import { sha256 } from '../schema.mjs';

export class ModelPolicyClient {
  constructor() {
    this.baseUrl = String(process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
    this.apiKey = process.env.CRS_OAI_KEY || '';
    this.model = process.env.UBUDDY_ORGBENCH_MODEL || process.env.UBUDDY_APPWORLD_MODEL || 'gpt-5.4-mini';
  }
  configured() { return Boolean(this.baseUrl && this.apiKey); }
  async json(system, user, options = {}) {
    if (!this.configured()) throw new Error('model_endpoint_not_configured');
    const normalized = typeof options === 'number' ? { maxTokens: options } : (options || {});
    const configuredMaxTokens = normalized.maxTokens ?? process.env.UBUDDY_ORGBENCH_MODEL_MAX_TOKENS;
    const maxTokens = configuredMaxTokens === undefined || configuredMaxTokens === null || configuredMaxTokens === '' ? null : Number(configuredMaxTokens);
    const validate = typeof normalized.validate === 'function' ? normalized.validate : null;
    const stage = String(normalized.stage || 'model_json');
    const attempts = Number(process.env.UBUDDY_ORGBENCH_MODEL_RETRIES || 3); let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, temperature: 0, ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { max_tokens: maxTokens } : {}), ...(process.env.UBUDDY_ORGBENCH_THINKING ? { thinking: { type: process.env.UBUDDY_ORGBENCH_THINKING } } : {}), response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
          signal: AbortSignal.timeout(Number(process.env.UBUDDY_ORGBENCH_MODEL_TIMEOUT_MS || 180000)),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`model_request_failed:${response.status}:${JSON.stringify(payload).slice(0, 500)}`);
        const choice = payload.choices?.[0] || {};
        const finishReason = String(choice.finish_reason || '');
        if (['length', 'max_tokens'].includes(finishReason)) throw new Error(`${stage}_output_truncated:${maxTokens ? `configured_max_tokens=${maxTokens}` : 'provider_output_limit'}`);
        const content = String(choice.message?.content || '').trim();
        // Some reasoning-model compatible gateways return the answer in
        // reasoning_content when thinking is enabled. Treat that as a
        // compatibility fallback only when it is valid JSON; never expose the
        // reasoning trace as a public result.
        const reasoningContent = String(choice.message?.reasoning_content || '').trim();
        const candidate = content || (reasoningContent.startsWith('{') && reasoningContent.endsWith('}') ? reasoningContent : '');
        if (!candidate) throw new Error(`${stage}_empty_content`);
        const value = JSON.parse(candidate);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${stage}_invalid_json_object`);
        if (validate) validate(value);
        return { value, usage: payload.usage || null, responseHash: sha256(candidate), model: this.model, attempt, finishReason, maxTokens };
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 1000 * 2 ** (attempt - 1))));
      }
    }
    throw new Error(`model_request_exhausted:${lastError?.message || lastError}`);
  }
}

export function requesterDecision({ client, problem, profiles, board, method, evolutionContext = null }) {
  return client.json(
    `You are requester uBuddy, a task secretary and organizer. You do not execute work. Dynamically decide which uBuddies to invite and create a non-empty first-level task plan. Only use provided uBuddy IDs. Never select or mention another uBuddy's internal Agents. Return JSON only: {"inviteUbuddyIds":["..."],"tasks":[{"id":"task_1","title":"...","description":"...","capability":"research|data_analysis|coding|web_operation|communication|review|file_operation|planning|execution","assigneeUbuddyId":"...","dependsOn":[]}]} . Include a review task. Method=${method}.`,
    `Problem:\n${problem}\n\nPublished uBuddy profiles:\n${JSON.stringify(profiles)}\n\nActive organization playbook (apply only when task scope matches):\n${JSON.stringify(evolutionContext?.playbook || null)}\n\nPublic collaboration board:\n${JSON.stringify(board)}`,
    {
      stage: 'requester_organization',
      maxTokens: process.env.UBUDDY_ORGBENCH_ORGANIZATION_MAX_TOKENS || undefined,
      validate: (value) => {
        if (!Array.isArray(value.inviteUbuddyIds)) throw new Error('requester_invite_list_missing');
        if (!Array.isArray(value.tasks) || !value.tasks.length) throw new Error('requester_tasks_missing');
      },
    },
  );
}

export function recipientDecision({ client, ubuddyId, assignedTasks, internalAgents, board, method, evolutionContext = null }) {
  return client.json(
    `You are ${ubuddyId}, a recipient uBuddy. You organize work but do not execute it. Decompose assigned work into executable leaf tasks and assign each leaf to one of your own provided internal Agent IDs. Return JSON only: {"subtasks":[{"id":"...","parentTaskId":"...","title":"...","description":"...","capability":"...","agentInstanceId":"...","dependsOn":[]}]} . Method=${method}.`,
    `Assigned tasks:\n${JSON.stringify(assignedTasks)}\n\nYour private internal Agent capability summaries and active version IDs:\n${JSON.stringify(internalAgents)}\n\nActive organization playbook:\n${JSON.stringify(evolutionContext?.playbook || null)}\n\nPublic board:\n${JSON.stringify(board)}`,
    {
      stage: `recipient_organization:${ubuddyId}`,
      maxTokens: process.env.UBUDDY_ORGBENCH_ORGANIZATION_MAX_TOKENS || undefined,
      validate: (value) => {
        if (!Array.isArray(value.subtasks) || !value.subtasks.length) throw new Error('recipient_subtasks_missing');
      },
    },
  );
}

export function recoveryDecision({ client, ubuddyId, failedTask, internalAgents, board, method }) {
  return client.json(
    `You are ${ubuddyId}, the owner uBuddy of a failed internal task. You organize recovery but never execute tools. Choose one action: retry with the same Agent, reassign to another one of your own Agent IDs, or propose one replacement subtask. Return JSON only: {"action":"retry|reassign|replace|block","agentInstanceId":"...","replacement":{"id":"...","title":"...","description":"...","capability":"...","dependsOn":[]},"reason":"..."}. Never select another uBuddy's internal Agent. Method=${method}.`,
    `Failed task:\n${JSON.stringify(failedTask)}\n\nYour internal Agents:\n${JSON.stringify(internalAgents)}\n\nLatest public board:\n${JSON.stringify(board)}`,
    {
      stage: `recovery:${ubuddyId}`,
      maxTokens: process.env.UBUDDY_ORGBENCH_RECOVERY_MAX_TOKENS || undefined,
      validate: (value) => {
        if (!['retry', 'reassign', 'replace', 'block'].includes(String(value.action))) throw new Error('recovery_action_invalid');
      },
    },
  );
}
