/**
 * `submitAll` 的**非干跑**路径测试。
 *
 * 为什么专门开一份：那条路以前只有真 Postgres 才走得到，于是本地全绿、盒子上第一次
 * 提交才炸 —— 实测炸过两次，一次是 `ON CONFLICT (graph_id,event_id)` 在真实 DDL 上
 * 不存在（那条现在由 `store.test.mjs` 的 DDL 对照守着），一次是纯 JS 的
 * `ReferenceError: skippedStore is not defined`（一个参数名写错，测试连碰都没碰到）。
 *
 * 所以这里用假 pool + 假 HTTP 把整条路走一遍：
 *   users upsert → provision → healthz → 每批 writeGraph → POST /api/rdmd/jobs
 *   → 写 jobs.jsonl → 读回图与 case_json 做越界审计 → 出报告
 *
 * 假 pool 只回**这些代码真的读过**的东西，并记录收到的 SQL；假 HTTP 回 201 与
 * 一个能读回来的 job 行。这样断言的是"代码把什么发出去"，而不是"代码能跑完"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRdmdCloudPayload } from '../../cloud/src/modules/rdmd/privacy.mjs';
import { buildBriefs } from './lib/protocol.mjs';
import { generate } from './simulate.mjs';
import { SIM_OWNER_USER_ID, submitAll } from './submit.mjs';

const BRIEF = buildBriefs({ orgIds: ['org_01_consumer'], personLimitPerOrg: 2 })[0];

/**
 * 造真 case：走 `generate`（不是 `assembleCase`），并且**整份都用**。
 *
 * 两个都踩过：
 *  - 直接用 `assembleCase` 的 sample 会缺 `brief_id`（那个键是 `generate` 落盘时补的），
 *    于是 `planBatches` 报 `brief_not_found:undefined`；
 *  - case 上**没有** `kind` 字段，kind 住在 `label.injected_type` / `label.status` 里，
 *    所以"按 kind 挑几条"这种写法会挑到空数组。整份用最贴近真实管线。
 */
async function allCases() {
  const result = await generate({ briefs: [BRIEF], mode: 'offline' });
  assert.ok(result.cases.length > 0, '生成器一条 case 都没出');
  // 这些是管线自己写进 generated.jsonl 的行，别让测试手搓形状。
  for (const row of result.cases) {
    assert.ok(row.brief_id && row.id && row.G_star && row.G_prime, `case 形状不完整：${JSON.stringify(Object.keys(row))}`);
  }
  return result.cases;
}

/**
 * 假 pool：按 SQL 前缀分流。
 * 关键的一条是 `case_json` 读回 —— 它必须回**我们真正提交的那份载荷**，
 * 否则"读回审计"这条断言就是自证。
 */
function fakePool({ jobRowsByCaseId }) {
  const seen = [];
  return {
    seen,
    async query(sql, params = []) {
      const text = String(sql).trim();
      seen.push({ text, params });
      if (/^INSERT INTO users/i.test(text)) return { rows: [] };
      // 表名是 `collaboration_graphs`（**没有**下划线）与 `collaboration_graph_*`，
      // 所以这里只能匹配到 `collaboration_graph` 为止 —— 写 `collaboration_graph_`
      // 会漏掉 graphs 那张表（实测漏过，fakePool 直接报"没准备这条 SQL"）。
      if (/^DELETE FROM collaboration_graph/i.test(text)) return { rows: [] };
      if (/^INSERT INTO collaboration_graph_graphs|^INSERT INTO collaboration_graphs/i.test(text)) return { rows: [] };
      if (/^INSERT INTO collaboration_graph_nodes/i.test(text)) return { rows: [] };
      if (/^INSERT INTO collaboration_graph_edges/i.test(text)) return { rows: [] };
      if (/^INSERT INTO collaboration_graph_events/i.test(text)) return { rows: [] };
      if (/^SELECT id,current_revision,lifecycle_status FROM collaboration_graphs/i.test(text)) {
        return { rows: [{ id: params[0], current_revision: 2, lifecycle_status: 'active' }] };
      }
      if (/^SELECT count\(\*\)::int AS n FROM collaboration_graph_nodes/i.test(text)) return { rows: [{ n: 4 }] };
      if (/^SELECT count\(\*\)::int AS n FROM collaboration_graph_edges/i.test(text)) return { rows: [{ n: 3 }] };
      if (/^SELECT count\(\*\)::int AS n FROM collaboration_graph_events/i.test(text)) return { rows: [{ n: 2 }] };
      if (/^SELECT kind, count\(\*\)::int AS n FROM collaboration_graph_nodes/i.test(text)) {
        return { rows: [{ kind: 'root', n: 1 }, { kind: 'agent_step', n: 3 }] };
      }
      if (/^SELECT kind, count\(\*\)::int AS n FROM collaboration_graph_edges/i.test(text)) {
        return { rows: [{ kind: 'parent_of', n: 3 }] };
      }
      if (/^SELECT case_json FROM cloud_rdmd_inference_jobs/i.test(text)) {
        const row = jobRowsByCaseId.get(text) || jobRowsByCaseId.get(params[0]);
        return { rows: row ? [{ case_json: row }] : [] };
      }
      throw new Error(`fakePool 没准备这条 SQL：${text.slice(0, 120)}`);
    },
    async end() { throw new Error('注入的 pool 不该被 submitAll 关掉'); },
  };
}

function fakeHttp({ caseJsonByJobId }) {
  const posted = [];
  return {
    posted,
    async get(pathname) {
      if (pathname === '/healthz') return { status: 200, body: { ok: true } };
      throw new Error(`假 HTTP 没准备 GET ${pathname}`);
    },
    async post(pathname, body) {
      assert.equal(pathname, '/api/rdmd/jobs');
      const jobId = `job_fake_${posted.length + 1}`;
      posted.push({ jobId, body });
      // **真云侧会先过白名单再落库**（`cloud/src/modules/rdmd/index.mjs` 的 submit 走
      // `buildRdmdCloudPayload`）。这里若原样存 `body.case`，读回审计报出来的"泄漏"
      // 只是假 HTTP 没照云侧做，而不是我们的载荷有问题 —— 那就等于测了个假象。
      caseJsonByJobId.set(jobId, buildRdmdCloudPayload({ case: body.case }));
      return { status: 201, body: { jobId, status: 'queued' } };
    },
    // provision 用真实现不合适（要真签名与真表），这里只回一个形状对的 grant。
    async provision() {
      return {
        grantId: 'dgr_fake', token: 'dgr_fake_token', deviceId: 'device_sim_task_group',
        userId: SIM_OWNER_USER_ID, scopes: ['rdmd:infer'],
      };
    },
  };
}

test('submitAll 的非干跑路径：写图、提交、读回审计，并留下可回收的 jobs.jsonl', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-submit-'));
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'sim-test-secret';
  try {
    const cases = await allCases();
    const casesPath = join(dir, 'generated.jsonl');
    const briefsPath = join(dir, 'briefs.jsonl');
    const jobsPath = join(dir, 'jobs.jsonl');
    writeFileSync(casesPath, `${cases.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    writeFileSync(briefsPath, `${JSON.stringify(BRIEF)}\n`, 'utf8');

    const caseJsonByJobId = new Map();
    const pool = fakePool({ jobRowsByCaseId: caseJsonByJobId });
    const http = fakeHttp({ caseJsonByJobId });

    const report = await submitAll({
      casesPath, briefsPath, jobsPath, quiet: true, pool, http,
    });

    // 报告的形状就是"没写错参数名"的证据（`skippedStore is not defined` 就是死在这一步）。
    assert.equal(report.submitted, cases.length, `提交数不对：${JSON.stringify(report)}`);
    assert.equal(report.stored, cases.length);
    assert.equal(report.skipStore, false);
    assert.equal(report.dryRun, undefined, '非干跑的报告里不该有 dryRun');

    // 每条都真 POST 了，且载荷里只带白名单内的东西。
    assert.equal(http.posted.length, cases.length);
    for (const item of http.posted) {
      assert.deepEqual(Object.keys(item.body).sort(), ['case', 'conversationKind', 'taskRunId']);
      // 空串是**桌面端实际发的值**；发别的会被云侧当成未知类型。
      assert.equal(item.body.conversationKind, '');
      assert.equal(item.body.case.id, item.body.case.id.toLowerCase().length >= 0 ? item.body.case.id : '');
    }

    // 每条都先写了图（`--skip-store` 是唯一会跳过它的开关）。
    const graphDeletes = pool.seen.filter((row) => /^DELETE FROM collaboration_graphs\b/i.test(row.text));
    assert.equal(graphDeletes.length, cases.length, '写图次数与 case 数不一致');

    // 读回来核对："写成功"不等于"读得出来"。这里断言读回来的图**不是空的** ——
    // 白名单/投影任一处把内容裁掉，症状就是"报告正常、图是空的"。
    assert.ok(report.graphReadback.length > 0, '一条 readback 都没有');
    for (const sample of report.graphReadback) {
      assert.equal(sample.graphs, 1, `读不回图：${JSON.stringify(sample)}`);
      assert.ok(sample.nodeCount > 0 && sample.edgeCount > 0 && sample.eventCount > 0,
        `读回来的图是空壳：${JSON.stringify(sample)}`);
    }

    // jobs.jsonl 是 collect 的账，必须落盘且带 jobId。
    assert.ok(existsSync(jobsPath), 'jobs.jsonl 没落盘 —— collect 会以为一条都没提交');
    const jobs = readFileSync(jobsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(jobs.length, cases.length);
    for (const job of jobs) {
      assert.match(job.jobId, /^job_fake_\d+$/);
      assert.equal(job.graphId, job.graphId);
      assert.ok(job.nodes > 0 && job.gold, `jobs 行不完整：${JSON.stringify(job)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--skip-store 真的跳过写图，但仍然提交（那是它唯一的作用）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-submit-skip-'));
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'sim-test-secret';
  try {
    const cases = await allCases();
    const casesPath = join(dir, 'generated.jsonl');
    const briefsPath = join(dir, 'briefs.jsonl');
    writeFileSync(casesPath, `${cases.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    writeFileSync(briefsPath, `${JSON.stringify(BRIEF)}\n`, 'utf8');

    const caseJsonByJobId = new Map();
    const pool = fakePool({ jobRowsByCaseId: caseJsonByJobId });
    const http = fakeHttp({ caseJsonByJobId });
    const report = await submitAll({
      casesPath, briefsPath, jobsPath: join(dir, 'jobs.jsonl'), quiet: true, skipStore: true, pool, http,
    });

    assert.equal(report.skipStore, true);
    assert.equal(report.stored, 0, '--skip-store 却写了图');
    assert.equal(report.submitted, cases.length, '--skip-store 不该少提交');
    const graphDeletes = pool.seen.filter((row) => /^DELETE FROM collaboration_graphs\b/i.test(row.text));
    assert.equal(graphDeletes.length, 0, '--skip-store 却动了图');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
