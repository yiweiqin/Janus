// Agent 内部执行规划（plan steps）的归一化契约。
//
// ## 数据来源只有一个
//
//   Codex app-server 的 `turn/plan/updated` 通知
//     -> src/main/codex.js（activityType: 'plan'）
//     -> src/main/scheduler.js（TASK_PROCESS_STRUCTURED_FIELDS 白名单含 'plan'）
//     -> task_events.payload_json.plan
//
// 实测（experiments/rdmd_detective_dataset/ubuddy_recon/_probe_plan_steps.mjs）：
// rollout JSONL 里**没有** plan 数据（19 个文件、1616 行，payload type 直方图里没有任何 plan），
// 所以 rollout 层不可能看到 agent 规划。除了 task_events，没有第二条通路。
//
// ## step 的字段形状
//
// 更正（2026-09-19）：这里原来写的是「实测（_probe_task_events_plan.mjs）：本地真实库里
// `activityType='plan'` 有 **0** 条，也就是说真实数据上还没有观测到过一个 plan step」。
// **那句话是错的**，而且它的来源正是本文件上面那条通路的**最后一个环节已经跑通**却没被看见。
//
// 错在哪：`_probe_task_events_plan.mjs` 在 WHERE 里用了 SELECT 别名
// （`WHERE activityType = 'plan'`）。SQLite 只在 `GROUP BY` 那种形式上容忍别名，
// 这种比较会抛 `no such column: activityType`；而探针的 `q()` 是 `catch { return [] }`，
// 于是「SQL 写错了」被读成了「真实数据里没有」。已修（探针现在查询失败就打印并非零退出）。
//
// 实测（同一个探针，修好之后，只读 `C:\Users\zhang\.janus-test\data\janus.db`）：
// `payload.activityType='plan'` 的事件有 **6 条 / 25 个 step**，落在 3 个 task run 上；
// 生产者 `eventOrigin='codex'` / `nativeSource='codex_app_server'` / `event_type='node_activity'`；
// step 形状**恰好就是** `{step, status}`，status 实测取值 completed(16) / pending(7) / inProgress(2)。
//
// 也就是说上面那条 `codex.js -> scheduler.js -> task_events.payload_json.plan` 通路
// **在真实数据上是被验证过通的**（这是本轮少有的好消息：采集侧不需要修）。
// 而且形状与下面的归一化代码完全对齐：`step` 命中 `source.step`，
// `inProgress`/`pending` 分别落进 `running`/`queued`。
//
// 尚未观测到的是**下一个环节**：`collaboration_graph_*` 表在活库里不存在，
// 因为已安装构建的 `app.asar` 里没有 `ensureUBuddyCollaborationGraphSchema`
// —— 所以 `projectAgentPlanSteps` 一次都没跑过。那是发布缺口，见
// `experiments/rdmd_detective_dataset/ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md` §11。
//
// 因此这里的形状断言仍然取自产品自己的消费点（口径一致），并且**不假设**字段一定存在 ——
// 一律防御性归一（现在这条已经不只是防御：真实形状与假设一致，且已实测）：
//
//   src/renderer/app/views/chatView.js      normalizeChatPlan        -> label | step, detail | description, status
//   src/renderer/app/core/rendererApp.js    normalizedPlanSteps      -> label | step, status
//   src/main/codex.js                       step?.status === 'completed'
//   src/main/prompts.js                     step.label, step.detail
//
// ## 截断
//
// scheduler 的 boundedTaskProcessValue 会在超过 12KB 时把载荷换成
// `{ truncated: true, preview }`。这种载荷**不可解析**，`normalizeAgentPlan`
// 会返回 `supported: false`，调用方必须跳过而不是猜 —— 宁缺毋滥。

export const UBUDDY_AGENT_PLAN_STEP_VERSION = 'ubuddy_agent_plan_steps_v1';

// 单次计划最多投影多少步。计划通常 <20 步；设上限只为了防止坏载荷把图撑爆。
export const UBUDDY_AGENT_PLAN_MAX_STEPS = 50;

const COMPLETED_STATUSES = new Set(['completed', 'complete', 'done', 'finished', 'success', 'succeeded']);
const ACTIVE_STATUSES = new Set(['active', 'running', 'inprogress', 'in_progress', 'in-progress', 'started']);

export function normalizeAgentPlanStepStatus(status = '') {
  const value = String(status || '').trim().toLowerCase();
  if (COMPLETED_STATUSES.has(value)) return 'completed';
  if (ACTIVE_STATUSES.has(value)) return 'running';
  return 'queued';
}

export function normalizeAgentPlanStep(step = {}, index = 0) {
  const source = step && typeof step === 'object' && !Array.isArray(step) ? step : {};
  const label = String(source.label || source.step || source.title || '').replace(/\s+/g, ' ').trim();
  if (!label) return null;
  return {
    index,
    label: label.slice(0, 240),
    detail: String(source.detail || source.description || '').replace(/\s+/g, ' ').trim().slice(0, 2_000),
    status: normalizeAgentPlanStepStatus(source.status),
  };
}

/**
 * 一次 `turn/plan/updated` 的载荷 -> 归一化的计划快照。
 *
 * @returns {{supported: boolean, explanation: string, steps: Array<{index:number,label:string,detail:string,status:string}>}}
 *   `supported:false` 表示这不是一个可用的计划（截断载荷、空计划、形状不认识），调用方必须跳过。
 */
export function normalizeAgentPlan(plan = {}) {
  if (Array.isArray(plan)) return finishPlan('', plan);
  if (!plan || typeof plan !== 'object') return { supported: false, explanation: '', steps: [] };
  if (plan.truncated === true) return { supported: false, explanation: '', steps: [] };
  const source = Array.isArray(plan.steps) ? plan.steps : Array.isArray(plan.plan) ? plan.plan : null;
  if (!source) return { supported: false, explanation: '', steps: [] };
  return finishPlan(String(plan.explanation || plan.rationale || plan.content || ''), source);
}

/** 从 `task.events`（已按 created_at 升序）里挑出 plan 事件。 */
export function agentPlanEventsFromTaskEvents(events = []) {
  return (Array.isArray(events) ? events : []).filter((event) => (
    String(event?.payload?.activityType || '') === 'plan' && event?.payload?.plan !== undefined
  ));
}

/**
 * 把某个 task node 的 plan 事件序列折成「最终计划状态 + 被砍掉的步骤」。
 *
 * 之所以要折而不是只取一条：agent 会重复发 `turn/plan/updated` 来推进 step 状态，
 * 图上只应该体现**最新状态**；而「第一次计划」和「最终计划」的差异正是 G_plan vs G_exec
 * 要在 agent 层表达的漂移。
 *
 * @param {Array} events 该 task node 的 plan 事件（按 created_at 升序）
 * @param {{revisionOf?: (event: object) => number}} [options]
 *   `revisionOf` 提供源版本号（例如事件时间戳）。为保证单调，返回值会被强制严格递增，
 *   否则 `source_revision` 守卫会把后到的计划当成过期数据丢掉。
 * @returns {{steps: Array, cancelled: Array, explanation: string, revisions: number, skipped: number, lastRevision: number}}
 */
export function foldAgentPlanEvents(events = [], { revisionOf = null } = {}) {
  const ordered = Array.isArray(events) ? events : [];
  // 每个 step 序号「最后一次出现时」的样子（含当时的 label，供后续标记 cancelled 用）。
  const latestByIndex = new Map();
  // 最后一版计划实际包含的序号。与 latestByIndex 的差集 = 被后续版本砍掉的步骤。
  let lastRevisionIndexes = new Set();
  let maxIndex = -1;
  let explanation = '';
  let revisions = 0;
  let skipped = 0;
  let lastRevision = 0;
  for (const event of ordered) {
    const plan = normalizeAgentPlan(event?.payload?.plan);
    if (!plan.supported) {
      skipped += 1;
      continue;
    }
    revisions += 1;
    let revision = typeof revisionOf === 'function' ? Number(revisionOf(event)) || 0 : revisions;
    if (revision <= lastRevision) revision = lastRevision + 1;
    lastRevision = revision;
    if (plan.explanation) explanation = plan.explanation;
    const updatedAt = String(event?.createdAt || '');
    for (const step of plan.steps) {
      latestByIndex.set(step.index, { ...step, revision, updatedAt });
      if (step.index > maxIndex) maxIndex = step.index;
    }
    lastRevisionIndexes = new Set(plan.steps.map((step) => step.index));
  }
  const steps = [...latestByIndex.values()]
    .filter((step) => lastRevisionIndexes.has(step.index))
    .sort((a, b) => a.index - b.index);
  const cancelled = [];
  for (let index = 0; index <= maxIndex; index += 1) {
    if (lastRevisionIndexes.has(index)) continue;
    const previous = latestByIndex.get(index);
    if (previous) cancelled.push({ index, label: previous.label, revision: previous.revision });
  }
  return { steps, cancelled, explanation, revisions, skipped, lastRevision };
}

/** 第一版计划（G_plan 的 agent 层）。没有可用计划时返回 `supported: false`。 */
export function firstAgentPlan(events = []) {
  for (const event of Array.isArray(events) ? events : []) {
    const plan = normalizeAgentPlan(event?.payload?.plan);
    if (plan.supported) return plan;
  }
  return { supported: false, explanation: '', steps: [] };
}

function finishPlan(explanation, source) {
  const steps = [];
  for (const item of source.slice(0, UBUDDY_AGENT_PLAN_MAX_STEPS)) {
    const step = normalizeAgentPlanStep(item, steps.length);
    if (step) steps.push(step);
  }
  return {
    supported: steps.length > 0,
    explanation: String(explanation || '').replace(/\s+/g, ' ').trim().slice(0, 2_000),
    steps,
  };
}
