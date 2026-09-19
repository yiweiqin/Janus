import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));

export function llmConfigured() {
  return Boolean(apiBase() && apiKey());
}

export function llmModel() {
  return process.env.RDMD_MODEL || process.env.UBUDDY_ORGBENCH_MODEL || process.env.UBUDDY_APPWORLD_MODEL || 'gpt-5.5';
}

/**
 * 调用模型，返回解析好的 JSON。
 *
 * `model` / `temperature` 是**可选覆盖**，默认值一字未改 —— 既有调用方
 * （`generate.mjs` / `ping_llm.mjs`）拿到的行为与之前完全一致。
 *
 * 为什么要有这两个参数：模拟任务群（`experiments/sim_task_group`）需要
 *   1. 走仓库统一的 `OPENAI_MODEL`（`llmModel()` 不认识它），
 *   2. 把温度压低以便重跑更接近（它的产物要进评测对照）。
 * 与其在 sim 那边再写一份 fetch，不如让这一份多接两个参数 ——
 * 两份传输实现意味着两条重试/超时/JSON 兜底策略，迟早会不一致。
 */
export async function llmJson({ system, user, stage = 'rdmd', retries = 3, timeoutMs = 120000, model = '', temperature = 0.7 }) {
  if (!llmConfigured()) throw new Error('model_endpoint_not_configured');
  const resolvedModel = String(model || llmModel());
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(`${apiBase()}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: resolvedModel,
          temperature: Number(temperature),
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`model_request_failed:${response.status}:${JSON.stringify(payload).slice(0, 400)}`);
      const content = String(payload.choices?.[0]?.message?.content || '').trim();
      if (!content) throw new Error(`${stage}_empty_content`);
      const value = JSON.parse(content);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${stage}_invalid_json`);
      return {
        value,
        model: resolvedModel,
        attempt,
        responseHash: createHash('sha256').update(content).digest('hex'),
      };
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(Math.min(8000, 800 * 2 ** attempt));
    }
  }
  throw new Error(`model_request_exhausted:${lastError?.message || lastError}`);
}

export function loadPrompt(name) {
  return readFileSync(join(ROOT, '../prompts', name), 'utf8').trim();
}

function apiBase() {
  return String(process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
}

function apiKey() {
  return process.env.CRS_OAI_KEY || process.env.OPENAI_API_KEY || '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
