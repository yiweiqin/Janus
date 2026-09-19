/**
 * `rdmd_headless_core.mjs` 的回归测试。
 *
 * 为什么脚本自带断言了还要写这个：
 *
 * 1. **断言只在有人记得跑的时候才存在。** 这个脚本证明的是"去掉 Electron 之后，
 *    迁移 → 投影 → 读图 → `record()` → 落库 这条我们自己的链仍然成立"。它是
 *    `src/main/` 下那批纯 Node 模块的**唯一一条端到端证据**（其余套件要么用替身换掉
 *    `readPlanExecGraphs`，要么止步于"读到了图"）。证据链断了而没人发现，等于没证据。
 * 2. **退出码不是判据。** `record()` 把 `recordTaskEvent` 包在 try/catch 里、失败只
 *    `logger.warn`；`projectTaskRunToCollaborationGraph` 也可以静默少投影一层。
 *    这些失败**都不会让脚本崩**，只会让断言悄悄红。所以这里逐个点名断言的 id，
 *    而不是只看 `ok`。
 *
 * 这个文件用 `node --test` 跑（`npm run experiment:rdmd-headless-core:test`），
 * 与 `experiment:rdmd-chain-to-dag:test` 同一形状。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runHeadlessCore, HEADLESS_GROUP_ID, HEADLESS_TASK_RUN_ID } from './rdmd_headless_core.mjs';

/** 八条断言各自的"为什么它必须绿"——写在这里，红的时候不用回去翻脚本。 */
const REQUIRED = {
  A6_reprojection_is_a_noop: '同一批 plan 事件重投影必须什么都不动；否则"样本在积累"会变成"节点在膨胀"',
  A1_four_layer_projection: '投影要真的产出 root / agent_task / agent_step 三层节点 + sequence_of 链',
  A2_read_gives_two_graphs: 'readPlanExecGraphs 要真的读出 G_plan 与 G_exec 两张图',
  A2b_plan_and_exec_actually_differ: '两张图必须不同；相同就说明 plan 事件没被 revision 折叠',
  A3_record_status_not_no_graph: 'record() 必须读到图（status !== no_graph）',
  A4_event_landed_in_task_events: '诊断必须真的落进 task_events（persist 失败只 warn，返回值照样是对的）',
  A4b_raw_column_matches_api: '原始列口径要与 API 口径一致，否则报告脚本的 SQL 会读空',
  A5_no_graph_mutation: 'record() 不许碰协作图（三张表的行数与内容签名前后一致）',
};

let cached = null;
const report = async () => {
  if (!cached) cached = await runHeadlessCore({ keep: false });
  return cached;
};

test('headless core: every assertion is present and green', async () => {
  const out = await report();
  const byId = new Map(out.assertions.map((item) => [item.id, item]));

  const missing = Object.keys(REQUIRED).filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], `断言的 id 少了：${missing.join(', ')}（改过断言名就要同步这里）`);

  const red = Object.keys(REQUIRED).filter((id) => !byId.get(id).ok);
  assert.deepEqual(red.map((id) => `${id} — ${REQUIRED[id]}`), [], '有断言没通过');
  assert.equal(out.ok, true);
  assert.deepEqual(out.failedAssertions, []);
});

test('headless core: the drift diagnosis is a real row, not just a return value', async () => {
  const out = await report();
  // 这是整件事的终点。只断言返回值等于放任 `persist()` 静默失败 —— 那种失败没有症状。
  assert.equal(out.persisted.driftEventCount, 1);
  assert.deepEqual(out.persisted.eventIds, [`rdmd_plan_exec:${HEADLESS_TASK_RUN_ID}`]);
  assert.equal(out.persisted.rawColumns.phase, out.record.phase);
  assert.ok(out.record.phase, 'phase 不能为空——它是报告脚本分组的口径');
});

test('headless core: the task family anchors on the group, so samples accumulate', async () => {
  const out = await report();
  // 这条守的是本脚本改出来的那个 bug：`readPlanExecGraphs` 回抄入参而不是取快照里的
  // groupId，于是按 taskRunId 调进来时 scope.groupId 恒为空串、族退化成 task_run、
  // 每一轮同类任务都换族。族错了，提案数再涨也不是样本在积累。
  assert.equal(out.read.taskFamilyAnchorKind, 'group');
  assert.ok(out.record.taskFamilyId.startsWith(`${HEADLESS_GROUP_ID}::`),
    `族必须挂在群上，实际是 ${out.record.taskFamilyId}`);
  assert.notEqual(out.record.taskFamily?.degenerate, true);
});

test('headless core: the four-layer graph has the shape the drift reader assumes', async () => {
  const out = await report();
  const kinds = out.graph.nodesByKind.map((row) => row.kind).sort();
  assert.ok(kinds.includes('root'));
  assert.ok(kinds.includes('agent_task'));
  assert.ok(kinds.includes('agent_step'));
  assert.ok(out.graph.edgesByKind.some((row) => row.kind === 'sequence_of'),
    'step 层要有 sequence_of 链，否则"哪一步被砍了"读不出来');

  // A2 的语义：首版 3 步，最终 2 步 + 1 cancelled。两侧必须真的不一样。
  assert.notDeepEqual(out.read.planSteps, out.read.execSteps);
  assert.ok(out.read.execSteps.some((step) => step.status === 'cancelled'));
});

test('headless core: re-running against the same snapshot does not grow the graph', async () => {
  const first = await report();
  const second = await runHeadlessCore({ keep: false });
  // 两次都跑在**各自新建的临时库**上，所以能比的是"形状"而不是 row id。
  // 真正要守的是：行数不会因为多跑一遍而涨（`createTaskNode` 没有 providedId，
  // 不按标题复用就会一路追加重复节点）。
  assert.equal(second.graph.nodesByKind.length, first.graph.nodesByKind.length);
  assert.equal(second.persisted.driftEventCount, 1, '事件是 eventId upsert，重跑不该多出行');
  assert.deepEqual(second.read.execSteps, first.read.execSteps);
  assert.equal(second.ok, true);
});
