/**
 * 「顺序链 → 依赖 DAG」的映射契约（**只给诊断用，不得用于训练/评测**）。
 *
 * 为什么必须有这份契约
 * --------------------
 * agent 长程层（Codex rollout turn 链）是当前**唯一**已实测「尺度与交互性都够」的图源
 * （`G_PLAN_G_EXEC.zh-CN.md` §2：19 个图 / 706 节点 / 687 边 / 链长最高 110），
 * 而它被投影成的是**顺序链**：`turn_i -> turn_{i+1}`。
 *
 * 顺序链**不是**依赖 DAG。把 `i -> i+1` 直接当因果，等于宣布「先发生的都导致了后面的」
 * —— 任何顺序都会变成因果，级联被系统性高估，RDMD 的「唯一级联根」在这张图上
 * 会退化成「根是第一跳」。所以 `G_PLAN_G_EXEC.zh-CN.md` §4.2 把这条写成硬约束：
 * 映射定义清楚之前，不得用长程层链条训练或评测 RDMD。
 *
 * 本模块就是那份「定义」。它做三件事，而且只做这三件：
 *
 *   1. **给每条边标出证据强度**：`sequence`（只有先后顺序，是**假设**）
 *      还是 `consumes`（后一步的输入里确实出现了前一步的产出，是**证据**）。
 *      两者混在一起是这套数据最危险的地方 —— 分开之后，下游可以只取有证据的那部分。
 *   2. **把「能不能做因果归因」变成一个可判定的问句**（`causalAttributionReadiness`），
 *      而不是一句「差不多了」。今天在真实 rollout 上的答案应当是 **false** —— 这不是坏消息，
 *      是这条门按设计关着。
 *   3. **把「这一步为何必需」拆成三档**（`stepNecessity`），并明确
 *      `unverifiable` 的读法是「这套证据说不了话」，**不是**「这一步不需要」。
 *
 * 为什么证据由调用方给、而不是在这里从 JSONL 里挖
 * ------------------------------------------------
 * 「哪些产出被谁消费」需要读工具调用的参数（路径、命令、ID）。那是**抽取器**的活，
 * 有它自己的不确定性；把它塞进契约会把这层不确定性洗成「规则算出来的事实」。
 * 所以这里的输入是**已声明的证据对**，契约只负责：校验、分级、算形状、给出可判定性。
 *
 * 与 `uBuddyPlanExec.js` 的关系：那个契约管**组织层**（root/ubuddy/agent_task/agent_step），
 * 本契约管**长程层**（turn 链）。两者都不做 IO，都可以脱离数据库单测。
 *
 * 用法：
 *   const mapped = stepDependencyMap({ nodes, edges, consumes });
 *   if (causalAttributionReadiness(mapped).ready) { ... }   // 今天恒为 false
 */

export const STEP_DEPENDENCY_MAP_VERSION = 'ubuddy_step_dependency_map_v1';

/**
 * 边的证据强度。这两档**不能**互相代替，也不该被折叠成一个数字。
 */
export const STEP_DEPENDENCY_EDGE_KINDS = Object.freeze({
  /** 后一步的输入里出现了前一步的产出。这是可归因的证据。 */
  CONSUMES: 'consumes',
  /** 只观察到「先后」。**不构成因果证据** —— 它是假设，必须能单独被看见和剔除。 */
  SEQUENCE: 'sequence',
});

/** 证据是调用方声明的，不是这里推出来的：把 `evidence` 的原话记进边里，便于回溯。 */
export const STEP_DEPENDENCY_ORDER_EVIDENCE = 'order_only';

/**
 * 「这一步为何必需」的三档。**没有第四档**，也不给「必需」一个布尔值 ——
 * 布尔值会把「没证据」和「不重要」压成同一个 false。
 */
export const STEP_NECESSITY = Object.freeze({
  /** 证据图上既有入边也有出边：它是某条「产出→消费」链的中间一环，删掉它链就断。 */
  ON_EVIDENCE_PATH: 'required_on_evidence_path',
  /** 只在一端（纯产出者或纯消费者）。它在证据里出现过，但删掉它不切断任何中间链路。 */
  ENDPOINT: 'evidence_endpoint',
  /** 证据图上完全孤立。读法见 `stepNecessity` 的返回字段 `reason`。 */
  UNVERIFIABLE: 'unverifiable',
});

/**
 * 这个常量是**故意**的：本轮（以及长程层没有 G_plan 之前）不允许拿它的输出训练或评测。
 * 写成常量而不是注释，是为了让「有人想用它训练」时至少得先改这里，而那是一次显式动作。
 * `assertNotForTraining` 是它的可执行版本。
 */
export const STEP_DEPENDENCY_MAP_TRAINING_ALLOWED = false;

/** 允许的用途。只有诊断 —— 加新用途要连同理由一起改这里。 */
export const STEP_DEPENDENCY_MAP_PURPOSES = Object.freeze(['diagnosis']);

/** 本契约对输入的形状要求。缺一条都不会静默通过，见 `stepDependencyMap` 的 warnings。 */
export const STEP_DEPENDENCY_MAP_WARNING_CODES = Object.freeze({
  NODES_MISSING: 'nodes_missing',
  EDGES_DERIVED_FROM_ORDER: 'edges_derived_from_order',
  EDGE_AGAINST_ORDER: 'edge_against_order',
  EDGE_UNKNOWN_ENDPOINT: 'edge_unknown_endpoint',
  SELF_LOOP: 'self_loop',
  CONSUMES_UNKNOWN_ENDPOINT: 'consumes_unknown_endpoint',
  CONSUMES_AGAINST_ORDER: 'consumes_against_order',
  CONSUMES_SELF_LOOP: 'consumes_self_loop',
  DUPLICATE_NODE_ID: 'duplicate_node_id',
});

function text(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 把一条顺序链映射成带证据分级的依赖图。
 *
 * @param {{ nodes?: Array, edges?: Array, consumes?: Array }} input
 *   - `nodes`：**按观察到的时间顺序**排列。顺序由这个数组定义，不由边定义
 *     （边只用来交叉核对；逆序的边会被丢掉并报警，而不是悄悄把顺序改掉）。
 *   - `edges`：省略时按节点顺序推导出相邻边，并给出 `edges_derived_from_order` 警告
 *     —— 让「我其实没给边」这件事留在结果里，而不是看起来像「边是数据里的」。
 *   - `consumes`：调用方声明的证据对 `{ from, to, symbol? }`。
 *
 * 返回 `{ version, nodes, edges, evidenceEdges, orderEdges, stats, warnings }`：
 *   - `edges` 是**全部**边（每对端点最多一条；同一个 `from->to` 上若既有顺序又有证据，
 *     只留一条并升级为 `consumes`，见下面的去重说明）。
 *   - `evidenceEdges` / `orderEdges` 是同一批边的两个视图，供下游「只要证据」时直接取。
 */
export function stepDependencyMap({ nodes = [], edges = [], consumes = [] } = {}) {
  const warnings = [];
  const warn = (code, detail) => warnings.push({ code, detail });

  // ---- 节点：顺序即数组顺序，重复 id 只留第一个（后面的会让「同一节点两个位置」这种
  //      自相矛盾的输入悄悄通过，所以既丢也报）。 ----
  const kept = [];
  const orderOf = new Map();
  for (const raw of array(nodes)) {
    const node = objectValue(raw);
    const id = text(node.id || node.nodeId, 80);
    if (!id) continue;
    if (orderOf.has(id)) {
      warn(STEP_DEPENDENCY_MAP_WARNING_CODES.DUPLICATE_NODE_ID, `节点 ${id} 在链上出现多次，只保留第一次`);
      continue;
    }
    orderOf.set(id, kept.length);
    kept.push({
      id,
      title: text(node.title, 240),
      role: text(node.role, 80),
      status: text(node.status, 40),
    });
  }
  if (!kept.length) warn(STEP_DEPENDENCY_MAP_WARNING_CODES.NODES_MISSING, '没有节点，映射结果为空图');

  // ---- 顺序边：链的骨架。它**永远是假设**，这就是本契约存在的理由。 ----
  const pairKey = (from, to) => `${from}->${to}`;
  const byPair = new Map();

  const addOrderEdge = (from, to) => {
    if (!orderOf.has(from) || !orderOf.has(to)) {
      warn(STEP_DEPENDENCY_MAP_WARNING_CODES.EDGE_UNKNOWN_ENDPOINT, `边 ${from}->${to} 的端点在节点集之外，已丢弃`);
      return;
    }
    if (from === to) {
      warn(STEP_DEPENDENCY_MAP_WARNING_CODES.SELF_LOOP, `自环 ${from}->${to} 已丢弃`);
      return;
    }
    if (orderOf.get(from) > orderOf.get(to)) {
      // 顺序链里出现逆序边 = 输入自相矛盾。**不改顺序**，丢边并报警：
      // 悄悄交换两端会把「数据有问题」变成「图看起来正常」。
      warn(STEP_DEPENDENCY_MAP_WARNING_CODES.EDGE_AGAINST_ORDER, `边 ${from}->${to} 与观察到的顺序相反，已丢弃`);
      return;
    }
    byPair.set(pairKey(from, to), {
      id: pairKey(from, to), from, to,
      kind: STEP_DEPENDENCY_EDGE_KINDS.SEQUENCE, causal: false,
      evidence: STEP_DEPENDENCY_ORDER_EVIDENCE,
    });
  };

  const givenEdges = array(edges);
  if (givenEdges.length) {
    for (const raw of givenEdges) {
      const edge = objectValue(raw);
      addOrderEdge(text(edge.from || edge.fromNodeId, 80), text(edge.to || edge.toNodeId, 80));
    }
  } else if (kept.length > 1) {
    warn(STEP_DEPENDENCY_MAP_WARNING_CODES.EDGES_DERIVED_FROM_ORDER,
      `输入没有边，按节点顺序推导了 ${kept.length - 1} 条顺序边`);
    for (let index = 1; index < kept.length; index += 1) addOrderEdge(kept[index - 1].id, kept[index].id);
  }

  // ---- 证据边：与顺序边**同一张表**，靠 kind 区分。
  //      同一对端点上两者并存时只留一条（升级为证据）。留着两条会踩同一个坑：
  //      `uBuddyReverseDetective.edgeKey` 是 `${from}->${to}`，两条同 id 的边
  //      会被 `drop_edge` 一次删掉两条、被度量重复计数。 ----
  let upgradedFromSequence = 0;
  for (const raw of array(consumes)) {
    const pair = objectValue(raw);
    const from = text(pair.from, 80);
    const to = text(pair.to, 80);
    if (!orderOf.has(from) || !orderOf.has(to)) {
      warn(STEP_DEPENDENCY_MAP_WARNING_CODES.CONSUMES_UNKNOWN_ENDPOINT, `证据 ${from}->${to} 的端点在节点集之外，已丢弃`);
      continue;
    }
    if (from === to) {
      warn(STEP_DEPENDENCY_MAP_WARNING_CODES.CONSUMES_SELF_LOOP, `证据自环 ${from}->${to} 已丢弃`);
      continue;
    }
    if (orderOf.get(from) > orderOf.get(to)) {
      // 「消费了未来才产出的东西」在时间上不可能 → 这份证据有问题，不采信。
      warn(STEP_DEPENDENCY_MAP_WARNING_CODES.CONSUMES_AGAINST_ORDER,
        `证据 ${from}->${to} 指向未来（顺序 ${orderOf.get(from)} -> ${orderOf.get(to)}），已丢弃`);
      continue;
    }
    if (byPair.has(pairKey(from, to))) upgradedFromSequence += 1;
    byPair.set(pairKey(from, to), {
      id: pairKey(from, to), from, to,
      kind: STEP_DEPENDENCY_EDGE_KINDS.CONSUMES, causal: true,
      evidence: text(pair.symbol, 240) || 'declared',
    });
  }

  const allEdges = [...byPair.values()];
  const orderEdges = allEdges.filter((edge) => edge.kind === STEP_DEPENDENCY_EDGE_KINDS.SEQUENCE);
  const evidenceEdges = allEdges.filter((edge) => edge.kind === STEP_DEPENDENCY_EDGE_KINDS.CONSUMES);

  return {
    version: STEP_DEPENDENCY_MAP_VERSION,
    nodes: kept,
    edges: allEdges,
    orderEdges,
    evidenceEdges,
    // 统计口径写在结果里，调用方不必自己数 —— 也不该自己数，否则「门为什么关着」会有第二种解释。
    stats: {
      nodeCount: kept.length,
      // 链骨架的边数（相邻位次对）。它和 `orderEdgeCount` 不同：逆序边被丢、证据边会顶替顺序边。
      chainEdgeCount: Math.max(0, kept.length - 1),
      edgeCount: allEdges.length,
      orderEdgeCount: orderEdges.length,
      evidenceEdgeCount: evidenceEdges.length,
      causalEdgeCount: evidenceEdges.length,
      upgradedFromSequence,
      // 空分母一律给 null，不给 0：把「没测到」印成「0%」会把人引向错误结论。
      orderOnlyShare: allEdges.length ? orderEdges.length / allEdges.length : null,
      // 把整条链当因果会高估的倍数：链骨架边数 / 有证据的边数。没有证据时没有上限可言 → null。
      cascadeInflation: evidenceEdges.length ? Math.max(0, kept.length - 1) / evidenceEdges.length : null,
    },
    warnings,
  };
}

/** 只要证据边的那张图。`isolatedNodeIds` 是证据图上度数为 0 的节点 —— 不是「多余」，是「说不了话」。 */
export function causalOnlyGraph(mapped = {}) {
  const evidenceEdges = array(mapped.evidenceEdges);
  const touched = new Set();
  for (const edge of evidenceEdges) {
    touched.add(edge.from);
    touched.add(edge.to);
  }
  const nodes = array(mapped.nodes);
  return {
    version: mapped.version || STEP_DEPENDENCY_MAP_VERSION,
    nodes,
    edges: evidenceEdges,
    isolatedNodeIds: nodes.filter((node) => !touched.has(node.id)).map((node) => node.id),
  };
}

/**
 * 这张映射结果**能不能**支撑因果归因。
 *
 * 判据刻意严：只要还存在**任何一条**只有顺序的边，就不行 —— 因为「哪条顺序边恰好是真因果」
 * 正是要判的东西，拿它当已知就是把答案当地基。今天在真实 rollout 上的答案恒为 false。
 *
 * 返回 `{ ready, reasons, stats }`：`reasons` 是**可读的原因**，不是布尔值，
 * 因为「为什么不能」决定了下一步该去找什么证据。
 */
export function causalAttributionReadiness(mapped = {}) {
  const stats = objectValue(mapped.stats);
  const reasons = [];
  if (!stats.edgeCount) reasons.push('no_edges');
  else if (!stats.evidenceEdgeCount) reasons.push('no_evidence_edges');
  if (stats.orderEdgeCount) reasons.push('order_only_edges_present');
  return { ready: reasons.length === 0, reasons, stats };
}

/**
 * 「这一步为何必需」的三档判定。
 *
 * 判据只用**证据图**的度数。刻意**不**看顺序边：
 * 顺序边上的入度/出度在链上是恒等于 1 的，用它判必要性等于对每条链都说「每一环都必需」。
 *
 * `unverifiable` 的读法（重要）：**不是**「这一步不需要」，而是「这套证据说不了话」。
 * 返回里带 `orderOnlyIn/orderOnlyOut`，就是为了让调用方看见
 * 「它在链上有邻居、只是没有证据」和「它是个孤点」是两件事。
 */
export function stepNecessity(mapped = {}, nodeId = '') {
  const id = text(nodeId, 80);
  const nodes = array(mapped.nodes);
  if (!nodes.some((node) => node.id === id)) {
    throw new Error(`stepNecessity: 节点 ${id || '(空)'} 不在映射结果里`);
  }
  const evidenceEdges = array(mapped.evidenceEdges);
  const orderEdges = array(mapped.orderEdges);
  const countInto = (edges, key) => edges.filter((edge) => edge[key] === id).length;
  const incoming = countInto(evidenceEdges, 'to');
  const outgoing = countInto(evidenceEdges, 'from');

  let verdict = STEP_NECESSITY.UNVERIFIABLE;
  let reason = 'no_evidence_edges_touch_this_step';
  if (incoming && outgoing) {
    verdict = STEP_NECESSITY.ON_EVIDENCE_PATH;
    reason = 'produced_by_an_earlier_step_and_consumed_by_a_later_one';
  } else if (incoming || outgoing) {
    verdict = STEP_NECESSITY.ENDPOINT;
    reason = incoming ? 'only_consumes_evidence' : 'only_produces_evidence';
  } else if (countInto(orderEdges, 'to') || countInto(orderEdges, 'from')) {
    reason = 'on_the_chain_but_no_evidence_attaches';
  } else {
    reason = 'isolated_in_both_views';
  }

  return {
    nodeId: id,
    verdict,
    reason,
    evidenceIn: incoming,
    evidenceOut: outgoing,
    orderOnlyIn: countInto(orderEdges, 'to'),
    orderOnlyOut: countInto(orderEdges, 'from'),
  };
}

/**
 * 「不得用于训练/评测」的可执行版本。
 *
 * 一个常量加一句注释挡不住任何人；一个会抛的函数至少让越界变成一次显式改动。
 * 允许改这里的唯一路径是：长程层有了 G_plan、`causalAttributionReadiness` 在真实链上
 * 给出 true、且那份证据抽取规则也已定义。
 */
export function assertNotForTraining(purpose = 'diagnosis') {
  const value = text(purpose, 40);
  if (!STEP_DEPENDENCY_MAP_PURPOSES.includes(value)) {
    throw new Error(
      `长程层「顺序链 → 依赖 DAG」的映射只允许 ${STEP_DEPENDENCY_MAP_PURPOSES.join('/')}，`
      + `不支持用途「${value || '(空)'}」：链式投影会系统性高估级联`
      + `（G_PLAN_G_EXEC.zh-CN.md §4.2），在映射与证据规则都定下来之前不得用于训练或评测。`,
    );
  }
  return true;
}
