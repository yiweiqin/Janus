/**
 * Adversarial probe: what the model does on inputs the training distribution provably never held.
 *
 * WHY THIS EXISTS
 * ---------------
 * The model's headline behaviour is that it ABSTAINS instead of guessing (the v3 fix took UNKNOWN
 * recall from 0.000 to 1.000). The failure that matters in production is the opposite of abstaining:
 * confidently naming an INNOCENT node. These rows attack that, and their correct answers are fixed by
 * the CONTRACT rather than by anyone's taste:
 *
 *   DETECTIVE_INSTRUCTION: "存在多个不相交原因或证据不足时 status=UNKNOWN，不要编造唯一凶手。"
 *
 * Two or more disjoint causes -> UNKNOWN. That is a definition, so no annotation step is involved and
 * no annotator's bias can leak into the labels.
 *
 * WHY NOT JUST ASK A BIGGER MODEL TO LABEL REAL DATA
 * --------------------------------------------------
 * It would be circular. An annotator -- human or model -- sees the same two trees, and the only
 * reading available is "earliest changed node whose change cascades", i.e. rule E. Agreement with
 * such labels measures agreement with rule E, not correctness. A label is worth having only if it is
 * independent evidence (a recorded incident cause), and this repo holds none for this tree-pair
 * contract. So the probe manufactures cases whose answer is decidable by construction instead.
 *
 * WHAT IS ACTUALLY OUT-OF-DISTRIBUTION (re-derived from the corpus at run time, not asserted)
 * ------------------------------------------------------------------------------------------
 * `measureTrainingSupport()` reads data/all.jsonl and refuses to run if the assumptions break. It
 * shows the generator's 1000 UNKNOWN rows are always exactly TWO causes and always
 * `visibility: visible` -- i.e. both causes were planted with `subtle: false`, so each one shows up
 * in a cause field (inputs / agentId / version / acceptance).
 *
 *   two_derived_cause  2 independent causes, the second visible ONLY through artifact/output/summary.
 *                      Outside the support because every UNKNOWN row in training was `visible`. It is
 *                      gate-legal (the corpus's own gate accepts it) but was never generated, the
 *                      same sense in which the scale/shape probe was out-of-distribution. This is the
 *                      case that tempts a model into naming the single cause it CAN see, so the
 *                      contract answer is UNKNOWN: two disjoint causes, don't fabricate a culprit.
 *   single_control     1 cause + decoys, must pass the gate clean. Catches a model that simply
 *                      always abstains, which would otherwise look perfect on the rows above.
 *
 * TWO STRUCTURAL LIMITS FOUND WHILE BUILDING THIS (recorded because they bound what is testable)
 * -----------------------------------------------------------------------------------------------
 *   1. A 3-cause family is impossible. These graphs are a spine with short side tracks, so the
 *      largest set of pairwise-unrelated nodes is 2 (brute-forced). That is also why the generator's
 *      UNKNOWN rows are always exactly 2 -- a property of the graph family, not a design choice.
 *   2. An "inert noise" family (an unrelated change that does NOT cascade) is impossible: every node
 *      outside the cause's causal neighbourhood is a side track that rejoins the spine, and the
 *      spine below the cause is changed, so every such node has a changed descendant.
 *      The related "innocent that drags its own cascade" family was built and then DROPPED: to make
 *      it a distinct row the innocent has to be declared in `injected_nodes`, at which point the
 *      gate accepts it and it is just an ordinary two-cause row with a hand-edited summary. It would
 *      have carried no out-of-distribution claim, so shipping it as evidence would have been
 *      overstatement. The negative result is more useful than the row.
 *
 * NOTE ON A LATENT GENERATOR BUG: `addDecoyNodes` sometimes emits repair nodes absent from its
 * returned `decoys` list (seen as `extra_node_unexplained:repair_*`). The gate catches it, so
 * training data is unaffected, and cells that hit it are skipped rather than shipped with a wrong
 * label. Such skips show up under `skipped` in the output.
 *
 * Usage: node experiments/rdmd_detective_dataset/make_adversarial.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DRIFT_TYPES, descendantsOf, maxHopFrom, siblingInjectablePairs,
} from './lib/graph.mjs';
import { validateSample } from './lib/gates.mjs';
import { toSftRow } from './lib/sft.mjs';
import {
  addDecoyNodes, applyLocalEdit, generateGoldenGraph, inferDownstream, insertedNodesOf, pickInjection,
} from './lib/localTeacher.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');
const TRAINING = join(DATA, 'all.jsonl');
const OUT_CASES = join(DATA, 'adv_cases.jsonl');
const OUT_LABELS = join(DATA, 'adv_labels.json');
const OUT_SFT = join(ROOT, 'sft', 'adversarial.jsonl');

const SEED = 20260915;
const CAUSE_FIELDS = ['inputs', 'agentId', 'version', 'acceptance'];
// local_replan's form only touches artifact/output/summary; the other three have their cause field
// restored by `subtle`. Restricting to these makes the derived-only claim reachable, and the
// predicate below still re-checks the finished row rather than trusting the type name.
const DERIVED_ONLY_TYPES = ['wrong_agent', 'wrong_version', 'wrong_acceptance', 'local_replan'];
const SALT = { two_derived_cause: 8192, single_control: 16384 };

function saltFor(kind) {
  if (!(kind in SALT)) throw new Error(`no seed salt for ${kind}`);
  return SALT[kind];
}

// ---------------------------------------------------------------------------
// What the training distribution actually contained
// ---------------------------------------------------------------------------

/**
 * The out-of-distribution claim is only worth anything if it comes from the data. This measures the
 * axes the probe varies, so a regenerated corpus that (say) starts emitting derived-only UNKNOWN
 * rows invalidates the probe loudly instead of silently turning it into an in-distribution test.
 */
function measureTrainingSupport() {
  const rows = readFileSync(TRAINING, 'utf8')
    .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const unknown = rows.filter((row) => row.label?.status === 'UNKNOWN');
  const causeCounts = new Map();
  const visibilities = new Set();
  for (const row of unknown) {
    const count = (row.label.injected_nodes || []).length;
    causeCounts.set(count, (causeCounts.get(count) || 0) + 1);
    visibilities.add(row.visibility || '(none)');
  }
  return {
    rows: rows.length,
    unknownRows: unknown.length,
    maxCauses: Math.max(...causeCounts.keys()),
    causeCounts: Object.fromEntries([...causeCounts].sort((a, b) => a[0] - b[0])),
    unknownVisibilities: [...visibilities].sort(),
  };
}

// ---------------------------------------------------------------------------
// Independent injectable nodes
// ---------------------------------------------------------------------------

/** Neither node is an ancestor of the other, so neither can be the other's consequence. */
function related(graph, a, b) {
  return a === b
    || descendantsOf(graph, a).includes(b)
    || descendantsOf(graph, b).includes(a);
}

/** Nodes that appear in a pair the generator itself would consider injectable. */
function injectablePool(graph) {
  return [...new Set(siblingInjectablePairs(graph)
    .filter(([a, b]) => maxHopFrom(graph, a) >= 3 && maxHopFrom(graph, b) >= 3)
    .flat())];
}

/** Greedily take `wanted` pairwise-unrelated nodes (deterministic for a given seed). */
function pickIndependent(graph, wanted, seed) {
  const order = injectablePool(graph);
  let state = seed >>> 0;
  for (let i = order.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) >>> 0;
    const j = state % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const chosen = [];
  for (const id of order) {
    if (chosen.every((other) => !related(graph, other, id))) chosen.push(id);
    if (chosen.length === wanted) return chosen;
  }
  return null;
}

/** Apply one cause at `nodeId`, trying the allowed types until one applies. */
function injectAt(graph, nodeId, seed, { subtle, allowed }) {
  const picks = [];
  for (const type of allowed) {
    const applied = applyLocalEdit(graph, type, nodeId, seed);
    if (!applied.gold) continue;
    const prime = inferDownstream(graph, applied.graph, applied.gold, { seed: seed + 13, subtle });
    // `inserted` 必须跟着 pick 一起带出去：调用方是按 picks[i] 选的，只有选中的那一支
    // 的插入节点才真的在图里。少带这一项，gates 的 extra_node_unexplained 会把样本判死。
    picks.push({ prime, type: applied.gold.type, inserted: insertedNodesOf(applied.gold) });
  }
  return picks;
}

/** Cause fields still identical on `nodeId`? That is what "derived-only" means. */
function changedCauseFields(star, prime, nodeId) {
  const left = star.nodes.find((node) => node.id === nodeId);
  const right = prime.nodes.find((node) => node.id === nodeId);
  if (!left || !right) return CAUSE_FIELDS.length;
  return CAUSE_FIELDS.filter((field) => left[field] !== right[field]).length;
}

function shell(graph, kind, seed, extra) {
  return {
    id: `${graph.graph_id}__${kind}__${seed}`,
    graph_id: graph.graph_id,
    split: 'adversarial',
    model: 'local-tutorial-writer',
    backend: 'local',
    seed,
    kind,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

/**
 * Two independent causes, the last one visible only through derived fields. Contract: UNKNOWN.
 * The derived cause is what makes it hard -- only one cause is visible in a cause field, so the
 * "single visible cause" reading is available and wrong.
 */
function twoDerivedCause(graph, index, variant) {
  const seed = SEED + index * 977 + variant * 131 + saltFor('two_derived_cause');
  const nodes = pickIndependent(graph, 2, seed);
  if (!nodes) return { error: 'no_independent_pair' };
  let prime = graph;
  const types = [];
  const inserted = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const subtle = i === nodes.length - 1;
    const allowed = subtle ? DERIVED_ONLY_TYPES : DRIFT_TYPES;
    const picks = injectAt(prime, nodes[i], seed + 11 + i * 37, { subtle, allowed });
    if (!picks.length) return { error: `no_applicable_type_at_${i}` };
    const chosen = picks[(variant + i) % picks.length];
    prime = chosen.prime;
    types.push(chosen.type);
    inserted.push(...chosen.inserted);
  }
  return {
    sample: shell(graph, 'two_derived_cause', seed, {
      G_star: graph,
      G_prime: prime,
      label: {
        status: 'UNKNOWN',
        injected_node: '',
        injected_type: '',
        injected_edge: '',
        injected_form: '',
        injected_nodes: nodes,
        injected_types: types,
        decoy_nodes: [],
        inserted_nodes: inserted,
      },
      generator_id: 'rdmd_adv_two_derived_cause_v1',
      visibility: 'derived_only+multi',
    }),
  };
}

/** One cause and nothing else touched. Must PASS the gate: the control against blanket abstention. */
function singleControl(graph, index, variant) {
  const seed = SEED + index * 977 + variant * 131 + saltFor('single_control');
  const picked = pickInjection(graph, seed, DRIFT_TYPES[(index + variant) % DRIFT_TYPES.length]);
  if (!picked) return { error: 'no_injectable_node' };
  const picks = injectAt(graph, picked.nodeId, seed + 11, { subtle: false, allowed: DRIFT_TYPES });
  if (!picks.length) return { error: 'no_applicable_type' };
  const { prime, type, inserted } = picks[variant % picks.length];
  const decoyed = addDecoyNodes(graph, prime, picked.nodeId, { seed: seed + 31 });
  return {
    sample: shell(graph, 'single_control', seed, {
      G_star: graph,
      G_prime: decoyed.graph,
      label: {
        status: 'drift',
        injected_node: picked.nodeId,
        injected_type: type,
        injected_edge: '',
        injected_form: '',
        hop_to_first_effect: 0,
        decoy_nodes: decoyed.decoys,
        inserted_nodes: inserted,
      },
      generator_id: 'rdmd_adv_single_control_v1',
      visibility: 'visible',
    }),
  };
}

const FAMILIES = [
  {
    family: 'two_derived_cause',
    build: twoDerivedCause,
    expect: () => null, // gate-legal; out-of-distribution by the measured corpus support
  },
  {
    family: 'single_control',
    expect: (errors) => (errors.length === 0 ? null : `control must be gate-clean (${errors.join(',')})`),
    build: singleControl,
  },
];

const WANTED_PER_FAMILY = 30;
const MAX_GRAPH_INDEX = 9000;

function main() {
  const support = measureTrainingSupport();
  if (support.maxCauses !== 2 || support.unknownVisibilities.join() !== 'visible') {
    throw new Error(`training support changed: ${JSON.stringify(support)} - probe assumptions invalid`);
  }

  const rows = [];
  const made = Object.fromEntries(FAMILIES.map(({ family }) => [family, 0]));
  const skipReasons = new Map();
  const note = (reason) => skipReasons.set(reason, (skipReasons.get(reason) || 0) + 1);
  let branchlessGraphs = 0;

  for (let gi = 0; gi < MAX_GRAPH_INDEX; gi += 1) {
    if (FAMILIES.every(({ family }) => made[family] >= WANTED_PER_FAMILY)) break;
    const base = generateGoldenGraph(gi, SEED);
    // The generator only varies its structure every DOMAINS x TOPICS graphs, so long runs of indices
    // produce a bare spine with no side tracks. Those can never host a multi-cause row; counting
    // them separately stops them from looking like a builder failure.
    if (injectablePool(base).length < 2) branchlessGraphs += 1;

    for (const { family, build, expect } of FAMILIES) {
      if (made[family] >= WANTED_PER_FAMILY) continue;
      const graph = { ...base, graph_id: `rdmd_adv_${family}_${gi}` };
      let built = null;
      let lastError = '';
      for (let variant = 0; variant < 6 && !built; variant += 1) {
        const candidate = build(graph, gi, variant);
        if (candidate.error) lastError = candidate.error;
        else built = candidate;
      }
      if (!built) {
        note(`${family}: ${lastError}`);
        continue;
      }
      const sample = built.sample;
      const errors = validateSample(sample);
      const violation = expect(errors, built);
      if (violation) {
        note(`${family}: ${violation}`);
        continue;
      }
      // The derived-only claim is re-checked on the finished row: a type name is not evidence.
      if (family === 'two_derived_cause') {
        const last = sample.label.injected_nodes[sample.label.injected_nodes.length - 1];
        if (changedCauseFields(sample.G_star, sample.G_prime, last) !== 0) {
          note(`${family}: last cause is not derived-only`);
          continue;
        }
      }
      const { row, errors: sftErrors } = toSftRow(sample, { supervised: true });
      if (!row || sftErrors.length) {
        note(`${family}: sft ${sftErrors.join(',')}`);
        continue;
      }
      made[family] += 1;
      rows.push({
        id: sample.id,
        graph_id: sample.graph_id,
        kind: sample.kind,
        scale: sample.G_star.nodes.length,
        status: sample.label.status,
        cases: (sample.label.injected_nodes || []).length || 1,
        injected_node: sample.label.injected_node || '',
        injected_type: sample.label.injected_type || '',
        injected_nodes: sample.label.injected_nodes || [],
        gateRejections: errors,
        G_star: sample.G_star,
        G_prime: sample.G_prime,
        sft: row,
      });
    }
  }

  const ids = rows.map((row) => row.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  const byKind = {};
  for (const row of rows) {
    byKind[row.kind] = byKind[row.kind] || { n: 0, cases: row.cases, status: row.status };
    byKind[row.kind].n += 1;
  }

  mkdirSync(DATA, { recursive: true });
  mkdirSync(join(ROOT, 'sft'), { recursive: true });
  writeFileSync(OUT_CASES, rows
    .map((row) => JSON.stringify({ id: row.id, G_star: row.G_star, G_prime: row.G_prime }))
    .join('\n') + '\n');
  writeFileSync(OUT_LABELS, `${JSON.stringify(rows.map((row) => ({
    id: row.id, kind: row.kind, scale: row.scale, status: row.status, cases: row.cases,
    injected_node: row.injected_node, injected_type: row.injected_type,
    injected_nodes: row.injected_nodes, gateRejections: row.gateRejections,
  })), null, 2)}\n`);
  writeFileSync(OUT_SFT, rows.map((row) => JSON.stringify(row.sft)).join('\n') + '\n');

  console.log(JSON.stringify({
    rows: rows.length,
    byKind,
    trainingSupport: support,
    // The OOD argument restated as machine checks rather than prose.
    outOfDistributionClaim: {
      derivedCauseNeverCoOccurredWithMultiCause: !support.unknownVisibilities.includes('derived_only'),
      maxIndependentNodesIsTwo: support.maxCauses === 2,
    },
    duplicateIds: duplicates.length,
    branchlessGraphsScanned: branchlessGraphs,
    skipped: Object.fromEntries(skipReasons),
  }, null, 2));
  if (duplicates.length || rows.length === 0) {
    console.error('adversarial probe is malformed - refusing to present it as evidence');
    process.exitCode = 1;
  }
}

main();
