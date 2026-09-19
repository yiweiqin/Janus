import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMinimumDisclosure } from '../../src/shared/contracts/uBuddyDisclosureFrontier.js';

const binding = { scope: 'oracle', version: 'v1', query: 'decision' };

// Deliberately independent oracle: it enumerates every disclosure and does not
// call or share helpers with the production search implementation.
function oracle(input) {
  const worlds = input.worlds; const units = input.units; const eps = input.epsilon;
  const interval = worlds.some(w => w.utilityInterval);
  const actions = [...new Set(worlds.flatMap(w => Object.keys(w.utilities ?? w.utilityInterval ?? {})))].sort();
  const value = (w, a) => {
    const v = (w.utilityInterval?.[a] ?? w.utilities?.[a]);
    if (typeof v === 'number') return [v, v];
    return Array.isArray(v) ? [v[0], v[1]] : [v.lower ?? v.min, v.upper ?? v.max];
  };
  const feasible = mask => {
    const blocks = new Map();
    for (const w of worlds) {
      const key = units.map((u, i) => mask & (1 << i) ? `${u.id}=${JSON.stringify(w.values?.[u.id])}` : '').join('|');
      if (!blocks.has(key)) blocks.set(key, []); blocks.get(key).push(w);
    }
    for (const block of blocks.values()) {
      const common = actions.find(a => block.every(w => {
        if (w.support !== true || w.safe?.[a] !== true) return false;
        const candidate = value(w, a); if (!candidate || candidate.some(x => !Number.isFinite(x))) return false;
        const competitors = actions.filter(b => b !== a && w.safe?.[b] === true).map(b => value(w, b)?.[interval ? 1 : 0]).filter(Number.isFinite);
        const best = competitors.length ? Math.max(...competitors) : candidate[0];
        return Math.max(0, best - candidate[0]) <= eps;
      }));
      if (!common) return false;
    }
    return true;
  };
  let best = null; const n = units.length;
  for (let mask = 0; mask < (1 << n); mask++) {
    if (!feasible(mask)) continue;
    const selected = units.filter((_, i) => mask & (1 << i)).map(u => u.id).sort();
    const cost = units.reduce((s, u, i) => s + ((mask & (1 << i)) ? u.cost : 0), 0);
    const candidate = { selected, cost };
    if (!best || cost < best.cost || (cost === best.cost && (selected.length < best.selected.length || (selected.length === best.selected.length && selected.join('\0') < best.selected.join('\0'))))) best = candidate;
  }
  return best;
}

function seeded(seed) { let x = seed >>> 0; return () => ((x = Math.imul(x ^ (x >>> 15), 2246822519) + 3266489917) >>> 0) / 4294967296; }
function catalog(seed, interval = false) {
  const r = seeded(seed); const worlds = []; const actions = ['a', 'b', 'c'];
  for (let i = 0; i < 4; i++) {
    const best = i % 3; const utilities = {}; const utilityInterval = {};
    for (let j = 0; j < actions.length; j++) { const p = j === best ? 3 : (j + i) % 2; if (interval) utilityInterval[actions[j]] = { lower: p - 0.2, upper: p + 0.2 }; else utilities[actions[j]] = p; }
    worlds.push({ id: `w${i}`, support: true, values: { u0: i % 2, u1: (i + seed) % 3, u2: i % 2 ? 'x' : 'y' }, ...(interval ? { utilityInterval } : { utilities }), safe: { a: true, b: true, c: true } });
  }
  return { binding, currentWorldId: 'w0', initial: {}, epsilon: interval ? 0.5 : 0, worlds, units: ['u0', 'u1', 'u2'].map((id, i) => ({ id, cost: i + 1, allowed: true })) };
}

test('exact disclosure solver agrees with an independent exhaustive oracle', () => {
  let cases = 0;
  for (let seed = 1; seed <= 20; seed++) for (const interval of [false, true]) {
    const input = catalog(seed, interval); const got = findMinimumDisclosure(input); const expected = oracle(input); cases++;
    assert.equal(got.status, expected ? 'CERTIFIED' : 'UNKNOWN', `seed=${seed} interval=${interval}`);
    if (expected) { assert.deepEqual(got.selectedUnits, expected.selected); assert.equal(got.disclosureCost, expected.cost); }
  }
  assert.equal(cases, 40);
});

test('oracle handles duplicate signatures, zero costs, and a triple conflict', () => {
  const input = { binding, currentWorldId: 'w1', initial: {}, epsilon: 0, worlds: [
    { id: 'w1', support: true, values: { x: 'a', y: 'a', z: 0 }, utilities: { a: 3, b: 0, c: 0 }, safe: { a: true, b: true, c: true } },
    { id: 'w2', support: true, values: { x: 'b', y: 'b', z: 1 }, utilities: { a: 0, b: 3, c: 0 }, safe: { a: true, b: true, c: true } },
    { id: 'w3', support: true, values: { x: 'c', y: 'c', z: 2 }, utilities: { a: 0, b: 0, c: 3 }, safe: { a: true, b: true, c: true } },
  ], units: [{ id: 'x', cost: 0, allowed: true }, { id: 'y', cost: 0, allowed: true }, { id: 'z', cost: 2, allowed: true }] };
  const expected = oracle(input); const got = findMinimumDisclosure(input);
  assert.deepEqual(expected, { selected: ['x'], cost: 0 }); assert.deepEqual(got.selectedUnits, ['x']); assert.equal(got.disclosureCost, 0);
});

test('simple distinct-value-per-cost greedy can lose to the exact optimum', () => {
  const input = { binding, currentWorldId: 'w1', initial: {}, epsilon: 0, worlds: [
    { id: 'w1', support: true, values: { trap: 'A', key: 0 }, utilities: { a: 3, b: 0 }, safe: { a: true, b: true } },
    { id: 'w2', support: true, values: { trap: 'B', key: 0 }, utilities: { a: 3, b: 0 }, safe: { a: true, b: true } },
    { id: 'w3', support: true, values: { trap: 'B', key: 1 }, utilities: { a: 0, b: 3 }, safe: { a: true, b: true } },
    { id: 'w4', support: true, values: { trap: 'C', key: 1 }, utilities: { a: 0, b: 3 }, safe: { a: true, b: true } },
  ], units: [{ id: 'trap', cost: 1, allowed: true }, { id: 'key', cost: 2, allowed: true }] };
  const exact = findMinimumDisclosure(input); const expected = oracle(input);
  let selected = []; let remaining = input.units.slice();
  while (remaining.length) {
    remaining.sort((x, y) => ((new Set(input.worlds.map(w => JSON.stringify(w.values[x.id]))).size - 1) / x.cost) < ((new Set(input.worlds.map(w => JSON.stringify(w.values[y.id]))).size - 1) / y.cost) ? 1 : -1);
    const pick = remaining.shift(); selected.push(pick.id);
    const trial = { ...input, units: input.units.filter(u => selected.includes(u.id)) };
    if (oracle(trial)) break;
  }
  const greedyCost = selected.reduce((s, id) => s + input.units.find(u => u.id === id).cost, 0);
  assert.deepEqual(expected, { selected: ['key'], cost: 2 }); assert.deepEqual(exact.selectedUnits, ['key']); assert.equal(greedyCost, 3);
  assert.ok(greedyCost > expected.cost);
});

test('interval uncertainty and malformed support remain UNKNOWN', () => {
  const input = catalog(7, true); input.worlds[2].utilityInterval.c = { lower: 1, upper: 0 };
  const got = findMinimumDisclosure(input); assert.equal(got.status, 'UNKNOWN'); assert.equal(got.reason, 'utility_interval_invalid');
  const unsupported = catalog(8, false); unsupported.worlds[0].support = false;
  assert.equal(findMinimumDisclosure(unsupported).status, 'UNKNOWN');
});
