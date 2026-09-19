# uBuddy / TDB 主线方法说明（代码对齐版）

> **研究主张已切换（2026-09-10）。** 论文 / 方案主线改为跨人任务组织自进化，见 `Janus/docs/ubuddy-pain-points-innovations-v4-self-evolution.zh-CN.md`。本文描述的是仍与当前 TDB 代码对齐的历史方法（依赖状态、最小披露、Probe），不再作为 V4 贡献表述，也不再沿这条线扩张投影 / 披露训练。

## 1. 总体目标

在跨人、跨组织、多 Agent 协作中，只披露足以支持当前决策的信息，并基于可追溯、可验证的证据实现组织与 Agent 的联合进化。

TDB、决策充分性、最小披露、Probe 和归因不是五个并列产品，而是同一条闭环中的不同阶段：

```text
部分可观测协作世界
  → 任务关系依赖状态 TDB
  → 条件化世界与授权约束
  → 鲁棒决策充分性 + 最小披露前沿
  → 公共语义投影与协作执行
  → 事件/结果/义务证据
  → 依赖归因与局部反事实 Probe
  → 组织、Agent、依赖边和投影策略联合进化
  → 跨任务验证、拒绝更新或回滚
```

## 2. 三类核心痛点

### P1 协作可见性悖论

更多信息可能提高决策准确度，却同时提高隐私风险、越权推断和通信成本。系统需要求解“支持当前决策的最小公共语义”，而不是默认共享完整私人状态。

### P2 公共状态决策不充分

同一公共图可能对应多个私人协作世界。仅凭任务状态和进度无法确认动作在所有仍可能世界中是否安全、有效或满足风险预算。

### P3 结果因果归因困难

成功或失败可能来自 Agent、依赖边、交接、版本新鲜度、资源、审核或组织结构。直接更新某个 Agent 会造成错误归因和负迁移。

## 3. 方法创新

### 3.1 部分可观测协作世界模型

系统显式区分公共空间、私人空间、规划图 `G_plan`、执行图 `G_exec`、责任边界、权限、版本和证据。有限世界目录只作为声明清楚的条件模型使用，无法覆盖的状态必须返回 `UNKNOWN`。

### 3.2 Task-scoped Dependency Bundle

TDB 绑定具体 `taskId`、`edgeId`、source/target 节点和 Agent、relation type、时间序列、版本、事件和证据。它不是 Agent 固有能力分，而是某条任务依赖边在某个时刻是否支持下游行动的状态。

代码维度为：`data`、`logic`、`quality`、`freshness`、`review`、`capability`、`resource`、`risk`、`downstreamImpact`、`uncertainty`。

事件 fold、snapshot hash、trace hash 和 replay token 使状态变化可重放、可审计。

### 3.3 条件化鲁棒决策充分性

在初始观测、权限、支持范围、安全契约、效用区间和风险预算约束下，构造条件化世界集合 `W_I`，判断是否存在跨世界稳定动作。输出带有 action、regret bound、risk bound、world count 和 binding 的证书；证书由独立 checker 负责，模型不能自行认证。

### 3.4 决策条件最小披露

将披露单元按公共观测签名划分世界，搜索能够消除动作歧义的最小披露集合，同时满足 allowed、成本、权限和隐私约束。输出 `selectedUnits`、`disclosureCost`、诊断信息和 frontier，而不是一个隐私不可审计的总分。

在字段价值依赖已观测值时，进一步使用自适应策略 `π`（决策树）最小化先验期望披露成本，并约束所有叶节点的最坏决策遗憾；该策略由有限模型动态规划求解，静态披露是其特例。

### 3.5 依赖归因与局部反事实 Probe

通过 `G_exec - G_plan` 的 TDB 变化定位候选依赖原因，再用 `replaceAgent`、`changeEdge`、`refreshVersion`、`addReview`、`changeOrder` 等局部干预与 paired noop 比较增量效用。观察性轨迹不能直接触发演化。

### 3.6 组织—Agent 联合进化

可更新对象包括组织结构、Agent skill/memory/tool policy、依赖边 owner/义务/权限/验收规则，以及投影和 Probe 策略。更新必须绑定证据、适用范围、跨任务验证、负迁移检查和回滚条件。

### 3.7 两个可证伪的数学核心

为避免把系统描述误认为算法，主线提供两个独立参考求解器（`academic_methods.mjs`）。

**约束最小披露：** 对披露单元集合 `S` 求解

```text
min Cost(S)
s.t. max_w [U*(w) - min_{w' : obs_S(w')=obs_S(w)} U(a,w')] ≤ ε
    PrivacyLoss(S) ≤ δ, Authorization(S)=true
```

该定义把披露程度变成最坏世界决策遗憾与隐私预算下的可验证优化问题，而不是回归不可解释的总分。

**保守干预优先级：**

```text
LCB(e) = μ_e − z·SE_e
Priority(e) = [LCB(e) − Cost(e) − ρ_e|μ_e|] / Cost(e)
```

其中 `ρ_e` 是负迁移风险，并保留双干预交互项 `I(A,B)=U(AB)-U(A)-U(B)+U(∅)`。模型只能提出候选，独立 evaluator/checker 才确认收益与证书。

## 4. 当前代码映射

| 方法概念 | 当前代码 |
|---|---|
| TDB 状态、事件 fold、replay | `src/shared/contracts/uBuddyTaskDependencyBundle.js` |
| 依赖 bundle 兼容契约 | `src/shared/contracts/uBuddyDependencyBundle.js` |
| 跨任务适用性 | `src/shared/contracts/uBuddyCrossTaskApplicability.js` |
| 决策充分性 | `src/shared/contracts/uBuddyDecisionSufficiency.js` |
| 最小披露 | `src/shared/contracts/uBuddyDisclosureFrontier.js` |
| 自适应披露参考算法（有限模型动态规划） | `experiments/tdb_probe_benchmark/academic_methods.mjs` |
| 披露价值（VOI） | `experiments/tdb_probe_benchmark/academic_methods.mjs` |
| 因果解释部分识别 | `experiments/tdb_probe_benchmark/academic_methods.mjs` |
| Probe 与 TDB 双向绑定 | `src/shared/contracts/uBuddyProbeTdbBinding.js`、`uBuddyProbeEffect.js` |
| 认证、权限、未知状态 | `src/shared/contracts/uBuddyFormalChain.js` |
| 组织/个体归因与演化证据 | `cloud/src/modules/collaboration/stateGraph.mjs`、`evolutionEvidenceGate.mjs` |
| TDB 多任务训练验证 | `scripts/train_tdb_multitask_v2.py`、`scripts/train_qlora_tdb_multitask.py` |

## 5. 当前边界

- 当前训练和 benchmark 证据仍为 synthetic finite-world；
- 方向级 scoring layer 仍是待实现扩展，不是当前代码能力；
- 两套 bundle contract 仍需统一或明确适配层关系；
- 真实 evaluator、真实 state/projection gold、双人标注和真实跨任务进化收益尚未闭合；
- 模型只能提出 proposal；`CERTIFIED`、权限、隐私、执行和演化资格由独立契约/检查器裁决。

## 6. 论文贡献的推荐表述

我们提出一种面向跨人、跨组织、多 Agent 协作的证据治理框架，将部分可观测协作世界、任务关系绑定依赖状态、条件化鲁棒决策充分性、决策条件最小披露、局部反事实 Probe 和受治理联合进化连接起来，使系统能够在不暴露私人协作状态的条件下判断信息是否足够、定位依赖层面的结果变化，并在证据不足时拒绝迁移或更新。

方向级权重属于 TDB 状态进入具体决策时的条件化扩展，不能替代上述主线，也不能被表述为全局依赖总分。
