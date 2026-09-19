/**
 * 把模拟出来的 `G_plan` 写进盒子云库的 `collaboration_graph_*`。
 *
 * ## 为什么要有这一步（而不是只提交 case）
 *
 * 只 `POST /api/rdmd/jobs` 的话，云侧看到的是一条**悬空的 case**：有一对图、有一个作业，
 * 但没有"它从哪个协作图来、哪个任务、哪个参与者"。那样的话：
 *
 *   - 判定结果无法回指到一个真实存在的任务族（"样本在累积"这句话就没有落点）；
 *   - TPM 的基础层（规划图/执行图）没有载体；
 *   - `collaboration_graphs` 那几张表永远是 0 行，"盒子上的协作图是空的"这个初始观察
 *     就永远不变 —— 而那正是我们这一轮要消掉的东西。
 *
 * ## 落库用的边类型**照产品的写法**，不是自己发明的
 *
 * 判据来自 `src/main/modules/persistence/infrastructure/collaborationGraphStoreMethods.js`：
 * 它投影四层图时写的就是下面这几种（行号见每条 `edgeKind` 的注释）。
 * 自己发明一套 `kind` 的后果是云侧/分析器读不到链，而症状只是"图上没有链"——
 * 看起来像那批任务本来就扁平。
 *
 *   parent_of       root→ubuddy、ubuddy→agent_task、agent_task→agent_step
 *   dependency_of   agent_task→agent_task（任务链，就是依赖分的形状）
 *   sequence_of     agent_step→agent_step（整张图上唯一的真链）
 *
 * `parent_node_id` 取"包含它的那个容器"：step 的父是它所属的任务，task 的父是 uBuddy。
 * 这与 `projectAgentPlanSteps` 里 `parentNodeId: parent.nodeId` 一致（`:530`）。
 *
 * ## 幂等
 *
 * 按 `graph_id` 先删后插。重跑同一批 case 不会让图膨胀，也不会撞唯一键。
 */
import { normalizeRichGraph } from '../rdmd_detective_dataset/lib/graph.mjs';

/** 云库的表名。集中在这里，免得散落在 SQL 字符串里。 */
export const TABLES = Object.freeze({
  graphs: 'collaboration_graphs',
  nodes: 'collaboration_graph_nodes',
  edges: 'collaboration_graph_edges',
  events: 'collaboration_graph_events',
});

/**
 * 边的 `kind` 由两端节点的 kind 决定 —— 与产品投影同口径。
 * 判据出处见文件头。
 */
export function edgeKind(fromKind, toKind) {
  if (toKind === 'agent_step' && fromKind === 'agent_task') return 'parent_of';
  if (toKind === 'agent_step' && fromKind === 'agent_step') return 'sequence_of';
  if (toKind === 'agent_task' && fromKind === 'ubuddy') return 'parent_of';
  if (toKind === 'agent_task' && fromKind === 'agent_task') return 'dependency_of';
  if (toKind === 'ubuddy' && fromKind === 'root') return 'parent_of';
  // 剩下的（比如 root→agent_task 这种被压平的形状）不是产品会写的边。
  // 返回 null 而不是猜一个：猜一个会让"这条边不属于这个语汇"这件事看不出来。
  return null;
}

/**
 * 把一张 `G_star` 拆成四张表的行。
 *
 * **纯函数**，不碰数据库 —— 于是"映射对不对"可以在没有 Postgres 的地方被穷举测试。
 */
export function graphRows({ graph, graphId, ownerUserId, taskRunId = '', delegationId = '', ownerAgentInstancePrefix = 'sim' }) {
  const rich = normalizeRichGraph(graph);
  const kindOf = Object.fromEntries(rich.nodes.map((node) => [node.id, node.kind]));
  const inbound = new Map();
  for (const edge of rich.edges) {
    if (!inbound.has(edge.to)) inbound.set(edge.to, []);
    inbound.get(edge.to).push(edge.from);
  }
  const CONTAINERS = new Set(['root', 'ubuddy', 'agent_task']);
  const containerMemo = {};
  /**
   * 最近的**容器**祖先。
   *
   * 为什么不只看 `parent_of` 边的末端：语料里有"挂在另一步骤下面的步骤"
   * （`addDecoyNodes` 的 step 诱饵、`insertLocalReplanStep` 增派的那一环），
   * 它们挂在 step 上而不是任务上。产品的 `projectAgentPlanSteps` 给每个 step 写的
   * `parentNodeId` 都是**所属任务**（`:530`），所以这里要往上爬到那个任务。
   *
   * 只认 `parent_of` 的话，这些 step 会得到空的 `parent_node_id`，
   * 而症状只是"有些步骤没有父"——分析器按父聚合时会把它们悄悄漏掉。
   */
  function containerOf(id) {
    if (id in containerMemo) return containerMemo[id];
    const seen = new Set([id]);
    const queue = [...(inbound.get(id) || [])];
    while (queue.length) {
      const from = queue.shift();
      if (seen.has(from)) continue;
      seen.add(from);
      if (CONTAINERS.has(kindOf[from])) { containerMemo[id] = from; return from; }
      queue.push(...(inbound.get(from) || []));
    }
    containerMemo[id] = '';
    return '';
  }

  const edges = [];
  const skipped = [];
  for (const edge of rich.edges) {
    const kind = edgeKind(kindOf[edge.from], kindOf[edge.to]);
    if (!kind) {
      skipped.push(`${edge.from}(${kindOf[edge.from]})→${edge.to}(${kindOf[edge.to]})`);
      continue;
    }
    edges.push({ edgeId: `${edge.from}->${edge.to}`, kind, from: edge.from, to: edge.to });
  }

  const nodes = rich.nodes.map((node) => ({
    nodeId: node.id,
    parentNodeId: node.kind === 'root' ? '' : containerOf(node.id),
    kind: node.kind,
    taskNodeId: '',
    ownerAgentId: String(node.agentId || '').slice(0, 160),
    ownerAgentInstanceId: `${ownerAgentInstancePrefix}_${String(node.agentId || 'agent').slice(0, 80)}`,
    // `public_summary` 是**对外可见**的那一侧，所以只放标题与摘要，不放 inputs/output
    // 这些内部文本。这一条与 `privacy.mjs` 的字段白名单是两件事：那边面向云运维，
    // 这边面向同租户的其他用户。
    title: String(node.title || '').slice(0, 240),
    publicSummary: String(node.summary || '').slice(0, 800),
    // 图上的 status 用节点的执行事实。step 层在真实投影里也只有这一个信号。
    status: String(node.status || 'completed').slice(0, 40),
    progress: node.status === 'completed' ? 100 : 0,
    depth: node.kind === 'root' ? 0 : (node.kind === 'ubuddy' ? 1 : (node.kind === 'agent_task' ? 2 : 3)),
  }));

  // 事件流：每个节点一条 `node_added`。`graph_revision` 必须从 1 单调递增 ——
  // 分析器要靠 before/after 配对读变更，版本号断了就读不出因果链。
  const events = rich.nodes.map((node, index) => ({
    graphRevision: index + 1,
    eventId: `${graphId}__ev_${index + 1}`,
    eventType: 'node_added',
    nodeId: node.id,
    patch: { status: String(node.status || 'completed'), progress: node.status === 'completed' ? 100 : 0, note: `sim ${node.kind}` },
  }));

  return {
    graph: {
      graphId,
      rootTaskRunId: taskRunId,
      rootDelegationId: delegationId,
      rootNodeId: rich.nodes.find((node) => node.kind === 'root')?.id || '',
      ownerUserId,
      title: String(rich.title || rich.topic || graphId).slice(0, 240),
      currentRevision: events.length,
      lifecycleStatus: 'active',
    },
    nodes,
    edges,
    events,
    skippedEdges: skipped,
  };
}

/**
 * 落库。**幂等**：先按 graph_id 删干净再插。
 *
 * 表已存在于云库（迁移 094 建四张表、096 补 agent_step），所以这里不建表、不迁移 ——
 * 迁移是云侧自己的事，模拟器不该偷偷改 schema。
 */
export async function writeGraph(pool, rows, { revision = 1 } = {}) {
  const { graph, nodes, edges, events } = rows;
  await pool.query(`DELETE FROM ${TABLES.events} WHERE graph_id=$1`, [graph.graphId]);
  await pool.query(`DELETE FROM ${TABLES.edges} WHERE graph_id=$1`, [graph.graphId]);
  await pool.query(`DELETE FROM ${TABLES.nodes} WHERE graph_id=$1`, [graph.graphId]);
  await pool.query(`DELETE FROM ${TABLES.graphs} WHERE id=$1`, [graph.graphId]);

  await pool.query(
    `INSERT INTO ${TABLES.graphs}
       (id,root_task_run_id,root_delegation_id,root_node_id,owner_user_id,title,current_revision,lifecycle_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [graph.graphId, graph.rootTaskRunId, graph.rootDelegationId, graph.rootNodeId,
      graph.ownerUserId, graph.title, graph.currentRevision, graph.lifecycleStatus],
  );

  for (const node of nodes) {
    await pool.query(
      `INSERT INTO ${TABLES.nodes}
         (graph_id,node_id,parent_node_id,kind,task_run_id,delegation_id,task_node_id,owner_user_id,
          owner_agent_id,owner_agent_instance_id,title,public_summary,status,progress,depth,source_revision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (graph_id,node_id) DO UPDATE SET
         parent_node_id=excluded.parent_node_id, kind=excluded.kind, title=excluded.title,
         public_summary=excluded.public_summary, status=excluded.status, progress=excluded.progress,
         depth=excluded.depth, owner_agent_id=excluded.owner_agent_id,
         owner_agent_instance_id=excluded.owner_agent_instance_id, updated_at=now()`,
      [graph.graphId, node.nodeId, node.parentNodeId, node.kind, graph.rootTaskRunId,
        graph.rootDelegationId, node.taskNodeId, graph.ownerUserId, node.ownerAgentId,
        node.ownerAgentInstanceId, node.title, node.publicSummary, node.status, node.progress,
        node.depth, revision],
    );
  }

  for (const edge of edges) {
    await pool.query(
      `INSERT INTO ${TABLES.edges} (graph_id,edge_id,kind,from_node_id,to_node_id,source_revision)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (graph_id,edge_id) DO UPDATE SET
         kind=excluded.kind, from_node_id=excluded.from_node_id, to_node_id=excluded.to_node_id,
         source_revision=excluded.source_revision, updated_at=now()`,
      [graph.graphId, edge.edgeId, edge.kind, edge.from, edge.to, revision],
    );
  }

  for (const event of events) {
    await pool.query(
      `INSERT INTO ${TABLES.events}
         (graph_id,graph_revision,event_id,event_type,node_id,public_patch_json,actor_user_id,
          actor_agent_instance_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,now())
       -- **冲突目标必须与 DDL 里的唯一约束一致**，否则 Postgres 直接拒绝整条语句：
       --   'there is no unique or exclusion constraint matching the ON CONFLICT specification'
       -- 这里踩过一次：写的是 (graph_id,event_id)，而 094_ubuddy_collaboration_graph.sql
       -- 给 events 表定的是 'event_id text NOT NULL UNIQUE' + 'PRIMARY KEY(graph_id,graph_revision)'
       -- —— **没有** (graph_id,event_id) 这个约束。
       -- 用 (event_id) 也正是产品侧的去重口径（collaborationGraphStoreMethods.js:174
       -- 按 event_id 查重、:192 按 UNIQUE ... event_id 判重复）。
       ON CONFLICT (event_id) DO NOTHING`,
      [graph.graphId, event.graphRevision, event.eventId, event.eventType, event.nodeId,
        JSON.stringify(event.patch), graph.ownerUserId, `${graph.graphId}__actor`],
    );
  }

  return { graphId: graph.graphId, nodes: nodes.length, edges: edges.length, events: events.length };
}

/** 读回来做校验 —— 写进去了不等于读得出来。 */
export async function readGraphSummary(pool, graphId) {
  const graphs = (await pool.query(`SELECT id,current_revision,lifecycle_status FROM ${TABLES.graphs} WHERE id=$1`, [graphId])).rows;
  const nodeCount = (await pool.query(`SELECT count(*)::int AS n FROM ${TABLES.nodes} WHERE graph_id=$1`, [graphId])).rows[0].n;
  const edgeCount = (await pool.query(`SELECT count(*)::int AS n FROM ${TABLES.edges} WHERE graph_id=$1`, [graphId])).rows[0].n;
  const eventCount = (await pool.query(`SELECT count(*)::int AS n FROM ${TABLES.events} WHERE graph_id=$1`, [graphId])).rows[0].n;
  const byKind = (await pool.query(
    `SELECT kind, count(*)::int AS n FROM ${TABLES.nodes} WHERE graph_id=$1 GROUP BY kind ORDER BY kind`, [graphId],
  )).rows;
  const byEdgeKind = (await pool.query(
    `SELECT kind, count(*)::int AS n FROM ${TABLES.edges} WHERE graph_id=$1 GROUP BY kind ORDER BY kind`, [graphId],
  )).rows;
  return { graphs: graphs.length, nodeCount, edgeCount, eventCount, byKind, byEdgeKind };
}
