import test from 'node:test';
import assert from 'node:assert/strict';
import { solveDisclosureFrontier, rankInterventions, disclosureMonotonicityCertificate, selectInterventionPortfolio, certifySubmodularity, solveAdaptiveDisclosure, certifyAdaptiveDisclosurePolicy, disclosureValueOfInformation, identifyCauseEquivalenceClass } from './academic_methods.mjs';

test('disclosure solver finds minimum sufficient set under privacy budget', () => {
  const r = solveDisclosureFrontier({
    units: [{ id: 'a', cost: 1, privacyLoss: .2 }, { id: 'b', cost: 2, privacyLoss: .2 }],
    actions: ['x', 'y'], epsilon: 0,
    worlds: [
      { observation: { a: 0, b: 0 }, utility: { x: 1, y: 0 } },
      { observation: { a: 1, b: 0 }, utility: { x: 0, y: 1 } }
    ]
  });
  assert.deepEqual(r.optimum.selectedUnits, ['a']);
});

test('ranking uses lower confidence bound and retains interaction', () => {
  const r = rankInterventions({ candidates: [{ id: 'e', upliftMean: 1, upliftSE: .1, cost: 1, jointUplift: 2, aUplift: .4, bUplift: .5 }] });
  assert.equal(r.candidates[0].interaction, 1.1);
  assert.ok(r.candidates[0].lcb < 1);
  assert.equal(r.candidates[0].recommendation, 'ABSTAIN');
});

test('disclosure monotonicity certificate rejects privacy-budget violations', () => {
  const r = disclosureMonotonicityCertificate({ base: { disclosureCost: 1, privacyLoss: .2, worstCaseRegret: .4 }, extension: { disclosureCost: 2, privacyLoss: 1.2, worstCaseRegret: .1 }, privacyBudget: 1 });
  assert.equal(r.certified, false);
});

test('portfolio selector is conservative when submodularity is not declared', () => {
  const r = selectInterventionPortfolio({ candidates: [{ id: 'a', cost: 1 }], budget: 1, gain: () => 1 });
  assert.equal(r.status, 'UNKNOWN');
});

test('portfolio selector chooses positive marginal gains under unit budget', () => {
  const r = selectInterventionPortfolio({
    candidates: [{ id: 'a', cost: 1 }, { id: 'b', cost: 1 }], budget: 2,
    declaredSubmodular: true, gain: set => new Set(set.map(x => x.id)).size * 2 - (set.some(x => x.id === 'a') && set.some(x => x.id === 'b') ? 1 : 0)
  });
  assert.deepEqual(r.selected, ['a', 'b']);
  assert.equal(r.approximationBound, 1 - Math.exp(-1));
});

test('submodularity certificate accepts diminishing returns and rejects complementarity', () => {
  const diminishing = certifySubmodularity({ ids: ['a', 'b'], gain: set => set.length ? 1 + (set.length - 1) * .5 : 0 });
  assert.equal(diminishing.status, 'CERTIFIED');
  const complement = certifySubmodularity({ ids: ['a', 'b'], gain: set => set.includes('a') && set.includes('b') ? 3 : set.length });
  assert.equal(complement.status, 'REJECTED');
  assert.equal(complement.submodular, false);
});

test('adaptive disclosure policy stops early on an easy observation branch', () => {
  const r = solveAdaptiveDisclosure({
    units: [{ id: 'signal', cost: 1, privacyLoss: .1, allowed: true }, { id: 'detail', cost: 3, privacyLoss: .1, allowed: true }],
    actions: ['go', 'wait'], epsilon: 0, privacyBudget: 1,
    worlds: [
      { id: 'easy', observation: { signal: 'go', detail: 0 }, utility: { go: 1, wait: 0 }, safe: { go: true, wait: true } },
      { id: 'hard', observation: { signal: 'wait', detail: 1 }, utility: { go: 0, wait: 1 }, safe: { go: true, wait: true } }
    ]
  });
  assert.equal(r.status, 'SOLVED');
  assert.equal(r.policy.type, 'reveal');
  assert.equal(r.policy.unit, 'signal');
  assert.equal(r.expectedDisclosureCost, 1);
});

test('adaptive policy has strictly lower expected cost than static disclosure', () => {
  const worlds = [
    { id: 'easy', observation: { signal: 'easy', detail: 0 }, utility: { go: 1, wait: 0 }, safe: { go: true, wait: true } },
    { id: 'hard-go', observation: { signal: 'hard', detail: 'g' }, utility: { go: 1, wait: 0 }, safe: { go: true, wait: true } },
    { id: 'hard-wait', observation: { signal: 'hard', detail: 'w' }, utility: { go: 0, wait: 1 }, safe: { go: true, wait: true } },
  ];
  const units = [{ id: 'signal', cost: 1, privacyLoss: .1, allowed: true }, { id: 'detail', cost: 4, privacyLoss: .1, allowed: true }];
  const adaptive = solveAdaptiveDisclosure({ units, worlds, actions: ['go', 'wait'], epsilon: 0, prior: { easy: .8, 'hard-go': .1, 'hard-wait': .1 } });
  const staticResult = solveDisclosureFrontier({ units, worlds, actions: ['go', 'wait'], epsilon: 0, privacyBudget: 1 });
  assert.equal(adaptive.status, 'SOLVED');
  assert.equal(staticResult.optimum.disclosureCost, 4);
  assert.ok(adaptive.expectedDisclosureCost < staticResult.optimum.disclosureCost);
});

test('adaptive policy uses worst-case interval regret and abstains when intervals overlap', () => {
  const r = solveAdaptiveDisclosure({
    units: [{ id: 'evidence', cost: 1, privacyLoss: 0, allowed: true }], actions: ['a', 'b'], epsilon: 0,
    worlds: [{ id: 'w', observation: { evidence: 0 }, utilityInterval: { a: [0, 1], b: [0, 1] }, safe: { a: true, b: true } }]
  });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.reason, 'no_regret_feasible_policy');
});

test('adaptive policy is distributionally robust over a declared prior set', () => {
  const r = solveAdaptiveDisclosure({
    units: [{ id: 'signal', cost: 1, privacyLoss: 0, allowed: true }], actions: ['go', 'wait'], epsilon: 0,
    priors: [{ a: .9, b: .1 }, { a: .1, b: .9 }],
    worlds: [
      { id: 'a', observation: { signal: 'a' }, utility: { go: 1, wait: 0 }, safe: { go: true, wait: true } },
      { id: 'b', observation: { signal: 'b' }, utility: { go: 0, wait: 1 }, safe: { go: true, wait: true } }
    ]
  });
  assert.equal(r.status, 'SOLVED');
  assert.equal(r.diagnostics.priorCount, 2);
  assert.equal(r.expectedDisclosureCostByPrior.length, 2);
});

test('disclosure value is marginal regret reduction per cost and privacy loss', () => {
  const r = disclosureValueOfInformation({ beforeRegret: 1, afterRegret: .25, cost: 2, privacyLoss: .5, lambdaPrivacy: 2 });
  assert.equal(r.status, 'DEFINED');
  assert.equal(r.regretReduction, .75);
  assert.equal(r.denominator, 3);
  assert.equal(r.value, .25);
  assert.equal(disclosureValueOfInformation({ beforeRegret: .2, afterRegret: .3, cost: 1 }).status, 'UNKNOWN');
});

test('independent adaptive certificate rejects a tampered policy tree', () => {
  const input = { units: [{ id: 'signal', cost: 1, privacyLoss: .1, allowed: true }], actions: ['go', 'wait'], epsilon: 0, worlds: [
    { id: 'a', observation: { signal: 'a' }, utility: { go: 1, wait: 0 }, safe: { go: true, wait: true } },
    { id: 'b', observation: { signal: 'b' }, utility: { go: 0, wait: 1 }, safe: { go: true, wait: true } }
  ] };
  const solved = solveAdaptiveDisclosure(input);
  assert.equal(certifyAdaptiveDisclosurePolicy({ ...input, policy: solved.policy }).status, 'CERTIFIED');
  const tampered = JSON.parse(JSON.stringify(solved.policy)); tampered.children['"a"'].action = 'wait';
  assert.equal(certifyAdaptiveDisclosurePolicy({ ...input, policy: tampered }).status, 'REJECTED');
});

test('causal attribution returns an equivalence class instead of inventing a unique cause', () => {
  const r = identifyCauseEquivalenceClass({ observed: [1, 0], tolerance: 0, causes: [
    { id: 'agent', signature: [1, 0] }, { id: 'handoff', signature: [1, 0] }, { id: 'version', signature: [0, 1] }
  ] });
  assert.equal(r.status, 'PARTIALLY_IDENTIFIED');
  assert.equal(r.equivalenceClassSize, 2);
});
