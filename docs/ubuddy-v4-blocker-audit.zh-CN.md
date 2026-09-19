# uBuddy V4 卡点核查基线（2026-09-19）

> 这一页是**后续所有决策的基线**：任何一个"卡住了"的说法，都要先在这里找到它是四类里的哪一类、
> 证据在哪个文件哪一行。没有行号的卡点不算卡点。

核查范围：`Janus/` 全目录（含 388 个未跟踪文件）+ 远程盒子 bjb1 只读探针 + 四路并行深挖
（无头可行性 / 云侧部署 / 模拟任务群 / CPDB 导出）。

## 0. 四类判定

| 类别 | 含义 | 数量 |
| --- | --- | --- |
| **不存在** | 曾经被当成卡点，实测不成立 | 2 |
| **已修** | 曾经真的是缺口，代码里已经补上 | 2 |
| **可绕开** | 真的存在，但有不依赖人工的路径 | 4 |
| **真存在且需处理** | 真的存在，且会静默失败或让干净克隆丢东西 | 4 |

---

## 1. 「不存在」的卡点

### N1. 「必须人工装一个桌面构建，否则管线跑不起来」— 实测不成立

这条是本轮**唯一被推翻**的主要卡点。推翻它的不是推理，是**已有的测试真跑过**：

- **四张图表明明在基础 schema 里**，不是只靠迁移：
  [`sqliteSchema.js:3164`](../src/main/modules/persistence/infrastructure/sqliteSchema.js) `collaboration_graphs`、
  `:3175` `collaboration_graph_nodes`、`:3188` `collaboration_graph_edges`、`:3197` `collaboration_graph_events`。
- **执行顺序也站在我们这边**：[`db.js:87`](../src/main/db.js) 才跑 `migrateDatabase(db)`，
  而基础 schema 更早。`ensureUBuddyCollaborationGraphSchema`（[`sqliteMigrations.js:2171`](../src/main/modules/persistence/infrastructure/sqliteMigrations.js)）
  在 `:553` 被**无条件**调用。所以就算迁移缺失，表照样会建。
- **实测两个套件在纯 Node（无 Electron）下全绿**：
  - `cloud/test/ubuddy-collaboration-graph.test.mjs` —— 真 `openDatabase` + 真 `Store` + 灌 plan 事件 + 投影四层图 + 读回 `G_plan`/`G_exec`，**7/7**。
  - `planExecDriftShadow.test.js` —— 真 SQLite + 真 `createPlanExecDriftService.record()`，并断言图表被写，**53/53**。
- **无 Electron 依赖**：`src/main` 下只有 [`main.js`](../src/main/main.js) 一处 `require('electron')`。
  `db.js` / `store.js` / `sqliteMigrations.js` / `collaborationGraphStoreMethods.js` / `planExecDriftService.js` 全部纯 Node。
  连 [`cloudSync.js`](../src/main/cloudSync.js) 也能在纯 Node 里 `import`（实测通过）。

> **唯一为真的窄口径**：**已安装的那个官方客户端本身**缺这段代码 —— 实测其 `resources/app.asar` 里
> `ensureUBuddyCollaborationGraphSchema` 出现 0 次、`/api/rdmd` 出现 0 次（我们本地 `pack:win:test` 的产物是 4 和 4）。
> 这只意味着「桌面 UI 里看不到图」，**不意味着管线跑不起来**。
> 这条窄口径在 [`planExecDriftService.js:86-93`](../src/main/modules/collaboration/application/planExecDriftService.js) 的注释里已被记录为「发布缺口」。

**结论**：无头路径（工作流 B）不需要任何人工安装步骤。桌面路径的缺口保留为「发布缺口」，另行处理。

### N2. 「盒子上的云 API 没有 RDMD 路由」— 实测路由在

- 盒子的云 API 对 `/api/rdmd/jobs/__probe__` 返回 **401**（= 路由在，只是要认证），不是 404。
- 云侧路由注册是**无条件**的：`cloud/src/server.mjs` 里模块导入与 `registerRdmdRoutes` 都不在 feature flag 后面。
  无 token 必然 401，`404` 只可能来自兜底 handler。
- 另：API 绑 `127.0.0.1`，所以在盒子上本地跑完全没有这个问题。

**与「生产云」的区别**：`123.207.22.235` 探到的是 **404** → 那台跑的是**旧 bundle**（见 R3）。

---

## 2. 「已修」的卡点

### F1. GRANT 缺失 — 已补

[`cloud/database/migrations/098_rdmd_inference_jobs_grants.sql`](../cloud/database/migrations/098_rdmd_inference_jobs_grants.sql)
已补上补票式 GRANT（该文件目前**未跟踪**，见 R1）。

背景（迁移 097 末尾的注释已写明）：迁移用 `janus_migrator` 跑，建出来的表属主是它，而云 API 用 `janus_api` 连库 ——
没有授权就是 `permission denied for table cloud_rdmd_inference_jobs`，且**只在第一次真的入队时才暴露**。

### F2. worker 回传的越权面 — 已收在签发端

[`097_rdmd_inference_jobs.sql:32-35`](../cloud/database/migrations/097_rdmd_inference_jobs.sql) 明确：
**不要**用 `owner_user_id` 去限制 worker 回传，因为 worker 是跨用户的服务身份（`scripts/_rdmd_worker_provision.mjs`），
它替所有用户领活，grant 的用户与 `owner_user_id` 天然不等。回传侧的越权面收在**签发端**：
`rdmd:infer` 只签给配置在册的服务身份（`cloud/src/modules/sync/deviceGrants.mjs` 的 `SERVICE_ONLY_SCOPES`），普通用户自取不到。

> **订正**：本计划的早期版本把这条写成「`recordVerdict` 不校验属主，应补属主交叉校验」。
> 按属主校验会**直接把 worker 打死**。真正有意义的交叉校验是「回传者必须是当前持有租约的那个 worker」，
> 见 R4。

---

## 3. 「可绕开」的卡点

### B1. 盒子云库的协作图是空的

`collaboration_graphs` / `_nodes` / `_edges` / `_events` 四张表**存在，行数全是 0**；
作业表 `completed 4 + failed_terminal 1`，**全是 E2E 夹具**（来自 `scripts/rdmd_cloud_e2e.mjs`）。

→ 缺的是**造数据**，不是装东西。绕开方式：模拟任务群写库（工作流 A2），
可直接复用 [`_verify_seed.sql:15-151`](../experiments/rdmd_detective_dataset/ubuddy_recon/_verify_seed.sql) 的 `generate_series` 种子模板。

### B2. 盒子没有模型密钥

实测 `env` 与云 API 的 `/proc/<pid>/environ` 里都没有模型密钥。

→ 你本机有 `CRS_OAI_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`，且 `https://codexpro.wwxb1123.xyz/v1` 端点可达
（无认证返回 401）。**运行时注入，不落盘**即可。

### B3. 协作图的物化时机

`createCollaborationGroup` 不会调 `ensureCollaborationGraphForDelegation`；只有委派被接受 / 进度更新时才物化。
模拟器必须**显式接受一次委派**，或直接调 `ensureCollaborationGraph`。

### B4. `migrateDatabase` 不能指向无关的空 SQLite 文件

它会对很多表做 `PRAGMA table_info`。无头内核要么走 `openDatabase(root, { skipMigrationBackup: true })`
（[`db.js:19`](../src/main/db.js)），要么指向一个**真实的 janus.db 快照**。混用会得到一坨 `no such table`。

---

## 4. 「真存在且需处理」的卡点

### R1. 仓库卫生 — 干净克隆会静默丢掉整个修订的载体

`git status` 共 **424** 条：未跟踪 **388**、已改 **26**、已暂存 **10**。

| 载体 | 未跟踪数量 | 为什么致命 |
| --- | --- | --- |
| `docs/` | **270**（只跟踪了 5 个） | V4 全部文档、主张冻结、三份协议（TPM / CPDB / RDMD）全在里面 |
| `src/shared/contracts/` | **18** | 含 `uBuddyTaskPublicMemory.js`（TPM 契约）与 `uBuddyCapabilityDependencyBundle.js`（CPDB 契约） |
| `experiments/cpdb_org_world/` | **44 个文件全部未跟踪** | 整个 CPDB 世界生成器 + 标注协议 + 数据 |
| `experiments/v4_self_evolution_feasibility/` | 整个目录未跟踪 | 可行性报告的证据链 |

另外 `cloud/database/migrations/098_*.sql` 未跟踪（见 F1）。

**需单独确认的两处**：
- `assets/auth-defaults.json` —— **已在本地被改过**（` M`），提交前要确认改动内容是否该进库。
- `scripts/_rdmd_env.ps1` —— 被 `.gitignore` 保护（含口令），**不该**进库；但它的存在意味着
  「SSH 口令来自本地文件」这件事没有进版本库的替代品。

### R2. `RDMD_CLOUD_URL` 是假开关 — 会静默失败

[`planExecDriftService.js:561`](../src/main/modules/collaboration/application/planExecDriftService.js)：

```js
const cloudUrl = text(env.RDMD_CLOUD_URL) || text(cloudValue.serverUrl);
const cloudInfer = typeof cloudValue.infer === 'function' ? cloudValue.infer : null;
const cloudReady = Boolean(cloudUrl && cloudInfer);
```

`RDMD_CLOUD_URL` **只参与「通道通不通」的判断**，不参与「发去哪」。真正提交在
[`cloudSync.js:1914-1917`](../src/main/cloudSync.js)：

```js
async rdmdInfer({ taskRunId = '', case: caseValue = {}, conversationKind = '' } = {}) {
  const payload = { ... };
  const submitted = await this.withAuthenticatedCloudIdentity(
    (authState) => this.client.submitRdmdJob(this.state(), payload, { accessToken: authState.access_token }),
  );
```

而 `this.client.submitRdmdJob` → `fetchJson(state, ...)` → [`cloudSyncClient.js:435`](../network/clients/cloudSyncClient.js)
用 `state?.server_url` 拼 URL。

**后果**：设 `RDMD_CLOUD_URL` 指向盒子 → 判成 cloud 可用 → 每条都发去 `cloud_sync_state.server_url` → 404 →
落成 `record_only` + `cloud_http_404`。**看起来像"云不认得我们"，实际是两台机器**。

**附带的坑**：改 `server_url` 不是无害操作。[`cloudSync.js:181-202`](../src/main/cloudSync.js)
的 `saveConfig` 一旦发现同步目标变了，会**清掉** `evolution_grant` / `device_grant`、把 `sync_schema_version` 重置为 5、
清空 `sync_capabilities_json` 与游标。所以「把桌面指向盒子」要连带重做同步身份，不能顺手改 —— 这也是
**让 `RDMD_CLOUD_URL` 成为真正的显式覆盖**比「改 server_url」更安全的原因：它不动同步身份。

→ 修法见 §5 D1。

### R3. 生产云是旧 bundle

`123.207.22.235` 的 `/api/rdmd/*` 返回 404。由于路由注册无条件（见 N2），404 只可能来自兜底 handler
→ **那台跑的是旧代码**。

→ **不修，只记录**：要走那条路需要那台的管理权，且改 `server_url` 会触发 R2 里的身份重置。
本计划完全不依赖它。

### R4. 迁移 098 不在部署校验里 + 回传路径缺「同租约」校验

两个都在同一条链上：

**(a) 迁移 098 的部署盲区。**
[`rdmd_cloud_deploy.py:144`](../scripts/rdmd_cloud_deploy.py) 的 `verify_remote()` 只断言 **096 / 097**（`:151-152`），
并在 `:166-170` 断言迁移头必须是 `097`。而 [`db.mjs:15`](../cloud/src/db.mjs) 的
`CLOUD_DATABASE_MIGRATION_HEAD` 也仍是 `'097_rdmd_inference_jobs.sql'`。
→ 缺 098 不会让 `/readyz` 变红，症状会拖到**第一次真的入队**才以 `permission denied` 出现。

**(b) 回传路径没有「回传者 = 持租约者」的校验。**
[`cloud/src/modules/rdmd/index.mjs:178-193`](../cloud/src/modules/rdmd/index.mjs) 的 `recordVerdict`
在 `:181` 按 `WHERE id=$1` 取作业，只检查了状态是 `claimed`/`running`（`:188`），
**没检查这条作业是不是被当前这个 worker 领走的**。同文件的 `read`（`:196-200`）在 `:197` 是带 `owner_user_id` 的。

注意（见 F2）：这里**不能**按 `owner_user_id` 校验。正确的校验维度是 `claimed_by` + 租约未过期 ——
这正是「领活」与「回传」之间的那一环。

---

## 5. 处理清单（与交付物的对应）

| 编号 | 卡点 | 处理 | 交付物 |
| --- | --- | --- | --- |
| D1 | R2 | 让 `RDMD_CLOUD_URL` 成为**真正的提交目标覆盖** | `src/main/cloudSync.js` + 负对照测试 |
| D2 | R4(b) | `recordVerdict` 校验 `claimed_by` = 本次回传的 worker 且租约未过期 | `cloud/src/modules/rdmd/index.mjs` + 云侧测试 |
| D3 | R4(a) | `verify_remote()` 补断言 098；决策迁移头是否前进 | `scripts/rdmd_cloud_deploy.py` / `cloud/src/db.mjs` |
| D4 | R1 | 把未跟踪载体纳入版本控制（口令文件除外） | git 提交 |
| D5 | 悬空脚本 | 清掉指向不存在文件的 npm 脚本；补文档引用却不存在的 `experiment:cpdb-*` | `package.json` |
| D6 | R3 | 不修，只记录 | 本页 §4 R3 |
| D7 | §3 全部 | 盒子闭环：模拟任务群 + 无头内核 + 云端提交回收 | `experiments/sim_task_group/`、`scripts/rdmd_headless_core.mjs` |

## 6. 悬空脚本清单（会让「跑过了」看起来发生过）

`package.json` 里指向**不存在文件**的脚本：

- `scripts/ubuddy_keepalive.mjs`
- `scripts/ubuddy_real_codex_full_chain_e2e.mjs`（`test:ubuddy-real-codex`）
- `scripts/ubuddy_direct_dispatch_smoke.mjs`（`test:ubuddy-direct-dispatch`）
- `scripts/ubuddy_intake_clarification_v2_smoke.mjs`（`test:ubuddy-intake`）
- `scripts/ubuddy_capability_catalog_smoke.mjs`（`test:ubuddy-capability-catalog`）
- `scripts/ubuddy_routing_runtime_smoke.mjs`（`test:ubuddy-routing`）
- `scripts/codex_agent_harness_smoke.mjs`（`test:codex-agent-harness`）
- `scripts/contracts_check.mjs`（`check:contracts`）

另外 `src/main/modelPolicy.*` **不存在** —— 模型策略实际在
[`experiments/ubuddy_orgbench/core/modelPolicy.mjs`](../experiments/ubuddy_orgbench/core/modelPolicy.mjs)。

以及文档（`experiments/cpdb_org_world/README.zh-CN.md`、`ANNOTATION.zh-CN.md`）里引用、
但 `package.json` 里**一条都不存在**的：`experiment:cpdb-world` / `:test` / `:smoke` / `-annotate` / `-agreement` / `-apply-labels`。

## 7. 本页不声称

- 不声称生产自进化已验证。
- 不声称 v4 超过规则基线。
- 不声称长程层可用（真实链 0/22 可因果归因）。
- 不声称生产云 `123.207.22.235` 可用（见 R3）。
