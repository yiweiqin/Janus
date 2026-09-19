export const UBUDDY_CPDB_VERSION = 'ubuddy_capability_dependency_bundle_v1';
export const CPDB_SCORE_MIN = 0;
export const CPDB_SCORE_MAX = 1;

const ROLE_TAGS = {
  research: ['research', '研究', '调研', 'analysis', '分析', 'data_collect', '信息整理', '整理'],
  data: ['data', '数据', '清洗', 'dataset', 'spreadsheet'],
  writing: ['writing', '文案', '写作', 'copy', 'report', '报告'],
  ppt: ['ppt', 'presentation', '图表', '设计', 'deck', 'slides'],
  code: ['code', 'backend', '编程', '开发'],
  review: ['review', '验收', '审核', 'source_verify', '来源验证'],
};

const PRODUCES = {
  research: ['notes', 'dataset'],
  data: ['dataset'],
  writing: ['report'],
  ppt: ['presentation'],
  code: ['code_change'],
  review: ['verdict'],
};

const CONSUMES = {
  research: [],
  data: ['notes'],
  writing: ['notes', 'dataset', 'verdict'],
  ppt: ['report', 'dataset', 'notes'],
  code: ['report'],
  review: ['report', 'presentation', 'code_change', 'dataset'],
};

export function normalizeCapabilityProfileLite(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    agentId: text(source.agentId || source.uBuddyAgentInstanceId || source.id, 160),
    capabilityTags: strings(source.capabilityTags),
    supportedTaskTypes: strings(source.supportedTaskTypes),
    deliverableTypes: strings(source.deliverableTypes),
    roles: inferRoles(source),
  };
}

export function dependencyScore(sourceProfile = {}, targetProfile = {}) {
  const source = normalizeCapabilityProfileLite(sourceProfile);
  const target = normalizeCapabilityProfileLite(targetProfile);
  if (!source.agentId || !target.agentId || source.agentId === target.agentId) return 0;
  const produced = new Set(source.roles.flatMap((role) => PRODUCES[role] || []));
  const consumed = new Set(target.roles.flatMap((role) => CONSUMES[role] || []));
  if (!consumed.size) return 0;
  const hit = [...consumed].filter((item) => produced.has(item)).length;
  const deliverableBoost = overlap(source.deliverableTypes, target.supportedTaskTypes) * 0.15;
  return clamp(hit / consumed.size + deliverableBoost);
}

export function similarityScore(leftProfile = {}, rightProfile = {}) {
  const left = normalizeCapabilityProfileLite(leftProfile);
  const right = normalizeCapabilityProfileLite(rightProfile);
  if (!left.agentId || !right.agentId || left.agentId === right.agentId) return 0;
  const tag = jaccard(left.capabilityTags, right.capabilityTags);
  const task = jaccard(left.supportedTaskTypes, right.supportedTaskTypes);
  const deliverable = jaccard(left.deliverableTypes, right.deliverableTypes);
  const role = jaccard(left.roles, right.roles);
  return clamp(0.4 * role + 0.3 * tag + 0.2 * task + 0.1 * deliverable);
}

export function updateDependencyScore(current, positiveSignal = 1, successCount = 0, { eta = 0.12, lambda = 0.45 } = {}) {
  const increment = Number(eta) * Number(positiveSignal) * Math.exp(-Number(lambda) * Math.max(0, Number(successCount) || 0));
  return clamp(Number(current) + increment);
}

export function selectCollaborators(candidates = [], sinkProfile = {}, { limit = 3 } = {}) {
  const sink = normalizeCapabilityProfileLite(sinkProfile);
  return rank(candidates, (profile) => dependencyScore(profile, sink), limit);
}

export function selectReplacement(failedProfile = {}, candidates = {}, { limit = 3 } = {}) {
  const failed = normalizeCapabilityProfileLite(failedProfile);
  const list = Array.isArray(candidates) ? candidates : [];
  return rank(list.filter((profile) => normalizeCapabilityProfileLite(profile).agentId !== failed.agentId),
    (profile) => similarityScore(failed, profile), limit);
}

export function capabilityGap(leftProfile = {}, rightProfile = {}) {
  const left = new Set(normalizeCapabilityProfileLite(leftProfile).capabilityTags);
  const right = new Set(normalizeCapabilityProfileLite(rightProfile).capabilityTags);
  return {
    onlyLeft: [...left].filter((tag) => !right.has(tag)),
    onlyRight: [...right].filter((tag) => !left.has(tag)),
  };
}

export function attributeAfterSwap({
  similarUtility = 0,
  randomUtility = 0,
  baselineUtility = 0,
  failedProfile = {},
  similarProfile = {},
  epsilon = 0.05,
} = {}) {
  const similarLift = Number(similarUtility) - Number(baselineUtility);
  const randomLift = Number(randomUtility) - Number(baselineUtility);
  if (similarLift > epsilon && similarLift > randomLift + epsilon) {
    return {
      decision: 'attribute_capability_gap',
      gap: capabilityGap(failedProfile, similarProfile),
      similarLift,
      randomLift,
    };
  }
  if (similarLift <= epsilon && randomLift <= epsilon) {
    return { decision: 'hand_back_to_rdmd', gap: capabilityGap(failedProfile, similarProfile), similarLift, randomLift };
  }
  return { decision: 'inconclusive', gap: capabilityGap(failedProfile, similarProfile), similarLift, randomLift };
}

export function forbidCombinedScore(dependency, similarity) {
  return { dependency: clamp(dependency), similarity: clamp(similarity), combined: null };
}

function inferRoles(source = {}) {
  const haystack = [...strings(source.capabilityTags), ...strings(source.supportedTaskTypes), ...strings(source.deliverableTypes)]
    .join(' ')
    .toLowerCase();
  const roles = Object.entries(ROLE_TAGS)
    .filter(([, tags]) => tags.some((tag) => haystack.includes(String(tag).toLowerCase())))
    .map(([role]) => role);
  return roles.length ? roles : strings(source.roles);
}

function rank(candidates, scoreFn, limit) {
  return (Array.isArray(candidates) ? candidates : [])
    .map((profile) => ({ profile: normalizeCapabilityProfileLite(profile), score: scoreFn(profile) }))
    .filter((item) => item.profile.agentId)
    .sort((a, b) => b.score - a.score || a.profile.agentId.localeCompare(b.profile.agentId))
    .slice(0, Math.max(1, Number(limit) || 3));
}

function overlap(left, right) {
  const rightSet = new Set(right);
  if (!left.length || !rightSet.size) return 0;
  return left.filter((item) => rightSet.has(item)).length / Math.max(left.length, 1);
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size && !b.size) return 0;
  const inter = [...a].filter((item) => b.has(item)).length;
  return inter / (a.size + b.size - inter);
}

function strings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => text(item, 120).toLowerCase()).filter(Boolean))];
}

function text(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(CPDB_SCORE_MAX, Math.max(CPDB_SCORE_MIN, number));
}
