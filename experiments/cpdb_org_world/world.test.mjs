import assert from 'node:assert/strict';
import test from 'node:test';
import {
  forbidCombinedScore,
  selectCollaborators,
  selectReplacement,
} from '../../src/shared/contracts/uBuddyCapabilityDependencyBundle.js';
import { generateWorld } from './generate.mjs';
import { teacherDependency, teacherSimilarity } from './lib/pairs.mjs';
import { AGENTS_PER_PERSON, ORG_COUNT, PEOPLE_PER_ORG } from './lib/catalog.mjs';
import { liteProfile } from './lib/profiles.mjs';

test('smoke world has one uBuddy and five specialists per person', () => {
  const world = generateWorld({ smoke: true });
  assert.equal(world.validation.ok, true, world.validation.errors.join(','));
  assert.equal(world.people.length, 4);
  assert.equal(world.agents.length, 20);
  assert.equal(world.ubuddyProfiles.length, 4);
  for (const person of world.people) {
    assert.equal(person.agentIds.length, AGENTS_PER_PERSON);
    const mine = world.agents.filter((agent) => agent.ownerUserId === person.id);
    assert.equal(mine.length, 5);
    assert.equal(new Set(mine.map((agent) => agent.skillHash)).size, 5);
    assert.ok(mine.some((agent) => agent.twin));
    assert.ok(new Set(mine.map((agent) => agent.familyId)).size >= 3);
    const ubuddy = world.ubuddyProfiles.find((profile) => profile.uBuddyAgentInstanceId === person.ubuddyId);
    assert.ok(ubuddy);
    assert.deepEqual(ubuddy.extra.sourceAgentIds, person.agentIds);
    const union = new Set(mine.flatMap((agent) => agent.capabilityTags));
    assert.ok(ubuddy.capabilityTags.some((tag) => union.has(tag)));
    assert.ok(ubuddy.introduction.includes(person.displayName));
  }
});

test('same family is similar; complementary families are dependent', () => {
  const world = generateWorld({ smoke: true });
  const research = world.agents.find((agent) => agent.familyId === 'research');
  const writing = world.agents.find((agent) => agent.familyId === 'writing');
  const otherResearch = world.agents.find((agent) => agent.familyId === 'research' && agent.id !== research.id);
  assert.ok(research && writing && otherResearch);
  assert.ok(teacherDependency(research, writing) > teacherSimilarity(research, writing));
  assert.ok(teacherSimilarity(research, otherResearch) > teacherDependency(research, otherResearch));
  assert.ok(teacherDependency(research, writing) > teacherDependency(research, otherResearch));
});

test('planning uses dependency and replacement uses similarity', () => {
  const world = generateWorld({ smoke: true });
  const lites = world.agentProfiles.map(liteProfile).filter((profile) => profile.familyId);
  const sink = lites.find((profile) => profile.familyId === 'writing');
  const failed = lites.find((profile) => profile.familyId === 'research');
  assert.ok(sink && failed);
  const collab = selectCollaborators(lites, sink, { limit: 1 });
  const swap = selectReplacement(failed, lites, { limit: 1 });
  assert.ok(collab[0].score > 0);
  assert.ok(swap[0].score > 0);
  assert.ok(collab[0].profile.capabilityTags.some((tag) => ['research', 'data', '信息整理', '数据'].includes(tag)));
  assert.ok(swap[0].profile.capabilityTags.some((tag) => failed.capabilityTags.includes(tag)));
  assert.equal(forbidCombinedScore(collab[0].score, swap[0].score).combined, null);
});

test('facet twins differ by a detail capability and pairs never combine scores', () => {
  const world = generateWorld({ smoke: true });
  const twins = world.pairs.filter((pair) => pair.isTwin);
  assert.ok(twins.length > 0);
  for (const pair of twins.slice(0, 8)) {
    // 契约禁止合成总分 —— 这个键必须完全不存在，否则会诱导下游去填它。
    assert.ok(!('combined' in pair), 'pair 不该带 combined 键');
    assert.ok(pair.initSimilarity >= pair.initDependency);
    const gap = [...pair.capabilityGap.onlyLeft, ...pair.capabilityGap.onlyRight];
    assert.ok(gap.length >= 1);
  }
  assert.ok(world.pairs.every((pair) => !('combined' in pair)), 'pairs.jsonl 里不该有任何 combined 键');
  assert.ok(world.cards.every((card) => card.human.dependency == null && card.questions.dependency.includes('规划')));
});

test('full world is large enough to train an 8B pair scorer', () => {
  const world = generateWorld({ smoke: false });
  assert.equal(world.validation.ok, true, world.validation.errors.join(','));
  assert.equal(world.orgs.length, ORG_COUNT);
  assert.equal(world.people.length, ORG_COUNT * PEOPLE_PER_ORG);
  assert.equal(world.agents.length, ORG_COUNT * PEOPLE_PER_ORG * AGENTS_PER_PERSON);
  assert.ok(world.pairs.length >= 8000);
  assert.ok(world.manifest.splits.train > world.manifest.splits.test);
  assert.ok(world.manifest.splits.test > 0);
  assert.ok(world.manifest.splits.development > 0);
  assert.ok(world.manifest.pairKinds.within_owner_directed > 0);
  assert.ok(world.manifest.pairKinds.cross_owner_similar > 0);
  assert.ok(world.manifest.pairKinds.cross_owner_complement > 0);
});
