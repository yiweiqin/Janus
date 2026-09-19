/**
 * 模拟任务群协议 —— 机器可读的那一份。
 *
 * ## 这个文件存在的理由
 *
 * 「模拟一个真实任务群」最危险的做法是**另起一套词表**：自己编一套漂移类型、自己编一套
 * gold 字段、自己编一套角色。那样跑出来的判定与训练/上线的那条链**对不上**，报告再绿也
 * 没有意义 —— 它证明的是一个不存在的系统能跑。
 *
 * 所以这里一条新词表都不发明。两件事**照抄**，并且用测试锁住（`protocol.test.mjs`）：
 *
 *   - **漂移词表**来自 `experiments/rdmd_detective_dataset/schema.json`（`driftTypes` /
 *     `labelFields` / `nodeFields` / `nodeKinds` / `nodeStatuses` / `minHopToFirstEffect` /
 *     `forbidden*`）。那是 v4 模型真正训练过的语义。
 *   - **角色库**来自 `experiments/cpdb_org_world/data/full/{people,agents}.jsonl`。那是
 *     CPDB（方案二）真正打过分的 600 个 specialist，天然带职能互补（依赖分）与近邻 twin
 *     （相似度）。模拟群任务因此是 CPDB 的**第一个消费者**，而不是又一个平行世界。
 *
 * ## 这个协议要产出什么
 *
 * 一个 brief（任务简报）= 一个「群任务」= 一组 case。每个 case 是
 * `{G_plan, G_exec, gold}`，形状与 `experiments/rdmd_detective_dataset` 的
 * `sampleFields` 对齐，可以直接过 `planExecCase()` / `buildRdmdCloudPayload()`。
 *
 * ## 三条不能碰的硬规则（照抄 `lib/forms.mjs` 的注释，那是踩过坑写下来的）
 *
 * 1. **hop 1–2 的后代一个字都不许改**，后果从 hop ≥3 起才写。
 *    `firstEffectHop`（`lib/graph.mjs`）取的是"变化的**后代**里最近的那个"，
 *    所以只要 hop 1 有一个字段变了，`hop_to_first_effect` 就是 1，`minHopToFirstEffect: 3`
 *    直接不满足 —— 而且**不报错**，只是样本静默变得过于容易。
 * 2. **改动不许落在"真凶及其后代"之外。** 否则 `changed_outside_descendants` 判死，
 *    或者更糟：模型学会去看一个与成因无关的节点。
 * 3. **真凶（gold）不许碰 `status`。** status 是 agent_step 层唯一真实的漂移信号，
 *    把它写进 gold 等于把答案放在模型眼前；`validate.mjs` 的 `statusShortcutBaseline`
 *    就是专门证明"只看 status 也能满分"的那条守卫。status 只能作为**后果**出现在下游。
 *
 * ## step 层只承载 4/5 种漂移
 *
 * `wrong_acceptance` 在 step 层**没有形态**：plan step 的载荷只有 `{step, status}`，
 * 验收标准在这个层级没有来源（`uBuddyAgentPlanSteps.js` + 真实投影实测表
 * `_real_live/AGENT_PLAN_OBSERVATION.zh-CN.md` §4.2 都证实 step 层不写富文本）。
 * 编一段 acceptance 能凑出样本，但那是在教模型一个生产上永远不存在的字段。
 * 宁可少一种漂移，也不造假 —— 这条在 `STEP_TIER_MISSING_FORMS` 里是显式数据，不是注释。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FAMILIES, ORGS, orgSplit } from '../../cpdb_org_world/lib/catalog.mjs';
import { makeRng } from '../../cpdb_org_world/lib/rng.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `experiments/sim_task_group` */
export const SIM_ROOT = resolve(HERE, '..');
/** 仓库里的 `Janus/` */
export const JANUS_ROOT = resolve(SIM_ROOT, '../..');

export const CPDB_DATA_DIR = join(JANUS_ROOT, 'experiments/cpdb_org_world/data/full');
export const RDMD_DATASET_DIR = join(JANUS_ROOT, 'experiments/rdmd_detective_dataset');

export const SIM_SCHEMA = 'sim_task_group_v1';

function readJsonl(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    .map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// 词表：全部从 rdmd 语料读进来，不在这里重抄一遍
// ---------------------------------------------------------------------------

/** rdmd 语料的 schema。漂移词表、gold 字段、闸门常量的唯一来源。 */
export function rdmdSchema() {
  return JSON.parse(readFileSync(join(RDMD_DATASET_DIR, 'schema.json'), 'utf8').replace(/^\uFEFF/, ''));
}

const SCHEMA = rdmdSchema();

/** 五种漂移。顺序就是语料里的顺序，报告与采样都按它排。 */
export const DRIFT_TYPES = Object.freeze([...SCHEMA.driftTypes]);
/** `drift` / `no_drift` / `UNKNOWN`。`UNKNOWN` 不是"没判出来"，是"不该判"（双注入）。 */
export const STATUSES = Object.freeze([...SCHEMA.status]);
/** gold 的字段名。多一个少一个都会被 `protocol.test.mjs` 抓住。 */
export const GOLD_FIELDS = Object.freeze([...SCHEMA.labelFields]);
/** 11 个模型可见字段（+ `kind` / `status` 不进模型契约，但进节点形状）。 */
export const NODE_FIELDS = Object.freeze([...SCHEMA.nodeFields]);
export const NODE_KINDS = Object.freeze([...SCHEMA.nodeKinds]);
export const NODE_STATUSES = Object.freeze([...SCHEMA.nodeStatuses]);
/** 「真凶到第一个变化后代」的最小跳数。见文件头硬规则 1。 */
export const MIN_HOP_TO_FIRST_EFFECT = Number(SCHEMA.minHopToFirstEffect || 3);

/**
 * `UNKNOWN` 样本的 gold 用**复数**字段。
 *
 * 这不是我们的发明：`generate.mjs#makeUnknown` 写的就是 `injected_nodes` / `injected_types` /
 * `injected_forms`（单数那份留空）。单注入样本用单数、双注入样本用复数 —— 两套都必须支持，
 * 否则 `collect.mjs` 算"定位命中"时会把 `UNKNOWN` 的定位当成"模型没答对"而不是"本就不该答"。
 */
export const MULTI_GOLD_FIELDS = Object.freeze([
  'injected_nodes', 'injected_types', 'injected_forms',
]);
/**
 * 注入本身在图上新增的节点（step 层 local_replan 的"增派一环"）。
 *
 * 它既不是真凶也不是诱饵，是**注入的副作用**。必须显式声明，否则闸门的
 * `extra_node_unexplained` 会把它当"无来由的新节点"判死（`generate.mjs:173-175`）。
 */
export const INSERTED_NODES_FIELD = 'inserted_nodes';

/** step 层**没有形态**的漂移类型，以及为什么。这是数据，不是注释。 */
export const STEP_TIER_MISSING_FORMS = Object.freeze({
  wrong_acceptance: 'plan step 的载荷只有 {step, status}，验收标准在 step 层没有来源',
});

/** 某个类型在 step 层有没有形态。采样器据此把 step 节点排除在候选之外。 */
export function stepFormAvailable(type) {
  return DRIFT_TYPES.includes(type) && !(type in STEP_TIER_MISSING_FORMS);
}

// ---------------------------------------------------------------------------
// 传播契约：照抄 generate.mjs#makePrime 的那句指令，因为它就是闸门的判据
// ---------------------------------------------------------------------------

export const PROPAGATION = Object.freeze({
  /** 真凶自己可以改的字段取决于形态；这里只钉"哪些后代不许动"。 */
  untouchedDescendantHops: Object.freeze([1, 2]),
  /** 后果从这里起写。 */
  effectStartsAtHop: MIN_HOP_TO_FIRST_EFFECT,
  /** 允许的改动范围。 */
  scope: 'gold ∪ descendants(gold)',
  subtle: '原因节点的 title/agentId/version/acceptance 尽量保持原样，主要改 summary/output/artifact。',
  visible: '可以改结构字段，也可在远处增加最多两个 repair_ 节点。',
  /** 两种口径都成立的一句。 */
  shared: '距离 1–2 跳的后代不要改；从第 3 跳起用该任务自己的材料写后果。只改注入点及其后代。',
});

/**
 * 五种漂移各自在哪一层、动哪个字段、真凶之外还要动什么。
 *
 * `goldTouchesFields: []` = 结构性漂移：真凶一个字段都不改，信号就是"边上少/多了一条"。
 * 给结构性漂移的真凶补一句自述，等于把结构信号换成一句可背的话（`forms.mjs` 原话）。
 */
export const DRIFT_SPEC = Object.freeze({
  missing_dependency: Object.freeze({
    zh: '缺依赖',
    // 两层都可以：`applyLocalEdit` 对 step 层有专门分支，shipped 语料里也真有两层
    // （manifest 的 stepForms 里 missing_dependency 有 142 条）。早先这里只写了
    // `agent_task`，于是协议测试反过来拦住了本来合法、而且语料里确实存在的一档。
    // 真正的额外约束是**位置性**的而不是层级性的：step 层必须挑一个"有前驱步骤"的点，
    // 因为能砍的只有链边（砍包含边会把这一步变成孤立源点，那是数据坏了不是漂移）。
    tiers: Object.freeze(['agent_task', 'agent_step']),
    structural: true,
    goldTouchesFields: Object.freeze([]),
    signal: '删掉真凶的入边（它没等上游产出就开工）',
    stepNote: 'step 层只能砍"上一步 → 这一步"的链边，且真凶必须有前驱步骤',
  }),
  wrong_agent: Object.freeze({
    zh: '执行者错位',
    tiers: Object.freeze(['agent_task', 'agent_step']),
    structural: false,
    goldTouchesFields: Object.freeze(['agentId']),
    signal: 'agentId 换成职能不同（或越权代跑）的 Agent',
    stepNote: 'step 的 agentId 平时继承自所属任务，"与父任务不同"本身就是越权代跑',
  }),
  wrong_version: Object.freeze({
    zh: '版本错位',
    tiers: Object.freeze(['agent_task', 'agent_step']),
    structural: false,
    goldTouchesFields: Object.freeze(['version', 'title']),
    signal: '钉在旧版口径（step 层没有 version，只能落在标题措辞上）',
    stepNote: 'step 层用 title 表达"这一步还在用上一版计划的说法"',
  }),
  wrong_acceptance: Object.freeze({
    zh: '验收放宽',
    tiers: Object.freeze(['agent_task']),
    structural: false,
    goldTouchesFields: Object.freeze(['acceptance']),
    signal: 'acceptance 换成更松的标准',
    stepNote: 'step 层没有验收标准这个来源，无形态',
  }),
  local_replan: Object.freeze({
    zh: '本地重规划',
    tiers: Object.freeze(['agent_task', 'agent_step']),
    structural: false,
    goldTouchesFields: Object.freeze(['title']),
    signal: '现场改计划：增派一环（结构）或把一步并进下一环（措辞）',
    stepNote: 'agent_task 层可以删掉一步；step 层不行 —— 真凶必须两侧都在，被删的节点无法校验归因',
  }),
});

// ---------------------------------------------------------------------------
// 角色库：CPDB 的 600 个 specialist + 120 个 uBuddy
// ---------------------------------------------------------------------------

/** 职能之间的依赖序（方案二的"依赖分"就长在这张图上）。 */
export function familyDependencyEdges() {
  const edges = [];
  for (const producer of Object.values(FAMILIES)) {
    for (const consumer of Object.values(FAMILIES)) {
      if (producer.id === consumer.id) continue;
      const shared = producer.produces.filter((token) => consumer.consumes.includes(token));
      if (shared.length) edges.push({ from: producer.id, to: consumer.id, tokens: shared });
    }
  }
  return edges;
}

/**
 * 职能的**稳定**先后序，用于把参与者的产出接成一条链。
 *
 * 依赖图里有环：`writing → report → review → verdict → writing`。
 * 这不是 bug —— `review` 的 verdict 是给 `writing` 的**修订依据**，而 report 是
 * review 的**审查对象**，两者互为输入。硬做拓扑排序会失败，所以这里：
 *
 *   - Kahn 排出主链；
 *   - 剩下的环节（就是环上的那几个）按 `FAMILIES` 的声明序补在后面；
 *   - **把断掉的边报出来**（`brokenEdges`），而不是静默丢掉。
 *
 * 静默丢边的后果是：依赖分看起来算出来了，其实少了一类协作关系，
 * 而下游（规划选人、相似度替换）会把缺失当成"这两个职能本来就不互相依赖"。
 */
export function familyDependencyOrder() {
  const edges = familyDependencyEdges();
  const ids = Object.keys(FAMILIES);
  const indeg = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const edge of edges) indeg[edge.to] += 1;
  const queue = ids.filter((id) => indeg[id] === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const edge of edges.filter((item) => item.from === id)) {
      indeg[edge.to] -= 1;
      if (indeg[edge.to] === 0) queue.push(edge.to);
    }
  }
  // Kahn 排不出来的都在环上：按 `FAMILIES` 的声明序补进来（确定性，不靠 hash）。
  for (const id of ids) if (!order.includes(id)) order.push(id);

  // 断边必须**排完序之后再找**。
  //
  // 第一版是在"补一个环上节点"的循环里顺手判的：那时 `order.indexOf(from)` 对尚未
  // 落位的节点返回 **-1**，`-1 > indexOf(to)` 恒假 —— 于是环上一个 back-edge 都记不下来，
  // `brokenEdges` 恒为空。而这个函数的整个价值就是"别静默丢边"，
  // 静默丢边的版本会让依赖分少算一类协作关系，且没有任何症状。
  const brokenEdges = edges
    .filter((edge) => order.indexOf(edge.from) > order.indexOf(edge.to))
    .map((edge) => ({ ...edge, reason: 'cycle' }));
  return { order, edges, brokenEdges };
}

/** brief 里一位参与者。字段全部来自 `agents.jsonl`，一个都不编。 */
function participantOf(agent) {
  return {
    agentId: agent.id,
    name: agent.name,
    ownerUserId: agent.ownerUserId,
    familyId: agent.familyId,
    familyTitle: agent.familyTitle,
    facetId: agent.facetId,
    facetName: agent.facetName,
    twin: Boolean(agent.twin),
    produces: [...agent.produces],
    consumes: [...agent.consumes],
    deliverableTypes: [...agent.deliverableTypes],
    detailCapabilities: [...agent.detailCapabilities],
  };
}

/**
 * 建 brief：一个「群任务」。
 *
 * 参与者 = 一个人的团队（4 个主职能位 + 1 个近邻 twin），因为"同一个人手下的团队"
 * 天然有：
 *   - **职能互补**（research → data → writing → ppt → review），这是方案二的依赖分；
 *   - **一对近邻**（主职能位 vs 同职能 twin，只差一项细节能力），这是方案二的相似度。
 * 换句话说，一个 brief 里自带了"该找谁协作"与"出事后该换谁"两个问题的最小实例。
 *
 * `split` 用 `catalog.orgSplit()`（按 org 连续切：前 10 个 org 是 train，
 * org_11 是 development，org_12 是 test）。**不是** `rng.splitForOrg()` —— 那个是
 * 哈希切分，会把同一个 org 的人劈到不同 split 里，而 org 内部的画像高度同源，
 * 等于测试集泄漏了训练集。`rng.splitForOrg` 目前在仓库里无人调用（死代码）。
 */
export function buildBriefs({ orgIds = [], limit = 0, personLimitPerOrg = 0 } = {}) {
  const people = readJsonl(join(CPDB_DATA_DIR, 'people.jsonl'));
  const agents = readJsonl(join(CPDB_DATA_DIR, 'agents.jsonl'));
  const byPerson = new Map();
  for (const agent of agents) {
    const list = byPerson.get(agent.ownerUserId) || [];
    list.push(agent);
    byPerson.set(agent.ownerUserId, list);
  }
  const wanted = orgIds.length ? new Set(orgIds) : null;
  const perOrg = new Map();
  const briefs = [];
  for (const person of people) {
    if (wanted && !wanted.has(person.orgId)) continue;
    const seen = perOrg.get(person.orgId) || 0;
    if (personLimitPerOrg && seen >= personLimitPerOrg) continue;
    perOrg.set(person.orgId, seen + 1);
    const team = (byPerson.get(person.id) || []).sort((a, b) => a.slot - b.slot);
    if (team.length < 2) continue;
    const participants = team.map(participantOf);
    const mains = participants.filter((item) => !item.twin);
    const twins = participants.filter((item) => item.twin);
    briefs.push({
      schema: SIM_SCHEMA,
      id: `brief_${person.orgId}_${person.id}`,
      orgId: person.orgId,
      orgName: person.orgName,
      domain: person.domain,
      topic: person.topic,
      departmentName: person.departmentName,
      // split 由 org 决定，不由人决定：同 org 的人必须落在同一个 split。
      split: orgSplit(person.orgId),
      archetypeId: person.archetypeId,
      archetypeTitle: person.archetypeTitle,
      lead: {
        ownerUserId: person.id,
        ownerDisplayName: person.displayName,
        ubuddyId: person.ubuddyId,
        title: person.title,
      },
      participants,
      /** 主职能位（不含近邻）。依赖链由这几个接出来。 */
      mainAgentIds: mains.map((item) => item.agentId),
      /** 近邻对：`[主职能位, twin]`，同职能只差一项细节能力。 */
      twinPairs: twins.map((twin) => {
        const main = mains.find((item) => item.familyId === twin.familyId);
        return main ? { mainAgentId: main.agentId, twinAgentId: twin.agentId, familyId: twin.familyId } : null;
      }).filter(Boolean),
      /** 该换谁：按相似度最近的主职能位 ↔ twin 对照。 */
      similarSwapCandidates: twins.map((twin) => ({
        familyId: twin.familyId,
        from: mains.find((item) => item.familyId === twin.familyId)?.agentId || '',
        to: twin.agentId,
        // 同一个人手下 + 同职能 + 只差一项细节能力 → 这是"最小能力改动"的实验台。
        detailFrom: mains.find((item) => item.familyId === twin.familyId)?.detailCapabilities || [],
        detailTo: twin.detailCapabilities,
      })),
      /** 该找谁协作：按职能依赖序排出的参与者次序。 */
      dependencyOrder: orderParticipants(participants),
    });
  }
  return limit > 0 ? briefs.slice(0, limit) : briefs;
}

/**
 * 把参与者按**职能依赖序**排一遍。
 *
 * 排不出来的（团队里没有那个职能）就往后放，但保持原顺序 —— 这是"按声明序兜底"，
 * 不是"按 hash 兜底"：同一个人重跑必须得到同一条链，否则 gold 会随重跑漂移。
 *
 * 同职能多人时（主职能位 + 同职能近邻，family 相同 → rank 相同）**必须**用
 * `agentId` 做最终 tie-break。用输入下标做 tie-break 会让排序结果依赖调用方传进来的
 * 顺序：`orderParticipants(a)` 与 `orderParticipants(reverse(a))` 得到两条不同的链，
 * 而这条链是 gold 里"上游是谁"的来源。
 */
export function orderParticipants(participants) {
  const { order } = familyDependencyOrder();
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...participants]
    .sort((a, b) => {
      const ra = rank.has(a.familyId) ? rank.get(a.familyId) : order.length;
      const rb = rank.has(b.familyId) ? rank.get(b.familyId) : order.length;
      // tie-break 只用内容（agentId），不用位置（index）。
      return ra - rb || String(a.agentId).localeCompare(String(b.agentId));
    });
}

// ---------------------------------------------------------------------------
// 每个 brief 的 case 计划
// ---------------------------------------------------------------------------

/**
 * 一个 brief 出 10 条 case，覆盖 5 类漂移 + `no_drift` + 双注入 + 近邻替换。
 *
 * ## `shape` 与「语料形态」是两回事，别混
 *
 * `shape` 是**本协议的 case 标签**，只用于报告分组与人工对号（"这条是哪种玩法"）。
 * 真正决定注入细节的是 `rdmd_detective_dataset/lib/forms.mjs` 里的**形态目录**
 * （`F(id, gold, far, repair)` 那种对象），由 `pickForm(domain, type, rng, {kind})` 按
 * 域 × 类型 × 层级挑出来。
 *
 * 这两者曾经被当成一个东西：装配器拿到 `shape` 字符串就当成语料形态用，
 * 于是 `form.gold` 不是函数、`applyFormToNode` 直接抛 `TypeError`。
 * 名字分开之后这种混淆编译期就看得见了。
 *
 * ## 为什么每条 case 的**层级**要写死，而不是让 LLM 挑
 *
 * 层级决定了哪些字段合法（step 层没有 acceptance、没有富文本），也决定了闸门怎么判。
 * 让 LLM 挑层级，等于让一个不知道 `STEP_TIER_MISSING_FORMS` 的东西去挑，
 * 它一定会挑出 step 层的 wrong_acceptance 然后在自由文本里补一个 acceptance 字段
 * —— 那正是 `forms.mjs` 明确拒绝过的事。所以：**层级由协议钉死，LLM 只负责把句子写好**。
 */
export const CASE_PLAN = Object.freeze([
  { id: 'missing_dependency', status: 'drift', type: 'missing_dependency', tier: 'agent_task', shape: 'skip_upstream_output', structural: true },
  { id: 'wrong_agent', status: 'drift', type: 'wrong_agent', tier: 'agent_task', shape: 'wrong_family_takes_over' },
  { id: 'wrong_version', status: 'drift', type: 'wrong_version', tier: 'agent_task', shape: 'stale_window' },
  { id: 'wrong_acceptance', status: 'drift', type: 'wrong_acceptance', tier: 'agent_task', shape: 'loosened_gate' },
  { id: 'local_replan_step', status: 'drift', type: 'local_replan', tier: 'agent_step', shape: 'step_spawned_extra_step', structural: true },
  { id: 'missing_dependency_step', status: 'drift', type: 'missing_dependency', tier: 'agent_step', shape: 'step_skips_predecessor', structural: true },
  { id: 'wrong_agent_step', status: 'drift', type: 'wrong_agent', tier: 'agent_step', shape: 'step_offloaded' },
  { id: 'wrong_version_step', status: 'drift', type: 'wrong_version', tier: 'agent_step', shape: 'step_from_previous_revision' },
  { id: 'no_drift', status: 'no_drift', type: '', tier: '', shape: '' },
  { id: 'multi_inject', status: 'UNKNOWN', type: '', tier: '', shape: '', injections: 2 },
  { id: 'twin_swap', status: 'drift', type: 'wrong_agent', tier: 'agent_task', shape: 'twin_replaces_mainslot', viaCpdbSimilarity: true },
]);

/**
 * 把 case 计划落到具体 brief 上：挑真凶、挑替换者、算期望跳数。
 *
 * 真凶**不取第一个也不取最后一个**参与者：它必须有上游（否则 `missing_dependency`
 * 删不掉入边）也必须有 ≥3 跳的下游（否则写不出 hop≥3 的后果）。所以取依赖链的中间位置。
 */
export function planCases(brief) {
  const ordered = brief.dependencyOrder.filter((item) => !item.twin);
  if (ordered.length < 2) return [];
  const mid = Math.max(1, Math.min(ordered.length - 1, Math.floor(ordered.length / 2)));
  return CASE_PLAN.map((entry, index) => {
    // `twin_swap` 的真凶**必须**是那个有近邻的职能位 —— 近邻只存在于 twin 覆盖的那个
    // 职能（`catalog.js` 的 `archetype.twin`）。随手取链中间那位的话，若它的职能没有近邻，
    // 这条 case 就没有替换者，"最小能力改动"实验直接退化成空跑（而且不会报错）。
    const swapTarget = entry.viaCpdbSimilarity
      ? ordered.find((item) => brief.similarSwapCandidates.some((pair) => pair.familyId === item.familyId))
      : null;
    // `missing_dependency` 要删的是一条**入边**，所以真凶不能是链首 —— 链首没有入边可删，
    // 注入会静默退化成"什么都没发生"，而 gold 里还写着 `injected_node`。
    const fallbackIndex = entry.type === 'missing_dependency' && mid === 0 ? 1 : mid;
    const target = swapTarget || ordered[Math.min(fallbackIndex + (index % 2), ordered.length - 1)];
    const caseId = `${brief.id}__${entry.id}`;
    return {
      caseId,
      briefId: brief.id,
      split: brief.split,
      kind: entry.id,
      status: entry.status,
      type: entry.type,
      tier: entry.tier,
      shape: entry.shape,
      structural: Boolean(entry.structural),
      viaCpdbSimilarity: Boolean(entry.viaCpdbSimilarity),
      targetAgentId: entry.tier === 'agent_step' ? participantForStep(ordered, brief, index) : target.agentId,
      targetTaskAgentId: target.agentId,
      // 相关的那位参与者。链首没有上游，就取下游 —— 但不能取自己：
      // `upstream === target` 会让"删掉入边"这条信号无处落脚，而报告里两个字段都有值，
      // 看起来完全正常。
      upstreamAgentId: neighbourOf(ordered, target),
      substituteAgentId: substituteFor(brief, entry, target),
      expected: {
        // 期望跳数就是协议的硬规则 1：后果从第 3 跳起。
        minHopToFirstEffect: entry.status === 'drift' ? MIN_HOP_TO_FIRST_EFFECT : 0,
        goldFields: entry.structural ? [] : (DRIFT_SPEC[entry.type]?.goldTouchesFields || []),
      },
    };
  });
}

/**
 * 取离 `target` 最近的那位**别的**参与者：先看上游，链首则看下游。
 *
 * 返回的一定不是 `target` 自己 —— 这一点必须由这个函数保证，不能靠调用方
 * `ordered[index - 1] || ordered[0]` 那种写法：链首时它会回落到 `ordered[0]`，
 * 也就是 target 自己。
 */
function neighbourOf(ordered, target) {
  const index = ordered.indexOf(target);
  const previous = ordered[index - 1];
  const next = ordered[index + 1];
  return (previous && previous.agentId !== target.agentId ? previous : next)?.agentId || '';
}

/**
 * step 层的真凶：`wrong_agent` 那条用**主职能位的步骤**（越权代跑才有意义），
 * `local_replan` / `wrong_version` 用中间那位的步骤。
 */
function participantForStep(ordered, brief, index) {
  const pick = index % 2 === 0 ? ordered[Math.max(0, ordered.length - 2)] : ordered[Math.floor(ordered.length / 2)];
  return pick?.agentId || brief.mainAgentIds[0] || '';
}

/**
 * 替换者怎么挑 —— 这里就是方案二（CPDB）落地的地方。
 *
 *   - `twin_swap`：换成**同职能近邻**（只差一项细节能力）。这是"最小能力改动"，
 *     换完结果变好/变坏都能归因到那一项细节能力上。依赖 `similarSwapCandidates`。
 *   - 其它 `wrong_agent`：换成**不同职能**的参与者。这是"能力错位"，
 *     差异大到不该归因到单项细节能力，只该判成 wrong_agent。
 *
 * 对照这两者，正是 CPDB 存在的意义：同样是"换了个 agent 结果崩了"，
 * 相似度高的那次能定位到细节能力，相似度低的那次只能定位到职能。
 */
function substituteFor(brief, entry, target) {
  if (entry.viaCpdbSimilarity) {
    const pair = brief.similarSwapCandidates.find((item) => item.familyId === target.familyId);
    return pair?.to || '';
  }
  if (entry.type !== 'wrong_agent') return '';
  const other = brief.dependencyOrder.find((item) => item.familyId !== target.familyId && !item.twin);
  return other?.agentId || '';
}

// ---------------------------------------------------------------------------
// gold：形状与语料逐字段对齐
// ---------------------------------------------------------------------------

/**
 * 产出一条 gold。**只用 `GOLD_FIELDS` 里的键**（外加双注入的复数键与 `inserted_nodes`）。
 *
 * 多写一个键会怎样：不会有任何东西报错，但 `collect.mjs` 算指标时会多出一列
 * 恒为 undefined 的"答案"，而报告里看不出来它是错的。所以这里用白名单构造，
 * 不是 `{...spread}`。
 */
export function goldOf({ status, nodeId = '', type = '', edgeId = '', formId = '', hopToFirstEffect = 0, decoyNodes = [], insertedNodes = [], multiNodes = [], multiTypes = [], multiForms = [] } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`sim_protocol_bad_status:${status}`);
  if (status === 'drift' && type && !DRIFT_TYPES.includes(type)) throw new Error(`sim_protocol_bad_type:${type}`);
  const gold = {
    status,
    injected_node: status === 'drift' ? String(nodeId) : '',
    injected_type: status === 'drift' ? String(type) : '',
    injected_edge: status === 'drift' ? String(edgeId) : '',
    injected_form: status === 'drift' ? String(formId) : '',
    hop_to_first_effect: status === 'drift' ? Number(hopToFirstEffect) : 0,
    decoy_nodes: [...decoyNodes],
  };
  // 双注入是**允许存在**的一种样本（`generate.mjs#makeUnknown` 就是这么造的），
  // 但它只评"弃权"，所以定位走复数键。
  if (status === 'UNKNOWN') {
    gold.injected_nodes = [...multiNodes];
    gold.injected_types = [...multiTypes];
    gold.injected_forms = [...multiForms];
  }
  // 注入本身插进来的节点（step 层 local_replan 的"增派一环"）。
  if (insertedNodes.length) gold[INSERTED_NODES_FIELD] = [...insertedNodes];
  return gold;
}

/** 协议里那些**能机器判**的约束，交给 `simulate.mjs` 在图生成之后自检。 */
export const CASE_GATES = Object.freeze([
  'nodes ⊆ ' + NODE_FIELDS.join(','),
  `hop 1–${PROPAGATION.effectStartsAtHop - 1} 的后代与 gold 之外一个字段都不能变`,
  `hop_to_first_effect >= ${MIN_HOP_TO_FIRST_EFFECT}`,
  'gold 不许碰 status',
  'step 层不许出现 acceptance / artifact / output / summary / inputs / version',
  'step 层不许出现 wrong_acceptance',
]);

/** 给 `simulate.mjs` 用的确定性 RNG（同 seed 同结果）。 */
export function rngFor(briefId, salt = 0) {
  let hash = 0;
  for (const char of `${briefId}:${salt}`) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return makeRng(hash || 1);
}

// ---------------------------------------------------------------------------
// 落盘：briefs.jsonl 与 case 计划
// ---------------------------------------------------------------------------

/**
 * `briefs.jsonl` 的**唯一**写法。
 *
 * 这个文件是可以从 `cpdb_org_world/data/full` 完全推导出来的，所以它有两种命运：
 *   1. 落盘并被测试盯住（`protocol.test.mjs` 断言磁盘上的内容 === 函数推导的内容）；
 *   2. 不落盘，每次跑的时候现推。
 *
 * 选 1，因为「这一轮到底用了哪些 agent」是报告里必须能被人复查的东西 ——
 * 如果它只活在内存里，一次 `--limit 3` 的跑和一次全量跑在报告上长得一模一样。
 * 落盘 + 过期即红 = 既可复查，又不会悄悄偏离真相源。
 */
export function briefsJsonl(briefs = buildBriefs({})) {
  return `${briefs.map((brief) => JSON.stringify(brief)).join('\n')}\n`;
}

export const BRIEFS_PATH = join(SIM_ROOT, 'briefs.jsonl');

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  // `node experiments/sim_task_group/lib/protocol.mjs [--write] [--cases]`
  const { writeFileSync } = await import('node:fs');
  const briefs = buildBriefs({});
  if (process.argv.includes('--write')) {
    writeFileSync(BRIEFS_PATH, briefsJsonl(briefs), 'utf8');
    console.log(`wrote ${BRIEFS_PATH} (${briefs.length} briefs)`);
  }
  if (process.argv.includes('--cases')) {
    const cases = briefs.flatMap((brief) => planCases(brief));
    console.log(JSON.stringify({
      schema: SIM_SCHEMA,
      briefs: briefs.length,
      cases: cases.length,
      bySplit: countBy(briefs, (brief) => brief.split),
      byKind: countBy(cases, (item) => item.kind),
      byStatus: countBy(cases, (item) => item.status),
      byTier: countBy(cases.filter((item) => item.tier), (item) => item.tier),
      families: familyDependencyOrder().order,
      brokenEdges: familyDependencyOrder().brokenEdges.map((edge) => `${edge.from}->${edge.to}(${edge.tokens.join(',')})`),
    }, null, 2));
  }
  if (!process.argv.includes('--write') && !process.argv.includes('--cases')) {
    console.log(JSON.stringify({ schema: SIM_SCHEMA, briefs: briefs.length, note: '--write 落盘 briefs.jsonl；--cases 打印 case 分布' }, null, 2));
  }
}

function countBy(list, keyOf) {
  const out = {};
  for (const item of list) {
    const key = keyOf(item) || '(none)';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}
