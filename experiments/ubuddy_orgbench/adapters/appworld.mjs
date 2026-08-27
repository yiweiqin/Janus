import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function appworldAdapter({ root = process.env.APPWORLD_ROOT || 'D:/Cli-anything/benchmarks/appworld-runtime', manifestPath = 'D:/Cli-anything/Janus/experiments/ubuddy_appworld/appworld_tasks.manifest.json' } = {}) {
  const python = process.env.APPWORLD_PYTHON || 'D:/Cli-anything/benchmarks/appworld-official/.venv313/Scripts/python.exe';
  const bridgeScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ubuddy_appworld/appworld_bridge.py');
  function startBridge() {
    const child = spawn(python, [bridgeScript], { env: { ...process.env, APPWORLD_ROOT: root }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    let buffer = ''; const pending = [];
    child.stdout.on('data', (chunk) => { buffer += chunk.toString(); let index; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim()) { const resolver = pending.shift(); if (resolver) resolver(JSON.parse(line)); } } });
    const call = (payload) => new Promise((resolve, reject) => { pending.push((response) => response.ok ? resolve(response.result) : reject(new Error(response.error))); child.stdin.write(`${JSON.stringify(payload)}\n`); });
    return { child, call, close: () => child.kill() };
  }
  return {
    name: 'appworld',
    async doctor() { try { await fs.access(path.join(root, 'data')); await fs.access(manifestPath); return { available: true, root, manifestPath }; } catch { return { available: false, root, manifestPath }; } },
    async manifest() { return JSON.parse(await fs.readFile(manifestPath, 'utf8')); },
    async evaluateTask(taskId, { actionFile = null, experimentName = `orgbench-${Date.now()}` } = {}) {
      const bridge = startBridge();
      try {
        const reset = await bridge.call({ command: 'reset', taskId, experimentName });
        let actionResult = null;
        if (actionFile) {
          const actions = JSON.parse(await fs.readFile(actionFile, 'utf8'));
          actionResult = [];
          for (const action of actions) actionResult.push(await bridge.call({ command: 'execute', role: action.role || 'internal_agent', code: String(action.code || '') }));
        }
        const evaluation = await bridge.call({ command: 'evaluate' });
        return { reset, actionResult, evaluation, evaluatorVersion: 'appworld-official' };
      } finally { await bridge.call({ command: 'close' }).catch(() => {}); bridge.close(); }
    },
  };
}
