import {
  dependencyScore,
  similarityScore,
} from '../../../src/shared/contracts/uBuddyCapabilityDependencyBundle.js';
import { quantizeScore } from './rng.mjs';

export function buildPairs({ agents, profiles, rng, smoke = false }) {
  const liteById = new Map(profiles.map((profile) => [profile.uBuddyAgentInstanceId, profile]));
  const byOwner = group(agents, (agent) => agent.ownerUserId);
  const byFamily = group(agents, (agent) => agent.familyId);
  const seen = new Map();
  const pairs = [];

  for (const agent of agents) {
    for (const other of byOwner.get(agent.ownerUserId) || []) {
      addPair(pairs, seen, agent, other, 'within_owner_directed', liteById);
    }
  }

  for (const agent of agents) {
    const twins = (byFamily.get(agent.familyId) || []).filter((other) => (
      other.id !== agent.id
      && other.facetId !== agent.facetId
      && other.ownerUserId !== agent.ownerUserId
    ));
    const similar = twins
      .map((other) => ({ other, score: teacherSimilarity(agent, other) }))
      .sort((a, b) => b.score - a.score || a.other.id.localeCompare(b.other.id));
    for (const item of similar.slice(0, smoke ? 1 : 4)) {
      addPair(pairs, seen, agent, item.other, 'cross_owner_similar', liteById);
    }
    const complements = agents.filter((other) => other.id !== agent.id && other.familyId !== agent.familyId);
    const ranked = complements
      .map((other) => ({ other, score: teacherDependency(agent, other) }))
      .sort((a, b) => b.score - a.score || a.other.id.localeCompare(b.other.id));
    for (const item of ranked.slice(0, smoke ? 1 : 4)) {
      addPair(pairs, seen, agent, item.other, 'cross_owner_complement', liteById);
    }
  }

  for (const agent of agents) {
    const twins = (byFamily.get(agent.familyId) || [])
      .filter((other) => other.id !== agent.id && other.facetId !== agent.facetId)
      .map((other) => ({
        other,
        score: teacherSimilarity(agent, other),
        gap: symmetricGap(agent.detailCapabilities, other.detailCapabilities).length,
      }))
      .filter((item) => item.gap >= 1 && item.gap <= 4)
      .sort((a, b) => b.score - a.score || a.other.id.localeCompare(b.other.id));
    for (const item of twins.slice(0, smoke ? 1 : 2)) {
      addPair(pairs, seen, agent, item.other, 'facet_twin', liteById);
    }
  }

  const negativeCount = smoke ? 1 : 2;
  for (const agent of agents) {
    const pool = agents.filter((other) => other.familyId !== agent.familyId && other.orgId !== agent.orgId);
    for (const other of rng.sample(pool, negativeCount)) {
      addPair(pairs, seen, agent, other, 'hard_negative', liteById);
    }
  }

  return pairs;
}

export function teacherDependency(left, right) {
  if (!left || !right || left.id === right.id) return 0;
  if (!right.consumes?.length) return 0;
  const produced = new Set(left.produces || []);
  const hit = (right.consumes || []).filter((item) => produced.has(item)).length;
  let score = hit / right.consumes.length;
  if (left.familyId === right.familyId) score *= 0.2;
  if (left.domain && left.domain === right.domain) score += 0.08;
  if (left.orgId === right.orgId) score += 0.04;
  return clamp(score);
}

export function teacherSimilarity(left, right) {
  if (!left || !right || left.id === right.id) return 0;
  const family = left.familyId === right.familyId ? 0.62 : 0.05;
  const facet = left.familyId === right.familyId && left.facetId === right.facetId ? 0.28 : 0;
  const detail = jaccard(left.detailCapabilities, right.detailCapabilities) * 0.22;
  const tags = jaccard(left.capabilityTags, right.capabilityTags) * 0.16;
  const domain = left.domain === right.domain ? 0.06 : 0;
  return clamp(family + facet + detail + tags + domain);
}

export function annotationCard(pair, left, right) {
  return {
    id: pair.id,
    split: pair.split,
    kind: pair.kind,
    left: cardSide(left),
    right: cardSide(right),
    questions: {
      dependency: '规划时，左方产出是否适合作为右方输入？（不要看他们像不像）',
      similarity: '若左方执行不佳，右方是否适合做最小能力改动的替换？（不要看他们是否该协作）',
    },
    scale: [0, 0.25, 0.5, 0.75, 1],
    teacher: {
      dependency: pair.initDependency,
      similarity: pair.initSimilarity,
    },
    human: {
      dependency: null,
      similarity: null,
      annotatorId: null,
      rationale: null,
    },
  };
}

function addPair(pairs, seen, left, right, kind, liteById) {
  if (!left || !right || left.id === right.id) return;
  const id = `${left.id}>${right.id}`;
  const resolved = kind;
  const isTwin = left.familyId === right.familyId && left.facetId !== right.facetId;
  const existing = seen.get(id);
  if (existing) {
    if (isTwin) existing.isTwin = true;
    return;
  }
  const leftLite = liteOf(liteById.get(left.id), left);
  const rightLite = liteOf(liteById.get(right.id), right);
  const initDependency = quantizeScore(teacherDependency(left, right));
  const initSimilarity = quantizeScore(teacherSimilarity(left, right));
  const pair = {
    id,
    kind: resolved,
    isTwin,
    leftAgentId: left.id,
    rightAgentId: right.id,
    leftOwnerId: left.ownerUserId,
    rightOwnerId: right.ownerUserId,
    leftFamily: left.familyId,
    rightFamily: right.familyId,
    leftFacet: left.facetId,
    rightFacet: right.facetId,
    orgId: left.orgId === right.orgId ? left.orgId : `${left.orgId}|${right.orgId}`,
    initDependency,
    initSimilarity,
    contractDependency: round4(dependencyScore(leftLite, rightLite)),
    contractSimilarity: round4(similarityScore(leftLite, rightLite)),
    // 这里**故意不放 `combined`**：`schema.json` 的 `forbidden.combinedScore` 与
    // `gates.mjs` 都禁止合成总分，而一个恒为 null 的键只会让人以为"本来该有个总分"。
    humanDependency: null,
    humanSimilarity: null,
    annotatorId: null,
    rationale: null,
    capabilityGap: {
      onlyLeft: diff(left.detailCapabilities, right.detailCapabilities),
      onlyRight: diff(right.detailCapabilities, left.detailCapabilities),
    },
  };
  seen.set(id, pair);
  pairs.push(pair);
}

function liteOf(profile, agent) {
  return {
    agentId: agent.id,
    capabilityTags: profile?.capabilityTags || agent.capabilityTags,
    supportedTaskTypes: profile?.supportedTaskTypes || agent.supportedTaskTypes,
    deliverableTypes: profile?.deliverableTypes || agent.deliverableTypes,
  };
}

function cardSide(agent) {
  return {
    agentId: agent.id,
    ownerUserId: agent.ownerUserId,
    ownerName: agent.ownerDisplayName,
    name: agent.name,
    family: agent.familyTitle,
    facet: agent.facetName,
    tags: agent.capabilityTags,
    produces: agent.produces,
    consumes: agent.consumes,
    skillDigest: (agent.preferredTasks || [])[0] || '',
  };
}

function group(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key) || [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

function symmetricGap(left = [], right = []) {
  return unique([...diff(left, right), ...diff(right, left)]);
}

function diff(left = [], right = []) {
  const other = new Set(right);
  return (left || []).filter((item) => !other.has(item));
}

function jaccard(left = [], right = []) {
  const a = new Set(left || []);
  const b = new Set(right || []);
  if (!a.size && !b.size) return 0;
  const inter = [...a].filter((item) => b.has(item)).length;
  return inter / (a.size + b.size - inter);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function clamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function round4(value) {
  return Math.round(clamp(value) * 10000) / 10000;
}
