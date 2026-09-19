import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

export function validateDir(dir) {
  const required = [
    'manifest.json', 'validation.json', 'people.jsonl', 'agents.jsonl',
    'agent_profiles.jsonl', 'ubuddy_profiles.jsonl', 'pairs.jsonl', 'annotation_cards.jsonl',
  ];
  const missing = required.filter((name) => !existsSync(join(dir, name)));
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const validation = JSON.parse(readFileSync(join(dir, 'validation.json'), 'utf8'));
  const pairs = readJsonl(join(dir, 'pairs.jsonl'));
  const combined = pairs.filter((pair) => pair.combined != null).length;
  const report = {
    dir,
    missing,
    validation,
    counts: manifest.counts,
    pairKinds: manifest.pairKinds,
    splits: manifest.splits,
    combined,
    pass: missing.length === 0 && validation.ok && combined === 0 && Number(manifest.counts?.pairs || 0) >= (manifest.smoke ? 20 : 8000),
  };
  return report;
}

function readJsonl(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const smoke = process.argv.includes('--smoke');
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const dir = join(ROOT, 'data', smoke ? 'smoke' : 'full');
  const report = validateDir(dir);
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exit(1);
}
