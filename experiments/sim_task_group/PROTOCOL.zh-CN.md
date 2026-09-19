# 模拟任务群协议（v1，2026-09-19）

这份文档定稿「用 LLM 在盒子上自动模拟一个真实任务群」的**简报、角色分配、漂移注入与 gold 格式**。
机器可读的那一份是 `lib/protocol.mjs`，两者必须一致 —— `protocol.test.mjs` 负责把不一致变成红色。

---

## 0. 一句话

**不发明任何新词表。** 漂移词表照抄 `experiments/rdmd_detective_dataset/schema.json`，
角色库照抄 `experiments/cpdb_org_world/data/full/`。模拟群任务是**这两套既有真相源的第一个消费者**，
不是第三个平行世界。

理由很直接：如果模拟器自己发明一套漂移类型，那么「模拟群任务判定全对」什么也不说明 ——
它证明的是一个**不存在的系统**能跑。而这一步的全部价值，恰恰是让盒子上那条真链
（`/api/rdmd/jobs` → GPU worker → verdict）见到**形状与训练时一致**的输入。

---

## 1. 复用关系（谁是谁的真相源）

| 模拟器需要的东西 | 真相源 | 文件 |
| --- | --- | --- |
| 5 类漂移、gold 字段、节点字段/状态/层、`minHopToFirstEffect`、禁词 | rdmd 语料契约 | `rdmd_detective_dataset/schema.json` |
| 每种漂移能落在哪一层、动哪个字段、step 层缺哪几种 | rdmd 语料形态目录 | `rdmd_detective_dataset/lib/forms.mjs` |
| 传播口径（hop 1–2 不许改）与 gold 的实际写法 | rdmd 语料生成器 | `rdmd_detective_dataset/generate.mjs` |
| 600 个 specialist、120 个 uBuddy、职能/细节能力/近邻 twin | CPDB 世界 | `cpdb_org_world/data/full/{agents,people}.jsonl` |
| 6 个职能族的产出/消费（依赖分的来源） | CPDB 目录 | `cpdb_org_world/lib/catalog.mjs` |
| org → split 的切分规则 | CPDB 目录 | `cpdb_org_world/lib/catalog.mjs#orgSplit` |

> **一处顺带发现的死代码**：`cpdb_org_world/lib/rng.mjs#splitForOrg`（按 org id 哈希切分）
> 在仓库里**无人调用**。真正生效的是 `catalog.mjs#orgSplit`（按 org 连续切：前 10 个 org = train，
> `org_11` = development，`org_12` = test）。两者会给出**不同**的 split。
> 协议明确采用后者，理由见 §3.2。

---

## 2. 简报（brief）：一个「群任务」

`buildBriefs()` 从 `people.jsonl` + `agents.jsonl` 推出 **120 个 brief**（12 org × 10 人），
落在 `briefs.jsonl`（120 行，由 `lib/protocol.mjs --write` 生成，测试盯住不过期）。

一个 brief 就是**一个人手下的团队**：

```
brief_org_01_consumer_p_01_00          # 北境消费研究社 / 王一帆 / 内容交付组
  lead:         ub_p_01_00（uBuddy = 主协调）
  participants: ag_p_01_00_0  信息整理·年份窗口        research
                ag_p_01_00_1  文案写作·引用绑定        writing
                ag_p_01_00_2  演示文稿·图表层级        ppt
                ag_p_01_00_3  验收审核·风险标记        review
                ag_p_01_00_4  文案写作·品牌语气（近邻） writing  ← twin
  mainAgentIds:        前 4 个（近邻不算主链）
  twinPairs:           [{writing 主职能位 ↔ writing 近邻}]
  similarSwapCandidates: 同上，带 detailFrom/detailTo
  dependencyOrder:     按职能依赖序排好的参与者
```

**为什么是"一个人的团队"而不是"随便凑几个人"**：这样一个 brief 里同时自带方案二的两个问题
的最小实例 ——

- **该找谁协作**：职能互补（`research → data → writing → ppt → code → review`），就是依赖分；
- **出事后该换谁**：一对同职能近邻，只差**一项细节能力**，就是相似度。

也就是说，`twin_swap` 这条 case 换完人之后，结果变好或变坏，都能**归因到那一项细节能力上**。
这不是比喻 —— `similarSwapCandidates` 里明确记着 `detailFrom` / `detailTo`。

---

## 3. 关键决策

### 3.1 真凶取依赖链的**中间**位置

链首没有入边（`missing_dependency` 无处落脚），链尾没有 ≥3 跳的下游（写不出 hop ≥3 的后果）。
所以真凶从中间取，并且：

- `missing_dependency` **显式排除链首**；
- 与真凶"相关的那位参与者"（`upstreamAgentId`）由 `neighbourOf()` 保证**一定不是真凶自己**
  （链首取下游，其余取上游）。

> 这里踩过一次：第一版写的是 `ordered[index - 1] || ordered[0]`。链首时它回落到 `ordered[0]`,
> 也就是真凶自己 —— 而报告里两个字段都有值，看起来完全正常。

### 3.2 split 按 **org** 切，不按哈希切

同一 org 内 10 个人的画像高度同源（同一个 `domain` / `topic` / `departmentName`，
职能组合只轮换 8 个 archetype）。按哈希切分会把同 org 的人劈到 train 与 test，
等于**测试集泄漏训练集**。

所以用 `orgSplit`：`org_01…org_10` = train（100 brief），`org_11` = development（10），
`org_12` = test（10）。`protocol.test.mjs` 断言没有任何 org 跨越 split。

### 3.3 每条 case 的**层级**写死，不让 LLM 挑

层级决定哪些字段合法：step 层没有 `acceptance`、没有富文本（`artifact`/`output`/`summary`/`inputs`），
也没有 `version`。让一个不知道这条的 LLM 去挑层级，它一定会挑出 **step 层的 `wrong_acceptance`**，
然后在自由文本里补一个 `acceptance` 字段 —— 那正是 `forms.mjs` 明确拒绝过的事。

**所以：层级由协议钉死，LLM 只负责把句子写好。**

### 3.4 依赖图里有一个环，必须**报出来**

`writing → report → review → verdict → writing`：report 是 review 的审查对象，
verdict 又是 writing 的修订依据。两者互为输入，硬做拓扑排序会失败。

处理方式：

1. Kahn 排出主链 `research → data → writing → ppt → code → review`；
2. 环上的环节按 `FAMILIES` 的声明序补齐（确定性，不靠 hash）；
3. **把断掉的边报出来**（当前是 `review->writing(verdict)`）。

> 这里也踩过一次：第一版在"补环上节点"的循环里顺手判回边，那时
> `order.indexOf(from)` 对尚未落位的节点返回 **-1**，`-1 > indexOf(to)` 恒假 ——
> 环上一条 back-edge 都记不下来，`brokenEdges` 恒为空。**静默丢边**的后果是：
> 依赖分看起来算出来了，其实少了一类协作关系，而下游会把缺失当成
> 「这两个职能本来就不互相依赖」。

---

## 4. Case 计划：一个 brief 出 10 条

| # | kind | 状态 | 类型 | 层级 | 形态 |
| --- | --- | --- | --- | --- | --- |
| 1 | `missing_dependency` | drift | 缺依赖 | `agent_task` | 删入边（**结构性，真凶不改字段**） |
| 2 | `wrong_agent` | drift | 执行者错位 | `agent_task` | 换成**不同职能**的参与者 |
| 3 | `wrong_version` | drift | 版本错位 | `agent_task` | 钉在旧窗口 |
| 4 | `wrong_acceptance` | drift | 验收放宽 | `agent_task` | 放掉门槛 |
| 5 | `local_replan_step` | drift | 本地重规划 | `agent_step` | 增派一环（**结构性**） |
| 6 | `wrong_agent_step` | drift | 执行者错位 | `agent_step` | 越权代跑（`agentId` 与父任务不同） |
| 7 | `wrong_version_step` | drift | 版本错位 | `agent_step` | 标题沿用上一版口径 |
| 8 | `no_drift` | no_drift | — | — | G_exec ≡ G_plan |
| 9 | `multi_inject` | **UNKNOWN** | 两条 | 混合 | 只评**弃权** |
| 10 | `twin_swap` | drift | 执行者错位 | `agent_task` | 换成**同职能近邻**（CPDB 相似度） |

合计 **120 × 10 = 1200 条**：drift 960 / no_drift 120 / UNKNOWN 120；
层级分布 `agent_task` 600、`agent_step` 360。

**`twin_swap` 为什么单列**：它是方案二（相似度）的落点。
第 2 条 `wrong_agent` 换成**不同职能**的人 —— 差异大到只能判"执行者错位"；
第 10 条换成**同职能近邻** —— 差异小到可以归因到单项细节能力。
**对照这两条，才是 CPDB 存在的意义。**

### step 层为什么只有 4/5 种漂移

`wrong_acceptance` 在 step 层**没有形态**：plan step 的载荷只有 `{step, status}`，
验收标准在这个层级没有来源（`uBuddyAgentPlanSteps.js` 与真实投影实测表
`ubuddy_recon/_real_live/AGENT_PLAN_OBSERVATION.zh-CN.md` §4.2 都证实 step 层不写富文本）。

编一段 `acceptance` 能凑出样本，但那是在教模型一个**生产上永远不存在的字段**。
宁可少一种漂移，也不造假 —— 这条是 `STEP_TIER_MISSING_FORMS` 里的**显式数据**，不是注释；
`protocol.test.mjs` 会去读 `forms.mjs#stepFormAvailable` 交叉验证，两边分歧就红。

---

## 5. 注入与传播的三条硬规则

照抄 `forms.mjs` 的注释 —— 那是踩过坑写下来的：

1. **hop 1–2 的后代一个字都不许改**，后果从 **hop ≥3** 起才写。
   `firstEffectHop()` 取的是"变化的**后代**里最近的那个"，所以 hop 1 只要有一个字段变了，
   `hop_to_first_effect` 就是 1，`minHopToFirstEffect: 3` 直接不满足 —— 而且**不报错**，
   只是样本静默变得过于容易。
2. **改动不许落在「真凶及其后代」之外**（`gold ∪ descendants(gold)`）。否则
   `changed_outside_descendants` 判死；更糟的是模型学会去看一个与成因无关的节点。
3. **真凶不许碰 `status`。** status 是 agent_step 层唯一真实的漂移信号，写进 gold
   等于把答案放在模型眼前。`validate.mjs` 的 `statusShortcutBaseline` 就是专门证明
   「只看 status 也能满分」的那条守卫。status 只能作为**后果**出现在下游。

两种难度口径（`PROPAGATION.subtle` / `.visible`），采样时二选一 ——
只有一种的话，"改动很微小"和"改动明显"就分不出来，而难度分层正是评测要看的一维。

---

## 6. gold 格式

单注入样本用**单数**键，双注入样本用**复数**键（照 `generate.mjs#makeUnknown`）：

```jsonc
// drift
{ "status": "drift", "injected_node": "n7", "injected_type": "wrong_agent",
  "injected_edge": "n3->n7", "injected_form": "research.wrong_agent.x",
  "hop_to_first_effect": 3, "decoy_nodes": ["n9"] }

// no_drift
{ "status": "no_drift", "injected_node": "", "injected_type": "",
  "injected_edge": "", "injected_form": "", "hop_to_first_effect": 0, "decoy_nodes": [] }

// UNKNOWN（双注入）：单数留空，定位走复数
{ "status": "UNKNOWN", "injected_node": "", "injected_type": "",
  "injected_edge": "", "injected_form": "", "hop_to_first_effect": 0, "decoy_nodes": [],
  "injected_nodes": ["n4","n11"], "injected_types": ["wrong_version","local_replan"],
  "injected_forms": ["a","b"] }
```

另有 `inserted_nodes`：注入本身在图上新增的节点（step 层 `local_replan` 的"增派一环"）。
它既不是真凶也不是诱饵，是**注入的副作用**，必须显式声明 —— 否则闸门的
`extra_node_unexplained` 会把它当"无来由的新节点"判死（`generate.mjs:173-175`）。

`goldOf()` **用白名单构造**，不是 `{...spread}`：多写一个键不会有任何东西报错，
但 `collect.mjs` 算指标时会多出一列恒为 `undefined` 的"答案"，而报告里看不出来它是错的。

---

## 7. 自检门槛（`CASE_GATES`）

图生成之后、提交之前，`simulate.mjs` 必须逐条过：

- 节点字段 ⊆ `nodeFields`；
- hop 1–2 的后代与 gold 之外**一个字段都不能变**；
- `hop_to_first_effect >= 3`；
- gold 不许碰 `status`；
- step 层不许出现 `acceptance` / `artifact` / `output` / `summary` / `inputs` / `version`；
- step 层不许出现 `wrong_acceptance`。

**不过门槛的 case 丢弃并计数，不"修一修再交"。** 一个形状不对的样本进了提交队列，
污染的是盒子上那条真链的评测结论。

---

## 8. 用法

```bash
node experiments/sim_task_group/lib/protocol.mjs --cases   # 打印 brief / case 分布
node experiments/sim_task_group/lib/protocol.mjs --write   # 重新落盘 briefs.jsonl
node --test experiments/sim_task_group/protocol.test.mjs   # 协议自检（12 条）
```

规模：**120 brief / 1200 case**。每条 case 需要 1–2 次 LLM 调用（生成计划 + 写后果），
所以 `simulate.mjs` 必须支持 `--briefs` / `--limit` / `--smoke` 做小样本先行 ——
1200 条全量是盒子上的一次长跑，不是本地调试的默认值。

---

## 9. 本文不声称

- **不声称模拟群任务等于真实用户任务。** 出的判定仍不是真实组织里发生的协作。
- **不声称 LLM 写的后果是"真实传播"。** 它按协议的跳数规则写，规则来自语料，但句子是生成的；
  所以每条 case 都要过 §7 的门槛，而不是"看起来合理就发"。
- **不声称 CPDB 的分数已验证。** 依赖分/相似度目前仍是 `prelabel_v1`，
  外部 AI 重判（工作流 C）还没回来；`twin_swap` 用的是**角色库里的职能结构**，
  不是打过分的数值。
- **不声称 step 层的 4/5 是临时妥协。** 那是刻意的能力削减：step 层没有验收标准的来源，
  少一种漂移比造一个生产上不存在的字段更诚实。
