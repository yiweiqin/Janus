import fs from 'node:fs/promises';
import path from 'node:path';
import { writeRun, verifyRun } from './artifacts.mjs';
import { validateRealTask } from './real-task-contract.mjs';

const help = `node runner.mjs <command> [options]
  run [--out NEW_DIRECTORY] [--seed 20260906] [--families 12] [--repeats 3]
  verify --out EXISTING_RUN_DIRECTORY
  report --out EXISTING_RUN_DIRECTORY
  doctor --task TASK_JSON
No auth, network, LLM or database required. Node >=22 required.
Run creates artifacts; verify/report/doctor are read-only. JSON output; errors exit 1.
Doctor validates metadata completeness only; it does not execute a real task.`;
try {
  const [command = '--help', ...args] = process.argv.slice(2);
  if (['--help', 'help'].includes(command)) console.log(help);
  else {
    const allowed = { run: ['out', 'seed', 'families', 'repeats'], verify: ['out'], report: ['out'], doctor: ['task'] }[command];
    if (!allowed) throw new Error('unknown_command');
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const k = args[i].replace(/^--/, '');
      if (!args[i].startsWith('--') || !allowed.includes(k) || options[k] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('invalid_options');
      options[k] = ['seed', 'families', 'repeats'].includes(k) ? Number(args[i + 1]) : args[i + 1];
    }
    let result;
    if (command === 'run') {
      const run = await writeRun(options);
      result = { directory: run.directory, counts: run.metrics.counts, evidenceLevel: run.metrics.evidenceLevel,
        byPolicy: run.metrics.byPolicy, verification: await verifyRun(run.directory) };
    } else if (command === 'doctor') {
      if (!options.task) throw new Error('task_required');
      result = validateRealTask(JSON.parse(await fs.readFile(options.task, 'utf8')));
      if (!result.metadataComplete) process.exitCode = 2;
    } else {
      if (!options.out) throw new Error('out_required');
      result = command === 'verify' ? await verifyRun(options.out) : JSON.parse(await fs.readFile(path.join(options.out, 'metrics.json'), 'utf8'));
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.code || error.message }));
  process.exitCode = 1;
}
