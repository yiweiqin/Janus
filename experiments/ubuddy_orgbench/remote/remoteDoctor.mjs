#!/usr/bin/env node
import fs from 'node:fs/promises';
import process from 'node:process';

const paths = { appworldRoot: process.env.APPWORLD_ROOT, appworldPython: process.env.APPWORLD_PYTHON, outputRoot: process.env.UBUDDY_ORGBENCH_OUTPUT_ROOT };
const checks = [{ name: 'linux', ok: process.platform === 'linux', detail: process.platform }, { name: 'remote_ack', ok: process.env.UBUDDY_ORGBENCH_REMOTE === '1', detail: 'UBUDDY_ORGBENCH_REMOTE=1' }, { name: 'model_endpoint', ok: Boolean(process.env.CRS_OAI_KEY && process.env.OPENAI_BASE_URL), detail: 'CRS_OAI_KEY + OPENAI_BASE_URL' }];
for (const [name, value] of Object.entries(paths)) { let ok = false; if (value) { try { await fs.access(value); ok = true; } catch {} } checks.push({ name, ok, detail: value || 'missing' }); }
const ready = checks.every((check) => check.ok);
console.log(JSON.stringify({ benchmark: 'ubuddy_orgbench_v2', ready, checks, mutatesState: false }, null, 2));
process.exitCode = ready ? 0 : 1;
