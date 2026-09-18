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

export async function llmJson({ system, user, stage = 'rdmd', retries = 3, timeoutMs = 120000 }) {
  if (!llmConfigured()) throw new Error('model_endpoint_not_configured');
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(`${apiBase()}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: llmModel(),
          temperature: 0.7,
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
        model: llmModel(),
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
