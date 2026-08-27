import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--test', 'cloud/test/ubuddy-collaboration-graph.test.mjs'], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
