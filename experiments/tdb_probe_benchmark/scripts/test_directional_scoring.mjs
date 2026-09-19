import assert from 'node:assert/strict';
import { directionalScore, evolutionPriority } from '../directional_scoring.mjs';
const s = directionalScore({ direction:'accept_result', state:{logic:1,quality:0}, weights:{logic:2,quality:1} });
assert.equal(s.values.logic, 1); assert.equal(s.score, 2/3);
const p = evolutionPriority({ candidateEdgeId:'e1', factors:{impact:1,uncertainty:1,risk:1,coupling:1,repairability:.5,cost:2} });
assert.equal(p.priorityScore, .25); console.log('directional scoring ok');
