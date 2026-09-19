# uBuddy 代码与技术实现专项评审

评审范围仅包括代码实现和技术链路是否兑现当前方案中的创新主张：部分可观测协作世界、任务关系状态/TDB、决策充分公共投影、依赖证据归因与组织—Agent 联合进化。不评价论文表达、实验设计或最终效果。

## 总体结论

当前代码已经形成一个可运行的跨人协作基础设施，具备：

- 委托/群组/成员权限边界；
- capability profile 和 selection snapshot；
- 任务事件、修订、结果版本和 superseded/adopted 状态；
- 公开工作状态 projection 和敏感字段清理；
- attribution API、evidence 引用和 personal/organization evolution 路由；
- 幂等上传、证据加密、owner confirmation、canary/rollback 相关基础设施。

但从“方案创新是否已经被代码实现”的角度，当前实现仍主要是 **公共协作图 + 规则型归因 + 演化证据路由**。方案中最有辨识度的三个技术对象尚未在代码中成为一等语义：

1. 没有任务—关系—时间—query/action 绑定的 TDB 状态对象；
2. 没有真正的 decision-sufficient/minimal disclosure projection 和 CERTIFIED/CONFLICT/UNKNOWN 证书；
3. 没有受控 Probe、support/positivity 检查、关系交互 credit 或最小联合更新求解。

因此，代码实现评分为 **6.4/10**：工程基础较强，创新兑现度明显低于方案设计。

## 三维独立审稿评分

| 维度 | 评分 | 审稿判断 |
|---|---:|---|
| 创新实现的新颖性 | **5.8/10** | 现有实现能区分跨用户状态和证据，但核心仍接近协作图、投影和启发式归因的组合 |
| 技术深度与可验证性 | **5.7/10** | 有版本、权限、证据和状态规范化；缺少 TDB、决策充分性、干预效果和最小性实现 |
| 系统可信度与闭环 | **7.6/10** | 权限、脱敏、幂等、版本、加密和演化门控基础较扎实，但存在路由门控和测试环境缺口 |
| 综合代码/实现接受潜力 | **6.4/10** | 作为系统工程基础可接受；作为当前创新方案的完整兑现仍属 Borderline/Weak Accept |

## 已实现且质量较好的部分

### 1. 跨人权限边界基本真实存在

`cloud/src/modules/collaboration/stateGraph.mjs:190-240` 对 group membership、delegation requester/recipient 和 block 状态做了服务端检查；`capabilityAccessScope` 进一步区分 owner、friends、organization。该部分不是前端伪装权限，具备跨用户数据访问的服务端边界。

### 2. 公开投影有实际脱敏和版本控制

`src/shared/contracts/uBuddyWorkStatus.js` 对公开文本、路径、token、邮箱和 evidence refs 做规范化，`applyAgentWorkStatusProjection` 拒绝旧 revision、版本冲突、terminal regression。它能支撑“公开状态不是私有会话原文”的工程约束。

### 3. 事件、修订和结果版本被合并为可追溯 trace

`buildCollaborationAttribution`（`cloud/src/modules/collaboration/stateGraph.mjs:59-187`）会读取 delegation revisions、task events、organization trace events、group messages、capability snapshots 和 result versions，并按时间排序。这是过程溯源的有效底座。

### 4. Evolution 已有安全基础设施

证据加密、稳定 evidence identity、usage ledger、owner confirmation、personal/cluster scope、canary 和 rollback 在 `src/shared/evolution` 与 `cloud/src/modules/evolution` 中已有较完整实现。它们适合作为联合进化的执行支撑层。

## 关键实现缺口与审稿意见

### P0：演化路由会绕过“证据缺失即阻断”语义

在 `cloud/src/server.mjs:3985-3987`，路由先复制 `evolutionRouting.blockedReasons`，随后显式过滤掉 `evolution_evidence_missing`。因此 attribution 没有任何 evidence 时，可能继续把高 confidence signal 路由到演化，而不是保持 blocked。

这与方案中“证据不足不生成候选”的安全边界直接冲突。建议保留该阻断原因；只有明确存在可验证的替代证据类型时，才能在分类上解除阻断。

### P0：当前 attribution 是启发式状态分类，不是关系级归因

`organizationSignalsFor`（`stateGraph.mjs:320-370`）只根据 accepted、submitted、reworked 和 officialEvaluation 布尔条件生成固定 confidence（0.6、0.65、0.8）。`individualSignalsFor`（`372-410`）同样依据 delegation status 和是否存在 profile，把结果标成 `delivery_capability_gap` 或 `delivery_capability_supported`。

实现没有读取或计算：

- 具体依赖关系边及其多维状态；
- plan→active→exec 的关系状态变化；
- 版本、新鲜度、质量、资源和 obligation 的边级差异；
- 节点/边/组织的干预对照结果；
- 组合交互项。

因此不能把当前输出称为因果归因或 dependency-grounded counterfactual credit，最多称为 evidence-backed heuristic signals。

### P1：没有 TDB 一等数据结构或持久化契约

代码中的 `buildCollaborationStateGraph` 只构造 user nodes、delegation edges、stateItems、resultVersions、capabilitySnapshots 和 selectionSnapshots（`stateGraph.mjs:9-56`）。没有发现与方案对应的 TDB/TDB-Trace/HDBP 数据模型、schema、状态向量更新器或关系级版本账本。

现有 `dependencyOf` 只是 delegation metadata 的字符串字段（`stateGraph.mjs:29-38`），不足以表示任务关系边的 data/logic/quality/freshness/review/capability/resource/risk/impact/uncertainty 状态。

### P1：公共投影仍是固定结构，不是 query-conditioned minimal disclosure

`publicAgentWorkStatusProjection` 和 `publicTaskAgentWorkStatus` 主要按 visibility 做字段裁剪；`buildCollaborationStateGraph` 也按 viewer 权限返回固定 nodes/edges/stateItems。当前没有：

- `query`、`actionSet`、receiver decision context；
- 语义单元边际决策价值；
- disclosure cost/leakage budget；
- action-stability/regret 计算；
- `CERTIFIED/CONFLICT/UNKNOWN` 证书；
- probe escalation 或稳定决策停止条件。

所以当前代码实现的是 permission-filtered public projection，而不是方案中的 Decision-Sufficient Semantic Projection。

### P1：证据引用不是不可变、可验证的决策证书

`evolutionEvidenceRef` 主要输出 evidence id、source、confidence、validation status 和 occurredAt（`stateGraph.mjs:435-449`）。它没有绑定 `decisionQuery`、`actionSet`、`contractHash`、`scope`、`expiry`、`owner signature` 或一致私有世界集合。证据可追溯，但还不能证明某个投影足以支持指定动作。

### P1：联合进化目前是路由，不是联合更新求解

`routeCollaborationAttributionToEvolution`（`cloud/src/server.mjs:3974-4110`）做的是按 confidence 过滤 signal、写入 evidence、检查 owner 和 model provider，然后排入 personal evolution run。组织侧返回 `evidence_routed_scheduler_owned`，并没有在本链路内完成组织策略、Agent 能力、依赖边估计和投影策略的联合优化，更没有最小成本更新集合。

### P1：历史与当前证据尚未实现显式优先级和校准

代码会读取当前 delegation 的 snapshots 和 trace，也有组织 evolution trace，但没有 HDBP 的任务关系类型、时间衰减、适用域、跨任务置信区间或负迁移门控实现。当前 confidence 是单任务固定规则，无法支持方案中的 cross-task attribution calibration。

### P2：部分失败路径被静默降级，影响可观察性

`optionalMany`（`stateGraph.mjs:497-503`）对缺表错误返回空列表。这有利于旧版本兼容，但会把“正式组织 trace 不存在”和“组织 trace 查询暂时失败”合并成同一个空证据状态。对于归因和演化安全链路，建议至少返回 provider status/schema availability，让上层进入 `UNKNOWN`，不要静默当成无事件。

### P2：结果版本选择逻辑可追溯，但没有统一的 decision sufficiency 检查

`resultVersionsForDelegations` 能识别 superseded/adopted/pending，并处理 revision invalidation；这是版本账本的良好基础。但它没有把版本适用范围、新鲜度和下游 query 绑定起来，因此“最新版本”仍不等于“对当前决策可用版本”。

## 验证证据

本轮运行了：

```text
node --test cloud/test/auth-friends.test.mjs cloud/test/evolution-contracts.test.mjs cloud/test/evolution-worker-security.test.mjs
```

结果为 **34 通过、5 失败**。失败均发生在 `evolution-worker-security.test.mjs` 的 SQLite fixture 初始化阶段，错误为：

```text
table sqlite_master may not be modified
```

位置在 `src/cloud/modules/persistence/infrastructure/cloudSyncRepository.js:1282` 的 migration 兼容路径。该失败不直接证明协作归因逻辑错误，但说明当前演化安全链路的测试环境/迁移兼容性尚未完全闭合；在顶会系统审稿中会降低“安全实现已经可复现”的可信度。

## 最重要的代码级结论

当前实现最强的部分是：

> 跨用户协作数据的权限边界、公开投影脱敏、事件/结果版本追踪，以及受治理的演化证据存储。

当前实现尚未兑现的核心创新是：

> 同一个任务级、关系级、时间绑定的 TDB，按照具体 query/action 生成最小充分公共语义，并用关系级干预证据驱动组织—Agent 联合更新。

因此，现阶段代码更准确的技术定位是：

> **带权限和演化治理的跨人 Agent 协作状态与证据基础设施**

而不是完整的 Decision-Relative TDB、最小充分披露和反事实联合进化系统。

## 顶会审稿建议

如果只评价当前代码，我会给出 **Weak Reject 到 Borderline**，具体取决于论文是否把贡献声称限制在已实现范围内。

要让代码兑现 V3 方案，优先级应是：

1. 建立 TDB/TDB-Trace/HDBP 的正式 schema、状态更新器和持久化契约；
2. 让 projection API 接收 `query、actionSet、receiver、privacy budget、contractHash`，并返回三态证书；
3. 将 observation signal 和 Probe effect 分开存储，加入 support/positivity 和 interaction-unknown；
4. 修正 evidence-missing 路由绕过；
5. 将联合进化从“evidence routed”推进到带适用域、跨任务校准、shadow/canary/rollback 的更新候选；
6. 让缺失 provider/schema 进入显式 UNKNOWN，而非静默空列表。

本评审只评价代码和技术实现，没有修改代码。
