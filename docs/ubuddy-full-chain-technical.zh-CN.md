# uBuddy 跨人 Agent 协作全链路（复杂技术版）

## 1. 设计目标与系统边界

### 1.1 目标

在多用户、多 uBuddy、多执行 Agent 的任务中，建立一个可共享、可版本化、可重放、可追溯的协作状态层，使参与者能够基于同一份公开状态自主协作，并将完整协作证据用于组织—个体联合进化。

### 1.2 非目标

系统不是中央工作流控制器，不根据依赖分数替 Agent 强制决定等待、重试、改派、拒绝或提交。系统只执行必要的运行时基础约束：

- 权限边界；
- 节点和来源引用的合法性；
- 两层 uBuddy 深度限制；
- 图结构不能形成环；
- 事件幂等、顺序和断线重放；
- 公共字段脱敏；
- 执行环境和任务记录的持久化。

等待、使用哪个结果、是否重试、是否改派以及是否重新规划，均由相关 uBuddy/Agent 根据公开协作状态自主决定。

## 2. 总体对象模型

系统同时维护三种互相关联的结构。

### 2.1 渐进式规划树 `P`

表示“截至某一时刻，各级 uBuddy 认为应该如何完成任务”。规划树不是一次性完整生成，而是随着信息从上游 uBuddy 向下游 uBuddy 展开逐步补全。

```text
P0：根任务
P1：根任务 + 外部 uBuddy 节点
P2：Bob uBuddy 补充内部 Agent 子图
P3：Carol uBuddy 补充内部 Agent 子图
P4：Agent 根据新情况提出局部重新规划
```

规划版本不可覆盖。每个版本保存父版本、需求版本、规划者、规划器版本、节点、边、输入输出契约、计划负责人、验收条件和变更原因。

### 2.2 实际执行事件树/执行 DAG `E`

表示“任务实际上发生了什么”。执行结构从规划版本对应的节点集合开始，但不覆盖规划历史；每次接收、派发、开始、交互、产出、阻塞、重试、交接、改派、修订、提交和验收都追加事件。

```text
E0 → E1 → E2 → ... → En
```

`task_nodes` 可以保存每个节点的当前物化状态，`task_events` 保存完整事件序列，`task_node_result_versions` 保存同一节点的多个结果版本。当前状态是事件历史的投影，不是唯一事实。

### 2.3 任务谱系证据图 `L`

表示输入、输出、文件、Memory、结果版本和验收之间的来源关系：

```text
需求版本
  → 规划版本
  → 委派指令
  → 节点输入
  → Agent 执行
  → 节点输出
  → Work Memory 版本
  → 下游消费
  → 最终交付
  → 验收结论
```

它回答：下游实际使用了哪个上游结果？使用的是哪个版本？结果是否被修订？某个偏差是否真正传播到了最终结果？

## 3. 全链路状态流

```text
Requirement(r0)
  ↓
Intent/Task Intake
  ↓
Capability Snapshot + Participant Selection
  ↓
Graph Initialization
  ↓
Progressive Plan Expansion(P0...Pk)
  ↓
Plan Version Release/Freeze for Current Execution Epoch
  ↓
Execution Projection(E0)
  ↓
Agent Interaction + Public Work Memory Publication
  ↓
Dependency Bundle Updates
  ↓
Agent-local Decision / Replan Request
  ↓
Execution Events and New Plan Versions
  ↓
Result Versioning + Handoff + Review
  ↓
Lineage Alignment + Attribution Diagnostics
  ↓
Organization Candidate + Personal Agent Candidate
  ↓
Evaluation / Canary / Rollback
```

这里的“冻结”不是指整条任务从开始到结束只允许一个计划，而是指：某一个执行轮次开始时，作为对照基线的规划版本不再原地修改；后续计划变化以新版本表示，执行态继续沿事件流推进。

## 4. 阶段 A：需求进入和结构化

### A1. 输入

用户消息、附件摘要、历史任务上下文和显式参与者要求进入发起方 uBuddy。

### A2. 输出

生成不可变的需求版本：

```json
{
  "requirementVersionId": "req_v1",
  "objective": "完成市场分析报告",
  "deliverables": ["报告", "PPT"],
  "acceptanceCriteria": ["数据来源可验证", "图表与结论一致"],
  "constraints": ["只使用公开数据"],
  "privacyScope": "task_group_public",
  "contentHash": "..."
}
```

### A3. 澄清机制

当存在会改变规划结构或最终交付的关键歧义时，uBuddy 返回结构化澄清，而不是直接猜测：

```json
{
  "decision": "clarification",
  "reason": "ambiguous_final_deliverable",
  "question": "最终需要提交报告和 PPT，还是只提交 PPT？",
  "options": ["报告和 PPT", "只提交 PPT"]
}
```

系统对澄清执行 schema 校验、幂等去重和权限检查。用户回答后生成 `req_v2`，并将 `req_v1 → req_v2` 作为需求演化关系保存。

## 5. 阶段 B：协作者发现和跨 uBuddy 规划

### B1. 能力选择快照

发起方 uBuddy 从可见候选中生成选择快照，至少包含：

- Agent family 和 Agent instance；
- 能力标签或有效 Skill；
- 性能等级；
- 当前负载；
- 可用状态；
- 能力画像版本；
- 选择理由和置信度。

能力选择快照被冻结在当前委托或任务群版本中，避免事后用最新画像替换历史决策。

### B2. 外部拓扑

建立：

```text
root task → recipient uBuddy(Bob)
root task → recipient uBuddy(Carol)
```

对应结构边：`parent_of`、`delegates_to`。外部 uBuddy 的深度最多为一层；内部执行 Agent 位于第二层。

### B3. 初始跨 uBuddy 依赖

发起方可以声明粗粒度依赖，例如：

```text
Bob 数据分析 → Carol 图表制作
```

此时只是跨主体协作意图，不要求发起方提前知道 Bob/Carol 内部的最终 Agent 节点。

## 6. 阶段 C：协作图和 Work Memory 初始化

### C1. 图对象

`ubuddy_collaboration_graph_v1` 至少包含：

- `collaboration_graphs`：图身份、根引用、owner、revision、生命周期；
- `collaboration_graph_nodes`：根、uBuddy、Agent task 节点及来源引用；
- `collaboration_graph_edges`：父子、委派、分配和依赖边；
- `collaboration_graph_events`：单调 revision、幂等 eventId、公开 patch、操作者。

所有节点和边必须由稳定来源引用生成 ID，不能通过标题或文本匹配合并。

### C2. Work Memory scope

为任务群或外部委托建立共享 Work Memory 范围。每个公开版本至少记录：

- `workScopeId`；
- 发布 Agent 和用户；
- 可见性；
- 内容摘要或加密载荷引用；
- 版本号和内容哈希；
- 来源游标；
- 发布时间；
- 访问审计信息。

公共图只保存公开摘要和引用，不保存完整 Prompt、私有 Memory、路径和凭据。

## 7. 阶段 D：渐进式规划树展开

### D1. 发起方规划

发起方先形成跨主体规划：

```text
P0：完成市场分析报告
P1：Bob 负责数据，Carol 负责图表和汇报
```

### D2. 接收方规划

Bob 的 `startExternalUBuddyTask` 在隔离上下文中：

1. 验证委托接收人和权限；
2. 读取公开任务要求和附件摘要；
3. 必要时返回结构化澄清；
4. 查询本地可用 Agent 候选；
5. 调用 uBuddy 任务图规划能力；
6. 生成 `task_run` 和 `task_nodes`；
7. 将公开节点投影到协作图。

任务图规划能力负责提出：

- 节点集合；
- 每个节点的 Agent/Agent instance；
- 节点目标和输出格式；
- dependencies；
- final node；
- 交付物和验收要求。

规划结果必须通过结构校验：节点身份唯一、Agent 有效、依赖引用存在、图无环、最终节点唯一。

### D3. 子图合并

Bob 和 Carol 的公开子图通过来源 ID 合并到总协作图：

```text
root
├── bob_ubuddy
│   ├── bob_collect
│   └── bob_verify
└── carol_ubuddy
    ├── carol_chart
    └── carol_report
```

合并不是把 `task_nodes` 改造成新的父子模型，而是通过协作图投影保存映射：

```text
collab_node_agent_task(hash(taskNodeId))
  ↔ taskRunId + taskNodeId + delegationId
```

## 8. 阶段 E：规划版本和执行轮次

### E1. 规划版本持久化

建议使用类似 `task_graph_plan_versions` 的追加表：

```json
{
  "planVersionId": "plan_v3",
  "parentPlanVersionId": "plan_v2",
  "requirementVersionId": "req_v1",
  "plannerVersion": "ubuddy_planner_v2",
  "plannerActor": "bob_ubuddy",
  "nodes": [],
  "edges": [],
  "plannedAgents": [],
  "contracts": [],
  "changeReason": "Bob 内部补充来源验证节点",
  "createdAt": "..."
}
```

旧版本不删除、不覆盖；新版本指向父版本。

### E2. 当前执行基线

当相关 uBuddy 认为当前子图足以开始执行时，系统记录：

```text
executionEpoch = 0
baselinePlanVersion = plan_v3
```

`plan_v3` 在该执行轮次中作为只读对照基线。它并不阻止后续生成 `plan_v4`。

### E3. 执行事件与状态投影

从基线复制或映射出执行初始状态 `E0`。之后每个真实事件追加：

```text
E0 task_created
E1 node_assigned
E2 execution_started
E3 input_received
E4 output_published
E5 memory_published
E6 blocked
E7 retry_started
E8 reassigned
E9 result_superseded
E10 submitted
E11 reviewed
```

`task_nodes.status/progress`、协作图节点状态和前端看板都是这些事件的物化投影。

## 9. 阶段 F：依赖集束和 Agent 自主决策

### F1. 依赖边结构

依赖边保存：

- 关系方向；
- 关系类型；
- 来源节点和目标节点；
- 依赖集束；
- 相关结果和 Memory 引用；
- source revision；
- 更新时间。

### F2. 依赖集束维度

```json
{
  "data": {
    "status": "available",
    "version": "result_v2",
    "evidenceRefs": ["output_v2"]
  },
  "logic": {
    "status": "partially_satisfied",
    "constraintCoverage": 0.75
  },
  "quality": {
    "score": 0.85,
    "status": "pending_review"
  },
  "freshness": {
    "score": 0.92,
    "expired": false
  },
  "review": {
    "status": "pending"
  },
  "capability": {
    "matchScore": 0.78
  },
  "resource": {
    "queueDepth": 2,
    "loadLevel": "medium"
  },
  "risk": {
    "score": 0.25,
    "level": "medium"
  },
  "downstreamImpact": {
    "score": 0.90,
    "affectedNodeIds": ["carol_chart", "carol_report"]
  },
  "updatedAt": "...",
  "evidenceRefs": ["event_12", "memory_v4", "output_v2"]
}
```

### F3. 分数的计算角色

系统可以根据事件、结果审核、时间和能力快照更新各维度分数，例如：

```text
qualityScore = 数据质量 × 0.5 + 来源可信度 × 0.3 + 审核信号 × 0.2
freshnessScore = max(0, 1 - elapsed / validWindow)
downstreamImpact = 下游重要性 × 受影响节点数 × 当前阻塞程度
```

这些分数用于公共状态理解、Agent 上下文、交互排序、诊断和进化证据，不直接作为系统的执行门控。

### F4. Agent 上下文

Agent 的 `publicCollaborationGraph` 至少包括：

- 当前图 revision；
- 所有授权节点；
- 所有授权边；
- 依赖集束完整字段；
- 公开 Work Memory 版本；
- 相关事件游标；
- 当前 Agent 与相关节点的关系。

私有 Prompt、私有 Memory、路径、凭据和未公开原始结果继续隔离。当前 Janus 已将协作图节点、状态、进度、公开摘要和 edges 注入 Agent Prompt，后续需要补充完整依赖集束和 Work Memory 引用。

### F5. 自主协作决策

Agent 读取状态后自行决定：

- 使用哪个结果版本；
- 是否等待；
- 是否先做草稿；
- 是否请求补充；
- 是否重试；
- 是否改派；
- 是否提交；
- 是否发起局部重新规划。

系统只将它的决定以及决定依据发布给相关参与者。

## 10. 阶段 G：执行中的重新规划

### G1. 触发来源

重新规划由以下主体主动提出：

- 发起方 uBuddy；
- 接收方 uBuddy；
- 内部 Agent；
- 用户需求变更。

典型原因：原数据源失效、结果版本过期、输入契约不满足、Agent 能力不适配或某一分支需要新增工作。

### G2. Replan 请求

```json
{
  "type": "replan_request",
  "basedOnPlanVersion": "plan_v3",
  "requesterNodeId": "bob_verify",
  "reason": "原数据源不可用",
  "proposedChanges": {
    "addNodes": ["backup_collect"],
    "removeNodes": [],
    "replaceEdges": [
      { "from": "backup_collect", "to": "carol_chart", "kind": "dependency_of" }
    ]
  },
  "evidenceRefs": ["event_10", "bundle_edge_4"]
}
```

系统对请求进行格式、权限、深度和循环检查，然后保存为新的 `plan_v4`，并广播：

```text
plan_v3 → plan_v4
changeReason = 原数据源不可用，新增备用收集节点
```

系统不替 Agent 评价提案是否最优。是否采纳由相关 uBuddy/Agent 自主协商或由用户确认。

### G3. 普通状态变化与计划变化的区别

不产生新计划版本：

- `queued → running`；
- 进度 20% → 60%；
- 发布一个新的公开摘要；
- 结果审核状态变化但任务结构未变。

产生新计划版本：

- 增删任务节点；
- 修改依赖方向或并行关系；
- 更换主要负责人；
- 修改输入输出契约；
- 需求变化；
- Agent 提出新增、替代或重排工作。

## 11. 阶段 H：结果版本和交接

每次节点输出生成不可变结果版本：

```json
{
  "resultVersionId": "output_v2",
  "taskRunId": "run_1",
  "taskNodeId": "bob_collect",
  "versionNo": 2,
  "contentHash": "...",
  "summary": "已完成数据收集，包含三个公开来源",
  "decision": "adopted|superseded|rejected|pending",
  "evidenceRefs": ["memory_v4"],
  "createdAt": "..."
}
```

结果交接事件记录：

- 发送方节点；
- 接收方节点；
- 结果版本；
- 公开摘要；
- Work Memory 引用；
- 交接时间；
- 是否被消费；
- 是否被后续版本替代。

这样可以区分：

```text
上游产生 v2，但下游实际消费 v1
```

这类版本错配不需要猜测，可以通过谱系直接验证。

## 12. 阶段 I：公开状态传播和断线恢复

本地协作图事件使用单调 `graphRevision` 和稳定 `eventId`。更新流程：

```text
本地事件追加
  ↓
图 revision + 1
  ↓
SSE/delegation_progress 发布公开 patch
  ↓
云端按 afterRevision 上传增量事件
  ↓
接收方按 cursor 补发
```

重复事件通过 `eventId` 幂等忽略；旧事件通过 revision 丢弃；断线后根据 `afterRevision` 补发。云端当前已支持完整快照和增量 delta 导入，快照用于初始化/冲突恢复，delta 用于正常同步。

## 13. 阶段 J：任务谱系对齐

任务结束或发生重要修订时，对齐：

```text
计划节点 ↔ 实际节点
计划边 ↔ 实际边
计划输入契约 ↔ 实际输入
计划输出契约 ↔ 实际输出
计划 Agent ↔ 实际 Agent
计划结果版本 ↔ 实际消费版本
```

对齐结果分为：

- 结构差异；
- 语义差异；
- 分配差异；
- 输入输出差异；
- 时间和版本差异。

合法重新规划、任务合并和回退不能直接标成错误，必须通过 `planVersionId` 和 `changeReason` 解释。

## 14. 阶段 K：规划—执行纵向和横向对比

### K1. 横向：计划与实际

比较：

- 计划节点和实际节点是否一致；
- 计划依赖和实际交互是否一致；
- 计划 Agent 与实际 Agent 是否一致；
- 计划输入输出契约是否被保留；
- 计划结果版本和实际消费版本是否一致。

### K2. 纵向：节点和边的时间轨迹

同一节点或依赖边按事件顺序查看：

```text
running
→ output_published(v1)
→ quality_pending
→ blocked
→ output_published(v2)
→ adopted
```

纵向轨迹用于判断：偏差何时首次出现、是否被发现、是否被修复、修复是否传播到下游。

### K3. 谱系：输入输出流

```text
bob_collect:v2
  → work_memory:v4
  → bob_verify consumes:v2
  → carol_chart consumes:v1  ← 版本错配
```

三种比较共同构成归因输入。

## 15. 阶段 L：多因素归因

归因不从最后一个失败 Agent 反推唯一责任，而从最终验收条件向上查询：

```text
验收失败条件
  ← 负责节点
  ← 实际输入
  ← 上游结果版本
  ← 相关依赖集束
  ← 计划—执行差异
  ← 首次未被修复且能解释影响的偏差
```

输出应允许多个角色：

```json
{
  "diagnosticId": "diag_1",
  "primaryCause": {
    "kind": "handoff_constraint_loss",
    "nodeId": "bob_to_carol_handoff",
    "confidence": 0.91
  },
  "contributingFactors": [
    { "kind": "upstream_quality_low", "nodeId": "bob_collect" },
    { "kind": "stale_result_consumed", "nodeId": "carol_chart" }
  ],
  "locallyCorrectNodes": ["bob_verify"],
  "remediationActions": ["bob_collect_v2"],
  "impactPath": ["bob_collect", "bob_verify", "carol_chart", "final_report"],
  "evidenceRefs": ["plan_v3", "event_10", "output_v2", "memory_v4"],
  "evolutionScopes": ["coordination_protocol", "agent_capability"],
  "blockedReason": ""
}
```

“首次有效偏差”必须同时满足：出现较早、证据充分、没有被后续完全修复，并且能解释最终质量下降或验收失败。证据不足时只保存诊断，不自动修改策略或 Agent 能力。

## 16. 阶段 M：联合进化

### M1. 组织层候选

归因路由到：

- 需求澄清策略；
- 任务拆分模板；
- 依赖和交接协议；
- 委派和能力选择；
- 质量门控；
- 版本和 Memory 传递协议；
- 重试、回退和协作提示。

### M2. 个体层候选

归因路由到：

- Agent Skill；
- Agent Memory；
- 能力画像标签；
- 能力权重；
- 输入检查；
- 结果验证；
- 特定工具使用能力。

### M3. 双向适配

```text
组织缺少某能力
  → 引导相关 Agent 补齐该能力

Agent 形成稳定新能力
  → 组织更新任务拆分和能力匹配

能力长期不被使用且无持续价值
  → 降低其调度/进化优先级
```

组织策略和个体能力候选都必须经过历史回放、离线评估、小流量验证、收益比较和可回滚发布。

## 17. 与当前 Janus 的对应关系

当前已有的生产链路大致是：

```text
Task Intake
  → Capability Selection
  → external_delegation/task_group
  → startExternalUBuddyTask
  → task_run/task_nodes
  → Scheduler
  → Agent Prompt + publicCollaborationGraph
  → Work Memory / progress / delivery review
  → collaboration graph projection
  → evolution evidence
```

当前已有能力包括：

- `uBuddyTaskIntakePlanner`：需求结构化和澄清；
- `uBuddyTaskGraphPlanner`：内部任务节点、Agent 分配、依赖和交付物规划；
- `startExternalUBuddyTask`：隔离接收外部委托并创建任务；
- `collaborationGraphStoreMethods`：图节点、边、事件、revision、来源映射和幂等；
- `scheduler.js`：任务状态变化、图投影和进度发布；
- `prompts.js`：向 Agent 注入公开协作图上下文；
- Work Memory：任务范围内公开工作记忆和访问控制；
- `collaborationGraph.mjs`：云端快照、delta 发布和参与者读取；
- 交付审核、结果版本和进化证据管线。

仍需要作为研究方法正式补齐：

- 规划版本的完整追加存储和版本差异算法；
- 计划节点—实际节点—结果版本的完整谱系表；
- 依赖集束的事件驱动计算和解释字段；
- Agent 上下文中的完整依赖集束和 Work Memory 引用；
- 重新规划请求及其采纳/拒绝历史；
- 规划—执行横向比较和节点/边纵向轨迹；
- 多因素、证据门控的归因诊断；
- 组织候选与个体候选的跨轮验证。

## 18. 最终方法定义

```text
渐进式规划树
  + 实际执行事件树/DAG
  + 任务谱系证据图
  + 动态依赖集束
  + 共享 Work Memory
  + Agent 自主决策
  + 组织—个体联合进化
```

该方法的核心贡献不是把工作流画成图，而是：

1. 用版本化规划记录“原本准备怎样做”；
2. 用追加事件记录“实际上发生了什么”；
3. 用谱系连接输入、输出、Memory 和结果版本；
4. 用依赖集束表达 Agent 关系的多维实时状态；
5. 把完整状态公开给授权 Agent，而不替它们做协作判断；
6. 用计划—执行—谱系联合证据生成组织和个体的改进方向。
