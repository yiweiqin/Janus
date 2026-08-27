import { sha256 } from '../schema.mjs';

export class ModelPolicyClient {
  constructor() {
    this.baseUrl = String(process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
    this.apiKey = process.env.CRS_OAI_KEY || '';
    this.model = process.env.UBUDDY_ORGBENCH_MODEL || process.env.UBUDDY_APPWORLD_MODEL || 'gpt-5.4-mini';
  }
  configured() { return Boolean(this.baseUrl && this.apiKey); }
  async json(system, user, maxTokens = 1400) {
    if (!this.configured()) throw new Error('model_endpoint_not_configured');
    const attempts = Number(process.env.UBUDDY_ORGBENCH_MODEL_RETRIES || 3); let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, temperature: 0, max_tokens: maxTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
          signal: AbortSignal.timeout(Number(process.env.UBUDDY_ORGBENCH_MODEL_TIMEOUT_MS || 180000)),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`model_request_failed:${response.status}:${JSON.stringify(payload).slice(0, 500)}`);
        const content = String(payload.choices?.[0]?.message?.content || '{}');
        return { value: JSON.parse(content), usage: payload.usage || null, responseHash: sha256(content), model: this.model, attempt };
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
  );
}

export function recipientDecision({ client, ubuddyId, assignedTasks, internalAgents, board, method, evolutionContext = null }) {
  return client.json(
    `You are ${ubuddyId}, a recipient uBuddy. You organize work but do not execute it. Decompose assigned work into executable leaf tasks and assign each leaf to one of your own provided internal Agent IDs. Return JSON only: {"subtasks":[{"id":"...","parentTaskId":"...","title":"...","description":"...","capability":"...","agentInstanceId":"...","dependsOn":[]}]} . Method=${method}.`,
    `Assigned tasks:\n${JSON.stringify(assignedTasks)}\n\nYour private internal Agent capability summaries and active version IDs:\n${JSON.stringify(internalAgents)}\n\nActive organization playbook:\n${JSON.stringify(evolutionContext?.playbook || null)}\n\nPublic board:\n${JSON.stringify(board)}`,
  );
}

export function recoveryDecision({ client, ubuddyId, failedTask, internalAgents, board, method }) {
  return client.json(
    `You are ${ubuddyId}, the owner uBuddy of a failed internal task. You organize recovery but never execute tools. Choose one action: retry with the same Agent, reassign to another one of your own Agent IDs, or propose one replacement subtask. Return JSON only: {"action":"retry|reassign|replace|block","agentInstanceId":"...","replacement":{"id":"...","title":"...","description":"...","capability":"...","dependsOn":[]},"reason":"..."}. Never select another uBuddy's internal Agent. Method=${method}.`,
    `Failed task:\n${JSON.stringify(failedTask)}\n\nYour internal Agents:\n${JSON.stringify(internalAgents)}\n\nLatest public board:\n${JSON.stringify(board)}`,
    900,
  );
}
