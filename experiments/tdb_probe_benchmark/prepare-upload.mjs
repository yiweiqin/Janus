import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const current = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !(await fs.stat(path.join(source, 'package.json'))).isFile()) throw new Error('source_repository_required');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-clean-upload-'));
const stage = path.join(directory, 'Janus');
await fs.mkdir(stage);
const roots = ['assets', 'cloud', 'deploy', 'docs', 'experiments', 'network', 'scripts', 'src', 'package.json', 'package-lock.json', 'AGENTS.md', 'LICENSE', 'README.md', 'README.zh-CN.md', 'PROJECT_MEMORY.md', 'TEAMMATE_HANDOFF.md'];
const excludedDirs = new Set(['node_modules', 'data', 'output', 'runs', '.git', '.janus', '.cache', '__pycache__', '.venv', 'workspace', 'test-artifacts', 'dist', 'config']);
const excludedFile = (name) => /^\.env($|\.)|^\.orgbench_env|^auth\.json$|^config\.toml$|^prepare-upload\.mjs$|\.(db|sqlite|sqlite3|pem|key|zip|tar|gz)$/i.test(name);
const records = new Map();
async function copy(base, relative, provenance) {
  const original = path.join(base, relative), stat = await fs.lstat(original);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    if (excludedDirs.has(path.basename(original))) return;
    for (const name of (await fs.readdir(original)).sort()) await copy(base, path.join(relative, name), provenance);
    return;
  }
  if (!stat.isFile() || excludedFile(path.basename(original))) return;
  const data = await fs.readFile(original);
  if (data.includes(Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----')) || data.includes(Buffer.from('-----BEGIN RSA PRIVATE KEY-----'))) throw new Error(`private_key_file_rejected:${relative}`);
  const target = path.join(stage, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
  records.set(relative.replaceAll('\\', '/'), { sha256: crypto.createHash('sha256').update(data).digest('hex'), provenance });
}
for (const root of roots) {
  try { await fs.access(path.join(source, root)); } catch { continue; }
  await copy(source, root, 'recovered-source');
}
for (const relative of ['experiments/tdb_probe_benchmark', 'src/shared/contracts/uBuddyTaskDependencyBundle.js', 'src/shared/contracts/uBuddyProbeTdbBinding.js', 'src/shared/contracts/uBuddyProbeEffect.js']) {
  await copy(current, relative, 'current-probe-overlay');
}
const files = Object.fromEntries([...records].sort(([a], [b]) => a.localeCompare(b)));
await fs.writeFile(path.join(stage, 'SNAPSHOT_MANIFEST.json'), JSON.stringify({ version: 'janus-probe-upload-v1', files, exclusions: [...excludedDirs], credentialFilesIncluded: false }, null, 2));
await fs.writeFile(path.join(stage, 'SNAPSHOT_SHA256.txt'), Object.entries(files).map(([file, item]) => `${item.sha256}  ${file}`).join('\n') + '\n');
const archive = path.join(directory, 'janus-probe-source.tar.gz');
const result = spawnSync('tar', ['-czf', archive, '-C', directory, 'Janus'], { encoding: 'utf8', timeout: 29000 });
if (result.status !== 0) throw new Error(result.error?.message || result.stderr || 'archive_failed');
const data = await fs.readFile(archive);
console.log(JSON.stringify({ directory, stage, archive, files: records.size, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }, null, 2));
