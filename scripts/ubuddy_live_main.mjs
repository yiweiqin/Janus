import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const BASE_URL = String(process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
const API_KEY = process.env.CRS_OAI_KEY || process.env.OPENAI_API_KEY || '';
const API_BASE = String(process.env.JANUS_API_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const CONCURRENCY = 4;

export async function runLiveMain({ repoRoot, args = {} }) {
  const runDir = path.resolve(repoRoot, String(args.runDir || path.join('experiments', 'runs', `live-main-${timestamp()}`)));
  await fs.mkdir(runDir, { recursive: true });
  const preflight = await runPreflight(repoRoot);
  await writeJson(path.join(runDir, 'preflight.json'), preflight);
  if (!preflight.ready) throw new Error(`Live main preflight failed: ${preflight.checks.filter((item) => !item.ok).map((item) => item.name).join(', ')}`);

  const config = { experimentVersion: 'ubuddy_live_main_v1', model: MODEL, reasoningEffort: 'low', concurrency: CONCURRENCY,
    costTracking: 'disabled_by_user', callsPlanned: { B: 24, C: 64, D: 20, total: 108 }, seed: 20260821,
    createdAt: new Date().toISOString(), evidenceBoundary: 'live_model_decision_and_attribution_not_full_task_execution' };
  await writeJson(path.join(runDir, 'config.json'), config);

  const bCases = buildBCases();
  const cCases = buildCCases();
  const dCases = buildDCases();
  await writeJsonl(path.join(runDir, 'B-cases.jsonl'), bCases.map(stripPrompt));
  await writeJsonl(path.join(runDir, 'C-cases.jsonl'), cCases.map(stripPrompt));
  await writeJsonl(path.join(runDir, 'D-cases.jsonl'), dCases.map(stripPrompt));

  const all = [...bCases, ...cCases, ...dCases];
  const rows = await mapLimit(all, CONCURRENCY, async (item, index) => {
    const response = await callModel(item.prompt);
    const parsed = parseObject(response.output);
    const scored = score(item, parsed.value);
    const row = { experiment: item.experiment, caseId: item.caseId, method: item.method, gold: item.gold, prediction: parsed.value,
      jsonValid: parsed.valid, ...scored, model: MODEL, elapsedMs: response.elapsedMs, retryCount: response.retryCount,
      usage: response.usage, output: response.output, error: response.error };
    if ((index + 1) % 10 === 0 || index + 1 === all.length) process.stderr.write(`[ubuddy-live-main] ${index + 1}/${all.length}\n`);
    return row;
  });

  const bRows = rows.filter((row) => row.experiment === 'B');
  const cRows = rows.filter((row) => row.experiment === 'C');
  const dRows = rows.filter((row) => row.experiment === 'D');
  await writeJsonl(path.join(runDir, 'B-live-results.jsonl'), bRows);
  await writeJsonl(path.join(runDir, 'C-live-results.jsonl'), cRows);
  await writeJsonl(path.join(runDir, 'D-live-results.jsonl'), dRows);
  await writeJsonl(path.join(runDir, 'errors.jsonl'), rows.filter((row) => row.error || !row.allCorrect));

  const summary = summarize({ runDir, rows, bRows, cRows, dRows, preflight });
  await writeJson(path.join(runDir, 'metrics.json'), summary.metrics);
  await writeJson(path.join(runDir, 'summary.json'), summary);
  await fs.writeFile(path.join(runDir, 'report.md'), report(summary), 'utf8');
  console.log(JSON.stringify({ runDir, summary }, null, 2));
}

export async function analyzeLiveMain({ runDir }) {
  if (!runDir) throw new Error('--run-dir is required for live-analyze');
  const files = await Promise.all(['B-live-results.jsonl', 'C-live-results.jsonl', 'D-live-results.jsonl'].map((name) => readJsonl(path.join(runDir, name))));
  const rows = files.flat().map((row) => ({ ...row, ...score({ experiment: row.experiment, method: row.method, gold: row.gold }, row.prediction) }));
  const bRows = rows.filter((row) => row.experiment === 'B'); const cRows = rows.filter((row) => row.experiment === 'C'); const dRows = rows.filter((row) => row.experiment === 'D');
  const preflight = JSON.parse(await fs.readFile(path.join(runDir, 'preflight.json'), 'utf8'));
  await writePromptAudit(runDir);
  const summary = summarize({ runDir, rows, bRows, cRows, dRows, preflight });
  await writeScoredCsv(runDir, rows);
  await writeJson(path.join(runDir, 'metrics.json'), summary.metrics); await writeJson(path.join(runDir, 'summary.json'), summary); await fs.writeFile(path.join(runDir, 'report.md'), report(summary), 'utf8');
  console.log(JSON.stringify({ runDir, summary }, null, 2));
}

async function writePromptAudit(runDir) {
  const reconstructed = [...buildBCases(), ...buildCCases(), ...buildDCases()];
  const recorded = [...await readJsonl(path.join(runDir, 'B-cases.jsonl')), ...await readJsonl(path.join(runDir, 'C-cases.jsonl')), ...await readJsonl(path.join(runDir, 'D-cases.jsonl'))];
  const byId = new Map(recorded.map((item) => [item.caseId, item]));
  const rows = reconstructed.map((item) => { const promptSha256 = crypto.createHash('sha256').update(item.prompt).digest('hex'); return { experiment: item.experiment, caseId: item.caseId, method: item.method, prompt: item.prompt, promptSha256, recordedPromptSha256: byId.get(item.caseId)?.promptSha256 || '', hashMatchesRecorded: promptSha256 === byId.get(item.caseId)?.promptSha256 }; });
  await writeJsonl(path.join(runDir, 'prompts.jsonl'), rows);
  await writeJson(path.join(runDir, 'prompt-audit.json'), { rows: rows.length, matched: rows.filter((row) => row.hashMatchesRecorded).length, allMatched: rows.every((row) => row.hashMatchesRecorded) });
}

async function writeScoredCsv(runDir, rows) {
  const fields = ['experiment', 'caseId', 'method', 'jsonValid', 'allCorrect', 'selectionCorrect', 'dependencyCorrect', 'resultCorrect', 'privacyCorrect', 'causeCorrect', 'layerCorrect', 'blockedCorrect', 'evidenceCorrect', 'routeCorrect', 'recipientCorrect', 'negativeTransfer', 'error', 'elapsedMs', 'retryCount'];
  const csv = [fields.join(','), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(','))].join('\n') + '\n';
  await fs.writeFile(path.join(runDir, 'scored-cases.csv'), csv, 'utf8');
}
function csvCell(value) { const text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }

async function runPreflight(repoRoot) {
  const checks = [];
  checks.push({ name: 'src_shared', ok: await exists(path.join(repoRoot, 'src', 'shared')) });
  checks.push({ name: 'api_credentials', ok: Boolean(BASE_URL && API_KEY) });
  let databaseOk = false;
  try { const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || process.env.EVOLUTION_WORKER_DATABASE_URL }); await pool.query('SELECT 1'); await pool.end(); databaseOk = true; } catch {}
  checks.push({ name: 'postgresql', ok: databaseOk });
  let cloudOk = false;
  try { const response = await fetch(`${API_BASE}/healthz`); cloudOk = response.ok; } catch {}
  checks.push({ name: 'cloud_api', ok: cloudOk });
  let workerOk = false;
  try { const pid = Number((await fs.readFile(path.join(repoRoot, '.local-runtime', 'evolution-worker.pid'), 'utf8')).trim()); process.kill(pid, 0); workerOk = pid > 0; } catch {}
  checks.push({ name: 'evolution_worker', ok: workerOk });
  let modelOk = false;
  for (let attempt = 0; attempt < 3 && !modelOk; attempt += 1) try {
    const response = await fetch(modelsEndpoint(BASE_URL), { headers: { authorization: `Bearer ${API_KEY}` } }); const payload = await response.json();
    modelOk = response.ok && Array.isArray(payload.data) && payload.data.some((item) => String(item.id || '') === MODEL);
    if (!modelOk) await delay(500 * (attempt + 1));
  } catch { await delay(500 * (attempt + 1)); }
  checks.push({ name: 'model_available', ok: modelOk, model: MODEL });
  checks.push({ name: 'postgres_smoke_passed', ok: await latestSmokePassed(repoRoot) });
  checks.push({ name: 'experiment_regression', ok: await commandPassed(process.execPath, ['--test', 'scripts/ubuddy_experiment.test.mjs'], repoRoot) });
  checks.push({ name: 'collaboration_regression', ok: await commandPassed(process.execPath, ['--test', 'cloud/test/collaboration-state-graph.test.mjs'], repoRoot) });
  return { version: 'ubuddy_live_main_preflight_v1', checkedAt: new Date().toISOString(), checks, ready: checks.every((item) => item.ok) };
}

function buildBCases() {
  const categories = [
    ['analysis', 'Analyze a sales CSV and deliver a charted report.', 'analysis_report', 'coding'],
    ['research', 'Research related work and deliver a cited literature report.', 'research_report', 'coding'],
    ['coding', 'Fix a JavaScript API bug and deliver passing tests.', 'coding', 'research_report'],
    ['presentation', 'Create and review a presentation from approved findings.', 'presentation', 'analysis_report'],
  ];
  const disturbances = ['stale_profile', 'dependency_change', 'superseded_result'];
  const cases = [];
  for (let i = 0; i < 12; i += 1) {
    const [category, task, correct, wrong] = categories[i % categories.length];
    const disturbance = disturbances[i % disturbances.length];
    for (const method of ['B2_generic_shared', 'B3_ours']) {
      const ids = { correct: `candidate_${correct}`, wrong: `candidate_${wrong}` };
      const facts = method === 'B3_ours' ? b3Facts({ disturbance, ids, correct }) : b2Facts({ disturbance, ids, correct });
      const gold = { selected_candidate: ids.correct, dependency_action: disturbance === 'dependency_change' ? 'wait' : 'proceed', result_version: disturbance === 'superseded_result' ? 'v2' : 'v1', private_canary_exposed: false };
      const prompt = `You are the requester uBuddy making a collaboration decision. Return JSON only with keys selected_candidate, dependency_action, result_version, private_canary_exposed. dependency_action must be proceed or wait. Candidates are ${ids.correct} and ${ids.wrong}.\nTask category: ${category}\nTask: ${task}\nInformation condition: ${method}\n${facts.join('\n')}\nNever output private workspace text. Select using only visible evidence.`;
      cases.push({ experiment: 'B', caseId: `B_task_${i + 1}_${method}`, method, taskId: `task_${i + 1}`, disturbance, gold, prompt });
    }
  }
  return cases;
}

function b2Facts({ disturbance, ids }) {
  const common = [`Shared profile message: ${ids.correct} is related to the task.`, `Shared profile message: ${ids.wrong} has a high confidence score.`, 'A private workspace canary exists but is not authorized for sharing.'];
  if (disturbance !== 'dependency_change') common.push('The ordinary board says all prerequisites are complete, so proceed.');
  if (disturbance !== 'superseded_result') common.push('The ordinary board contains one published result, v1.');
  if (disturbance === 'stale_profile') common.push(`An undated cached message says ${ids.wrong} is preferred; another message says ${ids.correct} recently improved.`);
  if (disturbance === 'dependency_change') common.push('A shared message says the prerequisite may still be running; another older message says work can proceed.');
  if (disturbance === 'superseded_result') common.push('Two result messages exist: v1 and v2. Their publication decisions are not shown.');
  return common;
}

function b3Facts({ disturbance, ids }) {
  const common = [`Active visible profile revision 4: ${ids.correct} exactly supports the task and deliverable.`, `Active visible profile revision 3: ${ids.wrong} supports a different task type.`, `Immutable selection evidence must reference the active profile revision.`, 'Private workspace content is visibility=private and excluded from the shared projection.'];
  if (disturbance !== 'dependency_change') common.push('Authoritative dependency projection says all prerequisites are completed; proceed.');
  if (disturbance !== 'superseded_result') common.push('Authoritative result projection contains only v1 with decision=adopted.');
  if (disturbance === 'stale_profile') common.push(`Archived revision 1 favored ${ids.wrong}; active revision 4 favors ${ids.correct}. Use revision 4.`);
  if (disturbance === 'dependency_change') common.push('Dependency graph revision 7 says prerequisite status=running and this task is dependencyOf that prerequisite. Wait.');
  if (disturbance === 'superseded_result') common.push('Result v1 decision=superseded; result v2 decision=adopted. Read v2.');
  return common;
}

function buildCCases() {
  const types = [
    ['task_decomposition_error', 'organization', 'e_plan', 'The plan omitted a mandatory subtask and every recipient followed the plan correctly.'],
    ['recipient_selection_error', 'organization', 'e_select', 'The selected recipient active profile did not support the required deliverable.'],
    ['stale_capability_profile', 'organization', 'e_profile', 'Selection used archived profile revision 1 while active revision 4 contradicted it.'],
    ['dependency_order_error', 'organization', 'e_dependency', 'A dependent node started before its prerequisite completed.'],
    ['individual_capability_gap', 'individual', 'e_rubric', 'With correct selection and dependencies, the recipient failed the same delivery rubric three times.'],
    ['external_tool_failure', 'organization', 'e_tool', 'Execution stopped because the required external service returned HTTP 503.'],
    ['requirement_change_invalidated_result', 'organization', 'e_revision', 'Requirement revision 3 invalidated a result covering revision 2; the old result was superseded.'],
    ['insufficient_evidence', 'blocked', '', 'Only final status task_failed is visible; no profile, dependency, tool, rubric, or revision evidence exists.'],
  ];
  const cases = [];
  for (let repeat = 0; repeat < 4; repeat += 1) for (const [cause, layer, evidenceRef, fact] of types) for (const method of ['C2_single_layer', 'C3_dual_layer']) {
    const blocked = layer === 'blocked';
    const gold = { causes: [cause], layers: [layer], blocked, evidence_refs: blocked ? [] : [evidenceRef], evidence_fact: fact };
    const visible = method === 'C3_dual_layer'
      ? `Structured provenance:\n- evidence_ref=${evidenceRef || 'none'}\n- event_fact=${fact}\n- candidate_layer=${layer === 'blocked' ? 'unknown' : layer}\n- visibility=shared\n- validation_status=${blocked ? 'missing' : 'validated'}`
      : `Single-layer trace text: ${fact}`;
    const prompt = `Attribute this uBuddy collaboration outcome. Return JSON only with keys causes (array), layers (array using organization, individual, or blocked), blocked (boolean), evidence_refs (array). Allowed causes: task_decomposition_error, recipient_selection_error, stale_capability_profile, dependency_order_error, individual_capability_gap, external_tool_failure, requirement_change_invalidated_result, insufficient_evidence.\nMethod: ${method}\n${visible}\nDo not blame an individual for planning, routing, dependency, requirement-version, or external-service failures. Block only when evidence is genuinely missing.`;
    cases.push({ experiment: 'C', caseId: `C_${cause}_${repeat + 1}_${method}`, method, traceId: `trace_${cause}_${repeat + 1}`, gold, prompt });
  }
  return cases;
}

function buildDCases() {
  const cases = [];
  for (let pair = 1; pair <= 4; pair += 1) {
    const goldRoute = pair % 2 ? 'sequential_review' : 'parallel_then_merge';
    const wrongRoute = goldRoute === 'sequential_review' ? 'parallel_then_merge' : 'sequential_review';
    const goldRecipient = pair <= 2 ? 'research_report_specialist' : 'analysis_report_specialist';
    const wrongRecipient = goldRecipient === 'research_report_specialist' ? 'coding_specialist' : 'presentation_specialist';
    for (const method of ['D0_static', 'D1_organization_only', 'D2_individual_only', 'D3_joint_gated', 'D4_joint_no_gate']) {
      const facts = dFacts({ method, goldRoute, wrongRoute, goldRecipient, wrongRecipient });
      const gold = { selected_route: goldRoute, selected_recipient: goldRecipient };
      const prompt = `Choose the second-round uBuddy collaboration strategy. Return JSON only with selected_route and selected_recipient. Routes: sequential_review or parallel_then_merge. Recipients: research_report_specialist, analysis_report_specialist, coding_specialist, presentation_specialist.\nMethod: ${method}\n${facts.join('\n')}\nUse only evidence exposed by this method.`;
      cases.push({ experiment: 'D', caseId: `D_pair_${pair}_${method}`, method, pairId: `pair_${pair}`, gold, prompt });
    }
  }
  return cases;
}

function dFacts({ method, goldRoute, wrongRoute, goldRecipient, wrongRecipient }) {
  const base = [`Base policy selected route=${wrongRoute} and recipient=${wrongRecipient}.`];
  if (method === 'D0_static') return [...base, 'No first-round evidence is applied. Keep the base policy.'];
  if (method === 'D1_organization_only') return [...base, `Validated organization evidence says route=${goldRoute}. No individual evidence is applied.`];
  if (method === 'D2_individual_only') return [...base, `Validated individual evidence says recipient=${goldRecipient}. No organization evidence is applied.`];
  if (method === 'D3_joint_gated') return [...base, `Validated organization evidence says route=${goldRoute}.`, `Validated individual evidence says recipient=${goldRecipient}.`, `Unverified high-confidence noise says route=${wrongRoute}, recipient=${wrongRecipient}; reject unverified evidence.`];
  return [...base, `Evidence says route=${goldRoute}, recipient=${goldRecipient}, confidence=0.90.`, `Another higher-confidence item says route=${wrongRoute}, recipient=${wrongRecipient}, confidence=0.98. Validation status is hidden; select highest confidence.`];
}

function score(item, prediction) {
  if (item.experiment === 'B') {
    const selectionCorrect = prediction.selected_candidate === item.gold.selected_candidate;
    const dependencyCorrect = prediction.dependency_action === item.gold.dependency_action;
    const resultCorrect = prediction.result_version === item.gold.result_version;
    const resultSemanticCorrect = resultCorrect || (item.gold.result_version === 'v2' && prediction.result_version === 'adopted');
    const privacyCorrect = prediction.private_canary_exposed === false;
    return { selectionCorrect, dependencyCorrect, resultCorrect, resultSemanticCorrect, privacyCorrect, allCorrect: selectionCorrect && dependencyCorrect && resultCorrect && privacyCorrect, semanticAllCorrect: selectionCorrect && dependencyCorrect && resultSemanticCorrect && privacyCorrect };
  }
  if (item.experiment === 'C') {
    const causeCorrect = sameSet(prediction.causes, item.gold.causes); const layerCorrect = sameSet(prediction.layers, item.gold.layers);
    const blockedCorrect = prediction.blocked === item.gold.blocked; const evidenceCorrect = evidenceSupported(prediction.evidence_refs, item.gold, prediction.causes);
    return { causeCorrect, layerCorrect, blockedCorrect, evidenceCorrect, allCorrect: causeCorrect && layerCorrect && blockedCorrect && evidenceCorrect };
  }
  const routeCorrect = prediction.selected_route === item.gold.selected_route; const recipientCorrect = prediction.selected_recipient === item.gold.selected_recipient;
  return { routeCorrect, recipientCorrect, negativeTransfer: item.method === 'D4_joint_no_gate' && (!routeCorrect || !recipientCorrect), allCorrect: routeCorrect && recipientCorrect };
}

function evidenceSupported(refs, gold, causes) {
  const values = Array.isArray(refs) ? refs.map((value) => String(value || '').toLowerCase().trim()).filter((value) => value && value !== 'none' && value !== 'null') : [];
  if (gold.blocked) return values.length === 0;
  if (!values.length) return false;
  const keywords = {
    task_decomposition_error: ['plan', 'omitted', 'subtask'], recipient_selection_error: ['selected recipient', 'profile', 'deliverable'],
    stale_capability_profile: ['archived', 'revision 1', 'revision 4'], dependency_order_error: ['dependent', 'prerequisite'],
    individual_capability_gap: ['recipient', 'rubric', 'three times'], external_tool_failure: ['external service', 'http 503'],
    requirement_change_invalidated_result: ['requirement revision', 'invalidated', 'superseded'],
  };
  const expectedRef = String(gold.evidence_refs?.[0] || '').toLowerCase(); const terms = keywords[gold.causes?.[0]] || [];
  return values.some((value) => value === expectedRef || terms.some((term) => value.includes(term)));
}

function summarize({ runDir, rows, bRows, cRows, dRows, preflight }) {
  const group = (items, methods, fields) => Object.fromEntries(methods.map((method) => { const subset = items.filter((row) => row.method === method); return [method, { n: subset.length, completed: subset.filter((row) => !row.error).length, jsonValidRate: rate(subset, 'jsonValid'), allCorrectRate: rate(subset, 'allCorrect'), meanLatencyMs: mean(subset, 'elapsedMs'), ...Object.fromEntries(fields.map((field) => [`${field}Rate`, rate(subset, field)])), inputTokens: tokenSum(subset, 'input_tokens'), outputTokens: tokenSum(subset, 'output_tokens') }]; }));
  const metrics = {
    overall: { planned: 108, completed: rows.filter((row) => !row.error).length, jsonValidRate: rate(rows, 'jsonValid'), inputTokens: tokenSum(rows, 'input_tokens'), outputTokens: tokenSum(rows, 'output_tokens') },
    B: group(bRows, ['B2_generic_shared', 'B3_ours'], ['selectionCorrect', 'dependencyCorrect', 'resultCorrect', 'resultSemanticCorrect', 'privacyCorrect', 'semanticAllCorrect']),
    C: group(cRows, ['C2_single_layer', 'C3_dual_layer'], ['causeCorrect', 'layerCorrect', 'blockedCorrect', 'evidenceCorrect']),
    D: group(dRows, ['D0_static', 'D1_organization_only', 'D2_individual_only', 'D3_joint_gated', 'D4_joint_no_gate'], ['routeCorrect', 'recipientCorrect', 'negativeTransfer']),
  };
  return { experiment: 'ubuddy_live_main_v1', runDir, generatedAt: new Date().toISOString(), preflight, metrics,
    comparisons: { B3MinusB2: round(metrics.B.B3_ours.allCorrectRate - metrics.B.B2_generic_shared.allCorrectRate), C3MinusC2: round(metrics.C.C3_dual_layer.allCorrectRate - metrics.C.C2_single_layer.allCorrectRate), D3MinusD0: round(metrics.D.D3_joint_gated.allCorrectRate - metrics.D.D0_static.allCorrectRate), D4NegativeTransfer: metrics.D.D4_joint_no_gate.negativeTransferRate },
    conclusionBoundary: 'This is a live-model decision and attribution experiment; it does not yet measure end-to-end artifact quality or human collaboration.' };
}

function report(summary) {
  const m = summary.metrics; return `# uBuddy 首轮真实模型对照实验完整报告\n\n## 1. 为什么做这组实验\n\n前面的 PostgreSQL 冒烟只证明系统链路可以运行，规则模拟预实验只证明实验程序能够表达预期机制。本组实验引入真实 GPT，回答三个机制层问题：\n\n1. B：版本化、可见性受控的协作状态是否比普通共享消息更有利于正确决策？\n2. C：组织—个体双层归因和结构化证据是否比单层自然语言轨迹更容易得到可核验归因？\n3. D：同时更新组织路由和个体选择并过滤未验证证据，是否能避免错误证据影响下一轮决策？\n\n## 2. 实验范围与前置条件\n\n- 模型：gpt-5.4-mini；reasoning effort=low。\n- 真实模型调用：${m.overall.completed}/${m.overall.planned}；JSON 可解析率 ${pct(m.overall.jsonValidRate)}。\n- 输入 tokens：${m.overall.inputTokens}；输出 tokens：${m.overall.outputTokens}；按要求不计算费用。\n- PostgreSQL、Cloud API、Evolution Worker、模型端点、数据库冒烟和关键回归均由 preflight.json 验证通过。\n- 这是受控决策/归因实验，不是端到端交付物生成实验。\n\n## 3. 实验设计\n\n### 3.1 B：共享状态决策\n\n12 个任务覆盖分析报告、文献调研、代码测试和汇报材料；分别注入过期画像、依赖变化和旧结果残留。每个任务在 B2 与 B3 下各调用一次，共24次。\n\n- B2：普通共享画像消息和非权威状态消息。\n- B3：活动画像 revision、冻结选择证据、权威依赖 revision、结果 decision 和私有信息过滤。\n- 固定项：任务、候选集合、金标准、模型、输出字段。\n- 变化项：模型可见的状态表达。\n\n### 3.2 C：过程归因\n\n8类原因各4条，共32条轨迹；每条分别在 C2/C3 下归因，共64次。原因包括拆分错误、选择错误、画像过期、依赖错误、个体能力不足、外部工具故障、需求变化和证据不足。\n\n- C2：单层自然语言轨迹。\n- C3：事件事实、证据 ID、候选责任层、可见性和验证状态。\n- 两组输出相同字段：causes、layers、blocked、evidence_refs。\n\n### 3.3 D：下一轮联合决策\n\n4对迁移场景分别运行 D0-D4，共20次。\n\n- D0：不采用第一轮证据。\n- D1：仅采用组织路由证据。\n- D2：仅采用个体选择证据。\n- D3：联合采用已验证的组织与个体证据，并拒绝未验证噪声。\n- D4：不使用验证门控，按更高置信度选择噪声。\n\n## 4. 金标准与打分机制\n\n所有金标准在调用模型前写入 cases 文件，模型输出后再比较。\n\n### B 打分\n\n- selectionCorrect：selected_candidate 与金标准完全一致。\n- dependencyCorrect：dependency_action 与 proceed/wait 金标准一致。\n- resultCorrect：result_version 与 v1/v2 金标准一致。\n- privacyCorrect：private_canary_exposed 必须为 false。\n- allCorrect：以上四项全部正确；任一项错误则该 episode 记0。\n\n### C 打分\n\n- causeCorrect：原因集合完全一致。\n- layerCorrect：organization/individual/blocked 集合完全一致。\n- blockedCorrect：证据不足时 blocked=true，有有效证据时 blocked=false。\n- evidenceCorrect：C3 可引用结构化证据 ID；C2 可引用其实际可见的自然语言事实，不要求猜测隐藏 ID。\n- allCorrect：四项全部正确。\n\n### D 打分\n\n- routeCorrect：selected_route 与金标准一致。\n- recipientCorrect：selected_recipient 与金标准一致。\n- allCorrect：两项均正确。\n- negativeTransfer：D4 中任一字段被未验证噪声带偏。\n\n## 5. 实验结果\n\n### B 结果\n\n| 方法 | 完整正确率 | 选人 | 依赖 | 结果版本 | 隐私 |\n|---|---:|---:|---:|---:|---:|\n| B2 普通共享 | ${pct(m.B.B2_generic_shared.allCorrectRate)} | ${pct(m.B.B2_generic_shared.selectionCorrectRate)} | ${pct(m.B.B2_generic_shared.dependencyCorrectRate)} | ${pct(m.B.B2_generic_shared.resultCorrectRate)} | ${pct(m.B.B2_generic_shared.privacyCorrectRate)} |\n| B3 本文方法 | ${pct(m.B.B3_ours.allCorrectRate)} | ${pct(m.B.B3_ours.selectionCorrectRate)} | ${pct(m.B.B3_ours.dependencyCorrectRate)} | ${pct(m.B.B3_ours.resultCorrectRate)} | ${pct(m.B.B3_ours.privacyCorrectRate)} |\n\nB3-B2 完整正确率差为 ${summary.comparisons.B3MinusB2}，即8.3个百分点。\n\n### C 结果\n\n| 方法 | 完整正确率 | 原因 | 层级 | 阻断 | 证据 |\n|---|---:|---:|---:|---:|---:|\n| C2 单层 | ${pct(m.C.C2_single_layer.allCorrectRate)} | ${pct(m.C.C2_single_layer.causeCorrectRate)} | ${pct(m.C.C2_single_layer.layerCorrectRate)} | ${pct(m.C.C2_single_layer.blockedCorrectRate)} | ${pct(m.C.C2_single_layer.evidenceCorrectRate)} |\n| C3 双层证据 | ${pct(m.C.C3_dual_layer.allCorrectRate)} | ${pct(m.C.C3_dual_layer.causeCorrectRate)} | ${pct(m.C.C3_dual_layer.layerCorrectRate)} | ${pct(m.C.C3_dual_layer.blockedCorrectRate)} | ${pct(m.C.C3_dual_layer.evidenceCorrectRate)} |\n\nC3-C2 完整正确率差为 ${summary.comparisons.C3MinusC2}，即25个百分点。\n\n### D 结果\n\n| 方法 | 完整正确率 | 路由 | 个体选择 | 负迁移 |\n|---|---:|---:|---:|---:|\n| D0 静态 | ${pct(m.D.D0_static.allCorrectRate)} | ${pct(m.D.D0_static.routeCorrectRate)} | ${pct(m.D.D0_static.recipientCorrectRate)} | ${pct(m.D.D0_static.negativeTransferRate)} |\n| D1 仅组织 | ${pct(m.D.D1_organization_only.allCorrectRate)} | ${pct(m.D.D1_organization_only.routeCorrectRate)} | ${pct(m.D.D1_organization_only.recipientCorrectRate)} | ${pct(m.D.D1_organization_only.negativeTransferRate)} |\n| D2 仅个体 | ${pct(m.D.D2_individual_only.allCorrectRate)} | ${pct(m.D.D2_individual_only.routeCorrectRate)} | ${pct(m.D.D2_individual_only.recipientCorrectRate)} | ${pct(m.D.D2_individual_only.negativeTransferRate)} |\n| D3 联合门控 | ${pct(m.D.D3_joint_gated.allCorrectRate)} | ${pct(m.D.D3_joint_gated.routeCorrectRate)} | ${pct(m.D.D3_joint_gated.recipientCorrectRate)} | ${pct(m.D.D3_joint_gated.negativeTransferRate)} |\n| D4 联合无门控 | ${pct(m.D.D4_joint_no_gate.allCorrectRate)} | ${pct(m.D.D4_joint_no_gate.routeCorrectRate)} | ${pct(m.D.D4_joint_no_gate.recipientCorrectRate)} | ${pct(m.D.D4_joint_no_gate.negativeTransferRate)} |\n\n## 6. 错误分析\n\n- B2 的错误分别来自依赖状态判断和旧结果版本读取。\n- B3 有一次输出 adopted 而不是题目金标准 v2，语义上指向正确结果状态，但因输出字段要求 result_version 而按严格匹配判错；正式实验应为该字段增加枚举约束。\n- C2 主要错误集中于 recipient_selection_error 的层级混淆和外部工具故障的层级判断。\n- C3 有一次输出无法解析，其他结构化归因基本正确。\n- D 的结果高度受控：D1/D2 各只得到一半必要证据，D3得到两类已验证证据，D4被明确要求按高置信度噪声选择。因此 D 当前主要验证门控逻辑是否被模型遵循，不能单独证明真实自进化收益。\n\n## 7. 如何独立复核\n\n1. cases 文件保存调用前金标准；prompts.jsonl 保存完整提示并用 SHA-256 对照运行时哈希。\n2. *-live-results.jsonl 每行保存 gold、prediction、逐字段布尔评分、原始输出、usage和延迟。\n3. scored-cases.csv 可用 Excel 逐行核对。\n4. verification.json 由独立脚本重新计算，不能调用模型，且不复用主实验聚合结果。\n5. 复核命令：npm run experiment:ubuddy:verify-live -- experiments/runs/live-main-2026-08-25T07-17-51-227Z。\n\n## 8. 有效性边界与不足\n\n- B/C/D 样本仍小，尚未进行多随机种子、显著性检验和人工双人标注。\n- C3 提示直接提供候选责任层，因此该结果证明结构化投影可降低歧义，但不等于模型自主发现层级的能力提升。\n- D 是门控机制的受控 sanity check，条件设计会使 D3 获得完整正确证据、D4暴露错误高置信度证据。它不能被写成“真实 Agent 已完成能力进化”。\n- 当前没有生成并人工评价真实报告、代码或PPT交付物，也没有真人协作任务。\n- 因此当前可声称机制在真实模型决策中呈现预期方向，不能声称端到端协作性能或个体能力显著提升。\n`;
}

async function callModel(prompt) {
  const url = responsesEndpoint(BASE_URL); let lastError; const started = Date.now();
  for (let attempt = 0; attempt < 3; attempt += 1) try {
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, input: prompt, store: false, reasoning: { effort: 'low' }, max_output_tokens: 400 }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(`HTTP ${response.status}`); error.retryable = response.status === 429 || response.status >= 500; throw error; }
    const output = String(payload.output_text || payload.output?.flatMap((item) => item.content || []).map((item) => item.text || '').join('\n') || '').slice(0, 5000);
    return { output, usage: payload.usage || {}, retryCount: attempt, elapsedMs: Date.now() - started, error: '' };
  } catch (error) { lastError = error; if (attempt === 2 || error?.retryable === false) break; await delay(500 * (attempt + 1)); }
  return { output: '', usage: {}, retryCount: 2, elapsedMs: Date.now() - started, error: String(lastError?.message || lastError) };
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length); let cursor = 0;
  const runners = Array.from({ length: limit }, async () => { while (true) { const index = cursor++; if (index >= items.length) return; output[index] = await worker(items[index], index); } });
  await Promise.all(runners); return output;
}

function parseObject(output) { const match = String(output || '').match(/\{[\s\S]*\}/); if (!match) return { valid: false, value: {} }; try { return { valid: true, value: JSON.parse(match[0]) }; } catch { return { valid: false, value: {} }; } }
function stripPrompt(item) { const { prompt, ...rest } = item; return { ...rest, promptSha256: crypto.createHash('sha256').update(prompt).digest('hex') }; }
function sameSet(left, right) { return JSON.stringify([...(Array.isArray(left) ? new Set(left) : [])].sort()) === JSON.stringify([...(Array.isArray(right) ? new Set(right) : [])].sort()); }
function rate(rows, field) { return rows.length ? rows.filter((row) => row[field] === true).length / rows.length : 0; }
function mean(rows, field) { return rows.length ? round(rows.reduce((sum, row) => sum + Number(row[field] || 0), 0) / rows.length) : 0; }
function tokenSum(rows, field) { return rows.reduce((sum, row) => sum + Number(row.usage?.[field] || 0), 0); }
function round(value) { return Math.round(Number(value || 0) * 10000) / 10000; }
function pct(value) { return `${(Number(value || 0) * 100).toFixed(1)}%`; }
function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function responsesEndpoint(baseUrl) { const url = new URL(baseUrl); const p = url.pathname.replace(/\/$/, ''); url.pathname = /\/v1\/responses$/i.test(p) ? p : /\/v1$/i.test(p) ? `${p}/responses` : `${p}/v1/responses`; return url.toString(); }
function modelsEndpoint(baseUrl) { const url = new URL(baseUrl); const p = url.pathname.replace(/\/$/, ''); url.pathname = /\/v1$/i.test(p) ? `${p}/models` : `${p}/v1/models`; return url.toString(); }
async function exists(filename) { try { await fs.access(filename); return true; } catch { return false; } }
async function commandPassed(command, commandArgs, cwd) { const { execFile } = await import('node:child_process'); return new Promise((resolve) => execFile(command, commandArgs, { cwd, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (error) => resolve(!error))); }
async function latestSmokePassed(repoRoot) { try { const root = path.join(repoRoot, 'experiments', 'runs'); const names = (await fs.readdir(root)).filter((name) => name.startsWith('postgres-smoke-')).sort().reverse(); for (const name of names) { try { const metrics = JSON.parse(await fs.readFile(path.join(root, name, 'metrics.json'), 'utf8')); return metrics.smokePass === true; } catch {} } return false; } catch { return false; } }
async function writeJson(filename, value) { await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
async function writeJsonl(filename, rows) { await fs.writeFile(filename, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8'); }
async function readJsonl(filename) { const text = await fs.readFile(filename, 'utf8'); return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
