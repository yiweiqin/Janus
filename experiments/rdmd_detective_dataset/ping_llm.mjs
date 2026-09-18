import { llmConfigured, llmJson, llmModel } from './lib/llmClient.mjs';

const configured = llmConfigured();
console.log(JSON.stringify({ configured, model: llmModel() }));
if (!configured) process.exit(2);
const result = await llmJson({
  system: 'Return only a JSON object.',
  user: 'Return {"ok":true}',
  stage: 'ping',
  retries: 1,
  timeoutMs: 45000,
});
console.log(JSON.stringify(result.value));
