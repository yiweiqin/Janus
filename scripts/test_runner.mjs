import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const selected = args.includes('--case') && args[args.indexOf('--case') + 1] === 'ubuddy-full-chain'
  ? ['cloud/test/ubuddy-collaboration-graph.test.mjs']
  : [
      'cloud/test/ubuddy-collaboration-graph.test.mjs',
      'cloud/test/collaboration-state-graph.test.mjs',
      'experiments/ubuddy_orgbench/tests/orgbench_core.test.mjs',
    ];
const result = spawnSync(process.execPath, ['--test', ...selected], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
