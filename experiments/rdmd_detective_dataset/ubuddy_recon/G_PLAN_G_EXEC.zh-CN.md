# G_plan / G_exec 的真实构造（2026-09-16 定义）

> 相关：`UBUDDY_RECON.zh-CN.md`（数据侦察与认知订正）、`deploy/INTEGRATION.zh-CN.md`（接入契约）、
> `V3_FULL_REPORT.zh-CN.md` 第 14 节
> 实现：`build_gplan_gexec.mjs`（只读，不写入任何真实库）
> 复现：见第 5 节

---

## 0. 一句话结论

**两个图必须分层构造，而且两层的可用性完全相反：**

| 层 | G_plan | G_exec | 边 | 能否承载 RDMD 的「级联根」 |
| --- | --- | --- | --- | --- |
| **uBuddy 组织层** | 计划节点集 | 已实现节点集 | **两层都是 0 条边**（实测） | **不能** —— 没有边就没有级联 |
| **agent 长程层** | （无计划快照） | Codex rollout turn 链 | **687 条边**，链长最高 **110** | 有真实结构，但**缺 G_plan** |

**组织层「零边」是实测事实，不是推断**，而且**与协作图是否落库无关**（理由见第 1.2 节）。
**长程层有真实的长程结构**，这是本文件最重要的发现。

---

## 1. 组织层：G_plan / G_exec

### 1.1 为什么不能用协作图

`collaboration_graph_*` **从未在任何已安装构建中存在**（两个 `app.asar` 全量字节搜索为 ABSENT；
两个真实库中四张表 MISSING）。所以本节只能基于**上游真实表**构造。

### 1.2 构造规则

| 图 | 构造 | 依据 |
| --- | --- | --- |
| **G_plan** | `task_nodes` **减去**「由 `task_graph_revisions` 引入的 fallback 节点」 | 没有计划快照落库，只能用这个可判定规则近似；**该近似本身是本构造的已知弱点** |
| **G_exec** | **全部** `task_nodes`（含 fallback） | 已实现的节点集 |

节点字段映射（真实 schema → `normalizeTaskGraph`）：

| 模型字段 | 真实来源 | 强度 |
| --- | --- | --- |
| `id` | `task_nodes.id` | direct |
| `title` | `task_nodes.title` | direct |
| `agentId` | `task_nodes.agent_id` | direct（但实测恒为 `general_agent`） |
| `status` | `task_nodes.status` | direct |
| `version` | **无来源** | **weak**：填常量 `'v1'`（`attempt_count` 是重试次数，不是语义版本） |
| `acceptance` | **无来源** | **weak**：填常量 `'standard'` |
| `role` | **无来源** | **missing**：填 `''` |

> **`version` / `acceptance` 填常量是有意的诚实话术**：不编造语义，但必须在报告里标明
> 「这两个字段在这套数据上不携带信息」。把重试次数当版本号会静默污染训练与评测。

### 1.3 边：唯一的来源，实测为空

投影链路（已逐环验证）：

```
task_nodes.dependencies_json
  --normalizeTaskNode (recordNormalizers.js:356, safeJsonParse)-->
taskNode.dependencies
  --collaborationGraphStoreMethods.js:226-230-->
dependency_of 边
```

实测：`dependencies_json` 在**两个库的全量行**（7/7 + 2/2，非抽样）上都是 `[]`。

**所以组织层 G_plan 与 G_exec 的边数恒为 0，且这一点与协作图表是否存在无关。**
这是**源数据**的属性。

### 1.4 revision 是「替换」，不是「依赖」

`task_graph_revisions` 的 `before_json` / `after_json` **不是全图快照**，而是**单节点局部增量**：

```json
before: {"replaced": {"id","title","status","agentId","dependencies":[], ...}, "dependents": []}
after:  {"replaced": {... "status":"cancelled" ...}, "fallback": {...}, "updatedDependents": []}
```

- `dependents` / `updatedDependents` **实测恒为 `[]`** → 不产生任何结构边。
- `replaced → fallback` 是**替换（supersession）**关系，不是依赖。本构造**单独记录**它
  （实测 11 条），**不把它当边** —— 否则会凭空造出 RDMD 意义上的「级联」。
- 11 条 revision 全部是**同一个节点**的 `running → cancelled` 循环（`attemptCount` 1→8），
  即失败重试，不是 plan/exec 演进。

### 1.5 实测结果

| 指标 | 实测 |
| --- | --- |
| 可构造的 (G_plan, G_exec) 对 | **6**（每个 `task_run` 一对） |
| G_plan 节点数 | 1, 1, 1, 1, 1, 1 |
| G_exec 节点数 | 2, 1, 1, 1, 1, 1 |
| **G_plan 边总数** | **0** |
| **G_exec 边总数** | **0** |
| supersession（单独记录） | 11 |

---

## 2. agent 长程层：G_exec

### 2.1 join key 的正确选择（实测对比）

| 候选 | 闭合率 | 结论 |
| --- | --- | --- |
| `model_executions.codex_thread_id` → rollout 文件名 | **2 / 24 (8.3%)** | 太差，不能做主键 |
| `sessions.id`（= 目录名）→ `codexHomeForSession` → `sessions/` | **6 / 6 (100%)** | **采用** |

`transcripts.js:8 codexSessionJsonlPaths(root, sessionId, threadId)` 走的正是第二条路径。

> 顺带：`model_executions` 里 24 条 `execution_kind='task_node'` 执行中只有 14 条带
> `codex_thread_id`，而其中只有 2 条的 rollout 文件还在磁盘上；
> 反过来 19 个 rollout 里有 **11 个没被任何 `model_executions` 引用**。
> **`model_executions` 与磁盘 rollout 之间存在双向缺失**，这是当前真实数据的现状。

### 2.2 构造规则

把 rollout JSONL 的 turn 序列投影成**链式图**：

| 事件类型 | 是否成节点 | `role` |
| --- | --- | --- |
| `response_item / reasoning` | 是 | `reasoning` |
| `response_item / message` | 是 | `message` |
| `response_item / agent_message` | 是 | `agent_message` |
| `response_item / function_call` | 是 | `function_call:<name>` |
| `response_item / custom_tool_call` | 是 | `custom_tool_call:<name>` |
| `response_item / *_output` | 否（是上一步的结果，不是新步骤） | — |
| `event_msg / *` | 否（遥测，如 `token_count`） | — |
| `inter_agent_communication_metadata` | 否，但**单独计数为交互证据** | — |

边：`turn_i → turn_{i+1}`（顺序链）。节点 `id = "<sessionId>#<seq>"`。

> **顺序链 ≠ 依赖 DAG。** 这是真实执行顺序的投影，不是任务依赖。要得到 DAG，
> 仍需一个「这一步为何必需」的映射规则，**尚未定义**（见第 4 节）。
>
> **2026-09-19 起该映射已定义**：见 [`SEQUENCE_TO_DAG.zh-CN.md`](SEQUENCE_TO_DAG.zh-CN.md)
> （规则 `stepDependencyMapLib.mjs` + 纪律测试 + 真实链形状验证）。定义出来之后的结论是
> **门仍然关着**：真实 rollout 链上可以因果归因的图 **0 / 22**，771 条边全是「假设」。
> 所以第 4 节那条约束**不解除**，只是从「没有定义」变成「有定义、且它说不」。

### 2.3 实测结果

| 指标 | 实测 |
| --- | --- |
| 可构造的 rollout 图 | **19** |
| 节点总数 | **706** |
| **边总数** | **687** |
| 链长分布 | 6, 9, 9, 10, 11, 11, 13, 14, 16, 16, 24, 25, 28, **51, 81, 82, 83, 107, 110** |
| 链长 ≥ 51 的图 | **6** |
| agent 间交互记录 | **25** |
| 原始字节 | 18.2 MB |

**这是本轮唯一已实测「尺度与交互性都够」的长程图源。** 对照 RDMD 训练语料的 16–28 节点：
**19 个图里有 13 个落在或超过这个区间**，另有 6 个显著超过。

> **2026-09-19 复测（同一台机器、同一目录），上面这张表已过期：**
> 22 个 rollout / **792** 节点 / **771** 边 / 链长 p50 **13**、max **180** / 链长 ≥51 仍为 6 个 /
> agent 间交互记录 **0**（当前 22 个文件里 `inter_agent_communication_metadata` 一条都没有）。
>
> - 「长程结构真实存在、尺度够」**不变**（max 从 110 涨到 180）；
> - 「**交互性**也够」这半句的依据**目前不成立**，需要重新实测或撤回；
> - 另有 1 个空图（2 行的 rollout，投影出 0 节点）与 2 个单节点图。
>
> 复测口径与逐图明细见 [`SEQUENCE_TO_DAG.zh-CN.md`](SEQUENCE_TO_DAG.zh-CN.md) §3.1。

---

## 3. 用产品规则跑一次真实对照（**只是诊断**）

`detectMinimalDrift(G_plan, G_exec)` 在 6 对组织层图上：

| task_run | 判定 |
| --- | --- |
| `task_4e1015ef-…` | **`drift` / `local_replan`**，定位 `node_d03c03d1…`（fallback 节点），`contrast.extraNodeIds` 恰好是它 |
| 其余 5 个 | `no_drift` |

读法：

- 只有 **1 / 6** 个真实任务产生任何漂移信号 —— 因为另外 5 个的 G_plan 与 G_exec 节点集相同。
- 那 1 个的信号是**节点新增**（fallback），规则把它判成 `local_replan`。
  这是**正确但信息量很低**的判定：它看见了「多了一个节点」，但**没有边可以归因**，
  所以给不出「级联根」——正是第 1.3 节预言的形态。
- **这不是模型的成绩，也不是规则的成绩**，是**数据结构决定的诊断**。

**边界（必须遵守）**：真实任务**没有注入标答**。上面这张表**不能**读成准确率，
也不能声称「模型/规则在真实任务上正确」。它只说明「这套构造能跑通，且产出形状符合预期」。

---

## 4. 明确的未完成项

1. **长程层没有 G_plan。** 组织层有 plan/exec 但零边；长程层有真实结构但没有「计划」。
   两边都缺一半 —— 这是当前构造最大的缺口。
   > **2026-09-19 收窄**：这句话要分成两半读。长程层确实没有 **uBuddy 规划层**的计划快照
   > （`turn/plan/updated` 那一路）；但 agent **自己**的计划以 `update_plan` 工具调用的形式
   > 真实存在（参数里带 `plan: [{ step, status }]`），实测覆盖 **2 / 22** 个 rollout、3 次调用 / 15 个步骤。
   > 它不能当 G_plan 用（覆盖率太低、语义是 agent 内部待办、节点 id 与执行步不同源），
   > 但它是「长程层将来能不能有 plan 侧」目前唯一的实测线索。见 `SEQUENCE_TO_DAG.zh-CN.md` §3.4。
2. **顺序链 → 依赖 DAG 的映射未定义。** 链式投影会**系统性高估**级联（任何顺序都变成因果）。
   在定义清楚之前，**不得**用长程层链条去训练/评测 RDMD。
   > **2026-09-19 已定义**：`stepDependencyMapLib.mjs`（规则 R0–R3）+
   > `stepDependencyMap.test.mjs`（9 条纪律测试）+ `_probe_chain_to_dag.mjs`（真实链形状验证），
   > 全文见 `SEQUENCE_TO_DAG.zh-CN.md`。
   >
   > **但约束不解除**，因为定义给出的答案是「不能用」：真实链上
   > `causalAttributionReadiness` 对 **22/22** 个图都给否（771 条边全是 `sequence`，0 条证据）；
   > 就算把「提到过同一路径」全认成证据（**上限**诊断），仍有 19/22 个图留着顺序边、
   > 可选归因的图仍为 0，而且边的密度会涨到链条的 **10.6 倍** ——「最小漂移」反而失去唯一候选。
   > `assertNotForTraining` 把这条约束做成了会抛的代码。
3. **`version` / `acceptance` 无语义来源**，填的是常量。若将来要在此数据上重训，必须先解决。
4. **`model_executions` 与 rollout 双向缺失**（第 2.1 节），导致无法把「哪次模型调用产生了哪一步」
   稳定对上。
5. **真值缺失**（研究边界）：真实任务没有注入的凶手标注，所以**只能产出诊断，不能训练、不能声称因果正确**。

---

## 5. 复现

```powershell
cd experiments/rdmd_detective_dataset/ubuddy_recon
node build_gplan_gexec.mjs `
  "$env:USERPROFILE\.janus-test\data\janus.db" `
  "$env:USERPROFILE\.janus-test\data\codex_backend_sessions" `
  _graphs
```

产出：`_graphs/gplan_gexec.json`（全量图）、`_graphs/gplan_gexec_summary.json`（汇总）。
SQLite **全程 `readOnly: true`**，未对用户应用库做任何写入。产出落在 `experiments/` 下（已 gitignore）。

辅助探针（同目录，均可独立运行）：

| 脚本 | 作用 |
| --- | --- |
| `_probe_true_graph.mjs` | 核对 `collaboration_graph_*` 是否存在 |
| `measure_ubuddy_upstream.mjs` | 上游表精确测量 |
| `_sample_revisions.mjs` | `before_json`/`after_json` 真实形状 |
| `_probe_linkage.mjs` | 表结构与 `codex_thread_id` 链路 |
| `_verify_rollout_join.mjs` | `codex_thread_id` join 闭合率（2/24） |
| `_verify_session_dirs.mjs` | session 目录 join 闭合率（6/6） |
| `_probe_chain_to_dag.mjs` | 长程层「顺序链 → 依赖 DAG」形状验证（只读，见 `SEQUENCE_TO_DAG.zh-CN.md`） |
