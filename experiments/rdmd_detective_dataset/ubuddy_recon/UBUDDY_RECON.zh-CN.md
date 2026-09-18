# uBuddy 数据侦察：先量清楚，再决定怎么改

> 相关：`deploy/INTEGRATION.zh-CN.md`（接入契约）、`V3_FULL_REPORT.zh-CN.md` 第 14 节
> 本轮的产出是**证据与决定**，不含适配器、不含 uBuddy 代码改动、不含训练。

## 0. 一句话结论

> **2026-09-16 重大订正：本节原先的「这条路不成立」已撤回。** 详见本节末尾的「订正说明」。
> 订正后的准确结论是：**不是「uBuddy 原生图不成立」，而是「它从未被观测到」** —— 两者证据强度差一个量级。

**（已撤回的原结论，保留以示记录）这条路不成立。** 真实的 uBuddy 数据已经在桌面端 SQLite 库里量到了
（`~/.janus-test`，2.9 GB），七项判定 **1 项 PASS、6 项 FAIL**，而且不是「差一点」——是结构性的：

| 决定性事实 | 实测 | 后果 |
| --- | --- | --- |
| 图规模 | 中位数 **1** 节点，最大 **2**（目标 ≥16） | 没有长程图 |
| 依赖边 | `dependencies_json` **全为 `[]`**；两库 9 个节点、零条边 | **没有 DAG，没有级联** —— RDMD 的任务定义在这层无法成立 |
| 图演进 | 13 个 revision **100% 是 `add_fallback_node`** | 「版本」是失败重试循环，不是 plan/exec 演进 |
| 体量 | 两库合计 **7 个 task_run / 9 个 node** | 无法训练，也无法评测 |
| 富文本 | 逐图全填 **100%** | **唯一 PASS**：散文载体确实存在 |

最关键的一条是我原先**没有预料到**的：**没有任何依赖边**。（原文此处推出「数据里没有这类结构」，
**该推论已被撤回**，理由见下方订正说明。）

---

### 订正说明（2026-09-16，必读）

本轮查明了一个**更靠前的、使整轮测量失去指涉对象**的事实：

> **`collaboration_graph_*` 从未在任何已安装构建中存在过。**

对两个已安装构建的 `app.asar` 做**全量字节搜索**（`Janus` 2026-09-07 00:43，`Janus Test` 2026-09-14 20:35
—— 后者正是测量期间在跑的那个）：

| 符号 | `Janus Test` asar | `Janus` asar |
| --- | --- | --- |
| `migrateDatabase` / `sqlite_master` / `task_nodes` / `task_graph_revisions` | FOUND | FOUND |
| `schema_migrations` | FOUND | FOUND |
| `collaboration_graphs` / `collaboration_graph_nodes` / `collaboration_graph_edges` | **ABSENT** | **ABSENT** |
| `ensureUBuddyCollaborationGraphSchema` | **ABSENT** | **ABSENT** |
| `collaborationGraphStoreMethods` / `projectTaskRunToCollaborationGraph` | **ABSENT** | **ABSENT** |
| `UBUDDY_COLLABORATION_MAX_UBUDDY_DEPTH` | **ABSENT** | **ABSENT** |
| `publishCollaborationGraph`（`runtime.js:1150` 的云发布通路） | **ABSENT** | **ABSENT** |
| `public_summary` | **ABSENT** | **ABSENT** |

并且直接只读打开两个真实库复核：`collaboration_graph_*` 四张表**全部 MISSING**；
`schema_migrations` 里也**没有**协作图迁移 id。这与代码一致 —— 迁移入口
`sqliteMigrations.js:553 ensureUBuddyCollaborationGraphSchema(db)` 确实是无条件调用的，
**只是这些构建里根本没有那个函数**。

**证据强度说明（供复核，避免日后重开这桩判断）。** 上表不是抽样，是**全量字节**搜索：
`Janus Test` 的 `app.asar` = **70,606,971 字节**，`Janus` 的 = **70,452,936 字节**，
均整份读入内存后逐个做字节级 `includes`。两个构建的**每一列都独立实测过**，不是由一份推另一份。

关键是**有对照组**，否则「搜不到」可能只是搜索方法失效：

- **必须为 FOUND 的**（证明扫描确实覆盖了 DB 层与迁移层）：`migrateDatabase`、`sqlite_master`、
  `task_nodes`、`task_graph_revisions`、`schema_migrations` —— **两个构建全部 FOUND** ✓
- **必须为 ABSENT 的**（证明搜索不是「什么都返回 FOUND」）：`public_summary` —— **两个构建全部
  ABSENT** ✓（`public_summary` 是上一轮合成导出脚本自己造出来的字段，并非产品字段；它在 asar 里
  查不到，恰好从反面印证了「上一轮测的不是协作图」）
- 协作图相关 9 个符号（含边表、建表函数、store 方法、深度常量、云发布通路）在两个构建里**全 ABSENT**。

所以结论是「**查了，且方法在对照下有效，确实没有**」，不是「没查到」。
注意 `publishCollaborationGraph` 也 ABSENT：**不只是 DB 层，连桌面端 → 云的协作图发布通路
都不在构建里** —— 这条功能是从上到下整块没进去。

⚠️ **执行记录上的一个坑（不影响结论，但会让你困惑）**：这几个探测脚本的 shell 退出码是
`4294967295`（即 -1）。原因是脚本在**跑完两个目标、结果已全部打印之后**，去读第三个目标
（`WorkBuddy`）时超时被杀 —— 失败发生在**测量之后**，不是测量之中。结论所依据的两份
全量扫描均已完整输出。**不要因为退出码非零就重跑或怀疑上面的表。**

**所以：这些构建有 DB 层，但整块协作图功能一行都没有，它们物理上不可能产出协作图。**
本次侦察实际上**从未观测过** `collaboration_graph_*`，它测的是上游表 `task_nodes` /
`task_graph_revisions`（第 0.0 节已自述）。由此：

1. **「零依赖边」依然成立，但要正确归因。** 投影代码
   `collaborationGraphStoreMethods.js:226-230` 把 `taskNode.dependencies` 逐条写成
   `dependency_of` 边；而 `normalizeTaskNode`（`recordNormalizers.js:356`）把
   `dependencies_json` 解析成它。该列在**两库全量行**（7/7 + 2/2，非抽样）上都是 `[]`，
   所以**即便把协作图投影出来，`dependency_of` 边数也恒为 0** —— 这是**源数据**的属性，
   与缺表无关。这条结论**不依赖**协作图是否落库。
2. **但它只描述 uBuddy 组织层。** 受 `MAX_NODES=8` 与单节点兜底约束的那一层不产依赖边，
   **不等于整张执行图没有长程结构**：agent 接到任务后自行组织的长程步骤落在
   **磁盘上的 Codex rollout JSONL**，不在这两张表里（见第 5.5 节）。
3. **第 4 节的实测数字全部有效**，它们对**所测对象**成立。失效的只是由此推出的
   **结构性结论**：「没有 DAG」「这类结构在数据里不存在」「改上限也到不了」。
4. **根因是部署，不是设计。** 功能代码在仓库里自 2026-08-27（`ca4437f`）即存在，
   但从未进入任何构建 —— 这是**发布/集成缺口**，不是数据形状问题。

### 0.0 证据所在（这条改变了整个侦察的入口）

原计划侦察云端 PostgreSQL 的 `collaboration_graph_*`。实测后发现两件事：

1. **本机 PG 里最大的库只有 ~16.8 MB**（其余是模板库）——基本只有 schema，没有数据；
2. 真实数据在**桌面端 SQLite**：`~/.janus-test/data/janus.db`（2.9 GB，**正在被实时写入**）
   与 `~/.janus/data/janus.db`（1.15 GB）。

而且 `collaboration_graph_*` 表在**两个库里都不存在**（迁移已写好在 `sqliteMigrations.js:553`
且无条件调用，只是运行中的实例是早于该迁移的构建）。所以本次测量是在**上游真实表**
（`task_runs` / `task_nodes` / `task_node_result_versions` / `task_graph_revisions`）上做的，
经由 `export_ubuddy_sqlite_samples.mjs` 映射到同一契约 —— 映射表逐条写在脚本头部，可核对。

顺带一个发现（**2026-09-16 已订正**）：原先写「重启一次桌面应用就会建出 `collaboration_graph_*` 表」，
依据是迁移在 `sqliteMigrations.js:553` 无条件执行。**这条推论是错的**：无条件执行的是
**仓库源码**，而**已安装构建里连这个函数都没有**（全量 asar 字节搜索 ABSENT）。
所以重启**不会**建表 —— 实测两个库在应用重启并持续运行后，四张表仍全部 MISSING。
要建出表，必须**用含该功能的构建重新安装/运行**。

---

### 0.1 原有诊断：昨天的「层不对」只对了一半

uBuddy 里有**两套图**，我昨天只看到其中一套：

- `cloud/src/modules/collaboration/stateGraph.mjs`：节点是**用户**、边是**委派** —— 人事图，与模型无关。
- `collaboration_graph_*`（迁移 094 + `cloud/src/modules/collaboration/collaborationGraph.mjs` + 桌面侧
  `collaborationGraphStoreMethods.js`）：节点 `kind ∈ {root, ubuddy, agent_task}`、`parent_node_id` 成树、
  `title` + `public_summary` 是散文、`collaboration_graph_events` 带递增 `graph_revision` ——
  **这才是与 RDMD 同层的任务步骤树，而且它在活树里端到端存在**。

所以问题不是「uBuddy 没有这一层」，而是**「这一层在真实数据里成不成立」** —— 这正是本轮要量的。
量不出来之前不动任何代码，这份文档把「已经确证的」和「还没量的」严格分开。

### 0.2 证据分级（先看这里）

| 类别 | 内容 | 可引用性 |
| --- | --- | --- |
| **代码级证据** | 表结构、读写通路、字段来源、`depth` 约束 | **可引用**（读的是活代码） |
| **实测数据证据** | 第 4 节的七项测量数值 | **可引用**：`real_janus_sqlite`，证据级 `evidence`（第 4 节） |
| **流水线验证** | 导出/分析器跑通（隔离 PG 实例 + 合成夹具） | 仅证明**工具可用**，**不得当结论** |

第 3 节的数字全部来自**合成夹具**，只用于证明工具行为正确。第 4 节才是真实测量结果。

**一条必须说清的边界**：本次测量读的是 `task_nodes` 等**上游真实表**，
而不是模型将要读的 `collaboration_graph_*` 投影 —— 后者在库里还没被建出来。
所以「富文本 PASS」的准确含义是「**上游存在散文载体**」，
不等于「投影之后仍然可用」（投影由 `collaborationGraphStoreMethods.js` 完成，尚未跑过）。

---

## 1. 诊断的演进：从「层不对」到「量过之后再判」

> 本节保留侦察前的推理链，因为它解释了「为什么要量这七项」。**结论见第 4 节。**

### 1.1 两套图必须分清

| | `stateGraph.mjs` | `collaboration_graph_*` |
| --- | --- | --- |
| 节点是什么 | 用户（`ubuddy:${userId}`） | 任务步骤（`root` / `ubuddy` / `agent_task`） |
| 边是什么 | 委派（`delegates_to`） | 父子 + 依赖（`parent_of` / `dependency_of`） |
| 有散文吗 | 无 | **有**：`title` + `public_summary` |
| 有变更流吗 | 无 | **有**：`collaboration_graph_events.graph_revision` |
| 和 RDMD 同层吗 | 否 | **是** |

我昨天读的是左边那一列，然后得出「层不对」。**那个结论对 `stateGraph.mjs` 成立，但对整个 uBuddy 不成立。**

### 1.2 `collaboration_graph_nodes` 的字段来源（活代码，逐条可核）

来自 `src/main/modules/persistence/infrastructure/collaborationGraphStoreMethods.js`：

| 模型字段 | uBuddy 来源 | 代码位置 |
| --- | --- | --- |
| 散文主体 | `publicSummary ← node.resultSummary`（退化顺序 `resultSummary → waitReason → errorText → objective`） | `publicTaskNodeSummary()` 第 311–313 行 |
| 标题 | `title ← taskNode.title` | 第 211 行 |
| 结构 | `parent_node_id` | store 的 upsert |
| 归属 | `owner_agent_id` | store 的 upsert |
| 状态 | `status` / `progress` | `normalizeCollaborationStatus` |

**关键**：`agent_task` 节点的散文来自**该步的 `resultSummary`** —— 也就是「规则读不懂、模型读得懂」的那一层，
正是 `V3_FULL_REPORT.zh-CN.md` 第 12.4 节里模型相对规则基线的优势所在（真凶仅派生字段可见时，规则 `type` 0.000 / 模型 1.000）。
**uBuddy 里存在这个优势的载体。** 这是这条路线能成立的必要条件，已满足。

### 1.3 但有一个必须先量出来的结构约束

`depth` 被 `CHECK(depth BETWEEN 0 AND 2)` 钉死，且 `agent_task` 恒为 `depth 2`。
所以这套图的形状是**三层树**：`root → ubuddy → N 个 agent_task 叶子`。

而 RDMD 训练语料是 **16–28 节点的长程图**（链式级联为主）。两者**不像**。

- 叶子之间的 `dependency_of` 边可以让级联发生（第 5 项测量专门量它）；
- 但「16–28 步链」与「三层星形 + 若干叶子依赖」不是同一个图族。
- **若叶子数中位数落在 3–8，现有权重基本不可复用**，要走的是「重建图族 + 重训」，那是另一个量级的工作。

这一项（第 1 项测量）是本轮最可能直接判死的一条，所以它排在第一位。

---

## 2. 七项测量与判定矩阵

### 2.1 十一个字段的契约映射（基于真实 schema，非猜测）

| 模型字段 | 来源 | 强度 |
| --- | --- | --- |
| `id` | `collaboration_graph_nodes.node_id` | direct |
| `title` | `collaboration_graph_nodes.title` | direct |
| `role` | **无来源** | missing |
| `agentId` | `collaboration_graph_nodes.owner_agent_id` | direct |
| `version` | `collaboration_graph_nodes.source_revision` | **weak**（是修订计数，不是 `v1`/`_stale` 那种语义版本；当版本号用会静默降分） |
| `acceptance` | **无来源** | missing |
| `artifact` | **无来源** | missing |
| `stage` | **无来源** | missing（≠ `depth`，语义不同） |
| `inputs` | **无来源** | missing |
| `output` | **无来源**（最接近的候选是 `task_node_result_versions.result_text`） | missing |
| `summary` | `collaboration_graph_nodes.public_summary` | direct |

**direct 4 / weak 1 / missing 6。**

这意味着：即使图规模过关，**11 个字段里仍有 6 个没有来源**。而模型的五项富文本
（`artifact/stage/inputs/output/summary`）里只有 `summary` 有对应列。

但注意第 1.2 节：散文主体**存在于 `publicSummary`**，只是被挤进了一个字段。
所以真正的重训契约很可能是「`summary` 承载富文本」，而不是「补齐五个字段」——
这取决于 `resultSummary` 里实际写了多少、什么结构。**这是第 2 项测量要回答的。**

`public_metadata_json` 是自由 jsonb，可能携带 `inputs/output/artifact`。
分析器会实测它的键分布，而不是假定它没有 —— 若关键命中，还要再量它的非空率（只有键名不算证据）。

### 2.2 七项测量

| # | 测量 | 为什么决定性 | 若为空的后果 |
| --- | --- | --- | --- |
| 1 | 每图节点数（分布，非均值） | 训练区间 16–28，而 `depth` 被钉在 0..2 | 叶子数太少 → 现有权重不可复用 |
| 2 | `public_summary` 非空率（**逐节点 + 逐图两个口径**） | 模型优势的唯一载体 | 无载体 → 相对规则无收益 |
| 3 | ≥2 个 `graph_revision` 的图占比；`superseded→adopted` 对占比 | 这就是 plan/exec 对 | 无 before/after → RDMD 的问题在这层不存在 |
| 4 | `decision ∈ {superseded,rejected}` 占比、`decision_reason` 填充率、`event_type` 分布 | 唯一候选标签来源 | 无标签 → 不能训练也不能评测 |
| 5 | 非 root 节点挂父率、悬空父引用、有环图、`dependency_of` 边 | 无 DAG 则「唯一级联根」不成立 | 因果级联不成立，任务定义垮掉 |
| 6 | 11 字段逐个来源 + `public_metadata_json` 键分布 | 产出重训数据契约草案 | 决定要新建多少字段 |
| 7 | 各表总量、有决策的 run 数、有 revision 的 run 数 | 决定能否训练与评测 | 体量不足则无法训练 |

### 2.3 判定矩阵（照抄进分析器的输出，逐项独立判死不采总分）

| 检查 | 通过条件 |
| --- | --- |
| 图规模 | 节点数 **p50 ≥ 16** |
| 富文本 | `public_summary` **逐图全填率 ≥ 0.50** |
| before/after | 存在 ≥2 revision 的图，**且版本类型不单一** |
| 标签 | 存在 `superseded`/`rejected`，或存在失败类事件 |
| 边 | 非 root 节点 **100%** 有父节点、无悬空引用、无环 |
| 字段 | 11 字段中 direct 来源 ≥ 6 |
| 体量 | 图总量 ≥ 1000 |

**「版本类型不单一」这个条件是被实测逼出来的**（第 4.2 节）。只查「有没有 ≥2 个版本」会被
失败重试循环骗过：实测数据里 11 个 revision 全是 `add_fallback_node`，同一个节点被反复重建、
版本号一路涨，形式上满足了「有两个版本」，实质上两个版本之间**没有任何实质差异**。
这正是一个「看起来 PASS、实则空无一物」的假阳性，所以判据必须同时量类型多样性。

三条纪律（已写成机器检查，见 `ubuddy_recon.test.mjs`）：

1. **给分布不给均值。** 图规模常是双峰的，均值会把形状抹平成毫无意义的数字。
2. **baseline 与 top 分开报，并报出差。** 只报 top 等于把天花板当常态。
3. **空分母不许印 0。** 没测到就印 `no data`。把「没测到」显示成「0%」会把人引向
   「数据质量差」这个错误结论，而真相往往是「这一层根本没落库」。

### 2.4 富文本那项的判据为什么用「逐图全填」而不是「逐节点」

部署守卫是**任一节点任一富文本字段为空就拒绝整条输入**（`deploy/rdmd_detective.py` 的
`check_case_contract`）。所以一条图上只要有一个节点没摘要，这条图就进不了训练。

用逐节点率会高估可用数据。合成夹具上这个差距是 **90.9% vs 33.3%** —— 只报前者会得出
「填充率九成、没问题」的结论，而按契约可用率只有三分之一。这个差距正是本项要暴露的东西。

---

## 3. 工具与流水线验证（**合成数据，不是结论**）

新增（不需要 GPU、不需要模型）：

| 文件 | 作用 |
| --- | --- |
| `ubuddy_recon/export_ubuddy_task_samples.mjs` | 从真实 PG 导出两层样本 + 总量，复用仓库既有脱敏 |
| `ubuddy_recon/export_ubuddy_sqlite_samples.mjs` | **实测走通的通路**：从桌面端 `janus.db`（SQLite）导出，产出与 PG 版**相同**的契约 |
| `ubuddy_recon/analyze_recon.mjs` | 七项测量 + 11 字段映射 + 判定矩阵 → `recon_summary.json` + `recon_report.md` |
| `ubuddy_recon/ubuddy_recon.test.mjs` | 把上述三条纪律做成机器检查（6 项，全过） |
| `ubuddy_recon/_verify_schema.sql` | 隔离验证实例的建表（真实 DDL 摘录） |
| `ubuddy_recon/_verify_seed.sql` | 故意做成双峰/半填充的夹具数据 |

**为什么多了一个 SQLite 导出**：原计划的侦察对象（云端 PG）实测是空的，真数据在 SQLite。
SQLite 版**只读**打开（用户真实应用库，任何写入都可能损坏它），且与 PG 版共用同一个分析器
—— 测量逻辑只有一份，不存在「两套口径」。

验证方式：隔离的 PostgreSQL 17 实例（端口 5433），按真实 DDL 建表、灌入双峰夹具，
跑通「导出 → 分析 → 报告」全链路。**刻意把夹具做成有缺陷的**（半数图无摘要、多数图只有
2–6 个节点），否则一个「处处通过」的夹具什么也证明不了。

验证抓到并修掉的三个真实 bug：

| bug | 后果 |
| --- | --- |
| 导出脚本把 `source` 无条件写成 `real_postgres` | 夹具数据会被判为「可引用证据」——正是本轮最该防的错。改为必须由操作者显式声明，未声明即 `unverified_postgres`，分析器拒绝当证据并以非 0 退出 |
| DAG 判据把 `root` 算进「缺父节点」的分母 | 凭空造出 89.6% 的假缺口。修正后非 root 挂父率 100% |
| manifest 带 BOM 时直接 `SyntaxError` 崩溃 | PowerShell 的 `Out-File -Encoding utf8` 会写 BOM，手工导出极易触发。已剥 BOM，且畸形行报出「文件:行号」后 fail-closed 退出 |
| 分析器 before/after 判据只查「≥2 版本」 | **真实数据上假 PASS**：11 个 revision 全是 `add_fallback_node`，是同一节点的失败重试循环，形式上有版本、实质无演进。已加「版本类型不单一」条件（第 4.2 节） |
| SQLite manifest 用源表名而非契约键 | 体量项显示 `no data`，把「6 张图 → FAIL」误报成「没测到」——两者含义完全不同。已补契约键 |

验证结果（**合成夹具，禁止引用**）：0/7 或 3/7 项通过，`evidenceGrade = synthetic_do_not_cite`，
分析器退出码 1 —— 证据分级按设计生效。

---

## 4. 实测结果（**真实数据，可引用**）

来源：`UBUDDY_RECON_SOURCE=real_janus_sqlite`，证据级 `evidence`。

```powershell
# 只读打开桌面端库；导出 → 分析
$env:UBUDDY_RECON_SOURCE='real_janus_sqlite'
node experiments/rdmd_detective_dataset/ubuddy_recon/export_ubuddy_sqlite_samples.mjs `
  "$env:USERPROFILE\.janus-test\data\janus.db" `
  experiments/rdmd_detective_dataset/ubuddy_recon/_real_test
node experiments/rdmd_detective_dataset/ubuddy_recon/analyze_recon.mjs `
  experiments/rdmd_detective_dataset/ubuddy_recon/_real_test
```

### 4.1 判定矩阵（两个库结论一致）

| 检查 | 实测（`~/.janus-test`，2.9 GB） | 结论 |
| --- | --- | --- |
| 图规模 p50 ≥ 16 | p50=**1**, max=2, ≥16 占比 0.0% (0/6) | **FAIL** |
| `public_summary` 逐图全填 ≥ 0.50 | **100.0%** (6/6) 逐图；100.0% (7/7) 逐节点 | **PASS** |
| ≥2 版本 且类型不单一 | 16.7% (1/6) 有 ≥2 版本；但版本类型 **1 种**、单一类型占比 **100.0%** (11/11) | **FAIL** |
| 存在 `superseded`/`rejected` 或失败类事件 | 0.0% (0/4) 决策；0.0% (0/11) 失败类事件 | **FAIL** |
| 非 root 100% 有父节点、无环 | **0.0% (0/7)** 有父节点；dangling=0；环=0 | **FAIL** |
| 11 字段 direct ≥ 6 | direct=**4**, weak=1, missing=**6** | **FAIL** |
| 图总量 ≥ 1000 | **6 张图 / 7 节点** | **FAIL** |

生产库 `~/.janus`（1.15 GB）为 **1 张图 / 2 节点 / 0 边 / 2 个 revision（全 `add_fallback_node`）**，
七项判定逐项一致地 FAIL。两个库合计 **7 个 task_run、9 个 node**。

### 4.2 三条结构性发现（比「数量不够」严重得多）

**(1) 没有任何边（数字有效，结论已订正）。** `task_nodes.dependencies_json` 在**两个库的全部 9 个节点上都是 `[]`**。
所以导出的 `collaboration_graph_edges.jsonl` 是**空文件**。

> **（原结论，已撤回）** 原文由此推出：「没有边就没有级联，没有级联就没有级联根；这不是数据量还不够，
> 而是这类结构在数据里不存在——再等更多数据也不会出现。」
>
> **订正**：这条推论把**上游 `task_nodes` 的依赖列**当成了**整张执行图的边**，二者不是一回事：
>
> - 该结论对 **uBuddy 组织层**成立：这一层受 `MAX_NODES=8` 与单节点兜底约束，确实不产依赖边。
> - 但**整图的长程结构不在这里**。agent 接到 `task_node` 后自行组织的多步长程任务记录在
>   **磁盘上的 Codex rollout JSONL**（`transcripts.js::codexSessionJsonlPaths` → `readCodexVisibleMessages`），
>   不落 `task_nodes` / `task_graph_revisions`。
> - 而且 `collaboration_graph_*` **从未在任何已安装构建中存在**（见第 0 节的订正说明），
>   所以本轮**根本没有观测到**协作图的边，也就没有资格对它的边下结论。
>
> 保留的**有效**部分：「在这 7 个 task_run 上，组织层没有产出任何依赖边」——
> 这是**实测事实**，且经投影代码验证（`dependencies` 是 `dependency_of` 的唯一来源）。

**(2) 「图版本」是失败重试循环。** `task_graph_revisions` 共 13 行（测试 11 + 生产 2），
`revision_type` **100% 是 `add_fallback_node`**。逐行看 `before_json`/`after_json`：
只有 `status`、`attemptCount`、`lastErrorCode` 在变（attemptCount 一路涨到 8），
**没有任何实质字段演进**。这正是第 5.1 节对照表里预告并被证实的那个陷阱。

**(3) 事件流 98% 是噪声。** `task_events` 8116 行里，`delivery_basic_check_failed` 占 **5727 行**
（70.5%），内容是同一个交付校验反复失败（`required_file_type_missing`）；
`node_activity` 再占 2119 行（26%）。真正带信息的失败/重试/重规划事件都在个位数
（`node_failed` 2、`node_cancelled` 10、`node_retry_*` 各 7）。
**「有 8116 个事件」不等于「有 8116 条标签」** —— 只看事件总数会严重高估标签量。

### 4.3 唯一的好消息，以及它的边界

`public_summary`（映射自 `task_nodes.result_summary || objective`）**逐图全填 100%**，
且是**真散文** —— 例如某个节点的 `objective` 是完整的任务目标段落，
`task_node_result_versions.result_text` 是完整的调研报告正文。

也就是说：**「规则读不懂、模型读得懂」的那层载体是真实存在的**（第 1.2 节的判断成立），
这仍然是模型相对规则基线（`detectMinimalDrift`）的优势来源。

但这条好消息**撑不起重训**：载体存在 ≠ 有图可训。图只有 1–2 个节点、没有边、
没有 plan/exec 对、总量 6 张 —— 载体再好，也没有承载它的图族。

### 4.4 隐私与安全

导出物是真实数据，只落在 `experiments/` 下（已 gitignore）。SQLite 全程 **`readOnly: true`** 打开，
未对用户的应用库做任何写入。凭据不进 manifest。

---

## 5. 三种结局，都要如实写

| 结局 | 判定 | 下一步 |
| --- | --- | --- |
| **全绿** | 七项全过 | 走「在 uBuddy 原生字段上重训」，第 2.1 节即数据契约草案 |
| **富文本绿、规模不绿** | 散文载体存在，但叶子数远小于 16–28 | 可以重训，但**必须重建图族**；工作量与产出要重新评估 |
| **载体缺失或没有两个状态** | 富文本/revision 不绿 | **这条路不成立** |

### 5.1 实际落在哪：**第三行（判据本身无效，已撤回）**

**实测 1 PASS / 6 FAIL。** 失败项里包含「边为零」。

> **2026-09-16 订正**：第三行的判据是「载体缺失**或**没有两个状态」。本轮确实测到
> `public_summary` 逐图全填 100%（载体存在），也确实测到 revision 类型单一。
> 但**落在哪一行并不重要** —— 因为**被测对象错了**：
> `collaboration_graph_*` 在**所有已安装构建里都不存在**（第 0 节订正说明），
> 本轮的「图」是从 `task_nodes` 合成的，不是协作图投影。
> 所以这里既不能判「不成立」，也不能判「成立」——只能判**未观测**。
>
> 准确表述：**七项判定对「上游组织层数据」成立；对「协作图」不适用，因为后者从未落库。**

预测与实测的对照（诚实记录我猜错了什么）：

| 我的预测 | 实测 | 对错 |
| --- | --- | --- |
| 富文本大概率绿 | 100% 逐图全填 | **对** |
| 规模大概率不绿（三层树，叶子 3–8） | 更极端：p50=**1** 节点，根本没有三层树 | **方向对，量级猜错** |
| 要警惕 before/after 是「同一状态换游标」 | 13/13 全是失败重试，**完全证实** | **对** |
| —— | **依赖边全为 `[]`** | **完全没预料到**，也是最致命的一条 |

### 5.2 下一步该怎么走（三个选项，都不需要 GPU）

1. **回到规则基线**（`detectMinimalDrift`）：不依赖 uBuddy 数据形状，现在就能用。
2. **等结构产生**：只有当 uBuddy 的执行器开始产出**带 `dependencies_json` 的 DAG**，
   这一层才可能长出可训练的图。这是一条**依赖产品行为改变**的路，不是数据积累问题 ——
   建议先确认「协作执行是否本来就设计成会产生多步依赖」，若设计上就是单步委派，则永远等不到。
3. **回到「恢复 archive 的 plan/lineage 层」这个产品决定**：如果确实需要长程级联图，
   那要改的是产品产出的数据结构，而不是训练管线。

**推荐先做第 2 项的确认**（读代码判断 DAG 是否在设计上会生成），因为它决定选项 2 是否成立；
这个确认成本很低，且能避免把时间花在一条结构上不可能的路上。

### 5.3 已确认：uBuddy **组织层**会不会产生多步依赖？（读代码的答案）

**结论（2026-09-16 缩小范围）：基建会，策略不会，而且有一个 8 节点的硬上限 ——
但这个上限只约束 uBuddy 组织层，不约束 agent 的长程层。**

> **订正**：原文由此推出「5.2 的『等结构产生』这条路可以排除」并进而判死整条路。
> 这是**越界推论**：本节引用的全部证据（`uBuddyTaskGraphPlanner.js`、`scheduler.js:181/197`、
> `createDelegationRuntimeApi.js:4051-4056`）都是关于 **uBuddy 如何把任务拆成节点**，
> 与 **agent 拿到节点后如何自行组织长程步骤**无关。后者不受 `MAX_NODES` 约束。
> 所以本节结论应限定为：「**组织层**不会产多步依赖」。

**证据一：基建完全支持 DAG（可引用）**

| 环节 | 代码位置 | 说明 |
| --- | --- | --- |
| 存储 | `sqliteSchema.js:2146` | `dependencies_json TEXT NOT NULL DEFAULT '[]'` |
| 调度器**真的读它** | `agentAllocationStoreMethods.js:301` | `WHEN json_array_length(dependencies_json)>0 THEN 'pending' ELSE 'ready' END` —— 有依赖就排队等，不是死字段 |
| 规划器校验 | `uBuddyTaskGraphPlanner.js:120,259,274` | 依赖必须指向存在的 `localId`、`assertAcyclic` 查环、`topologicalOrder` 拓扑排序 |

所以「没有边」不是基建缺失。

**证据二：确定性规划器确实会产依赖（`taskGraphPlanner.js`）**

| 路径 | 产出的图 |
| --- | --- |
| 通用 | `main` → `retro`（`retro.dependencies = ['main']`，第 142 行） |
| 带调研 | `research` → `main` → `retro` |
| PPT | `strategy` → `final`（跨部门再多一个 `consistency`） |

**证据三：但真正在跑的是 LLM 规划器，而它被明确要求「用最少的节点」**

- `scheduler.js:181` / `:197`：`modelProposal?.nodes || planTaskGraph(...)` —— **模型提案优先**，
  上面那个会产依赖的确定性规划器只是兜底。
- `uBuddyTaskGraphPlanner.js:31` 的提示词原文：
  `Use the fewest useful nodes: normally 1-4 and never more than ${MAX_NODES}.`
- LLM 失败时的兜底是**硬编码的单节点**、`dependencies: []`
  （`createDelegationRuntimeApi.js:4051-4056`，`localId: 'revision_final'`）。

**两条路都收敛到 1 个节点** —— 实测的「1 节点 / 0 依赖」不是异常，是设计的直接结果。

**证据四（最致命）：`MAX_NODES = 8`**

`uBuddyTaskGraphPlanner.js:7` 定义 `MAX_NODES = 8`，且第 78 行在超过时**直接抛错**
（`uBuddy task graph must contain 1-8 nodes`）。而 RDMD 的训练语料是 **16–28 节点**。

> **即使把提示词全改成「尽量多节点」，uBuddy 也无法产出 RDMD 训练过的图族** ——
> 硬上限差 2–3.5 倍。这不是策略太保守，是**上限本身低于模型的地板**。

### 5.4 结论修正（**已二次撤回**）：不是「改上限也到不了」，而是「从未观测」

> **2026-09-16 撤回首版 5.4。** 首版写「不是『等』，而是『改上限也到不了』」，
> 依据是「`MAX_NODES=8` 硬上限 vs RDMD 语料 16–28 节点，上限低于模型地板」。
> 这个算术没错，但它**只对 uBuddy 组织层成立**，而 RDMD 的 `G_plan`/`G_exec` 要的是
> **整张执行图**（组织层 + agent 长程层）。用一个只约束组织层的上限去否定整图，是**越界**。
> 叠加第 0 节的事实（协作图从未在任何构建中存在），首版的两条处置**均不成立**。

**订正后的结论**：

1. **观测缺口（根因，优先级最高）。** `collaboration_graph_*` 从未被任何已安装构建创建。
   功能代码自 2026-08-27 就在仓库里，却从未进入构建。**在补齐这个部署缺口之前，
   任何关于「uBuddy 原生图能否支撑 RDMD」的判断都缺少观测对象。**
2. **组织层不产依赖边（成立，但范围有限）。** 实测 `dependencies_json` 全 `[]`，
   经投影代码验证这是 `dependency_of` 边的唯一来源。所以**当前这批数据**上，
   组织层确实是单步的。这与第 5.3 节的代码证据一致。
3. **长程结构不在这两张表里（关键）。** agent 的长程多步执行记录在**磁盘 Codex rollout JSONL**。
   如果 RDMD 需要 16–28 步的长程图，**它更应该来自这一层**，而不是组织层。
   这条路径**尚未被侦察过**，不能判死。
4. **因此处置是**：
   - **必做**：先把含协作图功能的构建跑起来，才能观测原生协作图；
   - **同时**：侦察 Codex rollout 的长程结构 —— 这是当前唯一已知能承载长程图的真实数据源；
   - **保留**：规则基线 `detectMinimalDrift` 依然是不依赖数据形状、现在就能用的兜底选项。

「等数据积累」不成立（因为组织层设计上就不产），但**「换到正确的观测层」成立** ——
首版把这两件事混成了一件。

**否定结论同样是有价值的交付**，不为了好看而凑 —— 但**证据不足时的「未观测」必须与
「已证伪」分开写**，这是本轮最贵的一课。

### 5.5 被漏掉的观测层：agent 长程执行在磁盘上（**真实数据，已实测**）

第 5.4 节说「长程结构不在这两张表里」—— 这条**已实测确认**，而且它就在本机磁盘上。

**证据一：Codex rollout JSONL 真实存在。**

| 项 | 实测 |
| --- | --- |
| 文件数 | **21** 个 `rollout-*.jsonl` |
| 总量 | **17.4 MB**（对比：组织层两库合计 7 个 `task_run` / 9 个 `task_node`） |
| 最大单文件 | **5,165 KB**（`session_task_node_dd130d363426741e85eb5ee4d8760a71`，2026-09-14） |
| 路径 | `~/.janus-test/data/codex_backend_sessions/session_*/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| 读取通路 | `src/main/transcripts.js:8 codexSessionJsonlPaths(root, sessionId, threadId)` → `walkJsonl(codexHome/sessions)` |

**证据二：单个 `task_node` 的长程结构（样本 = 上面那个 5,165 KB 的 rollout）**

| 事件类别 | 数量 |
| --- | --- |
| `reasoning`（模型推理步） | **20** |
| `custom_tool_call` / `custom_tool_call_output` | 14 / 14 |
| `function_call` / `function_call_output` | 3 / 3 |
| `message` | 12 |
| `agent_message`（`event_msg`） | 7 |
| `sub_agent_activity` | 1 |
| 其他 | `token_count` 19、`turn_aborted` 1、`patch_apply_end` 1、`task_started` 1、`world_state` 1、`session_meta` 1 |
| **事件行合计** | **103**（另一样本 228 行；四个最大样本均 ≥103） |

**两个决定性的观察：**

1. **尺度够了。** 一个 `task_node` 展开出 **20 步推理 + 17 次工具调用 + 12 条消息**。
   组织层 p50 = **1** 节点，长程层 ≈ **100+** 事件 —— **长程性是真实的，只是长在另一层。**
2. **交互性也存在。** 样本里出现 `send_message` 工具调用、`sub_agent_activity` 事件，
   以及顶层 `inter_agent_communication_metadata`（1–5 条/会话）。
   这正是「agent 接到任务后自行组织**可能存在交互**的长程任务」那一层。

**因此处置要多加一条（优先级最高）：**

> **必须侦察 Codex rollout 层。** 它是当前唯一**已实测存在**、且**尺度与交互性都够**的长程图源。
> RDMD 的 `G_exec` 投影应优先从这一层的 turn 序列构造，而不是从只有 1–2 个节点的组织层构造。

**尚未量的（明确的下一批动作）：**

- rollout 的 turn 序列能否稳定映射成 `G_exec` 的节点/边（`response_item` 有 7 个子类型，映射规则未定）；
- `sessions.codex_thread_id` ↔ rollout 文件是否 100% 可解析（`model_executions` 里的指针）；
- 多 agent 协作时，不同 rollout 如何合成**一张**整图（`inter_agent_communication_metadata` 是候选接缝）；
- 这些 rollout 对应的任务**是否有可判定的「漂移真值」** —— 无真值就只产出诊断，不能训练。

**边界**：以上是**结构证据**，不是「RDMD 在这层可行」的结论。要下那个结论，
需先定义 `G_plan`/`G_exec` 的构造规则并量出可训练样本量。

---

## 6. 明确不做的事

- 不接模型、不改 uBuddy 代码、不动训练。本轮只产出**证据和决定**。
- 不在确认底料存在之前写任何「适配器」—— 那是把猜测固化成代码。
- 不把合成夹具的数字写进任何结论。第 3 节已明确标注为 `synthetic_do_not_cite`。
