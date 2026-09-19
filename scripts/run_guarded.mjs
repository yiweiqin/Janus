// Serial long-running commands with bounded runtime and resource checks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
if (args.shift() !== '--' || !args.length) throw new Error('usage: run_guarded.mjs -- command args');
const lock = path.join(process.cwd(), '.long-command.lock');
const timeout = Number(process.env.JANUS_GUARD_TIMEOUT_SECONDS || 7200);
if (!Number.isFinite(timeout) || timeout < 1 || timeout > 86400) throw new Error('invalid_guard_timeout');
function safe() {
  let free = os.freemem();
  if (process.platform === 'linux') free = Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)?.[1] || 0) * 1024;
  return free >= 2 * 1024 ** 3 && os.loadavg()[0] <= Math.max(2, os.cpus().length * 2);
}
if (!safe()) throw new Error('resource_pressure: waiting required');
const fd = fs.openSync(lock, 'wx');
fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString(), command: args[0] }));
fs.closeSync(fd);
let child, timer, deadline, force, failures = 0, stopped = false;
function stop(reason) {
  if (stopped) return; stopped = true;
  console.error(JSON.stringify({ guardStop: reason }));
  const kill = signal => { try { process.platform === 'linux' ? process.kill(-child.pid, signal) : child.kill(signal); } catch {} };
  kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 10000);
}
function clean() { clearInterval(timer); clearTimeout(deadline); clearTimeout(force); fs.unlinkSync(lock); }
child = spawn(args[0], args.slice(1), { stdio: 'inherit', detached: process.platform === 'linux' });
try { os.setPriority(child.pid, 10); } catch {}
child.on('error', error => { console.error(error.message); clean(); process.exitCode = 1; });
child.on('exit', code => { clean(); process.exitCode = stopped ? 124 : (code ?? 1); });
timer = setInterval(() => { failures = safe() ? 0 : failures + 1; if (failures >= 3) stop('resource_pressure'); }, 10000);
deadline = setTimeout(() => stop('timeout'), timeout * 1000);
process.on('SIGTERM', () => stop('signal')); process.on('SIGINT', () => stop('signal'));
