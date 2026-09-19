export function marbleAdapter() {
  return { name: 'marble', coordinationModes: ['graph', 'star', 'tree'], metrics: ['task_completion', 'token_consumption', 'planning_score', 'communication_score', 'agent_kpis', 'total_milestones'], source: process.env.MARBLE_ROOT || 'benchmarks/marble', role: 'optional_organization_reference' };
}
