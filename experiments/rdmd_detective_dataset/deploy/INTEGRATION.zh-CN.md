# 接入契约：RDMD 反向侦探 → uBuddy

> 适用产物：`deploy/`（`rdmd_detective.py` + `predict.py` + `qlora-v3` adapter）
> 相关：`README.zh-CN.md`（用法）、`V3_FULL_REPORT.zh-CN.md` 第 11–14 节（成绩与边界）、
> `ubuddy_recon/UBUDDY_RECON.zh-CN.md`（**数据侦察：上游到底有什么**）
> 结论日期依据：第 14 节；判据来自语料测量，不是估计。
> **2026-09-15 订正**：§0 / §2 / §5 已按「uBuddy 有两套图」重写。原先把 `normalizeTaskGraph`
> 当成 uBuddy 唯一的任务图，据此断定「层不对」，那只对公开记忆投影成立，对整个数据层不成立。

## 0. 一句话结论

**不能直接接入。** 模型本身达标，但**产品的公开记忆投影**（`normalizeTaskGraph`）和模型要求的
富节点不是同一个东西：它缺 5 个富文本字段，而那 5 个字段正是模型相对规则基线的**全部**优势所在。

输出侧是对齐的（`routeEvolution` 正好消费模型的 `{status, type}`），**缺口只在上游数据**。

> **2026-09-15 订正（重要）**：本节原先写成「uBuddy 的任务图缺 5 个字段」，把 `normalizeTaskGraph`
> 当成了 uBuddy 唯一的任务图。**这是错的** —— uBuddy 里有**两套图**，`normalizeTaskGraph` 只是
> 面向公开记忆的**窄投影**，活树里还有更丰富的 `collaboration_graph_*`（见 §2.1）。
> 所以「缺 5 个字段」是**投影层**的事实，不是 uBuddy 数据层的事实。
>
> **2026-09-16 二次订正（覆盖上一条的最后一段）**：上一条说「数据层到底有多少可用，
> 已由 UBUDDY_RECON 实测完成：七项判定 1 PASS / 6 FAIL，**路 A 不成立**」——
> **这个「路 A 不成立」已撤回**。本轮查明：`collaboration_graph_*` **从未在任何已安装构建中存在**
> （两个构建的 `app.asar` 全量字节搜索：`collaboration_graphs` / `ensureUBuddyCollaborationGraphSchema` /
> `collaborationGraphStoreMethods` 全部 **ABSENT**，而 `migrateDatabase` / `task_nodes` /
> `task_graph_revisions` 全部 FOUND；两个真实库中四张表全部 MISSING）。
> **因此那次实测从未观测过协作图**，它测的是上游 `task_nodes` 合成物。
> 正确表述是：**路 A 从未被观测，而不是已被证伪**。完整订正见
> `ubuddy_recon/UBUDDY_RECON.zh-CN.md` 第 0 节与第 5.4–5.5 节。
> **§5 已按此重写，§2 的判断仍只能算待验证的假设。**

## 1. 输入契约：模型要吃「富节点」

模型的公开投影（`public_graph`）逐节点需要 **11 个字段**：

```text
id, title, role, agentId, version, acceptance,      ← 6 个结构字段
artifact, stage, inputs, output, summary            ← 5 个富文本字段（RICH_NODE_FIELDS）
```

**这 5 个富文本字段不是装饰，是契约的一部分。** 依据：第 12.4 节那格「真凶仅派生字段可见」
（真凶在 `inputs/agentId/version/acceptance` 上毫无变化，只能从 `artifact/output/summary` 的
涟漪反推）—— 规则基线判 `type` 的准确率是 **0.000**，模型 **1.000**。模型的核心卖点就住在这 5 个字段里。

### 判据是从语料量出来的

| 盘 | 图数 | 节点实例 | 5 字段为空 |
| --- | --- | --- | --- |
| train | 8,465 | 169,300 | **0** |
| test | 1,764 | 35,280 | **0** |
| ood | 43 | 1,576 | **0** |
| adversarial | 60 | 1,200 | **0** |
| **合计** | **10,332** | **207,356** | **0 / 207,356** |

所以在**这批语料上 0 例外**。守卫因此可以判得很严而**不可能误伤合法输入**
（`test_rdmd_detective.py::test_legal_corpus_rows_are_never_rejected` 每次跑测试都会在真实盘上复核这一点）。

> 判据的范围必须和证据的范围一致：只检查这 5 个字段，**不**检查 `title/role`
> —— 后者的空值没有被测量过，把没量过的字段写进守卫就会误伤，**会误伤的守卫比没有守卫更糟**。

## 2. 缺口在哪一层（2026-09-15 订正）

### 2.1 先分清两套图

| | `normalizeTaskGraph`（公开记忆投影） | `collaboration_graph_nodes`（协作图） |
| --- | --- | --- |
| 位置 | `src/shared/contracts/uBuddyTaskPublicMemory.js` | 迁移 `094_ubuddy_collaboration_graph.sql`；`cloud/src/modules/collaboration/collaborationGraph.mjs` |
| 节点是什么 | 任务节点的**窄投影** | 任务步骤（`kind ∈ {root, ubuddy, agent_task}`，`depth ≤ 2`） |
| 字段 | `id, title, agentId, version, acceptance, role, status` | 上述 + **`public_summary`** + `parent_node_id` + `owner_agent_id` + `progress` + `source_revision` |
| 散文 | **无** | **有**：`title` + `public_summary` |
| 变更流 | 无 | **有**：`collaboration_graph_events.graph_revision` |
| 活写入通路 | — | **源码有，部署无**：桌面侧 `collaborationGraphStoreMethods.js` → `runtime.js:1150` 发布 → `POST /api/collaboration/graph`。**2026-09-16 订正**：这条通路**从未在任何已安装构建中部署过**（见 §0 二次订正），所以「活写入」目前只是源码状态，不是运行状态 |

**关键的一行**：`agent_task` 节点的 `public_summary` 取自该步的 **`resultSummary`**
（`publicTaskNodeSummary()`：`resultSummary → waitReason → errorText → objective` 退化）。
也就是说，「规则读不懂、模型读得懂」的那层散文在协作图里**有真实载体**。

### 2.2 逐字段映射（基于真实 schema）

| 模型字段 | 协作图来源 | 强度 |
| --- | --- | --- |
| `id` | `node_id` | direct |
| `title` | `title` | direct |
| `agentId` | `owner_agent_id` | direct |
| `summary` | `public_summary` | direct |
| `version` | `source_revision` | **weak**（修订计数，非语义版本） |
| `role` | — | missing |
| `acceptance` | — | missing |
| `artifact` | — | missing |
| `stage` | — | missing |
| `inputs` | — | missing |
| `output` | — | missing（最接近的是 `task_node_result_versions.result_text`） |

**direct 4 / weak 1 / missing 6。** 但「missing」要读成「**没有专属列**」，不是「没有内容」——
散文主体被挤进了 `public_summary` 一个字段里。所以可行的重训契约很可能是
「`summary` 承载富文本」，而不是「补齐五个字段」。这取决于 `resultSummary` 实际写了多少。

### 2.3 还有一条必须先量出来的结构约束

`depth` 被 `CHECK(depth BETWEEN 0 AND 2)` 钉死，`agent_task` 恒为 `depth 2` ——
协作图是**三层树**（`root → ubuddy → N 个叶子`），而 RDMD 训练语料是 **16–28 节点长程图**。
两者不像。叶子之间的 `dependency_of` 边能让级联发生，但图族不同。
**若叶子数中位数落在 3–8，现有权重基本不可复用。**

> **2026-09-16 补充（重要）**：本节说的是**协作图（组织层）**的形状，**不是整张执行图的形状**。
> 用户已明确：整张图由 uBuddy 与 agents **共同**完成，agent 接到 `task_node` 后自行组织的
> 长程任务**不受** `depth ≤ 2` 约束。已实测该层真实存在且尺度足够：
> 单个 `task_node` 的 Codex rollout 展开出 **20 步推理 + 17 次工具调用 + 12 条消息 ≈ 103 事件行**
> （样本最高 228），并含 `send_message` / `sub_agent_activity` / `inter_agent_communication_metadata`
> 等交互证据 —— 见 `ubuddy_recon/UBUDDY_RECON.zh-CN.md` 第 5.5 节。
> **所以「16–28 步的长程图」应该到 agent 长程层去找，而不是在协作图上找。**

### 2.4 原先那张「6–7 字段」的表

| | 字段 |
| --- | --- |
| `normalizeTaskGraph`（公开记忆投影） | `id, title, agentId, version, acceptance, role, status`（7 个） |
| 产品侧 RDMD 契约（`normalizeDriftGraph`） | 同上但**丢掉 `status`**（6 个） |
| **模型需要** | 11 个 |

复现（无需 GPU）：

```bash
node experiments/rdmd_detective_dataset/ubuddy_contract_probe.mjs
```

要点：

- 产品的 `contrastDriftGraphs` 只比 `title/agentId/version/acceptance` + 边。
  实测一个**只在 `inputs/output/summary` 上的改动 → `detectMinimalDrift` 判 `no_drift`**
  —— 产品规则对这类变化是**瞎的**。
- 产品侧那个模块（`src/shared/contracts/uBuddyReverseDetective.js`，V4 阶段 3）目前
  **没有任何产品运行时调用点** —— 引用它的只有实验脚本与它自己的测试。也就是说，**连规则版都还没接进流程**。
- 这一节的所有结论都建立在「输入是这份 6–7 字段投影」上。**若改从协作图取数（§2.1），
  本节关于缺口的判断需要重做** —— 这正是 `ubuddy_recon` 要做的事。

## 3. 失败模式：如果不加守卫，是**静默降级**（最坏那种）

`public_graph` 会把缺失字段归一成**空字符串**，于是链条全绿：

```bash
python experiments/rdmd_detective_dataset/ubuddy_model_probe.py
```

```text
node: {... "artifact":"", "stage":"", "inputs":"", "output":"", "summary":""}
prompt chars: 1793          ← 训练时是 11221–13016（短 6 倍）
validate_verdict: []        ← 空警告
```

**prompt 照常构建、判定照常通过校验、模型照常给一个自信的答案。**
没有任何运行时症状，但那个答案不再代表任何已测得的准确率。

这一点值得单独强调：`validate_verdict` **不能**替代输入守卫 ——
它只检查 `nodeId` 是否真的出现在图里（防幻觉），**从不检查输入是否够丰富**。

## 4. 已实现的 fail-closed 守卫

见 `rdmd_detective.py::check_case_contract`，挂在 `build_case_prompt` 这个**唯一咽喉**上
（`Detective` 也绕不过去）。

| 入口 | 行为 |
| --- | --- |
| `check_case_contract(case)` | 返回问题列表（空 = 可推理），逐节点检查 5 个富文本字段 |
| `build_case_prompt(case)` | 有问题就抛 `InputContractError`（**不**拼出空字段 prompt） |
| `predict.py --dry-run` | 把问题**报出来**并 **exit 1**（这就是「验契约」模式） |
| `predict.py` 正式推理 | 每条**先查契约再决定是否推理**，不合格 → `valid=false` + 警告，**不占用 GPU** |

不合格记录的形状：

```json
{"id":"...","verdict":{"status":"UNKNOWN","nodeId":"","edgeId":"","type":"","evidenceNodeIds":[]},
 "raw":"","valid":false,
 "warnings":["input_contract_violation:G_star:intake:empty_artifact;...(+27 more)"]}
```

- 前缀 `input_contract_violation:` 是给流水线分流用的，和 `inference_error:`（运行时故障）区分开
  —— 两者修法完全不同。
- 问题列表**封顶**（`summarize_contract_problems`）：一根 20 节点图缺 5 字段会产生 200 条，
  全塞进记录会把输出文件撑爆。

复现：

```bash
python experiments/rdmd_detective_dataset/ubuddy_model_probe.py \
    --emit experiments/rdmd_detective_dataset/data/ubuddy_shaped_cases.jsonl
python experiments/rdmd_detective_dataset/deploy/predict.py \
    --input experiments/rdmd_detective_dataset/data/ubuddy_shaped_cases.jsonl --dry-run
# -> [ERROR] 2/2 cases violate the input contract ... exit 1
```

## 5. 四条路（**2026-09-16 二次重排**）

> **上一版（2026-09-15）在这里写了「实测已完成，结论是否定的」，判定路 A 不成立。该判定已撤回。**
> 撤回理由：`collaboration_graph_*` **从未在任何已安装构建中存在**，那次实测测的是上游合成物，
> 不是协作图。详见 `ubuddy_recon/UBUDDY_RECON.zh-CN.md` 第 0 节订正说明。
>
> **仍然有效的实测数字**（对**所测对象**成立，保留）：`dependencies_json` 两库全量 9 节点皆 `[]`；
> 图规模 p50=1 / max=2；13 个 revision **100%** `add_fallback_node`；两库合计 **7 个 `task_run` / 9 个 `task_node`**。
> **失效的**：由这些数字推出的「这类结构在数据里不存在」「上限 8 < 地板 16 所以到不了」。

| 路 | 做法 | 判断（2026-09-16） |
| --- | --- | --- |
| **A** | 从**协作图**取数（`collaboration_graph_*`，含 `public_summary`），在 uBuddy 原生字段上重训 | **未观测，不能判死。** 前提缺口在**部署**：功能代码自 2026-08-27 在仓库里，但从未进入任何构建。要评这条路，必须先用**含该功能的构建**跑起来并产生数据。已知的**有效**约束只有一条：该投影的 `depth ≤ 2`（`root → ubuddy → N 个 agent_task`），且 `dependency_of` 边只来自 `dependencies_json`（实测为全 `[]`）→ **组织层成图是三层树 + 零依赖边** |
| **A′（新增）** | 从 **agent 长程层**（磁盘 Codex rollout JSONL）投影 `G_exec` | **当前最值得做的方向。** 已实测：21 个 `rollout-*.jsonl`、**17.4 MB**；单 `task_node` 展开 **20 步推理 + 17 次工具调用 + 12 条消息 ≈ 103 事件行**（样本最高 228）；并含 `send_message` / `sub_agent_activity` / `inter_agent_communication_metadata` 等**交互证据**。**这是唯一已实测同时具备「尺度」与「交互性」的长程图源** |
| **B** | 在 `normalizeTaskGraph` 的 6–7 字段投影上重训 | **预期无收益**（未变）：模型那时能读的信息和 `detectMinimalDrift` 完全一样，而规则在同一输入上本来就接近满分 |
| **C** | 不接模型，先用 `detectMinimalDrift` | **兜底项**（未变）：不依赖数据形状，现在就能用。需要接受它在派生字段上判 `type` 为 0.000，以及它是规则而非学习件 |

**上一版那段「路 A 不是『数据还不够多』，而是『这类结构在数据里不存在』……上限（8）低于模型的地板（16），
所以『等数据』这条路可以排除」—— 整段撤回。** 它犯了两个越界：

1. 把**从未落库的协作图**当成已观测对象；
2. 把只约束 **uBuddy 组织层**的 `MAX_NODES=8`，当成对**整张执行图**的上限。
   用户已明确指出：**整张图由 uBuddy 与 agents 共同完成**，agent 自行组织的长程任务不受该上限约束。

正确表述：**「组织层不产依赖边」成立且范围有限；「整图没有长程结构」不成立** ——
长程结构在 Codex rollout 层，已实测存在（见 A′ 与 `UBUDDY_RECON` 第 5.5 节）。

**动作次序建议**：

1. **先侦察 A′**（Codex rollout）：定义 turn 序列 → `G_exec` 的映射规则，量可训练样本量与真值可得性。
   不需要 GPU，也不需要等产品改动。
2. **并行补齐 A 的部署前提**：用含协作图功能的构建跑真实任务，才能观测原生协作图。
3. **C 保持可用**：在任何 A/A′ 结论落地前，它是唯一现在就能跑的产品侧选项。

在确认底料存在之前**不要写适配器** —— 这条纪律**仍然有效**（本轮已产出侦察工具，但**没有**产出任何适配器）。

**若将来 A 或 A′ 重启，仍需注意**：富文本字段必须**有真实内容**。填占位符/空串会被守卫拒绝（这正是它的用途），
而填没有信息量的模板文本会重新造出第 12 节那种「位置捷径」问题 —— 关键在每个节点带**可区分**的产出描述。
另注意协作图里的 `root` / `ubuddy` 节点带的是**常量摘要**（`'uBuddy 正在组织协作任务。'`），
只有 `agent_task` 叶子的 `publicSummary` 才是真正的步骤产出 —— 这一点会被富文本填充率的下限拉低，
分析器因此同时报「逐节点」与「逐图全填」两个口径。

## 6. 接之前必须知道的模型边界

1. **多原因场景模型比规则差。** 第 13 节：两条原因、其中一条仅派生字段可见时，
   模型弃权率 **0.833**（Wilson 95% CI [0.66, 0.93]），规则 **1.000**。
   失败机制 5/5 一致：看见一个可见的原因字段就当成唯一凶手，忽略只在派生字段留痕的第二条原因。
   **产品规则在「多于一个级联根」时返回 `UNKNOWN`，比模型更安全。**
2. **单原因 + 派生可见是模型的强项**（1.000 vs 基线 `type` 0.000，第 12.4 节）。
   所以选 A 换来的是**这一格**的能力，别处未必更好。
3. **规模/形状/长度不是瓶颈**：16→80 节点、4 种未见形状、prompt 5 倍于训练长度均不散架（第 12 节）。
4. **天花板由定义决定**：这些盘上定位上限是 1.000，模型不可能超过。

## 7. 输出侧：不用改

模型输出 `{status, nodeId, edgeId, type, evidenceNodeIds}`，而产品 `routeEvolution()`
正好消费 `{status, type}`，5 个 type 枚举与 `RDMD_DRIFT_TYPES` 完全一致：

| 模型 status / type | `routeEvolution` 动作 |
| --- | --- |
| `no_drift` | `record_only` / `no_drift` |
| `UNKNOWN` 或无 type | `record_only` / `unknown_drift` |
| `wrong_agent` | `similar_swap` |
| 其余 type | `minimal_plan_edit` |

**所以下游接口零改动，缺的只是上游数据。**

## 8. 验证清单（接入前后各跑一遍）

```bash
# 交付契约（含守卫不得误伤真数据） 29 项
python -m unittest discover -s experiments/rdmd_detective_dataset/deploy \
    -t experiments/rdmd_detective_dataset/deploy -p "test_*.py"

# 跨模块契约对照（产品侧 + 模型侧，无需 GPU）
node   experiments/rdmd_detective_dataset/ubuddy_contract_probe.mjs
python experiments/rdmd_detective_dataset/ubuddy_model_probe.py

# 接入后的真实输入必须 dry-run 通过（exit 0）；不通过就是缺字段，不要放行
python experiments/rdmd_detective_dataset/deploy/predict.py --input <你的cases> --dry-run
```

最后一条应当进 CI：**它把「静默降级」变成「显式失败」**，这是本次改动的主要目的。
