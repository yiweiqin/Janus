/**
 * analyze_recon.mjs 的纪律测试。
 *
 * 这个分析器的全部价值在于**不让人自欺**，所以它的纪律必须被机器检查，而不是靠我记住：
 *
 *   纪律 1  给分布不给均值        -> 双峰夹具上 mean 必须明显偏离 p50，直方图必须多个峰
 *   纪律 2  baseline 与 top 分开   -> 两层必须各自有 profile，并给出 delta
 *   纪律 3  空分母不许印 0         -> 递归断言：凡是 total===0 的比率，value 必须是 null
 *
 * 第 3 条是这里最重要的不变量：把「没测到」印成「0%」会把人引向「数据质量差」这个错误结论，
 * 而真相往往是「这一层根本没落库」。这条只能靠机器守。
 *
 * 顺带覆盖两个真实踩过的坑：manifest 带 BOM、以及 root 节点不该被算成「缺父节点」。
 *
 * 运行：node --test experiments/rdmd_detective_dataset/ubuddy_recon/ubuddy_recon.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANALYZER = path.join(HERE, 'analyze_recon.mjs');

function writeFixture(dir, { source, graphsFull = [], graphsThin = [] }) {
  fs.mkdirSync(dir, { recursive: true });
  const graphs = [];
  const nodes = [];
  const edges = [];
  const events = [];

  const add = (id, size, filledText) => {
    graphs.push({
      graph_id: id, graph_version: 'v1', root_task_run_id: `tr_${id}`, root_delegation_id: '',
      root_group_id: '', root_node_id: 'root', owner_user_id: 'u1', title: `G ${id}`,
      current_revision: 1, lifecycle_status: 'active', created_at: '', updated_at: '',
      _stratum: size > 5 ? 'top' : 'baseline',
    });
    nodes.push({
      graph_id: id, node_id: 'root', parent_node_id: '', kind: 'root', task_run_id: `tr_${id}`,
      delegation_id: '', task_node_id: '', owner_user_id: 'u1', owner_agent_id: '', owner_agent_instance_id: '',
      title: 'root', public_summary: filledText ? 'root summary' : '', status: 'running', progress: 35,
      depth: 0, visibility: 'participants', public_metadata: {}, source_revision: 1,
      created_at: '', updated_at: '', _stratum: size > 5 ? 'top' : 'baseline',
    });
    for (let index = 1; index < size; index += 1) {
      nodes.push({
        graph_id: id, node_id: `n${index}`, parent_node_id: 'root', kind: 'agent_task',
        task_run_id: `tr_${id}`, delegation_id: '', task_node_id: `tn_${id}_${index}`,
        owner_user_id: 'u1', owner_agent_id: `agent_${index}`, owner_agent_instance_id: `inst_${id}_${index}`,
        title: `step ${index}`, public_summary: filledText ? `summary ${index}` : '',
        status: 'completed', progress: 100, depth: 2, visibility: 'participants',
        public_metadata: {}, source_revision: 1, created_at: '', updated_at: '',
        _stratum: size > 5 ? 'top' : 'baseline',
      });
      edges.push({
        graph_id: id, edge_id: `e_${id}_${index}`, kind: 'parent_of', from_node_id: 'root',
        to_node_id: `n${index}`, public_metadata: {}, source_revision: 1,
        created_at: '', updated_at: '', _stratum: size > 5 ? 'top' : 'baseline',
      });
    }
    // 大图带事件流（before/after 可得），小图刻意不带 —— 制造双峰，逼分析器给分布。
    if (size > 5) {
      for (let revision = 1; revision <= 6; revision += 1) {
        events.push({
          graph_id: id, graph_revision: revision, event_id: `ev_${id}_${revision}`,
          event_type: revision % 3 === 0 ? 'execution_failed' : 'progress_published',
          node_id: 'n1', public_patch: { status: 'running' }, actor_user_id: 'u1',
          actor_agent_instance_id: 'inst', created_at: '', _stratum: 'top',
        });
      }
    }
  };

  for (const [index, size] of graphsFull.entries()) add(`gfull_${index}`, size, true);
  for (const [index, size] of graphsThin.entries()) add(`gthin_${index}`, size, false);

  const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  fs.writeFileSync(path.join(dir, 'collaboration_graphs.jsonl'), jsonl(graphs), 'utf8');
  fs.writeFileSync(path.join(dir, 'collaboration_graph_nodes.jsonl'), jsonl(nodes), 'utf8');
  fs.writeFileSync(path.join(dir, 'collaboration_graph_edges.jsonl'), jsonl(edges), 'utf8');
  fs.writeFileSync(path.join(dir, 'collaboration_graph_events.jsonl'), jsonl(events), 'utf8');
  fs.writeFileSync(path.join(dir, 'cloud_task_nodes.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(dir, 'task_node_result_versions.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    source, exportedAt: '2026-01-01T00:00:00.000Z',
    sampling: { baselineRequested: graphsThin.length, topRequested: graphsFull.length },
    volume: { collaboration_graphs: graphs.length }, rowCounts: {}, skipped: [],
  }, null, 2), 'utf8');
  return dir;
}

function runAnalyzer(dir) {
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [ANALYZER, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    status = error.status ?? 1;
    stdout = String(error.stdout || '');
  }
  return { status, stdout, summary: JSON.parse(fs.readFileSync(path.join(dir, 'recon_summary.json'), 'utf8')) };
}

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ubuddy-recon-${name}-`));
}

/** 递归找出所有 {value,hits,total} 比率对象，用来断言纪律 3。 */
function collectRatios(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectRatios(item, found);
    return found;
  }
  if (value && typeof value === 'object') {
    if ('value' in value && 'total' in value && 'hits' in value) found.push(value);
    for (const item of Object.values(value)) collectRatios(item, found);
  }
  return found;
}

test('纪律 3：分母为 0 的比率必须是 null，绝不能印成 0', () => {
  const dir = writeFixture(tempDir('empty'), { source: 'real_postgres' });
  const { summary } = runAnalyzer(dir);

  assert.equal(summary.emptyGraphExport, true, '空导出必须被标记');
  const ratios = collectRatios(summary.measurements);
  assert.ok(ratios.length > 5, '应该有多个比率对象');
  for (const ratio of ratios) {
    if (ratio.total === 0) {
      assert.equal(ratio.value, null, `分母为 0 却给出了 value=${ratio.value}；这会被误读成「数据质量差」`);
      assert.equal(ratio.note, 'no data');
    }
  }
  // 空盘上每一项判定都必须 FAIL —— 从零数据里得不出任何通过结论。
  assert.ok(summary.decisionMatrix.every((item) => item.pass === false));
});

test('纪律 1：双峰数据给出分布，均值不得冒充结论', () => {
  const dir = writeFixture(tempDir('bimodal'), {
    source: 'real_postgres',
    graphsFull: [18, 18],       // 天花板：大图 + 富文本 + 事件流
    graphsThin: [2, 2, 2],      // 基线：小图、无摘要、无事件
  });
  const { summary } = runAnalyzer(dir);
  const scale = summary.measurements['1_scale'];

  // 节点数：18,18,2,2,2 -> mean 8.4, p50 2。均值会把这个形状说成「差不多 8 步」。
  assert.equal(scale.all.n, 5);
  assert.equal(scale.all.p50, 2);
  assert.ok(scale.all.mean > scale.all.p50 + 4, `mean(${scale.all.mean}) 应远大于 p50(${scale.all.p50})`);
  assert.ok(scale.all.meanMinusMedian > 4, 'meanMinusMedian 应显式暴露偏斜');

  const nonEmptyBands = scale.histogram.filter((band) => band.count > 0);
  assert.ok(nonEmptyBands.length >= 2, '双峰数据必须落在多个直方图区间，否则形状被抹平了');
});

test('纪律 2：baseline 与 top 分开，且富文本两个口径不能混为一谈', () => {
  const dir = writeFixture(tempDir('strata'), {
    source: 'real_postgres',
    graphsFull: [18, 18],
    graphsThin: [2, 2, 2],
  });
  const { summary } = runAnalyzer(dir);
  const gap = summary.measurements['8_stratum_gap'];
  const rich = summary.measurements['2_rich_text'].collaboration_graph_nodes;

  assert.equal(gap.baseline.graphs, 3);
  assert.equal(gap.top.graphs, 2);
  assert.ok(gap.delta.publicSummaryPerGraphAllFilled > 0, 'top 的逐图全填率应高于 baseline');

  // 关键陷阱：逐节点率高（大图节点多且填满）但逐图全填率低（小图全空）。
  // 只报逐节点会得出「填充率不错」的假象，而契约是按图全填才可用。
  assert.ok(rich.public_summary_per_node.value > rich.public_summary_per_graph_all_filled.value,
    `逐节点(${rich.public_summary_per_node.value}) 应高于逐图全填(${rich.public_summary_per_graph_all_filled.value})`);
  assert.ok(rich.public_summary_per_graph_none_filled.value > 0);
});

test('DAG 判据排除 root：root 天然无父节点，不该算成缺口', () => {
  const dir = writeFixture(tempDir('dag'), { source: 'real_postgres', graphsFull: [18], graphsThin: [2] });
  const { summary } = runAnalyzer(dir);
  const shape = summary.measurements['5_graph_shape'];

  assert.equal(shape.root_nodes, 2, '两个图各有一个 root');
  // 旧的判据把 root 算进分母，会凭空造出 84% 的假缺口。
  assert.ok(shape.parent_node_id_filled.value < 1, '整体填充率确实不到 1（因为 root 没父节点）');
  assert.equal(shape.non_root_nodes_with_parent.value, 1, '非 root 节点必须 100% 有父节点');
  assert.equal(shape.dangling_parent_references.count, 0);
  assert.equal(shape.graphs_with_cycle.value, 0);
});

test('证据分级：来源不是 real_postgres 就拒绝当证据（退出码非 0）', () => {
  const synthetic = writeFixture(tempDir('synthetic'), { source: 'synthetic_fixture', graphsFull: [18] });
  const syntheticRun = runAnalyzer(synthetic);
  assert.equal(syntheticRun.summary.evidenceGrade, 'synthetic_do_not_cite');
  assert.equal(syntheticRun.status, 1, '合成数据被引用是这类侦察最贵的错误，必须非 0 退出');

  const real = writeFixture(tempDir('real'), { source: 'real_postgres', graphsFull: [18] });
  const realRun = runAnalyzer(real);
  assert.equal(realRun.summary.evidenceGrade, 'evidence');
  assert.equal(realRun.status, 0);
});

test(' robustness：manifest 带 BOM 也能解析，且不误报为崩溃', () => {
  const dir = writeFixture(tempDir('bom'), { source: 'real_postgres', graphsFull: [18] });
  const manifest = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'manifest.json'), `\uFEFF${manifest}`, 'utf8');
  const { summary, status } = runAnalyzer(dir);
  assert.equal(status, 0, 'BOM 不该让分析器崩溃');
  assert.equal(summary.source, 'real_postgres');
});
