# 活体观测：四层图在真实数据上到底有没有底料

> 探针：`ubuddy_recon/_probe_agent_plan_live.mjs`（只读打开 janus.db）
> 运行：`node _probe_agent_plan_live.mjs "$env:USERPROFILE\.janus-test\data\janus.db"`
> 结论用于「这条路值不值得继续投入」，**不是**实现的依赖。

## 1. 结论

**观测不到 plan 事件；四层图在任何地方都没有一行数据。** 具体分三层证据。

### 1.1 桌面端 `collaboration_graph*` 表根本不存在

两个本地库都没有建过 `ubuddy_collaboration_graph_v1` 这个迁移：

| 库 | 大小 | `schema_migrations` 条数 | 含 graph 迁移 | `collaboration_graph_*` 表 |
|---|---|---|---|---|
| `~/.janus-test/data/janus.db` | 3.2 GB（今天仍在写） | 95 | 否 | 不存在 |
| `~/.janus/data/janus.db` | 1.1 GB | 94 | 否 | 不存在 |

`db.js` 每次开库都会在 `migrateDatabase()` 里**无条件**调用
`ensureUBuddyCollaborationGraphSchema(db)`（`sqliteMigrations.js:553`），所以「表不存在」只能说明
**最后一次打开这个库的构建早于这段代码**。也就是说：这不是一个开关或能力位的问题，
而是「这份构建还没跑过那次迁移」。

后果：`readCollaborationGraphModelCase` 这类读图入口在本地**没有任何一行可以读**。
云端 PG 那边表在、但同样 0 行（P0 体检已确认）。所以
「`agent_step` 层的真实字段填充率表」**今天无法从真实数据产出** —— 因为不存在真实数据。

### 1.2 plan 通道：同源兄弟都在，只有 plan 没有

`~/.janus-test` 的 `task_events`（8,116 行）里 `payload_json.activityType` 分布：

```
protocol 1161 | command 331 | commentary 199 | agent 139 | status 92 | usage 45
image 31 | file 31 | model 25 | reasoning 20 | sandbox 18 | answer 15 | progress 12
tool 6 | error 4 | goal 1 | artifact 1        ← 没有 plan
```

`plan` 的发现路径与 `goal` / `usage` / `model` / `reasoning` / `sandbox` / `answer` / `artifact`
**完全同源**（都在 `codex.js` 的 `handleNotification` 里走
`standaloneProtocolActivity` → `emitNativeActivity` → task_events）。这七个兄弟**全部有行**，
只有 `plan` 是 0 —— 所以这不是持久化丢件，也不是 12KB 截断：

- **不是截断**：库里有 66 行带 `"truncated":true`，387 行超过 12,000 字节上限，
  但那些行的 activityType 都不是 plan（plan 行数为 0，`planPayloadBytes.rows = 0`）。
- **不是没落库**：同源兄弟有行，通道是活的。

**判定**：当前配置下 Codex app-server 没有发出 `turn/plan/updated`。这就是
`codex.js:1852` 那条唯一来源没有触发。

### 1.2.1 换一个独立的库复现，结论一致

`~/.janus/data/janus.db`（发布档，1.1 GB，与上一个库无数据关系）跑同一个探针：

```
activityTypes: protocol 162 | command 41 | commentary 29 | status 20 | agent 16
             | usage 10 | sandbox 5 | model 5 | answer 5 | reasoning 4   ← 同样没有 plan
planRows = 0 | collaboration_graphs exists = false | verdict = no_plan_observed
```

两个互不相关的库给出同一个结论，所以这不是某个 profile 的偶发状态。

### 1.3 持续规划那条路也没跑过

`ubuddy_planning_sessions` = 0，`ubuddy_planning_session_events` = 0。
`plan`-like 的 planning 事件 = 0。

### 1.4 旁证：本地真实任务规模

```
task_events 8116 | task_runs 6 | task_nodes 7 | task_graph_revisions 11
task_node_result_versions 4 | collaboration_groups 11 | agent_delegations 35
```

任务量很小（7 个 task node、4 份结果版本），所以即使图能建出来，样本量也不足以支撑
任何统计结论。

## 2. 这对计划意味着什么

计划里观测门写的两条分支，落在**第二条**上：

> 观测不到 → 如实记录，价值重心转向 `agent_task` 层漂移与 `status` 通道，
> 并且**不写任何适配器**去补底料。

按计划的指示执行：不写适配器，不为了凑底料去合成 plan 事件。

但观测还**多报了一条计划没预料到的事**，见下节 —— 它比「没有 plan」更严重。

## 3. 额外发现：`agent_task` 这一层，G_plan 侧也没有富文本来源

计划的锁定决定是「step 层收窄，`agent_task` 以上不放松」。按真实投影逐字核对后，
这条在 **G_plan 侧**站不住：

| 来源函数 | 真实写入的字段 |
|---|---|
| `proposalNodesFromTaskRun`（`:639`） | `localId` / `title` / `agentId` / `dependencies` |
| `buildPlanExecGraphs` 提案分支（`:404-410`） | `id` / `title` / `agentId` / `kind` / `status` |
| `publicTaskNodeSummary`（`:468`） | `resultSummary \|\| waitReason \|\| errorText \|\| objective` |

也就是说：**G_plan 的 `agent_task` 节点只有 `title` / `agentId` / `status`，
`summary` 与 `output` 在规划侧没有来源**（提案里根本不带这两个东西）。
而执行侧才有：`summary ← public_summary`、`output ← task_nodes.result_text`。

用真实投影形状跑一遍闸门（`_probe_real_gate.mjs`，一个已完成的、有两步 plan 的群任务）：

```
gaps = [
  { graph: 'G_star', field: 'summary', kind: 'agent_task' },
  { graph: 'G_star', field: 'output',  kind: 'agent_task' },
]
PASSES GATE: false
```

**所以 P1 的验收条件「真实群任务的 case 过闸门（gaps 为空）」在今天的契约下
不可能成立**，而且不是偶发：每一个提案节点都会稳定产生这两条缺口。

对照语料侧，v3 的 `layeredGroupPlan`（`lib/localTeacher.mjs:180`）给**每一个**节点
（包括 `agent_step`）都写满 `artifact` / `output` / `summary` / `inputs` / `stage`
（`content()` 函数）。这正是计划警告的那个错配：**语料读满字段，真实的 G_plan 却没有**。

### 3.1 这意味着什么

要么契约与语料都按「**哪一侧**」分档（G_plan 窄、G_prime 富），要么接受
「真实群任务恒 fail-closed、产品路径永远停在 `record_only`」。

这不是可以靠调阈值绕过去的：契约的准入规则 (b) 说「不能要求模型读不到的字段」，
而 `summary` / `output` 在 G_plan 上确实读不到。

## 4. 端到端验证：当 plan 真的到来时，四层图与闸门成立

观测门的两条分支里，上面 1–3 节落在「观测不到」。但「观测不到」**不等于**投影代码是坏的 ——
所以第 3 节那个契约缺口被按「侧」分档修掉之后，必须补一次端到端验证，否则 P1 的验收
（「真实群任务的 case 过闸门」）永远停在纸面。

做法（`ubuddy_recon/_probe_layered_graph_e2e.mjs`，**只在 janus.db 的副本上跑**）：

1. `scripts/_rdmd_snapshot_db.mjs` 用 `VACUUM INTO` 拷一份一致快照，绝不动原始库；
2. `scripts/_rdmd_migrate_snapshot.mjs` 在副本上跑真实迁移（`splitSchemaIndexes` +
   `layered.tables` + `migrateDatabase` + `layered.indexes`，镜像 `db.js#openDatabase`），
   把 `collaboration_graph_*` 建出来；
3. 挑一个**真实** task run（`task_4e1015ef…`，标题「向 test-1 询问其近期完成的工作和进展…」，
   带 `delegationId=agent_delegate_lq7VMZD5zsMHC49d`，2 个 task node）；
4. 往 `task_events` 注入两条**按真实形状**的 `turn/plan/updated` 事件（首版 3 步；
   第二版砍到 2 步），形状对齐 `uBuddyAgentPlanSteps.js#normalizeAgentPlan`；
5. 调用**真实 store 方法** `projectTaskRunToCollaborationGraph` 与 `readPlanExecGraphs`。

### 4.1 结果：四层图真的建出来了

```
collab_graph_delegation_20fd82e43254ffbcfd335c8350a27c9b
  root       depth 0  × 1
  ubuddy     depth 1  × 1
  agent_task depth 2  × 2
  agent_step depth 3  × 3      ← 第三层存在，depth=3 通过 CHECK

边：parent_of 6 | assigned_to 2 | delegates_to 1 | sequence_of 1
projection: appliedNodes 3, appliedEdges 4, taskNodesWithPlan 1, revisions 2, skippedEvents 0
```

`appliedEdges 4 = 3 × parent_of + 1 × sequence_of`。`sequence_of` **只有 1 条**是对的：
第二版计划把第 3 步砍掉了，被砍的步进 `folded.cancelled` 而不是顺序链，所以 3 步只剩
1 条链边（step0→step1）。这同时验证了「后续版本砍步 → 标 cancelled 而不是留着上一版
状态骗人」这条修正逻辑真的生效。

### 4.2 结果：step 层的真实字段填充率（P0 观测的交付物）

| 字段 | 实测 |
|---|---|
| `title` | 有值（步骤名，如「拉原始表」） |
| `status` | 有值（`queued` / `cancelled`） |
| `public_summary` | **恒空**（3/3 节点） |
| `artifact` / `output` / `inputs` / `stage` | 不存在（投影从不写） |

这就是 P1 契约把 `agent_step` 档取成 `['title','status']` 的**实测背书**：之前只是
「读代码可以确定」，现在是一个真实 projection run 的观测结果。计划里那句
「观测无法给出别的答案」得到确认。

### 4.3 结果：闸门通过，且两侧分档是它通过的原因

```
gaps = []            (byField {} / byKind {} / bySide {}, total 0)
PASSES GATE: true
metric = { ready: true, missing: [] }

G_plan 侧 step：拉原始表 queued | 缺失值处理 queued | 交付物复核 queued
G_exec 侧 step：拉原始表 queued | 缺失值处理 queued | 交付物复核 cancelled
```

三个结论：

1. **P1 验收达成**：真实群任务的 case 过闸门（`gaps` 为空），不是靠合成一个理想 case，
   而是真实 task run + 真实投影代码 + 真实迁移。
2. **按侧分档是必需的**：同一张图在旧的「一刀切」契约下会稳定产出 `G_star.summary` 与
   `G_star.output` 两条缺口（见第 3 节）。分档后为 0。这不是放宽，是把「模型的必需字段」
   收缩到「该侧真的有来源的字段」。
3. **漂移信号在窄字段集内是可表达的**：G_plan 3 步全 `queued`，G_exec 第 3 步
   `cancelled` —— 这正是 P2 要在 `agent_step` 层用 `['title','status']` 表达的
   「计划里有、执行时被砍掉」型漂移，不需要 step 层有任何富文本。

### 4.4 边界（必须说清楚，避免被误读成「补底料」）

- 注入 plan 事件是**故意的**：产品代码一行没改，真实库一行没改，探针只在副本上跑。
  它验证的是「**当** app-server 真的发出 plan 时，产品侧的投影与闸门是否成立」，
  也就是观测门「观测到了」那条分支的等价验证。
- 它**不**改变第 2 节的判定：今天真实数据里没有 plan，四层图的底料仍然不存在。
  step 层的富文本供给（计划「明确不做」第一条）依然不做。
- 代价是这次验证用的委托只带 1 个 uBuddy（`delegates_to 1`）。**≥2 uBuddy 的群任务
  仍然没有被真实跑过**，那需要人在应用里跑一次；这一项如实记为未完成。

## 5. 复现

```powershell
cd D:\Cli-anything\Janus\experiments\rdmd_detective_dataset\ubuddy_recon
node _probe_agent_plan_live.mjs "$env:USERPROFILE\.janus-test\data\janus.db"
node _probe_agent_plan_live.mjs "$env:USERPROFILE\.janus\data\janus.db"

# 端到端（先拷快照 + 迁移，再跑探针；不动原始库）
cd D:\Cli-anything\Janus
node scripts/_rdmd_snapshot_db.mjs "$env:USERPROFILE\.janus-test\data\janus.db" "$env:TEMP\rdmd_snap\janus_snapshot.db"
node scripts/_rdmd_migrate_snapshot.mjs "$env:TEMP\rdmd_snap\janus_snapshot.db"
cd experiments\rdmd_detective_dataset\ubuddy_recon
node _probe_layered_graph_e2e.mjs "$env:TEMP\rdmd_snap\janus_snapshot.db"
```
