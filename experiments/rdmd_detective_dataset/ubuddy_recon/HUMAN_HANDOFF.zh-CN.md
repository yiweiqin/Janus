# 只能由人做的两件事：交接清单（2026-09-19）

> 相关：`PLAN_EXEC_TRUTH.zh-CN.md` §12.6 / §12.7（P2 断点清单与验收）、§15（P5）
> 本文件是**交接书**，不是结论：里面每条都写清「谁做、做什么、做完怎么验、验完把什么数字贴回来」。
> 只读探针：`_probe_desktop_state.py`（凭据打码）。本轮实测的数字都标了来源。

---

## 0. 一句话状态

| 交接 | 状态 |
| --- | --- |
| **A. 装新构建 → 重启 → 跑 ≥2 个真实群任务** | **仍未做**（输入侧最后一跳，卡在发布） |
| **B. 核对 `cloud_sync_state.server_url`** | **已经查出来了，而且结论与预期不同**：它指向的云**没有** `/api/rdmd` 路由；`:8787` 从本机不可达。仍需您确认「123.207.22.235 是不是 bjb1 那台」 |

---

## 1. 交接 A：装新构建 → 重启桌面端 → 跑 ≥2 个真实群任务

### 1.1 为什么只能人做

`PLAN_EXEC_TRUTH` §12.6 断点 3：`collaboration_graph_*` **四张表在任何已安装构建里都不存在**，
所以四层图的投影没有落点。代码早就在仓库里（`sqliteMigrations.js:2172` 起的
`collaboration_graphs` / `collaboration_graph_nodes` / `collaboration_graph_edges` /
`collaboration_graph_events`），**缺的是一个含这段迁移的安装包 + 一次重启**。

在本轮复测里这一点仍然成立（只读实测）：

```
$ python experiments/rdmd_detective_dataset/ubuddy_recon/_probe_desktop_state.py
   collaboration_graph_* 表: （一张都没有）
   collaboration_groups 条数: 7          ← 群任务是有的，缺的是"图"
   task_events 里 plan 事件: 8（步骤数 5×4 / 4×2 / 3×2 = 34 步）
   task_nodes 里 dependencies_json 非空: 6 / 16 行（其中 1 行 3 个依赖）
   task_graph_revisions 条数: 0           ← 文档 §1.4 记的是 11，本地库已变
```

### 1.2 做什么

1. **装一个含 `ensureUBuddyCollaborationGraphSchema` 的构建**（本轮分支已推送，
   基线 6 个提交）。
2. **重启桌面端**（迁移在启动时跑）。
3. **跑 ≥2 个真实 uBuddy 群任务**，每个至少 **2 个参与者**，并且**让它们真的含有计划步骤**
   （planner 至少发过一次 `turn/plan/updated`）。
   - 不必刻意失败：这一轮的验收是「投影能不能物化」，不是「漂移判得准不准」。
   - 两个任务请尽量一大一小（一个步骤 ≤5，一个 ≥10），这样能看出投影在高步数下的行为。

### 1.3 跑完怎么验（三条命令）

```powershell
cd D:\Cli-anything\Janus

# ① 迁移到底跑没跑 + 计划事件有没有长出来
python experiments/rdmd_detective_dataset/ubuddy_recon/_probe_desktop_state.py

# ② 四层图是否物化（在**副本**上跑，真实库一行都不改）
cd experiments/rdmd_detective_dataset/ubuddy_recon
node _snapshot_db.mjs "$env:USERPROFILE\.janus-test\data\janus.db" "$env:TEMP\janus_fresh.db"
node _probe_layered_graph_e2e.mjs "$env:TEMP\janus_fresh.db"

# ③ 影子提案有没有开始进库（有判定之后才有内容）
cd D:\Cli-anything\Janus
node scripts/rdmd_shadow_report.mjs "$env:USERPROFILE\.janus-test\data\janus.db"
```

### 1.4 验收标准（写死，别用「看起来有了」代替）

| # | 判据 | 期望 |
| --- | --- | --- |
| 1 | `collaboration_graph_*` 四张表 | 都存在 |
| 2 | 真实群任务数 | **≥2**，每个 ≥2 参与者 |
| 3 | `task_events` 里 `activityType='plan'` 的事件 | **> 8**（相对本轮基线 8 增长） |
| 4 | `collaboration_graph_nodes` 里 `kind='agent_step'` 的行 | **> 0**（此前从未物化过） |
| 5 | `_probe_layered_graph_e2e.mjs` 的 `gate` 段 | 能跑到「缺口」并说出缺哪个字段；**不要求**通过（§12.5 那条豁免规则还没决策） |
| 6 | `rdmd_shadow_report.mjs` | 能出表；`observations` 仍可能是 0 —— **这不是失败**，是没判定 |

### 1.5 验完请把这几样贴回文档

- 上面 ① 的 `collaboration_graph_*` 那两行 + `plan 事件` 那两行；
- ② 里 `steps` / `graph` / `gate` 三段的原文；
- ③ 的表（含 `observations` 与分母）；
- 一句人话：两个任务各几步、有没有中途被砍掉的步骤。

贴回位置：`PLAN_EXEC_TRUTH.zh-CN.md` 新开一节（或直接贴在 §12.7 后面）。

---

## 2. 交接 B：`server_url` 指向核对 —— 已查出，且与预期不同

### 2.1 读到的值（只读实测，凭据已打码）

```
$ python experiments/rdmd_detective_dataset/ubuddy_recon/_probe_desktop_state.py
   server_url                       http://123.207.22.235
   auto_sync                        1
   evolution_enabled                1
   sync_schema_version              6
   last_sync_cursor                 2026-09-19T06:17:14.491Z
   last_success_at                  2026-09-19T06:19:44.416Z
   last_error                       （空）
```

**它不是 `…:8787`**：没有端口 = 默认 80。而同步是**成功**的（`last_success_at` 就在今天），
所以这个地址是活的、能说 sync 协议 9 —— 先把这一点记住，别把一条在工作的配置当成写错。

### 2.2 三发只读探测（GET，不改任何东西）

| 目标 | 结果 | 读法 |
| --- | --- | --- |
| `http://123.207.22.235/healthz` | **200** `{"ok":true,"status":"ok","version":"1.1.58",…}` | 这台**确实是**一个 Janus 云 API，活着，前面有反代（80 端口） |
| `http://123.207.22.235/api/rdmd/jobs/__probe__` | **404** | **RDMD 模块不在这台部署上**。若在，这个 GET 会先被 auth 挡成 **401** |
| `http://123.207.22.235:8787/healthz` | **连接超时** | 本机到 `8787` 没有服务（那台 bjb1 要么不在这个 IP 上，要么没开在这个端口） |

### 2.3 后果（为什么要紧）

桌面端选云通道的判据是「有地址 **且** 有提交函数」（`planExecDriftService.js:561`
`cloudUrl = env.RDMD_CLOUD_URL || cloud().serverUrl`，`runtime.js:1206` 注入
`cloudSync.rdmdInfer`）。所以现在这个配置下：

- 通道会被判成 **`cloud` 可用**（地址有、infer 有）；
- 然后每一次提交都会 **404**；
- `cloudSync.rdmdInfer` 的契约是「**失败一律抛**，由上层归一成 `record_only` 的原因」
  （`cloudSync.js:1909`）—— 所以**不会伪造判定**，但对**每一条** case 都是
  「提交即失败 → record_only」，影子度量的观测永远是 0。

也就是说：**「云是唯一通路」这句话今天也不成立** —— 云在，但那条路由不在。
这正是交接 A 之外的另一半：就算装上新构建、跑完真实群任务，**也不会产生任何判定**。

### 2.4 需要您判断/处理的两条

1. **确认 `123.207.22.235` 是不是 bjb1 那台。**
   - **是** → 问题从「地址写错」变成「**部署落后**」：那台跑的是 `1.1.58` 的 bundle，
     需要把含 `cloud/src/modules/rdmd` 的构建部署上去并重启。
   - **不是** → 那就需要在桌面端把地址改成 bjb1 那台（或设 `RDMD_CLOUD_URL` 覆盖，
     不动 `cloud_sync_state`）。**注意**：`server_url` 同时被同步与 RDMD 两处读，
     直接改它会影响同步，改之前先确认新地址也能说 sync 协议 9。
2. **部署之后复验一次**（同一条命令，期望从 404 变 401）：

   ```powershell
   try { Invoke-WebRequest -Uri 'http://<host>/api/rdmd/jobs/__probe__' -TimeoutSec 6 -UseBasicParsing } catch { [int]$_.Exception.Response.StatusCode }
   # 404 = 模块还没上；401 = 路由在（auth 挡住了未认证请求），这才是我们要的
   ```

---

## 3. 顺手发现（不是交接，但会影响判断，先记下）

1. **`npm run check:contracts` 是悬空脚本**：它指向 `scripts/contracts_check.mjs`，
   而该文件**在 git 全history 里都不存在**。本轮**没动它**（不属于方案 1），
   但它会让「跑一遍 check」这件事看起来做过而其实没有。
2. **编辑工具会往文件开头写 BOM**，而 `npm run cloud:test:hygiene` 正是为此设的门 ——
   本轮实测**它之前是红的**（`package.json` 与 `planExecDriftService.js` 带 BOM），
   本轮扫描全仓 21 个文件后清掉并复核通过。后续任何人编辑完这些文件，
   跑一次 `npm run cloud:test:hygiene` 比肉眼找快。
3. **本地库的数据已经变了**（相对 `G_PLAN_G_EXEC` §1.4 / §12 的记载）：
   `task_graph_revisions` 从 11 变成 **0**，`dependencies_json` 非空行从「7/13」变成
   「**6/16**」，plan 事件从「6 条 / 25+ 步」变成「**8 条 / 34 步**」。
   读旧结论时请先看一眼日期。

---

## 4. 本轮**没有**做（明确记下，免得被当成做过了）

- 没有装任何构建、没有重启桌面端、没有跑真实群任务（只能人做）。
- 没有改 `cloud_sync_state`（一行都没写；探针全程 `mode=ro`）。
- 没有修 §3.1 那个悬空 npm 脚本。
- 没有为长程层补 G_plan、没有改 `buildAgentGraph` 的投影（见 `SEQUENCE_TO_DAG.zh-CN.md` §4）。
