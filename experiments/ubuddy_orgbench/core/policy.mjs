import { publicProfile, methodFeatures, seededId } from '../schema.mjs';

export function discoverRequirements(problem) {
  const text = String(problem).toLowerCase();
  const requirements = [];
  const add = (capability, description) => { if (!requirements.some((item) => item.capability === capability)) requirements.push({ id: `req_${requirements.length + 1}`, capability, description, required: true }); };
  if (/research|search|read|paper|information|调查|检索|资料/.test(text)) add('research', 'research and gather the evidence needed by the project');
  if (/data|spreadsheet|csv|analysis|statistics|数据|表格|分析/.test(text)) add('data_analysis', 'analyze and structure the project data');
  if (/code|software|repository|bug|test|代码|仓库|测试/.test(text)) add('coding', 'implement or test the technical part of the project');
  if (/web|browser|site|app|update|create|send|execute|execution|perform|网页|应用|更新|执行/.test(text)) add('execution', 'perform the required application, tool, or environment operations');
  if (/review|verify|check|audit|审核|检查|验收/.test(text)) add('review', 'verify the intermediate and final results');
  if (!requirements.length) { add('research', 'understand the problem and gather required inputs'); add('execution', 'perform the requested work'); add('review', 'verify the outcome'); }
  if (!requirements.some((item) => item.capability === 'review')) add('review', 'verify the outcome before final acceptance');
  return requirements.slice(0, 5);
}

function scoreProfile(profile, requirement) {
  return profile.capabilities.includes(requirement.capability) ? 1 + profile.confidence : profile.confidence * 0.25;
}

export function chooseRecipients({ profiles, requirements, method }) {
  const candidates = profiles.filter((profile) => profile.availability === 'active');
  const selected = [];
  for (const requirement of requirements) {
    const ranked = candidates.filter((item) => !selected.includes(item)).sort((a, b) => scoreProfile(b, requirement) - scoreProfile(a, requirement));
    const winner = ranked[0];
    if (winner && !selected.includes(winner)) selected.push(winner);
  }
  return { selected, scores: candidates.map((profile) => ({ ubuddyId: profile.ubuddyId, scores: requirements.map((requirement) => ({ requirementId: requirement.id, score: scoreProfile(profile, requirement) })) })), snapshots: selected.map((profile) => ({ ubuddyId: profile.ubuddyId, revision: methodFeatures(method).profileVersioning ? profile.revision : undefined, contentHash: methodFeatures(method).profileVersioning ? profile.contentHash : undefined, frozen: methodFeatures(method).profileVersioning })) };
}

export function createRootPlan({ scenario, method, graph, addEvent }) {
  const features = methodFeatures(method);
  const rootId = 'project_root';
  graph.node(rootId, { kind: 'project', owner: 'ubuddy_A', title: scenario.problem, status: 'running', visibility: 'all' });
  const nodes = scenario.requirements.map((requirement, index) => {
    const id = `requester_task_${index + 1}`;
    graph.node(id, { kind: 'ubuddy_task', owner: 'ubuddy_A', title: requirement.description, capability: requirement.capability, parentNodeId: rootId, status: 'pending', visibility: 'all' });
    graph.edge('parent_of', rootId, id);
    if (index > 0) graph.edge('dependency_of', `requester_task_${index}`, id, { requirementId: requirement.id });
    addEvent('task_node_created', 'requester_ubuddy', id, { capability: requirement.capability, parentNodeId: rootId });
    return { id, requirement };
  });
  if (!features.multiUbuddy) return { rootId, nodes, recipients: [] };
  return { rootId, nodes };
}

export function allocateInternalAgent(pool, requirement, method) {
  const eligible = pool.agents.filter((agent) => agent.capabilities.includes(requirement.capability) || agent.capabilities.includes('execution'));
  const ranked = (eligible.length ? eligible : pool.agents).sort((a, b) => b.strength - a.strength);
  return ranked[0];
}

export function makeInternalNode(parent, agent, requirement, seed, graph, addEvent, ownerLayer = 'recipient_ubuddy') {
  const nodeId = seededId(`${parent.id}_internal`, seed, agent.agentInstanceId);
  graph.node(nodeId, { kind: 'internal_agent_task', owner: agent.ownerUbuddyId, agentInstanceId: agent.agentInstanceId, title: requirement.description, capability: requirement.capability, parentNodeId: parent.id, status: 'pending', visibility: 'all' });
  graph.edge('parent_of', parent.id, nodeId);
  graph.edge('assigned_to', nodeId, agent.agentInstanceId, { assignmentLayer: 'internal' });
  addEvent('internal_agent_selected', ownerLayer, nodeId, { agentInstanceId: agent.agentInstanceId, ownerUbuddyId: agent.ownerUbuddyId, capability: requirement.capability });
  return nodeId;
}
