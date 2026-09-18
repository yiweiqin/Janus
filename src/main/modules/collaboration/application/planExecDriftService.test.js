/**
 * planExecDriftService 的纪律测试。
 *
 * 这个模块只有一件事值得被机器守住：**任何不确定都必须退化成 record_only**。
 * 它跑在任务终态的收尾路径里，还要起 Python 子进程，所以它的失败模式不是崩溃，
 * 而是「悄悄地做了一个不该做的动作」。下面每一条不可用原因都单独钉一遍。
 *
 * 运行：node --test src/main/modules/collaboration/application/planExecDriftService.test.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RDMD_PLAN_EXEC_RECORD_VERSION,
  createPlanExecDriftService,
  planExecDriftEventId,
  planExecDriftRecord,
  rdmdInferenceArgs,
  resolveRdmdInferenceConfig,
  runRdmdInference,
  truthQualification,
} from './planExecDriftService.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const RICH = Object.freeze({
  artifact: 'artifact text', stage: 'stage text', inputs: 'inputs text',
  output: 'output text', summary: 'summary text',
});

/** `readPlanExecGraphs` 的真实返回形状（见 collaborationGraphStoreMethods.js）。 */
function readerOutput({ gaps = [], execExtra = false } = {}) {
  const plan = {
    nodes: [
      { id: 'root', title: 'Launch', agentId: 'agent', version: 'v1', acceptance: 'standard', role: '', kind: 'root' },
      { id: 'tn_a', title: '研究', agentId: 'research_agent', version: 'v1', acceptance: 'standard', role: '', kind: 'agent_task', ...RICH },
    ],
    edges: [{ id: 'root->tn_a', from: 'root', to: 'tn_a' }],
  };
  const exec = {
    nodes: [
      ...plan.nodes.slice(0, 1),
      { ...plan.nodes[1], agentId: 'intern_scribe', ...RICH },
      ...(execExtra ? [{ id: 'tn_b', title: '复核', agentId: 'review_agent', version: 'v1', acceptance: 'standard', role: '', kind: 'agent_task', ...RICH }] : []),
    ],
    edges: [{ id: 'root->tn_a', from: 'root', to: 'tn_a' }],
  };
  return {
    scope: { graphId: 'graph_1', revision: 7, taskRunId: 'task_1', delegationId: '', groupId: 'group_1', taskRunIds: ['task_1'] },
    plan,
    exec,
    mapping: { organizationalJoinKey: 'title' },
    case: { id: 'group_1', G_star: plan, G_prime: exec },
    gaps,
    gapSummary: gaps.length
      ? { total: gaps.length, byField: { artifact: gaps.length }, emptyRichFieldCount: gaps.length }
      : { total: 0, byField: {}, emptyRichFieldCount: 0 },
    metric: { ready: true, missing: [] },
    constants: { version: 'v1', acceptance: 'standard' },
    fieldSources: {},
    memory: {},
  };
}

/**
 * 假 spawn：按 `--output` 的位置写出指定记录，然后 close。
 *
 * `runRdmdInference` 的临时目录是它自己建的，所以假实现唯一的接口就是命令行参数
 * —— 而这也顺带证明了「输出路径确实是通过参数传下去的」。
 */
function fakeSpawn({ code = 0, record = null, writeRecord = true, neverCloses = false } = {}) {
  const calls = [];
  const impl = (command, args, options) => {
    calls.push({ command, args, options });
    const handlers = {};
    const child = {
      stdout: { on() {} },
      stderr: { on() {} },
      on(event, handler) { handlers[event] = handler; return child; },
      kill() { handlers.close?.(-1); return true; },
    };
    if (!neverCloses) {
      setTimeout(() => {
        if (writeRecord && record) {
          const outputPath = args[args.indexOf('--output') + 1];
          fs.writeFileSync(outputPath, `${JSON.stringify(record)}\n`, 'utf-8');
        }
        handlers.close?.(code);
      }, 0);
    }
    return child;
  };
  impl.calls = calls;
  return impl;
}

function validRecord(verdict = {}) {
  return {
    id: 'group_1',
    verdict: {
      status: 'drift', nodeId: 'tn_a', edgeId: '', type: 'wrong_agent', evidenceNodeIds: ['tn_a'],
      ...verdict,
    },
    raw: '',
    valid: true,
    warnings: [],
  };
}

const CONFIGURED = Object.freeze({
  configured: true, reason: '', python: 'python', script: path.join(HERE, 'fake_predict.py'),
  adapter: '/adapters/qlora-v3', model: '/models/Qwen3-8B', device: 'cuda:0', timeoutMs: 10_000,
});

/**
 * 云通道的配置。注意它**故意不含** adapter/script —— 云通道下桌面端没有这些东西，
 * 拿本地那几个字段判可用性会把生产路径判成不可用。
 */
const CLOUD_CONFIGURED = Object.freeze({
  configured: true, reason: '', transport: 'cloud',
  cloudUrl: 'https://cloud.example.test', taskRunId: 'task_1', conversationKind: '',
});

function tempDirs() {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('janus-rdmd-'));
}

// ---------------------------------------------------------------------------
// 进程边界
// ---------------------------------------------------------------------------

test('模型可用性是三态：没配 / 脚本不在 / 可用，且都不是错误', () => {
  const missingScript = resolveRdmdInferenceConfig({ root: 'D:/nowhere', env: { RDMD_ADAPTER: '/a' }, existsSync: () => false });
  assert.equal(missingScript.configured, false);
  assert.equal(missingScript.reason, 'model_script_missing');

  // 桌面端默认就是这个状态：既没有 GPU 也没有 adapter。
  const unconfigured = resolveRdmdInferenceConfig({ root: '', env: {}, existsSync: () => true });
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.reason, 'model_not_configured');

  const ready = resolveRdmdInferenceConfig({
    root: 'D:/repo', env: { RDMD_ADAPTER: '/a', RDMD_BASE_MODEL: '/m' }, existsSync: () => true,
  });
  assert.equal(ready.configured, true);
  assert.equal(ready.reason, '');
  assert.equal(ready.script, path.join('D:/repo', 'experiments', 'rdmd_detective_dataset', 'deploy', 'predict.py'));
});

test('命令行参数把 adapter 与 model 都传下去，且 device 恒有值', () => {
  const args = rdmdInferenceArgs({ script: '/s/predict.py', casePath: '/t/case.json', outputPath: '/t/out.jsonl', adapter: '/a', model: '/m', device: '' });
  assert.deepEqual(args, ['/s/predict.py', '--input', '/t/case.json', '--output', '/t/out.jsonl', '--adapter', '/a', '--model', '/m', '--device', 'cuda:0']);
  // 没配 adapter 时不该凭空补一个空串参数 —— predict.py 会拿它去查 adapter_config.json。
  assert.equal(rdmdInferenceArgs({ script: '/s', casePath: '/c', outputPath: '/o' }).includes('--adapter'), false);
});

test('没配置就根本不起进程，且临时目录不留垃圾', async () => {
  const spawnImpl = fakeSpawn({});
  const result = await runRdmdInference({ case: {}, config: { configured: false, reason: 'model_not_configured' }, spawnImpl });
  assert.deepEqual(result, { invoked: false, ok: false, reason: 'model_not_configured' });
  assert.equal(spawnImpl.calls.length, 0);
});

test('一条可用判定会被解析出来，且临时目录被清掉', async () => {
  const before = tempDirs();
  const result = await runRdmdInference({ case: { id: 'c' }, config: CONFIGURED, spawnImpl: fakeSpawn({ record: validRecord() }) });
  assert.equal(result.invoked, true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.verdict, {
    status: 'drift', nodeId: 'tn_a', edgeId: '', type: 'wrong_agent', evidenceNodeIds: ['tn_a'],
  });
  assert.deepEqual(tempDirs(), before, '临时目录必须清理干净');
});

test('每条失败路径都有自己的原因码，且都不抛异常', async () => {
  const cases = [
    // 退出码 2 = predict.py 自己的输入/环境错误（读不进输入、adapter 目录不对）。
    [{ code: 2 }, 'model_environment_error'],
    // valid:false 里带 input_contract_violation: 前缀 = 输入缺字段，要去补数据。
    [{ record: { id: 'c', verdict: {}, raw: '', valid: false, warnings: ['input_contract_violation:G_star:n1:empty_artifact'] } }, 'model_contract_violation'],
    // 其它 valid:false = 运行时故障（含节点幻觉），要去查环境。
    [{ record: { id: 'c', verdict: {}, raw: '', valid: false, warnings: ['inference_error:RuntimeError'] } }, 'model_invalid_verdict'],
    [{ record: { id: 'c', verdict: { status: 'drift', nodeId: 'x' }, raw: '', valid: true, warnings: [] } }, 'model_unknown_drift_type'],
    [{ record: validRecord(), writeRecord: false }, 'model_output_missing'],
  ];
  for (const [options, reason] of cases) {
    const result = await runRdmdInference({ case: {}, config: CONFIGURED, spawnImpl: fakeSpawn(options) });
    assert.equal(result.invoked, true);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason, `expected ${reason}, got ${result.reason}`);
  }
});

test('概念外的 drift type 在进路由之前就被拦下', async () => {
  // routeEvolution 对未知 type 是**兜底成** minimal_plan_edit，所以这里不拦就等于放行一次改图。
  const result = await runRdmdInference({
    case: {}, config: CONFIGURED,
    spawnImpl: fakeSpawn({ record: validRecord({ type: 'epic_mistake' }) }),
  });
  assert.equal(result.reason, 'model_unknown_drift_type');
  assert.equal(result.verdict.type, 'epic_mistake');
});

test('子进程超时被降级成一条原因码，不是一次未捕获的拒绝', async () => {
  const result = await runRdmdInference({
    case: {}, config: { ...CONFIGURED, timeoutMs: 5 },
    spawnImpl: fakeSpawn({ neverCloses: true }),
  });
  assert.equal(result.invoked, true);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'model_timeout');
});

test('起不来进程（ENOENT 之类）也只是一条原因码', async () => {
  const result = await runRdmdInference({
    case: {}, config: CONFIGURED,
    spawnImpl: () => { throw new Error('spawn python ENOENT'); },
  });
  assert.equal(result.reason, 'model_spawn_failed');
});

// ---------------------------------------------------------------------------
// 云通道（P4）
// ---------------------------------------------------------------------------

const CLOUD_VERDICT = Object.freeze({
  status: 'drift', nodeId: 'tn_a', type: 'wrong_agent', valid: true, warnings: [],
});

function cloudConfig(overrides = {}) {
  return { ...CLOUD_CONFIGURED, ...overrides };
}

test('通道选择：云 > 本地 > 无，且可被 RDMD_TRANSPORT 显式覆盖', () => {
  const both = resolveRdmdInferenceConfig({
    root: 'D:/repo', env: { RDMD_ADAPTER: '/a', RDMD_BASE_MODEL: '/m' }, existsSync: () => true,
    cloud: { serverUrl: 'https://cloud.example.test', infer: async () => ({}) },
  });
  assert.equal(both.transport, 'cloud', '生产优先云：云可用时本地那几个字段不该参与决策');

  const localOnly = resolveRdmdInferenceConfig({
    root: 'D:/repo', env: { RDMD_ADAPTER: '/a', RDMD_BASE_MODEL: '/m' }, existsSync: () => true,
    cloud: { serverUrl: 'https://cloud.example.test' },
  });
  assert.equal(localOnly.transport, 'local_spawn', '没有 infer 通道 = 云不可用');

  const nothing = resolveRdmdInferenceConfig({ root: '', env: {}, existsSync: () => true });
  assert.equal(nothing.transport, 'none');
  assert.equal(nothing.configured, false);

  // 离线/开发用显式覆盖。**云就绪也不许悄悄盖掉这个决定**。
  const forcedLocal = resolveRdmdInferenceConfig({
    root: 'D:/repo', env: { RDMD_ADAPTER: '/a', RDMD_BASE_MODEL: '/m', RDMD_TRANSPORT: 'local_spawn' },
    existsSync: () => true, cloud: { serverUrl: 'https://cloud.example.test', infer: async () => ({}) },
  });
  assert.equal(forcedLocal.transport, 'local_spawn');

  // 显式点名云但没配地址：不是"降级本地"，是配置错误 —— 原因必须指出来。
  const forcedCloud = resolveRdmdInferenceConfig({ root: 'D:/repo', env: { RDMD_TRANSPORT: 'cloud' }, existsSync: () => true });
  assert.equal(forcedCloud.transport, 'cloud');
  assert.equal(forcedCloud.configured, false);
  assert.equal(forcedCloud.reason, 'cloud_not_configured');

  // 显式关掉通道与"什么都没配"要能分开：一个是运维决定，一个是缺配置。
  const disabled = resolveRdmdInferenceConfig({
    root: 'D:/repo', env: { RDMD_ADAPTER: '/a', RDMD_BASE_MODEL: '/m', RDMD_TRANSPORT: 'none' }, existsSync: () => true,
  });
  assert.equal(disabled.configured, false);
  assert.equal(disabled.reason, 'transport_disabled');
});

test('云通道成功时产出与本地通道同形的结果', async () => {
  const calls = [];
  const result = await runRdmdInference({
    case: { id: 'group_1' },
    config: cloudConfig(),
    cloudInfer: async (input) => { calls.push(input); return { status: 'completed', jobId: 'rdmdjob_1', verdict: CLOUD_VERDICT, errorCode: '' }; },
  });
  assert.equal(result.invoked, true);
  assert.equal(result.ok, true);
  assert.equal(result.verdict.status, 'drift');
  assert.equal(result.verdict.nodeId, 'tn_a');
  assert.equal(result.verdict.type, 'wrong_agent');
  // 提交时必须把 taskRunId 与 conversationKind 一起带上：前者是云侧作业的去重键，
  // 后者是隐私白名单的判据（private_assistant 一律不带出去）。
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskRunId, 'task_1');
  assert.equal(calls[0].conversationKind, '');
});

test('云通道的每条失败路径都有自己的原因码，且都没有本地兜底', async () => {
  const cases = [
    // 没登录：证书拿不到。**必须**是它自己，而不是笼统的 request_failed。
    [() => { const error = new Error('auth required'); error.code = 'cloud_auth_required'; throw error; }, 'cloud_auth_required'],
    // 轮询到 deadline：宁可报超时，也不要拿"还没有判定"当判定。
    [() => { const error = new Error('late'); error.code = 'rdmd_cloud_timeout'; throw error; }, 'cloud_verdict_timeout'],
    [() => { const error = new Error('ECONNREFUSED'); error.code = 'rdmd_cloud_unreachable'; throw error; }, 'cloud_unreachable'],
    [() => { const error = new Error('bad gateway'); error.status = 502; throw error; }, 'cloud_http_502'],
    // 隐私边界拒绝：这是设计，不是故障，原因要原样透出去。
    [async () => ({ status: 'not_eligible', reason: 'private_assistant_not_eligible', jobId: '', verdict: null }), 'private_assistant_not_eligible'],
    // 云侧没模型（null 后端）：UNKNOWN 不是可用判定，原因就是它自己的 reason。
    [async () => ({ status: 'unavailable', reason: 'model_not_configured', jobId: 'j', verdict: { status: 'UNKNOWN', reason: 'model_not_configured' } }), 'model_not_configured'],
    // 概念外的 type 在云通道上同样要拦 —— routeEvolution 对未知 type 兜底成改图动作。
    [async () => ({ status: 'completed', jobId: 'j', verdict: { ...CLOUD_VERDICT, type: 'epic_mistake' } }), 'model_unknown_drift_type'],
    // drift 但没给 nodeId：两侧契约分叉了，要单独报，不能混进 type 那条。
    [async () => ({ status: 'completed', jobId: 'j', verdict: { status: 'drift', type: 'wrong_agent', nodeId: '' } }), 'model_incomplete_verdict'],
    // 云侧回了空判定。
    [async () => ({ status: 'completed', jobId: 'j', verdict: null }), 'model_output_missing'],
    // 配置说走云但没人给它通道。
    [null, 'cloud_transport_unavailable', { configured: true, transport: 'cloud', reason: '', cloudInfer: null }],
  ];
  for (const [infer, reason, configOverride] of cases) {
    const result = await runRdmdInference({
      case: {}, config: configOverride || cloudConfig(), cloudInfer: infer || undefined,
    });
    assert.equal(result.ok === true, false, `expected no usable verdict for ${reason}`);
    assert.equal(result.reason, reason, `expected ${reason}, got ${result.reason}`);
  }
});

test('reason 在 / no_drift 这两个判定也走成功路径', async () => {
  const result = await runRdmdInference({
    case: {}, config: cloudConfig(),
    cloudInfer: async () => ({ status: 'completed', jobId: 'j', verdict: { status: 'no_drift', nodeId: '', type: '', warnings: [] } }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.verdict.status, 'no_drift');
});

test('云通道下 record 把 transport 写进记录，且判定不参与真值', async () => {
  const service = createPlanExecDriftService({
    store: { readPlanExecGraphs: () => readerOutput(), recordTaskEvent: () => {} },
    root: '',
    env: { RDMD_TRANSPORT: 'cloud' },
    featureFlags: { snapshot: () => ({ planExecDrift: true }) },
    cloud: { serverUrl: 'https://cloud.example.test', infer: async () => ({ status: 'unavailable', reason: 'model_not_configured', verdict: { status: 'UNKNOWN', reason: 'model_not_configured' } }) },
    now: () => '2026-01-01T00:00:00.000Z',
  });
  assert.equal(service.config().transport, 'cloud');
  const record = await service.record({ task: { id: 'task_1', status: 'completed', ownerUserId: 'u1' } });
  // 空后端（云侧没模型）下，链路走通、判定不可用、动作恒为 record_only —— 这就是 P4 的验收。
  assert.equal(record.model.transport, 'cloud');
  assert.equal(record.model.invoked, true);
  assert.equal(record.model.ok, false);
  assert.equal(record.model.reason, 'model_not_configured');
  assert.equal(record.decision.action, 'record_only');
  assert.equal(record.phase, 'record_only');
});

test('private_assistant 会话把 conversationKind 交给隐私闸门，而不是在这里放行', async () => {
  const seen = [];
  const service = createPlanExecDriftService({
    store: { readPlanExecGraphs: () => readerOutput(), recordTaskEvent: () => {} },
    root: '',
    env: { RDMD_TRANSPORT: 'cloud' },
    featureFlags: { snapshot: () => ({ planExecDrift: true }) },
    cloud: {
      serverUrl: 'https://cloud.example.test',
      infer: async (input) => {
        seen.push(input.conversationKind);
        // 真实实现里这一步由云侧 privacy.mjs 判定；这里模拟它拒绝。
        return input.conversationKind === 'private_assistant'
          ? { status: 'not_eligible', reason: 'private_assistant_not_eligible', jobId: '', verdict: null }
          : { status: 'completed', jobId: 'j', verdict: CLOUD_VERDICT };
      },
    },
  });
  const record = await service.record({ task: { id: 'task_pa', status: 'completed', ownerUserId: 'u1', departmentId: 'private_assistant' } });
  assert.deepEqual(seen, ['private_assistant']);
  assert.equal(record.decision.action, 'record_only');
  assert.equal(record.model.reason, 'private_assistant_not_eligible');
});

// ---------------------------------------------------------------------------
// 记录与路由（纯函数）
// ---------------------------------------------------------------------------

test('真值资格：只有成功收口的 run 才是真值', () => {
  assert.deepEqual(truthQualification('completed'), { accepted: true, reason: 'run_completed' });
  assert.equal(truthQualification('failed').accepted, false);
  assert.equal(truthQualification('cancelled').accepted, false);
  // 状态缺失不能默认成真值 —— 「没观测到失败」不等于「成功」。
  assert.deepEqual(truthQualification(''), { accepted: false, reason: 'run_status_unknown' });
});

test('读不到图 = no_graph，不产生任何动作', () => {
  const record = planExecDriftRecord({ read: null, taskRunId: 'task_1', taskStatus: 'completed' });
  assert.equal(record.status, 'no_graph');
  assert.equal(record.decision.action, 'record_only');
  assert.equal(record.decision.reason, 'no_graph');
  assert.equal(record.metric, null);
  assert.equal(record.model.invoked, false);
});

test('缺富文本字段时退化成 record_only，但度量照算 —— 两件事必须分开报', () => {
  const read = readerOutput({ gaps: [{ graph: 'G_star', nodeId: 'tn_a', field: 'artifact' }] });
  const record = planExecDriftRecord({
    read, taskRunId: 'task_1', taskStatus: 'completed',
    model: { invoked: false, ok: false, reason: 'input_contract_violation' },
    now: '2026-09-16T00:00:00.000Z',
  });
  assert.equal(record.status, 'contract_gap');
  assert.equal(record.decision.action, 'record_only');
  assert.equal(record.decision.reason, 'input_contract_violation');
  assert.equal(record.model.invoked, false);
  assert.equal(record.model.valid, null, '没调用模型时 valid 是不适用，不是无效');
  // 度量只读 7 个字段 + 边，今天就能跑：输入缺字段不该把度量一起说成不可用。
  assert.equal(typeof record.metric.score, 'number');
  assert.equal(record.metric.score < 1, true, '规划说 research_agent、现实是 intern_scribe');
  assert.equal(record.gaps.emptyRichFieldCount, 1);
});

test('模型判定可用时按 routeEvolution 的出口走', () => {
  const read = readerOutput();
  const table = [
    [{ status: 'drift', type: 'wrong_agent', nodeId: 'tn_a' }, 'similar_swap'],
    [{ status: 'drift', type: 'missing_dependency', nodeId: 'tn_a', edgeId: 'e1' }, 'minimal_plan_edit'],
    [{ status: 'drift', type: 'local_replan', nodeId: 'tn_a' }, 'minimal_plan_edit'],
    [{ status: 'drift', type: 'wrong_version', nodeId: 'tn_a' }, 'minimal_plan_edit'],
    [{ status: 'no_drift', nodeId: '', type: '' }, 'record_only'],
    [{ status: 'UNKNOWN', nodeId: '', type: '' }, 'record_only'],
  ];
  for (const [verdict, action] of table) {
    const record = planExecDriftRecord({
      read, taskRunId: 'task_1', taskStatus: 'completed',
      model: { invoked: true, ok: true, reason: '', verdict },
    });
    assert.equal(record.decision.action, action, `${verdict.type || verdict.status} -> ${action}`);
    assert.equal(record.model.invoked, true);
    assert.equal(record.model.valid, true);
  }
});

test('模型跑了但判定不可信时不许退化成 JS 候选 —— 只能 record_only', () => {
  const read = readerOutput();
  for (const reason of ['model_timeout', 'model_invalid_verdict', 'model_unknown_drift_type', 'model_environment_error']) {
    const record = planExecDriftRecord({
      read, taskRunId: 'task_1', taskStatus: 'completed',
      model: { invoked: true, ok: false, reason, verdict: { status: 'drift', type: 'wrong_agent', nodeId: 'tn_a' } },
    });
    assert.equal(record.decision.action, 'record_only', reason);
    assert.equal(record.decision.reason, reason);
    assert.equal(record.model.ok, false);
  }
});

test('JS 度量给出候选也只是证据，不构成动作', () => {
  // 执行图里多出一个节点。
  const read = readerOutput({ execExtra: true });
  const model = { invoked: false, ok: false, reason: 'model_not_configured' };

  // 默认阈值 0.8 下 JS 度量认为**已经够接近**了（0.8 恰好达标）——这正是防过拟合该有的样子：
  // 「不需要完全向执行图靠拢」意味着有时连一处都不用改。
  const lenient = planExecDriftRecord({ read, taskRunId: 'task_1', taskStatus: 'completed', model });
  assert.equal(lenient.metric.alreadyCloseEnough, true);
  assert.equal(lenient.candidate.op, '');
  assert.equal(lenient.candidate.reached, true);

  // 阈值提到 0.95 才会指名道姓地说出该改哪一处。注意这只是**证据**：
  // 度量回答「差多少」，不回答「是谁导致的」——归因是模型的职责，没有模型就没有归因。
  const strict = planExecDriftRecord({ read, taskRunId: 'task_1', taskStatus: 'completed', model, threshold: 0.95 });
  assert.equal(strict.metric.alreadyCloseEnough, false);
  assert.equal(strict.candidate.op, 'add_node');
  assert.equal(strict.candidate.reached, true);

  for (const record of [lenient, strict]) {
    assert.equal(record.decision.action, 'record_only');
    assert.equal(record.decision.reason, 'model_not_configured');
  }
});

test('记录里不含任何图文本，可以安全落进 task_events', () => {
  const read = readerOutput();
  // 把私密内容塞进两个图，断言它们不出现在记录里。
  read.plan.nodes[1].summary = 'PRIVATE plan summary';
  read.plan.nodes[1].output = 'PRIVATE result text /Users/alice/secret';
  read.exec.nodes[1].output = 'PRIVATE result text /Users/alice/secret';
  const record = planExecDriftRecord({
    read, taskRunId: 'task_1', taskStatus: 'completed',
    model: { invoked: true, ok: true, reason: '', verdict: { status: 'drift', type: 'wrong_agent', nodeId: 'tn_a' } },
  });
  const blob = JSON.stringify(record);
  assert.equal(blob.includes('PRIVATE'), false);
  assert.equal(blob.includes('Launch'), false, '连 title 也不进记录');
  assert.equal(blob.includes('research_agent'), false);
  // 留下的只有 id / 计数 / 分数 / 字段名。
  assert.equal(record.model.nodeId, 'tn_a');
  assert.equal(record.version, RDMD_PLAN_EXEC_RECORD_VERSION);
});

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

function serviceFixture({ flags = { planExecDrift: true }, read = readerOutput(), spawnImpl = fakeSpawn({}) } = {}) {
  const events = [];
  const store = {
    readPlanExecGraphs: () => read,
    recordTaskEvent: (event) => { events.push(event); return event; },
  };
  const service = createPlanExecDriftService({
    store,
    root: '',
    // 默认没有 RDMD_ADAPTER / RDMD_BASE_MODEL —— 这正是桌面端的默认状态。
    env: {},
    featureFlags: { snapshot: () => flags },
    spawnImpl,
    existsSync: () => true,
    now: () => '2026-09-16T00:00:00.000Z',
  });
  return { service, events, store };
}

test('终态入口：一次 run 只落一行，重复通知不会写出第二行', async () => {
  const { service, events } = serviceFixture();
  const task = { id: 'task_1', status: 'completed', ownerUserId: 'alice' };
  const first = await service.record({ task });
  const second = await service.record({ task });
  assert.equal(first.decision.action, 'record_only');
  assert.equal(second, null, '同一个 run 只评估一次');
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, planExecDriftEventId('task_1'));
  assert.equal(events[0].eventType, 'rdmd_plan_exec_drift');
  assert.equal(events[0].taskRunId, 'task_1');
});

test('开关关掉时什么都不做（连诊断也不落）', async () => {
  const { service, events } = serviceFixture({ flags: { planExecDrift: false } });
  const record = await service.record({ task: { id: 'task_1', status: 'completed' } });
  assert.equal(record, null);
  assert.deepEqual(events, []);
});

test('没有 task id 时提前返回，不写脏行', async () => {
  const { service, events } = serviceFixture();
  assert.equal(await service.record({ task: { status: 'completed' } }), null);
  assert.deepEqual(events, []);
});

test('没有协作图的任务（普通 run）不落诊断行 —— 那会把真有图的诊断淹掉', async () => {
  // `readPlanExecGraphs` 在没有图、且 lazy backfill 也失败时返回 null。
  const { service, events } = serviceFixture({ read: null });
  const record = await service.record({ task: { id: 'task_plain', status: 'completed' } });
  assert.equal(record.status, 'no_graph', '记录本身还是产出，供 inspect 用');
  assert.deepEqual(events, [], '但不落库');
});

test('落库失败不许把异常抛回任务终态的收尾路径', async () => {
  const warnings = [];
  const failing = createPlanExecDriftService({
    store: {
      readPlanExecGraphs: () => readerOutput(),
      recordTaskEvent: () => { throw new Error('database is locked'); },
    },
    env: {},
    featureFlags: { snapshot: () => ({ planExecDrift: true }) },
    spawnImpl: fakeSpawn({}),
    logger: { warn: (event) => warnings.push(event) },
  });
  const record = await failing.record({ task: { id: 'task_1', status: 'completed' } });
  assert.equal(record.status, 'evaluated', '记录本身仍然产出，只是没落库');
  assert.deepEqual(warnings, ['rdmd-plan-exec-record-failed']);
  assert.equal(failing.config().configured, false, '默认没有适配器');
});
