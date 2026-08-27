#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_VERSION, METHODS, makeEvent, methodFeatures, nowIso, publicProfile, redactPrivate, sha256 } from './schema.mjs';
import { buildScenario } from './core/scenario.mjs';
import { CollaborationStateGraph } from './core/stateGraph.mjs';
import { allocateInternalAgent, chooseRecipients, createRootPlan, makeInternalNode } from './core/policy.mjs';
import { aggregateMetrics, evaluateEpisode } from './evaluators/metrics.mjs';
import { appworldAdapter } from './adapters/appworld.mjs';
import { theAgentCompanyAdapter } from './adapters/theagentcompany.mjs';
import { marbleAdapter } from './adapters/marble.mjs';
import { whoWhenAdapter } from './adapters/who_when.mjs';
import { swebenchAdapter } from './adapters/swebench.mjs';
import { ModelPolicyClient, recipientDecision, requesterDecision, recoveryDecision } from './core/modelPolicy.mjs';
import { assertActionAllowed } from './core/permissions.mjs';
import { spawn } from 'node:child_process';
import { JanusOrgBenchClient } from './core/janusClient.mjs';
import { createEvolutionCoordinator } from './core/evolutionCoordinator.mjs';
import { independentlyVerify } from './evaluators/independentVerifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORG_ROOT = path.join(ROOT, 'experiments', 'ubuddy_orgbench');
const RUN_ROOT = path.join(ROOT, 'experiments', 'runs');
const APPWORLD_MANIFEST = path.join(ROOT, 'experiments', 'ubuddy_appworld', 'appworld_tasks.manifest.json');
const TASK_PROTOCOL_MANIFEST = path.join(ORG_ROOT, 'task_protocol.manifest.json');
const TRANSFER_PAIRS_MANIFEST = path.join(ORG_ROOT, 'transfer_pairs.manifest.json');
const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'help';

function parseArgs(argv) { const out = { _: [] }; for (let i = 0; i < argv.length; i += 1) { const item = argv[i]; if (!item.startsWith('--')) { out._.push(item); continue; } const [key, inline] = item.slice(2).split('=', 2); const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); out[camel] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true); } return out; }
function csv(value, fallback) { return value ? String(value).split(',').map((item) => item.trim()).filter(Boolean) : fallback; }
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function selectProtocolTasks(manifest, split = 'locked_test') {
  const protocol = await readJson(TASK_PROTOCOL_MANIFEST);
  const families = new Set(protocol.splits?.[split] || []);
  const source = split === 'boundary' ? (manifest.boundarySupplement || []) : (manifest.tasks || []);
  return source.filter((task) => families.has(task.taskFamily));
}
async function writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
async function writeJsonl(file, rows) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8'); }
function encryptJson(value, keyMaterial = process.env.UBUDDY_ORGBENCH_TRUTH_KEY || 'orgbench-local-canary-key') {
  const key = crypto.createHash('sha256').update(keyMaterial).digest();
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { algorithm: 'aes-256-gcm', keyDerivation: 'sha256(env:UBUDDY_ORGBENCH_TRUTH_KEY)', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
function runDir(name = `orgbench-${Date.now()}`) { return path.join(RUN_ROOT, name); }
function help() { console.log('uBuddy-AppWorld Hybrid Benchmark v2\n\nCommands: doctor, prepare, manifest, canary, pilot, main, attribution, evolution, swebench, verify, report, package'); }

function spawnAppWorldBridge() {
  const python = process.env.APPWORLD_PYTHON || 'D:/Cli-anything/benchmarks/appworld-official/.venv313/Scripts/python.exe';
  const root = process.env.APPWORLD_ROOT || 'D:/Cli-anything/benchmarks/appworld-runtime';
  const bridgeScript = path.join(ROOT, 'experiments', 'ubuddy_appworld', 'appworld_bridge.py');
  const child = spawn(python, [bridgeScript], { env: { ...process.env, APPWORLD_ROOT: root, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  let buffer = ''; const pending = [];
  child.stdout.on('data', (chunk) => { buffer += chunk.toString(); let index; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim()) { const resolver = pending.shift(); if (resolver) { try { const response = JSON.parse(line); response.ok ? resolver.resolve(response.result) : resolver.reject(new Error(response.error)); } catch (error) { resolver.reject(error); } } } } });
  const call = (payload) => new Promise((resolve, reject) => { pending.push({ resolve, reject }); child.stdin.write(`${JSON.stringify(payload)}\n`); });
  return { call, close: () => child.kill() };
}

function modelRolePrompt({ method, layer, capability }) {
  const sharing = method === 'M1_static_profile' ? 'You only receive your assigned task and no shared progress.' : method === 'M2_generic_shared' ? 'You receive a plain, unversioned progress summary.' : 'Use the versioned visibility-filtered collaboration board; respect dependencies and result versions.';
  return `You are an AppWorld ${layer}. You are not allowed to organize other agents unless you are a uBuddy. ${sharing}\nFor an execution step, return JSON only: {"status":"execute|done|blocked","code":"valid Python for AppWorld.execute","summary":"..."}. Code may use apis.* and apis.api_docs. Execute real state changes; do not merely describe them. When the official task is fully satisfied, the final review executor must call apis.supervisor.complete_task(), including answer=... for answer-returning tasks. Capability focus: ${capability}.`;
}

function playbookRules(playbook, { taskType = 'appworld', objective = '' } = {}) {
  const rules = Array.isArray(playbook?.decompositionRules) ? playbook.decompositionRules : [];
  return rules.filter((rule) => (!rule.taskTypes?.length || rule.taskTypes.includes(String(taskType).toLowerCase()))
    && (!rule.objectiveIncludes?.length || rule.objectiveIncludes.some((token) => String(objective).toLowerCase().includes(String(token).toLowerCase()))));
}

export function applyOrganizationPlaybook(tasks, playbook, { taskType = 'appworld', objective = '' } = {}) {
  const applied = [];
  const next = Array.isArray(tasks) ? tasks.map((task) => ({ ...task, dependsOn: [...(task.dependsOn || [])] })) : [];
  for (const rule of playbookRules(playbook, { taskType, objective })) {
    applied.push(rule.id || rule.operator);
    if (rule.operator === 'require_synthesis_stage' && !next.some((task) => task.capability === 'review' || /review|synthes/i.test(task.title))) {
      next.push({ id: 'policy_review', title: 'Synthesize and review delegated results', description: 'Review and synthesize all completed subtasks before final acceptance.', capability: 'review', assigneeUbuddyId: 'ubuddy_A', dependsOn: next.map((task) => task.id) });
    }
    if (rule.operator === 'parallelize_independent_nodes') {
      for (const task of next) task.dependsOn = task.dependsOn.filter((dependency) => dependency === task.id);
    }
  }
  return { tasks: next, applied };
}

function safeRealEpisode(episode) {
  const { scenario, ...rest } = episode;
  return { ...rest, scenario: { taskId: scenario.taskId, problem: scenario.problem, seed: scenario.seed, requirements: scenario.requirements, profiles: scenario.profiles.map((profile) => publicProfile(profile, episode.method)), internalPools: Object.fromEntries(Object.entries(scenario.internalPools).map(([id, pool]) => [id, { count: pool.count, agents: pool.agents.map(({ privateMemory, ...agent }) => agent) }])), candidateCount: scenario.candidateCount } };
}

async function runRealAppWorldEpisode({ task, method, seed, runDir, evolutionContext = null, round = 1 }) {
  const bridge = spawnAppWorldBridge(); const client = new ModelPolicyClient(); const janus = new JanusOrgBenchClient(); const usage = []; const events = []; const janusArtifacts = [];
  const episodeId = `appworld:${task.taskId}:${method}:${seed}`; const scenario = buildScenario({ taskId: task.taskId, seed, problem: task.instruction });
  const graph = new CollaborationStateGraph({ episodeId, method, addEvent: (event) => events.push(event) });
  const event = (kind, layer, sourceId, metadata = {}, actorId = layer === 'requester_ubuddy' ? 'ubuddy_A' : 'system') => { const e = makeEvent({ eventKind: kind, episodeId, actorId, actorLayer: layer, sourceKind: 'appworld', sourceId, metadata }); events.push(e); return e; };
  const selections = []; const boardUpdates = []; const executions = []; let janusDelegationId = '';
  const cloudAgentMap = (() => { try { return JSON.parse(process.env.UBUDDY_ORGBENCH_CLOUD_AGENT_MAP || '{}') || {}; } catch { return {}; } })();
  const ubuddyUserMap = (() => { try { return JSON.parse(process.env.UBUDDY_ORGBENCH_UBUDDY_USER_MAP || '{}') || {}; } catch { return {}; } })();
  const cloudAgentId = (localAgentInstanceId = '') => {
    const localId = String(localAgentInstanceId || '');
    if (!localId) return '';
    if (cloudAgentMap[localId]) return String(cloudAgentMap[localId]);
    for (const [ubuddyId, pool] of Object.entries(scenario.internalPools || {})) {
      const agent = pool.agents.find((item) => item.agentInstanceId === localId); if (!agent) continue;
      const suffix = ({ research: 'research', data: 'data_analysis', coding: 'coding', execution: 'web_operation', review: 'review', communication: 'communication' })[agent.agentFamilyId] || 'research';
      return String(cloudAgentMap[`agent_${ubuddyId}_${suffix}`] || '');
    }
    return '';
  };
  try {
    const reset = await bridge.call({ command: 'reset', taskId: task.taskId, experimentName: `orgbench-${method}-${seed}-${Date.now()}` });
    event('project_created', 'requester_ubuddy', 'project_root', { benchmark: 'AppWorld', taskId: task.taskId, seed, round, evolutionNamespace: evolutionContext?.namespace || '', policyVersionId: evolutionContext?.policyVersionId || '', officialInstructionHash: sha256(reset.instruction) });
    graph.node('project_root', { kind: 'project', owner: 'ubuddy_A', title: reset.instruction, status: 'running', visibility: 'all' });
    const visibleProfiles = methodFeatures(method).multiUbuddy ? scenario.profiles.filter((p) => p.ubuddyId !== 'ubuddy_A').map((p) => publicProfile(p, method)) : [];
    event('profile_queried', 'requester_ubuddy', 'profile_catalog', { visibleCount: visibleProfiles.length });
    if (janus.enabled) janusArtifacts.push({ stage: 'candidate_query', result: await janus.queryCandidates({ userIds: String(process.env.UBUDDY_ORGBENCH_JANUS_CANDIDATE_USER_IDS || '').split(',').map((x) => x.trim()).filter(Boolean), requirement: { description: reset.instruction, capabilityTags: scenario.requirements.map((r) => r.capability) } }) });
    const requester = method === 'M0_single_ubuddy' ? { value: { inviteUbuddyIds: [], tasks: [{ id: 'whole_task', title: 'Complete official AppWorld task', description: reset.instruction, capability: 'execution', assigneeUbuddyId: 'ubuddy_A', dependsOn: [] }], usage: null } } : await requesterDecision({ client, problem: reset.instruction, profiles: visibleProfiles, board: graph.project('all'), method, evolutionContext });
    usage.push({ stage: 'requester_organization', usage: requester.usage, responseHash: requester.responseHash, model: requester.model });
    const invited = method === 'M0_single_ubuddy' ? [] : [...new Set((requester.value.inviteUbuddyIds || []).map(String).filter((id) => scenario.internalPools[id]))];
    for (const id of invited) { selections.push({ ubuddyId: id, revision: scenario.profiles.find((p) => p.ubuddyId === id)?.revision, contentHash: scenario.profiles.find((p) => p.ubuddyId === id)?.contentHash }); event('ubuddy_invited', 'requester_ubuddy', id, { recipientUbuddyId: id }); if (methodFeatures(method).profileVersioning) event('selection_snapshot_frozen', 'requester_ubuddy', `${id}:snapshot`, { recipientUbuddyId: id, revision: selections.at(-1).revision, contentHash: selections.at(-1).contentHash, immutable: true }); }
    if (janus.enabled && invited.length) janusArtifacts.push({ stage: 'selection_confirm', result: await janus.confirmSelection({ recipientUserId: String(ubuddyUserMap[invited[0]] || process.env.UBUDDY_ORGBENCH_JANUS_RECIPIENT_USER_ID || ''), selection: { profileRevision: selections[0]?.revision, contentHash: selections[0]?.contentHash, requirement: reset.instruction, selectionReason: 'OrgBench requester model decision' } }) });
    // Create the Cloud delegation before execution so the real lifecycle is
    // task-group/delegation -> progress -> result -> attribution.  The final
    // upload below remains the authoritative complete trace.
    if (janus.enabled && invited.length) {
      const delegation = await janus.createDelegation({
        recipientId: String(ubuddyUserMap[invited[0]] || process.env.UBUDDY_ORGBENCH_JANUS_RECIPIENT_USER_ID || invited[0] || ''),
        title: `OrgBench ${task.taskId}`.slice(0, 160), instruction: reset.instruction,
        clientRequestId: episodeId,
        capabilitySelection: selections[0] ? { profileRevision: selections[0].revision, contentHash: selections[0].contentHash, requirement: { description: reset.instruction, capabilityTags: scenario.requirements.map((item) => item.capability) }, consideredCandidateUserIds: String(process.env.UBUDDY_ORGBENCH_JANUS_CANDIDATE_USER_IDS || '').split(',').filter(Boolean), selectionReason: 'OrgBench requester organization decision' } : {},
        metadata: { benchmark: BENCHMARK_VERSION, method, seed, round, evolutionNamespace: evolutionContext?.namespace || '' },
      });
      janusArtifacts.push({ stage: 'delegation_create_pre_execution', result: delegation });
      janusDelegationId = delegation.payload?.delegation?.id || '';
    }
    const allowed = new Set(['ubuddy_A', ...invited]);
    const maxFirstLevelTasks = Number(process.env.UBUDDY_ORGBENCH_MAX_FIRST_LEVEL_TASKS || 5);
    const rawTasks = (Array.isArray(requester.value.tasks) ? requester.value.tasks : []).slice(0, maxFirstLevelTasks).map((item, i) => ({ id: String(item.id || `task_${i + 1}`), title: String(item.title || `Subtask ${i + 1}`), description: String(item.description || reset.instruction), capability: String(item.capability || 'execution'), assigneeUbuddyId: allowed.has(String(item.assigneeUbuddyId)) ? String(item.assigneeUbuddyId) : (invited[0] || 'ubuddy_A'), dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [] }));
    const policyApplied = applyOrganizationPlaybook(rawTasks, evolutionContext?.playbook, { taskType: 'appworld', objective: reset.instruction });
    const tasks = policyApplied.tasks.slice(0, maxFirstLevelTasks + 1);
    event('organization_policy_applied', 'requester_ubuddy', evolutionContext?.policyVersionId || 'baseline', { policyVersionId: evolutionContext?.policyVersionId || 'baseline', ruleIds: policyApplied.applied, appliedCount: policyApplied.applied.length });
    if (!tasks.length) throw new Error('requester_model_returned_no_tasks');
    for (const item of tasks) { graph.node(item.id, { kind: 'ubuddy_task', owner: item.assigneeUbuddyId, title: item.title, description: item.description, capability: item.capability, parentNodeId: 'project_root', status: 'pending', visibility: 'all' }); graph.edge('parent_of', 'project_root', item.id); graph.edge('assigned_to', item.id, item.assigneeUbuddyId, { assignmentLayer: item.assigneeUbuddyId === 'ubuddy_A' ? 'requester_internal' : 'cross_user' }); for (const dep of item.dependsOn) graph.edge('dependency_of', dep, item.id); event('task_node_created', 'requester_ubuddy', item.id, { generatedBy: 'requester_model' }); event('task_assigned', 'requester_ubuddy', item.id, { recipientUbuddyId: item.assigneeUbuddyId }); }
    const owners = [...new Set(tasks.map((t) => t.assigneeUbuddyId))];
    for (const owner of owners) {
      const pool = scenario.internalPools[owner]; const assigned = tasks.filter((t) => t.assigneeUbuddyId === owner); const internalAgents = pool.agents.map(({ privateMemory, ...a }) => ({ ...a, activeSkillVersion: evolutionContext?.agentVersions?.[a.agentInstanceId] || a.activeSkillVersion || a.skillVersion || 'base-v1', memoryVersion: evolutionContext?.memoryVersions?.[a.agentInstanceId] || a.memoryVersion || 'memory-v1' }));
      const recipient = owner === 'ubuddy_A' ? { value: { subtasks: assigned.map((t, i) => ({ id: `${t.id}_leaf`, parentTaskId: t.id, title: t.title, description: t.description, capability: t.capability, agentInstanceId: pool.agents[i % pool.agents.length].agentInstanceId, dependsOn: t.dependsOn })) }, usage: null } : await recipientDecision({ client, ubuddyId: owner, assignedTasks: assigned, internalAgents, board: graph.project('all'), method, evolutionContext });
      usage.push({ stage: `recipient_organization:${owner}`, usage: recipient.usage, responseHash: recipient.responseHash, model: recipient.model });
      const maxLeaves = Math.min(Number(process.env.UBUDDY_ORGBENCH_MAX_LEAVES_PER_UBUDDY || 4), Math.max(1, assigned.length * 2));
      const subtasks = Array.isArray(recipient.value.subtasks) ? recipient.value.subtasks.slice(0, maxLeaves) : [];
      for (const [i, raw] of subtasks.entries()) {
        const parent = assigned.find((t) => t.id === String(raw.parentTaskId)) || assigned[0]; let agent = pool.agents.find((a) => a.agentInstanceId === String(raw.agentInstanceId)) || pool.agents[i % pool.agents.length]; const id = String(raw.id || `${parent.id}_leaf_${i + 1}`);
        assertActionAllowed({ actorLayer: owner === 'ubuddy_A' ? 'requester_ubuddy' : 'recipient_ubuddy', action: 'assign_internal_agent', targetLayer: 'internal_agent', targetOwnerUbuddyId: owner, actorUbuddyId: owner });
        graph.node(id, { kind: 'internal_agent_task', owner, agentInstanceId: agent.agentInstanceId, title: String(raw.title || id), description: String(raw.description || parent.description), capability: String(raw.capability || parent.capability), parentNodeId: parent.id, status: 'running', visibility: 'all' }); graph.edge('parent_of', parent.id, id); graph.edge('assigned_to', id, agent.agentInstanceId, { assignmentLayer: 'internal' }); event('internal_agent_selected', owner === 'ubuddy_A' ? 'requester_ubuddy' : 'recipient_ubuddy', id, { agentInstanceId: agent.agentInstanceId, ownerUbuddyId: owner }); event('execution_started', 'internal_agent', id, { agentInstanceId: agent.agentInstanceId }, agent.agentInstanceId);
        const history = []; let finalStatus = 'blocked';
        const declaredDependencies = Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [];
        const unmetDependencies = declaredDependencies.filter((dependency) => graph.nodes.get(dependency)?.status !== 'done');
        if (unmetDependencies.length && methodFeatures(method).sharedState === 'gcsG') {
          graph.update(id, { status: 'blocked', blockedReason: `unmet_dependencies:${unmetDependencies.join(',')}` }, owner, owner === 'ubuddy_A' ? 'requester_ubuddy' : 'recipient_ubuddy');
          event('execution_failed', owner === 'ubuddy_A' ? 'requester_ubuddy' : 'recipient_ubuddy', id, { reason: 'unmet_dependencies', dependencies: unmetDependencies }, owner);
          executions.push({ nodeId: id, ownerUbuddyId: owner, agentInstanceId: agent.agentInstanceId, status: 'blocked', history: [], unmetDependencies });
          continue;
        }
        const maxAgentSteps = Number(process.env.UBUDDY_ORGBENCH_MAX_STEPS_PER_AGENT || 3);
        for (let step = 0; step < maxAgentSteps; step += 1) {
          const shared = method === 'M1_static_profile' ? [] : graph.project('all'); const evolutionHint = evolutionContext ? `\nActive organization policy: ${evolutionContext.policyVersionId || 'baseline'}\nActive individual versions: ${JSON.stringify(evolutionContext.agentVersions || {})}` : ''; const response = await client.json(modelRolePrompt({ method, layer: 'internal Agent executor', capability: graph.nodes.get(id).capability }), `Official task: ${reset.instruction}\nAssigned subtask: ${graph.nodes.get(id).description}\nShared board: ${JSON.stringify(shared)}${evolutionHint}\nPrevious execution outputs: ${JSON.stringify(history.slice(-3))}`, 1600);
          usage.push({ stage: `execute:${id}`, step, usage: response.usage, responseHash: response.responseHash, model: response.model }); const action = response.value || {};
          if (action.status === 'done') { finalStatus = 'done'; history.push({ status: 'done', summary: String(action.summary || '') }); break; }
          if (action.status === 'blocked') { finalStatus = 'blocked'; history.push({ status: 'blocked', summary: String(action.summary || '') }); break; }
          if (!String(action.code || '').trim()) { history.push({ status: 'invalid_action' }); continue; }
          const result = await bridge.call({ command: 'execute', role: 'internal_agent', code: String(action.code) }); history.push({ codeHash: sha256(action.code), output: String(result.output || '').slice(0, 8000) }); graph.update(id, { status: 'running', progress: (step + 1) / maxAgentSteps, lastOutputHash: sha256(result.output || '') }, agent.agentInstanceId, 'internal_agent'); event('progress_published', 'internal_agent', id, { progress: (step + 1) / maxAgentSteps, outputHash: sha256(result.output || ''), boardVersion: graph.nodes.get(id).version }, agent.agentInstanceId);
        }
        if (finalStatus !== 'done' && methodFeatures(method).sharedState === 'gcsG') {
          const recovery = await recoveryDecision({ client, ubuddyId: owner, failedTask: { id, title: graph.nodes.get(id).title, description: graph.nodes.get(id).description, capability: graph.nodes.get(id).capability, reason: history.at(-1)?.summary || 'execution_budget_exhausted' }, internalAgents, board: graph.project('all'), method });
          usage.push({ stage: `recovery:${id}`, usage: recovery.usage, responseHash: recovery.responseHash, model: recovery.model });
          event('task_replanned', owner === 'ubuddy_A' ? 'requester_ubuddy' : 'recipient_ubuddy', id, { action: recovery.value?.action || 'block', reason: recovery.value?.reason || 'model_recovery_decision' }, owner);
          const reassigned = pool.agents.find((candidate) => candidate.agentInstanceId === String(recovery.value?.agentInstanceId));
          if ((recovery.value?.action === 'retry' || recovery.value?.action === 'reassign') && reassigned) {
            agent = reassigned; graph.update(id, { status: 'running', retryCount: (graph.nodes.get(id).retryCount || 0) + 1, agentInstanceId: agent.agentInstanceId }, owner, owner === 'ubuddy_A' ? 'requester_ubuddy' : 'recipient_ubuddy'); event('execution_retried', owner === 'ubuddy_A' ? 'requester_ubuddy' : 'recipient_ubuddy', id, { retryReason: recovery.value.action, agentInstanceId: agent.agentInstanceId }, owner);
            const retryResponse = await client.json(modelRolePrompt({ method, layer: 'internal Agent executor', capability: graph.nodes.get(id).capability }), `Official task: ${reset.instruction}\nRetry this failed subtask: ${graph.nodes.get(id).description}\nExecute one recovery step and return done only if the state change is complete.`, 1600);
            usage.push({ stage: `retry_execute:${id}`, usage: retryResponse.usage, responseHash: retryResponse.responseHash, model: retryResponse.model });
            if (retryResponse.value?.status === 'done') { finalStatus = 'done'; graph.result(id, owner, owner === 'ubuddy_A' ? 'requester_ubuddy' : 'recipient_ubuddy', 'AppWorld recovery result', methodFeatures(method).resultVersioning ? 'adopted' : 'pending'); }
          }
        }
        if (finalStatus === 'done') { graph.result(id, owner, owner === 'ubuddy_A' ? 'requester_ubuddy' : 'recipient_ubuddy', 'AppWorld execution result', methodFeatures(method).resultVersioning ? 'adopted' : 'pending'); event('handoff_published', owner === 'ubuddy_A' ? 'requester_ubuddy' : 'recipient_ubuddy', id, { agentInstanceId: agent.agentInstanceId }, owner); } else { graph.update(id, { status: 'blocked', blockedReason: 'agent_blocked' }, agent.agentInstanceId, 'internal_agent'); event('execution_failed', 'internal_agent', id, { reason: 'agent_blocked' }, agent.agentInstanceId); }
        executions.push({ nodeId: id, ownerUbuddyId: owner, agentInstanceId: agent.agentInstanceId, status: finalStatus, history }); graph.update(parent.id, { status: finalStatus === 'done' ? 'done' : 'blocked', progress: finalStatus === 'done' ? 1 : 0 }, owner, owner === 'ubuddy_A' ? 'requester_ubuddy' : 'recipient_ubuddy');
      }
    }
    graph.update('project_root', { status: 'done', progress: 1 }, 'ubuddy_A', 'requester_ubuddy'); event('result_accepted', 'requester_ubuddy', 'project_root', { acceptance: 'awaiting_official_evaluator' }); const officialEvaluation = await bridge.call({ command: 'evaluate' }); event('project_evaluated', 'environment', 'appworld_official_evaluator', { success: officialEvaluation.success, passPercentage: officialEvaluation.passPercentage }, 'appworld');
    const metrics = evaluateEpisode({ scenario, method, graph, events, officialEvaluation });
    if (janus.enabled && janusDelegationId) { janusArtifacts.push({ stage: 'organization_trace', result: await janus.uploadOrganizationTrace({ evolutionNamespace: evolutionContext?.namespace || 'default', traceId: episodeId, delegationId: janusDelegationId, taskType: 'appworld', events: events.map((item, index) => { const localAgentInstanceId = String(item.metadata?.agentInstanceId || ''); return ({ ...item, idempotencyKey: `${episodeId}:${index}:${item.eventKind}`, payload: { ...item.metadata, localAgentInstanceId, agentInstanceId: cloudAgentId(localAgentInstanceId), officialEvaluation: item.eventKind === 'project_evaluated' ? officialEvaluation : undefined } }); }) }) }); janusArtifacts.push({ stage: 'state_graph', result: await janus.stateGraph({ delegationId: janusDelegationId }) }); janusArtifacts.push({ stage: 'attribution', result: await janus.attribution(janusDelegationId) }); }
    return { episodeId, benchmark: 'AppWorld', taskId: task.taskId, method, seed, round, evolutionNamespace: evolutionContext?.namespace || '', policyVersionId: evolutionContext?.policyVersionId || 'org-policy-baseline-v1', policyRulesApplied: policyApplied.applied, janusDelegationId, protocolOnly: false, officialEvaluation, metrics, graph: graph.project('all'), events, executions, usage, publicProfiles: visibleProfiles, selections, janusArtifacts, scenario, taskInstruction: reset.instruction, createdAt: nowIso() };
  } finally { await bridge.call({ command: 'close' }).catch(() => {}); bridge.close(); }
}

async function doctor() {
  const [appworld, tac] = await Promise.all([appworldAdapter().doctor(), theAgentCompanyAdapter().doctor()]);
  const checks = [
    { name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 20, detail: process.versions.node },
    { name: 'appworld', ok: appworld.available, detail: appworld },
    { name: 'theagentcompany', ok: tac.available, detail: tac },
    { name: 'marble', ok: await exists('D:/Cli-anything/benchmarks/marble/marble'), detail: marbleAdapter().source },
    { name: 'who_when', ok: await exists('D:/Cli-anything/benchmarks/who-and-when'), detail: whoWhenAdapter().source },
    { name: 'model_endpoint_configured', ok: Boolean(process.env.CRS_OAI_KEY && process.env.OPENAI_BASE_URL), detail: 'CRS_OAI_KEY + OPENAI_BASE_URL (optional for offline canary)' },
  ];
  const ready = checks.filter((item) => ['node', 'appworld', 'marble', 'who_when'].includes(item.name)).every((item) => item.ok);
  console.log(JSON.stringify({ benchmark: BENCHMARK_VERSION, approvalRequired: false, checks, ready, theAgentCompanyDeferred: !tac.available }, null, 2));
  process.exitCode = ready ? 0 : 1;
}

async function manifest() {
  const appworld = await readJson(APPWORLD_MANIFEST);
  const orgAppworldPath = path.join(ORG_ROOT, 'appworld_orgbench_tasks.manifest.json');
  const orgAppworld = await exists(orgAppworldPath) ? await readJson(orgAppworldPath) : null;
  const tac = await theAgentCompanyAdapter().manifest();
  const output = {
    benchmark: BENCHMARK_VERSION,
    name: 'uBuddy-AppWorld Hybrid Benchmark',
    version: 'v2',
    protocol: 'BENCHMARK_PROTOCOL.md',
    approvalRequired: false,
    primary: orgAppworld ? { name: 'AppWorld', officialEvaluatorRequired: true, strictTaskCount: orgAppworld.strictTaskCount, boundaryTaskCount: orgAppworld.boundaryTaskCount, taskIds: orgAppworld.tasks.map((task) => task.taskId), boundaryTaskIds: orgAppworld.boundarySupplement.map((task) => task.taskId), manifestSha256: orgAppworld.manifestSha256 } : { name: 'AppWorld', officialEvaluatorRequired: true, taskCount: appworld.taskCount, taskIds: appworld.tasks.map((task) => task.taskId), manifestSha256: appworld.manifestSha256 },
    externalScenarioValidation: { name: 'TheAgentCompany', taskCount: tac.taskCount, status: 'adapter_manifest', taskIds: tac.taskIds },
    organizationReference: marbleAdapter(),
    attributionReference: whoWhenAdapter(),
    externalValidation: swebenchAdapter(),
    selectionRules: { theAgentCompany: 'six role families, four tasks each, >=3 checkpoints, >=1 deterministic checkpoint', appworld: 'existing audited 12-task manifest; expand to 40 only after compatibility audit' },
  };
  output.manifestSha256 = sha256(JSON.stringify(output));
  await writeJson(path.join(ORG_ROOT, 'orgbench.manifest.json'), output);
  console.log(JSON.stringify({ output: path.join(ORG_ROOT, 'orgbench.manifest.json'), taskCounts: { appworldStrict: orgAppworld?.strictTaskCount ?? appworld.taskCount, appworldBoundary: orgAppworld?.boundaryTaskCount ?? 0, theAgentCompany: tac.taskCount }, manifestSha256: output.manifestSha256 }, null, 2));
}

async function prepare() {
  const generator = path.join(ROOT, 'scripts', 'generate_orgbench_manifests.py');
  const python = process.env.APPWORLD_PYTHON || 'D:/Cli-anything/benchmarks/appworld-official/.venv313/Scripts/python.exe';
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => { const child = spawn(python, [generator], { stdio: 'inherit', windowsHide: true }); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`orgbench_manifest_generation_failed:${code}`))); child.on('error', reject); });
  await manifest();
  const plan = { benchmark: BENCHMARK_VERSION, methods: METHODS, seeds: [20260821, 20260822, 20260823], splitUnit: 'task_family', controlledLockedTestEpisodes: 228, faultStressEpisodesMaximum: 1824, evolutionPairEpisodes: 300, primaryMetric: 'AppWorld official checkpoint rate', processDimensions: 8, deferred: ['swebench_verified', 'theagentcompany_external_validation'], generatedAt: nowIso() };
  await writeJson(path.join(ORG_ROOT, 'experiment_plan.json'), plan);
  console.log(JSON.stringify({ prepared: true, plan: path.join(ORG_ROOT, 'experiment_plan.json') }, null, 2));
}

export function makeEpisode({ taskId, method, seed, benchmark = 'synthetic', injectFault = null }) {
  const episodeId = `${benchmark}:${taskId}:${method}:${seed}`;
  const scenario = buildScenario({ taskId, seed, injectFault, problem: benchmark === 'synthetic' ? 'Resolve a project problem requiring research, execution, and review.' : `Complete ${benchmark} task ${taskId} while coordinating multiple people and Agent teams.` });
  const events = [];
  const addEvent = (eventKind, actorLayer, sourceId, metadata = {}, actorId = actorLayer === 'requester_ubuddy' ? 'ubuddy_A' : 'system') => {
    const event = makeEvent({ eventKind, episodeId, actorId, actorLayer, sourceKind: sourceId.includes('task') ? 'task_node' : 'orgbench', sourceId, metadata }); events.push(event); return event;
  };
  const graph = new CollaborationStateGraph({ episodeId, method, addEvent: (event) => events.push(event) });
  const executions = [];
  addEvent('project_created', 'requester_ubuddy', 'project_root', { benchmark, taskId, method, seed });
  const visibleProfiles = methodFeatures(method).multiUbuddy ? scenario.profiles.filter((profile) => profile.ubuddyId !== 'ubuddy_A').map((profile) => publicProfile(profile, method)) : [];
  addEvent('profile_queried', 'requester_ubuddy', 'profile_catalog', { visibleCount: visibleProfiles.length, profileRevisionsVisible: methodFeatures(method).profileVersioning });
  const plan = createRootPlan({ scenario, method, graph, addEvent: (kind, layer, sourceId, metadata) => addEvent(kind, layer, sourceId, metadata) });
  const selection = methodFeatures(method).multiUbuddy
    ? chooseRecipients({ profiles: scenario.profiles.filter((profile) => profile.ubuddyId !== 'ubuddy_A'), requirements: scenario.requirements, method })
    : { selected: [scenario.profiles[0]], scores: [], snapshots: [] };
  for (const profile of selection.selected.filter((item) => item.ubuddyId !== 'ubuddy_A')) {
    addEvent('ubuddy_invited', 'requester_ubuddy', profile.ubuddyId, { recipientUbuddyId: profile.ubuddyId });
    if (methodFeatures(method).profileVersioning) addEvent('selection_snapshot_frozen', 'requester_ubuddy', `${profile.ubuddyId}:snapshot`, { recipientUbuddyId: profile.ubuddyId, revision: profile.revision, contentHash: profile.contentHash, immutable: true });
  }
  for (const [index, task] of plan.nodes.entries()) {
    const requirement = task.requirement;
    const recipient = selection.selected[index % Math.max(1, selection.selected.length)] || scenario.profiles[0];
    graph.update(task.id, { owner: recipient.ubuddyId, status: 'running' }, 'ubuddy_A');
    graph.edge('assigned_to', task.id, recipient.ubuddyId, { assignmentLayer: recipient.ubuddyId === 'ubuddy_A' ? 'requester_internal' : 'cross_user' });
    addEvent('task_assigned', 'requester_ubuddy', task.id, { recipientUbuddyId: recipient.ubuddyId, capability: requirement.capability, assignmentLayer: recipient.ubuddyId === 'ubuddy_A' ? 'requester_internal' : 'cross_user' });
    const pool = scenario.internalPools[recipient.ubuddyId];
    const agent = allocateInternalAgent(pool, requirement, method);
    const allocationLayer = recipient.ubuddyId === 'ubuddy_A' ? 'requester_ubuddy' : 'recipient_ubuddy';
    const internalNodeId = makeInternalNode(task, agent, requirement, seed, graph, (kind, layer, sourceId, metadata) => addEvent(kind, layer, sourceId, metadata, recipient.ubuddyId), allocationLayer);
    addEvent('execution_started', 'internal_agent', internalNodeId, { agentInstanceId: agent.agentInstanceId }, agent.agentInstanceId);
    const shouldFail = scenario.injectFault === 'internal_agent_failure' && index === 0;
    if (shouldFail) {
      graph.update(internalNodeId, { status: 'blocked', blockedReason: 'injected_internal_agent_failure' }, agent.agentInstanceId, 'internal_agent');
      addEvent('execution_failed', 'internal_agent', internalNodeId, { fault: scenario.injectFault, trueLayer: 'internal_agent' }, agent.agentInstanceId);
      addEvent('execution_retried', allocationLayer, internalNodeId, { retryReason: 'failure_recovery' }, recipient.ubuddyId);
      graph.update(internalNodeId, { status: 'running', retryCount: 1 }, recipient.ubuddyId, allocationLayer);
    }
    graph.update(internalNodeId, { status: 'done', progress: 1 }, agent.agentInstanceId, 'internal_agent');
    graph.result(internalNodeId, recipient.ubuddyId, allocationLayer, `${requirement.capability} result submitted`, methodFeatures(method).resultVersioning ? 'adopted' : 'pending');
    graph.update(task.id, { status: 'done', progress: 1 }, recipient.ubuddyId, allocationLayer);
    addEvent('handoff_published', allocationLayer, internalNodeId, { recipientUbuddyId: recipient.ubuddyId, agentInstanceId: agent.agentInstanceId }, recipient.ubuddyId);
    executions.push({ nodeId: internalNodeId, ownerUbuddyId: recipient.ubuddyId, agentInstanceId: agent.agentInstanceId, status: 'done' });
  }
  graph.update('project_root', { status: 'done', progress: 1 }, 'ubuddy_A', 'requester_ubuddy');
  addEvent('result_accepted', 'requester_ubuddy', 'project_root', { acceptance: 'protocol_canary' });
  addEvent('project_evaluated', 'requester_ubuddy', 'project_root:evaluation', { officialEvaluatorAvailable: false });
  addEvent('attribution_generated', 'requester_ubuddy', 'project_root:attribution', { gated: methodFeatures(method).attributionGate });
  const metrics = evaluateEpisode({ scenario, method, graph, events });
  return { episodeId, benchmark, taskId, method, seed, scenario, visibleProfiles, selection, executions, graph, events, metrics, protocolOnly: true, createdAt: nowIso() };
}

export async function makeLiveOrganizationEpisode({ taskId, method = 'M3_ours', seed = 20260826, problem = 'Research the available evidence, perform the requested work, and independently review the final result.', benchmark = 'synthetic' }) {
  const client = new ModelPolicyClient();
  const episodeId = `${benchmark}:${taskId}:${method}:${seed}:live`;
  const scenario = buildScenario({ taskId, seed, problem }); const events = []; const usage = [];
  const addEvent = (eventKind, actorLayer, sourceId, metadata = {}, actorId = actorLayer === 'requester_ubuddy' ? 'ubuddy_A' : 'system') => { const event = makeEvent({ eventKind, episodeId, actorId, actorLayer, sourceKind: 'orgbench', sourceId, metadata }); events.push(event); return event; };
  const graph = new CollaborationStateGraph({ episodeId, method, addEvent: (event) => events.push(event) });
  graph.node('project_root', { kind: 'project', owner: 'ubuddy_A', title: problem, status: 'running', visibility: 'all' }); addEvent('project_created', 'requester_ubuddy', 'project_root', { taskId, benchmark, liveModel: true });
  const profiles = methodFeatures(method).multiUbuddy ? scenario.profiles.filter((profile) => profile.ubuddyId !== 'ubuddy_A').map((profile) => publicProfile(profile, method)) : [publicProfile(scenario.profiles[0], method)];
  addEvent('profile_queried', 'requester_ubuddy', 'profile_catalog', { visibleCount: profiles.length });
  const requester = await requesterDecision({ client, problem, profiles, board: graph.project('all'), method }); usage.push({ stage: 'requester_organization', usage: requester.usage, responseHash: requester.responseHash, model: requester.model });
  const validUbuddyIds = new Set(profiles.map((profile) => profile.ubuddyId));
  const inviteIds = [...new Set((requester.value.inviteUbuddyIds || []).map(String).filter((id) => validUbuddyIds.has(id)))];
  for (const ubuddyId of inviteIds) { assertActionAllowed({ actorLayer: 'requester_ubuddy', action: 'invite_ubuddy' }); addEvent('ubuddy_invited', 'requester_ubuddy', ubuddyId, { recipientUbuddyId: ubuddyId }); const profile = scenario.profiles.find((item) => item.ubuddyId === ubuddyId); if (profile && methodFeatures(method).profileVersioning) addEvent('selection_snapshot_frozen', 'requester_ubuddy', `${ubuddyId}:snapshot`, { revision: profile.revision, contentHash: profile.contentHash, immutable: true }); }
  const rawTasks = Array.isArray(requester.value.tasks) ? requester.value.tasks.slice(0, 8) : []; if (!rawTasks.length) throw new Error('requester_model_returned_no_tasks');
  const firstLevel = [];
  for (const [index, item] of rawTasks.entries()) {
    const id = String(item.id || `task_${index + 1}`); const assignee = validUbuddyIds.has(String(item.assigneeUbuddyId)) ? String(item.assigneeUbuddyId) : (inviteIds[0] || profiles[0].ubuddyId);
    assertActionAllowed({ actorLayer: 'requester_ubuddy', action: 'create_task_node' }); assertActionAllowed({ actorLayer: 'requester_ubuddy', action: 'assign_to_ubuddy' });
    const task = { id, title: String(item.title || id), description: String(item.description || ''), capability: String(item.capability || 'execution'), assigneeUbuddyId: assignee, dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [] };
    graph.node(id, { kind: 'ubuddy_task', owner: assignee, title: task.title, description: task.description, capability: task.capability, parentNodeId: 'project_root', status: 'pending', visibility: 'all' }); graph.edge('parent_of', 'project_root', id); graph.edge('assigned_to', id, assignee, { assignmentLayer: 'cross_user' }); for (const dependency of task.dependsOn) graph.edge('dependency_of', dependency, id); addEvent('task_node_created', 'requester_ubuddy', id, { generatedBy: 'requester_model', capability: task.capability }); addEvent('task_assigned', 'requester_ubuddy', id, { recipientUbuddyId: assignee }); firstLevel.push(task);
  }
  for (const ubuddyId of [...new Set(firstLevel.map((task) => task.assigneeUbuddyId))]) {
    const pool = scenario.internalPools[ubuddyId]; if (!pool) continue; const assignedTasks = firstLevel.filter((task) => task.assigneeUbuddyId === ubuddyId); const internalAgents = pool.agents.map(({ privateMemory, ...agent }) => agent);
    const recipient = await recipientDecision({ client, ubuddyId, assignedTasks, internalAgents, board: graph.project('all'), method }); usage.push({ stage: `recipient_organization:${ubuddyId}`, usage: recipient.usage, responseHash: recipient.responseHash, model: recipient.model });
    for (const [index, item] of (Array.isArray(recipient.value.subtasks) ? recipient.value.subtasks.slice(0, 10) : []).entries()) {
      const parentTaskId = assignedTasks.some((task) => task.id === String(item.parentTaskId)) ? String(item.parentTaskId) : assignedTasks[0].id; const agent = pool.agents.find((candidate) => candidate.agentInstanceId === String(item.agentInstanceId)); if (!agent) continue;
      assertActionAllowed({ actorLayer: 'recipient_ubuddy', action: 'assign_internal_agent', targetLayer: 'internal_agent', targetOwnerUbuddyId: ubuddyId, actorUbuddyId: ubuddyId }); const id = String(item.id || `${parentTaskId}_leaf_${index + 1}`);
      graph.node(id, { kind: 'internal_agent_task', owner: ubuddyId, agentInstanceId: agent.agentInstanceId, title: String(item.title || id), description: String(item.description || ''), capability: String(item.capability || agent.capabilities[0]), parentNodeId: parentTaskId, status: 'done', progress: 1, visibility: 'all' }); graph.edge('parent_of', parentTaskId, id); graph.edge('assigned_to', id, agent.agentInstanceId, { assignmentLayer: 'internal' }); for (const dependency of (Array.isArray(item.dependsOn) ? item.dependsOn : [])) graph.edge('dependency_of', String(dependency), id); addEvent('internal_agent_selected', 'recipient_ubuddy', id, { generatedBy: 'recipient_model', ownerUbuddyId: ubuddyId, agentInstanceId: agent.agentInstanceId }, ubuddyId); addEvent('execution_started', 'internal_agent', id, { liveExecutorStub: true }, agent.agentInstanceId); addEvent('progress_published', 'internal_agent', id, { progress: 1 }, agent.agentInstanceId); graph.result(id, ubuddyId, 'recipient_ubuddy', 'protocol live-model result', methodFeatures(method).resultVersioning ? 'adopted' : 'pending');
    }
    for (const task of assignedTasks) graph.update(task.id, { status: 'done', progress: 1 }, ubuddyId, 'recipient_ubuddy');
  }
  graph.update('project_root', { status: 'done', progress: 1 }, 'ubuddy_A', 'requester_ubuddy'); addEvent('result_accepted', 'requester_ubuddy', 'project_root', { liveModelOrganization: true }); addEvent('project_evaluated', 'requester_ubuddy', 'project_root:evaluation', { protocolOnly: true });
  return { episodeId, taskId, benchmark, method, seed, problem, visibleProfiles: profiles, graph: graph.project('all'), events, metrics: evaluateEpisode({ scenario, method, graph, events }), usage, protocolOnly: true, liveModelOrganization: true, createdAt: nowIso() };
}

async function runEpisodes({ name, tasks, seeds, methods = METHODS, benchmark = 'synthetic', injectFault = null }) {
  const dir = runDir(name); await fs.mkdir(dir, { recursive: true });
  const rows = []; const hiddenRows = [];
  for (const taskId of tasks) for (const seed of seeds) for (const method of methods) {
    const episode = makeEpisode({ taskId, method, seed, benchmark, injectFault });
    hiddenRows.push({ episodeId: episode.episodeId, truth: episode.scenario.hiddenTruth });
    const safe = { ...episode, scenario: { ...episode.scenario, hiddenTruth: undefined, internalPools: Object.fromEntries(Object.entries(episode.scenario.internalPools).map(([id, pool]) => [id, { count: pool.count, agents: pool.agents.map(({ privateMemory, ...agent }) => agent) }])) }, graph: episode.graph.project('all') };
    rows.push(safe);
  }
  await writeJsonl(path.join(dir, 'episodes.jsonl'), rows);
  await writeJson(path.join(dir, 'metrics.json'), aggregateMetrics(rows.map((row) => row.metrics)));
  await writeJson(path.join(dir, 'config.json'), { benchmark: BENCHMARK_VERSION, mode: 'protocol_canary', taskCount: tasks.length, seeds, methods, episodeCount: rows.length, generatedAt: nowIso() });
  await writeJson(path.join(dir, 'hidden_truth.enc.json'), encryptJson({ benchmark: BENCHMARK_VERSION, rows: hiddenRows }));
  console.log(JSON.stringify({ runDir: dir, episodeCount: rows.length, metrics: path.join(dir, 'metrics.json'), protocolOnly: true }, null, 2));
  return dir;
}

async function canary() {
  if (args.realAppworld) {
    const manifest = await readJson(path.join(ROOT, 'experiments', 'ubuddy_orgbench', 'appworld_orgbench_tasks.manifest.json'));
    const task = manifest.tasks.find((item) => item.taskId === String(args.taskId || '')) || manifest.tasks[0];
    const dir = path.resolve(String(args.runDir || runDir(`orgbench-appworld-canary-${Date.now()}`))); await fs.mkdir(dir, { recursive: true });
    const method = String(args.method || 'M3_ours'); const seed = Number(args.seed || 20260826);
    let episode; let runError = null;
    try { episode = await runRealAppWorldEpisode({ task, method, seed, runDir: dir }); } catch (error) { runError = { name: error.name, message: error.message, stack: error.stack }; await writeJsonl(path.join(dir, 'errors.jsonl'), [{ taskId: task.taskId, method, seed, stage: 'real_appworld_episode', ...runError, infrastructureLikely: /fetch failed|timeout|ECONN|model_request/.test(error.message) }]); }
    if (!episode) { await writeJson(path.join(dir, 'config.json'), { benchmark: BENCHMARK_VERSION, adapter: 'AppWorld', mode: 'real', taskId: task.taskId, method, seed, episodeCount: 0, failed: true }); console.log(JSON.stringify({ runDir: dir, benchmark: 'AppWorld', taskId: task.taskId, method, seed, protocolOnly: false, failed: true, error: runError }, null, 2)); return; }
    await writeJson(path.join(dir, 'config.json'), { benchmark: BENCHMARK_VERSION, adapter: 'AppWorld', mode: 'real', taskId: task.taskId, method, seed, episodeCount: 1, model: process.env.UBUDDY_ORGBENCH_MODEL || 'gpt-5.4-mini' });
    await writeJson(path.join(dir, 'problem.json'), { taskId: task.taskId, instruction: episode.taskInstruction, benchmark: 'AppWorld' });
    await writeJson(path.join(dir, 'public_ubuddy_profiles.json'), episode.publicProfiles);
    await writeJsonl(path.join(dir, 'selection_snapshots.jsonl'), episode.selections);
    await writeJsonl(path.join(dir, 'task_tree_events.jsonl'), episode.events.filter((e) => ['task_node_created', 'dependency_created', 'task_assigned', 'internal_agent_selected'].includes(e.eventKind)));
    await writeJsonl(path.join(dir, 'execution_events.jsonl'), episode.events.filter((e) => ['execution_started', 'progress_published', 'execution_failed', 'execution_retried', 'handoff_published'].includes(e.eventKind)));
    await writeJson(path.join(dir, 'official_evaluation.json'), episode.officialEvaluation);
    await writeJson(path.join(dir, 'organization_evaluation.json'), episode.metrics);
    await writeJson(path.join(dir, 'attribution.json'), { status: 'deferred', reason: 'run attribution command after collecting traces', traceEventCount: episode.events.length });
    await writeJson(path.join(dir, 'evolution_update.json'), { status: 'deferred', reason: 'requires validated attribution and transfer round' });
    await writeJsonl(path.join(dir, 'events.jsonl'), episode.events);
    await writeJsonl(path.join(dir, 'model_usage.jsonl'), episode.usage);
    await writeJson(path.join(dir, 'episodes.json'), [safeRealEpisode(episode)]);
    await writeJson(path.join(dir, 'metrics.json'), aggregateMetrics([episode.metrics]));
    await writeJson(path.join(dir, 'hidden_truth.enc.json'), encryptJson({ taskId: task.taskId, truth: episode.scenario.hiddenTruth }));
    console.log(JSON.stringify({ runDir: dir, benchmark: 'AppWorld', taskId: task.taskId, method, seed, protocolOnly: false, officialEvaluation: episode.officialEvaluation, artifacts: ['official_evaluation.json', 'organization_evaluation.json', 'task_tree_events.jsonl', 'execution_events.jsonl', 'model_usage.jsonl'] }, null, 2));
    return;
  }
  if (args.liveModel) { const dir = runDir(`orgbench-live-canary-${Date.now()}`); await fs.mkdir(dir, { recursive: true }); const episode = await makeLiveOrganizationEpisode({ taskId: 'live_canary_001', method: String(args.method || 'M3_ours'), seed: Number(args.seed || 20260826) }); await writeJsonl(path.join(dir, 'episodes.jsonl'), [episode]); await writeJson(path.join(dir, 'metrics.json'), aggregateMetrics([episode.metrics])); await writeJson(path.join(dir, 'config.json'), { benchmark: BENCHMARK_VERSION, liveModelOrganization: true, protocolOnly: true, method: episode.method, seed: episode.seed }); console.log(JSON.stringify({ runDir: dir, episodeCount: 1, liveModelOrganization: true, protocolOnly: true }, null, 2)); return; }
  await runEpisodes({ name: `orgbench-canary-${Date.now()}`, tasks: ['canary_001'], seeds: [20260826] });
}
async function pilot() {
  if (args.realAppworld) {
    const manifest = await readJson(path.join(ORG_ROOT, 'appworld_orgbench_tasks.manifest.json')); const tasks = manifest.tasks.slice(0, Number(args.taskCount || 1)); const dir = path.resolve(String(args.runDir || runDir(`orgbench-appworld-pilot-${Date.now()}`))); await fs.mkdir(dir, { recursive: true }); const rows = []; const errors = []; const seeds = csv(args.seeds, ['20260821', '20260822', '20260823']).map(Number); const methods = csv(args.methods, METHODS);
    for (const task of tasks) for (const seed of seeds) for (const method of methods) { try { rows.push(await runRealAppWorldEpisode({ task, method, seed, runDir: dir })); } catch (error) { errors.push({ taskId: task.taskId, method, seed, message: error.message, stack: error.stack, infrastructureLikely: /fetch failed|timeout|ECONN|model_request/.test(error.message) }); } await writeJsonl(path.join(dir, 'episodes.jsonl'), rows.map(safeRealEpisode)); if (errors.length) await writeJsonl(path.join(dir, 'errors.jsonl'), errors); await writeJson(path.join(dir, 'metrics.json'), aggregateMetrics(rows.map((r) => r.metrics))); }
    await writeJson(path.join(dir, 'config.json'), { benchmark: BENCHMARK_VERSION, adapter: 'AppWorld', mode: 'real', taskCount: tasks.length, episodeCount: rows.length, errorCount: errors.length, methods, seeds }); console.log(JSON.stringify({ runDir: dir, episodeCount: rows.length, errorCount: errors.length, protocolOnly: false }, null, 2)); return;
  }
  await runEpisodes({ name: `orgbench-pilot-${Date.now()}`, tasks: ['pilot_001', 'pilot_002'], seeds: [20260821, 20260822] });
}
async function main() {
  if (args.realAppworld) {
    const manifest = await readJson(path.join(ORG_ROOT, 'appworld_orgbench_tasks.manifest.json')); const split = String(args.split || 'locked_test'); const splitTasks = await selectProtocolTasks(manifest, split); const taskLimit = Number(args.taskCount || splitTasks.length); const tasks = splitTasks.slice(0, taskLimit); const seeds = csv(args.seeds, ['20260821', '20260822', '20260823']).map(Number); const methods = csv(args.methods, METHODS); const dir = path.resolve(String(args.runDir || runDir(`orgbench-appworld-main-${Date.now()}`))); await fs.mkdir(dir, { recursive: true }); const rows = []; const errors = [];
    for (const task of tasks) for (const seed of seeds) for (const method of methods) { try { rows.push(await runRealAppWorldEpisode({ task, method, seed, runDir: dir })); } catch (error) { errors.push({ taskId: task.taskId, method, seed, message: error.message, stack: error.stack, infrastructureLikely: /fetch failed|timeout|ECONN|model_request/.test(error.message) }); } await writeJsonl(path.join(dir, 'episodes.jsonl'), rows.map(safeRealEpisode)); if (errors.length) await writeJsonl(path.join(dir, 'errors.jsonl'), errors); await writeJson(path.join(dir, 'metrics.json'), aggregateMetrics(rows.map((r) => r.metrics))); }
    await writeJson(path.join(dir, 'config.json'), { benchmark: BENCHMARK_VERSION, adapter: 'AppWorld', mode: 'real', split, splitUnit: 'task_family', taskCount: tasks.length, taskIds: tasks.map((task) => task.taskId), episodeCount: rows.length, errorCount: errors.length, methods, seeds }); console.log(JSON.stringify({ runDir: dir, split, episodeCount: rows.length, errorCount: errors.length, protocolOnly: false }, null, 2)); return;
  }
  await runEpisodes({ name: `orgbench-main-${Date.now()}`, tasks: ['appworld_6f4b9a5_1', 'appworld_042a9fc_1', 'tac_pm_assign_issues', 'tac_sde_unit_test'], seeds: [20260821, 20260822, 20260823] });
}
async function attribution() { const dir = runDir(`orgbench-attribution-${Date.now()}`); const rows = []; for (let i = 0; i < 24; i += 1) for (const method of ['A0_final_outcome_only', 'A1_unstructured_trace', 'A2_single_layer_credit', 'A3_layered_evidence']) rows.push({ traceId: `trace_${i + 1}`, method, goldLayer: i % 3 === 0 ? 'requester_ubuddy' : i % 3 === 1 ? 'recipient_ubuddy' : 'internal_agent', predictedLayer: method === 'A3_layered_evidence' ? (i % 3 === 0 ? 'requester_ubuddy' : i % 3 === 1 ? 'recipient_ubuddy' : 'internal_agent') : 'unknown', evidenceRefs: method === 'A3_layered_evidence' ? [`event_${i + 1}`] : [], blocked: i % 8 === 0 && method === 'A3_layered_evidence' }); await writeJsonl(path.join(dir, 'attributions.jsonl'), rows); await writeJson(path.join(dir, 'metrics.json'), { protocolOnly: true, traceCount: 24, methodCount: 4, note: 'Canary attribution schema; human gold and full 192-trace evaluation are not generated by this command.' }); console.log(JSON.stringify({ runDir: dir, output: path.join(dir, 'attributions.jsonl'), resultEligible: false }, null, 2)); }
async function evolution() {
  const dir = path.resolve(String(args.runDir || runDir(`orgbench-evolution-${Date.now()}`)));
  await fs.mkdir(dir, { recursive: true });
  const methods = ['E0_static', 'E1_organization_only', 'E2_individual_only', 'E3_joint_gated', 'E4_joint_no_gate'];
  const real = Boolean(args.realAppworld);
  const seeds = csv(args.seeds, [20260827]).map(Number);
  let tasks = [{ taskId: 'synthetic_round1', instruction: 'Resolve a multi-step research, data analysis, execution and review problem.' }, { taskId: 'synthetic_round2', instruction: 'Resolve a similar but different research, data analysis, execution and review problem.' }];
  if (real) {
    const manifest = await readJson(path.join(ORG_ROOT, 'appworld_orgbench_tasks.manifest.json'));
    const transfer = await readJson(TRANSFER_PAIRS_MANIFEST); const pair = transfer.pairs.find((item) => item.round1 === String(args.taskId || '')) || transfer.pairs[0]; const allTasks = [...manifest.tasks, ...(manifest.boundarySupplement || [])];
    const first = allTasks.find((item) => item.taskId === pair.round1); const second = allTasks.find((item) => item.taskId === pair.round2);
    if (!first || !second) throw new Error(`transfer_pair_task_missing:${pair.round1}:${pair.round2}`);
    tasks = [first, second];
  }
  const rows = [];
  for (const seed of seeds) for (const method of methods) {
    const namespace = `orgbench-${method}-${seed}-${crypto.randomUUID()}`;
    const pairDir = path.join(dir, `${method}-${seed}`);
    const coordinator = createEvolutionCoordinator({ client: new JanusOrgBenchClient(), artifactDir: pairDir, namespace, method, gateThreshold: 0.7 });
    let round1Episode; let round2Episode; let round1Official = null; let round2Official = null; let evolutionContext = {};
    if (real) {
      round1Episode = await runRealAppWorldEpisode({ task: tasks[0], method: 'M3_ours', seed, runDir: pairDir, round: 1, evolutionContext: { namespace } });
      round1Official = round1Episode.officialEvaluation;
    } else {
      round1Episode = makeEpisode({ taskId: tasks[0].taskId, method: 'M3_ours', seed, benchmark: 'synthetic' });
      round1Official = null;
    }
    const round1 = await coordinator.processRound1({ episode: round1Episode, officialEvaluation: round1Official, taskType: 'appworld', delegationId: round1Episode.janusDelegationId || round1Episode.episodeId });
    if (real) {
      const agentVersions = Object.fromEntries([...coordinator.state.agents.entries()].map(([id, value]) => [id, value.activeSkillVersion]));
      const memoryVersions = Object.fromEntries([...coordinator.state.agents.entries()].map(([id, value]) => [id, value.memoryVersion]));
      evolutionContext = { namespace, policyVersionId: round1.activePolicy?.policyVersionId || 'org-policy-baseline-v1', playbook: round1.activePolicy?.playbook || null, agentVersions, memoryVersions };
      round2Episode = await runRealAppWorldEpisode({ task: tasks[1], method: 'M3_ours', seed: seed + 1, runDir: pairDir, round: 2, evolutionContext });
      round2Official = round2Episode.officialEvaluation;
    } else {
      round2Episode = makeEpisode({ taskId: tasks[1].taskId, method: 'M3_ours', seed: seed + 1, benchmark: 'synthetic' });
    }
    const finalized = await coordinator.finalizeRound2({ round1: { episode: round1Episode, officialEvaluation: round1Official }, round2Episode, round2Metrics: round2Episode.metrics || {} });
    const round1UpdateRows = round1.updates || [];
    const adopted = round1UpdateRows.filter((item) => item.adoptionStatus === 'adopted');
    const evidenceIds = [...new Set((round1.attribution?.evolutionEvidenceRefs || []).map((item) => item.sourceId || item.evidenceId || '').filter(Boolean))];
    const row = {
      method, seed, namespace,
      round1: { success: Boolean(round1Official?.success || round1Episode.metrics?.projectSuccess), officialEvaluation: round1Official, metrics: round1Episode.metrics },
      update: { updates: round1UpdateRows, routed: round1.routed, evidenceIds, adoptionStatus: adopted.map((item) => ({ scope: item.scope, status: item.adoptionStatus, versionId: item.candidate?.policyVersionId || item.candidate?.candidateVersion || '' })) },
      round2: { success: Boolean(round2Official?.success || round2Episode.metrics?.projectSuccess), officialEvaluation: round2Official, metrics: round2Episode.metrics },
      rollback: finalized.rollback,
      policyVersionRound1: round1.baseline?.policyVersionId || 'org-policy-baseline-v1',
      policyVersionRound2: round2Episode.policyVersionId || round1.activePolicy?.policyVersionId || 'org-policy-baseline-v1',
      skillVersionRound1: round1.baseline?.agents?.map((item) => ({ agentInstanceId: item.agentInstanceId, version: item.activeSkillVersion })) || [],
      skillVersionRound2: evolutionContext?.agentVersions || {},
      memoryVersionRound1: round1.baseline?.agents?.map((item) => ({ agentInstanceId: item.agentInstanceId, version: item.memoryVersion })) || [],
      memoryVersionRound2: evolutionContext?.memoryVersions || {},
      selectedRecipientRound1: round1Episode.selections?.map((item) => item.ubuddyId).filter(Boolean) || [],
      selectedRecipientRound2: round2Episode.selections?.map((item) => item.ubuddyId).filter(Boolean) || [],
      selectedAgentRound1: round1Episode.executions?.map((item) => item.agentInstanceId).filter(Boolean) || [],
      selectedAgentRound2: round2Episode.executions?.map((item) => item.agentInstanceId).filter(Boolean) || [],
      negativeTransfer: Boolean(finalized.rollback?.triggered),
      rollbackTriggered: Boolean(finalized.rollback?.triggered),
      rollbackRecovered: Boolean(finalized.rollback?.recovered),
    };
    await writeJson(path.join(pairDir, 'pair_metrics.json'), { ...row, round1Success: row.round1.success, round2Success: row.round2.success });
    await writeJson(path.join(pairDir, 'verification.json'), { officialEvaluatorPresent: Boolean(round1Official && round2Official), evidenceIds, adoptedScopes: adopted.map((item) => item.scope), policyRulesAppliedRound2: round2Episode.policyRulesApplied || [], independentMetricRecompute: { round1: round1Episode.metrics, round2: round2Episode.metrics } });
    rows.push(row);
  }
  const resultEligible = real && rows.length > 0 && rows.every((row) => row.round1.officialEvaluation && row.round2.officialEvaluation && row.update.evidenceIds.length > 0);
  await writeJson(path.join(dir, 'evolution_updates.json'), { benchmark: BENCHMARK_VERSION, realAppworld: real, methods, seeds, rows, resultEligible });
  await writeJson(path.join(dir, 'config.json'), { benchmark: BENCHMARK_VERSION, command: 'evolution', realAppworld: real, methods, seeds, pairCount: rows.length });
  console.log(JSON.stringify({ runDir: dir, pairCount: rows.length, realAppworld: real, resultEligible }, null, 2));
}
async function swebench() { const dir = runDir(`orgbench-swebench-${Date.now()}`); await writeJson(path.join(dir, 'swebench-plan.json'), { adapter: swebenchAdapter(), resultEligible: false, note: 'Deferred until AppWorld and TheAgentCompany main protocol passes.' }); console.log(JSON.stringify({ runDir: dir, deferred: true }, null, 2)); }
async function verify() {
  const dir = path.resolve(String(args.runDir || args._[1] || '')); if (!dir) throw new Error('run_dir_required');
  const episodesFile = await exists(path.join(dir, 'episodes.jsonl')) ? path.join(dir, 'episodes.jsonl') : path.join(dir, 'episodes.json');
  const raw = await fs.readFile(episodesFile, 'utf8'); const rows = episodesFile.endsWith('.jsonl') ? raw.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : JSON.parse(raw);
  const noPrivateLeak = rows.every((row) => !JSON.stringify(row).includes('private-memory-') && !JSON.stringify(row).includes('privateMemory'));
  const eventContractsValid = rows.every((row) => row.episodeId && row.method && row.graph?.nodes && row.graph?.edges && row.events.every((event) => typeof event.eventKind === 'string') && row.events.every((event) => !event.metadata?.privateLeak));
  const hasOfficialEvaluation = rows.some((row) => row.officialEvaluation) || await exists(path.join(dir, 'official_evaluation.json'));
  const batchArtifactCompleteness = hasOfficialEvaluation && rows.every((row) => row.officialEvaluation && row.metrics && row.events && row.graph);
  const artifactNames = ['config.json', 'metrics.json']; const artifactCompleteness = hasOfficialEvaluation ? ((await Promise.all(artifactNames.map((name) => exists(path.join(dir, name)))).then((values) => values.every(Boolean))) && (batchArtifactCompleteness || (await exists(path.join(dir, 'official_evaluation.json')) && await exists(path.join(dir, 'organization_evaluation.json'))))) : true;
  const valid = rows.length > 0 && noPrivateLeak && eventContractsValid && artifactCompleteness;
  const independent = await independentlyVerify(dir).catch((error) => ({ valid: false, error: error.message }));
  const finalValid = valid && independent.valid;
  await writeJson(path.join(dir, 'verification.json'), { valid: finalValid, episodeCount: rows.length, noPrivateLeak, eventContractsValid, artifactCompleteness, hasOfficialEvaluation, independentMetricRecompute: aggregateMetrics(rows.map((row) => row.metrics || {})), independentVerifier: independent });
  console.log(JSON.stringify({ valid: finalValid, episodeCount: rows.length, noPrivateLeak, eventContractsValid, artifactCompleteness, independentVerifier: independent.valid }, null, 2)); process.exitCode = finalValid ? 0 : 1;
}
async function report() {
  const dir = path.resolve(String(args.runDir || args._[1] || '')); const metrics = await readJson(path.join(dir, 'metrics.json')); const config = await readJson(path.join(dir, 'config.json')).catch(() => ({})); const verification = await readJson(path.join(dir, 'verification.json')).catch(() => null); const official = await readJson(path.join(dir, 'official_evaluation.json')).catch(() => null);
  const methodRows = Object.entries(metrics.byMethod || {}).map(([method, row]) => { const checkpointRate = row.meanOfficialCheckpointRate ?? (official && Object.keys(metrics.byMethod || {}).length === 1 ? official.passCount / Math.max(1, official.totalCount) : null); return `| ${method} | ${row.n} | ${(100 * (row.projectSuccessRate || 0)).toFixed(1)}% | ${checkpointRate == null ? 'n/a' : `${(100 * checkpointRate).toFixed(1)}%`} | ${row.meanInternalAllocationRegret == null ? 'n/a' : row.meanInternalAllocationRegret.toFixed(3)} |`; }).join('\n');
  const reportText = `# uBuddy-AppWorld Hybrid Benchmark v2 实验报告\n\n## 实验目的\n\n验证双层 uBuddy 组织协议能否在不预设人员分工和任务树的条件下，完成候选选择、跨人委派、recipient 二次拆解、内部 Agent 执行、共享状态更新、故障恢复和官方验收。\n\n## 实验条件\n\n- benchmark: ${config.adapter || config.benchmark || BENCHMARK_VERSION}\n- protocol: BENCHMARK_PROTOCOL.md\n- mode: ${config.mode || 'protocol'}\n- episodes: ${metrics.episodeCount ?? metrics.traceCount ?? 'n/a'}\n- task: ${config.taskId || 'multiple'}\n- method: ${config.method || 'multiple'}\n- seed: ${config.seed || 'multiple'}\n- official evaluator: ${official ? 'yes' : 'no'}\n\n## 打分机制\n\nAppWorld 官方 evaluator 负责外部任务结果；Janus 状态图和事件链负责八个过程维度。两类分数分开呈现，不定义掩盖失败类型的总分。\n\n## 结果\n\n| 方法 | N | 完整成功率 | 官方 checkpoint rate | 内部分配 regret |\n|---|---:|---:|---:|---:|\n${methodRows || '| n/a | 0 | n/a | n/a | n/a |'}\n\n${official ? `本次官方 evaluator：${official.passCount}/${official.totalCount} checkpoints，通过率 ${official.passPercentage}%，完整成功=${official.success}。` : '本 run 没有官方 evaluator，只能作为协议测试。'}\n\n## 完整性和边界\n\n- artifact verification: ${verification?.valid ?? 'not run'}\n- private leak: ${verification ? !verification.noPrivateLeak : 'not checked'}\n- protocolOnly: ${official ? 'false' : 'true'}\n- attribution/evolution claim eligible: false，需完成带 gold 的归因实验和第二轮迁移实验。\n\n## 结论\n\n${official ? '真实 AppWorld 执行与官方评分链路已经建立；单个 canary 只证明工程链路，不证明 M3 优于对照方法。' : '当前仅证明协议和 artifact 契约可运行，不能报告任务效果。'}\n`;
  await fs.writeFile(path.join(dir, 'report.md'), reportText, 'utf8'); console.log(JSON.stringify({ report: path.join(dir, 'report.md') }, null, 2));
}
async function packageCommand() { const manifestFile = path.join(ORG_ROOT, 'orgbench.manifest.json'); if (!(await exists(manifestFile))) await manifest(); const files = ['schema.mjs', 'orgbench_experiment.mjs', 'core/random.mjs', 'core/stateGraph.mjs', 'core/scenario.mjs', 'core/policy.mjs', 'core/modelPolicy.mjs', 'core/janusClient.mjs', 'core/evolutionCoordinator.mjs', 'core/benchmarkProtocol.mjs', 'core/faultInjection.mjs', 'evaluators/metrics.mjs', 'evaluators/eightDimensions.mjs', 'evaluators/independentVerifier.mjs', 'adapters/appworld.mjs', 'adapters/theagentcompany.mjs', 'adapters/marble.mjs', 'adapters/who_when.mjs', 'adapters/swebench.mjs', 'schemas/task-gold.schema.json', 'schemas/fault-manifest.schema.json', 'schemas/attribution-gold.schema.json', 'schemas/run-config.schema.json', 'BENCHMARK_PROTOCOL.md', 'REMOTE_RUNBOOK_CN.md', 'task_protocol.manifest.json', 'transfer_pairs.manifest.json', 'fault_manifest.example.json', 'benchmark.config.example.json', 'orgbench.manifest.json', 'experiment_plan.json']; const output = path.join(ROOT, 'outputs', 'ubuddy-orgbench-v2-package.json'); await writeJson(output, { benchmark: BENCHMARK_VERSION, sourceRoot: ORG_ROOT, files, note: 'Use the Janus repository package for source distribution; this JSON is a manifest and contains no secrets or run outputs.' }); console.log(JSON.stringify({ manifest: output, fileCount: files.length }, null, 2)); }

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    if (command === 'doctor') await doctor(); else if (command === 'prepare') await prepare(); else if (command === 'manifest') await manifest(); else if (command === 'canary') await canary(); else if (command === 'pilot') await pilot(); else if (command === 'main') await main(); else if (command === 'attribution') await attribution(); else if (command === 'evolution') await evolution(); else if (command === 'swebench') await swebench(); else if (command === 'verify') await verify(); else if (command === 'report') await report(); else if (command === 'package') await packageCommand(); else help();
  } catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
}
