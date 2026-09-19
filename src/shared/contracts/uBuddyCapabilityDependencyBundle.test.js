import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attributeAfterSwap,
  dependencyScore,
  forbidCombinedScore,
  selectCollaborators,
  selectReplacement,
  similarityScore,
  updateDependencyScore,
} from './uBuddyCapabilityDependencyBundle.js';

const A = { agentId: 'A', capabilityTags: ['research', '信息整理'], deliverableTypes: ['spreadsheet'], supportedTaskTypes: ['research'] };
const B = { agentId: 'B', capabilityTags: ['research', '信息整理', 'source_verify'], deliverableTypes: ['spreadsheet'], supportedTaskTypes: ['research'] };
const C = { agentId: 'C', capabilityTags: ['writing', '文案'], deliverableTypes: ['report'], supportedTaskTypes: ['writing'] };
const D = { agentId: 'D', capabilityTags: ['ppt', '图表'], deliverableTypes: ['presentation'], supportedTaskTypes: ['presentation'] };
const E = { agentId: 'E', capabilityTags: ['ppt', '图表', '设计'], deliverableTypes: ['presentation'], supportedTaskTypes: ['presentation'] };
const F = { agentId: 'F', capabilityTags: ['code', 'backend'], deliverableTypes: ['code_change'], supportedTaskTypes: ['code_change'] };

test('dependency and similarity stay separate and peak on different pairs', () => {
  assert.ok(dependencyScore(A, C) > dependencyScore(A, F));
  assert.ok(dependencyScore(A, C) > similarityScore(A, C));
  assert.ok(similarityScore(A, B) > similarityScore(A, C));
  assert.ok(similarityScore(D, E) > dependencyScore(D, E));
  assert.equal(forbidCombinedScore(0.8, 0.2).combined, null);
});

test('planning uses dependency; replacement uses similarity', () => {
  const collab = selectCollaborators([A, D, F], C, { limit: 1 });
  assert.equal(collab[0].profile.agentId, 'A');
  const swap = selectReplacement(A, [B, C, D, E, F], { limit: 1 });
  assert.equal(swap[0].profile.agentId, 'B');
});

test('successful cooperation increments decay; similar swap isolates the skill gap', () => {
  const first = updateDependencyScore(0.4, 1, 0);
  const later = updateDependencyScore(0.4, 1, 8);
  assert.ok(first - 0.4 > later - 0.4);
  const attributed = attributeAfterSwap({
    baselineUtility: 0.40, similarUtility: 0.82, randomUtility: 0.44,
    failedProfile: A, similarProfile: B,
  });
  assert.equal(attributed.decision, 'attribute_capability_gap');
  assert.ok(attributed.gap.onlyRight.includes('source_verify'));
  const handback = attributeAfterSwap({
    baselineUtility: 0.40, similarUtility: 0.41, randomUtility: 0.39,
    failedProfile: A, similarProfile: B,
  });
  assert.equal(handback.decision, 'hand_back_to_rdmd');
});
