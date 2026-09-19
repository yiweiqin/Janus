# 顺序链 → 依赖 DAG：映射定义（2026-09-19）

> 缺口来源：`G_PLAN_G_EXEC.zh-CN.md` §2.2 与 §4.2（「映射未定义前，不得用长程层链条训练/评测 RDMD」）
> 实现：`stepDependencyMapLib.mjs`（规则）· `stepDependencyMap.test.mjs`（纪律测试）· `_probe_chain_to_dag.mjs`（真实链形状验证）
> 运行：`npm run experiment:rdmd-chain-to-dag` · `npm run experiment:rdmd-chain-to-dag:test`
> 本轮结论进 `PLAN_EXEC_TRUTH.zh-CN.md §15`

---

## 0. 一句话

**顺序链不是依赖 DAG，本映射也不把它解释成依赖。** 它只做三件事：给每条边标出
「假设（`sequence`）」还是「证据（`consumes`）」、把「这条链能不能做因果归因」变成一个
**可判定**的问句、以及把「这一步为何必需」拆成三档。**真实 rollout 链上这个问句的答案是
`false`（0/22）—— 这不是坏消息，是这道门按设计关着。**

---

## 1. 为什么必须定义

长程层（Codex rollout turn 链）是当前**唯一已实测「尺度与交互性都够」**的图源，
而它的投影是**顺序链**：

```
turn_i -> turn_{i+1}        # buildAgentGraph（gplanGexecLib.mjs）
```

直接拿它当因果，等于宣布「先发生的都导致了后面的」。后果不是「差一点」：

- **任何顺序都变成因果** → 级联被系统性高估；
- RDMD 要的「唯一级联根」在这张图上退化成「根是第一跳」；
- 归因结果**看起来**有结构（有环外、有路径），实际全是链上的位次。

所以 §4.2 把它写成了硬约束。本轮把那份「定义」补上，**但不解除约束** —— 定义出来之后的
结论是「今天这条链不可用于因果归因」，而不是「可以用了」。

---

## 2. 规则

### R0 — 顺序边永远是假设

`i -> i+1` 保留，但必须带：

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `kind` | `sequence` | 只有先后顺序 |
| `causal` | `false` | **不构成因果证据** |
| `evidence` | `order_only` | 证据来源就是「顺序」本身 |

规则表里没有「把某条顺序边当作因果」的入口。想升级只有一条路：`consumes` 声明它（R1）。

### R1 — 证据由调用方声明，契约只做校验与分级

契约**不从 JSONL 里挖证据**。「哪些产出被谁消费」要读工具参数（路径、命令、ID），
那是抽取器的活、有它自己的不确定性；塞进契约会把这层不确定性洗成「规则算出来的事实」。

输入是 `consumes: [{ from, to, symbol? }]`，契约校验三条并**丢弃+报警**，不静默采信：

| 违反 | 警告码 | 为什么丢 |
| --- | --- | --- |
| 端点在节点集外 | `consumes_unknown_endpoint` | 图里没有这个节点，边无处可放 |
| 自环 | `consumes_self_loop` | 自己消费自己，不是依赖 |
| `from` 在 `to` 之后 | `consumes_against_order` | **消费了未来才产出的东西**，时间上不可能 → 这份证据有问题 |

通过校验的证据边 `kind=consumes`、`causal=true`、`evidence=<symbol|declared>`。

### R2 — 同一对端点只留一条边

`from->to` 上若既有顺序边又有证据边，**只留一条并升级为 `consumes`**（记 `upgradedFromSequence`）。

理由不是洁癖：`uBuddyReverseDetective.edgeKey(edge)` 就是 `${from}->${to}`，
两条同 id 的边会被 `drop_edge` **一次删掉两条**、被度量**重复计数**。

### R3 — 顺序由数组定义，不由边定义

`nodes` 的**数组顺序**就是观察到的顺序。逆序的边与重复的节点 id 一律**丢弃+报警**，
绝不悄悄交换两端 —— 否则「输入数据自相矛盾」会被抹成「图看起来正常」。

### 可判定性与三档必要性

```js
causalAttributionReadiness(mapped)
// ready=true 的充要条件：有边 && 有证据边 && 一条顺序边都不剩
// reasons: ['no_edges' | 'no_evidence_edges', 'order_only_edges_present']

stepNecessity(mapped, nodeId)
// required_on_evidence_path  证据图上入度≥1 且出度≥1：它是某条产出→消费链的中间一环
// evidence_endpoint          只在一端（纯产出者/纯消费者）
// unverifiable               证据图上孤立 —— **不是「不需要」**，是「这套证据说不了话」
```

判据刻意严：只要还剩**任何一条**只有顺序的边就不行。因为「哪条顺序边恰好是真因果」
正是要判的东西，拿它当地基就是把答案当条件。

`unverifiable` 的返回里带 `orderOnlyIn/orderOnlyOut`，就是为了让
「它在链上有邻居、只是没证据」和「它是个孤点」分得开（两种 `reason`：
`on_the_chain_but_no_evidence_attaches` / `isolated_in_both_views`）。

### 空分母

`orderOnlyShare` / `cascadeInflation` 在分母为 0 时一律 `null`，**不给 0**
（`cascadeInflation` 也不给 1：1 读起来像「不膨胀」）。

### 不得用于训练/评测（可执行）

```js
STEP_DEPENDENCY_MAP_TRAINING_ALLOWED === false
assertNotForTraining(purpose)   // 只放行 'diagnosis'，其余用途直接抛
```

一个常量加一句注释挡不住任何人；一个会抛的函数至少让越界变成一次显式改动。

---

## 3. 形状验证：真实 rollout 链上跑一次（2026-09-19 实测）

命令：`node _probe_chain_to_dag.mjs`（只读；产出落 `_graphs/chain_to_dag.json`，已 gitignore）

### 3.1 链的形状，以及文档基线已经过期

| 指标 | `G_PLAN_G_EXEC` §2.3 记录（2026-09-16） | 本次实测（2026-09-19T06:23:42Z） |
| --- | --- | --- |
| rollout 文件 | 19 | **22** |
| 节点 | 706 | **792** |
| 边 | 687 | **771** |
| 链长 max | 110 | **180** |
| 链长 ≥51 的图 | 6 | 6 |
| agent 间交互记录 | 25 | **0** |

- 本次链长 p50 = **13**，min = 1（分母 = **有内容的图 21**；另有 **1 个空图**：
  `rollout-2026-09-19T14-03-11-…jsonl` 只有 2 行，投影出 0 节点 —— 空图必须被单独数出来，
  否则它会把「链长最短 0」混进形状表）。
- **这些计数是活的，别把它们当基线钉住**：同一天两次运行之间节点数就从 789 涨到 792
  （rollout 还在写）。所以判据请以**结论**（`0 / 22` 可归因、顺序边占比 1.0）为准，
  具体计数以每次跑出来的 `_graphs/chain_to_dag.json`（内含 `generatedAt`）为准。
- **`interactions` 从 25 变成 0**：当前 22 个文件里 `inter_agent_communication_metadata`
  一条都没有（逐文件计数确认）。也就是说那一层的「交互证据」在今天的数据上**不存在**了，
  §2.3 里「尺度与交互性都够」这半句的依据**目前不成立**。这不推翻「长程结构真实存在」
  （链长 max 从 110 涨到 180），但「交互性」需要重新实测或撤回。
- 「链长 ≥51 的图 6 个」没变 → 尺度结论稳定。

### 3.2 口径 A：契约当前口径（没有证据）

| 指标 | 实测 |
| --- | --- |
| 可以因果归因的图 | **0 / 22** |
| 顺序边占比（均值） | **1.0**（分母 = 有边的图 19） |
| 证据边 | **0** |

**这就是主结论：门是关着的，而且是 22/22 全关。** 771 条边全部是「假设」，
一条证据都没有 —— 不是「差不多能用了」。

### 3.3 口径 B：上限诊断（**不是规则**）

把「后一步提到过前一步提到过的路径」当成候选消费对喂进去（`shell_command` 参数里的路径提及，
故意宽松）。**提过 ≠ 读过，更 ≠ 依赖** —— 这一列只回答「就算这么宽松地认证据，能瘦到多少」。

| 指标 | 实测 |
| --- | --- |
| 候选消费对 | **8,161**（是链条边数的 **10.6 倍**） |
| 涉及路径提及的节点 | 328 / 789 |
| 证据边（上限） | 8,161 |
| 仍留有顺序边的图 | 19 / 22 |
| 可以因果归因的图 | **0 / 22** |

三条读法，都是「这条路不是解法」：

1. **更宽松的证据不会把链变成 DAG，而是把它变成一张更密的图**（10.6×）。密度一上来，
   「最小漂移」就没有唯一候选可言 —— 那正是 RDMD 要的东西被自己毁掉。
2. **即便全认，仍有 19/22 个图留着顺序边** → 门照样关着。缺的不是证据数量，
   而是「这一步**为何必须**在另一步之后」的规则。
3. 所以路径提及**不能**晋升为规则；它能进契约的唯一形态是「写→读」的判定，那需要先定义。

### 3.4 长程层的「计划」信号：`update_plan` 确实存在

| 指标 | 实测 |
| --- | --- |
| 含 `update_plan` 调用的图 | **2 / 22** |
| 调用次数 / 步骤总数 | 3 / **15** |

`update_plan` 的参数里带 `plan: [{ step, status }]`，是 rollout 里**真实存在**的计划快照。
所以 §4.1 的「长程层没有 G_plan」需要收窄成一句更准的话：

> 长程层没有 **uBuddy 规划层**的计划快照（`turn/plan/updated` 那一路）；
> agent **自己**的计划以 `update_plan` 工具调用的形式出现，但只覆盖 **2/22** 个 rollout。

它不能当 G_plan 直接用（只覆盖 2/22、语义是 agent 内部待办、与执行步不是同一套节点 id），
但它是「长程层将来能不能有 plan 侧」目前唯一的实测线索。

### 3.5 已知边界：跨 rollout 合并会撞 id

节点 id 是 `<sessionId>#<seq>`，而**一个 session 可以有多个 rollout 文件**：
本次 22 个 rollout 只落在 **10 个 session 目录**上。所以

- **同一个图内** id 唯一（契约成立）；
- **把同一 session 的多个 rollout 并成一张图会撞 id**（12 处重复）。

本轮不合并、不修（`buildAgentGraph` 的 id 公式是既有约定，改它要同步 `build_gplan_gexec.mjs`），
但这是后续要动长程层时必须先解决的一件事。

---

## 4. 明确不做

- **不拿长程层链条训练或评测 RDMD**（`assertNotForTraining` 挡着）。
- 不把「路径提及」写成规则（见 §3.3）。
- 不为长程层补 G_plan（`update_plan` 是线索，不是方案）。
- 不改 `buildAgentGraph` 的投影（本轮只定义映射，不动投影）。

---

## 5. 要打开这道门，还差什么

按依赖顺序：

1. **证据抽取规则**：「这一步的输入里含上一步的产出」的判定（写→读，而不是提到过）。
   有了它，`consumes` 才有真实来源，`causalAttributionReadiness` 才可能翻真。
2. **长程层的 plan 侧**：`update_plan` 是唯一已实测候选；要么证明它可扩到多数 rollout，
   要么接受「长程层只有 exec」。
3. **`version` / `acceptance` 仍无语义来源**（`G_PLAN_G_EXEC` §4.3）—— 在这条数据上重训前必须解决。
4. **真值缺失**（§4.5）：真实任务没有注入凶手，所以这条链**只能产出诊断，不能训练**。
   这条不解决，第 1–3 条都只是让诊断更准。

---

## 6. 复现

```powershell
cd experiments/rdmd_detective_dataset/ubuddy_recon
node --test stepDependencyMap.test.mjs        # 规则与纪律（9 条，无需真实数据）
node _probe_chain_to_dag.mjs                  # 形状验证（只读，需真实 rollout）
npm run experiment:rdmd-chain-to-dag          # 同上，从仓库根跑
```

产出：`_graphs/chain_to_dag.json`（全量逐图明细）。rollout 目录可用第一个参数覆盖，
默认 `%USERPROFILE%\.janus-test\data\codex_backend_sessions`；目录里没有 rollout 时退出码 **3（未测到）**。
