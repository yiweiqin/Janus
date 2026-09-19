import crypto from 'node:crypto';

export const ORGBENCH_NAMESPACE = 'ubuddy-orgbench-v2';
export const USERS = Object.freeze([
  { key: 'a', id: 'orgbench_user_a', role: 'requester' },
  { key: 'b', id: 'orgbench_user_b', role: 'recipient' },
  { key: 'c', id: 'orgbench_user_c', role: 'recipient' },
  { key: 'd', id: 'orgbench_user_d', role: 'recipient' },
  { key: 'e', id: 'orgbench_user_e', role: 'recipient' },
  { key: 'f', id: 'orgbench_user_f', role: 'recipient' },
]);

export const AGENT_FAMILIES = Object.freeze([
  { id: 'orgbench_research_agent', familyId: 'research_agent', name: 'Research Agent', tags: ['research', 'retrieval', 'synthesis'] },
  { id: 'orgbench_data_analysis_agent', familyId: 'data_analysis_agent', name: 'Data Analysis Agent', tags: ['data-analysis', 'statistics', 'transformation'] },
  { id: 'orgbench_coding_agent', familyId: 'coding_agent', name: 'Coding Agent', tags: ['coding', 'debugging', 'testing'] },
  { id: 'orgbench_web_operation_agent', familyId: 'web_operation_agent', name: 'Web Operation Agent', tags: ['web', 'browser', 'api-operation'] },
  { id: 'orgbench_communication_agent', familyId: 'communication_agent', name: 'Communication Agent', tags: ['communication', 'writing', 'coordination'] },
  { id: 'orgbench_review_agent', familyId: 'review_agent', name: 'Review Agent', tags: ['review', 'validation', 'quality-control'] },
]);

export const allAgentAliases = () => USERS.flatMap((user) => AGENT_FAMILIES.map((family) => ({
  alias: `agent_ubuddy_${user.key.toUpperCase()}_${family.familyId.replaceAll('_agent', '')}`,
  userId: user.id,
  familyId: family.id,
  familyKey: family.familyId,
})));

export function deterministicAgentId(userKey, familyKey) {
  return `orgbench_uagent_${String(userKey).toLowerCase()}_${String(familyKey).replaceAll('_agent', '')}`;
}

export function deterministicUBuddyId(userKey) {
  return `orgbench_ubuddy_${String(userKey).toLowerCase()}`;
}

export function deterministicDeviceId(userKey) {
  return `${ORGBENCH_NAMESPACE}:device:${String(userKey).toLowerCase()}`;
}

export function passwordForUser({ userId, seed }) {
  return crypto.createHmac('sha256', String(seed || crypto.randomBytes(32).toString('hex')))
    .update(`${ORGBENCH_NAMESPACE}:${userId}`).digest('base64url');
}

export function profileForUser(user, ubuddyId, skillHash) {
  const recipient = user.role === 'recipient';
  const baselineTimestamp = '2026-08-27T00:00:00.000Z';
  return {
    version: 'ubuddy_capability_profile_v1',
    ownerUserId: user.id,
    uBuddyAgentInstanceId: ubuddyId,
    profileRevision: 1,
    introduction: recipient
      ? `OrgBench ${user.id} 可协调研究、数据、代码、网页操作、沟通和审核 Agent。`
      : 'OrgBench requester uBuddy 负责需求理解、组织协作、进度同步和结果验收。',
    supportedTaskTypes: recipient
      ? ['research', 'data-analysis', 'coding', 'web-operation', 'communication', 'review']
      : ['planning', 'delegation', 'coordination', 'review'],
    deliverableTypes: ['answer', 'report', 'document', 'code_change'],
    capabilityTags: recipient
      ? ['orgbench-coordination', 'multi-agent-management', 'research', 'data-analysis', 'coding', 'web-operation', 'review']
      : ['orgbench-requester', 'task-decomposition', 'delegation', 'global-state-review', 'acceptance'],
    preferredTasks: recipient ? ['需要多个内部 Agent 协作的长程任务'] : ['需要跨主体组织和验收的长程任务'],
    unsupportedTasks: [],
    improvementDirections: ['根据验证过的协作证据更新路由策略'],
    collaborationModes: ['cross-user-delegation', 'shared-state-graph', 'evidence-gated-evolution'],
    privacyConstraints: ['不公开私有会话、Memory、Skill 正文、本地路径或凭据'],
    evidenceSummary: 'OrgBench initialization baseline; no private evidence included.',
    sourceEffectiveSkillHash: skillHash,
    visibility: 'friends',
    publicationState: 'active',
    generatedAt: baselineTimestamp,
    approvedAt: baselineTimestamp,
    publishedAt: baselineTimestamp,
    privacyRiskConfirmedAt: baselineTimestamp,
    privacyRiskCodes: [],
  };
}
