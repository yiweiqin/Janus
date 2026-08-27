#!/usr/bin/env node
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_VERSION, METHODS, EVENT_KINDS, makeEvent, nowIso } from './schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WWW_ROOT = path.join(ROOT, 'experiments', 'ubuddy_appworld');
const DEFAULT_MANIFEST = path.join(WWW_ROOT, 'appworld_tasks.manifest.json');
const DEFAULT_RUN_ROOT = path.join(ROOT, 'experiments', 'runs');
const APPWORLD_ROOT = process.env.APPWORLD_ROOT || 'D:/Cli-anything/benchmarks/appworld-runtime';
const APPWORLD_PYTHON = process.env.APPWORLD_PYTHON || 'D:/Cli-anything/benchmarks/appworld-official/.venv313/Scripts/python.exe';
const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'help';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) { out._.push(item); continue; }
    const [key, inline] = item.slice(2).split('=', 2);
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  }
  return out;
}

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function writeJson(file, value) { await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
function help() { console.log('uBuddy-AppWorld-Hybrid\n\nCommands: doctor, prepare, manifest, canary, main, attribution, evolution, external, verify, report, package'); }

async function prepare() {
  const generator = path.join(ROOT, 'scripts', 'generate_ubuddy_appworld_manifest.py');
  const child = spawn(APPWORLD_PYTHON, [generator, '--root', APPWORLD_ROOT, '--output', DEFAULT_MANIFEST], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let output = '';
  for await (const chunk of child.stdout) output += chunk.toString();
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) throw new Error(`manifest_generation_failed:${output}`);
  console.log(output.trim());
}

async function doctor() {
  const checks = [];
  checks.push({ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 20, detail: process.versions.node });
  checks.push({ name: 'appworld_python', ok: await exists(APPWORLD_PYTHON), detail: APPWORLD_PYTHON });
  checks.push({ name: 'appworld_runtime', ok: await exists(path.join(APPWORLD_ROOT, 'data', 'datasets', 'test_normal.txt')), detail: APPWORLD_ROOT });
  checks.push({ name: 'manifest', ok: await exists(DEFAULT_MANIFEST), detail: DEFAULT_MANIFEST });
  const modelConfigured = Boolean(process.env.CRS_OAI_KEY && process.env.OPENAI_BASE_URL);
  let modelReachable = false;
  if (modelConfigured) {
    try { const response = await fetch(`${String(process.env.OPENAI_BASE_URL).replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${process.env.CRS_OAI_KEY}` }, signal: AbortSignal.timeout(10000) }); modelReachable = response.ok || response.status === 404 || response.status === 405; } catch {}
  }
  checks.push({ name: 'model_endpoint_configured', ok: modelConfigured, detail: 'CRS_OAI_KEY + OPENAI_BASE_URL' });
  checks.push({ name: 'model_endpoint_reachable', ok: modelReachable, detail: modelReachable ? 'reachable' : 'connection failed or timed out' });
  console.log(JSON.stringify({ benchmark: BENCHMARK_VERSION, approvalRequired: false, checks, ready: checks.every((x) => x.ok) }, null, 2));
  process.exitCode = checks.every((x) => x.ok) ? 0 : 1;
}

async function manifest() {
  const data = await readJson(DEFAULT_MANIFEST);
  console.log(JSON.stringify({ benchmark: data.benchmark, taskCount: data.taskCount, manifestSha256: data.manifestSha256, tasks: data.tasks.map((x) => ({ taskId: x.taskId, taskFamily: x.taskFamily, numApps: x.numApps, numApiCalls: x.numApiCalls })) }, null, 2));
}

function profiles() { return [
  { ubuddyId: 'research-a', revision: 1, tags: ['retrieval', 'cross-app-reading'], visibility: 'friends', confidence: 0.82 },
  { ubuddyId: 'execution-b', revision: 1, tags: ['transaction', 'state-mutation'], visibility: 'friends', confidence: 0.79 },
  { ubuddyId: 'review-c', revision: 1, tags: ['verification', 'consistency-check'], visibility: 'organization', confidence: 0.76 },
]; }

function buildEpisode(task, method, seed, officialEvaluation = null) {
  const episodeId = `${task.taskId}:${method}:${seed}`;
  const events = [];
  const add = (eventKind, sourceKind, sourceId, actor = 'requester', metadata = {}) => events.push(makeEvent({ eventKind, episodeId, actorUserId: actor, sourceKind, sourceId, metadata }));
  add('task_created', 'appworld_task', task.taskId);
  add('profile_query', 'ubuddy_profile_catalog', `${episodeId}:profiles`);
  if (method !== 'M0_single_agent') add('selection_confirmed', 'capability_selection_snapshot', `${episodeId}:snapshot`, 'requester', { profileRevisions: profiles().map((p) => p.revision) });
  add('subtask_created', 'collaboration_task', `${episodeId}:subtask-a`);
  add('dependency_created', 'collaboration_dependency', `${episodeId}:dep-a-b`);
  add('execution_started', 'appworld_execution', `${episodeId}:execution`, method === 'M0_single_agent' ? 'requester' : 'recipient-a');
  add('state_published', 'collaboration_state', `${episodeId}:state`);
  add('result_submitted', 'task_result', `${episodeId}:result`);
  add('official_evaluated', 'appworld_evaluator', `${episodeId}:evaluation`, 'requester', { success: officialEvaluation?.success ?? false });
  add('attribution_generated', 'ubuddy_attribution', `${episodeId}:attribution`);
  return { episodeId, taskId: task.taskId, method, seed, task, profiles: profiles(), events, officialEvaluation, protocolOnly: !officialEvaluation, createdAt: nowIso() };
}

function spawnBridge() {
  const child = spawn(APPWORLD_PYTHON, [path.join(WWW_ROOT, 'appworld_bridge.py')], { env: { ...process.env, APPWORLD_ROOT }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  let buffer = '';
  const pending = [];
  child.stdout.on('data', (chunk) => { buffer += chunk.toString(); let idx; while ((idx = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1); if (line.trim()) pending.shift()?.(JSON.parse(line)); } });
  const call = (payload) => new Promise((resolve, reject) => { pending.push((response) => response.ok ? resolve(response.result) : reject(new Error(response.error))); child.stdin.write(JSON.stringify(payload) + '\n'); });
  return { call, close: () => child.kill() };
}

class ModelClient {
  constructor() {
    this.baseUrl = String(process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
    this.apiKey = process.env.CRS_OAI_KEY || '';
    this.model = process.env.UBUDDY_APPWORLD_MODEL || 'gpt-5.4-mini';
  }
  async json(system, user, maxTokens = 1200) {
    if (!this.baseUrl || !this.apiKey) throw new Error('model_endpoint_not_configured');
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, temperature: 0, max_tokens: maxTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(Number(process.env.UBUDDY_APPWORLD_MODEL_TIMEOUT_MS || 120000)),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`model_request_failed:${response.status}`);
    const content = String(payload.choices?.[0]?.message?.content || '{}');
    return { value: JSON.parse(content), usage: payload.usage || null, responseHash: hash(content) };
  }
}

async function makePlan(client, task, method) {
  if (method === 'M0_single_agent') return [{ id: 'whole-task', role: 'requester', description: task.instruction, dependsOn: [] }];
  const visibleProfiles = method === 'M1_static_profile' ? profiles().map(({ revision, ...rest }) => rest) : profiles();
  const result = await client.json(
    'You are the requester of a multi-uBuddy AppWorld task. Decompose the task into 2-4 executable subtasks. Return JSON only: {"subtasks":[{"id":"...","role":"research-a|execution-b|review-c","description":"...","dependsOn":[]}]} . The final reviewer subtask must verify completion and call supervisor.complete_task through AppWorld code.',
    `Task: ${task.instruction}\nAvailable capability profiles: ${JSON.stringify(visibleProfiles)}\nMethod: ${method}`,
  );
  const subtasks = Array.isArray(result.value.subtasks) ? result.value.subtasks.slice(0, 4) : [];
  if (!subtasks.length) throw new Error('model_returned_no_subtasks');
  return subtasks.map((item, index) => ({ id: String(item.id || `subtask-${index + 1}`), role: String(item.role || 'execution-b'), description: String(item.description || ''), dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [] }));
}

function roleSystem(method, role) {
  const sharing = method === 'M1_static_profile' ? 'You only receive your assigned subtask; do not assume other agents shared progress.' : method === 'M2_generic_shared' ? 'You receive a plain summary of earlier agents.' : method === 'M3_ours' ? 'You receive a versioned, visibility-filtered collaboration state. Respect dependency and result-version status.' : 'You own the entire task.';
  return `You are ${role}, an AppWorld agent. ${sharing}\nReturn JSON only with status=execute|done|blocked, code, and summary. When status=execute, code must be valid Python passed to AppWorld.execute and may call apis.*. Explore API documentation through apis.api_docs when needed. Do not access files outside the simulated AppWorld. The final responsible role must call apis.supervisor.complete_task(), with answer=... for answer-seeking tasks. Never claim done without executing the required state changes.`;
}

async function executeSubtask({ client, bridge, task, method, subtask, sharedState, modelUsage, maxSteps }) {
  const history = [];
  for (let step = 0; step < maxSteps; step += 1) {
    const shared = method === 'M1_static_profile' ? [] : sharedState.map((x) => ({ subtaskId: x.subtaskId, role: x.role, version: method === 'M3_ours' ? x.version : undefined, status: x.status, summary: x.summary }));
    const response = await client.json(roleSystem(method, subtask.role), `Official task: ${task.instruction}\nYour subtask: ${subtask.description}\nDependencies: ${JSON.stringify(subtask.dependsOn)}\nShared state: ${JSON.stringify(shared)}\nYour previous actions: ${JSON.stringify(history.slice(-4))}`, 1400);
    modelUsage.push({ role: subtask.role, subtaskId: subtask.id, step, usage: response.usage, responseHash: response.responseHash });
    const action = response.value || {};
    if (action.status === 'done' || action.status === 'blocked') return { status: action.status, summary: String(action.summary || action.status), steps: history.length };
    if (action.status !== 'execute' || !String(action.code || '').trim()) { history.push({ error: 'invalid_action' }); continue; }
    const result = await bridge.call({ command: 'execute', role: subtask.role, code: String(action.code) });
    history.push({ codeHash: hash(action.code), output: String(result.output || '').slice(0, 6000) });
  }
  return { status: 'blocked', summary: 'max_steps_exceeded', steps: history.length };
}

async function runMethodTask(task, method, seed, runDir) {
  const bridge = spawnBridge(); const client = new ModelClient(); const modelUsage = []; const sharedState = [];
  try {
    const reset = await bridge.call({ command: 'reset', taskId: task.taskId, experimentName: `ubuddy-${method}-${seed}-${Date.now()}` });
    const plan = await makePlan(client, task, method);
    for (const subtask of plan) {
      const unmet = subtask.dependsOn.filter((id) => !sharedState.some((x) => x.subtaskId === id && x.status === 'done'));
      if (unmet.length && method === 'M3_ours') { sharedState.push({ subtaskId: subtask.id, role: subtask.role, version: 1, status: 'blocked', summary: `unmet_dependencies:${unmet.join(',')}` }); continue; }
      const result = await executeSubtask({ client, bridge, task: { ...task, instruction: reset.instruction }, method, subtask, sharedState, modelUsage, maxSteps: Number(process.env.UBUDDY_APPWORLD_MAX_STEPS_PER_SUBTASK || 8) });
      sharedState.push({ subtaskId: subtask.id, role: subtask.role, version: 1, ...result });
    }
    const evaluation = await bridge.call({ command: 'evaluate' });
    await writeJson(path.join(runDir, `real-${task.taskId}-${method}-${seed}.json`), { taskId: task.taskId, method, seed, plan, sharedState, modelUsage, evaluation });
    return { evaluation, plan, sharedState, modelUsage };
  } finally { await bridge.call({ command: 'close' }).catch(() => {}); bridge.close(); }
}

async function runRealTask(task, runDir) {
  const bridge = spawnBridge();
  const trace = [];
  try {
    const reset = await bridge.call({ command: 'reset', taskId: task.taskId, experimentName: `ubuddy-appworld-${Date.now()}` });
    trace.push({ event: 'reset', result: { taskId: reset.taskId, instruction: reset.instruction } });
    // The bridge intentionally does not invent an answer. A cloud run can supply a
    // model-generated AppWorld Python program through --action-file.
    const actionFile = args.actionFile ? path.resolve(String(args.actionFile)) : null;
    if (actionFile && await exists(actionFile)) {
      const actions = JSON.parse(await fs.readFile(actionFile, 'utf8'));
      for (const action of actions) trace.push({ event: 'execute', result: await bridge.call({ command: 'execute', role: action.role || 'requester', code: action.code }) });
    }
    const evaluation = await bridge.call({ command: 'evaluate' });
    trace.push({ event: 'evaluate', result: evaluation });
    await writeJson(path.join(runDir, `real-${task.taskId}.json`), { taskId: task.taskId, trace, evaluation });
    return evaluation;
  } finally { await bridge.call({ command: 'close' }).catch(() => {}); bridge.close(); }
}

async function canary() {
  const data = await readJson(DEFAULT_MANIFEST); const task = data.tasks[0];
  const runDir = path.resolve(String(args.runDir || path.join(DEFAULT_RUN_ROOT, `appworld-canary-${Date.now()}`))); await fs.mkdir(runDir, { recursive: true });
  const rows = [];
  let officialEvaluation = null;
  let real = null;
  if (args.real && String(process.env.UBUDDY_APPWORLD_ENABLE_REAL) === '1') {
    real = args.model ? await runMethodTask(task, 'M3_ours', 20260826, runDir) : { evaluation: await runRealTask(task, runDir) };
    officialEvaluation = real.evaluation;
  }
  for (const method of METHODS) rows.push(buildEpisode(task, method, 20260826, method === 'M3_ours' ? officialEvaluation : null));
  const protocolOnly = !officialEvaluation;
  await writeJson(path.join(runDir, 'episodes.json'), rows); await writeJson(path.join(runDir, 'config.json'), { benchmark: BENCHMARK_VERSION, mode: protocolOnly ? 'protocol' : 'real', taskCount: 1, methods: METHODS, seed: 20260826 });
  console.log(JSON.stringify({ runDir, protocolOnly, episodes: rows.length, officialEvaluation, plan: real?.plan || null, sharedState: real?.sharedState || null, next: protocolOnly ? 'set UBUDDY_APPWORLD_ENABLE_REAL=1 and rerun with --real' : 'run main after reviewing real canary' }, null, 2));
}

async function main() {
  const data = await readJson(DEFAULT_MANIFEST); const seeds = [20260821, 20260822, 20260823];
  const runDir = path.resolve(String(args.runDir || path.join(DEFAULT_RUN_ROOT, `appworld-main-${Date.now()}`))); await fs.mkdir(runDir, { recursive: true });
  const rows = [];
  for (const task of data.tasks) for (const seed of seeds) for (const method of METHODS) {
    let evaluation = null;
    let real = null;
    if (args.real && String(process.env.UBUDDY_APPWORLD_ENABLE_REAL) === '1') real = await runMethodTask(task, method, seed, runDir);
    evaluation = real?.evaluation || null;
    rows.push({ ...buildEpisode(task, method, seed, evaluation), plan: real?.plan || null, sharedState: real?.sharedState || null, modelUsage: real?.modelUsage || null });
  }
  await writeJson(path.join(runDir, 'config.json'), { benchmark: BENCHMARK_VERSION, mode: args.real ? 'real' : 'protocol', taskCount: data.tasks.length, episodeCount: rows.length, methods: METHODS, seeds });
  await fs.writeFile(path.join(runDir, 'episodes.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  await writeJson(path.join(runDir, 'metrics.json'), { episodeCount: rows.length, protocolOnly: rows.every((x) => x.protocolOnly), byMethod: Object.fromEntries(METHODS.map((m) => [m, { n: rows.filter((x) => x.method === m).length, officialSuccessRate: rows.filter((x) => x.method === m && x.officialEvaluation?.success).length / rows.filter((x) => x.method === m).length }])) });
  console.log(JSON.stringify({ runDir, episodeCount: rows.length, protocolOnly: rows.every((x) => x.protocolOnly) }, null, 2));
}

async function verify() { const runDir = path.resolve(String(args.runDir || args._[1] || '')); if (!runDir) throw new Error('--run-dir is required'); const rows = (await fs.readFile(path.join(runDir, 'episodes.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); const valid = rows.length > 0 && rows.every((row) => row.episodeId && row.events.every((event) => EVENT_KINDS.includes(event.eventKind))); await writeJson(path.join(runDir, 'verification.json'), { valid, episodeCount: rows.length, allEventKindsKnown: valid }); console.log(JSON.stringify({ valid, episodeCount: rows.length }, null, 2)); process.exitCode = valid ? 0 : 1; }
async function protocolArtifact(kind) {
  const runDir = path.resolve(String(args.runDir || path.join(DEFAULT_RUN_ROOT, `appworld-${kind}-${Date.now()}`))); await fs.mkdir(runDir, { recursive: true });
  const plan = await readJson(path.join(WWW_ROOT, 'experiment_plan.json'));
  const payload = { benchmark: BENCHMARK_VERSION, kind, status: 'ready_for_real_artifacts', generatedAt: nowIso(), plan: kind === 'attribution' ? plan.attribution : kind === 'evolution' ? plan.evolution : plan.external, warning: 'This file is a protocol plan, not an experimental result.' };
  await writeJson(path.join(runDir, `${kind}-plan.json`), payload); console.log(JSON.stringify({ runDir, artifact: path.join(runDir, `${kind}-plan.json`), resultEligible: false }, null, 2));
}
async function report() { const runDir = path.resolve(String(args.runDir || args._[1] || '')); const metrics = await readJson(path.join(runDir, 'metrics.json')); await fs.writeFile(path.join(runDir, 'report.md'), `# uBuddy-AppWorld-Hybrid Report\n\n- benchmark: ${BENCHMARK_VERSION}\n- episodes: ${metrics.episodeCount}\n- protocolOnly: ${metrics.protocolOnly}\n\nOfficial AppWorld scores are reported only when a real bridge run produced an evaluator artifact.\n`, 'utf8'); console.log(JSON.stringify({ report: path.join(runDir, 'report.md') }, null, 2)); }
async function packageRun() { const target = path.resolve(String(args.output || path.join(ROOT, 'outputs', 'ubuddy-appworld-hybrid-package-v1'))); await fs.mkdir(target, { recursive: true }); const filter = (source) => !source.includes('__pycache__') && !source.endsWith('.pyc'); for (const rel of ['experiments/ubuddy_appworld', 'scripts/generate_ubuddy_appworld_manifest.py', 'scripts/appworld_ubuddy_experiment.mjs', 'package.json']) { const src = path.join(ROOT, rel); const dst = path.join(target, rel); await fs.mkdir(path.dirname(dst), { recursive: true }); if ((await fs.stat(src)).isDirectory()) await fs.cp(src, dst, { recursive: true, filter }); else await fs.copyFile(src, dst); } await fs.writeFile(path.join(target, 'PACKAGE_README.md'), '# uBuddy-AppWorld-Hybrid package\n\nSecrets, databases and experiment runs are intentionally excluded. Clone the official public benchmarks with experiments/ubuddy_appworld/cloud_setup.sh.\n', 'utf8'); console.log(JSON.stringify({ packageDir: target }, null, 2)); }

if (command === 'doctor') await doctor(); else if (command === 'prepare') await prepare(); else if (command === 'manifest') await manifest(); else if (command === 'canary') await canary(); else if (command === 'main') await main(); else if (command === 'verify') await verify(); else if (command === 'report') await report(); else if (command === 'package') await packageRun(); else if (['attribution', 'evolution', 'external'].includes(command)) await protocolArtifact(command); else help();
