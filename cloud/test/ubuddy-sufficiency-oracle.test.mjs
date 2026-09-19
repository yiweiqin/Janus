import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessDecisionSufficiency } from '../../src/shared/contracts/uBuddyDecisionSufficiency.js';

const base = (worlds, actions = ['a', 'b'], epsilon = 0) => ({
  query: 'q', allowedActions: actions, worlds, epsilon,
  coverage: { complete: true, basisRef: 'oracle-v1' },
});

function oracle({ worlds, actions, epsilon }) {
  const rows = actions.map(action => {
    let worst = -Infinity;
    for (const world of worlds) {
      const feasible = actions.filter(candidate => world.safe[candidate]);
      if (!feasible.length) return null;
      const best = Math.max(...feasible.map(candidate => world.utility[candidate]));
      if (!world.safe[action]) return Infinity;
      worst = Math.max(worst, best - world.utility[action]);
    }
    return { action, worst };
  }).filter(row => Number.isFinite(row.worst) && row.worst <= epsilon)
    .sort((x, y) => x.worst - y.worst || x.action.localeCompare(y.action));
  return rows[0] ?? null;
}

function runOracleCase(worlds, actions, epsilon) {
  const expected = oracle({ worlds, actions, epsilon });
  const result = assessDecisionSufficiency(base(worlds, actions, epsilon));
  if (!expected) assert.equal(result.status, 'UNKNOWN');
  else {
    assert.equal(result.status, 'CERTIFIED');
    assert.equal(result.action, expected.action);
    assert.equal(result.regretBound, expected.worst);
  }
}

test('unsafe high utility can never become the per-world optimum', () => {
  runOracleCase([
    { id: 'w1', support: true, safe: { a: true, b: true }, utility: { a: 2, b: 1 } },
    { id: 'w2', support: true, safe: { a: true, b: false }, utility: { a: 0, b: 100 } },
  ], ['a', 'b'], 0);
});

test('an action safe in only some worlds is rejected even at large epsilon', () => {
  runOracleCase([
    { id: 'w1', support: true, safe: { a: true, b: true }, utility: { a: 4, b: 3 } },
    { id: 'w2', support: true, safe: { a: false, b: true }, utility: { a: 100, b: 2 } },
  ], ['a', 'b'], 1_000);
});

test('epsilon boundary is inclusive and just-below boundary is unknown', () => {
  const worlds = [
    { id: 'w1', support: true, safe: { a: true, b: true }, utility: { a: 5, b: 3 } },
    { id: 'w2', support: true, safe: { a: true, b: true }, utility: { a: 0, b: 3 } },
  ];
  const at = assessDecisionSufficiency(base(worlds, ['a', 'b'], 2));
  assert.equal(at.status, 'CERTIFIED'); assert.equal(at.action, 'b'); assert.equal(at.regretBound, 2);
  const below = assessDecisionSufficiency(base(worlds, ['b', 'a'], 1.999));
  assert.equal(below.status, 'UNKNOWN'); assert.equal(below.reason, 'action_ambiguity');
});

test('equal regret uses deterministic lexicographic tie break', () => {
  const worlds = [
    { id: 'w1', support: true, safe: { alpha: true, beta: true }, utility: { alpha: 1, beta: 1 } },
    { id: 'w2', support: true, safe: { alpha: true, beta: true }, utility: { alpha: 1, beta: 1 } },
  ];
  const result = assessDecisionSufficiency(base(worlds, ['beta', 'alpha'], 0));
  assert.equal(result.status, 'CERTIFIED'); assert.equal(result.action, 'alpha'); assert.equal(result.regretBound, 0);
});

test('differential oracle agrees across deterministic utility/safety catalog', () => {
  let seed = 17;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  for (let n = 0; n < 80; n += 1) {
    const actions = ['a', 'b', 'c'];
    const worlds = Array.from({ length: 1 + (next() % 4) }, (_, i) => {
      const safe = Object.fromEntries(actions.map(a => [a, (next() % 3) !== 0]));
      if (!Object.values(safe).some(Boolean)) safe.a = true;
      const utility = Object.fromEntries(actions.map(a => [a, (next() % 11) - 5]));
      return { id: `w${i}`, support: true, safe, utility };
    });
    const epsilon = (next() % 5) / 2;
    runOracleCase(worlds, actions, epsilon);
  }
});

test('malformed models remain UNKNOWN rather than yielding a certificate', () => {
  const worlds = [{ id: 'w', support: true, safe: { a: true, b: true }, utility: { a: 1, b: 0 } }];
  for (const malformed of [
    { ...base(worlds), epsilon: NaN },
    { ...base(worlds), allowedActions: ['a', 'a'] },
    { ...base(worlds), worlds: [{ ...worlds[0], utility: { a: 1 } }] },
    { ...base(worlds), worlds: [{ ...worlds[0], safe: { a: true } }] },
  ]) assert.equal(assessDecisionSufficiency(malformed).status, 'UNKNOWN');
});

