import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCases, runCase, VERSION, hash } from './engine.mjs';
import { analyze } from './analysis.mjs';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CODE = ['engine.mjs', 'evaluator.mjs', 'analysis.mjs', 'artifacts.mjs', 'runner.mjs',
  '../../src/shared/contracts/uBuddyTaskDependencyBundle.js'];
const FILES = ['cases.json', 'episodes.jsonl', 'model.json', 'predictions.json', 'metrics.json', 'report.md'];
const json = (v) => JSON.stringify(v, null, 2) + '\n';

export function renderReport(metrics) {
  const table = Object.entries(metrics.byPolicy).map(([name, m]) => `| ${name} | ${(m.successRate * 100).toFixed(1)}% | ${m.meanGain.toFixed(3)} | ${m.meanRepairCost.toFixed(3)} | ${m.meanDiagnosticExecutions} |`).join('\n');
  return `# TDB Probe 执行报告\n\n证据等级：SYNTHETIC_EXECUTION_ONLY。真实任务验证：否。自动进化：禁止。\n\n训练 ${metrics.counts.train}、校准 ${metrics.counts.calibration}、测试 ${metrics.counts.test} 个配对样例；${metrics.counts.totalExecutions} 次执行；测试独立任务族 ${metrics.counts.independentTestFamilies} 个。所有任务族来自同一个手写发票生成器。\n\n| 策略 | 成功率 | 相对 noop 收益 | 修复代价（人为单位） | 额外诊断执行/任务 |\n|---|---:|---:|---:|---:|\n${table}\n\n动作成功概率 Brier：${metrics.actionSuccessBrier.toFixed(6)}。双故障交互效应：${metrics.interaction}。\n\n固定启发式是本基准示例，不是 Janus 线上算法。learned 是训练组经验频率表，不是大模型。probeSearch 使用六臂穷举，其结果与事后 oracle 共用已执行的结果；不能声称它在相同预算下优于其他策略。训练/校准收集成本另为 ${(metrics.counts.train + metrics.counts.calibration) * 6} 次执行。\n\n根因准确率不报告：修复有效不能识别唯一根因。家族 bootstrap 区间只作合成描述；零宽区间来自相同响应，不表示现实确定性。不能据此启用生产自进化，也不能证明真实公共语义投影充分。\n`;
}

async function codeHashes() {
  const values = {};
  for (const file of CODE) values[file] = hash(await fs.readFile(path.resolve(ROOT, file), 'utf8'));
  return values;
}

export async function writeRun({ out, seed = 20260906, families = 12, repeats = 3 } = {}) {
  const config = { seed, families, repeats }, cases = makeCases(config);
  const rows = cases.map(runCase), result = analyze(rows);
  let directory;
  if (out) { directory = path.resolve(out); await fs.mkdir(directory, { recursive: false }); }
  else {
    await fs.mkdir(path.join(ROOT, 'runs'), { recursive: true });
    directory = await fs.mkdtemp(path.join(ROOT, 'runs', 'run-'));
  }
  const payloads = {
    'cases.json': json(cases), 'episodes.jsonl': rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'model.json': json(result.scorer), 'predictions.json': json(result.policyRows),
    'metrics.json': json(result.metrics), 'report.md': renderReport(result.metrics),
  };
  for (const [file, data] of Object.entries(payloads)) await fs.writeFile(path.join(directory, file), data, { flag: 'wx' });
  const manifest = { benchmark: VERSION, config, createdAt: new Date().toISOString(), nodeVersion: process.version,
    synthetic: true, autoEvolutionAllowed: false, inputHash: hash(cases), code: await codeHashes(),
    files: Object.fromEntries(Object.entries(payloads).map(([file, data]) => [file, hash(data)])),
    hashScope: 'Local reproducibility and tamper detection, not an independently signed evidence certificate.' };
  await fs.writeFile(path.join(directory, 'manifest.json'), json(manifest), { flag: 'wx' });
  return { directory, metrics: result.metrics };
}

export async function verifyRun(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.benchmark !== VERSION || !manifest.synthetic || manifest.autoEvolutionAllowed !== false) throw new Error('manifest_scope_invalid');
  if (hash(manifest.code) !== hash(await codeHashes())) throw new Error('code_version_changed');
  if (hash(Object.keys(manifest.files).sort()) !== hash([...FILES].sort())) throw new Error('artifact_set_mismatch');
  const payloads = {};
  for (const file of FILES) {
    payloads[file] = await fs.readFile(path.join(directory, file), 'utf8');
    if (hash(payloads[file]) !== manifest.files[file]) throw new Error(`artifact_hash_mismatch:${file}`);
  }
  const cases = makeCases(manifest.config);
  if (hash(cases) !== manifest.inputHash || hash(JSON.parse(payloads['cases.json'])) !== hash(cases)) throw new Error('input_replay_mismatch');
  const rows = cases.map(runCase), result = analyze(rows);
  const recorded = payloads['episodes.jsonl'].trim().split('\n').map((s) => JSON.parse(s));
  if (hash(rows) !== hash(recorded)) throw new Error('execution_replay_mismatch');
  for (const [file, value] of [['model.json', result.scorer], ['predictions.json', result.policyRows], ['metrics.json', result.metrics]]) {
    if (hash(JSON.parse(payloads[file])) !== hash(value)) throw new Error(`analysis_replay_mismatch:${file}`);
  }
  if (payloads['report.md'] !== renderReport(result.metrics)) throw new Error('report_replay_mismatch');
  return { verified: true, cases: cases.length, executions: result.metrics.counts.totalExecutions, syntheticOnly: true };
}
