import { runRemoteInitialization } from './remoteInitCore.mjs';

try {
  const result = await runRemoteInitialization();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`[orgbench-init] ${error?.message || error}`);
  process.exitCode = 1;
}
