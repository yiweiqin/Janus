import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyRawAccessPipeline,
  inspectElevationItems,
  projectTaskPublicMemory,
} from '../../src/shared/contracts/uBuddyTaskPublicMemory.js';
import {
  attributeAfterSwap,
  dependencyScore,
  selectCollaborators,
  selectReplacement,
  similarityScore,
  updateDependencyScore,
} from '../../src/shared/contracts/uBuddyCapabilityDependencyBundle.js';
import {
  RDMD_DRIFT_TYPES,
  contrastDriftGraphs,
  detectMinimalDrift,
  injectMinimalDrift,
  routeEvolution,
} from '../../src/shared/contracts/uBuddyReverseDetective.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'out');
const SEED_COUNT = 240;

const PROFILES = {
  A: { agentId: 'A', capabilityTags: ['research', '信息整理'], deliverableTypes: ['spreadsheet'], supportedTaskTypes: ['research'] },
  B: { agentId: 'B', capabilityTags: ['research', '信息整理', 'source_verify'], deliverableTypes: ['spreadsheet'], supportedTaskTypes: ['research'] },
  C: { agentId: 'C', capabilityTags: ['writing', '文案'], deliverableTypes: ['report'], supportedTaskTypes: ['writing'] },
  D: { agentId: 'D', capabilityTags: ['ppt', '图表'], deliverableTypes: ['presentation'], supportedTaskTypes: ['presentation'] },
  E: { agentId: 'E', capabilityTags: ['ppt', '图表', '设计'], deliverableTypes: ['presentation'], supportedTaskTypes: ['presentation'] },
  F: { agentId: 'F', capabilityTags: ['code', 'backend'], deliverableTypes: ['code_change'], supportedTaskTypes: ['code_change'] },
};

function templates() {
  return [
    {
      id: 'report_fork',
      nodes: [
        node('intake', 'intake'), node('research', 'research'), node('data', 'data'),
        node('verify', 'review'), node('write', 'writing'), node('ppt', 'ppt'),
      ],
      edges: [
        edge('intake', 'research'), edge('intake', 'data'), edge('research', 'verify'),
        edge('verify', 'write'), edge('data', 'write'), edge('write', 'ppt'),
      ],
    },
    {
      id: 'linear_etl',
      nodes: ['ingest', 'clean', 'validate', 'transform', 'review', 'publish'].map((id) => node(id, id)),
      edges: [
        edge('ingest', 'clean'), edge('clean', 'validate'), edge('validate', 'transform'),
        edge('transform', 'review'), edge('review', 'publish'),
      ],
    },
    {
      id: 'brief_chain',
      nodes: ['interview', 'notes', 'synthesize', 'chart', 'deck', 'qa'].map((id) => node(id, id)),
      edges: [
        edge('interview', 'notes'), edge('notes', 'synthesize'), edge('synthesize', 'chart'),
        edge('chart', 'deck'), edge('deck', 'qa'),
      ],
    },
  ];
}

function node(id, role) {
  return { id, title: id, agentId: `agent_${id}`, version: 'v1', acceptance: 'standard', role };
}

function edge(from, to) {
  return { id: `${from}->${to}`, from, to };
}

function evaluateRdmd() {
  const families = templates();
  const types = RDMD_DRIFT_TYPES;
  const single = [];
  for (let seed = 0; seed < SEED_COUNT; seed += 1) {
    const plan = structuredClone(families[seed % families.length]);
    const type = types[seed % types.length];
    const injected = injectMinimalDrift(plan, { type, seed: seed + 3 });
    if (!injected.gold) continue;
    const detective = detectMinimalDrift(plan, injected.graph);
    const contrast = contrastDriftGraphs(plan, injected.graph);
    const topoTail = contrast.involvedNodeIds.at(-1) || '';
    const sortedFirst = [...contrast.involvedNodeIds].sort()[0] || '';
    single.push({
      type,
      gold: injected.gold.nodeId,
      detective: detective.nodeId,
      detectiveStatus: detective.status,
      detectiveType: detective.type,
      hit: detective.status === 'drift' && detective.nodeId === injected.gold.nodeId,
      typeHit: detective.type === injected.gold.type,
      terminalHit: topoTail === injected.gold.nodeId,
      firstHit: sortedFirst === injected.gold.nodeId,
      involved: contrast.involvedNodeIds.length,
      evidence: detective.evidenceNodeIds.length,
    });
  }

  const noDrift = families.map((plan) => detectMinimalDrift(plan, plan));
  const fork = families[0];
  const multi = [];
  for (const typeA of types) {
    for (const typeB of types) {
      if (typeA === typeB) continue;
      const one = injectMinimalDrift(fork, { type: typeA, nodeId: 'research' });
      if (!one.gold) continue;
      const two = injectMinimalDrift(one.graph, { type: typeB, nodeId: 'data' });
      if (!two.gold) continue;
      multi.push(detectMinimalDrift(fork, two.graph));
    }
  }

  const hit = mean(single.map((row) => Number(row.hit)));
  const typeHit = mean(single.map((row) => Number(row.typeHit)));
  const terminal = mean(single.map((row) => Number(row.terminalHit)));
  const first = mean(single.map((row) => Number(row.firstHit)));
  const involved = mean(single.map((row) => row.involved));
  const evidence = mean(single.map((row) => row.evidence));
  const noDriftRate = mean(noDrift.map((row) => Number(row.status === 'no_drift')));
  const unknownRate = mean(multi.map((row) => Number(row.status === 'UNKNOWN')));
  const byType = Object.fromEntries(types.map((type) => {
    const rows = single.filter((row) => row.type === type);
    return [type, { n: rows.length, hit: round(mean(rows.map((row) => Number(row.hit)))) }];
  }));

  const gates = {
    detective_hit_ge_0_80: hit >= 0.8,
    detective_beats_terminal_by_0_20: hit >= terminal + 0.2,
    no_drift_ge_0_95: noDriftRate >= 0.95,
    multi_unknown_ge_0_50: unknownRate >= 0.5,
    evidence_lt_involved: evidence < involved,
  };

  return {
    n: single.length,
    hit: round(hit),
    typeHit: round(typeHit),
    terminalBlameHit: round(terminal),
    firstDiffHit: round(first),
    meanInvolvedNodes: round(involved),
    meanDetectiveEvidence: round(evidence),
    noDriftRate: round(noDriftRate),
    multiInjectUnknownRate: round(unknownRate),
    byType,
    gates,
    pass: Object.values(gates).every(Boolean),
  };
}

function evaluateCpdb() {
  const { A, B, C, D, E, F } = PROFILES;
  const collab = selectCollaborators([A, D, F], C, { limit: 1 })[0];
  const swap = selectReplacement(A, [B, C, D, E, F], { limit: 1 })[0];
  const attributed = attributeAfterSwap({
    baselineUtility: 0.4, similarUtility: 0.82, randomUtility: 0.44,
    failedProfile: A, similarProfile: B,
  });
  const handback = attributeAfterSwap({
    baselineUtility: 0.4, similarUtility: 0.41, randomUtility: 0.4,
    failedProfile: A, similarProfile: B,
  });
  const pairs = [
    ['A->C dep', dependencyScore(A, C)],
    ['A~B sim', similarityScore(A, B)],
    ['A~C sim', similarityScore(A, C)],
    ['D~E sim', similarityScore(D, E)],
    ['D->E dep', dependencyScore(D, E)],
    ['A->F dep', dependencyScore(A, F)],
  ];
  const decay = [0, 1, 2, 4, 8].map((n) => updateDependencyScore(0.4, 1, n));
  const gates = {
    planning_picks_A_for_writer: collab.profile.agentId === 'A',
    replacement_picks_B_not_writer: swap.profile.agentId === 'B',
    dep_not_equal_sim_argmax: collab.profile.agentId !== swap.profile.agentId,
    similar_swap_isolates_source_verify: attributed.decision === 'attribute_capability_gap'
      && attributed.gap.onlyRight.includes('source_verify'),
    failed_swap_hands_back: handback.decision === 'hand_back_to_rdmd',
    decay_is_monotonic: decay.every((value, index) => index === 0 || value <= decay[index - 1] + 1e-9),
  };
  return { pairs: Object.fromEntries(pairs.map(([name, value]) => [name, round(value)])), decay: decay.map(round), collab, swap, attributed, handback, gates, pass: Object.values(gates).every(Boolean) };
}

function evaluateTpm() {
  const inspected = inspectElevationItems([
    { id: 'raw-ok', title: '数据里程碑', content: '数据收集完成，采用 market_data_v2', nodeId: 'n1' },
    { id: 'raw-secret', title: '密钥', content: 'password=hunter2', nodeId: 'n2' },
  ]);
  const memory = {
    taskId: 'task-report',
    ownerUserId: 'alice',
    participantUserIds: ['alice', 'bob'],
    foundation: { plan: { nodes: [{ id: 'n1', title: '收集' }], edges: [] }, exec: { nodes: [{ id: 'n1', title: '收集' }], edges: [] } },
    elevation: inspected.accepted,
    raw: [
      { id: 'raw-ok', title: '对话全文', content: '完整私聊', nodeId: 'n1' },
      { id: 'raw-secret', title: '密钥', content: 'password=hunter2', nodeId: 'n2' },
    ],
  };
  const participant = projectTaskPublicMemory(memory, { userId: 'bob', taskId: 'task-report' });
  const stranger = projectTaskPublicMemory(memory, { userId: 'carol', taskId: 'other-task' });
  const rejected = applyRawAccessPipeline({
    sourceTaskId: 'other-task', targetTaskId: 'task-report', requesterUserId: 'carol',
    purpose: '全部原文', nodeIds: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'], excerptOnly: false,
  }, memory, { ownerDecision: 'approve', actorUserId: 'alice' });
  const granted = applyRawAccessPipeline({
    sourceTaskId: 'other-task', targetTaskId: 'task-report', requesterUserId: 'carol',
    purpose: '核对数据里程碑', nodeIds: ['raw-ok'], excerptOnly: true,
  }, memory, { ownerDecision: 'approve', actorUserId: 'alice' });
  const gates = {
    inspect_drops_secrets: inspected.rejected.length === 1 && inspected.accepted.length === 1,
    participant_hides_raw: participant.raw.length === 0 && participant.layers.includes('foundation'),
    stranger_sees_nothing: stranger.foundation == null,
    wide_request_rejected_before_owner: rejected.ai.decision === 'reject' && !rejected.owner,
    approved_excerpt_only: granted.owner?.decision === 'approve' && granted.projection.raw.length === 1,
  };
  return { gates, pass: Object.values(gates).every(Boolean) };
}

function evaluateLoop() {
  const plan = templates()[0];
  const agent = injectMinimalDrift(plan, { type: 'wrong_agent', nodeId: 'research' });
  const dep = injectMinimalDrift(plan, { type: 'missing_dependency', nodeId: 'write' });
  const routes = {
    wrong_agent: routeEvolution(detectMinimalDrift(plan, agent.graph)),
    missing_dependency: routeEvolution(detectMinimalDrift(plan, dep.graph)),
    unknown: routeEvolution({ status: 'UNKNOWN' }),
  };
  const gates = {
    agent_goes_to_swap: routes.wrong_agent.action === 'similar_swap',
    structure_goes_to_plan_edit: routes.missing_dependency.action === 'minimal_plan_edit',
    unknown_does_not_update: routes.unknown.action === 'record_only',
  };
  return { routes, gates, pass: Object.values(gates).every(Boolean) };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value) {
  return Number(Number(value).toFixed(4));
}

function renderReport(result) {
  const mark = (pass) => (pass ? '通过' : '未通过');
  return `# V4 自进化可行性验证

> 运行时间：${result.generatedAt}  
> 总判定：**${mark(result.pass)}**  
> 本报告验证的是方案可执行、可打标、可用非训练基线分离，不是真实任务上的自进化已成立。

## 结论

${result.pass
    ? '三层公共 memory、反向侦探合成监督、能力画像两个分数，在当前契约和合成器上都能跑通，并且侦探基线明显优于末端归责。可以进入阶段 3/4 的数据规模化，不必先回到最小披露。'
    : '存在未通过闸门，先看下方分项，不要扩大训练。'}

## 1. 任务公共 memory

${gateTable(result.tpm.gates)}

## 2. 反向侦探（${result.rdmd.n} 条单注入）

| 指标 | 数值 |
|---|---:|
| 侦探 Top-1 | ${pct(result.rdmd.hit)} |
| 漂移类型准确率 | ${pct(result.rdmd.typeHit)} |
| 末端归责 Top-1 | ${pct(result.rdmd.terminalBlameHit)} |
| 字典序第一差异 Top-1 | ${pct(result.rdmd.firstDiffHit)} |
| 平均涉入节点数 | ${result.rdmd.meanInvolvedNodes} |
| 侦探平均证据节点数 | ${result.rdmd.meanDetectiveEvidence} |
| 无漂移识别率 | ${pct(result.rdmd.noDriftRate)} |
| 双注入 UNKNOWN | ${pct(result.rdmd.multiInjectUnknownRate)} |

${gateTable(result.rdmd.gates)}

分类型命中：${Object.entries(result.rdmd.byType).map(([type, row]) => `${type} ${pct(row.hit)} (n=${row.n})`).join('；')}。

## 3. 能力画像依赖集束

规划选人：${result.cpdb.collab.profile.agentId}（依赖分）。失败替换：${result.cpdb.swap.profile.agentId}（相似度）。二者 argmax 不同。

${gateTable(result.cpdb.gates)}

## 4. 闭环路由

${gateTable(result.loop.gates)}

## 边界

- 侦探基线是“变化子图的唯一源点”，证明标答可学，不是已训练模型。
- 画像分数来自标签角色表，不是人工标注模型。
- 未接 PostgreSQL / 真实 Work Memory；未改 TDB 投影训练。
`;
}

function gateTable(gates) {
  return `| 闸门 | 结果 |\n|---|---|\n${Object.entries(gates).map(([name, pass]) => `| ${name} | ${pass ? 'PASS' : 'FAIL'} |`).join('\n')}`;
}

function pct(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

const result = {
  generatedAt: new Date().toISOString(),
  tpm: evaluateTpm(),
  rdmd: evaluateRdmd(),
  cpdb: evaluateCpdb(),
  loop: evaluateLoop(),
};
result.pass = result.tpm.pass && result.rdmd.pass && result.cpdb.pass && result.loop.pass;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'metrics.json'), `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(join(OUT, 'FEASIBILITY_REPORT.zh-CN.md'), renderReport(result));
writeFileSync(join(ROOT, '../../docs/ubuddy-v4-feasibility-report.zh-CN.md'), renderReport(result));

console.log(JSON.stringify({
  pass: result.pass,
  tpm: result.tpm.pass,
  rdmd: { pass: result.rdmd.pass, hit: result.rdmd.hit, terminal: result.rdmd.terminalBlameHit, n: result.rdmd.n },
  cpdb: result.cpdb.pass,
  loop: result.loop.pass,
  out: OUT,
}, null, 2));
if (!result.pass) process.exitCode = 1;
