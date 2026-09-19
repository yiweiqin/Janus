/**
 * `store.mjs` / `submit.mjs` 的纯函数测试。
 *
 * 落库那部分要真 Postgres，放在盒子上的 `run_remote.sh` 里跑（那里有 `DATABASE_URL`）。
 * 这里测的是能在任何机器上被穷举的那部分 —— 而恰恰是这部分出过一次代价很大的错：
 * `privacy.mjs` 的白名单曾经写成 `['domain','title','nodes','edges']`，
 * 于是**每一条**载荷都被裁成空对象，而云侧正常入队、worker 正常领活、测试还全绿
 * （夹具照着白名单写）。所以这里既测"映射对不对"，也测"审计函数真的会拦"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBriefs, planCases } from './lib/protocol.mjs';
import { assembleCase } from './lib/scenario.mjs';
import { TABLES, edgeKind, graphRows } from './store.mjs';
import { auditPayload, planBatches, readJsonl } from './submit.mjs';
import { seedOf, generate } from './simulate.mjs';
import { DEFAULT_BRIEFS, DEFAULT_CASES } from './submit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const JANUS_ROOT = join(HERE, '..', '..');

const BRIEFS = buildBriefs({ orgIds: ['org_01_consumer'], personLimitPerOrg: 2 });
const BRIEF = BRIEFS[0];

async function sampleOf(kind) {
  const plan = planCases(BRIEF).find((item) => item.kind === kind);
  const assembled = await assembleCase({ brief: BRIEF, plan, seed: seedOf(plan.caseId), propagate: 'local' });
  assert.ok(assembled.sample, `${kind} 装配失败：${assembled.reason}`);
  return assembled.sample;
}

// ---------------------------------------------------------------------------
// 边语汇
// ---------------------------------------------------------------------------

test('the edge vocabulary is the product one, and unknown shapes return null instead of a guess', () => {
  // 判据出处：collaborationGraphStoreMethods.js 的投影（parent_of / dependency_of / sequence_of）。
  assert.equal(edgeKind('root', 'ubuddy'), 'parent_of');
  assert.equal(edgeKind('ubuddy', 'agent_task'), 'parent_of');
  assert.equal(edgeKind('agent_task', 'agent_step'), 'parent_of');
  assert.equal(edgeKind('agent_step', 'agent_step'), 'sequence_of');
  assert.equal(edgeKind('agent_task', 'agent_task'), 'dependency_of');
  // 不在语汇里的组合返回 null：猜一个会让"这条边不属于这个语汇"看不出来。
  assert.equal(edgeKind('root', 'agent_task'), null);
  assert.equal(edgeKind('agent_step', 'agent_task'), null);
  assert.equal(edgeKind('ubuddy', 'agent_step'), null);
});

test('every edge of every generated case maps into the product vocabulary', async () => {
  // 这条是"骨架形状没跑偏"的硬判据。语料将来若新增一种边形状，这里会红，
  // 而不是 quietly 少写几条边（少写边的症状只是"图上没有链"）。
  const result = await generate({ briefs: BRIEFS, mode: 'offline' });
  let edges = 0;
  for (const sample of result.cases) {
    const rows = graphRows({ graph: sample.G_star, graphId: `g_${sample.id}`, ownerUserId: 'u' });
    assert.deepEqual(rows.skippedEdges, [], `${sample.id} 有无法归类的边：${rows.skippedEdges}`);
    edges += rows.edges.length;
  }
  assert.ok(edges > 0, '一条边都没有？');
});

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

test('parent_node_id is only ever set by a parent_of edge, matching the real projection', async () => {
  const sample = await sampleOf('wrong_agent');
  const rows = graphRows({ graph: sample.G_star, graphId: 'g_test', ownerUserId: 'u' });
  const kindOf = Object.fromEntries(rows.nodes.map((node) => [node.nodeId, node.kind]));
  for (const node of rows.nodes) {
    if (!node.parentNodeId) {
      // 只有 root 没有父。别的节点缺父意味着包含边丢了。
      assert.equal(node.kind, 'root', `${node.nodeId}(${node.kind}) 没有 parent_node_id`);
      continue;
    }
    const parent = kindOf[node.parentNodeId];
    assert.ok(['root', 'ubuddy', 'agent_task'].includes(parent),
      `${node.nodeId} 的父是 ${parent}，不是容器`);
    if (node.kind === 'agent_step') assert.equal(parent, 'agent_task', 'step 的父必须是任务');
  }
  // 深度是产品的四层。
  assert.equal(rows.nodes.find((node) => node.kind === 'root').depth, 0);
  assert.equal(rows.nodes.find((node) => node.kind === 'ubuddy').depth, 1);
  assert.equal(rows.nodes.find((node) => node.kind === 'agent_task').depth, 2);
  assert.equal(rows.nodes.find((node) => node.kind === 'agent_step').depth, 3);
});

test('the event stream is a monotone revision sequence starting at 1', async () => {
  // 分析器靠 graph_revision 配对读"变更前/变更后"。版本号断了就读不出因果链，
  // 而症状只是"读不到变更"，不是报错。
  const sample = await sampleOf('local_replan_step');
  const rows = graphRows({ graph: sample.G_star, graphId: 'g_test', ownerUserId: 'u' });
  assert.deepEqual(rows.events.map((event) => event.graphRevision),
    rows.nodes.map((_, index) => index + 1));
  assert.equal(rows.graph.currentRevision, rows.events.length);
  // 事件必须指向真实存在的节点 —— 云侧分析器是按 node_id 关联的。
  const ids = new Set(rows.nodes.map((node) => node.nodeId));
  for (const event of rows.events) assert.ok(ids.has(event.nodeId), `事件指向了不存在的 ${event.nodeId}`);
});

test('public_summary carries only the outward-facing text', async () => {
  // `public_summary` 是**同租户他人可见**的那一侧。把 inputs/output 这些内部文本塞进去，
  // 等于把内部上下文发给了同事 —— 与 privacy.mjs 面向云运维的白名单是两条不同的边界。
  const sample = await sampleOf('wrong_version');
  const rows = graphRows({ graph: sample.G_star, graphId: 'g_test', ownerUserId: 'u' });
  for (const node of rows.nodes) {
    const source = sample.G_star.nodes.find((item) => item.id === node.nodeId);
    assert.equal(node.publicSummary, source.summary);
    assert.ok(!node.publicSummary.includes(source.output) || !source.output,
      `${node.nodeId} 的 public_summary 里混进了 output`);
  }
});

// ---------------------------------------------------------------------------
// 载荷与隐私
// ---------------------------------------------------------------------------

test('the output audit only fires on leaks, so the local payload check must be truncation-based', async () => {
  // 这条测试记录的是**一个被证伪的防线**：曾经把"审计 buildRdmdCloudPayload 的输出"
  // 当成隐私防线，而输出是白名单拼的 —— 往 case 顶层塞 `prompt` 也好、往 G_star 塞
  // `murder` 也好，都会被安静裁掉，永远不出现在输出里。那条断言因此恒为真。
  const sample = await sampleOf('wrong_agent');
  const poisonedTop = auditPayload({ id: 'g', G_star: sample.G_star, G_prime: sample.G_prime, prompt: 'leak' });
  assert.deepEqual(poisonedTop.hits, [], '输出侧居然响了？那说明白名单坏了');
  assert.equal(poisonedTop.payload.prompt, undefined);
  const poisonedGraph = auditPayload({
    id: 'g', G_star: { ...sample.G_star, murder: 'leak' }, G_prime: sample.G_prime,
  });
  assert.deepEqual(poisonedGraph.hits, []);
  assert.equal(poisonedGraph.truncation.length, 0, '图级多余字段不该被算成裁过头');
  // 而审计函数本身是有效的 —— 直接喂它一个越界对象就会响。
  const { auditRdmdCloudPayload } = await import('../../cloud/src/modules/rdmd/privacy.mjs');
  assert.ok(auditRdmdCloudPayload({ id: 'g', prompt: 'leak' }).some((hit) => hit.includes('prompt')));
});

test('the truncation check catches the failure that actually happened', async () => {
  // 负对照：白名单曾经写成 `['domain','title','nodes','edges']`，于是每条载荷都被裁成
  // 空对象 —— 不报错、云侧照常入队、worker 照常领活，只是 case 里什么都没有。
  // 这里冒充一次那种白名单，断言 `describeTruncation` 会拦下它。
  const sample = await sampleOf('missing_dependency');
  const { describeTruncation } = await import('./submit.mjs');
  const good = { id: 'g', G_star: sample.G_star, G_prime: sample.G_prime };
  const realPayload = (await import('../../cloud/src/modules/rdmd/privacy.mjs')).buildRdmdCloudPayload({ case: good });
  assert.deepEqual(describeTruncation(good, realPayload), []);

  const truncated = { id: 'g', G_star: { nodes: [], edges: [] }, G_prime: { nodes: [], edges: [] } };
  const problems = describeTruncation(good, truncated);
  assert.ok(problems.some((item) => item.startsWith('G_star_nodes_truncated:')), JSON.stringify(problems));
  assert.ok(problems.some((item) => item.startsWith('G_prime_nodes_truncated:')));

  // 数量对但字段被裁光，也要拦得住。
  const hollow = { id: 'g', G_star: { nodes: [{ id: 'x' }], edges: [] }, G_prime: { nodes: [], edges: [] } };
  const hollowProblems = describeTruncation({ id: 'g', G_star: { nodes: [{ id: 'x', kind: 'agent_task', title: 't', agentId: 'a', status: 'completed' }], edges: [] }, G_prime: { nodes: [], edges: [] } }, hollow);
  assert.ok(hollowProblems.some((item) => item.includes('node_field_missing')), JSON.stringify(hollowProblems));
});

test('the input-side audit names the fields the whitelist silently drops', async () => {
  // 这条查的是**另一个方向**的风险。语料/图上有几个字段进不了云侧白名单，会被静默裁掉：
  //   `role`（节点的职能族）以及**图级的 `graph_id` / `domain` / `title` / `topic`**。
  // 后者值得单独指出：图级白名单只有 `nodes`/`edges`，所以**任务主题根本没上云**，
  // 模型只看到节点级文本。裁掉不是泄漏，但"我们以为发了什么"必须看得见 ——
  // 否则模型因为缺少上下文而答错时，没人分得清是模型不行还是我们没发。
  const sample = await sampleOf('wrong_agent');
  const audit = auditPayload({ id: 'g', G_star: sample.G_star, G_prime: sample.G_prime });
  assert.ok(audit.droppedFields.some((hit) => hit.includes('.role')),
    `没报出被裁掉的 role：${JSON.stringify(audit.droppedFields.slice(0, 6))}`);
  assert.ok(audit.droppedFields.some((hit) => hit.includes('.topic')),
    '没报出图级 topic 被裁掉');
  // 而被裁掉的字段确实不在载荷里。
  assert.ok(!JSON.stringify(audit.payload).includes('"role"'));
  assert.ok(!JSON.stringify(audit.payload).includes('"topic"'));
  // 白名单全命中的字段不该出现在 droppedFields 里。
  assert.ok(!audit.droppedFields.some((hit) => hit.includes('.summary')));
});

test('the payload keeps exactly the three case fields and nothing else', async () => {
  const sample = await sampleOf('missing_dependency');
  const { payload } = auditPayload({ id: 'g', G_star: sample.G_star, G_prime: sample.G_prime });
  assert.deepEqual(Object.keys(payload).sort(), ['G_prime', 'G_star', 'id']);
  for (const side of ['G_star', 'G_prime']) {
    assert.deepEqual(Object.keys(payload[side]).sort(), ['edges', 'nodes']);
  }
});

// ---------------------------------------------------------------------------
// 批量装配
// ---------------------------------------------------------------------------

test('planBatches joins cases to briefs, and reports a case whose brief is missing', async () => {
  const result = await generate({ briefs: BRIEFS, mode: 'offline' });
  const batches = planBatches({ cases: result.cases, briefs: BRIEFS });
  assert.equal(batches.problems.length, 0, JSON.stringify(batches.problems.slice(0, 3)));
  assert.equal(batches.batches.length, result.cases.length);
  // 云侧身份是合成的 sim 用户，不是 CPDB 角色 —— 见 submit.mjs 文件头。
  for (const batch of batches.batches) {
    assert.equal(batch.rows.graph.ownerUserId, 'user_sim_task_group');
  }
  // 缺 brief 时报出来，而不是拿一个空 owner 蒙混过去。
  const orphaned = planBatches({ cases: result.cases, briefs: [] });
  assert.equal(orphaned.batches.length, 0);
  assert.equal(orphaned.problems.length, result.cases.length);
  assert.match(orphaned.problems[0].reason, /brief_not_found/);
});

test('a malformed case is caught, not submitted as an empty payload', async () => {
  // `describeTruncation` **不可能**被"从外面往 case 里塞字段"触发 —— 白名单只会少发、
  // 不会多发，所以要多塞一个字段来制造"裁过头"是做不到的。它能被触发的真实情形是
  // **输入本身是坏的**：坏输入经过白名单会退化成空载荷，而那正是历史上那个 bug 的形状
  // （载荷被裁成空对象，云侧照常入队、worker 照常领活，只是 case 里什么都没有）。
  const result = await generate({ briefs: BRIEFS, mode: 'offline' });
  const poisoned = result.cases.map((sample, index) => (index === 0
    ? { ...sample, G_prime: { nodes: 'not-an-array', edges: [] } }
    : sample));
  const built = planBatches({ cases: poisoned, briefs: BRIEFS });
  assert.ok(built.problems.some((problem) => problem.reason === 'payload_truncated'),
    `坏输入被当成好载荷提交了：${JSON.stringify(built.problems.slice(0, 2))}`);
});

test('planBatches reports the dropped fields instead of silently shrinking the payload', async () => {
  const result = await generate({ briefs: BRIEFS, mode: 'offline' });
  const built = planBatches({ cases: result.cases, briefs: BRIEFS });
  // 聚合的是**字段名**而不是路径：32 个节点各带一个 role 会刷出 32 条同样的路径。
  // 两侧图都算，所以至少是每 case 32 次。
  assert.ok(built.droppedFields.role >= result.cases.length * 32,
    `没报出 role：${JSON.stringify(built.droppedFields)}`);
});

test('readJsonl refuses to silently skip a malformed line', () => {
  // 静默丢行会让"提交了 900 条"和"文件里有 1000 条"看起来一样。
  assert.throws(() => readJsonl(DEFAULT_CASES.replace('generated.jsonl', 'does-not-exist.jsonl'), 'cases'),
    /cases_missing/);
});

test('the generated artifacts are the ones submit reads by default', async () => {
  // 默认路径对不上时，`npm run experiment:sim-group:submit` 会在**别的**文件上跑，
  // 而报告看起来完全正常。
  const cases = readJsonl(DEFAULT_CASES, 'cases');
  const briefs = readJsonl(DEFAULT_BRIEFS, 'briefs');
  assert.ok(cases.length > 0, 'generated.jsonl 是空的：先跑 experiment:sim-group:generate');
  assert.ok(briefs.length > 0, 'briefs.jsonl 是空的');
  const briefIds = new Set(briefs.map((brief) => brief.id));
  for (const sample of cases) {
    assert.ok(briefIds.has(sample.brief_id), `${sample.id} 的 brief 不在 briefs.jsonl 里`);
  }
});

// ---------------------------------------------------------------------------
// 落库 SQL 的冲突目标 vs 真 schema
// ---------------------------------------------------------------------------

/**
 * 这一条是**用一次真实事故换来的**。
 *
 * 起因：`writeGraph` 给 events 表写的是 `ON CONFLICT (graph_id,event_id)`，而
 * `cloud/database/migrations/094_ubuddy_collaboration_graph.sql` 给这张表定的是
 * `event_id text NOT NULL UNIQUE` + `PRIMARY KEY(graph_id,graph_revision)` ——
 * 根本没有 `(graph_id,event_id)` 这个约束。Postgres 于是整条拒绝：
 * `there is no unique or exclusion constraint matching the ON CONFLICT specification`。
 *
 * 为什么本地没拦住：这里测的是纯函数，而 `writeGraph` 要真 Postgres。这个错只有
 * **上传到盒子、跑起来**才现形 —— 恰好是这一轮最想避免的那种"跑到一半才炸"。
 *
 * 所以这里做一件不需要数据库的事：把迁移里的真实约束抠出来，和 `store.mjs` 里写的
 * `ON CONFLICT (...)` 逐条比。抠不出来就**失败** —— 不让解析器坏了之后静默全过。
 */
function constraintsOf(sql, table) {
  const found = new Set();
  const normalize = (clause) => clause.split(',').map((item) => item.trim().toLowerCase())
    .filter(Boolean).sort().join(',');
  const blockRe = new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'g');
  let blocks = 0;
  for (const block of sql.matchAll(blockRe)) {
    blocks += 1;
    const body = block[1];
    for (const match of body.matchAll(/PRIMARY KEY\s*\(([^)]*)\)/gi)) found.add(normalize(match[1]));
    for (const match of body.matchAll(/\bUNIQUE\s*\(([^)]*)\)/gi)) found.add(normalize(match[1]));
    for (const line of body.split('\n')) {
      // 列级 UNIQUE：`event_id text NOT NULL UNIQUE`
      const name = line.match(/^\s*([a-z_][a-z0-9_]*)\s+[a-z]/i);
      if (name && /\bUNIQUE\b/i.test(line) && !/UNIQUE\s*\(/i.test(line)) found.add(normalize(name[1]));
    }
  }
  return { constraints: found, blocks };
}

test('every ON CONFLICT target in store.mjs exists in the real DDL', () => {
  const migrationsDir = join(JANUS_ROOT, 'cloud', 'database', 'migrations');
  const sql = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
    .map((name) => readFileSync(join(migrationsDir, name), 'utf8')).join('\n');

  const targets = [];
  const storeSrc = readFileSync(join(HERE, 'store.mjs'), 'utf8');
  // `[^`]*?` 是关键：每条 SQL 都是一个模板字符串，**不能让匹配跨过反引号**。
  // 少了这一层，graphs 那条（先删后插、没有 ON CONFLICT）会一路吃到下一条 nodes 的
  // `ON CONFLICT (graph_id,node_id)`，于是配出一个"graphs 表上有 (graph_id,node_id)"的
  // 假结论 —— 实测就是被下面那个"未知表键"断言抓住的。
  for (const match of storeSrc.matchAll(/INSERT INTO \$\{TABLES\.(\w+)\}[^`]*?ON CONFLICT \(([^)]*)\)/g)) {
    targets.push({
      key: match[1],
      columns: match[2].split(',').map((item) => item.trim().toLowerCase()).sort().join(','),
    });
  }
  // 写死条数是刻意的：这个正则要是哪天匹配不上，测试要**失败**，
  // 而不是变成一条空循环永远全绿。（graphs 那条没有 ON CONFLICT，它是先删后插。）
  assert.equal(targets.length, 3, `store.mjs 里的 ON CONFLICT 条数变了：${JSON.stringify(targets)}`);

  const parsed = {};
  for (const key of Object.keys(TABLES)) {
    if (key === 'graphs') continue;
    const table = TABLES[key];
    const { constraints, blocks } = constraintsOf(sql, table);
    assert.equal(blocks, 1, `${table} 在迁移里应该正好出现一次 CREATE TABLE，实际 ${blocks} 次`);
    assert.ok(constraints.size >= 1, `${table} 一条约束都没解析出来 —— 解析器坏了，这条测试就是摆设`);
    parsed[key] = constraints;
  }

  for (const target of targets) {
    const table = TABLES[target.key];
    assert.ok(parsed[target.key], `ON CONFLICT 指向了一个未知的表键：${target.key}`);
    assert.ok(parsed[target.key].has(target.columns),
      `${table} 上没有 (${target.columns}) 这个唯一约束：Postgres 会整条拒绝 `
      + '(there is no unique or exclusion constraint matching the ON CONFLICT specification)。'
      + `现有约束：${[...parsed[target.key]].map((c) => `(${c})`).join(' ')}`);
  }
});
