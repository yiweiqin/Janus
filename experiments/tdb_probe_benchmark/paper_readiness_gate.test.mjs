import test from 'node:test';
import assert from 'node:assert/strict';
import { audit } from './paper_readiness_gate.mjs';

test('synthetic run is accepted only for method/protocol evidence', async () => {
  const result = await audit('experiments/tdb_probe_benchmark/runs/review-v3-stats/seed-20260907');
  assert.equal(result.readyForSyntheticMethodSection, true);
  assert.equal(result.readyForRealGeneralizationClaim, false);
  assert.ok(result.blockers.some(x => x.check === 'realIndependentEvaluator'));
  assert.ok(result.blockers.some(x => x.check === 'stateGold'));
});

test('real-claim gate requires every evidence class', async () => {
  const result = await audit('experiments/tdb_probe_benchmark/runs/multitask-reference-v3');
  assert.equal(result.readyForRealGeneralizationClaim, false);
  assert.ok(result.blockers.length >= 8);
});

