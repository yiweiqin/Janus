import fs from 'node:fs/promises';
import path from 'node:path';
import { allAgentAliases, USERS } from './roster.mjs';

const dir = process.argv.includes('--output-dir') ? process.argv[process.argv.indexOf('--output-dir') + 1] : (process.env.UBUDDY_ORGBENCH_INIT_OUTPUT_DIR || '/var/lib/janus/orgbench-init');
const verification = JSON.parse(await fs.readFile(path.join(dir, 'remote-orgbench-verification.json'), 'utf8'));
const identities = JSON.parse(await fs.readFile(path.join(dir, 'remote-orgbench-identities.json'), 'utf8'));
const agentMap = JSON.parse(await fs.readFile(path.join(dir, 'remote-orgbench-agent-map.json'), 'utf8'));
const checks = {
  verificationPassed: verification.passed === true,
  sixUsers: identities.length === USERS.length,
  completeAgentMap: Object.keys(agentMap).length === allAgentAliases().length,
  noApiKeyInArtifacts: !JSON.stringify({ verification, identities, agentMap }).match(/(?:sk-|CRS_OAI_KEY|OPENAI_BASE_URL)/i),
};
const passed = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ version: 'remote_orgbench_verify_v1', passed, checks }, null, 2));
if (!passed) process.exitCode = 1;
