// Metadata lint only; hashes and owner statements are not proof of real reset or consent.
export function validateRealTask(task) {
  const issues = [];
  const required = ['taskId', 'familyId', 'split', 'inputSnapshotRef', 'inputHash', 'evaluatorVersion',
    'evaluatorCommand', 'resetCommand', 'agentVersion', 'promptVersion', 'toolVersion', 'acceptanceRule', 'dataBoundary'];
  for (const key of required) if (typeof task?.[key] !== 'string' || !task[key].trim() || /TODO|REPLACE/i.test(task[key])) issues.push(`missing:${key}`);
  if (!['train', 'calibration', 'test'].includes(task?.split)) issues.push('invalid:split');
  if (!/^[a-f0-9]{64}$/.test(task?.inputHash || '')) issues.push('invalid:inputHash');
  if (!Array.isArray(task?.interventions) || task.interventions.length < 2 || !task.interventions.includes('noop')
    || task.interventions.some((v) => typeof v !== 'string' || !v.trim()) || new Set(task.interventions).size !== task.interventions.length) issues.push('invalid:interventions');
  if (!(Number.isSafeInteger(task?.maxExecutions) && task.maxExecutions >= 2)) issues.push('invalid:maxExecutions');
  if (!(Number.isFinite(task?.maxCost) && task.maxCost > 0)) issues.push('invalid:maxCost');
  if (task?.resetVerified !== true) issues.push('missing:resetVerification');
  if (task?.independentEvaluator !== true) issues.push('missing:independentEvaluator');
  return { metadataComplete: issues.length === 0, executableReady: false, issues,
    nextStep: 'Implement and verify a sandbox task adapter; doctor does not run supplied commands.', autoEvolutionAllowed: false };
}
