import { createHash } from 'node:crypto';
import { GENERATED_AT } from './catalog.mjs';
import {
  normalizeUBuddyCapabilityProfile,
  validateUBuddyCapabilityProfile,
} from '../../../src/shared/contracts/uBuddyCapabilityProfile.js';

export function agentCapabilityProfile(agent, person) {
  const profile = {
    version: 'ubuddy_capability_profile_v1',
    ownerUserId: person.id,
    uBuddyAgentInstanceId: agent.id,
    profileRevision: 1,
    introduction: [
      `我是${person.displayName}的「${agent.name}」。`,
      `主职是${agent.familyTitle}，细节能力是${agent.facetName}。`,
      agent.preferredTasks[0],
    ].join(''),
    supportedTaskTypes: agent.supportedTaskTypes,
    deliverableTypes: agent.deliverableTypes,
    capabilityTags: agent.capabilityTags,
    preferredTasks: agent.preferredTasks,
    unsupportedTasks: agent.unsupportedTasks,
    improvementDirections: [`把「${agent.facetName}」做稳，不把相邻职能的活揽过来。`],
    collaborationModes: ['作为 specialist 接收上游产物', '把本职产出交给下游'],
    privacyConstraints: ['简介只来自有效 Skill，不写入私聊或凭据。'],
    evidenceSummary: `有效 Skill 覆盖${agent.familyTitle} / ${agent.facetName}；产出 ${agent.produces.join('、')}；输入 ${agent.consumes.join('、') || '任务简报'}。`,
    sourceEffectiveSkillHash: agent.skillHash,
    visibility: 'organization',
    publicationState: 'active',
    generatedAt: GENERATED_AT,
    approvedAt: GENERATED_AT,
    publishedAt: GENERATED_AT,
    extra: {
      kind: 'specialist',
      familyId: agent.familyId,
      facetId: agent.facetId,
      produces: agent.produces,
      consumes: agent.consumes,
      detailCapabilities: agent.detailCapabilities,
      twin: agent.twin,
    },
  };
  return stamp(profile);
}

export function ubuddyCapabilityProfile(person, agents) {
  const ordered = [...agents].sort((a, b) => a.slot - b.slot);
  const tags = unique([
    '协作协调', '需求整理', '进度跟踪', 'privacy',
    ...ordered.flatMap((agent) => agent.capabilityTags),
  ]);
  const taskTypes = unique([
    '任务澄清与需求整理', '任务分派与协作协调', '进度跟踪与状态汇报',
    ...ordered.flatMap((agent) => agent.supportedTaskTypes),
  ]);
  const deliverables = unique(ordered.flatMap((agent) => agent.deliverableTypes));
  const names = ordered.map((agent) => agent.name).join('、');
  const skillHash = sha256(ordered.map((agent) => agent.skillHash).join('|'));
  const profile = {
    version: 'ubuddy_capability_profile_v1',
    ownerUserId: person.id,
    uBuddyAgentInstanceId: person.ubuddyId,
    profileRevision: 1,
    introduction: [
      `我是${person.displayName}的 uBuddy，负责${person.departmentName}在「${person.domain}」上的任务入口与协作规划。`,
      `手下 5 个 specialist：${names}。`,
      '规划时按依赖分选择互补协作；执行不佳时按相似度做最小能力改动替换。',
    ].join(''),
    supportedTaskTypes: taskTypes,
    deliverableTypes: deliverables,
    capabilityTags: tags.slice(0, 40),
    preferredTasks: [
      `把${person.topic}拆成可执行步骤并分给合适的 specialist。`,
      '在失败后只替换最像的 Agent，便于归因到一项细节能力。',
    ],
    unsupportedTasks: [
      '未经所有者确认的对外发布、正式承诺或信息共享。',
      '要求披露私聊、凭据或未发布材料的任务。',
    ],
    improvementDirections: [
      '提高按依赖分选协作、按相似度换人的稳定性。',
      '把单次成功合作的加分限制在指数递减范围内，避免老搭档锁死。',
    ],
    collaborationModes: ['uBuddy 直接处理', '转交单个 specialist Agent', '协调多 Agent 任务', '经确认的跨用户委托'],
    privacyConstraints: [
      '简介由手下 Agent 的有效 Skill 聚合，不读取私有 Memory 或附件原文。',
      '对外共享前需要所有者明确确认。',
    ],
    evidenceSummary: `由 ${ordered.length} 个 specialist 的 Skill 哈希聚合；覆盖职能 ${unique(ordered.map((agent) => agent.familyTitle)).join('、')}。`,
    sourceEffectiveSkillHash: skillHash,
    visibility: 'organization',
    publicationState: 'active',
    generatedAt: GENERATED_AT,
    approvedAt: GENERATED_AT,
    publishedAt: GENERATED_AT,
    extra: {
      kind: 'ubuddy',
      sourceAgentIds: ordered.map((agent) => agent.id),
      sourceFamilies: unique(ordered.map((agent) => agent.familyId)),
      sourceFacets: ordered.map((agent) => `${agent.familyId}.${agent.facetId}`),
    },
  };
  return stamp(profile);
}

export function liteProfile(profile) {
  return {
    agentId: profile.uBuddyAgentInstanceId,
    capabilityTags: profile.capabilityTags,
    supportedTaskTypes: profile.supportedTaskTypes,
    deliverableTypes: profile.deliverableTypes,
    produces: profile.extra?.produces || [],
    consumes: profile.extra?.consumes || [],
    familyId: profile.extra?.familyId || '',
    facetId: profile.extra?.facetId || '',
    detailCapabilities: profile.extra?.detailCapabilities || [],
  };
}

function stamp(profile) {
  const normalized = normalizeUBuddyCapabilityProfile(profile);
  validateUBuddyCapabilityProfile(normalized, { throwOnError: true });
  return { ...normalized, extra: profile.extra || {} };
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}
