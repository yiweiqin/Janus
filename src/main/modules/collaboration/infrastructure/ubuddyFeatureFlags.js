import crypto from 'node:crypto';

export const UBUDDY_FEATURE_FLAG_SETTING_KEY = 'ubuddy:feature_flags:v1';

export const UBUDDY_FEATURE_FLAGS = Object.freeze({
  codexPrimaryV1: 'ubuddy_codex_primary_v1',
  newTaskWorkspaceUi: 'ubuddy.new_task_workspace_ui',
  newDispatchStrategy: 'ubuddy.new_dispatch_strategy',
  newProcessEventStream: 'ubuddy.new_process_event_stream',
  intakeClarificationV2: 'ubuddy_intake_clarification_v2',
  structuredTaskReference: 'structured_task_reference_v1',
  profilePreviewV1: 'ubuddy_profile_preview_v1',
  profilePreview: 'ubuddy.profile_preview',
  profileHistory: 'ubuddy_profile_history_v1',
  profilePublication: 'ubuddy.profile_publication',
  profileRoutingShadow: 'ubuddy_profile_routing_shadow_v1',
  profileRoutingAuto: 'ubuddy_profile_routing_auto_v1',
  agentWorkDetailProjection: 'agent_work_detail_projection_v1',
  boundedDeliveryReworkV1: 'bounded_delivery_rework_v1',
  boundedDeliveryRework: 'bounded_delivery_rework_v1',
  unifiedAgentWorkKernelV2: 'unified_agent_work_kernel_v2',
  messageModeV1: 'ubuddy_message_mode_v1',
  continuousPlanningV1: 'ubuddy_continuous_planning_v1',
  recentWorkReportingV1: 'ubuddy_recent_work_reporting_v1',
  organizationEvolutionCollectV1: 'ubuddy.organization_evolution_collect_v1',
  organizationEvolutionApplyV1: 'ubuddy.organization_evolution_apply_v1',
  organizationEvolutionDecompositionV1: 'ubuddy.organization_evolution_decomposition_v1',
  // plan/exec 漂移诊断（反向侦探模型的接线点）。
  //
  // 默认**开**：它只落一行诊断事件（`rdmd_plan_exec_drift`），既不改图也不改调度，
  // 与 `agentWorkDetailProjection` 同类 —— 是投影不是行为。
  //
  // 之所以要给它一个开关，是因为关掉它的成本极低，而它读的图是本轮才扩到四层的
  // （`agent_step` / `sequence_of`）。出问题时需要能一键止血。
  //
  // 注意：开关**不控制模型能不能跑**。模型还要 `RDMD_ADAPTER` / `RDMD_BASE_MODEL`
  // 存在才会被调用；默认不存在，所以默认路径是「读图 + 算度量 + record_only」。
  planExecDrift: 'ubuddy_plan_exec_drift',
  // plan/exec 漂移的**动作侧**能力位。默认**关**（见 SAFE_DEFAULT_OFF）。
  //
  // 打开它**不会**让任何东西去改图。它只解锁动作阶梯的第一级 `phase='shadow'`：
  // 把模型给的最小改动记下来、**不执行**，并记录执行图后来真实发生了什么，
  // 用两者的一致性做累计度量（见 planExecDriftService 的 observeShadowFollowUp）。
  // 真动作（改规划）的前提是那个度量，而不是"模型验收过了" —— 见
  // experiments/rdmd_detective_dataset/ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md 里
  // "动作侧只做影子"那一节的理由（提案在执行完成时已不可回改）。
  //
  // 所以 flag 的名字（apply）指的是**它守的是哪一侧**（动作侧），
  // 而不是"打开就开始改图"。这条区分很重要：读代码的人如果以为打开它就会改图，
  // 会去审查一个不存在的风险；而真正该审查的是影子度量有没有被绕过。
  planExecDriftApply: 'ubuddy_plan_exec_drift_apply',
  // CPDB 打分器：用**学到的**分替换 `uBuddyCapabilityDependencyBundle` 的手写规则。
  //
  // 默认**关**，理由与 planExecDriftApply 同类：打开它会改变"规划时挑谁协作、失败后换谁"
  // 的名次，也就是会改变协作图的形状。所以它守的是行为，不是投影。
  //
  // 打开之后发生的事是可枚举的：`scoredSelectCollaborators` / `scoredSelectReplacement`
  // 走交付产物（`artifacts/cpdb-scorer-v3-ship`，默认是 36 格 family 表），
  // 而 `describeScorerFallback` 会告诉你此刻到底走的是表、模型还是规则。
  // 产物不在位时**不会**变成"所有分数为 0"——它回落到手写规则，可发现、可观测。
  //
  // 为什么不默认开：手写规则与学到的分**不是同一个函数**。它们在"同族一律压到 0"
  // 这类地方差别很大（这正是学习想要修掉的那一点，也正是风险所在）。要换，得先看影子对比。
  capabilityDependencyScorer: 'ubuddy_capability_dependency_scorer_v1',
});

const ENV_KEYS = Object.freeze({
  [UBUDDY_FEATURE_FLAGS.codexPrimaryV1]: 'JANUS_UBUDDY_CODEX_PRIMARY_V1',
  [UBUDDY_FEATURE_FLAGS.newTaskWorkspaceUi]: 'JANUS_UBUDDY_NEW_TASK_WORKSPACE_UI',
  [UBUDDY_FEATURE_FLAGS.newDispatchStrategy]: 'JANUS_UBUDDY_NEW_DISPATCH_STRATEGY',
  [UBUDDY_FEATURE_FLAGS.newProcessEventStream]: 'JANUS_UBUDDY_NEW_PROCESS_EVENT_STREAM',
  [UBUDDY_FEATURE_FLAGS.intakeClarificationV2]: 'JANUS_UBUDDY_INTAKE_CLARIFICATION_V2',
  [UBUDDY_FEATURE_FLAGS.structuredTaskReference]: 'JANUS_STRUCTURED_TASK_REFERENCE_V1',
  [UBUDDY_FEATURE_FLAGS.profilePreviewV1]: 'JANUS_UBUDDY_PROFILE_PREVIEW_V1',
  [UBUDDY_FEATURE_FLAGS.profilePreview]: 'JANUS_UBUDDY_PROFILE_PREVIEW',
  [UBUDDY_FEATURE_FLAGS.profileHistory]: 'JANUS_UBUDDY_PROFILE_HISTORY',
  [UBUDDY_FEATURE_FLAGS.profilePublication]: 'JANUS_UBUDDY_PROFILE_PUBLICATION',
  [UBUDDY_FEATURE_FLAGS.profileRoutingShadow]: 'JANUS_UBUDDY_PROFILE_ROUTING_SHADOW_V1',
  [UBUDDY_FEATURE_FLAGS.profileRoutingAuto]: 'JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1',
  [UBUDDY_FEATURE_FLAGS.agentWorkDetailProjection]: 'JANUS_UBUDDY_AGENT_WORK_DETAIL_PROJECTION',
  [UBUDDY_FEATURE_FLAGS.boundedDeliveryReworkV1]: 'JANUS_BOUNDED_DELIVERY_REWORK_V1',
  [UBUDDY_FEATURE_FLAGS.unifiedAgentWorkKernelV2]: 'JANUS_UNIFIED_AGENT_WORK_KERNEL_V2',
  [UBUDDY_FEATURE_FLAGS.messageModeV1]: 'JANUS_UBUDDY_MESSAGE_MODE_V1',
  [UBUDDY_FEATURE_FLAGS.continuousPlanningV1]: 'JANUS_UBUDDY_CONTINUOUS_PLANNING_V1',
  [UBUDDY_FEATURE_FLAGS.recentWorkReportingV1]: 'JANUS_UBUDDY_RECENT_WORK_REPORTING_V1',
  [UBUDDY_FEATURE_FLAGS.organizationEvolutionCollectV1]: 'JANUS_UBUDDY_ORGANIZATION_EVOLUTION_COLLECT_V1',
  [UBUDDY_FEATURE_FLAGS.organizationEvolutionApplyV1]: 'JANUS_UBUDDY_ORGANIZATION_EVOLUTION_APPLY_V1',
  [UBUDDY_FEATURE_FLAGS.organizationEvolutionDecompositionV1]: 'JANUS_UBUDDY_ORGANIZATION_EVOLUTION_DECOMPOSITION_V1',
  [UBUDDY_FEATURE_FLAGS.planExecDrift]: 'JANUS_UBUDDY_PLAN_EXEC_DRIFT',
  [UBUDDY_FEATURE_FLAGS.planExecDriftApply]: 'JANUS_UBUDDY_PLAN_EXEC_DRIFT_APPLY',
  [UBUDDY_FEATURE_FLAGS.capabilityDependencyScorer]: 'JANUS_UBUDDY_CAPABILITY_DEPENDENCY_SCORER_V1',
});

const LEGACY_ENV_KEYS = Object.freeze({
  [UBUDDY_FEATURE_FLAGS.structuredTaskReference]: 'JANUS_UBUDDY_STRUCTURED_TASK_REFERENCE',
  [UBUDDY_FEATURE_FLAGS.boundedDeliveryReworkV1]: 'JANUS_UBUDDY_BOUNDED_DELIVERY_REWORK',
  [UBUDDY_FEATURE_FLAGS.profileRoutingShadow]: 'JANUS_UBUDDY_PROFILE_ROUTING_SHADOW',
  [UBUDDY_FEATURE_FLAGS.profileRoutingAuto]: 'JANUS_UBUDDY_PROFILE_ROUTING_AUTO',
});

const LEGACY_SETTING_KEYS = Object.freeze({
  [UBUDDY_FEATURE_FLAGS.structuredTaskReference]: Object.freeze(['ubuddy.structured_task_reference']),
  [UBUDDY_FEATURE_FLAGS.agentWorkDetailProjection]: Object.freeze(['ubuddy.agent_work_detail_projection', 'agentWorkDetailProjection']),
  [UBUDDY_FEATURE_FLAGS.boundedDeliveryReworkV1]: Object.freeze(['ubuddy.bounded_delivery_rework', 'boundedDeliveryRework']),
  [UBUDDY_FEATURE_FLAGS.profileRoutingShadow]: Object.freeze(['ubuddy.profile_routing_shadow', 'profileRoutingShadow']),
  [UBUDDY_FEATURE_FLAGS.profileRoutingAuto]: Object.freeze(['ubuddy.profile_routing_auto', 'profileRoutingAuto']),
});

const SAFE_DEFAULT_OFF = new Set([
  UBUDDY_FEATURE_FLAGS.profileRoutingAuto,
  UBUDDY_FEATURE_FLAGS.unifiedAgentWorkKernelV2,
  UBUDDY_FEATURE_FLAGS.organizationEvolutionCollectV1,
  UBUDDY_FEATURE_FLAGS.organizationEvolutionApplyV1,
  UBUDDY_FEATURE_FLAGS.organizationEvolutionDecompositionV1,
  // 动作侧：默认关。它与上面的 organizationEvolutionApplyV1 同类 ——
  // 都是"会改变别的任务/规划怎么走"的能力，所以默认值必须是关，
  // 而且要在代码里就能看出"打开它之后最坏会发生什么"。
  //
  // 注意它比 organizationEvolutionApplyV1 更早一级：打开它今天**只会**进入影子，
  // 不会改任何东西。默认关的严格程度与它守的东西无关，而与"这个开关的语义将来会不会变强"
  // 有关 —— 将来接上真动作时，这个默认值就是唯一的安全边界，所以现在就设成关。
  UBUDDY_FEATURE_FLAGS.planExecDriftApply,
  // 打分器会改"挑谁协作 / 换谁"的名次，也就是会改变协作图的形状 —— 这个默认值
  // 将来接上真动作时就是唯一的安全边界，所以现在就设成关。
  UBUDDY_FEATURE_FLAGS.capabilityDependencyScorer,
]);
const OPTIONAL_DEFAULT_OFF_FLAGS = new Set([
  UBUDDY_FEATURE_FLAGS.organizationEvolutionCollectV1,
  UBUDDY_FEATURE_FLAGS.organizationEvolutionApplyV1,
  UBUDDY_FEATURE_FLAGS.organizationEvolutionDecompositionV1,
]);
const DEFAULT_ON_BY_DEFAULT = new Set(
  Object.values(UBUDDY_FEATURE_FLAGS).filter((flag) => !SAFE_DEFAULT_OFF.has(flag)),
);

export function createUBuddyFeatureFlagService({ store, env = process.env, isDev = false } = {}) {
  void isDev;

  const readStored = () => safeJson(store?.settingGet?.(UBUDDY_FEATURE_FLAG_SETTING_KEY, '{}'));

  const resolve = (flag, { userId = '', workspaceId = '' } = {}) => {
    const stored = readStored();
    const environment = firstConfiguredValue(env[ENV_KEYS[flag]], env[LEGACY_ENV_KEYS[flag]]);
    const storedValue = firstConfiguredValue(
      stored?.[flag],
      flag === UBUDDY_FEATURE_FLAGS.intakeClarificationV2 ? stored?.['ubuddy.intake_clarification_v2'] : undefined,
      flag === UBUDDY_FEATURE_FLAGS.structuredTaskReference ? stored?.['ubuddy.structured_task_reference'] : undefined,
      flag === UBUDDY_FEATURE_FLAGS.profileHistory ? stored?.['ubuddy.profile_history'] : undefined,
      ...(LEGACY_SETTING_KEYS[flag] || []).map((key) => stored?.[key]),
      stored?.[shortFlagName(flag)],
    );
    const configured = environment.found ? environment : storedValue;
    const policy = normalizePolicy(configured.value, DEFAULT_ON_BY_DEFAULT.has(flag));
    const subject = String(userId || workspaceId || 'anonymous');
    const bucket = rolloutBucket(flag, subject);
    const enabled = policy.mode === 'on' || (policy.mode === 'percentage' && bucket < policy.percentage);
    return {
      flag,
      enabled,
      mode: policy.mode,
      percentage: policy.percentage,
      bucket,
      source: environment.found ? 'environment' : storedValue.found ? 'app_settings' : 'default',
    };
  };

  const snapshot = (context = {}) => {
    const codexPrimaryV1 = resolve(UBUDDY_FEATURE_FLAGS.codexPrimaryV1, context);
    const workspaceUi = resolve(UBUDDY_FEATURE_FLAGS.newTaskWorkspaceUi, context);
    const dispatch = resolve(UBUDDY_FEATURE_FLAGS.newDispatchStrategy, context);
    const processStream = resolve(UBUDDY_FEATURE_FLAGS.newProcessEventStream, context);
    const intakeClarificationV2 = resolve(UBUDDY_FEATURE_FLAGS.intakeClarificationV2, context);
    const structuredTaskReference = resolve(UBUDDY_FEATURE_FLAGS.structuredTaskReference, context);
    const profilePreviewV1 = resolve(UBUDDY_FEATURE_FLAGS.profilePreviewV1, context);
    const profilePreview = resolve(UBUDDY_FEATURE_FLAGS.profilePreview, context);
    const profileHistory = resolve(UBUDDY_FEATURE_FLAGS.profileHistory, context);
    const profilePublication = resolve(UBUDDY_FEATURE_FLAGS.profilePublication, context);
    const profileRoutingShadow = resolve(UBUDDY_FEATURE_FLAGS.profileRoutingShadow, context);
    const profileRoutingAuto = resolve(UBUDDY_FEATURE_FLAGS.profileRoutingAuto, context);
    const agentWorkDetailProjection = resolve(UBUDDY_FEATURE_FLAGS.agentWorkDetailProjection, context);
    const boundedDeliveryReworkV1 = resolve(UBUDDY_FEATURE_FLAGS.boundedDeliveryReworkV1, context);
    const unifiedAgentWorkKernelV2 = resolve(UBUDDY_FEATURE_FLAGS.unifiedAgentWorkKernelV2, context);
    const messageModeV1 = resolve(UBUDDY_FEATURE_FLAGS.messageModeV1, context);
    const continuousPlanningV1 = {
      flag: UBUDDY_FEATURE_FLAGS.continuousPlanningV1,
      enabled: true,
      mode: 'on',
      percentage: 100,
      bucket: 0,
      source: 'hard_cutover',
    };
    const recentWorkReportingV1 = resolve(UBUDDY_FEATURE_FLAGS.recentWorkReportingV1, context);
    const organizationEvolutionCollectV1 = resolve(UBUDDY_FEATURE_FLAGS.organizationEvolutionCollectV1, context);
    const organizationEvolutionApplyV1 = resolve(UBUDDY_FEATURE_FLAGS.organizationEvolutionApplyV1, context);
    const organizationEvolutionDecompositionV1 = resolve(UBUDDY_FEATURE_FLAGS.organizationEvolutionDecompositionV1, context);
    const planExecDrift = resolve(UBUDDY_FEATURE_FLAGS.planExecDrift, context);
    const planExecDriftApply = resolve(UBUDDY_FEATURE_FLAGS.planExecDriftApply, context);
    const capabilityDependencyScorer = resolve(UBUDDY_FEATURE_FLAGS.capabilityDependencyScorer, context);
    const organizationEvolutionConfigured = [
      organizationEvolutionCollectV1,
      organizationEvolutionApplyV1,
      organizationEvolutionDecompositionV1,
    ].some((policy) => policy.source !== 'default' || policy.enabled);
    return {
      version: 'ubuddy_feature_flags_v1',
      codexPrimaryV1: codexPrimaryV1.enabled,
      newTaskWorkspaceUi: workspaceUi.enabled,
      newDispatchStrategy: dispatch.enabled,
      newProcessEventStream: processStream.enabled,
      intakeClarificationV2: intakeClarificationV2.enabled,
      structuredTaskReference: structuredTaskReference.enabled,
      profilePreviewV1: profilePreviewV1.enabled,
      profilePreview: profilePreview.enabled,
      profileHistory: profileHistory.enabled,
      profilePublication: profilePublication.enabled,
      profileRoutingShadow: profileRoutingShadow.enabled,
      profileRoutingAuto: profileRoutingAuto.enabled,
      profileRoutingShadowV1: profileRoutingShadow.enabled,
      profileRoutingAutoV1: profileRoutingAuto.enabled,
      agentWorkDetailProjection: agentWorkDetailProjection.enabled,
      boundedDeliveryReworkV1: boundedDeliveryReworkV1.enabled,
      boundedDeliveryRework: boundedDeliveryReworkV1.enabled,
      unifiedAgentWorkKernelV2: unifiedAgentWorkKernelV2.enabled,
      messageModeV1: messageModeV1.enabled,
      continuousPlanningV1: continuousPlanningV1.enabled,
      recentWorkReportingV1: recentWorkReportingV1.enabled,
      planExecDrift: planExecDrift.enabled,
      planExecDriftApply: planExecDriftApply.enabled,
      capabilityDependencyScorer: capabilityDependencyScorer.enabled,
      ...(organizationEvolutionConfigured ? {
        organizationEvolutionCollectV1: organizationEvolutionCollectV1.enabled,
        organizationEvolutionApplyV1: organizationEvolutionApplyV1.enabled,
        organizationEvolutionDecompositionV1: organizationEvolutionDecompositionV1.enabled,
      } : {}),
      executionKernelVersion: unifiedAgentWorkKernelV2.enabled ? 'agent_work_v2' : 'legacy_task_exec_v1',
      taskWorkspaceUiVersion: workspaceUi.enabled ? 'task_workspace_v2' : 'inline_task_cards_v1',
      dispatchStrategyVersion: dispatch.enabled ? 'ubuddy_route_v2' : 'ubuddy_safe_route_v1',
      processStreamVersion: processStream.enabled ? 'process_event_stream_v2' : 'task_status_stream_v1',
      policies: {
        codexPrimaryV1,
        newTaskWorkspaceUi: workspaceUi,
        newDispatchStrategy: dispatch,
        newProcessEventStream: processStream,
        intakeClarificationV2,
        structuredTaskReference,
        profilePreviewV1,
        profilePreview,
        profileHistory,
        profilePublication,
        profileRoutingShadow,
        profileRoutingAuto,
        agentWorkDetailProjection,
        boundedDeliveryReworkV1,
        boundedDeliveryRework: boundedDeliveryReworkV1,
        unifiedAgentWorkKernelV2,
        messageModeV1,
        continuousPlanningV1,
        recentWorkReportingV1,
      planExecDrift,
      planExecDriftApply,
      capabilityDependencyScorer,
        ...(organizationEvolutionConfigured ? {
          organizationEvolutionCollectV1,
          organizationEvolutionApplyV1,
          organizationEvolutionDecompositionV1,
        } : {}),
      },
    };
  };

  return {
    resolve,
    snapshot,
    storedConfig: readStored,
  };
}

export function normalizeUBuddyFeatureFlagConfig(value = {}) {
  const parsed = typeof value === 'string' ? safeJson(value) : value;
  const result = {};
  for (const flag of Object.values(UBUDDY_FEATURE_FLAGS)) {
    const configured = firstConfiguredValue(
      parsed?.[flag],
      ...(LEGACY_SETTING_KEYS[flag] || []).map((key) => parsed?.[key]),
      parsed?.[shortFlagName(flag)],
    );
    if (OPTIONAL_DEFAULT_OFF_FLAGS.has(flag) && !configured.found) continue;
    const policy = normalizePolicy(configured.value, DEFAULT_ON_BY_DEFAULT.has(flag));
    result[flag] = policy.mode === 'percentage' ? `percentage:${policy.percentage}` : policy.mode;
  }
  return result;
}

function firstConfiguredValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return { found: true, value };
  }
  return { found: false, value: '' };
}

function normalizePolicy(value, defaultEnabled) {
  if (typeof value === 'boolean') return { mode: value ? 'on' : 'off', percentage: value ? 100 : 0 };
  if (typeof value === 'number') return percentagePolicy(value);
  if (value && typeof value === 'object') {
    if (String(value.mode || '').toLowerCase() === 'percentage') return percentagePolicy(value.percentage);
    return normalizePolicy(value.mode ?? value.enabled, defaultEnabled);
  }
  const text = String(value || '').trim().toLowerCase();
  if (!text) return { mode: defaultEnabled ? 'on' : 'off', percentage: defaultEnabled ? 100 : 0 };
  if (['1', 'true', 'on', 'enabled'].includes(text)) return { mode: 'on', percentage: 100 };
  if (['0', 'false', 'off', 'disabled'].includes(text)) return { mode: 'off', percentage: 0 };
  const percentage = /^(?:percentage|percent)\s*:\s*(\d+(?:\.\d+)?)$/.exec(text)?.[1];
  if (percentage !== undefined) return percentagePolicy(percentage);
  return { mode: defaultEnabled ? 'on' : 'off', percentage: defaultEnabled ? 100 : 0 };
}

function percentagePolicy(value) {
  const percentage = Math.max(0, Math.min(100, Number(value) || 0));
  return { mode: 'percentage', percentage };
}

function rolloutBucket(flag, subject) {
  const digest = crypto.createHash('sha256').update(`janus-rollout-v1:${flag}:${subject}`).digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16) % 100;
}

function shortFlagName(flag) {
  return String(flag || '').split('.').at(-1) || '';
}

function safeJson(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}
