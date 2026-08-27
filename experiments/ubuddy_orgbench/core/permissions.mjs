export const UBUDDY_ACTIONS = new Set(['query_profiles', 'invite_ubuddy', 'create_task_node', 'assign_to_ubuddy', 'assign_internal_agent', 'set_dependency', 'update_task_status', 'publish_progress', 'request_revision', 'accept_result', 'reject_result', 'reassign_task', 'close_project']);
export const INTERNAL_AGENT_ACTIONS = new Set(['observe_environment', 'execute_tool', 'report_progress', 'submit_result', 'report_blocker', 'propose_subtask']);

export function assertActionAllowed({ actorLayer, action, targetLayer = null, targetOwnerUbuddyId = null, actorUbuddyId = null }) {
  if (actorLayer === 'internal_agent') {
    if (!INTERNAL_AGENT_ACTIONS.has(action)) throw new Error(`internal_agent_action_forbidden:${action}`);
    if (['assign_to_ubuddy', 'assign_internal_agent', 'accept_result', 'reject_result', 'reassign_task', 'close_project'].includes(action)) throw new Error(`internal_agent_cannot_organize:${action}`);
    return true;
  }
  if (!UBUDDY_ACTIONS.has(action)) throw new Error(`ubuddy_action_unknown:${action}`);
  if (action === 'assign_internal_agent' && targetLayer === 'internal_agent' && targetOwnerUbuddyId && actorUbuddyId !== targetOwnerUbuddyId) throw new Error('cannot_directly_dispatch_foreign_internal_agent');
  return true;
}
