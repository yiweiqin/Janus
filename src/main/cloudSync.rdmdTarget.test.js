/**
 * `RDMD_CLOUD_URL` 的写死行为：它是**提交目标的显式覆盖**，不是「可用性提示」。
 *
 * 这个 bug 的形状值得写清楚，因为它没有任何报错：
 *
 *   - `planExecDriftService.resolveRdmdInferenceConfig` 用 `RDMD_CLOUD_URL` 判断
 *     「云通道通不通」（`cloudUrl = env.RDMD_CLOUD_URL || cloudValue.serverUrl`）；
 *   - `cloudSync.rdmdInfer` 真的提交时用 `cloud_sync_state.server_url`
 *     （`client.submitRdmdJob(this.state(), ...)` → `fetchJson` → `state.server_url`）。
 *
 * 于是「把 RDMD 单独指向一台盒子」的结果是：判成 cloud 可用 → 每条都发去 `server_url`
 * → 404 → 落库 `record_only` + `cloud_http_404`。看起来像云不认得我们，实际是发去了两台机器。
 *
 * 所以下面第二条测试是**负对照**：故意把 `RDMD_CLOUD_URL` 指到一个必然连不上的地址，
 * 正确实现必须**失败**。如果它"通过"了（成功拿到判定），说明覆盖根本没生效 ——
 * 那正是修之前的行为，而且正是最难发现的一种"全绿"。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openDatabase } from './db.js';
import { Store } from './store.js';
import { CloudSyncService, resolveRdmdTargetUrl } from './cloudSync.js';

/** 一个必然连不上的地址：端口 1 上不会有人监听，连接会立刻被拒。 */
const DEAD_URL = 'http://127.0.0.1:1';

/**
 * 起一个真的、只认 `/api/rdmd/jobs` 的假云。返回 `unavailable` 而不是 `queued`，
 * 这样 `rdmdInfer` 拿到判定就直接返回、不轮询 —— 断言只需要看**提交打到谁身上**。
 */
async function startFakeRdmdApi({ status = 'unavailable', reason = 'model_not_configured' } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status, reason, jobId: '',
        verdict: { status: 'UNKNOWN', reason, driftType: null, nodeId: '' },
      }));
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    seen,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 真 SQLite + 真 Store + 真 CloudSyncService（`cloudSync.js` 不依赖 Electron，实测可 import）。 */
async function realServiceFixture({ serverUrl, userId = 'user_rdmd_target' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-rdmd-target-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const service = new CloudSyncService({
    root,
    db,
    store: new Store(db, { root }),
    authStateProvider: () => ({ access_token: 'test-access-token', remote_user_id: userId }),
  });
  service.saveConfig({ serverUrl, userId, token: 'test-sync-token' });
  return {
    root, db, service,
    async close() {
      db.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/** 每个用例都自己收起 env，避免 `RDMD_CLOUD_URL` 漏到下一条用例。 */
function withRdmdCloudUrl(value, body) {
  const previous = process.env.RDMD_CLOUD_URL;
  if (value === undefined) delete process.env.RDMD_CLOUD_URL;
  else process.env.RDMD_CLOUD_URL = value;
  return Promise.resolve()
    .then(body)
    .finally(() => {
      if (previous === undefined) delete process.env.RDMD_CLOUD_URL;
      else process.env.RDMD_CLOUD_URL = previous;
    });
}

test('resolveRdmdTargetUrl：覆盖优先、只有空白才退回同步地址', () => {
  assert.equal(resolveRdmdTargetUrl({}, 'https://sync.example.test'), 'https://sync.example.test');
  assert.equal(resolveRdmdTargetUrl({}, ''), '');
  // 覆盖生效，并归一化掉尾斜杠 —— 否则会拼出 `//api/rdmd/jobs`。
  assert.equal(
    resolveRdmdTargetUrl({ RDMD_CLOUD_URL: 'http://127.0.0.1:8787/' }, 'https://sync.example.test'),
    'http://127.0.0.1:8787',
  );
  // 空串 / 空白等价于「不设」，不会把一个原本可用的部署关掉。
  for (const blank of ['', '   ']) {
    assert.equal(
      resolveRdmdTargetUrl({ RDMD_CLOUD_URL: blank }, 'https://sync.example.test'),
      'https://sync.example.test',
      `RDMD_CLOUD_URL=${JSON.stringify(blank)} 不该改变提交目标`,
    );
  }
  // 非空但畸形**原样采纳**，不退回 server_url。
  // 理由：可用性判断读的是同一个 env，如果这里"宽容地"退回，就重新造出了
  // 「判可用时读覆盖、提交时读另一处」这个 bug —— 而且这次连报错都没有。
  // 宁可让它在拼 URL 时炸响。
  assert.equal(
    resolveRdmdTargetUrl({ RDMD_CLOUD_URL: 'not-a-url' }, 'https://sync.example.test'),
    'not-a-url',
  );
});

test('RDMD_CLOUD_URL 生效：同步地址是死的，覆盖地址是活的，提交必须走覆盖', async (t) => {
  const api = await startFakeRdmdApi();
  const fixture = await realServiceFixture({ serverUrl: DEAD_URL });
  t.after(async () => { await fixture.close(); await api.close(); });

  await withRdmdCloudUrl(api.baseUrl, async () => {
    const result = await fixture.service.rdmdInfer({ taskRunId: 'task_1', case: { id: 'case_1' } });
    assert.equal(result.status, 'unavailable', '提交必须落到覆盖地址上');
  });

  assert.equal(api.seen.length, 1, '假云必须真的收到这一次提交');
  assert.equal(api.seen[0].url, '/api/rdmd/jobs');
  assert.equal(api.seen[0].authorization, 'Bearer test-access-token', '认证头不能因为换目标而丢');
});

test('负对照：覆盖地址是死的时必须失败，否则说明覆盖根本没生效', async (t) => {
  const api = await startFakeRdmdApi();
  // 同步地址是活的、覆盖地址是死的。修之前实现只认同步地址，这条会"通过"（拿到 unavailable）
  // —— 那恰恰是 bug 本身。正确实现必须抛。
  const fixture = await realServiceFixture({ serverUrl: api.baseUrl });
  t.after(async () => { await fixture.close(); await api.close(); });

  await withRdmdCloudUrl(DEAD_URL, async () => {
    await assert.rejects(
      () => fixture.service.rdmdInfer({ taskRunId: 'task_2', case: { id: 'case_2' } }),
      `RDMD_CLOUD_URL=${DEAD_URL} 时提交到 ${api.baseUrl} 就等于忽略了这个覆盖`,
    );
  });

  assert.equal(api.seen.length, 0, '被覆盖掉的地址不该收到任何请求');
});

test('不设覆盖时行为不变：还是走同步地址', async (t) => {
  const api = await startFakeRdmdApi();
  const fixture = await realServiceFixture({ serverUrl: api.baseUrl });
  t.after(async () => { await fixture.close(); await api.close(); });

  await withRdmdCloudUrl(undefined, async () => {
    const result = await fixture.service.rdmdInfer({ taskRunId: 'task_3', case: { id: 'case_3' } });
    assert.equal(result.status, 'unavailable');
  });

  assert.equal(api.seen.length, 1);
});
