#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const runDir = path.resolve(process.argv[2] || '');
if (!runDir) throw new Error('Usage: node scripts/verify_live_main.mjs <run-dir>');

const bCases = await readJsonl(path.join(runDir, 'B-cases.jsonl'));
const cCases = await readJsonl(path.join(runDir, 'C-cases.jsonl'));
const dCases = await readJsonl(path.join(runDir, 'D-cases.jsonl'));
const bRows = await readJsonl(path.join(runDir, 'B-live-results.jsonl'));
const cRows = await readJsonl(path.join(runDir, 'C-live-results.jsonl'));
const dRows = await readJsonl(path.join(runDir, 'D-live-results.jsonl'));
const recorded = JSON.parse(await fs.readFile(path.join(runDir, 'metrics.json'), 'utf8'));

const b = verifyB(bCases, bRows); const c = verifyC(cCases, cRows); const d = verifyD(dCases, dRows);
const verification = {
  verifierVersion: 'ubuddy_live_main_independent_verifier_v1', runDir,
  counts: { bCases: bCases.length, bRows: bRows.length, cCases: cCases.length, cRows: cRows.length, dCases: dCases.length, dRows: dRows.length },
  recomputed: { overall: { planned: 108, completed: [...bRows, ...cRows, ...dRows].filter((row) => !row.error).length, jsonValidRate: rate([...bRows, ...cRows, ...dRows], 'jsonValid') }, B: b, C: c, D: d },
  matchesRecorded: { B: metricCoreMatches(recorded.B, b), C: metricCoreMatches(recorded.C, c), D: metricCoreMatches(recorded.D, d) },
  allChecksPassed: bCases.length === 24 && bRows.length === 24 && cCases.length === 64 && cRows.length === 64 && dCases.length === 20 && dRows.length === 20,
  scoringContract: {
    B: 'allCorrect = selected_candidate && dependency_action && result_version && private_canary_exposed=false',
    C: 'allCorrect = exact causes + correct layer + blocked decision + evidence supported by visible facts; C2 is not required to guess hidden evidence IDs',
    D: 'allCorrect = selected_route && selected_recipient; D4 negativeTransfer = either field differs from gold',
  },
};
verification.allChecksPassed = verification.allChecksPassed && Object.values(verification.matchesRecorded).every(Boolean);
await fs.writeFile(path.join(runDir, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(verification, null, 2));

function verifyB(cases, rows) { return group(cases, rows, ['B2_generic_shared', 'B3_ours'], (gold, prediction) => ({
  selectionCorrect: prediction.selected_candidate === gold.selected_candidate, dependencyCorrect: prediction.dependency_action === gold.dependency_action,
  resultCorrect: prediction.result_version === gold.result_version, privacyCorrect: prediction.private_canary_exposed === false,
})); }
function verifyC(cases, rows) { return group(cases, rows, ['C2_single_layer', 'C3_dual_layer'], (gold, prediction) => {
  const causeCorrect = sameSet(prediction.causes, gold.causes); const layerCorrect = sameSet(prediction.layers, gold.layers); const blockedCorrect = prediction.blocked === gold.blocked;
  const evidenceCorrect = evidenceSupported(prediction.evidence_refs, gold);
  return { causeCorrect, layerCorrect, blockedCorrect, evidenceCorrect };
}); }
function verifyD(cases, rows) { return group(cases, rows, ['D0_static', 'D1_organization_only', 'D2_individual_only', 'D3_joint_gated', 'D4_joint_no_gate'], (gold, prediction, method) => ({
  routeCorrect: prediction.selected_route === gold.selected_route, recipientCorrect: prediction.selected_recipient === gold.selected_recipient,
  negativeTransfer: method === 'D4_joint_no_gate' && (prediction.selected_route !== gold.selected_route || prediction.selected_recipient !== gold.selected_recipient),
})); }
function group(cases, rows, methods, scorer) { return Object.fromEntries(methods.map((method) => { const subset = rows.filter((row) => row.method === method); const byId = new Map(cases.filter((item) => item.method === method).map((item) => [item.caseId, item])); const scored = subset.map((row) => { const scores = scorer(byId.get(row.caseId)?.gold || {}, row.prediction || {}, method); const correctness = Object.entries(scores).filter(([field]) => field.endsWith('Correct')).every(([, value]) => value === true); return { ...row, ...scores, allCorrect: correctness }; }); return [method, { n: scored.length, completed: scored.filter((row) => !row.error).length, jsonValidRate: rate(scored, 'jsonValid'), allCorrectRate: rate(scored, 'allCorrect'), ...Object.fromEntries(['selectionCorrect','dependencyCorrect','resultCorrect','privacyCorrect','causeCorrect','layerCorrect','blockedCorrect','evidenceCorrect','routeCorrect','recipientCorrect','negativeTransfer'].filter((field) => scored.some((row) => Object.hasOwn(row, field))).map((field) => [`${field}Rate`, rate(scored, field)])) }]; })); }
function evidenceSupported(refs, gold) { const values = Array.isArray(refs) ? refs.map((value) => String(value || '').toLowerCase().trim()).filter((value) => value && value !== 'none' && value !== 'null') : []; if (gold.blocked) return values.length === 0; if (!values.length) return false; const terms = { task_decomposition_error: ['plan','omitted','subtask'], recipient_selection_error: ['selected recipient','profile','deliverable'], stale_capability_profile: ['archived','revision 1','revision 4'], dependency_order_error: ['dependent','prerequisite'], individual_capability_gap: ['recipient','rubric','three times'], external_tool_failure: ['external service','http 503'], requirement_change_invalidated_result: ['requirement revision','invalidated','superseded'] }[gold.causes?.[0]] || []; return values.some((value) => value === String(gold.evidence_refs?.[0] || '').toLowerCase() || terms.some((term) => value.includes(term))); }
function sameSet(left, right) { return JSON.stringify([...(Array.isArray(left) ? new Set(left) : [])].sort()) === JSON.stringify([...(Array.isArray(right) ? new Set(right) : [])].sort()); }
function rate(rows, field) { return rows.length ? rows.filter((row) => row[field] === true).length / rows.length : 0; }
function normalize(value) { return JSON.parse(JSON.stringify(value, Object.keys(value || {}).sort())); }
function metricCoreMatches(recordedGroup, recomputedGroup) { return Object.keys(recomputedGroup).every((method) => { const left = recordedGroup?.[method] || {}; const right = recomputedGroup[method] || {}; return ['n','completed','jsonValidRate','allCorrectRate','selectionCorrectRate','dependencyCorrectRate','resultCorrectRate','privacyCorrectRate','causeCorrectRate','layerCorrectRate','blockedCorrectRate','evidenceCorrectRate','routeCorrectRate','recipientCorrectRate','negativeTransferRate'].every((field) => left[field] === undefined || left[field] === right[field]); }); }
async function readJsonl(filename) { return (await fs.readFile(filename, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
