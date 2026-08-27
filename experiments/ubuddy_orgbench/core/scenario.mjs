import { createRng } from './random.mjs';
import { sha256, seededId } from '../schema.mjs';
import { discoverRequirements } from './policy.mjs';

const CAPABILITIES = ['research', 'data_analysis', 'coding', 'web_operation', 'communication', 'review', 'file_operation', 'planning'];
const AGENT_TYPES = ['research', 'data', 'coding', 'execution', 'review', 'communication'];

function profileFor(index, rng) {
  const capabilities = rng.shuffle(CAPABILITIES).slice(0, 2 + (index % 3));
  return { ubuddyId: `ubuddy_${String.fromCharCode(65 + index)}`, ownerUserId: `user_${String.fromCharCode(65 + index)}`, displayName: `Participant ${String.fromCharCode(65 + index)}`, capabilities, supportedTaskTypes: capabilities, availability: index === 0 ? 'requester' : 'active', visibility: 'organization', revision: 1, confidence: 0.72 + (index % 4) * 0.06, evidenceSupport: index % 3, contentHash: sha256(`profile:${index}:${capabilities.join(',')}`) };
}

export function buildScenario({ taskId = 'orgbench-canary', problem = 'Resolve a multi-step work problem involving research, data processing, execution, and review.', seed = 20260826, candidateCount = 5, injectFault = null } = {}) {
  const rng = createRng(seed);
  const profiles = Array.from({ length: candidateCount + 1 }, (_, index) => profileFor(index, rng));
  const requirements = discoverRequirements(problem);
  const internalPools = Object.fromEntries(profiles.map((profile, profileIndex) => {
    const count = rng.int(2, 6);
    const agents = Array.from({ length: count }, (_, agentIndex) => {
      const capabilities = rng.shuffle(AGENT_TYPES).slice(0, 1 + ((agentIndex + profileIndex) % 3));
      return { agentInstanceId: seededId(`agent_${profile.ubuddyId}`, seed, agentIndex), ownerUbuddyId: profile.ubuddyId, agentFamilyId: capabilities[0], capabilities, strength: 0.65 + rng.next() * 0.3, tools: capabilities.includes('execution') ? ['execute'] : ['inspect'], memoryVersion: 1, privateMemory: `private-memory-${profile.ubuddyId}-${agentIndex}` };
    });
    return [profile.ubuddyId, { count, agents }];
  }));
  const hiddenTruth = {
    requirements,
    requirementGraph: { nodes: requirements.map((item) => item.id), edges: [['req_1', 'req_2'], ['req_2', 'req_3']] },
    candidateCapabilities: Object.fromEntries(profiles.map((profile) => [profile.ubuddyId, profile.capabilities])),
    internalCapabilities: Object.fromEntries(Object.entries(internalPools).map(([ubuddyId, pool]) => [ubuddyId, Object.fromEntries(pool.agents.map((agent) => [agent.agentInstanceId, agent.capabilities]))])),
    optimalRecipientSet: ['ubuddy_B', 'ubuddy_C'],
    injectFault,
  };
  return { taskId, problem, seed, profiles, internalPools, requirements, hiddenTruth, candidateCount, injectFault, rngState: 'deterministic' };
}
