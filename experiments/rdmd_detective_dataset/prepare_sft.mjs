import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { SCHEMA, structuralGraph } from './lib/graph.mjs';
import { validateSample } from './lib/gates.mjs';
import { isMainSupervised, toSftRow, SFT_SCHEMA } from './lib/sft.mjs';
import { detectMinimalDrift } from '../../src/shared/contracts/uBuddyReverseDetective.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');
const OUT = join(ROOT, 'sft');
const smoke = process.argv.includes('--smoke');

export function prepareSft({ smoke: smokeFlag = smoke } = {}) {
  const splits = ['train', 'development', 'test'].map((name) => ({
    name,
    rows: readJsonl(join(DATA, `${name}.jsonl`)),
  }));
  const all = splits.flatMap((item) => item.rows);
  if (!all.length) throw new Error('raw_splits_missing');

  const buckets = {
    train: [],
    development: [],
    test: [],
    eval_unknown: [],
    eval_no_drift: [],
  };
  const rejected = [];
  const graphSplit = new Map();
  const chars = [];

  for (const sample of all) {
    const gate = validateSample(sample, { requireSplit: true });
    if (gate.length) {
      rejected.push({ id: sample.id, errors: gate });
      continue;
    }
    const prev = graphSplit.get(sample.graph_id);
    if (prev && prev !== sample.split) {
      rejected.push({ id: sample.graph_id, errors: ['graph_id_split_leak'] });
      continue;
    }
    graphSplit.set(sample.graph_id, sample.split);

    const supervised = sample.split !== 'test' && isMainSupervised(sample.label.status);
    const { row, errors } = toSftRow(sample, { supervised });
    if (!row || errors.length) {
      rejected.push({ id: sample.id, errors: errors.length ? errors : ['sft_row_invalid'] });
      continue;
    }
    chars.push(row.chars);
    if (sample.split === 'train' || sample.split === 'development') {
      if (supervised) buckets[sample.split].push(row);
    }
    if (sample.split === 'test') buckets.test.push(row);
    if (sample.split === 'test' && sample.label.status === 'UNKNOWN') buckets.eval_unknown.push(row);
    if (sample.split === 'test' && sample.label.status === 'no_drift') buckets.eval_no_drift.push(row);
  }

  const unknownInMain = [...buckets.train, ...buckets.development].filter((row) => row.status === 'UNKNOWN');
  if (unknownInMain.length < 1) throw new Error('unknown_missing_from_main_loss');

  mkdirSync(OUT, { recursive: true });
  mkdirSync(join(OUT, 'smoke'), { recursive: true });
  const written = {};
  for (const name of ['train', 'development', 'test', 'eval_unknown', 'eval_no_drift']) {
    const rows = smokeFlag ? buckets[name].slice(0, name === 'train' ? 24 : 8) : buckets[name];
    const path = join(OUT, `${name}.jsonl`);
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
    written[name] = { n: rows.length, path: rel(path), sha256: fileHash(path) };
  }
  writeSmoke(buckets);

  const tokenFromChars = chars.map((n) => Math.ceil(n / 1.6) + 48);
  const tokenAudit = {
    n: chars.length,
    chars: stats([...chars].sort((a, b) => a - b)),
    estimatedTokens: stats([...tokenFromChars].sort((a, b) => a - b)),
    recommendedMaxLength: recommendMaxLength(tokenFromChars),
  };
  writeFileSync(join(OUT, 'token_audit.json'), `${JSON.stringify(tokenAudit, null, 2)}\n`);

  const rawTest = splits.find((item) => item.name === 'test').rows;
  const baseline = scoreBaseline(smokeFlag ? rawTest.slice(0, 32) : rawTest);
  writeFileSync(join(OUT, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);

  const manifest = {
    schemaVersion: SFT_SCHEMA,
    sourceVersion: SCHEMA.version,
    generatedAt: new Date().toISOString(),
    smoke: Boolean(smokeFlag),
    instruction: 'lib/sft.mjs#DETECTIVE_INSTRUCTION',
    mainLoss: ['drift', 'no_drift', 'UNKNOWN'],
    evalOnly: [],
    unknownInMainLoss: unknownInMain.length,
    testReadDuringTraining: false,
    graphLeak: 0,
    rejected: rejected.length,
    files: written,
    tokenAudit,
    baseline,
    counts: {
      train: written.train.n,
      development: written.development.n,
      test: written.test.n,
      eval_unknown: written.eval_unknown.n,
      eval_no_drift: written.eval_no_drift.n,
    },
    sourceSha256: {
      train: fileHash(join(DATA, 'train.jsonl')),
      development: fileHash(join(DATA, 'development.jsonl')),
      test: fileHash(join(DATA, 'test.jsonl')),
    },
    status: rejected.length ? 'BLOCKED' : 'READY_FOR_QLORA',
  };
  if (rejected.length) manifest.rejectedSample = rejected.slice(0, 20);
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function writeSmoke(buckets) {
  const smokeTrain = buckets.train.slice(0, 24);
  const smokeDev = buckets.development.slice(0, 8);
  writeFileSync(join(OUT, 'smoke', 'train.jsonl'), smokeTrain.map((row) => JSON.stringify(row)).join('\n') + (smokeTrain.length ? '\n' : ''));
  writeFileSync(join(OUT, 'smoke', 'development.jsonl'), smokeDev.map((row) => JSON.stringify(row)).join('\n') + (smokeDev.length ? '\n' : ''));
}

function scoreBaseline(rows) {
  const drift = rows.filter((row) => row.label?.status === 'drift');
  let hit = 0;
  let typeHit = 0;
  let unknownOnSingle = 0;
  for (const row of drift) {
    const prediction = detectMinimalDrift(structuralGraph(row.G_star), structuralGraph(row.G_prime));
    if (prediction.status === 'UNKNOWN') unknownOnSingle += 1;
    if (prediction.status === 'drift' && prediction.nodeId === row.label.injected_node) hit += 1;
    if (prediction.type === row.label.injected_type) typeHit += 1;
  }
  const noDrift = rows.filter((row) => row.label?.status === 'no_drift');
  const noDriftOk = noDrift.filter((row) => detectMinimalDrift(structuralGraph(row.G_star), structuralGraph(row.G_prime)).status === 'no_drift').length;
  const unknown = rows.filter((row) => row.label?.status === 'UNKNOWN');
  const unknownOk = unknown.filter((row) => detectMinimalDrift(structuralGraph(row.G_star), structuralGraph(row.G_prime)).status === 'UNKNOWN').length;
  return {
    n: rows.length,
    drift: {
      n: drift.length,
      topologicalHit: drift.length ? hit / drift.length : 0,
      typeHit: drift.length ? typeHit / drift.length : 0,
      unknownRate: drift.length ? unknownOnSingle / drift.length : 0,
    },
    noDrift: { n: noDrift.length, correct: noDrift.length ? noDriftOk / noDrift.length : 0 },
    unknown: { n: unknown.length, correct: unknown.length ? unknownOk / unknown.length : 0 },
  };
}

function stats(sorted) {
  if (!sorted.length) return { min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  return {
    min: sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
  };
}

function recommendMaxLength(tokens) {
  const max = tokens.length ? Math.max(...tokens) : 0;
  for (const cap of [4096, 8192, 16384, 24576, 32768]) {
    if (max <= cap - 128) return cap;
  }
  return 32768;
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function fileHash(path) {
  if (!existsSync(path)) return '';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function rel(path) {
  return path.replace(`${ROOT}\\`, '').replace(`${ROOT}/`, '');
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const manifest = prepareSft();
  console.log(JSON.stringify({
    ok: manifest.status === 'READY_FOR_QLORA',
    status: manifest.status,
    counts: manifest.counts,
    rejected: manifest.rejected,
    recommendedMaxLength: manifest.tokenAudit.recommendedMaxLength,
    estimatedTokens: manifest.tokenAudit.estimatedTokens,
  }, null, 2));
  if (manifest.status !== 'READY_FOR_QLORA') process.exitCode = 1;
}
