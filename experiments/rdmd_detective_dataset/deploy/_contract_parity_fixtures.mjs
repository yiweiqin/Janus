// JS 侧的契约判定，供 test_rdmd_detective.py 的 ContractParityWithJs 逐条比对。
//
// 为什么要有这个脚本：契约现在有两份实现（src/shared/contracts/uBuddyPlanExec.js 的
// planExecContractGaps 与 deploy/rdmd_detective.py 的 check_case_contract）。两份实现
// 各自单测都能过，却可能在「kind 缺失怎么回退」「哪些字段要判」「哪一侧该判哪些字段」
// 上悄悄分叉 —— 而分叉的后果是：JS 认为这条 case 可以推理、Python 认为不行（或反过来），
// 于是 fail-closed 失效，且没有任何运行时症状。
//
// 所以这里不引用任何 Python，只输出「输入 + JS 的判定」，由 Python 侧在同一批输入上
// 跑自己的判定并断言逐条相等。任何一侧改了判据，这个用例立刻红。
//
// 用法：node _contract_parity_fixtures.mjs        # 输出 JSON 到 stdout
//
// 前缀 `_` 是刻意的：_rdmd_push_dir.py 会跳过下划线开头的文件，所以这个测试专用脚本
// 不会被推到训练盒 / 云端盒上。
import { planExecContractGaps } from '../../../src/shared/contracts/uBuddyPlanExec.js';

const task = (id, overrides = {}) => ({
  id, title: id, summary: `${id} 的摘要`, output: `${id} 的结果`, ...overrides,
});

// 规划侧的真实形状：提案节点只带 title/agentId（没有 outcome 文本）。
const proposal = (id, overrides = {}) => ({ id, title: id, agentId: 'agent', ...overrides });

// 覆盖面刻意压在**可能分叉**的地方：kind 缺失/未知、每一档的每个必需字段各缺一次、
// 空图、v2 放宽掉的那三个无来源字段、以及 (c) 的「哪一侧写得出来」。
// `exec` 省略时与 `plan` 相同（单图 fixture 的老写法）。
const FIXTURES = [
  {
    name: 'fallback_no_kind_missing_tier_fields',
    note: 'kind 缺失 -> 回退最严的 agent_task 档；summary/output 空',
    graphs: { nodes: [{ id: 'n1', title: 'n1' }], edges: [] },
  },
  {
    name: 'fallback_no_kind_complete',
    note: 'kind 缺失但 agent_task 档的三个字段齐全 -> 无缺口',
    graphs: { nodes: [task('n1')], edges: [] },
  },
  {
    name: 'unknown_kind_falls_back',
    note: '未知 kind 必须与 kind 缺失同样回退，不能「不判」',
    graphs: { nodes: [task('n1', { kind: 'mystery_layer', summary: '' })], edges: [] },
  },
  {
    name: 'agent_task_missing_each_required_field',
    note: 'agent_task 档：title / summary / output 各缺一次',
    graphs: {
      nodes: [
        task('t1', { kind: 'agent_task', title: '' }),
        task('t2', { kind: 'agent_task', summary: '' }),
        task('t3', { kind: 'agent_task', output: '' }),
      ],
      edges: [],
    },
  },
  {
    name: 'agent_step_complete',
    note: 'step 档的可见字段齐全（title）；无论 status 是否已进 prompt，这条都该通过',
    graphs: {
      nodes: [{ id: 's1', title: '第 1 步', kind: 'agent_step', status: 'completed' }],
      edges: [],
    },
  },
  {
    name: 'agent_step_missing_status',
    // 这条 fixture 的归属由 **status 的可见性**决定，两侧必须同时翻转：
    //   status 不在 NODE_FIELDS 时 -> 通过（契约不许要求模型读不到的字段）
    //   status 进了 NODE_FIELDS 时 -> 失败（step 档唯一真正的漂移信号，必须判）
    // 它同时是「两处 prompt 有没有同步」的探针：只改一侧，JS↔Python 逐条比对立刻红。
    note: 'step 档缺 status；此刻不在必需集里（status 还没进 prompt），P2 进 prompt 后必须报',
    graphs: {
      nodes: [{ id: 's1', title: '第 1 步', kind: 'agent_step', status: '' }],
      edges: [],
    },
  },
  {
    name: 'agent_step_missing_title',
    note: 'step 档的 title 是可见字段，缺了必须报',
    graphs: { nodes: [{ id: 's1', title: '', kind: 'agent_step', status: 'running' }], edges: [] },
  },
  {
    name: 'root_and_ubuddy_only_need_title',
    note: '容器层只要 title；它们的富文本为空是正常的，不该报',
    graphs: {
      nodes: [
        { id: 'r', title: 'root', kind: 'root' },
        { id: 'u', title: 'uBuddy', kind: 'ubuddy' },
        { id: 'r2', title: '', kind: 'root' },
      ],
      edges: [],
    },
  },
  {
    name: 'no_source_fields_are_not_required',
    note: 'v2 放宽：artifact/stage/inputs 无来源，清空它们不产生缺口（顺序也要一致）',
    graphs: {
      nodes: [task('n1', { artifact: '', stage: '', inputs: '' }), task('n2', { artifact: '' })],
      edges: [{ id: 'n1->n2', from: 'n1', to: 'n2' }],
    },
  },
  {
    name: 'node_without_id_is_dropped_by_both_sides',
    note: '两侧都必须丢掉空 id 的节点，否则缺口数会对不上',
    graphs: { nodes: [task('n1'), { id: '', title: 'no id' }], edges: [] },
  },
  {
    name: 'edge_to_missing_endpoint_dropped',
    note: '悬空边两侧都丢；边不影响缺口，但它会影响节点集合的判定顺序',
    graphs: { nodes: [task('n1')], edges: [{ id: 'e', from: 'n1', to: 'ghost' }] },
  },
  {
    name: 'long_fields_are_non_empty_after_truncation',
    note: '超长字段截断后仍非空 -> 两侧都不该报（截断上限不同也不能影响「是否为空」）',
    graphs: { nodes: [task('n1', { summary: '摘'.repeat(900), output: '结'.repeat(900) })], edges: [] },
  },
  {
    name: 'whitespace_only_counts_as_empty',
    note: '折叠空白 + trim 之后是空串 -> 两侧都必须当成缺字段',
    graphs: { nodes: [task('n1', { summary: '   \n\t  ' })], edges: [] },
  },
  {
    name: 'plan_side_does_not_require_outcome_text',
    // (c) 的核心用例：规划侧的 agent_task 只有 title/agentId（提案节点本来就只带这些），
    // 而执行侧同一个节点有 summary/output。契约**不得**在规划侧要求那两个字段 ——
    // 否则每个真实群任务都恒 fail-closed（每个提案节点稳定两条缺口）。
    note: '规划侧缺 summary/output 必须放过；执行侧同名节点有 outcome 文本',
    plan: { nodes: [proposal('n1', { kind: 'agent_task', agentId: 'data_agent_5' })], edges: [] },
    exec: {
      nodes: [task('n1', {
        kind: 'agent_task', agentId: 'data_agent_5',
        summary: '对字段做了缺失值处理', output: '产出 12 列宽表',
      })],
      edges: [],
    },
  },
  {
    name: 'exec_side_still_requires_outcome_text',
    // 与上一条配对：放宽只发生在规划侧。执行侧缺 output 仍必须报。
    note: '执行侧的 agent_task 缺 output 仍然必须报，放宽不能漏到执行侧',
    plan: { nodes: [proposal('n1', { kind: 'agent_task' })], edges: [] },
    exec: { nodes: [task('n1', { kind: 'agent_task', output: '' })], edges: [] },
  },
  {
    name: 'plan_side_missing_title_still_fails',
    // (c) 只去掉 outcome 文本，不能顺手把 title 也放掉 —— 否则规划侧就没在判了。
    note: '规划侧仍然要判 title',
    plan: { nodes: [proposal('n1', { kind: 'agent_task', title: '' })], edges: [] },
    exec: { nodes: [task('n1', { kind: 'agent_task' })], edges: [] },
  },
  {
    name: 'plan_side_step_missing_title_still_fails',
    note: '规划侧的 agent_step 同样要判 title',
    plan: {
      nodes: [{ id: 's1', title: '', kind: 'agent_step', status: 'queued' }],
      edges: [],
    },
    exec: {
      nodes: [{ id: 's1', title: '第 1 步', kind: 'agent_step', status: 'completed' }],
      edges: [],
    },
  },
  {
    name: 'empty_plan_graph_is_reported_on_the_plan_side',
    note: '规划图为空 -> 报在 G_star 上，不能因为执行图完好就放过',
    plan: { nodes: [], edges: [] },
    exec: { nodes: [task('n1')], edges: [] },
  },
];

/** 两侧共用的规范化问题串。Python 侧的 check_case_contract 原生就是这个形状。 */
function problemsOf(plan, exec) {
  return planExecContractGaps({ G_star: plan, G_prime: exec }).map((gap) => (
    gap.field === 'nodes' ? `${gap.graph}:no_nodes` : `${gap.graph}:${gap.nodeId}:empty_${gap.field}`
  ));
}

const fixtures = FIXTURES.map((fixture) => {
  const plan = fixture.plan || fixture.graphs;
  const exec = fixture.exec || fixture.graphs;
  return { name: fixture.name, note: fixture.note, G_star: plan, G_prime: exec };
});

const verdicts = {};
for (const fixture of fixtures) {
  verdicts[fixture.name] = problemsOf(fixture.G_star, fixture.G_prime);
}

process.stdout.write(JSON.stringify({ fixtures, verdicts }, null, 2) + '\n');
