import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessDecisionSufficiency } from '../../src/shared/contracts/uBuddyDecisionSufficiency.js';

const input = () => ({ query: 'consume', allowedActions: ['accept', 'wait'], epsilon: 0,
  coverage: { complete: true, basisRef: 'model-v1' }, worlds: [
    { id: 'private-a', support: true, safe: { accept: true, wait: true }, utility: { accept: 2, wait: 1 } },
    { id: 'private-b', support: true, safe: { accept: true, wait: true }, utility: { accept: 3, wait: 1 } },
  ] });
test('certifies only a safe common action under explicit finite coverage', () => {
  const result = assessDecisionSufficiency(input());
  assert.equal(result.status, 'CERTIFIED'); assert.equal(result.action, 'accept');
  assert.equal(Object.hasOwn(result, 'worlds'), false); assert.equal(JSON.stringify(result).includes('private-'), false);
});
test('unknown coverage/utility/contract is not converted into a certificate', () => {
  assert.equal(assessDecisionSufficiency({ ...input(), coverage: undefined }).reason, 'coverage_unknown');
  assert.equal(assessDecisionSufficiency({ ...input(), worlds: [{ ...input().worlds[0], support: false }] }).reason, 'support_incomplete');
  const bad = input(); delete bad.worlds[0].safe.wait;
  assert.equal(assessDecisionSufficiency(bad).reason, 'contract_incomplete');
});
test('contradictory declared evidence is conflict while action ambiguity is unknown', () => {
  const conflict = input(); conflict.worlds[0].evidenceConflict = true;
  assert.equal(assessDecisionSufficiency(conflict).status, 'CONFLICT');
  const ambiguous = input(); ambiguous.worlds[1].utility = { accept: 0, wait: 3 };
  assert.equal(assessDecisionSufficiency(ambiguous).reason, 'action_ambiguity');
});

test('initial observation conditions the finite world catalog', () => {
  const result = assessDecisionSufficiency({ ...input(), initial: { phase: 'ready' }, worlds: [
    { ...input().worlds[0], values: { phase: 'ready' } },
    { ...input().worlds[1], values: { phase: 'blocked' }, utility: { accept: 99, wait: 0 } },
  ] });
  assert.equal(result.status, 'CERTIFIED');
  assert.equal(result.worldCount, 1);
  assert.equal(assessDecisionSufficiency({ ...input(), initial: { phase: 'missing' }, worlds: input().worlds }).reason, 'initial_observation_inconsistent');
});

test('risk is required only for safe actions', () => {
  const worlds = [{ id: 'w', support: true, safe: { accept: true, wait: false }, utility: { accept: 1, wait: 100 }, risk: { accept: 0.1 } }];
  const result = assessDecisionSufficiency({ ...input(), worlds, riskBudget: 0.1 });
  assert.equal(result.status, 'CERTIFIED');
  assert.equal(result.action, 'accept');
});

test('optional risk budget selects a slightly higher-regret action within budget', () => {
  const result = assessDecisionSufficiency({ ...input(), epsilon: 2, riskBudget: 0.2,
    worlds: input().worlds.map((w, i) => ({ ...w, risk: { accept: i ? 0.8 : 0.1, wait: 0.1 } })) });
  assert.equal(result.status, 'CERTIFIED'); assert.equal(result.action, 'wait');
  assert.equal(result.riskBound, 0.1); assert.equal(result.riskBudget, 0.2);
});

test('risk budget is conservative for missing, invalid, or infeasible risk', () => {
  assert.equal(assessDecisionSufficiency({ ...input(), riskBudget: 1 }).reason, 'risk_incomplete');
  assert.equal(assessDecisionSufficiency({ ...input(), riskBudget: -1 }).reason, 'risk_budget_invalid');
  const worlds = input().worlds.map(w => ({ ...w, risk: { accept: 2, wait: 3 } }));
  assert.equal(assessDecisionSufficiency({ ...input(), worlds, riskBudget: 1, epsilon: 2 }).reason, 'risk_budget_infeasible');
});
