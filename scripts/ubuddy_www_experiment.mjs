#!/usr/bin/env node

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { ARTIFACT_FILES, BENCHMARK_VERSION, EVENTS, METHODS, assertEpisodeConfig, assertEvent, makeOfficialEvaluation, nowIso, publicBrowserEvent, redactPrivateMetadata, sha256 } from '../experiments/ubuddy_www/schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW_ROOT = path.join(ROOT, 'experiments', 'ubuddy_www');
const DEFAULT_RUN_ROOT = path.join(ROOT, 'experiments', 'runs');
const DEFAULT_MANIFEST = path.join(WWW_ROOT, 'webarena_verified_tasks.manifest.json');
const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'help';
if (args.real) {
  process.env.UBUDDY_WWW_BRIDGE_MODE = 'real';
  process.env.UBUDDY_WWW_BENCHMARK = 'webarena_verified';
  process.env.UBUDDY_WWW_ENABLE_MODEL = process.env.UBUDDY_WWW_ENABLE_MODEL || '1';
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) { out._.push(item); continue; }
    const [rawKey, inline] = item.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  }
  return out;
}

function help(code) {
  console.log(`uBuddy-WWW experiment runner\n\nCommands:\n  doctor           Check the default public WebArena-Verified backend\n  webarena-doctor  Check WebArena-Verified data, evaluator and local websites\n  canary           Run one protocol canary per method (mock unless real bridge is configured)\n  main             Run the fixed 12-task x 3-seed x 4-method design\n  evolution        Run the 6-pair transfer design\n  external         Legacy external-design command\n  verify           Independently verify artifacts and metrics\n  report           Render a report from a run directory\n\nOptions:\n  --run-dir <path>\n  --manifest <path>\n  --allow-mock   Permit protocol-only runs without local WebArena websites\n  --real         Use real sites, model browser actions and official evaluator`);
  process.exitCode = code;
}

async function doctor() {
  const checks = [];
  checks.push(check('node', Boolean(process.versions.node), process.versions.node));
  const python = resolvePython();
  checks.push(check('python', await commandExists(python), python));
  checks.push(check('browsergym_source', await exists(path.join(process.env.BROWSER_GYM_ROOT || '', 'pyproject.toml')) || await exists(path.join('D:\\Cli-anything', 'benchmarks', 'browsergym', 'pyproject.toml')), 'BROWSER_GYM_ROOT or downloaded source'));
  checks.push(check('workarena_source', await exists(path.join(process.env.WORKARENA_ROOT || '', 'pyproject.toml')) || await exists(path.join('D:\\Cli-anything', 'benchmarks', 'workarena', 'pyproject.toml')), 'WORKARENA_ROOT or downloaded source'));
  checks.push(check('playwright_python', await pythonImport('playwright', python), 'python import')); 
  checks.push(check('chromium_executable', Boolean(resolveChromiumExecutable()), resolveChromiumExecutable() || 'Playwright-managed Chromium')); 
  checks.push(check('postgres_url', Boolean(process.env.DATABASE_URL || process.env.EVOLUTION_WORKER_DATABASE_URL), 'DATABASE_URL or EVOLUTION_WORKER_DATABASE_URL'));
  const cloudBase = process.env.UBUDDY_WWW_JANUS_BASE_URL || process.env.JANUS_AUTH_URL || process.env.JANUS_API_BASE_URL || 'http://127.0.0.1:8787';
  checks.push(check('cloud_api', await httpHealth(cloudBase), cloudBase));
  checks.push(check('model_endpoint_config', Boolean(process.env.CRS_OAI_KEY && process.env.OPENAI_BASE_URL), 'CRS_OAI_KEY + OPENAI_BASE_URL')); 
  const explicitSnow = Boolean(process.env.SNOW_INSTANCE_URL && process.env.SNOW_INSTANCE_UNAME && process.env.SNOW_INSTANCE_PWD);
  const instancePool = Boolean(process.env.SNOW_INSTANCE_POOL || process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || await huggingFaceTokenAvailable(python));
  checks.push(check('workarena_instance_access', explicitSnow || instancePool, 'approved Hugging Face token/session, SNOW_INSTANCE_POOL, or SNOW_INSTANCE_*'));
  const realReady = checks.filter((item) => ['node', 'python', 'browsergym_source', 'workarena_source', 'playwright_python', 'chromium_executable', 'postgres_url', 'cloud_api', 'workarena_instance_access', 'model_endpoint_config'].includes(item.name)).every((item) => item.ok);
  console.log(JSON.stringify({ benchmark: BENCHMARK_VERSION, checks, protocolCanaryAllowed: true, realEnvironmentReady: realReady, mockReason: realReady ? '' : 'official ServiceNow credentials or runtime prerequisites are not complete' }, null, 2));
  process.exitCode = realReady ? 0 : 1;
}

async function webarenaDoctor() {
  const python = resolveWebarenaPython();
  const sourceRoot = resolveWebarenaRoot();
  const dataset = resolveWebarenaDataset();
  const checks = [
    check('node', Boolean(process.versions.node), process.versions.node),
    check('python_3_11_plus', await pythonVersionAtLeast(python, 3, 11), python),
    check('webarena_verified_source', await exists(path.join(sourceRoot, 'pyproject.toml')), sourceRoot),
    check('webarena_verified_dataset', await exists(dataset), dataset),
    check('webarena_verified_manifest', await exists(DEFAULT_MANIFEST), DEFAULT_MANIFEST),
    check('webarena_verified_import', await pythonImportFromSource('webarena_verified', python, sourceRoot), 'official evaluator import'),
    check('docker', await commandExists(resolveDocker()), resolveDocker()),
    check('playwright_python', await pythonImport('playwright', python), 'python import'),
  ];
  const sites = webarenaSiteUrls();
  for (const [site, url] of Object.entries(sites)) checks.push(check(`site_${site}`, await httpReachable(url), url));
  const evaluatorReady = checks.filter((item) => ['python_3_11_plus', 'webarena_verified_source', 'webarena_verified_dataset', 'webarena_verified_manifest', 'webarena_verified_import'].includes(item.name)).every((item) => item.ok);
  const sitesReady = checks.filter((item) => item.name.startsWith('site_')).every((item) => item.ok);
  console.log(JSON.stringify({ benchmark: BENCHMARK_VERSION, approvalRequired: false, checks, evaluatorReady, websitesReady: sitesReady, realEnvironmentReady: evaluatorReady && sitesReady, note: 'Evaluator/data can run without approval; browser episodes require local website containers.' }, null, 2));
  process.exitCode = evaluatorReady && sitesReady ? 0 : 1;
}

async function canary() {
  const runDir = await prepareRun('canary');
  const rows = [];
  const real = (process.env.UBUDDY_WWW_BRIDGE_MODE || 'mock') === 'real';
  const task = real ? (await loadManifest()).tasks?.[0] : canaryTask();
  if (!task) throw new Error('canary requires at least one selected WebArena-Verified task');
  for (const method of METHODS) rows.push(await runEpisode({ runDir, method, task, seed: 20260821, condition: 'natural', canary: true }));
  await finalizeRun(runDir, rows, { kind: 'canary', officialScoreEligible: rows.every((row) => row.officialEvaluation.evaluatorVersion !== 'mock:not-a-score') });
  console.log(JSON.stringify({ runDir, episodes: rows.length, protocolOnly: rows.some((row) => row.protocolOnly) }, null, 2));
}

async function mainExperiment() {
  const manifest = await loadManifest();
  const tasks = manifest.tasks || [];
  if ((process.env.UBUDDY_WWW_BRIDGE_MODE || 'mock') !== 'real' && !args.allowMock) throw new Error('main requires UBUDDY_WWW_BRIDGE_MODE=real; pass --allow-mock only for protocol validation');
  if (tasks.length !== 12) throw new Error(`main requires exactly 12 fixed WebArena-Verified tasks; found ${tasks.length}`);
  if (process.env.UBUDDY_WWW_BRIDGE_MODE === 'real') await ensureRealWebarenaReady();
  const runDir = await prepareRun('main');
  const rows = [];
  for (const task of tasks) for (const seed of [20260821, 20260822, 20260823]) for (const method of METHODS) {
    const condition = task.condition || (Number(rows.length / METHODS.length / 3) < 6 ? 'controlled' : 'natural');
    rows.push(await runEpisode({ runDir, method, task, seed, condition }));
  }
  await finalizeRun(runDir, rows, { kind: 'main', officialScoreEligible: rows.every((row) => row.officialEvaluation.evaluatorVersion !== 'mock:not-a-score') });
  console.log(JSON.stringify({ runDir, episodes: rows.length, expected: 144, protocolOnly: rows.some((row) => row.protocolOnly) }, null, 2));
}

async function ensureRealWebarenaReady() {
  if (!(process.env.CRS_OAI_KEY && process.env.OPENAI_BASE_URL)) throw new Error('real WebArena run requires CRS_OAI_KEY and OPENAI_BASE_URL');
  for (const [site, url] of Object.entries(webarenaSiteUrls())) {
    if (!(await httpReachable(url))) throw new Error(`WebArena site ${site} is not reachable at ${url}; run experiment:ubuddy:www:sites:start and :init first`);
  }
}

async function evolutionExperiment() {
  if ((process.env.UBUDDY_WWW_BRIDGE_MODE || 'mock') !== 'real' && !args.allowMock) throw new Error('evolution requires UBUDDY_WWW_BRIDGE_MODE=real; pass --allow-mock only for protocol validation');
  const runDir = await prepareRun('evolution');
  const rows = [];
  for (let pair = 1; pair <= 6; pair += 1) for (const seed of [20260821, 20260822, 20260823]) for (const method of METHODS) {
    const task = { officialTaskId: `TRANSFER-${String(pair).padStart(2, '0')}`, category: 'transfer', taskClass: 'paired_workarena_task', condition: pair % 2 ? 'controlled' : 'natural' };
    rows.push(await runEpisode({ runDir, method, task, seed, condition: task.condition, phase: 'round2', pairId: pair }));
  }
  await finalizeRun(runDir, rows, { kind: 'evolution', officialScoreEligible: rows.every((row) => row.officialEvaluation.evaluatorVersion !== 'mock:not-a-score') });
  console.log(JSON.stringify({ runDir, episodes: rows.length, expected: 72, protocolOnly: rows.some((row) => row.protocolOnly) }, null, 2));
}

async function externalExperiment() {
  if ((process.env.UBUDDY_WWW_EXTERNAL_MODE || 'protocol') !== 'real' && !args.allowMock) throw new Error('external requires a real WebArena-Verified adapter; pass --allow-mock only for protocol validation');
  const runDir = await prepareRun('external');
  const rows = [];
  for (let task = 1; task <= 8; task += 1) for (const seed of [20260821, 20260822, 20260823]) for (const method of METHODS) {
    rows.push(await runEpisode({ runDir, method, task: { officialTaskId: `WEBARENA-VERIFIED-${task}`, category: 'external', taskClass: 'pending_verified_task' }, seed, condition: 'natural', phase: 'external' }));
  }
  await finalizeRun(runDir, rows, { kind: 'external', officialScoreEligible: rows.every((row) => row.officialEvaluation.evaluatorVersion !== 'mock:not-a-score') });
  console.log(JSON.stringify({ runDir, episodes: rows.length, expected: 96, protocolOnly: rows.some((row) => row.protocolOnly) }, null, 2));
}

async function verify() {
  const runDir = path.resolve(String(args.runDir || ''));
  if (!args.runDir) throw new Error('--run-dir is required');
  const rows = await readJsonl(path.join(runDir, 'episodes.jsonl'));
  const errors = [];
  for (const row of rows) {
    try { assertEpisodeConfig(row.config); for (const event of row.events) assertEvent(event); } catch (error) { errors.push({ episodeId: row.config?.episodeId, error: String(error.message || error) }); }
  }
  const metrics = computeMetrics(rows);
  const stored = await readJson(path.join(runDir, 'metrics.json')).catch(() => null);
  const result = { runDir, episodeCount: rows.length, artifactErrors: errors, metrics, metricsMatch: stored ? JSON.stringify(stored) === JSON.stringify(metrics) : false, allChecksPassed: errors.length === 0 && Boolean(stored) && JSON.stringify(stored) === JSON.stringify(metrics) };
  await fs.writeFile(path.join(runDir, 'verification.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.allChecksPassed ? 0 : 1;
}

async function report() {
  const runDir = path.resolve(String(args.runDir || ''));
  if (!args.runDir) throw new Error('--run-dir is required');
  const rows = await readJsonl(path.join(runDir, 'episodes.jsonl'));
  const metrics = computeMetrics(rows);
  const text = renderDetailedReport(runDir, rows, metrics);
  await fs.writeFile(path.join(runDir, 'report.md'), text, 'utf8');
  console.log(text);
}

async function runEpisode({ runDir, method, task, seed, condition, phase = 'round1', pairId = null, canary = false }) {
  const taskId = String(task.officialTaskId || task.taskId || 'unknown');
  const episodeId = `${taskId}:${phase}:${seed}:${method}`.replace(/[^a-zA-Z0-9:_-]/g, '_');
  const config = { benchmark: BENCHMARK_VERSION, episodeId, officialTaskId: taskId, taskClass: task.taskClass || '', category: task.category || '', seed, method, condition, phase, pairId, bridgeMode: process.env.UBUDDY_WWW_BRIDGE_MODE || 'mock', createdAt: nowIso() };
  assertEpisodeConfig(config);
  const profiles = buildProfiles();
  const candidateQueries = [{ episodeId, viewerUserId: 'requester', candidates: profiles.map(({ privateNotes, ...profile }) => profile), visibilityApplied: true, method }];
  const snapshots = method === 'M3_ours' ? [{ episodeId, delegationId: `${episodeId}:d1`, profileRevisionAtSelection: 1, profileHashAtSelection: sha256(profiles[0]), immutable: true }] : [];
  const subtasks = [{ subtaskId: 's1', goal: 'official task preparation', dependsOn: [] }, { subtaskId: 's2', goal: 'official task execution', dependsOn: ['s1'] }, { subtaskId: 's3', goal: 'official task verification', dependsOn: ['s2'] }];
  const faultManifest = condition === 'controlled' ? { condition, faults: [faultForTask(taskId, seed)] } : { condition, faults: [] };
  const bridge = new BridgeClient();
  const janus = new JanusExperimentClient();
  const model = new ModelClient();
  const janusArtifacts = [];
  let liveDelegationId = '';
  const browserArtifactDir = path.join(runDir, 'browser_traces', episodeId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  await fs.mkdir(browserArtifactDir, { recursive: true });
  await bridge.start();
  const bridgeReset = await bridge.call('reset', { episodeId, officialTaskId: taskId, seed, benchmark: BENCHMARK_VERSION, artifactDir: browserArtifactDir });
  const events = [];
  const emit = (eventKind, payload = {}) => { const event = { eventKind, episodeId, eventId: `${episodeId}:${events.length + 1}`, occurredAt: nowIso(), ...payload }; assertEvent(event); events.push(event); };
  emit('task_created', { actorUserId: 'requester', sourceKind: 'webarena_verified_task', sourceId: taskId });
  emit('profile_queried', { actorUserId: 'requester', sourceKind: 'ubuddy_profile', sourceId: 'profiles:v1' });
  if (janus.enabled && method !== 'M0_single_agent') {
    const live = await janus.prepareCollaboration({
      episodeId,
      method,
      userIds: profiles.map((profile) => profile.ubuddyId),
      requirement: { description: taskId, capabilityTags: profiles.flatMap((profile) => profile.capabilityTags) },
    });
    liveDelegationId = live.delegationId;
    janusArtifacts.push(live.artifact);
  }
  if (method !== 'M0_single_agent') emit('delegation_created', { actorUserId: 'requester', recipientUserId: 'recipient-a', sourceKind: 'agent_delegation', sourceId: `${episodeId}:d1` });
  if (method === 'M3_ours') {
    emit('profile_snapshot_frozen', { actorUserId: 'requester', sourceKind: 'selection_snapshot', sourceId: `${episodeId}:d1`, profileRevision: 1 });
  }
  if (model.enabled) {
    const decision = await model.plan({ method, taskId, condition, profiles, subtasks });
    janusArtifacts.push({ kind: 'model_plan', ...decision });
  }
  for (const actor of method === 'M0_single_agent' ? ['requester'] : ['requester', 'recipient-a']) {
    const sessionId = `${episodeId}:${actor}`;
    await bridge.call('create_session', { sessionId, actorUbuddyId: actor, role: actor === 'requester' ? 'requester' : 'recipient' });
    const maxSteps = Math.max(1, Number(process.env.UBUDDY_WWW_MAX_STEPS_PER_ACTOR || 30));
    const realAgent = config.bridgeMode === 'real' && model.enabled;
    for (let step = 0; step < (realAgent ? maxSteps : 1); step += 1) {
      const observation = await bridge.call('observe', { sessionId });
      const modelDecision = realAgent
        ? await model.decideAction({ method, taskId, goal: bridgeReset.officialTask?.goal || '', actor, subtask: actor === 'requester' ? subtasks[0] : subtasks[1], observation: observation.observation })
        : { action: { kind: 'wait', ms: 1, target: 'mock' }, responseHash: '', usage: null };
      if (modelDecision.usage) janusArtifacts.push({ kind: 'model_action', actor, step, usage: modelDecision.usage, responseHash: modelDecision.responseHash });
      const action = await bridge.call('act', { sessionId, action: modelDecision.action });
      emit('browser_action', publicBrowserEvent({ episodeId, eventId: `${episodeId}:${events.length + 1}`, actorUbuddyId: actor, subtaskId: actor === 'requester' ? 's1' : 's2', action: modelDecision.action.kind, stepIndex: action.action?.stepIndex || step + 1, url: action.action?.url || '', observedStateHash: action.observation?.stateHash || '' }));
      if (modelDecision.action.kind === 'done') break;
    }
    emit('state_checkpoint', { actorUbuddyId: actor, subtaskId: actor === 'requester' ? 's1' : 's2', visibility: method === 'M3_ours' ? 'filtered' : 'shared' });
  }
  if (condition === 'controlled') {
    const fault = faultManifest.faults[0];
    emit(fault.eventKind, { actorUserId: fault.layer === 'individual' ? 'recipient-a' : 'requester', sourceKind: fault.sourceKind, sourceId: fault.sourceId, metadata: redactPrivateMetadata(fault.metadata) });
    if (fault.eventKind === 'execution_failed') emit('retry_started', { actorUserId: 'recipient-a', sourceKind: 'delegation_event', sourceId: `${episodeId}:d1` });
  }
  emit('result_submitted', { actorUserId: 'requester', sourceKind: 'task_result', sourceId: `${episodeId}:r1`, coveredRevision: 1 });
  if (method === 'M3_ours') emit('result_adopted', { actorUserId: 'requester', sourceKind: 'task_result', sourceId: `${episodeId}:r1`, decision: 'adopted' });
  const agentResponse = (config.bridgeMode === 'real' && model.enabled)
    ? await model.finalizeResponse({ taskId, goal: bridgeReset.officialTask?.goal || '', observation: (await bridge.call('observe', { sessionId: `${episodeId}:requester` })).observation })
    : null;
  const evaluation = makeOfficialEvaluation(await bridge.call('evaluate', { episodeId, officialTaskId: taskId, agentResponse }).then((result) => result.evaluation || {}));
  emit('official_evaluation', { actorUserId: 'evaluator', sourceKind: 'official_evaluator', sourceId: evaluation.evaluatorVersion, metadata: { status: evaluation.officialSuccess ? 'passed' : 'not_run' } });
  await bridge.close();
  const attribution = buildAttribution(config, events, faultManifest);
  const evolution = buildEvolution(config, attribution);
  if (janus.enabled && liveDelegationId) {
    janusArtifacts.push(await janus.queryStateAndAttribution({ delegationId: liveDelegationId }));
  }
  const row = { config, officialTask: { officialTaskId: taskId, taskClass: task.taskClass || '', category: task.category || '' }, profiles, candidateQueries, selectionSnapshots: snapshots, subtasks, faultManifest, events, officialEvaluation: evaluation, attribution, evolutionUpdate: evolution, protocolOnly: evaluation.evaluatorVersion === 'mock:not-a-score', metrics: episodeMetrics(config, events, evaluation, attribution, evolution) };
  row.janusArtifacts = janusArtifacts;
  row.agentResponse = agentResponse;
  await appendEpisodeArtifacts(runDir, row);
  return row;
}

class BridgeClient {
  constructor() { this.child = null; this.pending = new Map(); this.nextId = 0; }
  async start() {
    const python = resolveWebarenaPython();
    const bridgeEnv = { ...process.env, UBUDDY_WWW_BENCHMARK: process.env.UBUDDY_WWW_BENCHMARK || 'webarena_verified', WEBARENA_VERIFIED_ROOT: resolveWebarenaRoot() };
    if (!bridgeEnv.UBUDDY_WWW_CHROMIUM_EXECUTABLE && resolveChromiumExecutable()) bridgeEnv.UBUDDY_WWW_CHROMIUM_EXECUTABLE = resolveChromiumExecutable();
    this.child = spawn(python, [path.join(WWW_ROOT, 'browsergym_bridge.py')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: bridgeEnv });
    this.child.stdout.setEncoding('utf8'); let buffer = '';
    this.child.stdout.on('data', (chunk) => { buffer += chunk; let idx; while ((idx = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1); if (!line.trim()) continue; const response = JSON.parse(line); const pending = this.pending.get(response.requestId); if (pending) { this.pending.delete(response.requestId); response.ok ? pending.resolve(response) : pending.reject(new Error(response.error?.message || 'bridge_error')); } } });
    this.child.stderr.on('data', () => {});
    await new Promise((resolve, reject) => { this.child.once('spawn', resolve); this.child.once('error', reject); });
  }
  call(command, payload = {}) { const requestId = `${Date.now()}:${++this.nextId}`; return new Promise((resolve, reject) => { this.pending.set(requestId, { resolve, reject }); this.child.stdin.write(`${JSON.stringify({ requestId, command, ...payload })}\n`); }); }
  async close() { if (!this.child) return; try { await this.call('close'); } catch {} this.child.kill(); this.child = null; }
}

class JanusExperimentClient {
  constructor() {
    this.baseUrl = String(process.env.UBUDDY_WWW_JANUS_BASE_URL || process.env.JANUS_AUTH_URL || process.env.JANUS_API_BASE_URL || '').replace(/\/$/, '');
    this.token = String(process.env.UBUDDY_WWW_JANUS_ACCESS_TOKEN || process.env.JANUS_ACCESS_TOKEN || '');
    this.candidateUserIds = String(process.env.UBUDDY_WWW_CANDIDATE_USER_IDS || '').split(',').map((item) => item.trim()).filter(Boolean);
    this.enabled = Boolean(this.baseUrl && this.token && this.candidateUserIds.length);
    this.headers = { authorization: this.token ? `Bearer ${this.token}` : '', accept: 'application/json', 'content-type': 'application/json' };
  }

  async request(route, { method = 'GET', body } = {}) {
    if (!this.enabled) return { kind: 'janus_api_skipped', route, reason: 'base_url_or_access_token_missing' };
    const response = await fetch(`${this.baseUrl}${route}`, { method, headers: this.headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Janus API ${method} ${route} failed (${response.status})`);
    return { route, method, status: response.status, payload };
  }

  queryCandidates(body) { return this.request('/api/collaboration/candidates/query', { method: 'POST', body: { ...body, socialCapability: 'ubuddy-capability-profile-v1' } }); }
  confirmSelection(body) { return this.request('/api/collaboration/selections/confirm', { method: 'POST', body: { ...body, socialCapability: 'ubuddy-capability-profile-v1' } }); }
  createDelegation(body) { return this.request('/api/delegations', { method: 'POST', body }); }
  async prepareCollaboration({ episodeId, method, requirement }) {
    const candidateQuery = await this.queryCandidates({ userIds: this.candidateUserIds, requirement });
    const selected = candidateQuery.payload?.candidates?.[0];
    if (!selected) throw new Error('Janus candidate query returned no visible uBuddy');
    const recipientUserId = selected.ownerUserId;
    let capabilitySelection = {};
    let selection = null;
    if (method === 'M3_ours') {
      selection = await this.confirmSelection({ recipientUserId, selection: { queryId: candidateQuery.payload.queryId, profileRevision: selected.profileRevision, contentHash: selected.contentHash, requirement, consideredCandidateUserIds: this.candidateUserIds, selectionReason: 'fixed uBuddy-WWW benchmark protocol' } });
      capabilitySelection = selection.payload?.delegationInput?.capabilitySelection || {};
    }
    const delegation = await this.createDelegation({ recipientId: recipientUserId, title: `uBuddy-WWW ${episodeId}`.slice(0, 160), instruction: requirement.description, clientRequestId: `ubuddy-www:${episodeId}`, capabilitySelection, metadata: { benchmark: BENCHMARK_VERSION, episodeId, method } });
    return { delegationId: delegation.payload?.delegation?.id || '', artifact: { kind: 'janus_collaboration_setup', candidateQuery, selection, delegation } };
  }
  async queryStateAndAttribution({ delegationId }) {
    const capability = 'agent-work-detail-projection-v1';
    return {
      kind: 'janus_projection_queries',
      stateGraph: await this.request(`/api/collaboration/state-graph?capability=${capability}&delegationId=${encodeURIComponent(delegationId)}`),
      attribution: await this.request(`/api/collaboration/attribution?capability=${capability}&delegationId=${encodeURIComponent(delegationId)}`),
    };
  }
}

class ModelClient {
  constructor() {
    this.apiKey = String(process.env.CRS_OAI_KEY || '');
    this.baseUrl = String(process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
    this.model = String(process.env.UBUDDY_WWW_MODEL || 'gpt-5.4-mini');
    // Model calls are opt-in so schema/canary tests never spend API budget.
    this.enabled = process.env.UBUDDY_WWW_ENABLE_MODEL === '1' && Boolean(this.apiKey && this.baseUrl);
  }

  async plan({ method, taskId, condition, profiles, subtasks }) {
    if (!this.enabled) return { modelEnabled: false, reason: 'CRS_OAI_KEY_or_OPENAI_BASE_URL_missing' };
    const prompt = [
      `Benchmark method: ${method}`,
      `Official task: ${taskId}`,
      `Condition: ${condition}`,
      `Candidate public profiles: ${JSON.stringify(profiles.map(({ privateNotes, ...profile }) => profile))}`,
      `Subtasks: ${JSON.stringify(subtasks)}`,
      'Return compact JSON with selectedUbuddyId, subtaskAssignments, dependencies, and rationale.',
    ].join('\n');
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, temperature: 0, max_tokens: 1000, messages: [{ role: 'system', content: 'You are a benchmark planner. Do not claim browser success.' }, { role: 'user', content: prompt }] }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`model request failed (${response.status})`);
    return { modelEnabled: true, model: this.model, usage: payload.usage || null, responseHash: sha256(payload.choices?.[0]?.message?.content || payload) };
  }

  async decideAction({ method, taskId, goal, actor, subtask, observation }) {
    const prompt = [
      `Method: ${method}`,
      `Official task ID: ${taskId}`,
      `Official goal: ${goal}`,
      `Role: ${actor}`,
      `Assigned subtask: ${JSON.stringify(subtask)}`,
      `Current page: ${JSON.stringify(observation)}`,
      'Choose exactly one safe next browser action. Use only a selector listed in interactiveElements.',
      'Return JSON: {"kind":"click|type|select|press|scroll|wait|done","target":"selector","value":"text or key","ms":500}.',
      'Use done only when your assigned subtask is complete or no further safe action is possible.',
    ].join('\n');
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, temperature: 0, max_tokens: 300, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'You control a browser through one JSON action. Never invent selectors.' }, { role: 'user', content: prompt }] }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`model action request failed (${response.status})`);
    const content = String(payload.choices?.[0]?.message?.content || '{}');
    let action;
    try { action = JSON.parse(content); } catch { action = { kind: 'wait', ms: 500 }; }
    const allowed = new Set(['click', 'type', 'select', 'press', 'scroll', 'wait', 'done']);
    if (!allowed.has(action.kind)) action = { kind: 'wait', ms: 500 };
    if (['click', 'type', 'select', 'press'].includes(action.kind)) {
      const selectors = new Set((observation.interactiveElements || []).map((item) => item.selector));
      if (!selectors.has(String(action.target || ''))) action = { kind: 'wait', ms: 500 };
    }
    return { action, usage: payload.usage || null, responseHash: sha256(content) };
  }

  async finalizeResponse({ taskId, goal, observation }) {
    const prompt = [
      `Official WebArena-Verified task ID: ${taskId}`,
      `Goal: ${goal}`,
      `Final requester observation: ${JSON.stringify(observation)}`,
      'Return only a JSON object with task_type (retrieve|navigate|mutate), status (SUCCESS or an explicit error status), retrieved_data (array or null), and error_details (string or null).',
      'Do not claim SUCCESS unless the browser work is actually complete.',
    ].join('\n');
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, temperature: 0, max_tokens: 500, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Produce the final WebArena-Verified agent response JSON.' }, { role: 'user', content: prompt }] }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`model final response request failed (${response.status})`);
    try { return JSON.parse(String(payload.choices?.[0]?.message?.content || '{}')); } catch { return { task_type: 'retrieve', status: 'FAILURE', retrieved_data: null, error_details: 'invalid_model_json' }; }
  }
}

async function prepareRun(kind) {
  const runDir = path.resolve(String(args.runDir || path.join(DEFAULT_RUN_ROOT, `www-${kind}-${timestamp()}`)));
  await fs.mkdir(runDir, { recursive: true });
  await writeJson(path.join(runDir, 'config.json'), { experiment: `ubuddy_www_${kind}_v1`, benchmark: BENCHMARK_VERSION, benchmarkSource: resolveWebarenaRoot(), benchmarkDataset: resolveWebarenaDataset(), kind, methods: METHODS, seeds: [20260821, 20260822, 20260823], createdAt: nowIso(), codeRevision: await gitRevision(), browsergymSource: process.env.BROWSER_GYM_ROOT || 'D:/Cli-anything/benchmarks/browsergym', bridgeMode: process.env.UBUDDY_WWW_BRIDGE_MODE || 'mock', model: process.env.UBUDDY_WWW_MODEL || 'gpt-5.4-mini', modelEnabled: process.env.UBUDDY_WWW_ENABLE_MODEL === '1', officialEvaluatorRequired: true });
  return runDir;
}

async function finalizeRun(runDir, rows, meta) {
  const metrics = computeMetrics(rows);
  await writeJson(path.join(runDir, 'official_task.json'), rows.map((row) => row.officialTask));
  await writeJson(path.join(runDir, 'profiles.json'), rows.map((row) => ({ episodeId: row.config.episodeId, profiles: row.profiles })));
  await writeJson(path.join(runDir, 'subtasks.json'), rows.map((row) => ({ episodeId: row.config.episodeId, subtasks: row.subtasks })));
  await writeJson(path.join(runDir, 'fault_manifest.json'), rows.map((row) => ({ episodeId: row.config.episodeId, ...row.faultManifest })));
  await writeJson(path.join(runDir, 'official_evaluation.json'), rows.map((row) => ({ episodeId: row.config.episodeId, ...row.officialEvaluation })));
  await writeJson(path.join(runDir, 'attribution.json'), rows.map((row) => row.attribution));
  await writeJson(path.join(runDir, 'evolution_update.json'), rows.map((row) => row.evolutionUpdate));
  await writeJson(path.join(runDir, 'metrics.json'), metrics);
  await writeJson(path.join(runDir, 'verification.json'), { generatedAt: nowIso(), episodeCount: rows.length, protocolOnly: rows.some((row) => row.protocolOnly), officialScoreEligible: meta.officialScoreEligible, allChecksPassed: rows.length > 0 && rows.every((row) => row.events.every((event) => EVENTS.includes(event.eventKind))) });
  await fs.writeFile(path.join(runDir, 'change-manifest.md'), '# uBuddy-WWW experiment adapter\n\nThis run uses the external BrowserGym bridge and does not modify official benchmark tasks.\n', 'utf8');
  await fs.writeFile(path.join(runDir, 'report.md'), renderReport(metrics, meta), 'utf8');
  for (const name of ['janus_api.jsonl', 'model_usage.jsonl']) await fs.appendFile(path.join(runDir, name), '', 'utf8');
}

async function appendEpisodeArtifacts(runDir, row) {
  const append = async (name, value) => fs.appendFile(path.join(runDir, name), `${JSON.stringify(value, null, name.endsWith('.json') ? 2 : 0)}${name.endsWith('.json') ? '' : '\n'}`, 'utf8');
  await append('episodes.jsonl', row);
  await append('candidate_queries.jsonl', row.candidateQueries[0]);
  for (const item of row.selectionSnapshots) await append('selection_snapshots.jsonl', item);
  await append('subtasks.jsonl', { episodeId: row.config.episodeId, items: row.subtasks });
  await append('fault_manifest.jsonl', { episodeId: row.config.episodeId, ...row.faultManifest });
  for (const event of row.events) await append('events.jsonl', event);
  await append('official_evaluations.jsonl', { episodeId: row.config.episodeId, ...row.officialEvaluation });
  await append('agent_responses.jsonl', { episodeId: row.config.episodeId, agentResponse: row.agentResponse || null });
  await append('attributions.jsonl', row.attribution);
  await append('evolution_updates.jsonl', row.evolutionUpdate);
  for (const artifact of row.janusArtifacts || []) await append('janus_api.jsonl', artifact);
  for (const artifact of (row.janusArtifacts || []).filter((item) => item.kind === 'model_plan' || item.kind === 'model_action')) await append('model_usage.jsonl', { episodeId: row.config.episodeId, ...artifact });
  await append('errors.jsonl', row.metrics.errors);
}

function buildProfiles() { return [
  { ubuddyId: 'recipient-a', profileVersion: 'ubuddy_capability_profile_v1', profileRevision: 1, capabilityTags: ['dashboard_retrieval', 'numeric_reasoning'], visibility: 'friends', successRate: 0.82, privateNotes: 'not exported' },
  { ubuddyId: 'recipient-b', profileVersion: 'ubuddy_capability_profile_v1', profileRevision: 1, capabilityTags: ['form_filling', 'workflow_execution'], visibility: 'friends', successRate: 0.79, privateNotes: 'not exported' },
  { ubuddyId: 'recipient-c', profileVersion: 'ubuddy_capability_profile_v1', profileRevision: 1, capabilityTags: ['verification', 'policy_reasoning'], visibility: 'organization', successRate: 0.76, privateNotes: 'not exported' },
]; }

function faultForTask(taskId, seed) {
  const kinds = [
    { eventKind: 'profile_snapshot_frozen', layer: 'organization', sourceKind: 'capability_selection_snapshot', sourceId: `${taskId}:${seed}:stale-profile`, metadata: { status: 'stale_profile' } },
    { eventKind: 'execution_failed', layer: 'individual', sourceKind: 'delegation_event', sourceId: `${taskId}:${seed}:retry`, metadata: { status: 'failed_once' } },
    { eventKind: 'dependency_reordered', layer: 'organization', sourceKind: 'task_event', sourceId: `${taskId}:${seed}:dependency`, metadata: { status: 'reordered' } },
    { eventKind: 'requirement_revised', layer: 'organization', sourceKind: 'delegation_revision', sourceId: `${taskId}:${seed}:revision`, metadata: { status: 'revised' } },
    { eventKind: 'result_superseded', layer: 'organization', sourceKind: 'task_result', sourceId: `${taskId}:${seed}:superseded`, metadata: { status: 'superseded', coveredRevision: 1 } },
    { eventKind: 'execution_failed', layer: 'individual', sourceKind: 'delegation_event', sourceId: `${taskId}:${seed}:joint`, metadata: { status: 'capability_gap' } },
  ];
  return kinds[(Math.abs(Number(seed)) + String(taskId).length) % kinds.length];
}

function buildAttribution(config, events, faultManifest) {
  const fault = faultManifest.faults[0];
  const blocked = !events.some((event) => event.eventKind === 'profile_snapshot_frozen') && config.method !== 'M3_ours';
  return { attributionVersion: 'ubuddy_process_attribution_v1', episodeId: config.episodeId, trace: events.map(({ eventKind, sourceKind, sourceId, actorUserId, occurredAt }) => ({ eventKind, sourceKind, sourceId, actorUserId: actorUserId || '', occurredAt })), organizationSignals: fault && fault.layer === 'organization' ? [{ kind: fault.eventKind, confidence: config.method === 'M3_ours' ? 0.8 : 0.4, evidenceRefs: [fault.sourceId], recommendation: 'inspect task decomposition or routing' }] : [], individualSignals: fault && fault.layer === 'individual' ? [{ userId: 'recipient-a', agentInstanceId: 'ubuddy-agent-a', kind: 'execution_failure', confidence: config.method === 'M3_ours' ? 0.75 : 0.35, evidenceRefs: [fault.sourceId], recommendation: 'validate individual capability evidence' }] : [], evolutionEvidenceRefs: events.filter((event) => ['result_submitted', 'result_adopted', 'execution_failed'].includes(event.eventKind)).map((event) => ({ sourceKind: event.sourceKind, sourceId: event.sourceId })), evolutionRouting: { personalCandidates: fault?.layer === 'individual' ? ['recipient-a'] : [], clusterCandidates: fault?.layer === 'organization' ? ['requester'] : [], blockedReasons: blocked ? [{ code: 'capability_snapshot_missing' }] : [] } };
}

function buildEvolution(config, attribution) { const gated = config.method === 'M3_ours' && !attribution.evolutionRouting.blockedReasons.length; return { episodeId: config.episodeId, routeVersion: 'ubuddy_attribution_evolution_route_v1', organizationUpdated: gated && attribution.organizationSignals.length > 0, individualUpdated: gated && attribution.individualSignals.length > 0, evidenceGated: gated, adopted: gated, rolledBack: false, blockedReasons: attribution.evolutionRouting.blockedReasons }; }

function episodeMetrics(config, events, evaluation, attribution, evolution) { return { method: config.method, eventCount: events.length, browserActionCount: events.filter((event) => event.eventKind === 'browser_action').length, officialSuccess: evaluation.officialSuccess, protocolPass: events.length >= 6 && attribution.attributionVersion === 'ubuddy_process_attribution_v1', evidenceGated: evolution.evidenceGated, privateLeak: events.some((event) => JSON.stringify(event).includes('PRIVATE_CANARY')), errors: [] }; }

function computeMetrics(rows) { const byMethod = Object.fromEntries(METHODS.map((method) => { const subset = rows.filter((row) => row.config.method === method); const avg = (key) => subset.length ? subset.reduce((sum, row) => sum + Number(row.metrics[key] || 0), 0) / subset.length : 0; return [method, { n: subset.length, protocolPassRate: avg('protocolPass'), officialSuccessRate: avg('officialSuccess'), meanEventCount: avg('eventCount'), meanBrowserActionCount: avg('browserActionCount'), privateLeakRate: avg('privateLeak') }]; })); return { benchmark: BENCHMARK_VERSION, episodeCount: rows.length, byMethod }; }

function renderReport(metrics, meta) { return `# uBuddy-WWW 实验报告\n\n- benchmark: ${metrics.benchmark}\n- episodes: ${metrics.episodeCount}\n- kind: ${meta.kind}\n- 官方分数是否可用：${meta.officialScoreEligible ? '是' : '否（当前为 mock bridge）'}\n\n| Method | N | Protocol pass | Official success |\n|---|---:|---:|---:|\n${Object.entries(metrics.byMethod).map(([method, item]) => `| ${method} | ${item.n} | ${item.protocolPassRate.toFixed(3)} | ${item.officialSuccessRate.toFixed(3)} |`).join('\n')}\n\n当前运行若使用 mock bridge，只能证明协议和数据链路，不能作为 WWW 性能结果。\n`; }
function renderDetailedReport(runDir, rows, metrics) {
  const official = rows.every((row) => row.officialEvaluation.evaluatorVersion !== 'mock:not-a-score');
  const controlled = rows.filter((row) => row.config.condition === 'controlled').length;
  const table = Object.entries(metrics.byMethod).map(([method, item]) => `| ${method} | ${item.n} | ${item.protocolPassRate.toFixed(3)} | ${item.officialSuccessRate.toFixed(3)} | ${item.meanBrowserActionCount.toFixed(2)} | ${item.privateLeakRate.toFixed(3)} |`).join('\n');
  return `# uBuddy-WWW 实验报告

## 为什么做这个实验

实验检验两项主张：版本化、可见性受控的协作状态是否改善长程 Web 任务中的委派和依赖决策；带证据门控的组织—个体双层归因是否能改善下一轮迁移任务，而不引入更多负迁移。

## 实验设计

- benchmark：${BENCHMARK_VERSION}
- episode：${rows.length}
- 受控扰动：${controlled}；自然任务：${rows.length - controlled}
- 方法：${METHODS.join('、')}
- 官方 evaluator 可用：${official ? '是' : '否'}
- 原始数据目录：${runDir}

同一 task/seed 的四个方法共享初始条件、候选数、基础模型、最大步骤和故障清单，差异只来自协作协议。

## 执行流程

官方任务 reset → 建群前画像查询 → 候选选择与可选快照冻结 → 独立 BrowserContext 执行 → 里程碑写入 → 官方 validate → 双层归因 → 证据门控与进化路由 → 独立 verifier 重算。

## 打分机制

官方任务分数只读取 WebArena-Verified 的确定性 AgentResponseEvaluator/NetworkEventEvaluator。协议通过率只检查 artifact/schema 完整性，不等同于任务成功率。隐私泄露率检查公开事件中是否出现私有 canary。归因和迁移指标需在真实轨迹及人工金标准就绪后计算。

| Method | N | Protocol pass | Official success | Mean browser actions | Private leak |
|---|---:|---:|---:|---:|---:|
${table}

## 结果解释

${official ? '本表包含官方 evaluator 结果，可进入后续统计分析，但仍需配对置信区间和显著性检验。' : '当前运行是 protocol/mock 验证，只能证明 144-episode 编排、脱敏和独立重算链路成立。Official success=0 不是模型失败率，而是官方 evaluator 未运行。'}

## 可复核数据

- episodes.jsonl：每个 episode 的完整公开记录；
- events.jsonl：脱敏事件链；
- official_evaluations.jsonl：官方或 mock evaluator；
- janus_api.jsonl：真实 Janus API 调用产物；
- model_usage.jsonl：模型 usage 与输出哈希；
- verification.json：独立重算结果。

## 限制

未启动本地 WebArena 网站容器时，不能验证真实长程成功率、多身份权限或联合进化效果。只有第二轮官方迁移任务显著改善且负迁移受控，论文才可声称“联合进化有效”。
`;
}

async function loadManifest() { const file = path.resolve(String(args.manifest || DEFAULT_MANIFEST)); return readJson(file); }
function canaryTask() { return { officialTaskId: 'CANARY-NOT-OFFICIAL', taskClass: 'protocol_canary', category: 'canary' }; }
async function writeJson(file, value) { await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8'); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function readJsonl(file) { const text = await fs.readFile(file, 'utf8').catch(() => ''); return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function commandExists(command) { try { const { execFile } = await import('node:child_process'); await new Promise((resolve, reject) => execFile(command, ['--version'], { windowsHide: true }, (error) => error ? reject(error) : resolve())); return true; } catch { return false; } }
async function httpHealth(baseUrl) { try { const response = await fetch(`${String(baseUrl).replace(/\/$/, '')}/healthz`); return response.ok; } catch { return false; } }
async function pythonImport(moduleName, python = resolvePython()) { try { const { execFile } = await import('node:child_process'); await new Promise((resolve, reject) => execFile(python, ['-c', `import ${moduleName}`], { windowsHide: true }, (error) => error ? reject(error) : resolve())); return true; } catch { return false; } }
async function pythonImportFromSource(moduleName, python, sourceRoot) { try { const { execFile } = await import('node:child_process'); const source = path.join(sourceRoot, 'src'); await new Promise((resolve, reject) => execFile(python, ['-c', `import sys; sys.path.insert(0, r'''${source}'''); import ${moduleName}`], { windowsHide: true }, (error) => error ? reject(error) : resolve())); return true; } catch { return false; } }
async function pythonVersionAtLeast(python, major, minor) { try { const { execFile } = await import('node:child_process'); return await new Promise((resolve) => execFile(python, ['-c', `import sys; raise SystemExit(0 if sys.version_info >= (${major}, ${minor}) else 1)`], { windowsHide: true }, (error) => resolve(!error))); } catch { return false; } }
async function huggingFaceTokenAvailable(python = resolvePython()) { try { const { execFile } = await import('node:child_process'); return await new Promise((resolve) => execFile(python, ['-c', 'from huggingface_hub import get_token; raise SystemExit(0 if get_token() else 1)'], { windowsHide: true }, (error) => resolve(!error))); } catch { return false; } }
function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const candidate = path.join(ROOT, '.venv_www', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  return candidate;
}
function resolveWebarenaRoot() { return path.resolve(process.env.WEBARENA_VERIFIED_ROOT || 'D:\\Cli-anything\\benchmarks\\webarena-verified'); }
function resolveWebarenaDataset() { return path.resolve(process.env.WEBARENA_VERIFIED_DATASET || path.join(resolveWebarenaRoot(), 'assets', 'dataset', 'webarena-verified.json')); }
function resolveWebarenaPython() { const candidates = [process.env.WEBARENA_VERIFIED_PYTHON, path.join(resolveWebarenaRoot(), '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python'), path.join(ROOT, '.venv_webarena', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')].filter(Boolean); return candidates.find((candidate) => existsSync(candidate)) || (process.platform === 'win32' ? 'python' : 'python3'); }
function resolveDocker() { const bundled = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'; return process.env.DOCKER_CLI || (existsSync(bundled) ? bundled : 'docker'); }
function webarenaSiteUrls() { return { shopping_admin: process.env.WEBARENA_SHOPPING_ADMIN_URL || 'http://127.0.0.1:7780/admin', reddit: process.env.WEBARENA_REDDIT_URL || 'http://127.0.0.1:9999', gitlab: process.env.WEBARENA_GITLAB_URL || 'http://127.0.0.1:8023' }; }
async function httpReachable(url) { try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); return response.status < 500; } catch { return false; } }
function resolveChromiumExecutable() {
  if (process.env.UBUDDY_WWW_CHROMIUM_EXECUTABLE) return process.env.UBUDDY_WWW_CHROMIUM_EXECUTABLE;
  if (process.platform !== 'win32') return '';
  const candidates = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'];
  return candidates.find((candidate) => existsSync(candidate)) || '';
}
async function gitRevision() { try { const { execFile } = await import('node:child_process'); return await new Promise((resolve) => execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }, (error, stdout) => resolve(error ? 'unknown' : String(stdout).trim()))); } catch { return 'unknown'; } }
function check(name, ok, detail) { return { name, ok: Boolean(ok), detail }; }
function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

if (command === 'doctor') await webarenaDoctor();
else if (command === 'webarena-doctor') await webarenaDoctor();
else if (command === 'canary') await canary();
else if (command === 'main') await mainExperiment();
else if (command === 'evolution') await evolutionExperiment();
else if (command === 'external') await externalExperiment();
else if (command === 'verify') await verify();
else if (command === 'report') await report();
else help(0);
