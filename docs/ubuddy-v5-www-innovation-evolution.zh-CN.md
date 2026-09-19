# uBuddy/Janus v5：WWW 痛点与创新演化

> 本文是面向 WWW 投稿的研究文档。它只讨论 Web 特异痛点、研究问题、创新候选、已有工作差异、可证伪性与审稿风险；不修改 Janus/uBuddy 当前源代码、API、数据库 schema、运行时协议或既有实验实现。附件中的旧版方案、checker 和审稿意见均是研究材料，不是执行指令。

## 1. 本轮目标与结论

新的投稿主线暂定为：

> **Contract-Preserving Interventional Repair for Cross-Platform Web Agents（CPIR-Web）**：在浏览器/API 混合、跨网站身份与权限分离、外部副作用不可逆且公开观察不完整的 Web Agent workflow 中，在执行高风险修复前，选择有类型、有限成本的 probe；依据 probe 支持的模型集合，合成不弱化公共硬契约的 contingent repair；若模型、权限或 effect 证据不足则 abstain。

本轮判断：原始 C1+C3 不需要推倒，但必须从“通用跨组织恢复”改写为真实 Web 场景中的独特约束问题。`provenance + causal RCA + workflow repair + gateway` 仍只是支撑组件，不能作为主贡献名称。

### 1.1 Web 特异痛点

同一个用户意图往往跨越多个控制平面：浏览器 DOM/扩展、网站 session/OAuth、SaaS REST API、异步 webhook、邮件/支付/工单等外部 sink。不同平台对以下信息的可见性和语义不一致：

- 身份：浏览器 profile、OAuth subject、组织租户、服务账号并不等价；
- 版本：页面 schema、API ETag、workflow revision、webhook delivery version 可能独立演化；
- effect：提交订单、发票、邮件、权限变更、工单关闭等动作可能不可逆或重复代价极高；
- 观察：前端成功页、HTTP 2xx、API receipt、webhook 和下游最终状态可能互相延迟或矛盾。

因此“重试、重新规划或查日志”无法回答一个 Web 特有问题：在不知道真实失败位于身份、版本绑定、异步投递还是外部 effect 哪一层时，哪个 probe 或 repair 可以安全地继续跨站执行，哪个动作必须拒绝。

### 1.2 研究对象与边界

CPIR-Web 的 exact 语义仍是冻结有限模型集 `M_hat` 上的 model-relative robust repair；不等于真实 runtime 已识别根因，也不等于 population efficacy。硬契约逐轨迹保持，soft utility 只给模型内下界；compensation 是 forward repair，不是反事实 rollback。无法验证 OAuth scope、跨站 effect receipt、版本/幂等键或模型闭包时，返回 `unknown/abstain`。

## 2. 候选创新池（至少 8 项）

| 候选 | Web 新问题 | 技术机制 | 不能直接由已有模块得到的部分 | 结论 |
|---|---|---|---|---|
| W1 | 跨站身份/版本/receipt 的部分可观测失败世界 | typed Web world + probe support | 需要把浏览器身份、OAuth、API 版本和 webhook delay 放进同一 repair 语义 | 保留主线 |
| W2 | 高风险外部 effect 前的 probe 选择 | effect-scoped intervention policy | retry/replan 不区分信息获取和副作用提交 | 保留主线 |
| W3 | 不可弱化的 Web contract | contract projection/exception/expiry/idem/auth conservation | 普通 workflow repair 可通过删字段、改成功页或扩大 exception 逃逸 | 保留主线 |
| W4 | 跨平台 effect 关联 | receipt/effect join 与版本栅栏 | provenance 只记录来源，不定义跨平台 effect legality | 支撑模块 |
| W5 | 浏览器/API 混合观测对齐 | DOM/API/webhook observation lattice | 单一日志 RCA 假定同质事件 | 合并入 W1 |
| W6 | OAuth scope 与 owner 分离下的修复授权 | capability-scoped action typing | gateway/ACL 单独不决定 probe 后能否安全修复 | 合并入 W3 |
| W7 | 异步 Webhook 重排/重复下的 forward repair | bounded dedup/fencing/compensation | Saga 只给事务模式，不给模型内 probe 选择与 abstain | D2 支撑 |
| W8 | 用户可感知的安全 abstention | public disposition + ACL diagnostic reference | 人在回路通常只做确认，不定义何时信息论上必须拒答 | 支撑/实验 |
| W9 | 跨平台 repair 的可解释最小性 | cost × risk × disclosure Pareto repair | minimum-cost 与最小集合常被混用 | 合并入主线 |
| W10 | Web benchmark 中的不可区分世界 | same intent/public cut, different hidden cause | 普通 benchmark 只测 success，不测错误动作风险 | 实验贡献 |

## 3. 合并、淘汰与主贡献

### 主贡献 A：Web-specific model-relative repair problem

合并 W1/W5/W6：定义跨浏览器、网站、SaaS API 和 webhook 的 typed hidden-world/action model。新意不在“用了因果/模型”，而在把跨平台身份、权限、版本、异步 receipt 和不可逆 effect 作为同一 repair 问题的必要状态维度。

### 主贡献 B：Probe-before-effect contract-preserving synthesis

合并 W2/W3/W9：在高风险 effect 之前选择有限 probe，并搜索满足 Web contract conservation、模型内 hard safety、soft value 下界和 Pareto 成本约束的 contingent repair。没有 positivity、effect support、授权证书或模型闭包则 abstain。

### 主贡献 C：可证伪的 Web failure benchmark

合并 W4/W7/W8/W10：构造跨站身份错配、版本漂移、webhook drop/dup/reorder、外部 effect 已提交但 receipt 丢失等 paired worlds，比较 retry、replan、reflection、provenance、Saga 和 CPIR-Web。该贡献必须以真实 Web replay 或明确 simulator evidence 支撑；当前尚未实现。

### 淘汰或降级

- “DAG/provenance/causal/gateway/ESCROW”不再单列创新；它们是实现或威胁模型组件。
- privacy、Blackwell sufficiency、exactly-once、all-or-none、rollback、population efficacy 不进入主贡献，除非另有独立定义和证据。
- checker、digest、schema、negative corpus 只能是 artifact credibility，不是 WWW 核心新颖性。

## 4. 相邻工作排雷（待人工核验）

检索家族：Web/Browser Agents、workflow repair 与 planning、causal diagnosis、safe planning/MDP、distributed transaction/Saga、provenance/attestation、OAuth/capability security、human-in-the-loop agent。当前只记录研究家族和关键词，不捏造具体论文或结果；正式投稿前需补作者、年份、链接/DOI 和检索日期。

本轮可由 Crossref 元数据直接核验的相邻条目（检索日 2026-09-01）：`Mind2Web: Towards a Generalist Agent for the Web`（2023，DOI `10.52202/075280-1220`）和 `Mind2Web 2: Evaluating Agentic Search with Agent-as-a-Judge`（2025，DOI `10.52202/085713-5778`）代表 Web agent 任务/评测方向；`SAGA Distributed Transactions Verification Using Maude`（2022，DOI `10.1109/isnib57382.2022.10076050`）代表分布式事务验证方向。它们用于排雷和定位，不被表述为已经解决 CPIR-Web 的 probe-before-effect、不可弱化 Web contract 或跨站 hidden-world abstention；WebArena、BrowserGym、workflow repair、causal RCA 等具体条目仍待人工核验。

需要逐项回答：已有 Web agent 是否只优化任务成功而没有 external-effect contract；workflow repair 是否假定可回滚或同质日志；Saga/2PC 是否解决 probe 选择和部分可观测 hidden cause；provenance 是否提供 action legality 而非来源记录；causal RCA 是否具备跨站 intervention support；human confirmation 是否有 abstention necessity。

## 5. WWW 可证伪假设

H1：在 paired hidden worlds 中，静态 retry/replan 至少有一个世界触发更高风险 effect；probe-before-effect 可降低风险而不弱化 hard contract。

H2：当 OAuth scope、effect receipt 或版本支持缺失时，CPIR-Web 的 abstain 比启发式 repair 更少产生 contract violation；不能把 abstain 当作 task success。

H3：跨浏览器/API/webhook 的 typed model 比单一日志模型能发现更多不可区分失败对；该结论需要锁定 benchmark 和独立标注，不能由一次 replay 推出。

## 6. 当前 WWW 审稿判断

Web relevance：**7.4/10**（问题已具体到跨站身份、SaaS API、webhook 与外部 effect，但尚缺真实部署证据）。

Novelty：**6.2–6.6/10**（问题组合有潜力，核心算法与已有 safe planning/repair 的不可替代性尚未证明）。

Technical depth：**6.1–6.5/10**（形式化方向清晰，但 finite product、support、effect legality 和定理仍是 planned）。

Experimental credibility：**4.8–5.4/10**（当前只有 fixture/prototype，缺真实 Web replay、故障注入和 locked benchmark）。

总体倾向：**Borderline / Weak Reject**。本轮采纳“Web 特异性必须成为问题定义的一部分”，拒绝把已有 checker 或旧版 D2 组件包装成 WWW 新颖性。目标保持 active。

## 7. 下一轮

1. 建立 Web-specific typed transition schema：browser/session/OAuth/API/webhook/sink 五类 effect 与权限/版本字段。
2. 写出 probe-before-effect synthesis 的伪算法、support/abstain 条件和至少一个 bounded soundness/necessity 定理目标。
3. 设计 paired-world Web benchmark 与 baseline matrix，先用 simulator 标记 `planned/unverified`，不声称真实 runtime。

## 第 3 轮：多步 belief-tree 与规模化 benchmark 设计（2026-09-01）

### 本轮研究问题

PBES 是否只是单步 safe planning 的换名？本轮将核心机制限定为“高风险 effect 前的多步信息购买 + Web contract ledger 约束 + fail-closed abstention”，并检查它在身份、版本、异步投递和 receipt 组合故障下是否产生非平凡的 contingent policy。

### 保留、合并与淘汰

- **保留主贡献 B**：PBES 多步 belief-tree。新增可观察对象不是字段堆叠，而是 probe 序列改变 belief partition，且每一分支必须通过 contract/effect legality 检查。
- **保留主贡献 C**：paired-world benchmark。扩展为 24 个模板（见 review log），每个模板至少两种相同 public cut、不同安全 repair 的 hidden world。
- **合并入主贡献 A**：browser/session、OAuth/tenant/scope、API version/ETag、webhook 和 sink receipt 的 typed state；它们是 Web 问题定义的必要维度，不单列模块创新。
- **降级支撑**：provenance、gateway、Saga/ESCROW、causal RCA、root-auth、digest/checker。它们用于支持或对照，不能替代 PBES 的 probe ordering、branch safety 与 abstention。
- **淘汰当前主张**：exactly-once、all-or-none、rollback、privacy、population efficacy；没有新证据时只作为 threat/boundary。

### 新增技术深度

1. v1 schema 固定 world/contract/support registry 在搜索前锁定，防止 planner 通过添加有利 world 或 scope 逃逸。
2. v1 checker 实现 depth-`H` 递归、risk budget、observation partition、branch-level repair/abstain 和 belief-state memoization；branch safety 仍来自 fixture 的 `safeByWorld`，尚未由 transition/contract 自动推导。
3. 写出 bounded soundness 与 abstention necessity 的归纳/反证证明草案，明确仅相对于 declared finite model。
4. 给出显式复杂度上界 `O(P^H·W(P+R))` 与 memoized belief-state 上界；不越界声称 hardness。

### 当前 v1 原型结果与边界

v1 输入包含：二步 identity→receipt probe、预算不足导致的 partial repair/abstain，以及所有低风险 probe 观察相同的 payment paired world。checker/negative runner 仅验证声明模型的一致性；运行结果必须继续标记 `UNKNOWN_INPUT_NOT_PROVEN` 与 `prototype/unverified`。没有 browser/API/webhook replay、OAuth certificate、authoritative receipt、effect linearization 或真实 world coverage。

## 第 4 轮：从“belief-tree 算法”收敛到 Web contract-conflict separation（2026-09-01）

### 本轮研究问题

如果 PBES 只被描述为 belief-tree 搜索，审稿人可以把它直接归入 constrained POMDP 或 active diagnosis。本轮改问一个更窄、可证伪且 Web 特异的问题：

> 给定相同的 Web public cut、多个 hidden worlds 及其不可弱化 effect contracts，哪些低风险 probe 能分离互相冲突的 contract obligations？当预算内没有足够的 separating probe 时，如何生成可审计的 abstention certificate？

### 八个候选及排雷结论

| 候选 | 新增问题/机制 | 相邻工作可覆盖部分 | 可证伪性质 | 处理 |
|---|---|---|---|---|
| C11 Contract-conflict hypergraph | world 是顶点，repair 不安全集合是超边 | POMDP 可表示，但通常不显式编码 Web obligation 冲突 | conflict-edge separation coverage | 合并主贡献 B |
| C12 Contract-separating probe tree | probe 选择以消除冲突超边，而非只最大化信息熵 | active diagnosis 有 test policy，但不带 Web effect legality | 安全叶覆盖/abstain 必要性 | 合并主贡献 B |
| C13 Irreversibility frontier | 在首次不可逆 sink effect 前冻结可执行 action set | Saga/gateway 有提交边界 | frontier 前后 violation rate | 支撑 B |
| C14 Cross-plane alias relation | browser profile/OAuth subject/tenant/canonical ID 的关系约束 | OAuth/ACL 能验证单次授权 | alias inconsistency fault injection | 合并主贡献 A |
| C15 Receipt–version conflict edge | receipt、ETag、sink revision 矛盾成为显式冲突边 | provenance 能记录来源，不能决定 effect legality | receipt-loss/version-drift paired worlds | 合并 A/B |
| C16 Budgeted certificate lower bound | 证明剩余 probe 不足以分离某冲突 edge | POMDP 给 value，但未必输出可读 certificate | certificate soundness/false-abstain | 合并 B |
| C17 Paired-world mutation generator | 从同一 public trace 生成不同安全 repair 的 worlds | Web benchmark 多测 success，不测 unsafe repair | held-out fault generalization | 主贡献 C |
| C18 Effect-ledger risk metrics | 以 effect cardinality/tenant/irreversibility 计安全损失 | 普通 agent metric 不区分错误副作用 | risk-calibrated benchmark ranking | 主贡献 C 支撑 |

### 收敛后的三条主贡献

1. **Web contract-conflict model**：定义跨 browser/OAuth/API/webhook/sink 的 typed world、obligation hypergraph 和 effect-conflict edge；重点是 obligation-level conflict，而不是泛化 POMDP。
2. **Conflict-separating PBES**：搜索满足 scope、version、receipt 和不可逆 effect 约束的 probe tree；输出 repair、partial repair 或带冲突边 witness 的 abstention certificate。若仅把该算法实现为通用 POMDP，论文必须承认其算法基础来自已有 safe planning，并把新意放在 Web contract semantics 与 certificate interface。
3. **Effect-ledger paired-world benchmark**：六个优先 simulator 场景和 24 个模板，以 gold effect ledger 标注错误副作用、冲突边和 abstain 必要性；不再把普通任务成功率作为核心证据。

### 明确拒绝的过度主张

- 不声称 contract-conflict hypergraph 本身是全新图论；它是把 Web obligations 显式暴露给 probe synthesis 的建模接口。
- 不声称 PBES 在表达能力上严格超越 constrained POMDP；需要通过 obligation-level certificate、effect legality 和 benchmark evidence 证明其实用不可替代性。
- 不声称 simulator 等价真实 OAuth、支付或 SaaS 运行时；所有未运行部分继续标为 `planned/unverified`。

本轮独立 simulator 已从 S1–S3 扩展到 S1–S6：90 条 deterministic traces，使用统一 public-cut / hidden-world / gold-effect-ledger 结构。初步结果只用于验证 benchmark 协议和故障标注链路，不作为论文性能结论；输出状态为 `simulator/prototype`，并在下轮做 seed、fault timing 与 baseline fairness 审计。

simulator checker 对 18 个 world×seed group、5 个 policy 输出和 90 条 gold ledgers 做一致性检查，negative 5/5；这只证明研究工件的结构完整，不能证明 simulator 与真实 Web 语义等价。

独立 baseline runner 将 world catalog、policy synthesis 和 contract evaluator 分离后，得到一个必须采纳的负结果：在 6 个场景上，safe-constrained-POMDP 与 CPIR 产生相同的 declared-model 安全分布；active diagnosis 也相同，one-step diagnosis 在 S1/S5 各有一个 violation。于是主贡献 B 不再表述为“新 planner”，而表述为“面向 Web effect contract 的冲突边抽取、可审计 certificate 和 fail-closed policy interface”；若后续实验不能证明 certificate/ledger 带来额外诊断价值，应将 B 降为 formalization/interface，不能继续包装算法创新。

## 第 5 轮补充：以方法路线为中心的收敛（2026-09-01）

本轮按用户要求，只评审创新点的新颖度和技术深度；实现完成度、论文写法和统计包装暂不作为主阻塞。

### 三个创新 Agent 的独立候选

- Innovation A（Web 场景）：提出 authority continuity、receipt freshness/finality、observation coherence、model-validity envelope、intent-lineage fencing 六个 Web 特异方向；建议优先处理跨平面授权连续性和开放世界模型越界。
- Innovation B（方法）：提出 CES-PBES、irreversibility-frontier/effect-ledger reconciliation、scope–identity–version triage、budgeted certificate lower bound；同时确认 policy tree 可被 constrained POMDP 表达，不能把 planner 表达能力当作新意。
- Innovation C（理论）：发现旧 `E_conf=Unsafe(a)∪Safe(a)` 恒等于全世界集；建议改成 inclusion-minimal 高阶 conflict subset，并区分 `CONFLICT`、`EPISTEMIC_BLOCKAGE`、`INFEASIBLE`、`UNKNOWN`。BCS-TREE reduction 在有限、确定、二元 probe、正整数成本约束下基本成立，但仍只是 proof draft。

### 综合后的八个候选

| 候选 | 核心对象 | 新颖性判断 | 处理 |
|---|---|---|---|
| I1 CACE-IL | browser→OAuth→tenant→API→sink 的 authority/intent continuity envelope | Web 跨平面信任链比单站 ACL 更具体；若只是 token/idem 字段拼接则淘汰 | 主线 A |
| I2 RFRE | receipt freshness/finality、sink generation、commit index 与重试门 | 将“effect 已发生”和“Agent 未观察到”分开；需避免退化为普通 timestamp | 主线 B |
| I3 Model-validity envelope | API/issuer/schema/latency 演化导致模型越界时撤销安全结论 | 直击 model-relative safety 漏洞；可能与 OOD/version monitor 重叠 | 合并 A/B，优先级高 |
| I4 Intent-lineage fencing | 多 tab、back-cache、retry 的 intent supersession 与 sink fence | Web 并发/导航特异；普通 endpoint idempotence 不足以覆盖 | 支撑或主线 C 候选 |
| I5 Conflict-edge certificate | obligation-level witness、probe closure、blocking world | 不是新图论；只有 closure verifier 和可审计诊断价值成立才保留 | B 的证明接口 |
| I6 Observation-coherence cut | DOM/API/webhook issuer、epoch、version 的一致性合并规则 | 可能是 provenance+trust lattice 换名 | 暂作支撑 |
| I7 Bound confirmation | 绑定 tenant/resource/amount/version 的 challenge-response confirmation | 容易退化为 HITL token/ACL | 淘汰主线 |
| I8 Effect-ledger benchmark | 以副作用、receipt、tenant/subject 错配为 gold object | 不是算法创新，但可提供不可替代证据 | 主线 C |

### 主线最终排序

当前建议不重做整个方向，但重做“算法创新”的叙述：

1. **CACE-IL：effect admission protocol**；
2. **RFRE：post-linearization reconciliation protocol**；
3. **Proof-carrying Web effect benchmark/certificate**。

PBES 保留为二者之上的 policy interface。若强 POMDP 加入同样的 CACE-IL/RFRE verifier 后仍输出相同 policy，则不再争论 planner 新颖性，主张降为 Web-specific protocol/formalization + auditable certificate。

## 第 2 轮：PBES paired-world 原型与 abstention 边界（2026-09-01）

### 本轮研究问题

同一 Web 公共轨迹对应 OAuth subject 错配、webhook 延迟、API version drift 或“effect 已提交但 receipt 丢失”等隐藏世界时，是否存在一个低风险 probe，使 Agent 可以安全选择 repair；若不存在，能否给出必须 abstain 的模型内证据？

### 本轮候选（10 项）

| 候选 | 新增内容 | 与成熟模块的差异 | 可证伪性 | 处理 |
|---|---|---|---|---|
| P1 | Web belief partition probe | replan 不主动购买区分 hidden worlds 的信息 | probe 后分区是否缩小 | 主贡献 B |
| P2 | identity-before-effect fence | OAuth 检查本身不决定 effect safety | 错 subject paired world | 合并 P1 |
| P3 | DOM/API/webhook observation lattice | provenance 不处理异步观测冲突 | 删除一种观测的 ablation | 合并 A |
| P4 | probe risk budget | active diagnosis 通常不约束 Web 外部 effect | risk 超预算必须跳过 | 合并 B |
| P5 | capability-scoped probe/repair | gateway 只做授权，不做 belief-dependent synthesis | scope 缺失负例 | 合并 B |
| P6 | receipt-aware effect reconciliation | Saga 不判断 effect 是否已发生但 receipt 丢失 | commit/no-receipt paired world | 支撑 C |
| P7 | abstention necessity witness | human confirmation 不等于安全拒答条件 | 不可区分 cell 无通用安全 repair | 主贡献 B |
| P8 | Web paired-world generator | Web benchmark 通常强调成功率 | same public cut / different safe action | 主贡献 C |
| P9 | Web effect contract refinement | workflow repair 可能伪造前端 success 或删除 obligation | contract mutation | 主贡献 B |
| P10 | cost-risk-disclosure Pareto policy | minimum-cost 不等于 disclosure/risk 最小 | Pareto ablation | 未来扩展 |

收敛仍为三条主贡献：A Web typed hidden-world model；B PBES；C paired-world benchmark。P2–P7/P9 是 PBES 的不可分割约束，不作为模块清单平铺；P10 暂不进入正文主张。

### 原型证据与边界

新增 `ubuddy-cpir-web-pbes-v0.*`。场景一中，`identity+receipt` probe 将 OAuth subject mismatch 与 webhook delay 分开，两个 observation cell 分别选择 `reauthorize-and-submit` 和 `wait-and-reconcile`。场景二中，低风险 public-status probe 对 API version drift 与 committed-no-receipt 返回相同观察，且不存在对两个世界均安全的 repair，因此输出 `ABSTAIN_NECESSARY_UNDER_DECLARED_MODEL`。负例 6/6。

该结果仅为 locked finite paired-world table 上的 model-relative synthesis；没有 browser runtime、OAuth certificate、authoritative receipt 或真实 sink replay。它不能声称识别了真实根因，也不能声称 runtime safety。

### 本轮 WWW 评分

Web relevance **7.7/10**；Novelty **6.4–6.8/10**；Technical depth **6.5–6.9/10**；Experimental credibility **5.0–5.6/10**；总体仍 **Borderline / Weak Reject**。评分小幅提升来自形成了具体 Web paired-world 与 PBES 决策对象，而非 checker 数量。

下一轮：多步 belief-tree 与 probe 组合；写出 declared-model one-step soundness 和 abstention necessity 的完整证明草案；把 paired worlds 映射到 WebArena/BrowserGym/WorkArena 类环境的可执行任务定义（先 planned）。

## 第 6 轮：把新颖性落到可执行的 effect-admission 语义（2026-09-01）

本轮不增加新的名词集合，而是执行 P0/P1 的最小方法闭环。核心变化是：CACE-IL/RFRE 不再只是协议字段清单，而成为一个可对 typed Web snapshot 运行的六项 obligation evaluator。

### 方法层新增内容

1. `AUTH_CONTINUOUS`：browser profile/session epoch、OAuth issuer/subject/audience/epoch、scope 和 envelope 必须连续；
2. `TENANT_BOUND`：contract/session/OAuth/envelope/resource 必须同租户，alias 无权威映射时为 `UNKNOWN`；
3. `VERSION_FRESH`：effectful action 消费一致的 API origin/version/version fence；
4. `IDEM_UNIQUE`：intent/effect/idempotence key 与 registry 状态一致，已消费或跨 intent 复用为 `VIOLATED`；
5. `EFFECT_CARDINALITY_WITHIN_BOUND`：由 effect ledger 的当前 cardinality 和 action delta 推导上界，缺失为 `UNKNOWN`；
6. `RECEIPT_POLICY_SATISFIED`：只允许 authoritative fresh `NO_COMMIT` 做同 key retry，只有 coherent `FINAL_VERIFIED` 能宣称成功，compensation 必须是新 contract。

### 新颖性判断更新

这一步没有证明新的 planner 表达能力；它把候选主线从“belief-tree 算法”进一步收敛成 Web 特异的 effect admission + post-linearization reconciliation 语义。真正需要继续证明的不是字段数量，而是：同一 intent/effect 是否能在 browser、OAuth、tenant、API fence 和 sink receipt 之间保持可检查连续性，以及该连续性是否能产生普通 retry/replan/gateway 不提供的 witness 和 fail-closed 行为。

### 当前状态

`ubuddy-cpir-web-transition-evaluator-v0.mjs` 和对应测试为 `research-prototype/unverified`；旧 simulator/runner 尚未替换，故本轮不提高 WWW 评分，不声称 runtime safety、OAuth authenticity、exactly-once 或真实 Web 覆盖。

## 第 7 轮：从 preflight predicate 推进到有限线性化 admission model（2026-09-01）

### 独立创新候选

Innovation A 提出四个候选：

1. **CLAT（Cross-plane Linearization-bound Admission Token）**：用 sink reserve/consume 时的 binding vector、revision 和不可复用 nonce 处理跨 browser/OAuth/API/sink 的 race 与 ABA；
2. **RLF（Receipt-loss-safe Finality）**：把 commit 后 receipt 丢失、延迟和重排与 retry gate、finality 证据绑定；
3. **AECF（Authority-to-effect Continuity Fence）**：将 browser profile、OAuth principal、tenant alias revision、resource fence 一起绑定到 effect token；
4. **Timestamp/sequence hybrid freshness**：用 generation、commit index、可信时钟替代单 timestamp freshness。

综合裁决：CLAT + AECF 合并为 CACE-IL 的技术深化，RLF 保留为 RFRE 的技术深化，timestamp/sequence 仅作为 receipt 实现细节。四项都存在被 OAuth/DPoP、ETag/CAS、idempotency/outbox、signed receipt 组合替代的风险，不能单独宣布全新协议。

### 本轮新增的实质变化

AdmissionToken 已从静态字段检查变成有限 reserve→consume→finalize transition model，并引入 `stateRevision`、`bindingRevision`、`bootEpoch`、sink generation 和 cross-plane authority vector。它第一次提供了可运行的 race/ABA/replay 反例对象，而不只是增加 schema 字段。

### 新颖性边界重新判断

如果将同一 transition relation 用标准 OAuth/DPoP + tenant ACL + ETag/CAS + idempotency store + signed outbox receipt 实现，并得到相同的 reject/no-op/finality witness，那么 CACE-IL/RFRE 仍应降级为跨平台 Web contract formalization。当前可辩护的新意是：把这些平面绑定成一个 effect identity 和可审计 witness；尚未证明不可替代。

### 当前状态

新工件状态为 `research-prototype/unverified`。34 个 transition/audit/step-witness 测试通过；contract/cardinality 已由 immutable registry 提供，epoch/generation 禁止回退，replay 必须保持 action identity。但它仍是单进程有限模型；旧 CPIR/safe-POMDP runner 尚未接入，故本轮不把评分提升到 Weak Accept。

### 第 7 轮候选综合为 8 项

| 候选 | 核心差异 | 处理 |
|---|---|---|
| N1 Cross-source causal admission cut | 多权威证据必须存在共同有效切面，防 fractured read | 主线 A |
| N2 Probe-to-Reserve Transaction | probe evidence 与 reserve revision/token 原子绑定 | 合并 A |
| N3 Cross-plane Non-Revival | 任一 authority/version/generation epoch 变化后旧 token 永不复活 | 主线 B |
| N4 Linearization Witness Chain | 输出 pre/post state、CAS revision、ledger delta 和 receipt link | B 的证明接口 |
| N5 Receipt-loss-safe Finality | linearization 后 receipt 丢失时禁止 false success/blind retry | 主线 C |
| N6 Admit/Goal separation | action safe 不等于任务完成 | C 的语义接口 |
| N7 Multi-tab/SW/BFCache lifecycle worlds | Web 特异并发、离线、页面复活 fault model | benchmark |
| N8 Receipt-carrying terminal UI | DOM/ARIA success 必须绑定 final receipt | benchmark/未来机制 |

正文仍最多保留三条：causal admission cut、cross-plane non-revival、receipt-loss-safe finality。N2/N4/N6 是三条主线的技术接口；N7/N8 用来证明问题真实依赖 Web。

## 第 8 轮：把冲突证书绑定到 admission transition（2026-09-01）

本轮新增的不是又一个协议名，而是将 P2 的 conflict/blockage registry 从“评估矩阵后处理”推进为 admission-derived 语义：每个 world/action 必须实际运行 `RESERVE → CONSUME → FINALIZE`，再依据 transition outcome、obligation witness 和 sink audit 生成 `SAFE_TERMINAL / VIOLATED / UNKNOWN`。

### 本轮新颖性收敛

- 可保留的窄主张：**admission-derived Web effect conflict certificate**。它把 version fence、authority epoch、idempotence、cardinality 和 receipt finality 的失败，统一映射为可审计的 action-level conflict/blockage witness。
- 不可保留的强主张：该 conflict registry 不是新图论；PBES 仍未证明严格超越 constrained POMDP；成熟 OAuth/DPoP + ACL + ETag/CAS + idempotency/outbox + signed receipt 可能复现相同行为。
- 当前最有价值的差异点是证书接口：`pre/post state hash + transition reason + terminal status + sink ledger audit`，而不是 world 数量或字段数量。

### 新工件

- `ubuddy-cpir-web-admission-conflict-adapter-v0.mjs`
- `ubuddy-cpir-web-admission-conflict-adapter-v0.test.mjs`

复核修正后 10/10 端到端测试通过；全量 P0–P2 回归为 75 个断言通过。状态仍为 `research-prototype/unverified`。

### 下一步三个执行任务

1. 将 transition trace 扩展成完整 probe closure certificate；
2. 加入成熟组合 baseline，验证 certificate 是否提供额外诊断/abstention 信息；
3. 若等价，则停止 planner 新颖性主张，固定为 Web effect-contract formalization + auditable protocol/benchmark。

## 第 9 轮：VCC/PREE 与 Web 生命周期/跨 authority 方向收敛（2026-09-01）

### 独立创新候选

本轮 Web 问题分析提出四个候选：

1. **Activation-Scoped Browser Coherence Cut**：把 BFCache、Service Worker controller、tab/page activation 纳入 cut lineage，防止冻结页面复活后复用旧 evidence；
2. **Causally Consistent Multi-Authority Cut**：从墙钟区间交集升级到带 predecessor/revocation frontier 的跨 OAuth/tenant/API/sink consistent cut；
3. **Partition- and Channel-Bound Evidence Escrow**：绑定 top-level site、frame origin、storage partition 和 OAuth challenge，阻断跨站 channel mix-up；
4. **Absence-Covering Retry Escrow**：要求 sink 对旧 attempt 给出覆盖完整的 `NO_COMMIT` 负证据，防止 timeout 被误当作未提交。

综合处理：1–3 是下一阶段可合并进 VCC/PREE 的候选；4 与 RFRE 高度重叠，暂不单列主贡献。若仅新增 `pageEpoch`、`nonce` 或 vector clock 而没有生命周期撤销、跨 authority 依赖和 reserve-time witness，均按成熟 fencing/consistent snapshot 换名淘汰。

### 本轮技术执行

- 新增 VCC/PREE finite evidence semantics 和 15 个断言；cut 在 reserve 前从 escrow atoms 重建，修复 forged aggregate cut、过期 evidence 和跨 effect/tenant 复用。
- atom 现在显式绑定 probe session、challenge、effect、tenant、owner、scope、authority key revision；未验证签名返回 `UNKNOWN`。
- escrow store 增加 revision，顺序 replay 需要共享 store 的 returned state；当前仍不声称跨进程原子消费。

### 严格审稿裁决

本轮独立 Reviewer 评分：新颖性约 `5.8/10`，技术深度约 `6.6/10`，Web 适配度 `8.2/10`，实验可信度 `3.8/10`，倾向 `Weak Reject / Borderline`。主要否决理由是：VCC/PREE 仍可被成熟 authority/ETag/idempotency/outbox 组合复现；证据真实性与 durable atomicity 尚为假设；当前还没有 BFCache/SW 或 fractured-read 的端到端 paired trace。

因此不重做整个方向，但必须把主线收敛为：

```text
browser activation/channel lineage
→ multi-authority evidence cut
→ escrow-to-reserve refinement
→ admission transition
→ finality/conflict certificate
```

下一轮只做：实现 activation lineage 与 cross-authority dependency edge 的最小模型，并用成熟组合做相同 paired-world 对照；若证书和行为完全等价，停止“新协议/新 planner”叙事。

## 第 10 轮：ABCA 收敛与四类可证伪 pair（2026-09-01）

### 候选合并

本轮不再增加独立协议名，将候选合并为一个 profile：**Activation-Bound Coherent Admission (ABCA)**。它统一：

1. browser activation/channel lineage；
2. multi-authority predecessor-coherent cut；
3. challenge/effect/tenant-bound escrow；
4. reserve-time reconstruction 与 sink admission/finality。

算法层仍保持开放：DRAS（漂移鲁棒 admission synthesis）和 AOC（最小 admission obstruction core）只是待验证候选，不能因为名称本身算创新。

### 本轮修正与验证

- VCC/PREE atom 增加 activation vector：`activationRoot/tabEpoch/pageEpoch/swEpoch/partitionEpoch/activationNonce/partitionKeyHash`。
- escrow 同步绑定 activation；reserve 强制 current activation revalidation；BFCache restore、SW controller change、partition switch 等事件通过 epoch/nonce 推进触发旧 cut 失效。
- 增加 signature-unverified、stale activation、escrow revision 和 current activation 缺失负例；VCC/PREE 测试 17/17 通过。
- 修正 VCC 默认复杂度：当前语义是 unary per-source filtering，默认 `UNARY_CANONICAL`；Cartesian 只作为显式 bounded mode。

### 三组独立意见综合

- Web 候选：AS-BCC、CCMAC、PCBE 最有价值；ACRE 并入 RFRE。
- 方法候选：DRAS 最像算法问题，AOC 最像可验证证书问题；二者都需与同一 verifier 的强 baseline 比较。
- 理论候选：activation non-revival、predecessor/revocation closure、escrow refinement、abstention necessity；其中只有在完整 lineage/revocation/escrow 语义落地时才可能不可替代。

### 下一轮最小锁定实验

建立四类 paired worlds：

- AL：BFCache/SW/partition activation 变化；
- PC：OAuth revoke 与下游 token 局部新鲜冲突；
- ER：forged aggregate、clone-return replay、crash-after-token；
- AN：committed/no-commit timeout 不可区分。

基线必须包括强成熟组合和同一 transition verifier；若 full ABCA 与强基线在 verdict、linearization witness、certificate projection 上等价，则停止新协议/新 planner 主张。

## 第 11 轮：PC locked pair 的负新颖性结果（2026-09-01）

新增 `ubuddy-cpir-web-pc-locked-pair-v0.mjs`，用同一公共观察构造：

- `PC+`：OAuth predecessor grant 在 frontier 仍 ACTIVE；
- `PC-`：下游 tenant/API/sink atom 仍局部 fresh，但 OAuth frontier 已有覆盖 grant 的 revoke tombstone。

独立 authority-log oracle 给出 `PC+=SAFE`、`PC-=REJECTED`。实验结果：

- 只检查 OAuth/ACL/ETag/本地 freshness 的常见成熟组合无法分离，`PC-` 错误 `SAFE`；
- ABCA predecessor closure 正确分离并输出 revoke frontier witness；
- 给成熟组合加入同一 causal frontier verifier 后，其 verdict 与 ABCA 完全等价。

因此本轮采纳一个重要负结论：**predecessor/revocation closure 是必要机制，但目前没有证明它是 ABCA 独有或不可替代的机制。** ABCA 主张正式降为 Web typed admission profile；不可替代性只能继续从更弱 trust/transaction 假设、结构化 solver、证书最小性或 probe 成本优势中寻找。

VCC/PREE 同时修复 unary dependency filtering，跨 source `dependencyRevisions` 在默认模式下不再误报 UNKNOWN；测试扩展为 18/18。PC pair 测试 8/8。

## 第 12 轮：从 AOC wrapper 收敛到 observation-aware DP（2026-09-01）

- deletion-MUS baseline 与旧 exhaustive conflict registry 在三元 hard conflict 上产生相同 core，确认 AOC wrapper 只是成熟算法包装，不再作为算法创新。
- 旧 AOC/registry 未限制 observation-equivalent cell，不能直接从任意 world subset推出 abstention necessity。
- 新增 observation-aware bounded DP：先在 belief cell 内查 universally-safe terminal action，再尝试 separating probes；任一 losing child 形成显式 obstruction witness。
- AOC-DP 测试 8/8 通过，明确标记 `candidate-equivalent-to-bounded-pomdp-until-proven-otherwise`。

当前最窄方法主张收敛为：`activation-aware Web effect admission + observation-cell fail-closed abstention + replayable obstruction witness`。DP、MUS 和 belief partition 本身不算新算法；若 generic robust-POMDP + 同一 verifier 能产生相同 policy/certificate，停止 planner 新颖性路线。

## 第 13 轮：AOC/DP 负结果与独立 oracle 闸门（2026-09-01）

本轮最重要的结果是负结果而非新增名词：deletion-MUS baseline 与旧 registry 在三元冲突上得到相同 core，说明静态 AOC 不是新算法；AOC-DP 虽然正确地把决策放回 observation cell，但理论上等价于 bounded constrained POMDP。

因此当前只保留一个窄对象：

> Observation-aware, bounded Web admission obstruction certificate profile

它将 activation、cross-authority revoke、escrow/refinement 和 receipt ambiguity 映射到 Web effect witness；不再宣称独立 AOC/DRAS planner。

下一轮唯一算法闸门是 candidate-independent oracle-v1：固定 manifest、fault automaton、observation projector、trust roots 和预算；AOC-DP、deletion-MUS、robust-POMDP、强成熟组合共享同一 raw oracle。若 verdict、linearization witness 和 certificate projection trace-equivalent，立即停止算法/协议新颖性路线。

## 第 14 轮：candidate-independent oracle-v1 与自证风险收紧（2026-09-01）

本轮没有新增协议名，而是实现公平比较所需的基础层：oracle 固定 manifest、trust-root/contract/projector/verifier hashes、预算和唯一 ID；action verdict 由 guard DSL 与 state transition 推导，probe 由只读 projection 推导；timeout、bound、缺证据、未声明对象、重复 ID 和异常全部 fail-closed 为 `UNKNOWN`。AOC-DP 已改为只消费 oracle 表格，禁止任意 evaluator/observe callback。

关键修正是：预填 `safeByWorld/actionResults/probeResults` 被列为非法字段。否则 oracle 只是把答案表换了位置，无法提高实验可信度。

### 新颖性裁决

该增量提升的是技术闭合和可证伪性，不是 planner 新颖性。当前主张继续固定为：

> finite activation-aware Web effect admission + observation-cell fail-closed abstention + replayable obstruction witness interface

当前区间保持：新颖性 `5.8–6.0/10`、技术深度 `7.0–7.3/10`、Web 适配度 `8.3–8.5/10`、实验可信度 `4.8–5.2/10`。没有真实 browser/authority/durable sink，不能升到 Weak Accept。

### 下一步闸门

1. 把 AL/PC/ER/AN paired worlds 编译成 oracle DSL；
2. 在同一 oracle 上实现 deletion-MUS/MaxSAT、robust-POMDP/model checker 和强成熟组合；
3. 比较 verdict、linearization witness、certificate projection、状态展开、调用次数、时间/内存和 probe cost。

若 bounded traces 在预注册指标上 trace/certificate 等价，立即停止算法/协议新颖性叙事，最终定位为 Web effect-contract formalization + auditable certificate interface + falsification benchmark。

### Pair 编译状态

AL/PC/ER/AN 已编译到共享 oracle DSL，测试 `26/26`。这一步只证明四类反例可以用同一 candidate-independent transition profile 表达，不构成新的协议或 planner 证据。

### Shared-oracle 负新颖性结果

独立 robust model checker 与 AOC-DP 在 shared-oracle fixture 上得到相同 policy 和 memo state 数；AL/PC/ER/AN manifest 上 bounded verdict 也等价。strongest mature profile 获得同一 verifier 后逐 action trace 同样等价。comparison 测试 `10/10`。

因此正式执行停止条件：

- 停止 AOC-DP/DRAS/ABCA 的独立算法或不可替代协议叙事；
- 不再通过增加术语、checker、guard 或 fixture 提高新颖性评分；
- 研究定位固定为 **Web typed effect-admission formalization + replayable certificate interface + falsification benchmark**；
- 下一阶段只允许从“证书信息增益、较弱信任/事务假设、真实 Web 生命周期覆盖或可测成本优势”中重新建立不可替代性。

当前新颖性应保守回落到 `5.4–5.8/10`；技术深度维持 `7.1–7.4/10`。这不是方向失败，而是明确了可继续投入的部分和应停止投入的部分。

### 证书信息量闸门结果

CPIR full certificate 与 generic/mature full typed projection 均可完整 replay，native trace/audit 只缺少部分 Web decision-evidence 字段，MUS core 不能重放完整 transition。结论是：当前所谓 certificate advantage 仍是表示层差异，不构成不可替代的新颖性。测试 `18/18`，不提高评分。

### 双故障覆盖结果

新增 AL+PC、AL+AN、PC+ER、ER+AN 四类双故障 manifest；oracle 保留多项 violated guard witness，测试 `17/17`。它增强 falsification benchmark 的诊断能力，但没有改变与 full typed projection baseline 的等价性，因此不提高新颖性评分。

### Durable harness 结果

SQLite/WAL harness 通过 `29/29`：cross-process crash-after-commit 可恢复，事务内失败可 rollback，stale revision 和 duplicate key 被拒绝。该结果增强技术深度和故障真实性，但范围仍是本地研究 sink；不恢复 ABCA/AOC 的独立协议或算法新颖性。

### Signed authority log 结果

Ed25519 authority log 测试 `12/12`：签名篡改、hash-chain break、frontier gap 和 equivocation 均可检测，revoke 可由 signed frontier 推导。它提升 PC 语义可信度，但属于本地 authority profile，不恢复 ABCA 的独立协议新颖性。
