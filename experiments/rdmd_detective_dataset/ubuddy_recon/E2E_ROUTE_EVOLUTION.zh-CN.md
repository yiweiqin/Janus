# 端到端接线对照：真实任务 → `routeEvolution`（只记诊断）

> 回答的问题：**「把模型输出接进 `routeEvolution`，跑一次真实任务端到端对照」到底会得到什么。**
> 脚本 `route_evolution_e2e.mjs`，输出 `_e2e/route_evolution_e2e.json`，输入 `C:\Users\zhang\.janus-test\data\janus.db`（只读）。
> 生成时间 2026-09-16，6 个真实 task_run。

> [!IMPORTANT]
> **更正（2026-09-19，实测）**——本文写于 v1 契约下，下面的数字与措辞已部分过时。以
> [`PLAN_EXEC_TRUTH.zh-CN.md`](PLAN_EXEC_TRUTH.zh-CN.md) **§10** 为准：
> - A 段的 **6/6 拒答不再成立**。它现在量的是"**侦察投影缺字段**"（该投影不带 `kind`/`summary`/`output`，
>   节点落进最严兜底档），不是"真实数据缺字段"。按**产品形状投影**实测是 **3/6**，
>   且通过的正是多节点、全部成功的真实群任务。
> - §2 说的"缺 5 个富文本字段"是 v1 的事。v2 按 `kind` 收窄后，残余缺口**只剩一档**：
>   `exec` 侧 `failed`/`cancelled` 节点的 `empty_output`。
> - 表格里 B 段的 "1 `minimal_plan_edit`" 是**投影 bug 造出来的假漂移**（规划侧恒零边）。
>   修掉后 B 段是 **6/6 `no_drift`**。**§3.2 关于"构造产物"的结论方向对，但数字已变。**

---

## 0. 一句话结论

**输出侧的接线是通的，输入侧是断的——而且断得符合设计。**

| 段 | 喂什么 | 结果 | 性质 |
| --- | --- | --- | --- |
| **A** | 真实组织层图 → 模型输入闸门 | **6/6 拒答**（缺 5 个富文本字段），`exit=1` | ✅ 设计行为（fail-closed） |
| **B** | 真实组织层图 → 规则基线 → `routeEvolution` | 1 `minimal_plan_edit` + 5 `record_only` | ⚠️ 那 1 条是**构造产物**，见 §3.2 |
| **C** | **已录真实模型判定**（103 条）→ `routeEvolution` | `record_only 45` / `minimal_plan_edit 46` / `similar_swap 12` | ✅ 接线已验通 |
| **D** | 7 种判定形状全覆盖映射 | 7/7 命中 | ✅ 契约完整 |

**所以：模型本身在真实数据上今天给不出任何东西（上游数据不合格）；但模型一旦给出判定，`routeEvolution` 的消化路径已经被 103 条真实模型输出验证过。**

---

## 1. 为什么必须分三段

「跑一次真实任务端到端」这句里藏着一个不能含糊的问题：**用谁当侦探？** 三个候选的可用性完全不同，混在一起报会得出假结论。

| 候选 | 需要什么输入 | 真实数据上可用吗 |
| --- | --- | --- |
| 训练好的 QLoRA v3 模型 | 11 字段富文本图 | ❌ 缺 5 个富文本字段 → 拒答 |
| 规则基线 `detectMinimalDrift` | 6–7 字段窄图 | ✅ 能跑，但信息量极低（§3.2） |
| 已录模型判定回放 | 只要判定记录 | ✅ 验接线用，不代表真实任务上的表现 |

A 段用**官方守卫**而不是我重写一遍：直接调 `deploy/predict.py --dry-run`（`check_case_contract` 是权威实现，重写就等于把被检验的东西换掉）。

---

## 2. A 段：真实数据过模型输入闸门 → 拒答

```
python deploy/predict.py --input <real_cases.jsonl> --dry-run
exit = 1
stderr: [ERROR] 6/6 cases violate the input contract (missing rich fields)
        -- the model would answer confidently from empty fields
```

6 个真实任务，**每一条**的**每一个节点**都缺这 5 个字段（`artifact` / `stage` / `inputs` / `output` / `summary`），G_star 与 G_prime 都是：

```
G_star:node_11d2e743-...:empty_artifact
G_star:node_11d2e743-...:empty_stage
G_star:node_11d2e743-...:empty_inputs
G_star:node_11d2e743-...:empty_output
G_star:node_11d2e743-...:empty_summary
G_prime:node_11d2e743-...:empty_artifact
... (G_prime 同 5 条，含 fallback 节点共 15 条/任务)
```

### 2.1 这是设计行为，不是 bug

`rdmd_detective.py` 的注释写得很清楚，这里如实复述：

> 必须 fail-closed：`public_graph` 会把缺失字段归一成空字符串，于是 prompt **照常构建成功**、`validate_verdict` **照常返回空警告**，模型照样给一个自信的判定 —— 只是那个判定不再代表任何已测得的准确率。这是最隐蔽的一种降级。

判据来自语料测量而非估计：在 10,332 张图 / 207,356 个节点实例上，这 5 个字段**没有一个为空**（0/207356）。所以「任一节点任一字段为空」＝落在训练支持集之外，而这个守卫在那批语料上**不可能误伤**。

### 2.2 闸门之后会发生什么

拒答 → 模型侧等价于**空判定**（`status=UNKNOWN`）。喂进 `routeEvolution`：

```
{ status: 'UNKNOWN', nodeId: '', edgeId: '', type: '', evidenceNodeIds: [] }
  -> { action: 'record_only', reason: 'unknown_drift' }
```

**即：真实数据今天走完整链路，终点是一个 `record_only`，不写任何组织策略。** 这是正确行为——不确定就不要改产品。

### 2.3 顺带发现：连官方自带的 uBuddy 形状样例也过不了闸门

`data/ubuddy_shaped_cases.jsonl` 是仓库里已有的「uBuddy 形状」样例（`intake/research/write` 三节点），字段同样只有 `id/title/agentId/version/acceptance/role/status` —— **5 个富文本字段一个都没有**，所以它同样会被拒。

这说明缺口不是「真实数据没导出对」，而是**uBuddy 侧的图投影本来就不含模型需要的字段**。上一轮把 `public_summary`（`result_summary || objective`）当富文本来源的思路方向对，但它**没有进 `normalizeTaskGraph` 的投影**——投影只有 `id/title/agentId/version/acceptance/role/status`。

---

## 3. B 段：真实数据过规则基线 → 1 条 drift（必须打星号）

规则基线吃窄字段，所以能出判定：

| task_run | G_plan 节点 | G_exec 节点 | 判定 | 动作 |
| --- | --- | --- | --- | --- |
| `task_4e1015ef` | 1 | 2 | `drift` / `local_replan` / `node_d03c03d1…` | `minimal_plan_edit` |
| `task_1a8c7a0b` | 1 | 1 | `no_drift` | `record_only` |
| `task_a16f57dd` | 1 | 1 | `no_drift` | `record_only` |
| `task_6ce70b9f` | 1 | 1 | `no_drift` | `record_only` |
| `task_7270b516` | 1 | 1 | `no_drift` | `record_only` |
| `task_30a1a3fc` | 1 | 1 | `no_drift` | `record_only` |

汇总：`{ minimal_plan_edit: 1, record_only: 5 }`。

### 3.1 唯一那条 drift 是「fallback 节点」

`task_4e1015ef` 的 G_plan 是被排除掉 fallback 的 1 个节点，G_exec 是 2 个节点（原节点 `status=failed` + `Fallback: …` `status=completed`）。规则看到 exec 多出一个节点 → `extraNodeIds` → `local_replan`。

### 3.2 ⚠️ 这条判定**不含独立信息**，必须明说

G_plan 的定义就是「`task_nodes` 减去由 revision 引入的 fallback 节点」（见 `G_PLAN_G_EXEC.zh-CN.md §1`）。也就是说：

> **「G_exec 比 G_plan 多一个节点」这件事是构造规则的直接推论，不是从数据里发现的东西。**

规则在这里等于把构造时的假设又念了一遍。**不能把这条报成「规则基线在真实任务上成功发现了漂移」。**

正确读法：这条恰好说明「fallback 是本数据集里唯一可被窄图表达的图变更形态」，而不是说明检测能力。

### 3.3 更值得注意的：规则对 3 个「明确没按计划走」的任务判了 `no_drift`

| task_run | G_exec 节点状态 | 规则判定 | 问题 |
| --- | --- | --- | --- |
| `task_1a8c7a0b` | `failed` | `no_drift` | ⚠️ 任务失败了 |
| `task_7270b516` | `cancelled` | `no_drift` | ⚠️ 任务被取消 |
| `task_30a1a3fc` | `cancelled` | `no_drift` | ⚠️ 任务被取消 |

原因很直白：`classifyDrift` / `contrastDriftGraphs` 只比 `{id, agentId, version, acceptance}`，

- `status`（`completed/failed/cancelled`）**不在比较范围**，
- `version` 被投影成常量 `v1`（真实库没有语义版本列），
- `acceptance` 被投影成常量 `standard`。

于是这三条**在真实数据里唯一存在的、有语义的差异（执行结局）恰好落在检测器看不见的地方**。

> **这是本轮最有用的一条诊断：窄图投影把真实数据里唯一有信号的那个字段（`status`）丢掉了，同时把两个没有信号的字段（`version`/`acceptance`）补成了常量。**

它同时解释了为什么「在 6–7 字段投影上重训」预期无收益（`INTEGRATION.zh-CN.md` 的 B 路）：不是模型不够强，是**投影把信号删了**。

---

## 4. C 段：已录真实模型判定回放 → 接线验通

用验收阶段留下的**真实模型输出**（`ood_verdicts.jsonl` 43 条 + `adv_verdicts.jsonl` 60 条 = **103 条，全部 `valid=true`**）逐条喂 `routeEvolution`：

| 维度 | 分布 |
| --- | --- |
| status | `no_drift 16` / `UNKNOWN 29` / `drift 58` |
| type | `(空) 45` / `missing_dependency 42` / `wrong_agent 12` / `wrong_version 2` / `wrong_acceptance 2` |
| **动作** | **`record_only 45` / `minimal_plan_edit 46` / `similar_swap 12`** |
| 动作原因 | `no_drift 16` / `unknown_drift 29` / `missing_dependency 42` / `wrong_agent 12` / `wrong_version 2` / `wrong_acceptance 2` |

一致性自检：`16+29=45`（`record_only`）✓，`42+2+2=46`（`minimal_plan_edit`）✓，`12`（`similar_swap`）✓。三路动作与判定类型一一对上，**没有落空的判定形状**。

这一段的效力边界：它证明的是**「模型输出 → 路由动作」这段接线是通的、无形状错配**，**不是**模型在真实任务上的准确率（这些判定来自合成 OOD/对抗集）。

---

## 5. D 段：判定形状 → 动作的完整映射（接线契约）

| 模型 `status` | 模型 `type` | `routeEvolution` 动作 | 原因 |
| --- | --- | --- | --- |
| `no_drift` | — | `record_only` | `no_drift` |
| `UNKNOWN` | — | `record_only` | `unknown_drift` |
| `drift` | `wrong_agent` | `similar_swap` | `wrong_agent`（带 `swapDecision`） |
| `drift` | `missing_dependency` | `minimal_plan_edit` | `missing_dependency` |
| `drift` | `wrong_version` | `minimal_plan_edit` | `wrong_version` |
| `drift` | `wrong_acceptance` | `minimal_plan_edit` | `wrong_acceptance` |
| `drift` | `local_replan` | `minimal_plan_edit` | `local_replan` |

`wrong_agent` 分支额外验证了 swap 决策透传：`routeEvolution(v, {decision:'replace'})` → `{action:'similar_swap', swapDecision:'replace'}`，默认未传时为 `'pending'`。

**覆盖完整：模型能吐的 7 种形状全部有确定动作，无 `undefined`。**

---

## 6. 产品侧现状（如实）：契约有，调用点无

在 `src/` 下 grep `routeEvolution`：

- 定义：[`src/shared/contracts/uBuddyReverseDetective.js`](../../../src/shared/contracts/uBuddyReverseDetective.js) 第 156 行
- 单元测试：[`src/shared/contracts/uBuddyReverseDetective.test.js`](../../../src/shared/contracts/uBuddyReverseDetective.test.js) 第 77–79 行
- **`src/main/**` 下没有任何调用点。**

所以准确说法是：**接线点在契约层已存在且行为完整，产品运行时尚未挂上。** 这与 `INTEGRATION.zh-CN.md §「输出侧已对齐」`不矛盾——那里的意思是「形状对齐、不需要改产品代码去适配模型」，而不是「已经接上了」。

---

## 7. 边界（不声称）

- 真实任务**没有标答**。训练是注入式监督（`injectMinimalDrift`，凶手手法已知）；真实数据里没有「谁是真凶」的 ground truth。
- 本报告只记**诊断**与**路由动作**，**不声称**模型在真实任务上因果正确。
- B 段那条 `local_replan` **不构成**模型/规则的有效性证据（§3.2）。
- **不声称**生产自进化已验证。
- C 段 103 条的效力仅限于「接线通」（§4）。

---

## 8. 复现

```bash
cd Janus/experiments/rdmd_detective_dataset/ubuddy_recon
node route_evolution_e2e.mjs <path-to-janus.db> [out-dir]
# 产物：_e2e/real_cases.jsonl 、 _e2e/route_evolution_e2e.json
```

（`real_cases.jsonl` 是从真实库投影出的模型输入，可直接 `python ../../deploy/predict.py --input real_cases.jsonl --dry-run` 手工复验闸门。）

---

## 9. 对下一步的含义

1. **模型侧在真实数据上无事可做**，直到 uBuddy 的图投影能把 `artifact/stage/inputs/output/summary` 填出来。这是**产品侧的数据供给问题**，不是模型问题。
2. **投影必须补 `status`**。§3.3 显示：真实数据里唯一有信号的字段被丢掉了。补进去以后规则基线的表现才会开始反映真实差异；而按 v3 第 12.4 节的测量，**派生字段（含 `status` 类信息）恰好是模型相对规则基线的全部优势来源**（真凶身上无任何标记时：规则 type 0.000 / 模型 1.000）。
3. **接线的下一刀在「谁调用 `routeEvolution`」**，而不在动作映射——映射已经 7/7 闭合。
4. 真实数据要走到「有标答的对照」，只能靠**轨迹回放**（`task_graph_revisions` 的 before/after 天然是注入式监督的现实版本），或者等协作图与 agent 长程层落库。见 `G_PLAN_G_EXEC.zh-CN.md §4`。
