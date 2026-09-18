/**
 * Out-of-distribution (OOD) probe for the RDMD detective model.
 *
 * WHY THIS EXISTS
 * ---------------
 * The v3 held-out test split has "zero topology overlap" with train, but that claim is narrower
 * than it sounds: the generator derives domain / topic / structure from the graph index, so all
 * 10 DOMAINS and all 4 STRUCTURES appear in train, and the step lists pin every golden graph to
 * 19-21 nodes even though the schema allows 16-32. The v3 scores therefore measure *within-family*
 * generalisation. This script builds rows that are legal under the schema but were never observed:
 *
 *   - SCALE:  16 / 24 / 32 nodes (schema-legal; train only ever saw 19-21)
 *             48 / 80 nodes (out-of-contract probes, to locate the real breaking point)
 *   - SHAPE:  chain_side / wide_fan / nested_diamond / layered_mesh
 *             (none of these is the generator's linear / fork_join / late_diamond / side_track)
 *
 * WHAT IT DELIBERATELY KEEPS CONSTANT
 * -----------------------------------
 * Node vocabulary is borrowed from a real generated golden graph (same domain, topic, titles and
 * artifact/summary conventions) and the injection pipeline is the *same code* the training data
 * went through (pickInjection -> applyLocalEdit -> inferDownstream -> addDecoyNodes). That isolates
 * the two variables under test. If these probes fail, it is because of scale/shape, not because the
 * words changed.
 *
 * THE BASELINE IS NOT COMPUTED HERE. It lives in scripts/rdmd_trivial_baseline.py (rules A-E) and is
 * applied to this script's output by score_ood.py. Duplicating it here would let the two definitions
 * drift, and a mis-stated baseline is worse than no baseline.
 *
 * A candidate is kept only if it passes the dataset gate, exactly as generate.mjs does -- malformed
 * probes would silently invalidate the cells they cover. In-contract rows must pass cleanly;
 * out-of-contract rows may fail *only* on node count.
 *
 * Usage: node experiments/rdmd_detective_dataset/make_ood.mjs
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRIFT_TYPES, cloneRichGraph, isDag, normalizeRichGraph } from './lib/graph.mjs';
import { obfuscateGraph } from './lib/obfuscate.mjs';
import { validateSample } from './lib/gates.mjs';
import { toSftRow } from './lib/sft.mjs';
import {
  addDecoyNodes, applyLocalEdit, inferDownstream, insertedNodesOf, pickForkPair, pickInjection,
} from './lib/localTeacher.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');
const OUT_CASES = join(DATA, 'ood_cases.jsonl');
const OUT_LABELS = join(DATA, 'ood_labels.json');
const OUT_SFT = join(ROOT, 'sft', 'ood.jsonl');

const SEED = 20260914;
const SCHEMA_STAR_MAX = 32;
const TRAIN_PROMPT_MIN = 11221;   // token_audit.json range over the 12000 training rows
const TRAIN_PROMPT_MAX = 13016;
const VARIANTS = 12;              // retries per cell before giving up on it

/**
 * Mirrors CAUSE_FIELDS in scripts/rdmd_trivial_baseline.py. A drift row is "derived-only" when the
 * culprit changed *only* through artifact/output/summary, i.e. no cause field differs.
 *
 * That subset matters more than any other: it is 47% of the v3 test drift rows (675/1427), it is
 * where the rule baseline scores 0.000 on `type`, and it is the only place the model can beat the
 * rule (0.9985 localisation). A probe with no derived-only rows measures the easy half of the task,
 * so this script plants them deliberately and asserts their count.
 */
const CAUSE_FIELDS = ['inputs', 'agentId', 'version', 'acceptance'];
// local_replan's form only touches artifact/output/summary, so it is derived-only even without the
// subtle restore; the other three have their cause field restored by `subtle`.
const DERIVED_ONLY_TYPES = ['wrong_agent', 'wrong_version', 'wrong_acceptance', 'local_replan'];

/**
 * Each status gets its own seed band AND its own id segment. Sharing a seed was a real bug: the
 * drift and no_drift candidate for the same cell then produced the SAME id, so the cases / labels /
 * sft files each ended up holding a different sample under one key, and the "drift" rows silently
 * turned into identical-tree rows. Ids are asserted unique at the end for exactly this reason.
 */
const STATUS_SALT = { drift: 0, drift_derived_only: 16384, no_drift: 4096, UNKNOWN: 8192 };

/** Unknown statuses must fail loudly: a missing key silently makes the seed NaN. */
function saltFor(status) {
  if (!(status in STATUS_SALT)) throw new Error(`no seed salt for status ${status}`);
  return STATUS_SALT[status];
}

// ---------------------------------------------------------------------------
// Golden-graph shapes the generator never produces
// ---------------------------------------------------------------------------

function uniqueEdges(edges) {
  const seen = new Set();
  return edges.filter((edge) => {
    if (!edge.from || !edge.to || edge.from === edge.to) return false;
    const key = `${edge.from}->${edge.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Spine + forward-only bridges, plus optional lateral links. */
function edgesFor(ids, kind, laterals) {
  const edges = [];
  const add = (from, to) => edges.push({ id: `${from}->${to}`, from, to });
  const spineLen = Math.max(9, Math.round(ids.length * 0.58));
  const spine = ids.slice(0, spineLen);
  const extras = ids.slice(spineLen);
  for (let i = 0; i + 1 < spine.length; i += 1) add(spine[i], spine[i + 1]);

  const span = kind === 'chain_side' ? 3 : 4;
  const mod = Math.max(1, spine.length - span);
  const fromIdx = (i) => (i * 5) % mod;
  const toIdx = (i) => Math.min(spine.length - 1, fromIdx(i) + span);

  if (kind === 'wide_fan') {
    // A mid-spine node fans out into parallel lanes that all rejoin further down the spine.
    const lanes = Math.max(2, Math.min(3, Math.floor(extras.length / 2) || 2));
    const cut = Math.max(1, Math.floor(spine.length * 0.25));
    const joinAt = Math.min(spine.length - 1, Math.floor(spine.length * 0.8));
    const per = Math.max(1, Math.ceil(extras.length / lanes));
    extras.forEach((id, i) => {
      const pos = i % per;
      if (pos === 0) add(spine[cut], id);
      else add(extras[i - 1], id);
      if (pos === per - 1 || i === extras.length - 1) add(id, spine[joinAt]);
    });
    return uniqueEdges(edges);
  }

  if (kind === 'nested_diamond') {
    // Long bypass arcs plus off-spine nodes hung between the same pairs, i.e. diamonds inside
    // diamonds -- several nodes end up with in-degree 2, which no training structure produces.
    const a = Math.max(1, Math.floor(spine.length * 0.2));
    const b = Math.max(a + 1, Math.floor(spine.length * 0.45));
    const c = Math.max(b + 1, Math.floor(spine.length * 0.7));
    add(spine[a], spine[b]);
    add(spine[b], spine[c]);
    if (c > a + 1) add(spine[a], spine[c]);
    extras.forEach((id, i) => {
      const [from, to] = i % 2 === 0 ? [spine[a], spine[b]] : [spine[b], spine[c]];
      add(from, id);
      add(id, to);
    });
    return uniqueEdges(edges);
  }

  // chain_side and layered_mesh share the bridge pattern; layered_mesh adds lateral links.
  extras.forEach((id, i) => {
    add(spine[fromIdx(i)], id);
    add(id, spine[toIdx(i)]);
    // A lateral link is only safe when this bridge lands at or before the next bridge starts.
    // Without this guard the two bridges overlap and the pair closes a cycle (observed as
    // star_not_dag on layered_mesh/32).
    if (laterals && i % 2 === 0 && i + 1 < extras.length && toIdx(i) <= fromIdx(i + 1)) {
      add(id, extras[i + 1]);
    }
  });
  return uniqueEdges(edges);
}

/** Build edges, falling back to the no-lateral form if the result is somehow cyclic. */
function buildEdges(nodes, ids, kind) {
  const graph = (laterals) => ({ nodes, edges: edgesFor(ids, kind, laterals) });
  if (kind === 'layered_mesh') {
    const withLaterals = graph(true);
    if (isDag(withLaterals)) return withLaterals.edges;
  }
  return graph(false).edges;
}

/** Source a real golden graph so vocabulary / field conventions stay in-distribution. */
function loadVocabularySource() {
  const path = join(DATA, 'all.jsonl');
  if (!existsSync(path)) throw new Error('data/all.jsonl missing - run generate.mjs first');
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const sample = JSON.parse(line);
    if (sample.label?.status === 'drift' && sample.G_star?.nodes?.length >= 20) return sample.G_star;
  }
  throw new Error('no usable golden graph found');
}

function stageName(offset, total) {
  const q = offset / Math.max(1, total - 1);
  if (q < 0.25) return '准备';
  if (q < 0.5) return '执行';
  if (q < 0.75) return '整合';
  return '交付';
}

/**
 * Assemble a golden graph with `n` nodes in the given shape, reusing the source's domain, topic and
 * titles. Titles repeat once the pool runs out; a round suffix keeps them distinct without
 * inventing vocabulary.
 */
function buildGolden(source, n, kind, index) {
  const titles = source.nodes.map((node) => node.title);
  const { domain, topic } = source;
  const ids = Array.from({ length: n }, (_, i) => `n${i + 1}`);
  const nodes = ids.map((id, offset) => {
    const round = Math.floor(offset / titles.length);
    const base = titles[offset % titles.length];
    const title = round === 0 ? base : `${base}（续${round}）`;
    const stage = stageName(offset, n);
    return {
      id,
      title,
      role: domain,
      agentId: `${domain}_agent_${offset + 1}`,
      version: 'v1',
      acceptance: 'standard',
      artifact: `${topic}-${title}`,
      stage,
      inputs: offset === 0 ? `${topic}任务说明` : `${titles[(offset - 1) % titles.length]}的产出`,
      output: `${title}产出（${topic}）`,
      summary: `在「${topic}」中完成「${title}」，所属域：${domain}，阶段：${stage}。`,
    };
  });
  const graph = normalizeRichGraph({
    graph_id: `rdmd_ood_${kind}_${n}_${index}`,
    domain,
    title: source.title,
    topic,
    nodes,
    edges: buildEdges(nodes, ids, kind),
  });
  // Same obfuscation as the training data: ids and rendered order must not leak topological order
  // (the gate rejects any graph whose id order or array order is topological).
  const obfuscated = obfuscateGraph(graph, SEED + index * 31 + n);
  obfuscated.graph_id = `rdmd_ood_${kind}_${n}_${index}`;
  return obfuscated;
}

// ---------------------------------------------------------------------------
// Sample assembly (same pipeline the training data went through)
// ---------------------------------------------------------------------------

function sampleShell(kind, n, golden, index, seed, status) {
  return {
    id: `${golden.graph_id}__${kind}__${status}__${seed}`,
    graph_id: golden.graph_id,
    split: 'ood',
    model: 'local-tutorial-writer',
    backend: 'local',
    seed,
    kind,
    scale: n,
    inContract: n <= SCHEMA_STAR_MAX,
  };
}

function driftCandidate(kind, n, golden, index, variant, status) {
  const seed = SEED + index * 977 + variant * 131 + saltFor(status);
  const picked = pickInjection(golden, seed, DRIFT_TYPES[(index + variant) % DRIFT_TYPES.length]);
  if (!picked) return { error: 'no_injection_candidate' };
  const applied = applyLocalEdit(golden, picked.type, picked.nodeId, seed + 7);
  if (!applied.gold) return { error: 'local_edit_failed' };
  const subtle = variant % 2 === 1;
  const prime = inferDownstream(golden, applied.graph, applied.gold, { seed: seed + 13, subtle });
  const decoyed = addDecoyNodes(golden, prime, applied.gold.nodeId, { seed: seed + 17 });
  return {
    sample: {
      ...sampleShell(kind, n, golden, index, seed, status),
      G_star: golden,
      G_prime: decoyed.graph,
      label: {
        status: 'drift',
        injected_node: applied.gold.nodeId,
        injected_type: applied.gold.type,
        injected_edge: applied.gold.edgeId || '',
        injected_form: applied.gold.formId || '',
        hop_to_first_effect: 0,
        decoy_nodes: decoyed.decoys,
        inserted_nodes: insertedNodesOf(applied.gold),
      },
      generator_id: 'rdmd_ood_single_inject_v1',
      visibility: subtle ? 'subtle' : 'visible',
    },
  };
}

function noDriftCandidate(kind, n, golden, index, variant, status) {
  const seed = SEED + index * 977 + variant * 131 + saltFor(status);
  return {
    sample: {
      ...sampleShell(kind, n, golden, index, seed, status),
      G_star: golden,
      G_prime: cloneRichGraph(golden),
      label: { status: 'no_drift', injected_node: '', injected_type: '', injected_edge: '' },
      generator_id: 'rdmd_ood_no_drift_v1',
      visibility: 'none',
    },
  };
}

/** Count of cause fields that differ on `nodeId`. 0 means the culprit is derived-only. */
function changedCauseFields(star, prime, nodeId) {
  const left = star.nodes.find((node) => node.id === nodeId);
  const right = prime.nodes.find((node) => node.id === nodeId);
  if (!left || !right) return CAUSE_FIELDS.length;
  return CAUSE_FIELDS.filter((field) => left[field] !== right[field]).length;
}

/**
 * A drift row whose culprit is visible ONLY through artifact/output/summary. Forced subtle, and the
 * type is restricted to the ones whose cause field `subtle` restores. The caller re-checks
 * `changedCauseFields === 0` before keeping the row, so this cannot silently become an easy row.
 */
function driftDerivedOnlyCandidate(kind, n, golden, index, variant, status) {
  const seed = SEED + index * 977 + variant * 131 + saltFor(status);
  const type = DERIVED_ONLY_TYPES[variant % DERIVED_ONLY_TYPES.length];
  const picked = pickInjection(golden, seed, type);
  if (!picked) return { error: 'no_injection_candidate' };
  const applied = applyLocalEdit(golden, picked.type, picked.nodeId, seed + 7);
  if (!applied.gold) return { error: 'local_edit_failed' };
  const prime = inferDownstream(golden, applied.graph, applied.gold, { seed: seed + 13, subtle: true });
  const decoyed = addDecoyNodes(golden, prime, applied.gold.nodeId, { seed: seed + 17 });
  return {
    sample: {
      ...sampleShell(kind, n, golden, index, seed, status),
      G_star: golden,
      G_prime: decoyed.graph,
      label: {
        status: 'drift',
        injected_node: applied.gold.nodeId,
        injected_type: applied.gold.type,
        injected_edge: applied.gold.edgeId || '',
        injected_form: applied.gold.formId || '',
        hop_to_first_effect: 0,
        decoy_nodes: decoyed.decoys,
        inserted_nodes: insertedNodesOf(applied.gold),
      },
      generator_id: 'rdmd_ood_derived_only_inject_v1',
      visibility: 'derived_only',
    },
  };
}

function unknownCandidate(kind, n, golden, index, variant, status) {
  const seed = SEED + index * 977 + variant * 131 + saltFor(status);
  const pair = pickForkPair(golden, seed + 3);
  if (!pair) return { error: 'no_fork_pair' };
  const typeA = DRIFT_TYPES[(index + variant) % DRIFT_TYPES.length];
  const typeB = DRIFT_TYPES[(index + variant + 2) % DRIFT_TYPES.length];
  const first = applyLocalEdit(golden, typeA, pair.a, seed + 11);
  if (!first.gold) return { error: 'first_edit_failed' };
  const mid = inferDownstream(golden, first.graph, first.gold, { seed: seed + 19 });
  const second = applyLocalEdit(mid, typeB, pair.b, seed + 23);
  if (!second.gold) return { error: 'second_edit_failed' };
  const prime = inferDownstream(golden, second.graph, second.gold, { seed: seed + 29 });
  const decoyed = addDecoyNodes(golden, prime, [pair.a, pair.b], { seed: seed + 31 });
  return {
    sample: {
      ...sampleShell(kind, n, golden, index, seed, status),
      G_star: golden,
      G_prime: decoyed.graph,
      label: {
        status: 'UNKNOWN', injected_node: '', injected_type: '', injected_edge: '',
        injected_form: '',         injected_nodes: [pair.a, pair.b],
        injected_types: [typeA, typeB],
        decoy_nodes: decoyed.decoys,
        // 两条注入都可能各自在链上插一环，所以这里要把两份合起来。
        inserted_nodes: [...insertedNodesOf(first.gold), ...insertedNodesOf(second.gold)],
      },
      generator_id: 'rdmd_ood_multi_inject_v1',
      visibility: 'visible',
    },
  };
}

/** In-contract rows must pass the gate cleanly; out-of-contract rows may fail only on node count. */
function gateAcceptable(errors, inContract) {
  if (inContract) return errors.length === 0;
  return errors.every((error) => error === 'star_node_count' || error === 'prime_node_count');
}

function accept(builder, kind, n, golden, index, inContract, status, requireOk = null) {
  const reasons = new Set();
  for (let variant = 0; variant < VARIANTS; variant += 1) {
    const built = builder(kind, n, golden, index, variant, status);
    if (built.error) {
      reasons.add(built.error);
      continue;
    }
    const errors = validateSample(built.sample);
    if (!gateAcceptable(errors, inContract)) {
      reasons.add(errors.join('|'));
      continue;
    }
    // A predicate lets a row kind assert a property the dataset gate does not check (e.g. "this
    // row must really be derived-only"). Rejecting here keeps the claim in the results table honest.
    const why = requireOk ? requireOk(built.sample) : null;
    if (why) {
      reasons.add(why);
      continue;
    }
    return { sample: built.sample, errors };
  }
  return { error: [...reasons].join(',') };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const source = loadVocabularySource();
  const cells = [
    { n: 16, kind: 'chain_side' }, { n: 16, kind: 'wide_fan' },
    { n: 16, kind: 'nested_diamond' }, { n: 16, kind: 'layered_mesh' },
    { n: 24, kind: 'chain_side' }, { n: 24, kind: 'wide_fan' },
    { n: 24, kind: 'nested_diamond' }, { n: 24, kind: 'layered_mesh' },
    { n: 32, kind: 'chain_side' }, { n: 32, kind: 'wide_fan' },
    { n: 32, kind: 'nested_diamond' }, { n: 32, kind: 'layered_mesh' },
    // Out-of-contract probes: the schema caps star at 32 nodes, so these are not legal task
    // instances. They locate the breaking point; they are not scored as capability.
    { n: 48, kind: 'layered_mesh' }, { n: 48, kind: 'nested_diamond' },
    { n: 80, kind: 'layered_mesh' }, { n: 80, kind: 'chain_side' },
  ];

  const rows = [];
  const skipped = [];
  cells.forEach((cell, cellIndex) => {
    const inContract = cell.n <= SCHEMA_STAR_MAX;
    const golden = buildGolden(source, cell.n, cell.kind, cellIndex);
    // Every cell gets a drift and a no_drift row, plus a derived-only drift row (the subset where
    // the rule baseline has no signal and the model can actually differentiate). One UNKNOWN per
    // scale tier keeps abstention covered without spending the whole matrix on it.
    const wanted = [
      ['drift', driftCandidate, null],
      ['no_drift', noDriftCandidate, null],
      ['drift_derived_only', driftDerivedOnlyCandidate,
        (sample) => (changedCauseFields(sample.G_star, sample.G_prime, sample.label.injected_node) === 0
          ? null : 'not_derived_only')],
    ];
    if (cellIndex % 4 === 0) wanted.push(['UNKNOWN', unknownCandidate, null]);

    for (const [status, builder, requireOk] of wanted) {
      const built = accept(builder, cell.kind, cell.n, golden, cellIndex, inContract, status, requireOk);
      if (built.error) {
        skipped.push(`${cell.kind}/${cell.n}/${status}: ${built.error}`);
        continue;
      }
      const sample = built.sample;
      const { row, errors: sftErrors } = toSftRow(sample, { supervised: true });
      if (!row || sftErrors.length) {
        skipped.push(`${cell.kind}/${cell.n}/${status}: sft ${sftErrors.join(',')}`);
        continue;
      }
      const derivedOnly = sample.label.status === 'drift'
        && changedCauseFields(sample.G_star, sample.G_prime, sample.label.injected_node) === 0;
      rows.push({
        id: sample.id,
        graph_id: sample.graph_id,
        kind: sample.kind,
        scale: sample.scale,
        status: status === 'drift_derived_only' ? 'drift' : status,
        inContract: sample.inContract,
        generator_id: sample.generator_id,
        visibility: sample.visibility,
        derivedOnly,
        G_star: sample.G_star,
        G_prime: sample.G_prime,
        label: sample.label,
        validateErrors: built.errors,
        promptChars: row.prompt.length,
        beyondTrainedLength: row.prompt.length > TRAIN_PROMPT_MAX,
        sft: row,
      });
    }
  });

  // A collision here means two different samples share a key, which silently mixes their graphs,
  // labels and prompts across the three output files. Assert rather than discover it downstream.
  const ids = rows.map((row) => row.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);

  mkdirSync(DATA, { recursive: true });
  mkdirSync(join(ROOT, 'sft'), { recursive: true });
  writeFileSync(OUT_CASES, rows
    .map((row) => JSON.stringify({ id: row.id, G_star: row.G_star, G_prime: row.G_prime }))
    .join('\n') + '\n');
  writeFileSync(OUT_LABELS, `${JSON.stringify(rows.map((row) => ({
    id: row.id, kind: row.kind, scale: row.scale, status: row.label.status,
    derivedOnly: row.derivedOnly, visibility: row.visibility,
    injected_node: row.label.injected_node || '', injected_type: row.label.injected_type || '',
    injected_nodes: row.label.injected_nodes || [],
    inContract: row.inContract, validateErrors: row.validateErrors,
    promptChars: row.promptChars, beyondTrainedLength: row.beyondTrainedLength,
  })), null, 2)}\n`);
  writeFileSync(OUT_SFT, rows.map((row) => JSON.stringify(row.sft)).join('\n') + '\n');

  const byScale = {};
  for (const row of rows) {
    const entry = byScale[row.scale] || { n: 0, drift: 0, no_drift: 0, UNKNOWN: 0, beyondTrainedLength: 0 };
    entry.n += 1;
    entry[row.label.status] += 1;
    if (row.beyondTrainedLength) entry.beyondTrainedLength += 1;
    byScale[row.scale] = entry;
  }
  const chars = rows.map((row) => row.promptChars).sort((a, b) => a - b);
  const malformed = rows.filter((row) => row.inContract && row.validateErrors.length);
  const identicalTrees = rows.filter((row) => row.label.status === 'drift'
    && JSON.stringify(row.G_star) === JSON.stringify(row.G_prime));
  const derivedOnlyRows = rows.filter((row) => row.derivedOnly).length;
  console.log(JSON.stringify({
    rows: rows.length,
    byScale,
    promptChars: {
      min: chars[0], max: chars[chars.length - 1],
      trainedRange: [TRAIN_PROMPT_MIN, TRAIN_PROMPT_MAX],
      rowsBeyondTrainedRange: rows.filter((row) => row.beyondTrainedLength).length,
    },
    inContractRows: rows.filter((row) => row.inContract).length,
    inContractGateFailures: malformed.length,
    duplicateIds: duplicates.length,
    // A drift row whose two trees are byte-identical is a mislabelled row, not a hard row.
    driftRowsWithIdenticalTrees: identicalTrees.length,
    // The subset v3 test is 47% made of and where the rule baseline has no signal.
    derivedOnlyDriftRows: derivedOnlyRows,
    skipped,
  }, null, 2));
  if (malformed.length || duplicates.length || identicalTrees.length || !derivedOnlyRows) {
    console.error('OOD probe is malformed - refusing to present it as evidence');
    process.exitCode = 1;
  }
}

main();
