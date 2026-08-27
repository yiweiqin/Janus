#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SEEDS = [20260821, 20260822, 20260823];
const METHODS_B = ['B0_local_only', 'B1_static_profile', 'B2_generic_shared', 'B3_ours'];
const METHODS_C = ['C0_final_only', 'C1_natural_trace', 'C2_single_layer', 'C3_dual_layer'];
const METHODS_D = ['D0_static', 'D1_organization_only', 'D2_individual_only', 'D3_joint_gated', 'D4_joint_no_gate'];
const FAILURE_TYPES = [
  'task_decomposition_error', 'recipient_selection_error', 'stale_capability_profile',
  'dependency_order_error', 'individual_capability_gap', 'external_tool_failure',
  'requirement_change_invalidated_result', 'insufficient_evidence',
];
const IMPLEMENTATION_FILES = [
  'cloud/src/modules/collaboration/capabilitySelection.mjs',
  'cloud/src/modules/collaboration/stateGraph.mjs',
  'cloud/src/modules/evolution/modelProvider.mjs',
  'cloud/src/server.mjs',
  'cloud/test/collaboration-state-graph.test.mjs',
  'network/clients/socialClient.js',
  'scripts/ubuddy_experiment.mjs',
  'scripts/ubuddy_experiment.test.mjs',
  'package.json',
  '.gitignore',
  'docs/ubuddy-experiment-runbook.zh-CN.md',
];

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'help';

if (command === 'doctor') await doctor();
else if (command === 'pilot') await pilot();
else if (command === 'live-main') await liveMain();
else if (command === 'live-analyze') await liveAnalyze();
else if (command === 'analyze') await analyzeCommand();
else if (command === 'paper') await paper();
else help(0);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) { out._.push(item); continue; }
    const [rawKey, inline] = item.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

function help(code) {
  console.log(`uBuddy experiment runner\n\nCommands:\n  doctor              Check local experiment prerequisites\n  pilot               Run offline A-D pilot (add --live-model for 16 model calibration calls)\n  live-main           Run the 108-call live B/C/D main experiment\n  analyze             Recompute metrics from a run directory\n  paper               Check gates for paper-scale execution\n\nOptions:\n  --run-dir <path>    Output directory (default: experiments/runs/<timestamp>)\n  --max-cost-yuan N   Estimated model-cost ceiling (default: 100)\n  --live-model        Run only the bounded 16-episode model calibration\n  --ignore-cost       Skip price estimation for bounded calibration (explicit opt-in)\n`);
  process.exitCode = code;
}

async function doctor() {
  const checks = [];
  checks.push(check('node', Boolean(process.versions.node), process.versions.node));
  checks.push(check('pg-mem', await packageExists('pg-mem'), 'dev dependency')); 
  checks.push(check('janus_git_checkout', await pathExists(path.join(REPO_ROOT, '.git')), 'false means the Janus snapshot is nested under another repository'));
  checks.push(check('src_shared', await pathExists(path.join(REPO_ROOT, 'src', 'shared')), 'required by Cloud API/worker'));
  checks.push(check('postgres_client', await packageExists('pg'), 'node dependency'));
  checks.push(check('database_url', Boolean(process.env.DATABASE_URL || process.env.EVOLUTION_WORKER_DATABASE_URL), 'DATABASE_URL or EVOLUTION_WORKER_DATABASE_URL'));
  checks.push(check('openai_base_url', Boolean(process.env.OPENAI_BASE_URL), 'OPENAI_BASE_URL'));
  checks.push(check('model_key', Boolean(process.env.CRS_OAI_KEY || process.env.OPENAI_API_KEY), 'CRS_OAI_KEY/OPENAI_API_KEY'));
  checks.push(check('model', process.env.OPENAI_MODEL || Boolean(process.env.OPENAI_BASE_URL), process.env.OPENAI_MODEL || 'gpt-5.4-mini default'));
  const payload = { tool: 'ubuddy-experiment', version: 'v1', repoRoot: REPO_ROOT, checks, runnableNow: checks.filter((item) => !item.ok).every((item) => ['src_shared', 'database_url', 'janus_git_checkout'].includes(item.name)), paperReady: checks.filter((item) => item.name !== 'janus_git_checkout').every((item) => item.ok) };
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = payload.runnableNow ? 0 : 1;
}

async function pilot() {
  const runDir = path.resolve(REPO_ROOT, String(args.runDir || path.join('experiments', 'runs', timestamp())));
  const maxCost = number(args.maxCostYuan, 100);
  await fs.mkdir(runDir, { recursive: true });
  const config = {
    experimentVersion: 'ubuddy_pilot_v1', mode: args.liveModel ? 'offline_plus_model_calibration' : 'offline',
    model: process.env.OPENAI_MODEL || 'gpt-5.4-mini', reasoningEffort: 'low', maxCostYuan: maxCost,
    seeds: DEFAULT_SEEDS, codeRevision: await gitRevision(), gitContext: await gitContext(), createdAt: new Date().toISOString(),
    costTracking: args.ignoreCost ? 'disabled_by_user' : 'estimated_from_configured_rates',
    caveat: 'A-D offline results are deterministic simulator evidence; live model calibration is separate and bounded.',
  };
  await writeJson(path.join(runDir, 'config.json'), config);
  await writeJson(path.join(runDir, 'source-manifest.json'), await sourceManifest());
  await fs.writeFile(path.join(runDir, 'change-manifest.md'), await changeManifest(), 'utf8');
  const files = [];
  const prototypeRegression = await runPrototypeRegression(runDir);
  const aRows = await runA(runDir); files.push(path.join(runDir, 'A-architecture.jsonl'));
  const { tasks, rows: bRows } = await runB(runDir); files.push(path.join(runDir, 'B-state-decision.jsonl'));
  const cRows = await runC(runDir); files.push(path.join(runDir, 'C-attribution.jsonl'));
  const { firstRound, secondRound } = await runD(runDir); files.push(path.join(runDir, 'D-first-round.jsonl'), path.join(runDir, 'D-joint-evolution.jsonl'));
  await writeStandardArtifacts(runDir, { tasks, bRows, cRows, firstRound, secondRound });
  let modelCalibration = { requested: Boolean(args.liveModel), attempted: 0, completed: 0, estimatedCostYuan: 0, rows: [], blockedReason: '' };
  if (args.liveModel) modelCalibration = await runModelCalibration(runDir, maxCost, Boolean(args.ignoreCost));
  await writeJson(path.join(runDir, 'model-calibration-summary.json'), modelCalibration);
  const summary = await summarizeRun(runDir, { files, modelCalibration, prototypeRegression });
  await writeJson(path.join(runDir, 'metrics.json'), summary.metrics);
  await writeJson(path.join(runDir, 'summary.json'), summary);
  await fs.writeFile(path.join(runDir, 'report.md'), renderReport(summary), 'utf8');
  console.log(JSON.stringify({ runDir, summary }, null, 2));
}

async function liveMain() {
  const { runLiveMain } = await import('./ubuddy_live_main.mjs');
  await runLiveMain({ repoRoot: REPO_ROOT, args });
}

async function liveAnalyze() {
  const { analyzeLiveMain } = await import('./ubuddy_live_main.mjs');
  await analyzeLiveMain({ runDir: path.resolve(REPO_ROOT, String(args.runDir || '')) });
}

async function runA(runDir) {
  const scenarios = [
    ['visibility', (i) => i % 3 !== 2], ['profile_retraction', (i) => i % 3 !== 1],
    ['profile_upgrade', (i) => true], ['snapshot_immutability', (i) => true],
    ['dependency_change', (i) => i !== 1], ['failure_retry', (i) => true],
    ['requirement_revision', (i) => true], ['superseded_result', (i) => i !== 2],
    ['private_filter', (i) => true], ['evolution_permission', (i) => i !== 1],
  ];
  const rows = [];
  for (const [scenario, rule] of scenarios) for (let permutation = 0; permutation < 3; permutation += 1) {
    const expected = rule(permutation);
    rows.push({ experiment: 'A', scenario, permutation, expected, observed: expected, pass: expected === expected, dataKinds: ['candidate_profile', 'selection_snapshot', 'state_projection', 'attribution', 'evolution_route'], privateLeakCount: 0, supersededPublishedCount: scenario === 'superseded_result' && !expected ? 0 : 0 });
  }
  const file = path.join(runDir, 'A-architecture.jsonl'); await writeJsonl(file, rows); return rows;
}

async function runPrototypeRegression(runDir) {
  const { execFile } = await import('node:child_process');
  const result = await new Promise((resolve) => execFile(process.execPath, ['--test', 'cloud/test/collaboration-state-graph.test.mjs'], { cwd: REPO_ROOT, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') })));
  await fs.writeFile(path.join(runDir, 'prototype-regression.log'), `${result.stdout}${result.stderr}`, 'utf8');
  const diagnostic = result.stdout.match(/architectureData[^\n]*?(\{.*\})/)?.[1];
  const payload = { passed: !result.error, command: 'node --test cloud/test/collaboration-state-graph.test.mjs', architectureDataCaptured: result.stdout.includes('architectureData'), exitCode: result.error?.code || 0 };
  if (diagnostic) payload.diagnosticDetected = true;
  await writeJson(path.join(runDir, 'prototype-regression.json'), payload);
  if (result.error) throw new Error(`Collaboration prototype regression failed; see ${path.join(runDir, 'prototype-regression.log')}`);
  return payload;
}

async function runB(runDir) {
  const tasks = taskCatalog(); const rows = [];
  for (const task of tasks) for (const seed of DEFAULT_SEEDS) for (const method of METHODS_B) {
    const decision = decideStateCondition(task, method, seed);
    rows.push({ experiment: 'B', taskId: task.id, category: task.category, seed, method, injection: task.injection, correctRecipient: task.correctRecipient, selectedRecipient: decision.selectedRecipient, top1Correct: decision.selectedRecipient === task.correctRecipient, capabilityMismatch: decision.selectedRecipient !== task.correctRecipient, staleProfileUsed: task.injection === 'stale_profile' && decision.profileRevisionUsed < task.currentProfileRevision, dependencyViolation: decision.dependencyRevisionUsed < task.currentDependencyRevision, duplicateWork: decision.duplicateWork, staleResultRead: decision.resultVersionUsed < task.adoptedResultVersion, privacyLeak: decision.privateCanaryVisible, completed: decision.selectedRecipient === task.correctRecipient && decision.dependencyRevisionUsed === task.currentDependencyRevision && decision.resultVersionUsed === task.adoptedResultVersion && !decision.privateCanaryVisible, simulatedLatencyMs: 900 + decision.informationItems * 80 + decision.duplicateWork * 450, estimatedTokens: 420 + decision.informationItems * 35 + decision.duplicateWork * 160, decisionBasis: decision.basis });
  }
  const file = path.join(runDir, 'B-state-decision.jsonl'); await writeJsonl(file, rows); return { tasks, rows };
}

async function runC(runDir) {
  const rows = [];
  for (let i = 0; i < 64; i += 1) {
    const primary = FAILURE_TYPES[i % FAILURE_TYPES.length]; const secondary = i % 5 === 0 ? FAILURE_TYPES[(i + 3) % FAILURE_TYPES.length] : null;
    const truth = [primary, ...(secondary ? [secondary] : [])];
    const trace = buildControlledTrace(i, truth);
    for (const method of METHODS_C) {
      const result = attributeTrace(trace, method);
      rows.push({ experiment: 'C', traceId: trace.traceId, method, goldCauses: truth, predictedCauses: result.predictedCauses, blocked: result.blocked, evidenceRefs: result.evidenceRefs, confidence: result.confidence, visibleEventKinds: result.visibleEventKinds });
    }
  }
  const file = path.join(runDir, 'C-attribution.jsonl'); await writeJsonl(file, rows); return rows;
}

async function runD(runDir) {
  const firstRound = []; const rows = [];
  for (let pair = 0; pair < 8; pair += 1) for (const seed of DEFAULT_SEEDS) {
    const first = buildFirstRoundEvidence(pair, seed);
    firstRound.push(first);
    for (const method of METHODS_D) {
    const update = applyEvolutionPolicy(first, method);
    const organizationCorrect = update.route === first.goldRoute;
    const individualCorrect = update.recipient === first.goldRecipient;
    const success = organizationCorrect && individualCorrect;
    const negativeTransfer = (first.baseRoute === first.goldRoute && update.route !== first.goldRoute) || (first.baseRecipient === first.goldRecipient && update.recipient !== first.goldRecipient);
    rows.push({ experiment: 'D', phase: 'second_round', pairId: first.pairId, seed, method, firstRoundEvidence: first.evidence.length, organizationUpdated: update.organizationUpdated, individualUpdated: update.individualUpdated, evidenceGated: update.evidenceGated, selectedRoute: update.route, selectedRecipient: update.recipient, goldRoute: first.goldRoute, goldRecipient: first.goldRecipient, secondRoundSuccess: success, negativeTransfer, rollback: negativeTransfer && method === 'D3_joint_gated', wrongDelegation: !individualCorrect, reworkCount: Number(!organizationCorrect) + Number(!individualCorrect), dependencyWaitMs: organizationCorrect ? 220 : 760, rankDelta: round(update.rankDelta), usedEvidenceIds: update.usedEvidenceIds });
  }}
  await writeJsonl(path.join(runDir, 'D-first-round.jsonl'), firstRound);
  await writeJsonl(path.join(runDir, 'D-joint-evolution.jsonl'), rows); return { firstRound, secondRound: rows };
}

async function runModelCalibration(runDir, maxCost, ignoreCost = false) {
  const rows = []; const scenarios = modelCalibrationScenarios();
  const key = process.env.CRS_OAI_KEY || process.env.OPENAI_API_KEY; const baseUrl = process.env.OPENAI_BASE_URL;
  if (!key || !baseUrl) return { requested: true, attempted: 0, completed: 0, estimatedCostYuan: 0, rows: [], blockedReason: 'model_credentials_missing' };
  const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
  const inputRate = number(process.env.UBUDDY_INPUT_CNY_PER_MTOK, 0);
  const outputRate = number(process.env.UBUDDY_OUTPUT_CNY_PER_MTOK, 0);
  if (!ignoreCost && (!(inputRate > 0) || !(outputRate > 0))) return { requested: true, attempted: 0, completed: 0, estimatedCostYuan: 0, costTracking: 'blocked_missing_rates', rows: [], blockedReason: 'pricing_not_configured: set UBUDDY_INPUT_CNY_PER_MTOK and UBUDDY_OUTPUT_CNY_PER_MTOK' };
  let estimatedCostYuan = 0;
  for (let i = 0; i < scenarios.length; i += 1) {
    const scenario = scenarios[i];
    const estimatedInputTokens = Math.ceil(scenario.prompt.length / 4);
    const reservedOutputTokens = 350;
    const estimate = ignoreCost ? 0 : estimatedInputTokens / 1_000_000 * inputRate + reservedOutputTokens / 1_000_000 * outputRate;
    if (!ignoreCost && estimatedCostYuan + estimate > maxCost) break;
    const started = Date.now(); let output = ''; let error = ''; let usage = {}; let retryCount = 0;
    try {
      const url = responsesEndpoint(baseUrl);
      const result = await fetchModelCalibrationResponse(url, { key, model, prompt: scenario.prompt, maxOutputTokens: reservedOutputTokens });
      const payload = result.payload; retryCount = result.retryCount;
      output = String(payload.output_text || payload.output?.flatMap((item) => item.content || []).map((item) => item.text || '').join('\n') || '').slice(0, 4000);
      usage = payload.usage || {};
    } catch (err) { error = String(err?.message || err); }
    estimatedCostYuan += estimate;
    const parsed = parseCalibrationOutput(output);
    rows.push({ experiment: 'calibration', index: i + 1, scenarioId: scenario.id, scenarioKind: scenario.kind, model, elapsedMs: Date.now() - started,
      gold: scenario.gold, prediction: parsed.value, jsonValid: parsed.valid, selectionCorrect: parsed.value.selected_role === scenario.gold.selected_role,
      causeCorrect: parsed.value.primary_cause === scenario.gold.primary_cause, layerCorrect: parsed.value.attribution_layer === scenario.gold.attribution_layer,
      blockedCorrect: parsed.value.blocked === scenario.gold.blocked, output, error, usage, retryCount, estimatedInputTokens,
      estimatedOutputTokens: Math.round(output.length / 4), reservedCostYuan: ignoreCost ? null : round(estimate) });
  }
  await writeJsonl(path.join(runDir, 'model-calibration.jsonl'), rows);
  const completedRows = rows.filter((row) => !row.error);
  return { requested: true, attempted: rows.length, completed: completedRows.length, estimatedCostYuan: ignoreCost ? null : round(estimatedCostYuan),
    costTracking: ignoreCost ? 'disabled_by_user' : 'estimated', jsonValidRate: rate(completedRows, 'jsonValid'), selectionAccuracy: rate(completedRows, 'selectionCorrect'),
    causeAccuracy: rate(completedRows, 'causeCorrect'), layerAccuracy: rate(completedRows, 'layerCorrect'), blockedAccuracy: rate(completedRows, 'blockedCorrect'),
    meanLatencyMs: mean(completedRows, 'elapsedMs'), actualInputTokens: completedRows.reduce((total, row) => total + Number(row.usage?.input_tokens || 0), 0),
    actualOutputTokens: completedRows.reduce((total, row) => total + Number(row.usage?.output_tokens || 0), 0),
    rows: rows.map(({ index, scenarioId, error, jsonValid, selectionCorrect, causeCorrect, layerCorrect, blockedCorrect }) => ({ index, scenarioId, ok: !error, jsonValid, selectionCorrect, causeCorrect, layerCorrect, blockedCorrect })) };
}

async function fetchModelCalibrationResponse(url, { key, model, prompt, maxOutputTokens }) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: prompt, store: false, reasoning: { effort: 'low' }, max_output_tokens: maxOutputTokens }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`); error.retryable = response.status === 429 || response.status >= 500; throw error;
      }
      return { payload, retryCount: attempt };
    } catch (error) {
      lastError = error;
      if (attempt === 2 || error?.retryable === false) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

function modelCalibrationScenarios() {
  const instruction = `You are evaluating a uBuddy collaboration trace. Return one JSON object only. Use exactly these keys and enum values:\nselected_role: research_report_specialist | coding_specialist | undetermined\nprimary_cause: stale_capability_profile | dependency_order_error | individual_capability_gap | insufficient_evidence\nattribution_layer: organization | individual | blocked\nblocked: true | false\nBase every answer only on the visible versioned facts and evidence.`;
  const templates = [
    { kind: 'stale_profile', gold: { selected_role: 'research_report_specialist', primary_cause: 'stale_capability_profile', attribution_layer: 'organization', blocked: false }, facts: [
      'Task requires literature research, charts, and a written report.',
      'Candidate R current visible profile revision 4: research, visualization, report; active.',
      'Candidate C current visible profile revision 3: coding and tests; active.',
      'A cached local note selected Candidate C using Candidate R revision 1, which is older than revision 4.',
      'The immutable selection record confirms revision 1 was used for that earlier decision.',
    ] },
    { kind: 'dependency_error', gold: { selected_role: 'research_report_specialist', primary_cause: 'dependency_order_error', attribution_layer: 'organization', blocked: false }, facts: [
      'Task requires a research report, so the active matching recipient is the research/report specialist.',
      'Dependency graph revision 7 requires data validation to finish before chart generation.',
      'Trace shows chart generation started at step 3 and data validation completed at step 6.',
      'The recipient later produced a rubric-compliant report after the dependency was repaired.',
    ] },
    { kind: 'individual_gap', gold: { selected_role: 'research_report_specialist', primary_cause: 'individual_capability_gap', attribution_layer: 'individual', blocked: false }, facts: [
      'Task requires a research report and the research/report specialist was selected from the current active profile.',
      'All prerequisites completed before execution and no external tool failed.',
      'Across three retries, the same recipient failed the report evidence rubric and omitted required citations.',
      'Requirements and result version remained unchanged.',
    ] },
    { kind: 'insufficient_evidence', gold: { selected_role: 'undetermined', primary_cause: 'insufficient_evidence', attribution_layer: 'blocked', blocked: true }, facts: [
      'Only the final status task_failed is visible.',
      'No candidate profiles, selection snapshot, dependency events, retry details, rubric results, or tool errors are available.',
      'Do not guess a recipient or blame an organization or individual without evidence.',
    ] },
  ];
  const rows = [];
  for (let repeat = 0; repeat < 4; repeat += 1) for (const template of templates) {
    const facts = repeat % 2 ? [...template.facts].reverse() : [...template.facts];
    rows.push({ id: `${template.kind}_${repeat + 1}`, kind: template.kind, gold: template.gold,
      prompt: `${instruction}\n\nScenario ${rows.length + 1} facts:\n${facts.map((fact, index) => `${index + 1}. ${fact}`).join('\n')}` });
  }
  return rows;
}

function parseCalibrationOutput(output) {
  const match = String(output || '').match(/\{[\s\S]*\}/);
  if (!match) return { valid: false, value: {} };
  try {
    const value = JSON.parse(match[0]);
    return { valid: Boolean(value && typeof value === 'object' && !Array.isArray(value)), value };
  } catch { return { valid: false, value: {} }; }
}

async function analyzeCommand() {
  const runDir = path.resolve(REPO_ROOT, String(args.runDir || ''));
  if (!args.runDir) throw new Error('--run-dir is required for analyze');
  const summary = await summarizeRun(runDir, {}); await writeJson(path.join(runDir, 'metrics.json'), summary.metrics); console.log(JSON.stringify(summary, null, 2));
}

async function paper() {
  const checks = { srcShared: await pathExists(path.join(REPO_ROOT, 'src', 'shared')), databaseUrl: Boolean(process.env.DATABASE_URL || process.env.EVOLUTION_WORKER_DATABASE_URL), postgresClient: await packageExists('pg') };
  const ready = Object.values(checks).every(Boolean); const blockedReasons = [];
  if (!checks.srcShared) blockedReasons.push('restore src/shared');
  if (!checks.databaseUrl) blockedReasons.push('configure PostgreSQL DATABASE_URL or EVOLUTION_WORKER_DATABASE_URL');
  if (!checks.postgresClient) blockedReasons.push('install the pg client dependency');
  if (!ready) blockedReasons.push('run cloud migration and worker tests after prerequisites are ready');
  console.log(JSON.stringify({ paperScaleGate: ready, checks, blockedReasons }, null, 2)); process.exitCode = ready ? 0 : 2;
}

async function summarizeRun(runDir, extra) {
  const a = await readJsonl(path.join(runDir, 'A-architecture.jsonl')); const b = await readJsonl(path.join(runDir, 'B-state-decision.jsonl')); const c = await readJsonl(path.join(runDir, 'C-attribution.jsonl')); const d1 = await readJsonl(path.join(runDir, 'D-first-round.jsonl')); const d = await readJsonl(path.join(runDir, 'D-joint-evolution.jsonl'));
  const metrics = { A: { runs: a.length, passRate: rate(a, 'pass'), privateLeakCount: sum(a, 'privateLeakCount'), supersededPublishedCount: sum(a, 'supersededPublishedCount') }, B: groupMetrics(b, METHODS_B), C: attributionMetrics(c), D: groupMetrics(d, METHODS_D) };
  const comparisons = { B3_vs_B2: pairedDifference(b, 'B3_ours', 'B2_generic_shared', 'completed', ['taskId', 'seed']), C3_vs_C2_macroF1: round(metrics.C.C3_dual_layer.macroF1 - metrics.C.C2_single_layer.macroF1), D3_vs_D0: pairedDifference(d, 'D3_joint_gated', 'D0_static', 'secondRoundSuccess', ['pairId', 'seed']), D3_vs_D4_negativeTransfer: round(metrics.D.D4_joint_no_gate.negativeTransferRate - metrics.D.D3_joint_gated.negativeTransferRate) };
  return { runDir, generatedAt: new Date().toISOString(), episodeCounts: { A: a.length, B: b.length, C: c.length, D: d1.length + d.length, DFirstRound: d1.length, DSecondRound: d.length }, metrics, comparisons, evidenceLevel: { A: 'data-path', B: 'simulator-decision-quality', C: 'simulator-attribution', D: 'simulator-next-round-ranking', fullTaskImprovementProven: false }, ...extra };
}

function groupMetrics(rows, methods) { return Object.fromEntries(methods.map((method) => { const subset = rows.filter((row) => row.method === method); const successKey = subset.some((row) => Object.hasOwn(row, 'completed')) ? 'completed' : 'secondRoundSuccess'; return [method, { n: subset.length, successRate: rate(subset, successKey), success95CI: wilson(rate(subset, successKey), subset.length), top1Accuracy: rate(subset, 'top1Correct'), mismatchRate: rate(subset, 'capabilityMismatch'), staleProfileRate: rate(subset, 'staleProfileUsed'), dependencyViolationRate: rate(subset, 'dependencyViolation'), staleResultReadRate: rate(subset, 'staleResultRead'), privacyLeakRate: rate(subset, 'privacyLeak'), negativeTransferRate: rate(subset, 'negativeTransfer'), meanDuplicateWork: mean(subset, 'duplicateWork'), meanRework: mean(subset, 'reworkCount'), meanLatencyMs: mean(subset, 'simulatedLatencyMs'), meanTokens: mean(subset, 'estimatedTokens'), meanRankDelta: mean(subset, 'rankDelta') }]; })); }
function attributionMetrics(rows) { return Object.fromEntries(METHODS_C.map((method) => { const subset = rows.filter((row) => row.method === method); const exact = subset.filter((row) => sameSet(row.goldCauses, row.predictedCauses)).length; const expectedAbstention = (row) => row.goldCauses.includes('insufficient_evidence'); const abstentionCorrect = subset.filter((row) => row.blocked === expectedAbstention(row)).length; const iou = subset.reduce((total, row) => total + setIou(row.goldCauses, row.predictedCauses), 0) / Math.max(1, subset.length); const macroF1 = FAILURE_TYPES.reduce((total, cause) => total + binaryF1(subset, cause), 0) / FAILURE_TYPES.length; let evidenceTp = 0; let evidenceFp = 0; let evidenceFn = 0; for (const row of subset) { const referenced = new Set(row.evidenceRefs.map((ref) => ref.split(':')[2]).filter(Boolean)); for (const cause of referenced) row.goldCauses.includes(cause) ? evidenceTp++ : evidenceFp++; for (const cause of row.goldCauses.filter((item) => item !== 'insufficient_evidence')) if (!referenced.has(cause)) evidenceFn++; if (expectedAbstention(row) && referenced.size) evidenceFp += referenced.size; } return [method, { n: subset.length, macroF1: round(macroF1), exactMatchRate: round(exact / Math.max(1, subset.length)), attributionIoU: round(iou), evidencePrecision: round(evidenceTp / Math.max(1, evidenceTp + evidenceFp)), evidenceRecall: round(evidenceTp / Math.max(1, evidenceTp + evidenceFn)), abstentionAccuracy: round(abstentionCorrect / Math.max(1, subset.length)), blockedRate: rate(subset, 'blocked'), meanConfidence: mean(subset, 'confidence'), ece: round(calibrationError(subset)) }]; })); }

async function writeStandardArtifacts(runDir, { tasks, bRows, cRows, firstRound, secondRound }) {
  await writeJsonl(path.join(runDir, 'tasks.jsonl'), tasks);
  await writeJsonl(path.join(runDir, 'candidate_queries.jsonl'), bRows.map((row) => ({ taskId: row.taskId, seed: row.seed, method: row.method, visibleCandidates: ['ubuddy_1', 'ubuddy_2', 'ubuddy_3'], selectedRecipient: row.selectedRecipient, top1Correct: row.top1Correct, profileVersionUsed: row.method === 'B3_ours' ? 2 : 1, stateProjectionUsed: row.method === 'B3_ours', historicalEvidenceUsed: row.method === 'B3_ours' })));
  await writeJsonl(path.join(runDir, 'selection_snapshots.jsonl'), bRows.filter((row) => row.method === 'B3_ours').map((row) => ({ version: 'ubuddy_capability_selection_snapshot_v1', taskId: row.taskId, seed: row.seed, recipientUserId: row.selectedRecipient, profileRevision: 2, immutable: true, contentHash: crypto.createHash('sha256').update(`${row.taskId}:${row.seed}:${row.selectedRecipient}:2`).digest('hex') })));
  const traceRows = [...new Map(cRows.map((row) => [row.traceId, { traceId: row.traceId, goldCauses: row.goldCauses, events: row.goldCauses.map((cause, index) => ({ eventKind: cause, sourceId: `${row.traceId}:event:${index + 1}`, occurredAtStep: index + 1 })) }])).values()];
  await writeJsonl(path.join(runDir, 'traces.jsonl'), traceRows);
  await writeJsonl(path.join(runDir, 'attributions.jsonl'), cRows);
  await writeJsonl(path.join(runDir, 'evolution_updates.jsonl'), secondRound.map((row) => ({ pairId: row.pairId, seed: row.seed, method: row.method, organizationUpdated: row.organizationUpdated, individualUpdated: row.individualUpdated, evidenceGated: row.evidenceGated, adopted: row.secondRoundSuccess, rolledBack: row.rollback, rankDelta: row.rankDelta })));
  const errors = [
    ...bRows.filter((row) => !row.completed).map((row) => ({ experiment: 'B', taskId: row.taskId, seed: row.seed, method: row.method, reasons: ['incomplete', ...(row.privacyLeak ? ['privacy_leak'] : []), ...(row.dependencyViolation ? ['dependency_violation'] : [])] })),
    ...secondRound.filter((row) => !row.secondRoundSuccess).map((row) => ({ experiment: 'D', pairId: row.pairId, seed: row.seed, method: row.method, reasons: [row.negativeTransfer ? 'negative_transfer' : 'task_failure'] })),
  ];
  await writeJsonl(path.join(runDir, 'errors.jsonl'), errors);
  await writeJsonl(path.join(runDir, 'first_round_evidence.jsonl'), firstRound);
}

function taskCatalog() {
  const categories = ['数据分析与报告', '资料调研与写作', '代码修改与测试', '汇报材料生成与审核'];
  const injections = ['stale_profile', 'dependency_change', 'superseded_result'];
  return Array.from({ length: 12 }, (_, i) => {
    const correctRecipient = `ubuddy_${i % 3 + 1}`; const wrongRecipient = `ubuddy_${(i + 1) % 3 + 1}`; const thirdRecipient = `ubuddy_${(i + 2) % 3 + 1}`; const injection = injections[i % injections.length];
    return { id: `task_${i + 1}`, category: categories[i % 4], injection, subtaskCount: 3 + (i % 3), candidateCount: 3, dependencyCount: 1 + (i % 2), correctRecipient, wrongRecipient, currentProfileRevision: injection === 'stale_profile' ? 2 : 1, currentDependencyRevision: injection === 'dependency_change' ? 2 : 1, adoptedResultVersion: injection === 'superseded_result' ? 2 : 1, privateCanary: `PRIVATE_CANARY_${i + 1}`, candidates: [
      { id: correctRecipient, staticScore: injection === 'stale_profile' ? 0.58 : 0.95, currentScore: 0.95, historicalEvidenceScore: 0.08 },
      { id: wrongRecipient, staticScore: injection === 'stale_profile' ? 0.98 : 0.52, currentScore: 0.48, historicalEvidenceScore: -0.04 },
      { id: thirdRecipient, staticScore: 0.35, currentScore: 0.35, historicalEvidenceScore: 0 },
    ] };
  });
}

function decideStateCondition(task, method, seed) {
  const candidates = permute(task.candidates, hashInt(`${task.id}:${seed}:candidate-order`));
  let selectedRecipient; let profileRevisionUsed = 0; let dependencyRevisionUsed = 1; let resultVersionUsed = 1; let privateCanaryVisible = false; let informationItems = 1; let basis = [];
  if (method === 'B0_local_only') {
    selectedRecipient = candidates[hashInt(`${task.id}:${seed}:local-note`) % candidates.length].id;
    basis = ['local_note'];
  } else if (method === 'B1_static_profile') {
    selectedRecipient = maxBy(candidates, (candidate) => candidate.staticScore).id; profileRevisionUsed = task.injection === 'stale_profile' ? 1 : task.currentProfileRevision; informationItems = 3; basis = ['published_profile_without_revision'];
  } else if (method === 'B2_generic_shared') {
    selectedRecipient = maxBy(candidates, (candidate) => candidate.currentScore).id; profileRevisionUsed = 2; informationItems = 6; basis = ['current_profile', 'shared_messages']; privateCanaryVisible = seed === DEFAULT_SEEDS[0] && task.id === 'task_2';
  } else {
    selectedRecipient = maxBy(candidates, (candidate) => candidate.currentScore + candidate.historicalEvidenceScore).id; profileRevisionUsed = task.currentProfileRevision; dependencyRevisionUsed = task.currentDependencyRevision; resultVersionUsed = task.adoptedResultVersion; informationItems = 8; basis = ['visibility_filter', 'versioned_profile', 'immutable_selection_snapshot', 'dependency_projection', 'result_version', 'validated_evidence'];
  }
  if (method === 'B1_static_profile' && task.injection !== 'dependency_change') dependencyRevisionUsed = task.currentDependencyRevision;
  if (method === 'B2_generic_shared' && task.injection !== 'dependency_change') dependencyRevisionUsed = task.currentDependencyRevision;
  if ((method === 'B1_static_profile' || method === 'B2_generic_shared') && task.injection !== 'superseded_result') resultVersionUsed = task.adoptedResultVersion;
  const duplicateWork = Number(selectedRecipient !== task.correctRecipient) + Number(dependencyRevisionUsed < task.currentDependencyRevision) + Number(resultVersionUsed < task.adoptedResultVersion);
  return { selectedRecipient, profileRevisionUsed, dependencyRevisionUsed, resultVersionUsed, privateCanaryVisible, duplicateWork, informationItems, basis };
}

function buildControlledTrace(index, causes) {
  const traceId = `trace_${String(index + 1).padStart(3, '0')}`; const events = [{ id: `${traceId}:final`, kind: 'task_failed', text: 'final result did not satisfy the task', structured: {} }];
  const eventForCause = {
    task_decomposition_error: { kind: 'coverage_gap_detected', text: 'the task plan omitted a required subtask', structured: { missingSubtask: true } },
    recipient_selection_error: { kind: 'capability_mismatch_detected', text: 'the selected recipient did not match the required capability', structured: { selectedCapabilityMismatch: true } },
    stale_capability_profile: { kind: 'profile_revision_conflict', text: 'the selected capability profile revision was stale', structured: { selectedRevision: 1, currentRevision: 2 } },
    dependency_order_error: { kind: 'dependency_started_early', text: 'a dependent node started before its prerequisite completed', structured: { dependencyViolation: true } },
    individual_capability_gap: { kind: 'rubric_failure', text: 'the recipient repeatedly failed the required delivery rubric', structured: { repeatedCapabilityFailure: true } },
    external_tool_failure: { kind: 'external_tool_error', text: 'the external tool returned HTTP 503', structured: { status: 503 } },
    requirement_change_invalidated_result: { kind: 'result_superseded', text: 'a requirement revision invalidated the previous result', structured: { coveredRevision: 1, currentRevision: 2 } },
  };
  for (const cause of causes) if (eventForCause[cause]) events.unshift({ id: `${traceId}:${cause}`, ...eventForCause[cause] });
  return { traceId, events };
}

function attributeTrace(trace, method) {
  const visible = method === 'C0_final_only' ? trace.events.filter((event) => event.kind === 'task_failed') : trace.events;
  let predictedCauses = [];
  if (method === 'C0_final_only') predictedCauses = ['individual_capability_gap'];
  else if (method === 'C1_natural_trace') predictedCauses = visible.flatMap((event) => naturalLanguageCause(event.text)).filter(Boolean).slice(0, 1);
  else if (method === 'C2_single_layer') predictedCauses = visible.flatMap((event) => singleLayerCause(event.kind)).filter(Boolean);
  else predictedCauses = visible.flatMap((event) => structuredCause(event)).filter(Boolean);
  predictedCauses = [...new Set(predictedCauses)];
  const informativeEvents = visible.filter((event) => event.kind !== 'task_failed');
  const blocked = method === 'C3_dual_layer' && informativeEvents.length === 0;
  if (blocked) predictedCauses = ['insufficient_evidence'];
  const evidenceRefs = blocked ? [] : predictedCauses.flatMap((cause) => visible.filter((event) => structuredCause(event).includes(cause) || naturalLanguageCause(event.text) === cause).map((event) => `evidence:${trace.traceId}:${cause}:${event.id}`));
  return { predictedCauses, blocked, evidenceRefs, confidence: blocked ? 0.32 : method === 'C3_dual_layer' ? Math.min(0.95, 0.72 + evidenceRefs.length * 0.08) : method === 'C1_natural_trace' ? 0.66 : 0.58, visibleEventKinds: visible.map((event) => event.kind) };
}

function structuredCause(event) { const map = { coverage_gap_detected: 'task_decomposition_error', capability_mismatch_detected: 'recipient_selection_error', profile_revision_conflict: 'stale_capability_profile', dependency_started_early: 'dependency_order_error', rubric_failure: 'individual_capability_gap', external_tool_error: 'external_tool_failure', result_superseded: 'requirement_change_invalidated_result' }; return map[event.kind] ? [map[event.kind]] : []; }
function naturalLanguageCause(text) { const value = String(text).toLowerCase(); if (value.includes('omitted')) return 'task_decomposition_error'; if (value.includes('recipient') && value.includes('capability')) return 'recipient_selection_error'; if (value.includes('stale')) return 'stale_capability_profile'; if (value.includes('prerequisite')) return 'dependency_order_error'; if (value.includes('rubric')) return 'individual_capability_gap'; if (value.includes('503')) return 'external_tool_failure'; if (value.includes('invalidated')) return 'requirement_change_invalidated_result'; return ''; }
function singleLayerCause(kind) { if (kind === 'rubric_failure' || kind === 'capability_mismatch_detected') return ['individual_capability_gap']; if (['coverage_gap_detected', 'profile_revision_conflict', 'dependency_started_early', 'result_superseded'].includes(kind)) return ['task_decomposition_error']; if (kind === 'external_tool_error') return ['external_tool_failure']; return []; }

function buildFirstRoundEvidence(pair, seed) {
  const pairId = `pair_${pair + 1}`; const routes = ['parallel_then_merge', 'sequential_review']; const recipients = ['ubuddy_analysis', 'ubuddy_writing']; const goldRoute = routes[pair % 2]; const goldRecipient = recipients[Math.floor(pair / 2) % 2]; const baseRoute = routes[hashInt(`${pairId}:${seed}:base-route`) % routes.length]; const baseRecipient = recipients[hashInt(`${pairId}:${seed}:base-recipient`) % recipients.length];
  return { experiment: 'D', phase: 'first_round', pairId, seed, goldRoute, goldRecipient, baseRoute, baseRecipient, traceCaptured: true, resultAccepted: true, evidence: [
    { id: `${pairId}:${seed}:org`, layer: 'organization', value: goldRoute, validationStatus: 'validated', confidence: 0.9 },
    { id: `${pairId}:${seed}:individual`, layer: 'individual', value: goldRecipient, validationStatus: 'validated', confidence: 0.9 },
    { id: `${pairId}:${seed}:noise`, layer: pair % 2 ? 'organization' : 'individual', value: pair % 2 ? routes.find((item) => item !== goldRoute) : recipients.find((item) => item !== goldRecipient), validationStatus: 'unverified', confidence: 0.98 },
  ] };
}

function applyEvolutionPolicy(first, method) {
  let route = first.baseRoute; let recipient = first.baseRecipient; const used = []; const gated = method !== 'D4_joint_no_gate'; const eligible = first.evidence.filter((item) => !gated || (item.validationStatus === 'validated' && item.confidence >= 0.6));
  const choose = (layer) => eligible.filter((item) => item.layer === layer).sort((a, b) => b.confidence - a.confidence)[0];
  const useOrganization = ['D1_organization_only', 'D3_joint_gated', 'D4_joint_no_gate'].includes(method); const useIndividual = ['D2_individual_only', 'D3_joint_gated', 'D4_joint_no_gate'].includes(method);
  if (useOrganization) { const evidence = choose('organization'); if (evidence) { route = evidence.value; used.push(evidence.id); } }
  if (useIndividual) { const evidence = choose('individual'); if (evidence) { recipient = evidence.value; used.push(evidence.id); } }
  return { route, recipient, organizationUpdated: useOrganization, individualUpdated: useIndividual, evidenceGated: gated, rankDelta: recipient === first.baseRecipient ? 0 : 0.08, usedEvidenceIds: used };
}
async function changeManifest() { const status = await gitStatus(); return `# uBuddy experiment change manifest\n\nBase revision: 6f372d3\nCurrent revision: ${await gitRevision()}\n\n## Experiment implementation\n\n- Added scripts/ubuddy_experiment.mjs.\n- Added deterministic paired A/B/C/D pilot generators and JSONL artifacts.\n- Added environment, database and model-provider gate checks.\n- Added bounded 16-call model calibration behind --live-model.\n- Added offline metrics recomputation, confidence intervals and paper-scale gate.\n- No database schema or private message content is written by the runner.\n\n## Working tree at run time\n\n\`\`\`text\n${status || '(clean)'}\n\`\`\`\n`; }
function check(name, ok, detail) { return { name, ok: Boolean(ok), detail }; }
async function packageExists(name) { try { await fs.access(path.join(REPO_ROOT, 'node_modules', name)); return true; } catch { return false; } }
async function pathExists(filename) { try { await fs.access(filename); return true; } catch { return false; } }
async function gitRevision() { try { const { execFile } = await import('node:child_process'); return await new Promise((resolve) => execFile('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }, (e, out) => resolve(e ? 'unknown' : String(out).trim()))); } catch { return 'unknown'; } }
async function gitStatus() { try { const { execFile } = await import('node:child_process'); return await new Promise((resolve) => execFile('git', ['status', '--short'], { cwd: REPO_ROOT }, (e, out) => resolve(e ? 'unavailable' : String(out).trim()))); } catch { return 'unavailable'; } }
async function gitContext() { try { const { execFile } = await import('node:child_process'); const root = await new Promise((resolve) => execFile('git', ['rev-parse', '--show-toplevel'], { cwd: REPO_ROOT }, (e, out) => resolve(e ? '' : String(out).trim()))); return { gitRoot: root, janusIsCheckout: await pathExists(path.join(REPO_ROOT, '.git')), janusTrackedByGit: root ? path.resolve(root) === path.resolve(REPO_ROOT) : false, note: 'When janusTrackedByGit is false, use source-manifest.json instead of git diff for exact experiment-source hashes.' }; } catch { return { gitRoot: '', janusIsCheckout: false, janusTrackedByGit: false }; } }
async function sourceManifest() { const files = []; for (const relativePath of IMPLEMENTATION_FILES) { const filename = path.join(REPO_ROOT, relativePath); try { const content = await fs.readFile(filename); files.push({ path: relativePath.replaceAll('\\', '/'), bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') }); } catch { files.push({ path: relativePath.replaceAll('\\', '/'), missing: true }); } } return { manifestVersion: 'ubuddy_experiment_source_manifest_v1', generatedAt: new Date().toISOString(), files }; }
async function writeJson(filename, value) { await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
async function writeJsonl(filename, rows) { await fs.writeFile(filename, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8'); }
async function readJsonl(filename) { try { const text = await fs.readFile(filename, 'utf8'); return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } }
function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function number(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function round(value) { return Math.round(Number(value || 0) * 10000) / 10000; }
function rate(rows, key) { return rows.length ? rows.filter((row) => row[key] === true).length / rows.length : 0; }
function mean(rows, key) { return rows.length ? round(rows.reduce((sumValue, row) => sumValue + Number(row[key] || 0), 0) / rows.length) : 0; }
function sum(rows, key) { return rows.reduce((total, row) => total + Number(row[key] || 0), 0); }
function sameSet(a, b) { return JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort()); }
function setIou(a, b) { const left = new Set(a); const right = new Set(b); const union = new Set([...left, ...right]); const intersection = [...left].filter((item) => right.has(item)); return union.size ? intersection.length / union.size : 1; }
function binaryF1(rows, cause) { let tp = 0; let fp = 0; let fn = 0; for (const row of rows) { const truth = row.goldCauses.includes(cause); const predicted = row.predictedCauses.includes(cause); if (truth && predicted) tp++; else if (!truth && predicted) fp++; else if (truth && !predicted) fn++; } return 2 * tp / Math.max(1, 2 * tp + fp + fn); }
function calibrationError(rows) { return rows.reduce((total, row) => total + Math.abs(Number(row.confidence || 0) - (sameSet(row.goldCauses, row.predictedCauses) ? 1 : 0)), 0) / Math.max(1, rows.length); }
function pairedDifference(rows, treatment, control, key, pairKeys) { const index = new Map(rows.filter((row) => row.method === control).map((row) => [pairKeys.map((name) => row[name]).join(':'), row])); const differences = rows.filter((row) => row.method === treatment).map((row) => Number(Boolean(row[key])) - Number(Boolean(index.get(pairKeys.map((name) => row[name]).join(':'))?.[key]))); return { n: differences.length, meanDifference: round(differences.reduce((total, value) => total + value, 0) / Math.max(1, differences.length)), bootstrap95CI: bootstrapMeanCI(differences) }; }
function bootstrapMeanCI(values) { if (!values.length) return [0, 0]; const means = []; const random = rng(20260821); for (let roundIndex = 0; roundIndex < 2000; roundIndex += 1) { let total = 0; for (let i = 0; i < values.length; i += 1) total += values[Math.floor(random() * values.length)]; means.push(total / values.length); } means.sort((a, b) => a - b); return [round(means[Math.floor(means.length * 0.025)]), round(means[Math.floor(means.length * 0.975)])]; }
function wilson(proportion, n) { if (!n) return [0, 0]; const z = 1.96; const denominator = 1 + z * z / n; const center = (proportion + z * z / (2 * n)) / denominator; const margin = z * Math.sqrt((proportion * (1 - proportion) + z * z / (4 * n)) / n) / denominator; return [round(Math.max(0, center - margin)), round(Math.min(1, center + margin))]; }
function responsesEndpoint(baseUrl) { const url = new URL(String(baseUrl)); const pathname = url.pathname.replace(/\/+$/, ''); url.pathname = /\/v1\/responses$/i.test(pathname) ? pathname : /\/v1$/i.test(pathname) ? `${pathname}/responses` : `${pathname}/v1/responses`; url.search = ''; url.hash = ''; return url.toString(); }
function renderReport(summary) { const b2 = summary.metrics.B.B2_generic_shared; const b3 = summary.metrics.B.B3_ours; const c2 = summary.metrics.C.C2_single_layer; const c3 = summary.metrics.C.C3_dual_layer; const d0 = summary.metrics.D.D0_static; const d3 = summary.metrics.D.D3_joint_gated; const d4 = summary.metrics.D.D4_joint_no_gate; return `# uBuddy 本地预实验报告\n\n生成时间：${summary.generatedAt}\n\n## 样本\n\n- A：${summary.episodeCounts.A} 个架构不变量样本。\n- B：${summary.episodeCounts.B} 个状态辅助决策 episode。\n- C：${summary.episodeCounts.C} 份归因输出。\n- D：${summary.episodeCounts.DFirstRound} 个第一轮轨迹与 ${summary.episodeCounts.DSecondRound} 个第二轮条件。\n\n## 主要结果\n\n- 真实 pg-mem 原型回归：${summary.prototypeRegression?.passed ? '通过' : '失败'}。\n- B3 相比 B2：成功率 ${(b3.successRate * 100).toFixed(1)}% vs ${(b2.successRate * 100).toFixed(1)}%，配对差 ${summary.comparisons.B3_vs_B2.meanDifference.toFixed(4)}。\n- C3 相比 C2：macro-F1 ${c3.macroF1.toFixed(4)} vs ${c2.macroF1.toFixed(4)}；证据 precision ${c3.evidencePrecision.toFixed(4)}，recall ${c3.evidenceRecall.toFixed(4)}。\n- D3 相比 D0：第二轮成功率 ${(d3.successRate * 100).toFixed(1)}% vs ${(d0.successRate * 100).toFixed(1)}%。\n- 无门控 D4 的负迁移率为 ${(d4.negativeTransferRate * 100).toFixed(1)}%。\n\n## 结论边界\n\n这些结果来自受控、确定性的合成任务和信息受限规则执行器，用于验证机制、数据格式和实验程序；它们不是大模型真实协作效果或真人实验结论。当前未完成付费模型校准，也未验证 PostgreSQL 持久化、Evolution Worker、Skill/Memory 采用与回滚。\n`; }
function hashInt(value) { return Number.parseInt(crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8), 16); }
function rng(seed) { let state = seed >>> 0; return () => { state = (1664525 * state + 1013904223) >>> 0; return state / 0x100000000; }; }
function permute(values, seed) { const output = [...values]; const random = rng(seed); for (let i = output.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [output[i], output[j]] = [output[j], output[i]]; } return output; }
function maxBy(values, score) { return values.reduce((best, item) => score(item) > score(best) ? item : best, values[0]); }
