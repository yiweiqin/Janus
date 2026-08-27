export function marbleAdapter() {
  return { name: 'marble', coordinationModes: ['graph', 'star', 'tree'], metrics: ['task_completion', 'token_consumption', 'planning_score', 'communication_score', 'agent_kpis', 'total_milestones'], source: 'D:/Cli-anything/benchmarks/marble' };
}
