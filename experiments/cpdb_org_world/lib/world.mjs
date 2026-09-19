import { createHash } from 'node:crypto';
import {
  AGENTS_PER_PERSON,
  ARCHETYPES,
  GENERATED_AT,
  ORGS,
  PEOPLE_PER_ORG,
  TITLES,
  agentDisplayName,
  familyOf,
  flavorLine,
  personName,
} from './catalog.mjs';
import { makeRng } from './rng.mjs';

export function buildRoster({ smoke = false, rng = makeRng(1) } = {}) {
  const orgs = smoke ? ORGS.slice(0, 2) : ORGS;
  const peoplePerOrg = smoke ? 2 : PEOPLE_PER_ORG;
  const people = [];
  const agents = [];
  for (let orgIndex = 0; orgIndex < orgs.length; orgIndex += 1) {
    const org = orgs[orgIndex];
    for (let personIndex = 0; personIndex < peoplePerOrg; personIndex += 1) {
      const personId = `p_${org.id.slice(4, 6)}_${String(personIndex).padStart(2, '0')}`;
      const ubuddyId = `ub_${personId}`;
      const archetype = ARCHETYPES[(orgIndex + personIndex) % ARCHETYPES.length];
      const person = {
        id: personId,
        displayName: personName(orgIndex, personIndex),
        title: TITLES[personIndex % TITLES.length],
        orgId: org.id,
        orgName: org.name,
        domain: org.domain,
        topic: org.topic,
        departmentName: org.departmentName,
        archetypeId: archetype.id,
        archetypeTitle: archetype.title,
        ubuddyId,
        agentIds: [],
      };
      const built = buildTeamAgents({ person, org, archetype, rng });
      person.agentIds = built.map((agent) => agent.id);
      people.push(person);
      agents.push(...built);
    }
  }
  return { generatedAt: GENERATED_AT, orgs, people, agents };
}

function buildTeamAgents({ person, org, archetype, rng }) {
  const usedFacets = new Map();
  const agents = archetype.slots.map((familyId, slot) => makeAgent({
    person, org, familyId, slot, rng, usedFacets, twin: false,
  }));
  agents.push(makeAgent({
    person, org, familyId: archetype.twin, slot: AGENTS_PER_PERSON - 1, rng, usedFacets, twin: true,
  }));
  return agents;
}

function makeAgent({ person, org, familyId, slot, rng, usedFacets, twin }) {
  const family = familyOf(familyId);
  const previous = usedFacets.get(familyId) || [];
  const available = family.facets.filter((facet) => !previous.includes(facet.id));
  const facet = (twin ? available[0] : null) || rng.pick(available.length ? available : family.facets);
  usedFacets.set(familyId, [...previous, facet.id]);
  const id = `ag_${person.id}_${slot}`;
  const skillMd = renderSkill({ person, org, family, facet, twin });
  const capabilityTags = unique([...family.baseTags, ...facet.tags]);
  return {
    id,
    ownerUserId: person.id,
    ownerDisplayName: person.displayName,
    orgId: org.id,
    domain: org.domain,
    topic: org.topic,
    slot,
    familyId: family.id,
    familyTitle: family.title,
    facetId: facet.id,
    facetName: facet.name,
    twin,
    twinOfFamily: twin ? family.id : '',
    name: agentDisplayName(family, facet, twin),
    produces: [...family.produces],
    consumes: [...family.consumes],
    deliverableTypes: [...family.deliverableTypes],
    supportedTaskTypes: [...family.supportedTaskTypes, org.domain],
    capabilityTags,
    detailCapabilities: [...facet.tags],
    preferredTasks: [flavorLine(org, family, facet)],
    unsupportedTasks: [family.unsupported],
    skillMd,
    skillHash: sha256(skillMd),
  };
}

function renderSkill({ person, org, family, facet, twin }) {
  const neighbor = twin ? '这是近邻替换位：与同组同职能 Agent 只差一项细节能力。' : '这是主职能位。';
  return [
    `# ${family.title} / ${facet.name}`,
    '',
    `你是${person.displayName}手下的 specialist Agent，负责${org.departmentName}在「${org.domain}」任务里的${family.title}。`,
    neighbor,
    '',
    '## 场景',
    flavorLine(org, family, facet),
    '',
    '## 输入',
    family.consumes.length ? family.consumes.map((item) => `- ${item}`).join('\n') : '- 所有者确认后的任务简报',
    '',
    '## 产出',
    family.produces.map((item) => `- ${item}`).join('\n'),
    '',
    '## 细节能力',
    `- ${facet.name}：${facet.rule}`,
    '',
    '## 不做',
    family.unsupported,
    '',
    '## 协作',
    '只处理本职能输入到本职能产出。需要其他职能时交回 uBuddy 按依赖分规划，不擅自改写下游契约。',
  ].join('\n');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}
