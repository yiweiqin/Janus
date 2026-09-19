import { validateUBuddyCapabilityProfile } from '../../../src/shared/contracts/uBuddyCapabilityProfile.js';
import { AGENTS_PER_PERSON } from './catalog.mjs';

export function validateWorld({ orgs, people, agents, agentProfiles, ubuddyProfiles, pairs }) {
  const errors = [];
  const agentIds = new Set(agents.map((agent) => agent.id));
  if (people.some((person) => person.agentIds.length !== AGENTS_PER_PERSON)) {
    errors.push('person_agent_count');
  }
  if (agents.some((agent) => !agent.skillMd || !agent.skillHash || !agent.facetId)) {
    errors.push('agent_skill_missing');
  }
  for (const person of people) {
    const mine = agents.filter((agent) => agent.ownerUserId === person.id);
    const families = new Set(mine.map((agent) => agent.familyId));
    if (families.size < 3) errors.push(`person_family_too_narrow:${person.id}`);
    if (!mine.some((agent) => agent.twin)) errors.push(`person_missing_twin:${person.id}`);
    const ubuddy = ubuddyProfiles.find((profile) => profile.uBuddyAgentInstanceId === person.ubuddyId);
    if (!ubuddy) errors.push(`ubuddy_profile_missing:${person.id}`);
    else {
      const union = new Set(mine.flatMap((agent) => agent.capabilityTags));
      const extra = ubuddy.capabilityTags.filter((tag) => !union.has(tag) && !COORDINATOR_TAGS.has(tag));
      if (extra.length) errors.push(`ubuddy_tag_not_from_agents:${person.id}`);
      if (!ubuddy.extra?.sourceAgentIds?.every((id) => person.agentIds.includes(id))) {
        errors.push(`ubuddy_source_mismatch:${person.id}`);
      }
    }
  }
  for (const profile of [...agentProfiles, ...ubuddyProfiles]) {
    const result = validateUBuddyCapabilityProfile(profile);
    if (!result.valid) errors.push(`profile_invalid:${profile.uBuddyAgentInstanceId}`);
  }
  for (const pair of pairs) {
    if (pair.combined != null) errors.push(`combined_score:${pair.id}`);
    if (!agentIds.has(pair.leftAgentId) || !agentIds.has(pair.rightAgentId)) errors.push(`pair_unknown_agent:${pair.id}`);
    if (pair.initDependency < 0 || pair.initDependency > 1 || pair.initSimilarity < 0 || pair.initSimilarity > 1) {
      errors.push(`score_range:${pair.id}`);
    }
  }
  return { ok: errors.length === 0, errors: unique(errors).slice(0, 40), counts: {
    orgs: orgs.length, people: people.length, agents: agents.length,
    agentProfiles: agentProfiles.length, ubuddyProfiles: ubuddyProfiles.length, pairs: pairs.length,
  } };
}

const COORDINATOR_TAGS = new Set(['协作协调', '需求整理', '进度跟踪', 'privacy']);

function unique(values) {
  return [...new Set(values)];
}
