# uBuddy v4 痛点与创新演化（研究目标执行稿）

> 本文档记录当前目标的一轮独立研究、文献排雷、候选创新收敛和顶会式拒稿检查。它只修改研究问题、创新命题、理论目标和实验可证伪性，不修改 uBuddy/Janus 当前代码、API、数据库 schema、运行时协议或实验实现。

## 1. 本轮结论

原始创新不建议推倒重做，但必须从“DAG + provenance + causal + repair + gateway”的模块组合，收缩为一个唯一研究对象：

> **Contract-Preserving Robust Interventional Repair（CP-RIR）**：给定 cross-owner workflow 的当前公开一致切、不可修改的已登记公共硬契约、owner 控制的有限 typed intervention 集合，以及搜索前冻结的 owner-attested 有限抽象世界集，寻找成本最小的有限时域探针—分支—修复计划；该计划在所有声明允许的模型世界和未来轨迹上保持硬契约，同时达到软任务价值下界和相对 no-op 的修复增益下界。保证严格以声明 universe、世界集、owner certificate interface 和 mediation 边界为条件，当前仍是 `planned/unverified`，不是现有系统已经实现的跨组织能力。对声明闭世界之外的真实世界覆盖不作自动保证；若 canonical 输入、typed executability、规划证书或可信执行边界不足，返回带安全公开处置标签及受 ACL 约束的诊断引用（不构成隐私保证）的 `INPUT_INVALID/abstain`。

这一定义目前仍是待形式化的研究命题，不是已经兑现的系统能力。它把原始想法中的三项价值合并为同一个条件性研究对象：

1. **模型条件干预比较**：不是从自然日志猜真实根因，而是在声明有限模型中比较实际可执行 intervention policy 的 value/effect；
2. **契约保持**：修复不能通过删除输入、强化前置条件、改变 evaluator 或把成功改成 exception 来伪造成功；
3. **split-knowledge / split-authority 可执行**：没有主体同时拥有全部私有状态与全部 effect authority；修复动作带 owner、权限、版本、读写集、effect class 和关系证书，并在 gateway 的 fencing/linearization 语义下提交。

population-level repair policy 仍可作为外部效度或基线，但不再与声明世界内的 model-relative policy feasibility 混为一谈。

## 2. 痛点重构

### 2.1 总痛点

跨用户、跨组织 Agent workflow 的失败恢复同时受到部分可观测性、不可修改公共承诺和跨层副作用约束。已有方法通常只解决其中一个子问题：日志/RCA 解释发生了什么，APR 修改代码，replanning 修改计划，Saga/gateway 管理事务，safe policy improvement 给总体分布上的安全更新。它们没有共同定义以下返回对象：

> 在知识和写权限分别掌握于不同 owner、没有主体同时拥有全局私有状态与全部 effect authority、且公共义务不可修改时，仅依据 owner-attested 有限抽象与关系证书，合成一个可执行、契约不弱化、model-relative value/effect 达标且成本可比较的 contingent repair policy；canonical 输入或证书不足时在产生外部 effect 前拒答，并只返回受 ACL 约束的诊断引用，不将其表述为隐私机制。

三类困难应被写成总痛点的约束，而不是三个并列的大贡献：

```text
部分观察       → 哪个 model-relative policy contrast 可计算、可证书化
固定公共契约   → 哪个 repair 合法
跨层副作用/交互 → 哪个 repair 可搜索、可提交、可恢复
```

### 2.2 不可区分失败世界

设公共观察为 `h_pub`，冻结的有限私有候选世界集合为 `M_hat(h_pub)`。以下反例固定同一 ROC、版本哈希和公开失败轨迹：

- 世界 W1：上游 Agent 能力缺失，`patch-capability` 有效；
- 世界 W2：下游缓存绑定旧版本，`bind-version` 有效；
- 两个动作在另一世界分别会触发越权或重复副作用。

如果没有低风险探针或额外可信证书，任何只依赖 `h_pub` 的确定静态 repair 都会在至少一个世界失败。canonical 结果不是扁平五态，而是分层对象的公开投影：

- plan-level：`PLAN_REJECT(π,witness)` 或满足硬安全、精确 `V_rob`、精确 `Δ_rob` 和成本约束的 `PLAN_FEASIBLE`；
- instance-level：所有有限计划均有确定反例时为 `INSTANCE_INFEASIBLE`，存在可行计划时选择 `ACCEPT(π*)`；
- input-validity：canonical manifest、typed executability、规划期 capability/mediation certificate 不完整时为 `UNKNOWN(publicDisposition, access-controlled diagnostic reference)`；该引用只表示访问控制约束下的审计信息，不构成隐私证明；
- execution outcome：资源限制内未完成记为 `TIMEOUT`，`Committed/IN_DOUBT/Finalized` 是正交运行时状态。

`HISTORICAL_VIOLATION/REMEDIATION` 是进入 plan/instance 语义前的前缀分类：cut 之前已发生硬违例时，不运行“全前缀安全 repair”判定。

“世界结论不同就一律 UNKNOWN”并不严谨；在声明闭世界内应返回确定的 plan/instance 语义，真实世界是否落在 `M_hat` 外属于独立的外部效度与 world-set sensitivity 风险，不能由运行时 UNKNOWN 自动检测。

### 2.3 契约弱化逃逸

公共硬契约写为 `C_hard=(Assume,Input,Obligation,Footprint,Projection,Exception,Deadline,Attempt,Freshness,Idem,Auth)`；soft evaluator `U` 独立存在。合法 implementation trace refinement 至少要求：

- 不强化环境责任，不缩小输入域或 scope；
- 不删除、延迟或降格 required obligation；
- 不扩大未授权 footprint，不降低 freshness/version/idempotence/auth；
- 固定 soft evaluator `U`、投影、异常/abstain 语义、deadline/attempt 和 obligation 集合；
- 只允许强化实现保证或减少实现方额外环境依赖。

反例：把失败输入 `x` 从 `I` 移除，再对剩余输入证明 postcondition，不能算契约保持。

### 2.4 历史违例与补偿边界

硬安全 `C_hard/Inv` 要求所有允许前缀不违例；soft evaluator `U∈[0,1]` 独立于公共硬契约；已发生的 effect 属于 `reversible / idempotent / compensatable / irreversible-uncompensatable` 之一。不可逆历史违例不能被称为 rollback，只能输出 `remediation`、`compensation-pending` 或 `manual-abort`。补偿是新的业务动作，不会抹掉历史事实。

## 3. 候选创新池（本轮维护 16 项）

| 编号 | 候选命题 | 分类 | 与已有方法的真正差异 | 当前决策 |
|---|---|---|---|---|
| C1 | Finite closed-world robust repair | 主贡献 | 对冻结 owner-attested 世界集合做 model-relative robust policy synthesis；population ATE、真实根因识别和隐私观察等价不能替代 | 保留为核心 |
| C2 | Probe–branch–repair contingent plan | 主贡献/算法 | 将低风险信息干预和后续 repair 分支统一为 bounded plan，而非静态 patch | 保留，作为 C1 的计划对象 |
| C3 | Anti-evasion public-contract refinement | 主贡献支撑 | 固定输入域、scope、evaluator、obligation 和异常语义，阻止 specification gaming | 保留，必须有形式定义 |
| C4 | Typed CP-RIR with compositional executability | 算法支撑 | 对完整 policy tree 检查 typed action、owner authorization、Gateway capability 与组合 footprint，不把单动作可执行性当作组合可执行性 | 保留 |
| C5 | Layered `INPUT_INVALID/abstain` with access-controlled diagnostic reference | 语义/安全支撑 | canonical 输入无效、规划证书不足与 runtime `IN_DOUBT` 分层；诊断引用只受假设 ACL 约束，不宣称 privacy | 保留 |
| C6 | Causal consistent cut + WorldAtCut | 分布式语义支撑 | repair 只作用当前 consistent suffix，证书绑定因果前沿和快照 | 保留 |
| C7 | Owner-fenced effect witness transaction | 系统支撑 | OFFER/ACCEPT/COMMIT 与 epoch、linearization、pre/post hash 绑定 | 保留为执行基座 |
| C8 | Full-transcript leakage diagnostic | 隐私研究议程 | 测量 proposal、拒绝、重试、时序、补偿等完整 transcript 的泄漏；当前不提供 coalition-safe theorem | 删除出正文贡献，附录/future |
| C9 | Contract-aware Blackwell decision sufficiency | 隐私/决策扩展 | 信号最小性相对于 repair efficacy + safety verdict + ACL，而非只最小字段/互信息 | 降为 future |
| C10 | Adaptive confidence/alpha-spending repair search | 统计扩展 | 候选搜索、删冗余和锁定 holdout 的选择后置信控制 | 降为 learned-model 扩展 |
| C11 | Interaction-width CMRS complexity | 理论支撑 | 一般 NP-hard；有界交互阶/treewidth 时 FPT；强互补时不套次模保证 | 保留一个复杂度结果 |
| C12 | Contract–program–graph typed synthesis | 组合动作类型 | patch/rewire/bind/guard 各自语义和 footprint，联合重验证新增因果路径 | 并入 C4/C6 |
| C13 | Evidence lattice + semantic transaction | 系统扩展 | 证据 token、冲突集合、时效与动作前后置条件的非单调合并 | 降为 future |
| C14 | Population repair policy learning | 另一研究路线 | 估计 `V_pop(π)`，不宣称当前实例充分性 | 仅作基线/后续论文 |
| C15 | Access-diagnostic transcript accountant | 隐私 non-goal | 将授权、拒绝、分支、重试、延迟、补偿、unknown 和证书元数据纳入观察测量；没有 adjacency/mechanism/accountant 就不声称 coalition privacy | 仅附录测量规范 |
| C16 | Split-knowledge/split-authority relational certificate interface | 高风险附录候选 | 在显式 access regime 下研究关系证书的充分性与成本；不把“协调器不读 payload”写成隐私或已实现保证 | Gate B 附录，摘要 no-go |

### 3.1 合并与淘汰

- C1+C2 合并为唯一核心对象：**robust contingent repair**；静态 repair set 是无探针特例。
- C3 作为核心合法性谓词；不是独立论文贡献。
- C4+C11 组成 canonical 算法/理论支撑，只选一个主要复杂度正结果；C10 不进入 exact core。
- C6+C7 组成跨组织执行语义；普通 DAG、provenance、2PC、Saga、hash、签名不单独计贡献。
- C8+C9+C13 暂不作为本论文并列主线，避免从 repair 论文发散成隐私协议论文。
- C14 不与 C1 混用；若未来选择它，必须删除“当前失败充分修复/根因”措辞。
- C15 不升级为独立隐私主线；若无法形式化 transcript alphabet、secret adjacency、coalition view 和 composition accountant，则正文明确声明“不提供 coalition privacy 保证”。
- C16 与 C1/C6/C7 合并评估：若能证明 action-local safe bit 或 top-1 diagnosis 接口不足，而某个 owner-local relational certificate interface 对 CP-RIR 决策充分，它可能成为跨组织不可替代性的真正来源；证明前保持候选，不宣称已成立。

## 4. 收敛后的正文唯一主线与附录支撑

投稿正文的当前唯一贡献身份是 M1。M2′ 只允许作为附录级 access-model 风险检查，M3 只允许作为 M1 的复杂度支撑；二者在 theorem/artifact 未完成前不得出现在 contribution list。consistent cut、certificate、owner authorization、sink fencing、value checker 和 differential benchmark 都是 M1 的条件/证据链，不分别计新贡献。若单篇论文无法同时完成该证据链，应优先收缩为 **contract/runtime-aware certified repair specialization**，而不是继续扩张定理包。

本轮进一步固定正文最小 theorem package：D1（finite closed-world `FEAS_full/FEAS_robust` 与统一 `V/Δ/cost` 语义）、D2（在 `CompleteCutCert`、`CompleteMediation`、`AtomicEffectReceipt`、`CrossSinkInvariant` 和 safety-reflecting simulation 等前提下的 bounded hard-safety soundness）、D3（central-full、有限可枚举 `Π`、total exact oracle 下的 solver soundness/relative completeness/non-vacuity）。D4 受限 factored static-subclass 的 NP-hard 或 exact-DP 结果只能放附录；T5/INDEX 在 theorem、matching upper bound 和 artifact 完成前不进入正文贡献列表。这样审稿人可以用一句话复述论文，而不会把 T1–T5 误解为五个并列贡献。

### 主线 M1（论文核心）：Robust Contract-Preserving Contingent Repair

输入为有限时域 workflow、公开 consistent cut、固定 `C_hard/Inv`、有限 owner 预授权 typed action 库和冻结的 `M_hat(h_pub)`。输出计划 `π=q→branch→R`，满足：

1. 每条分支的 `C_hard/Inv` 均保持；
2. 对所有允许世界，固定 nominal-soft product 下的 `V_m^soft(π)=E_{P_soft^m(·|π)}[U]`、`V_rob^soft=min_m V_m^soft≥η`，且 `Δ_m^soft(π)=V_m^soft(π)-V_m^soft(π0)`、`Δ_rob^soft=min_m Δ_m^soft≥κ>0`；hard safety 与 cost 另对 bounded fault automaton 做 universal/worst-case 量化，`κ≤0` 的变体只能称 utility-feasibility，不能宣称 repair gain；
3. 计划成本、探针风险和副作用可比较；
4. canonical exact 中不能判定时返回 typed `INPUT_INVALID/abstain`；`coverageUnknown` 仅用于 learned/open-world 扩展，不猜真实根因。

这是当前最贴合项目痛点的统一研究对象；它已排除“各模块独立优化、probe 前锁定 repair”的简单串联，但尚未证明不可由完备 contingent planner + 同一 contract/runtime verifier 实现，因此不可替代性仍是待证目标而非既成结论。

#### M1 的可计算语义（第二轮补强）

为避免把符号世界集合误写成经验因果事实，本轮正式锁定 **finite closed-world exact 核心**：给定候选搜索前冻结、非空、相对公共历史闭包的 `M_hat(h_pub)={m_1,...,m_K}`，以及每个世界的有限转移模型/外部快照。`V_rob^soft/Δ_rob^soft` 是模型条件下的 nominal-soft policy-value contrast，不宣传为无模型的个体因果识别。随机干预数据只用于构造/校准 `M_hat`、检查 support 和做外部有效性，不与核心 exact guarantee 混称。

统一有限核心采用技术稿的 world-indexed `W_m`：有限状态/动作/观察/时域、`δ_m`、`Auth_m`、`Exec_m`、`Effect_m`、固定合同 `C_hard/Inv`、soft evaluator `U`、owner/权限元组和 nominal-soft kernel `K_soft^m`。计划为 `π:history→probe/repair proposal`，成本为严格为正且可加的 `cost_probe+cost_repair+cost_coordination+cost_delay+cost_risk`。canonical exact 结论只以搜索前冻结、非空且对所有策略可达 history 闭包的 `M_hat` 为条件；绝不能按“有 support 的世界”过滤掉危险世界。`Pr(m*∈M_hat)≥1−δ_world` 与 sequential positivity 属于后续 learned-model/外部有效性扩展，不进入 exact ACCEPT 的定义；exact manifest 本身仍必须提供可验证快照、版本和 total transition/authorization kernel。干预对象是嵌套的 `π∘Auth_m∘Exec_m` 总 regime，`A_t` 只是 realized action，policy contrast 包含合法拒绝机制；若未来改用数据学习且 owner 授权由私有状态决定，必须估计嵌套 regime `Y^{π,π_auth}` 或将候选限制为预授权模板。canonical 规划 ACCEPT 要求模型内 typed action support、Gateway executability 和 capability/mediation certificate 完整；执行后 effect witness/receipt 只决定 reconciliation 与 finalization。

输出采用分层标签及安全公开投影，而非把所有状态扁平化为一个五态 gate：plan-level 为 `PLAN_REJECT(π,witness)` 或 `PLAN_FEASIBLE`；instance-level 只有在存在同时通过 hard/soft 轴的可行计划时才返回 `ACCEPT(π*)`，所有计划均有确定反例时返回 `INSTANCE_INFEASIBLE`；canonical 输入/规划期证书不完整时返回 `UNKNOWN(publicDisposition, access-controlled diagnostic reference)`；资源受限未完成记为 `TIMEOUT`；`HISTORICAL_VIOLATION/REMEDIATION` 与 `Committed/IN_DOUBT/Finalized` 分别是前缀和运行时正交状态。诊断引用只在假设 ACL 下供 owner/审计使用，不声明 confidentiality、noninterference 或 coalition privacy。`PLAN_FEASIBLE` 必须同时满足 hard safety、`V_rob^soft≥η`、`Δ_rob^soft≥κ` 和 worst-case cost≤k；G05 的 `SOFT_ACCEPT` 只表示 soft 轴通过，不能简写为 `ACCEPT` 或 `PLAN_FEASIBLE`；执行后 effect witness/receipt 缺失不能倒充规划期 UNKNOWN。

若 cut 前已经发生硬违例，只能输出 historical-violation/remediation，不得声称整段轨迹的 safety certificate。`P_soft^m(·|π∘Auth_m∘Exec_m,h)` 诱导的是 nominal-soft policy value，不能直接称为当前实例因果充分性；主判据还需同一 cut、horizon、自然重试和授权过程下的 baseline `π0`，并使用 `Δ_m^soft(π)=V_m^soft(π)-V_m^soft(π0)`、`Δ_rob^soft=min_m Δ_m^soft`，避免把 no-op 自然恢复误报为 repair 增益。若发生 `IN_DOUBT/CommitUnknown`，公开结果必须映射为不可盲目重试的安全处置类，具体 receipt/effect obstruction 仅在私有审计通道返回。

#### 不可组合反例（必须进入理论或微基准）

构造两个公共观察相同的世界 `m_1,m_2`：`m_1` 只有 patch `p` 有效，`m_2` 只有 bind-version `b` 有效；且 `p` 与 `b` 的 footprint 在另一世界分别触发越权/重复副作用。任何“先 active diagnosis，再独立选单个 repair，再做局部 verifier”的串联流程，都会在某一世界误接受或成本超过预算 `k`。集成 CP-RIR 在同一有限 DSL 中必须联合选择低风险 probe、分支和 repair，并对完整计划验证 `C_hard/Inv`，才能在成本 `≤k` 下得到可接受结论；有效 closed-world 输入中，坏计划返回 `PLAN_REJECT`，若所有计划均失败则返回 `INSTANCE_INFEASIBLE`；只有 manifest/certificate preflight 无效才返回 `UNKNOWN`。该反例降为 motivating counterexample：它只排除“模块独立优化、无共享状态/合同反馈、在 probe 前锁定 repair”的架构类，不声称击败任意完备 contingent planner。

### 执行假设 M2：Owner-Fenced Certificate-Carrying Repair Transaction

以 causal consistent cut 为起点，状态机为 `ObservedCut → Diagnosed → Proposed → SupportChecked → OwnerPrepared → VersionFenced → Committing → Committed|IN_DOUBT → VerifiedAtCut → Finalized`，异常/恢复状态为 `Aborted/CompensationPending/Compensated/Stale/Revoked/Unknown/Remediation`。规划期只验证 capability/mediation certificate；执行后 effect witness 才绑定 repairId/generation、owner epoch、输入版本、pre-state hash、完整 change-set、linearization point、持久 receipt 和 post-state hash。无 quorum/fencing、私有证书不完整或外部写入不可观察时，只能阻塞或 unknown；`IN_DOUBT` 必须先做 receipt reconciliation，不能盲目重试。

M2 不是第二项独立创新，而是 T1 hard-safety theorem 的 mediation/TCB 假设，为 M1 中的 `π∘Auth_m∘Exec_m` proposal regime 提供可验证的跨信任域语义。只有未来真正证明跨域 effect-witness composition 或实现独立 Repair Transaction 时，才考虑升级贡献地位。

### 高风险候选 M2′：Split-Knowledge Relational Certificate Interface

若能完成技术稿中的 T5，跨 owner 新颖性可从“用了 Gateway/2PC”提升为一个可证伪的接口命题：仅有 action-local unary 摘要无法同时保持 soundness 与 relative completeness；必须交换受限的 world/action/footprint compatibility relation。但当前反例只对应 distributed-CSP 中常见的 unary-vs-joint correlation 不充分，尚无必要+充分 certificate theorem 或通信/查询下界，因此不计入现有正文主贡献。该命题仍是 `planned/unverified`，且不声称击败拥有同一 relational oracle 的完备 contingent planner。若无法补齐理论，M2′ 降回 mediation/TCB 边界，论文定位为 contract/runtime-aware certified specialization。

### 理论支撑 M3：Support-Aware CMRS 的一个复杂度子类

一般 CMRS decision problem 保留 weighted set-cover 特例的 NP-hard 下界。正结果只选择一个：当完整 contract/transition/world/support 联合因子图宽度、状态/动作/观察字母、policy branch depth 和数值 bit complexity 全部固定或参数化时，尝试 exact DP/FPT。删除真实 robust OPT 的次模近似主张；surrogate 只能评价 surrogate OPT。

投稿正文最多两项贡献：M1 的 finite-world robust contingent repair 问题/算法，以及 support-aware bounded certificate/一个复杂度子类。M2 作为 TCB/mediation assumption，不单独计创新。

### 隐私边界（第三轮补强）

本论文不把 Blackwell-minimal 或 coalition privacy 作为独立主贡献。若保留跨组织隐私措辞，必须定义完整 transcript `T_C`（proposal、authorization/refusal、branch、retry、timing、message length、certificate metadata、unknown disposition、compensation 和 effect outcome）、秘密相邻关系、联盟观察者和 `(ε_priv,δ_priv)`/TV 组合会计，并将 `π_auth` 作为随机选择通道。`alpha-spending/reusable holdout` 只控制统计选择，不提供隐私预算。

在上述形式化和实验完成前，论文只能声称“私有 payload 不由协调器直接读取、隐私是设计约束”，不能声称 noninterference、coalition-safe 或结构泄漏安全。`UNKNOWN` 对外应使用 coarsened/randomized disposition，内部 obstruction witness 只交给 owner/审计者；否则 unknown 类型本身会泄露隐藏世界。

### 跨组织执行边界（第三轮补强）

`WorldAtCut` 不能只包含已记录事件：cut 证书还需包含 in-flight channel state、每个 authoritative resource 的 snapshot/version 和全局 manifest。`ownerEpoch` 只有在每个资源 sink 的线性化点以 epoch/lease + conditional CAS 强制拒绝旧写入时才有意义；registry 元数据或 hash/signature 本身不足以防旁路写入。`effect witness` 必须绑定 actor、repairId、精确资源版本、完整（含传递依赖）change-set、持久 receipt 和独立 read-after-write observer。

COMMIT 后 receipt 丢失进入 `IN_DOUBT`，不能盲目重试不可幂等 effect；分区无线性一致 registry/quorum 时禁止 commit，合并只能产生 conflict/unknown。`VerifiedAtCut` 不等于 `Finalized`，除非有 quiescence、lease 或单调不变量。跨组织主张的必要条件不是固定“三个 owner”，而是至少两个独立管理域、无主体同时拥有全部私有状态与全部写权限、sink-side mediation 和故障注入；否则标题必须收窄为 multi-agent/cross-owner workflow。

## 5. 与相邻研究家族的文献排雷

下表只记录已核验或需人工核验的相邻家族；名称本身不构成创新。

| 家族 | 已有能力 | uBuddy 不应声称的内容 | 只有以下新增才可能成立 |
|---|---|---|---|
| causal diagnosis / active diagnosis | 干预选择、故障诊断、主动实验 | “首次使用 causal/active” | 对当前公开一致世界的 repair sufficiency、支持边界和 sound abstention |
| automated program repair / CEGIS / MaxSMT | 代码补丁与规范满足 | “联合 patch 所以新” | typed graph/version/code action 的统一语义、anti-evasion 和跨层全局证书 |
| workflow/process repair | 重规划、过程模型修复 | “修复 workflow 所以新” | 与 interventional effect、固定契约和 owner effect witness 同时成立 |
| proof-carrying plans / runtime assurance | 计划证明、运行时监控 | “有 verifier 所以新” | 局部证书在 consistent cut、fencing 和 soft-effect 证据下的组合语义 |
| safe policy improvement / OPE | 总体分布的安全策略更新 | “成功率下界就是当前实例根因” | 明确区分 `V_pop` 与 `V_rob`，并在 support/authorization 选择下拒答 |
| Blackwell / selective disclosure / causal privacy | 实验支配、信息泄露与非干扰 | “Blackwell-minimal 字段” | contract-aware decision/certificate sufficiency，且把完整事务 transcript 纳入 ACL |
| 2PC/Saga/CRDT/fencing | 提交、补偿、收敛、版本栅栏 | “gateway/事务本身新” | effect witness 与 repair certificate 在跨 owner、consistent cut 上的联合 soundness |
| adaptive data analysis | reusable holdout、选择后置信 | “一次 LCB 足够” | adaptive repair-set search 的 simultaneous guarantee + abstention correctness |

可确认的具体记录包括：

- `Privacy in Action: Towards Realistic Privacy Mitigation and Evaluation for LLM-Powered Agents`，Findings of EMNLP 2025，DOI [10.18653/v1/2025.findings-emnlp.925](https://doi.org/10.18653/v1/2025.findings-emnlp.925)；
- `Data Provenance in Security and Privacy`，ACM Computing Surveys 2023，DOI [10.1145/3593294](https://doi.org/10.1145/3593294)；
- `Proof-Carrying Plans: a Resource Logic for AI Planning`，PPDP 2020，DOI [10.1145/3414080.3414094](https://doi.org/10.1145/3414080.3414094)；
- `The reusable holdout: Preserving validity in adaptive data analysis`，Science 2015，DOI [10.1126/science.aaa9375](https://doi.org/10.1126/science.aaa9375)。

本轮 Crossref 关键词检索日期为 2026-08-31，关键词包括：`active causal diagnosis`、`workflow repair process mining`、`Blackwell informativeness decision experiments`、`safe policy improvement off policy`、`causal information flow privacy`、`saga distributed transactions compensation`、`assume guarantee compositional verification`、`adaptive data analysis reusable holdout`。自动检索结果仅作为发现入口，未直接把不确定条目写成已核验引用；新增引用需人工核验会议、年份和 DOI。

## 6. 最小理论包与可证伪性

canonical exact 核心只保留以下三类理论目标；统计学习作为独立扩展，不与 exact theorem 混用：

1. **Typed composition soundness**：在 finite-state、bounded-H、WorldAtCut、局部 assume–guarantee、无冲突 footprint、权限/版本/幂等和 gateway 线性化条件下，接受的计划保持 `C_hard/Inv`。
2. **Exact robust decision and non-vacuity**：在冻结非空 `M_hat`、有限 policy tree、total transition/authorization/certificate oracle 下精确计算 `V_rob/Δ_rob`。对有效 canonical 实例，语义答案只有 `ACCEPT/INSTANCE_INFEASIBLE`；`PLAN_REJECT` 是 plan-level witness，`UNKNOWN` 是 input-validity，`TIMEOUT` 是资源受限执行结果。
3. **CMRS complexity**：给出正式 decision encoding 和 weighted set-cover NP-hard 归约；只选择一个完整联合图参数化的 exact DP/FPT 子类，删除次模/多求解器保证。

统计扩展若未来启用，另行定义 `M_hat` outer confidence-set 构造、随机 assignment、estimator、simultaneous confidence 和 `μ^{-H}` 样本复杂度，不修改 exact 核心的 ACCEPT 语义。

canonical exact 微基准必须包含：不可区分世界、primitive 单独可执行但组合不可执行、契约输入域逃逸、TOCTOU 旧 owner 写入、网络分区双提交、不可补偿副作用、always-UNKNOWN 和 post-horizon safety-closure time bomb。主要指标为 hard-contract violation、false completion、分层 verdict/status correctness、`V_rob/Δ_rob` 精确性、repair cost/OPT、stale/duplicate effect、p95/p99 提交延迟和人工确认成本。自适应 holdout/LCB 校准只属于 learned-model 扩展实验。

## 7. 独立审稿评分与阻塞项

本轮综合独立代理和顶会审查：

| 维度 | 当前估计 |
|---|---:|
| 痛点重要性 | 8.0/10 |
| 跨组织特异性 | 5.0/10；只有 split-knowledge/split-authority interface 和独立管理域证据成立后才可能上调 |
| 创新新颖度 | 6.0/10；T5 目前只是候选，尚未形成 communication/certificate lower bound |
| 技术深度潜力 | 8.0/10 |
| 可实现性 | 5.0/10（当前代码尚未实现主张） |
| 条件性 Strong-Accept 潜力 | 约 8/10；前提是关闭五个一票否决项并完成三层证据 |

仍未关闭的一票否决风险：

1. `M_hat(h_pub)` 的生成、有限表示和 external coverage 仍只有 model-relative 条件与敏感性实验；
2. T5 是否能从 unary-interface 反例提升为 certificate-sufficiency 与 relation size/query/round lower bound；
3. T1 的 monitor × abstract LTS × concrete simulation 是否有机器检查 artifact，并能拒绝半提交、旧 epoch、漏队列和隐藏 effect mutant；
4. nominal-soft `K_soft^m`、adversarial-hard safety 与 worst-case cost 的三层量词是否由 oracle 实际重算；
5. `EVAL/SYNTH`、受限 NP-complete 归约和 bounded-treewidth specialization 是否有正式证明；
6. 与相同 relational oracle 的 `Complete-Contingent` 对照是否证实等价或仅在受限 pipeline 上存在 separation；
7. split-authority、sink mediation 和 owner universe 是否有独立部署证据，而非中心模型自我声明。

综合第五轮独立复审，当前设计应标记为 **Borderline/Weak Reject（约 6.0/10）**，而不是 Strong-Accept-capable design。更准确的表述是“方向潜力约 8/10 的条件性研究命题”。在 T1/T2/T4 artifact、T5 接口下界、公平 complete-planner 对照和独立管理域实验兑现前，不能使用 Strong-Accept-capable 作为当前状态结论。

## 8. 下一轮三个可执行任务

1. 锁定有限核心：冻结非空 `M_hat`、唯一成本、动态 regime、typed authorization support 和分层 verdict/status；证明不能按 support 过滤危险世界。sequential positivity 仅在后续 learned-model 扩展中讨论。
2. 给出不可组合反例/定理：证明“active diagnosis→独立 set-cover→局部 verifier→gateway”在 XOR/共享 footprint 世界中误接受或成本超限，而集成计划可行。
3. 形式化 T5 relation/certificate 下界和 T1 最小 artifact，并预注册穷举微基准、locked AppWorld 与至少两个独立管理域的 runner；报告分层 verdict、semantic executability 和 sensitivity，而非只报成功率。

## 9. 本轮修改记录

- 采纳：将 current-instance robust repair 设为唯一核心；将 population policy 降为基线；增加 contingent plan、anti-evasion、set-level support、typed unknown、consistent cut 和 owner fencing。
- 采纳：将 gateway、Saga、2PC、provenance、DAG、solver portfolio 降为执行/证据支撑，不再单独宣称创新。
- 修正：不再写“一致世界意见不同必然 UNKNOWN”；区分完整世界集合下的 REJECT 与证据不完整下的 UNKNOWN。
- 修正：不再把 compensation/forward repair 写作 rollback，不再用 Monte-Carlo 证明零硬违规。
- 未采纳：把 Blackwell-minimal、联盟隐私、认知证据格、双层共同适应作为本论文并列主贡献；原因是会改变论文身份并引入额外成熟研究重叠。
- 明确：本轮没有修改任何当前技术实现。
- 第二轮审稿采纳：补入有限世界/条件分布二选一语义、不可组合反例、系统方向降分和跨组织证据门槛；因此当前仍不宣布 Strong Accept。
- 最终复审修正：当前评分下调为约 5/10 Weak Reject；新增冻结非空 `M_hat`、五态 verdict、PLAN_REJECT/INSTANCE_INFEASIBLE 区分、policy value 与个体充分性区分、progress-sensitive trace refinement 和复杂度非空性约束。
- 第三轮隐私审查修正：新增 C15 transcript privacy boundary；禁止把 payload 隐藏、hash 或 reusable holdout 误写成 coalition privacy，未完成完整 transcript 模型前只保留“隐私约束”而非隐私定理。

## 20. 第六轮：把 T5 从直觉反例收敛为可证伪候选

本轮完成 distributed-CSP/DCOP、关系分解与通信复杂度方向的文献排雷，并由独立顶会代理复核。结论仍是：**不重做 CP-RIR 主线；T5/C16 暂不升级为第二主贡献**。本轮把“unary 摘要看不见联合约束”改写成明确的接口研究问题，而不是把标准直觉包装成新定理。

### 20.1 接口与观察等价必须先固定

公开输入固定为 `x=(cutHash,contractHash,DSLHash,evaluatorHash,budget,threshold,H)`。`Γ_unary` 中 owner 只能回答单动作、单世界投影上的有限字母摘要；查询顺序、轮数、随机性、自适应性、超时、消息长度、时序、hash、cost、拒绝和沉默都属于 transcript，总预算为 `B`。若 unary reply 可见完整 tuple、peer commitment 或未声明上下文，反例失效。

`Γ_rel` 额外允许查询有限 tuple `T=(world/action/footprint/owner-set)` 的 `RelCompat`/联合证书。证书必须绑定 cut/world/contract/DSL/evaluator/Γ hash、epoch/version、action tuple、nonce/expiry，并规定 omission、equivocation、stale、timeout 的 reject/UNKNOWN 处置。签名只证明来源，不证明完整性、无陈旧或无 equivocation。

定义 `S ≡_Γ S'` 为：对任意受 `(B,rounds,randomness)` 约束的协调器，完整 transcript 分布相同。T5 反例必须满足该观察等价，而不是只比较一条静态消息。

### 20.2 T5 的证明义务与下界候选

若 T5 要升级为贡献，必须同时证明 `CP-RIR-FEAS` 的 soundness 与 relative completeness。Soundness 要求所有 `m∈M_hat`、`Auth_m` outcome 和 hard fault/scheduler trace 满足 `C_hard/Inv`、typed execution、value/增益阈值和成本约束，且 sink 只接受同一 tuple/epoch/version 的联合授权并原子写 effect、dedup、receipt。Relative completeness 只相对于可由 `Γ_rel` 生成证书的有效实例，不能宣称任意私有世界集的绝对完整性。

两个可证伪下界候选（均针对 interface-relative `CP-RIR-FEAS^Γ`，不是明文 `M_hat` exact core）：

- `INDEX_d`：A 持有 `x∈{0,1}^d`，在 `attestationCut` 前发送与 `j` 无关的摘要；B 在 cut 后给出 `j`，且禁止回查 A，唯一计划 `π_j={a,b_j}` 的可行性为 `x_j=1`。phase-ordered one-way 下，bounded-error unary transcript 需要 `Ω(d)` bits；若允许按 `j` 重新查询，界限消失，故 `revealOrder/postCutQueryPolicy` 必须是定理参数。
- `PAIR-DISJ_d`：所有 unary marginal、cost、timing、hash 相同，只有隐藏 pair relation 不同。无结构黑盒下，zero-error 判断是否存在可行 pair 需要最坏 `Ω(d)` relation queries/bits；r-ary tuple 可扩展到 `Ω(d^r)`，但这不是所有关系的普遍下界。

匹配上界候选是 bounded-treewidth extensional relation 的 junction-tree DP：若完整 decision/non-anticipativity/executability/contract/world 超图 treewidth≤`w`，且 `Γ_rel` 返回 exact factors，则可在每个 sealed world 上精确合并 safety/value/cost，并给出相对于 `Γ_rel` 的 sound + relative-complete certificate。该 DP 接近既有 WCSP/CSP 结果，新增性只能来自 cut/hash/epoch 绑定、联合授权和 sink enforcement 的端到端语义。若把完整明文 `M_hat` 交给协调器，T5 的通信下界不成立，必须将其作为 central-full 对照而非下界实例。

### 20.3 诚实定位与本轮评分

T5 的可行定位是“受限信息接口的通信/证书边界 + 可验证结构化特例”，不是新的通用规划表达能力定理。若无法完成下界—上界闭环，C16/T5 降回 T1 mediation/TCB assumption，论文采用 `contract/runtime-aware certified specialization` 定位。

本轮总体评分仍为 **6.0/10，Borderline/Weak Reject**；CP-RIR 主线保留，不重做；T5 当前新颖度 **4.5–5.0/10**，完成下界+上界后潜力约 7–7.5/10。没有修改当前源代码、API、数据库 schema、运行时协议或已有实验实现。

本轮文献排雷记录（检索日期 2026-09-01）：Distributed Constraint Optimization Problems and Applications: A Survey，JAIR 2018，DOI [10.1613/jair.5565](https://doi.org/10.1613/jair.5565)；On the Desirability of Acyclic Database Schemes，JACM 1983，DOI [10.1145/2402.322389](https://doi.org/10.1145/2402.322389)；The Multiparty Communication Complexity of Set Disjointness，SIAM J. Comput. 2016，DOI [10.1137/120891587](https://doi.org/10.1137/120891587)；Near-optimal lower bounds on the multi-party communication complexity of set disjointness，CCC 2003，DOI [10.1109/CCC.2003.1214414](https://doi.org/10.1109/CCC.2003.1214414)。这些相邻结果表明 unary/joint correlation、关系连接和 set-disjointness 下界本身不新；潜在新增必须来自 CP-RIR 的 FEAS 量词、证书绑定、联合授权和端到端验证闭环。

## 21. 第七轮后半程：双输入域与 certificate-runtime 闭环

本轮明确将两个问题拆开：

- `CP-RIR-FEAS`：完整冻结 `M_hat/W_m` 对 solver 可见，负责 canonical exact 语义；
- `CP-RIR-FEAS^Γ`：owner 私有世界 sealed，协调器只见 public manifest 与 Γ transcript，负责接口相对的通信/证书结果。

这不是符号微调，而是 T5 是否成立的前提。若明文 `M_hat` 已包含 owner 私有状态，INDEX 通信下界失效；若把所有私有状态放进同一 robust world set，问题可能恒 infeasible。未来论文不得在 exact theorem 与 interface lower bound 之间偷换输入域。

### 本轮保留、合并、降级

- 保留 M1 finite closed-world exact CP-RIR，不改变其 `M_hat` 条件性结论；
- 将 T5/INDEX 降为 `CP-RIR-FEAS^Γ` 的 phase-ordered interface necessity lemma，不计主贡献；
- 将 `Γ_rel`、`Auth_joint`、sink token、fencing、atomic effect/dedup/receipt 合并为一个 certificate-runtime 闭环候选，不再分别宣称创新；
- privacy、noninterference、MPC/ZK、coalition safety 继续排除出当前主线；签名不等于关系真实性或完整性。

### 可证伪升级门槛

T5 只有在以下四项同时完成时才可重新评估：

1. `CP-RIR-FEAS^Γ` 的 soundness 与 relative completeness theorem；
2. phase-sealed unary 下界和 `Γ_rel` matching upper bound；
3. omission/equivocation/stale/receipt-loss/bypass-write mutant 可由独立 oracle 正确分层；
4. central-full、unary、relational、same-Γ Complete-Contingent 在相同 policy grammar 上的差分实验。

本轮审稿判断仍为 **6.0/10，Borderline/Weak Reject**。输入域分离提高了正确性，但没有自动增加新颖性；T5 当前仍约 5.0/10。

## 22. 第八轮：从“Γ 证书即 FEAS”退回三层语义

本轮因果/统计与分布式安全复核发现：`Γ_rel` 不能自动创造 sealed-world 的 `V/Δ` 真值。当前必须严格区分：

```text
FEAS_full(I_pub, θ, π)        # sealed actual world θ 的离线真值
VerifyΓ(I_pub, transcript, π) # 证书是否覆盖真值所需分量
SolveΓ(I_pub, Γ_θ)            # 协调器在接口下的输出
```

正确性目标是 `SolveΓ=ACCEPT ⇒ FEAS_full`，以及在 Γ 完整、可用、可信时 `FEAS_full ⇒ SolveΓ=ACCEPT`。因此 T5/INDEX 暂只保留 deterministic、`H=1`、关系 bit 直接决定 `V_θ^soft=Δ_θ^soft=x_j` 的受限族；一般 sealed-world value/增益需要额外的 attested transition/reward factors 或 `ValueCert` 组合器。

同时修正：有效 `RelCompat=false` 通过 `Auth_joint/Exec` 形成无外部 effect 的拒绝轨迹，因 `V/Δ` 不达标而 `PLAN_REJECT`，不是 hard-contract violation；Γ 合法但信息不足在 T5 valid-input 域计 completeness error，不能伪装成 input-invalid；stale/equivocation 通常是 `UNKNOWN(CERT_INVALID/TCB_UNTRUSTED)+audit`，除非动作语义本身已确定不可刷新。`Γ_rel` 查询总通信还应计入传输的 `log d` 索引，不能笼统写成 O(1)。

本轮没有修改源代码或运行时实现。总体评分仍为 **6.0/10，Borderline/Weak Reject**；T5 约 **5.0/10**，保留为高风险接口 lemma，不升级主贡献。

问题定义最终收口：不再把 `CP-RIR-FEAS` 与 `CP-RIR-FEAS^Γ` 宣传为两个并列研究问题。统一真值为 `FEAS_full(θ,π)` 与 `FEAS_robust(M,π)=∧_{θ∈M}FEAS_full(θ,π)`；central-full 和 sealed-Γ 只是两种 access regime，后者由 transcript 诱导 `Comp_Γ(I_pub,T_Γ)`。T5/INDEX 仅作为该统一语义下的 access-model necessity lemma，从而避免 exact 主线与接口下界在输入域上互相偷换。

必须显式分叉两种 T5 语义：若 `Comp_Γ(I_pub,T_Γ)` 同时包含 `x_j=0` 与 `x_j=1` completion，则 `FEAS_robust(Comp_Γ,π_j)` 必须拒绝；只有声明 trusted singleton attestation/TCB，使 `Comp_Γ={θ_x}` 时，INDEX 的 actual-world gap `FEAS_full(θ_x,π_j)↔x_j=1` 才适用。不能同时使用 robust-over-completions soundness 和 actual-world completeness 而不声明 singleton trust。

隐私边界同步收口：Γ_rel 的优势来自 post-`j` 的额外查询权限和显式 declassification，不是隐私保持。当前不声称 query privacy、coalition privacy、unlinkability、traffic-analysis resistance、noninterference 或 DP；若要隐藏 `j`，必须另建 PIR/OT/MPC/TEE 模型并计入安全参数、证明大小、计算与轮次。`sealed/local-only/opaque` 仅表示 data locality/access control。

## 23. 第九轮：certificate-sufficiency 的非空、完备与单一 completion 约束

本轮新增的核心不是另一个模块，而是对证书语义的封闭：`Comp_Γ` 必须非空、有限可检查，并在 trusted actual-world 模式下包含真实 `θ*`；矛盾 transcript 不能通过制造空 completion 集产生 vacuous ACCEPT。统一目标为 `VerifyΓ ⇒ FEAS_robust(CompΓ,π)`，fixed-plan completeness 与 synthesis completeness 分开，所有候选共享 common `T*`/`M*`，不得按候选删除危险 completion。

这使 T5 的定位进一步收窄为“sealed-state certified access layer 的 necessity lemma”：INDEX 只用于 deterministic `H=1`、trusted singleton 关系值族；一般 sealed-world 的 `V/Δ` 需要 `ValueCert` 或可组合 transition/reward factors。`Γ_rel` 的 post-`j` 查询应计 setup、索引、证明、验证和 declassification 成本，且不提供隐私保证。

本轮没有修改当前技术实现。独立顶会仍给出 **6.0/10，Borderline/Weak Reject**；T5/C16 保留附录候选，不计主贡献。

## 24. 第十轮：冻结 completion 的证书非循环与候选级 UNKNOWN 收口

本轮把上一轮的 `Comp_Γ` 约束进一步收紧为两阶段语义：先由不依赖候选结论的事实 attestation、cut/epoch/version 和 coverage proof 构造非空 `Comp0`，再由 relation/safety/value certificate 对同一 `Comp0Digest` 作全称证明。该修改采纳了因果/统计代理关于 `ValueCert` 自证循环的意见：证书不能先声明 `V≥η`，再用这条声明删掉不利世界。若 Γ 回复真的揭示新世界信息，必须成为有成本的显式 probe/branch，生成新版本并整体重验 `π`、`π0` 与候选集合。

本轮同时修正算法文字中的另一个边界：在 central-full 且 verifier complete 的 canonical 有效实例上，`INSTANCE_INFEASIBLE` 仍要求所有有限计划的完整负证书；在 sealed-Γ 模式中，候选级 `UNRESOLVED` 必须传播为实例级 `UNKNOWN`，不能写成“不存在候选级 UNKNOWN”。有效 `RelCompat=false` 仍仅在负 witness 覆盖当前计划时生成 `PLAN_REJECT`；omission、coverage 不足、stale/equivocation 和 value 无法打开仍属于证书/输入层 UNKNOWN。

### 本轮八候选独立筛选

| 候选 | 本轮处理 | 理由 |
|---|---|---|
| C1 robust closed-world CP-RIR | 保留主线 | 唯一统一研究对象，条件性新颖性来自量词与契约保持的联合定义 |
| C2 contingent probe–branch–repair | 合并入 C1 | 是 C1 的 policy object，不再单独计贡献 |
| C3 anti-evasion refinement | 保留支撑 | 封堵删除输入/改 evaluator 等 specification gaming，但需独立 checker |
| C4 typed compositional executability | 保留支撑 | 将组合 footprint、授权和 gateway 约束纳入同一 FEAS |
| C5 layered verdict/abstention | 保留语义支撑 | 解决 UNKNOWN、PLAN_REJECT、IN_DOUBT 的状态混淆，不宣称新协议 |
| C6 causal consistent cut/WorldAtCut | 合并执行语义 | 是修复作用域与证书绑定条件，不单独计贡献 |
| C7 owner-fenced atomic effect witness | 合并执行语义 | gateway/fencing/receipt 是 soundness 基座，不单独计贡献 |
| C16 Γ-relational certificate / INDEX | 降为附录候选 | 仍缺正式 theorem、matching upper bound 和 artifact，继续不列主贡献 |

### 本轮审稿裁决

五视角与独立顶会代理共同认为：两阶段 `Comp0/M0Digest` 明显提高了 soundness 可审计性，但不自动增加新颖性；它把最危险的证书循环和 ghost-world 风险从主线中移除。当前评分上调为**语义/正确性 6.8/10，整体创新兑现 6.1/10，结论仍为 Borderline/Weak Reject**。若没有 machine-checked checker、独立 oracle、完整 Γ-relative theorem 和公平差分实验，不能称 Strong-Accept-capable；T5/INDEX 仍应放附录或在投稿前删除。

本轮仍未修改源代码、API、数据库 schema、运行时协议或已有实验实现；新增内容均为 `planned/unverified` 研究设计。

## 25. 第十轮补丁：候选查询 side-channel 与 access/filtration 分离

本轮隐私/信息论复核补充了两个 P0，已写入技术稿：

1. `Comp0/M0Digest` 只能阻止证书直接删世界，不能阻止规划器依据 candidate-specific Γ 查询的拒绝、时序、长度、proof size、重试或 early-stop 间接改变 filtration。后续规范必须固定 candidate-independent 的 common transcript，或把 `Obs_Γ` 显式纳入 policy branch，并同步计入 `K_soft`、fault model、baseline、risk、delay 和 cost。
2. `POST_J_REL` 会向决策者增加 `j`/relation observation，可能扩大策略类并改变 FEAS；因此实验不得再笼统声称 access 只改变“可证明性”。应区分 observation-matched（certificate-only 或所有臂共享同一显式 branch）与 adaptive-information（单独测信息增益）两种子实验。

同时明确：普通 `M0Digest=H(...)` 只有 binding，不具 hiding；低熵 completion 可被字典攻击，稳定 digest 产生 linkability。若不采用随机化 hiding commitment 并定义可见性边界，就只能将 digest 泄漏计入通信/信息指标，不得使用 privacy-preserving、opaque 或 transcript-indistinguishable 表述。

本轮进一步把差分实验收紧为 `access × query timing × declassification` 因子设计，并补充 owner 端生成、预计算、padding/恒时化、失败重试、验证、延迟、泄漏和可信硬件成本。当前整体评分修正为：语义/正确性 **6.5–6.8/10**，隐私/接口严谨性 **5.0/10**，实验可归因性 **4.5–5.0/10**，综合仍为 **6.0–6.2/10，Borderline/Weak Reject**。下一步不再扩写主张，先以最小 artifact 验证 common `Comp0`、same-Γ 对照和四类 mutant；若无法形成证据，投稿正文删除显式 T5/INDEX，保留 contract/runtime-aware certified repair specialization 定位。

## 26. 第十一轮：baseline 敏感性与 fault-utility 边界

因果/诊断复核补充了一个必须写入主线的边界：`Δ_rob^soft(π;π0)` 不是对任意 baseline 都单调或可比的因果效应。若候选可以选择更弱的 `π0`，同一 repair 可能仅因 baseline 改变而获得虚假的正增益；若 baseline 包含自然恢复、差异化 retry 或候选相关授权，又会引入 post-treatment/authorization collider。

因此 canonical CP-RIR 固定唯一、不可被候选操纵的 status-quo baseline：同一 cut、horizon、`Auth/Exec`、retry/timeout 和 `K_soft` 下的 `π0=no-op`（proposal 为空，不产生 repair effect）。所有 `ValueCert` 必须绑定 `baselinePolicyHash`；论文只称 `policy-regime gain/no-op contrast`，不称个体反事实因果效应。实验增加 baseline-sensitivity mutant：替换为更强但仍 admissible 的 `π0′` 时，必须报告逐世界 `Δ_m` 变化，而不能继续宣称 gain 不变。

另一个反例是 authorization collider：隐藏状态 `H` 同时决定自然成功与授权，若只在“已授权 episode”上估计成功率，会得到虚假的 100% success；canonical exact evaluator 必须在同一 world 上把拒绝轨迹和 no-op 一并纳入，学习扩展则必须显式估计嵌套 regime `Y^{π,π_auth}`，不能用 public-history propensity 或 authorized-only subset 推出 `Δ`。

最后明确双轴保证：canonical `V^soft/Δ^soft` 使用 nominal kernel，fault adversary 只量化 hard safety、可提交性与 worst-case cost；因此 ACCEPT 不保证 fault-conditioned utility。若需要故障下效用，必须另定义 `K_soft⊗F_dist` 并重新声明阈值与证书。摘要、定理和实验都不得把 nominal policy-value contrast 写成 fault-robust repair efficacy。

## 27. 第十一轮最终收敛：选择 certified-specialization 路线

五个独立视角和独立顶会式复核均认为：当前没有证据支持把 T5/C16 升为 cross-organization 不可替代性主定理；若强行将其与 T1/T2/T4 并列，会使论文从单一研究问题重新膨胀为 umbrella specification。因此本轮做出明确选择，而不是保留两条平行身份：

> **当前投稿主线采用 finite closed-world contract/runtime-aware certified CP-RIR specialization。**

“cross-owner”只描述适用威胁模型和条件：至少两个独立管理域、无主体同时拥有全部私有状态与全部写权限、sink-side mediation 不可旁路。它不是已经证明的 privacy、communication separation 或 planner expressiveness theorem。M2 的 cut/Auth/token/receipt 语义属于 D2 的 TCB/checker obligation；C16/T5 只保留在附录研究议程，正文 contribution list 删除 INDEX 和“unary 必须 relational”主张。

正文最多三项可复述贡献：

1. 一个有限闭世界、不可弱化公共硬契约、nominal-soft/adversarial-hard 分离的 contingent repair decision problem；
2. 一个条件性、可机器反驳的 bounded certificate/safety theorem，以及 plan/input/runtime/safety 的正交 verdict schema；
3. 一个 central-full exact solver/oracle artifact，验证 soundness、relative completeness、non-vacuity、baseline monotonicity 和故障 mutants。

受限 set-cover/联合图复杂度只作附录支撑。跨组织关系证书只有在未来完成 Γ-relative necessity+sufficiency、matching upper bound 和相同 grammar artifact 后，才另行评估是否形成独立论文或升级主线。

本轮候选最终处理：C1 保留唯一核心；C2 并入 policy object；C3/C4/C5 并入 D1/D2 checker 与 verdict；C6/C7 并入 D2 TCB；C11 附录；C8/C9/C10/C13 删除出正文；C12 并入 C4/C6；C14 仅作 baseline/后续论文；C15 仅作隐私 non-goal；C16/T5 附录研究议程，不计当前贡献。

该收敛不会自动提高当前投稿分，但显著降低身份摇摆和证明面风险。当前投稿成熟度仍约 **4.5–5.0/10，Weak Reject**；设计清晰度可上调至约 **7.0/10**。达到 Strong-Accept-capable 的下一道 gate 不再是扩写概念，而是完成 D1–D3 的 machine-checkable 最小 artifact，并证明相同语法/相同 verifier 下没有 soundness 或 completeness 退化。

## 29. 第十三轮：Gate A v1 interface draft 与三个人工金标冻结审查

本轮完成文献排雷与五个独立研究视角复核。相邻家族包括 RVPLAN（DOI `10.5220/0010776500003116`）、Proof-Carrying Plans（DOI `10.1145/3414080.3414094`）、formal contracts in multi-agent reinforcement learning（DOI `10.1007/s10458-024-09682-5`）和 Distributed Private Constraint Optimization（DOI `10.1109/WIIAT.2008.426`）。本轮只将它们作为排雷入口，未根据标题推断未核验的定理或实验结论。

### 29.1 本轮采纳

- Gate A interface draft 使用 `cp-rir-gate-a/v1`，显式 `accessRegime=central_full`；Γ transcript、sealed query 和 declassification 不得污染 D1–D3 ground truth。该版本只是规范草案，不是已锁定可执行 artifact。
- 新增 `inputDomainHash`、`obligationSetHash`、`registeredObligationHash`、`evaluatorSemanticsVersion` 和 `refinementDirection`，将 specification completeness 与 registered-obligation conservation 分开检查。
- Gate A 的 hash/digest/signature 明确为 `integrity_only`，不宣称 hiding、privacy、unlinkability 或 coalition safety。
- `exactWorldOracle` 补充逐世界 `policyValue`、`baselineValue`、`delta`、安全/执行/refinement verdict 和 arithmetic witness；禁止从两个 robust minima 相减构造 `robustDelta`。
- 冻结 G01（empty completion）、G04（min-of-differences）和 G06（authorization collider）的完整参数与 reference derivation；同时保留 G00/G03/G11 作为最小闭环的正向、反循环和 receipt-loss 金标。
- Gate A 的最优性必须检查同成本但 tie-break 更优候选；sealed 模式允许 `FEASIBLE_NOT_PROVEN_OPTIMAL`，不再强行压成二值 UNKNOWN。

### 29.2 本轮拒绝/降级

- Gate B/T5/INDEX 仍为摘要级 **NO-GO**；没有正式 Γ-relative theorem、matching upper bound、完整通信/泄漏成本和 same-Γ artifact 前，不进入正文贡献列表。
- 删除或中性化 privacy-preserving、Blackwell-minimal、query/coalition privacy、DP、noninterference、通用通信 separation 等措辞。
- 不用 central-full artifact 支撑“跨组织特异性”；标题级 cross-organization 仍需独立管理域、sink-side mediation 和真实故障证据。
- 不把 Gate A interface/schema draft 误写成 D1–D3 已证明；状态仍是 `planned/unverified`。

### 29.3 第十三轮审稿裁决

独立审稿综合评分：痛点重要性约 **8.0–8.5/10**，普遍性 **5.5–6.5/10**，跨组织特异性 **4.5–5.0/10**，创新新颖度 **5.5/10**，技术严谨潜力 **7/10**，当前 artifact/readiness **3.5–4/10**，投稿成熟度 **4.5–5.2/10（Weak Reject/Borderline）**。若 A1/A2/A3 独立 artifact 满足 exact verdict/OPT 一致、unsafe false accept=0 和全部 locked mutants，设计潜力约 **7–7.5/10**；这不是当前状态结论。

当前主阻塞：没有真实可运行的 A1/A2/A3、D2 machine-checked transfer、D3 独立 oracle 差分、非平凡 ACCEPT 证据、跨管理域 sink runner 或现实 `Comp0` 覆盖证据。目标继续 active。

## 36. 第十八轮：D2 证据接口收紧，但不新增主创新（2026-09-01）

本轮结论仍是“融合原始创新，不重做”。C1/M1 finite closed-world CP-RIR 继续是唯一正文身份；D2 abstract-to-concrete safety-reflecting transfer 继续是唯一可能把论文从“语义组合与验证工程”提升为技术贡献的待证核。新增的组织—资源—sink binding、fault automaton、trace projection、per-sink receipt/linearization ref 和 G05 paired baseline 只是让失败更容易被独立 checker 暴露，不单独构成新颖性。

### 36.1 采纳与淘汰

- **采纳**：将 D2 的最小 artifact 从任意 faultTrace 草案收紧为带 concrete/abstract model kind、冻结故障自动机、alpha projection、sealed-base binding、owner/resource/sink 关系和 per-sink receipt witness 引用的 input-only contract。
- **采纳**：把 G05 从改变同一 `noop` transition kernel 的数值 mutant 修正为 C0002 同一完整 kernel 上 `π0=noop` 与 `π0′=repair` 的 self-baseline paired sanity；这修复的是因果解释和可审计性，不是新算法，也不宣称一般 monotonicity 已由该退化 mutant 证明。
- **拒绝升级为主创新**：schema 字段、hash/commitment、ACL/ref、receipt/fencing、G11–G16、answer-free lint、structured verdict、有限枚举和受限复杂度结果仍不计为独立 contribution。
- **继续淘汰**：T5/INDEX、privacy/noninterference、Blackwell minimality、communication separation、exactly-once/liveness/Byzantine、cross-organization algorithmic indispensability 不进入摘要或正文强主张。

### 36.2 顶会式判断更新

本轮 artifact 的结构 gate 已通过，但没有产生非平凡 D2 theorem、真实 sink enforcement、独立 reducer 或运行结果。因此创新度不因“字段更完整”上调：当前综合投稿成熟度仍约 **5.0–5.3/10（Weak Reject/Borderline）**，创新度约 **5.2/10**；CAV 约 5.6、ICSE 约 5.1，SOSP/NeurIPS 仍不匹配。方向潜力维持 **7–7.5/10**，前提是完成 machine-checked transfer 并证明其不是普通 planner+runtime verifier 的直接串接。

### 36.3 当前可证伪边界

若独立 checker 发现任一 concrete trace 无法映射到 abstract trace、存在 abstract-safe/concrete-unsafe 反例、owner/sink binding 可被 Org-Binding Twin 改写、receipt/linearization 证据不能重放，D2 主张必须降为“带 TCB 的 certified specialization interface”；若最终只有 schema 和负向输入检查，则不应声称论文有新的跨组织算法贡献。所有本轮新增能力均为 `planned/unverified`，本轮没有修改 Janus/uBuddy 实现。

## 37. 第十九轮：D2 非拼接性候选复盘与文献排雷（2026-09-01）

### 37.1 文献排雷记录

本轮通过 DBLP/Crossref 做了定向检索（检索日期 2026-09-01）。检索只用于排除“成熟组件换名”，不把相邻工作当作已证明重叠：

| 研究家族 | 可核验来源 | 与本项目的重叠 | 当前真实差异/风险 |
|---|---|---|---|
| proof-carrying code | Necula, POPL 1997, DOI [10.1145/263699.263712](https://doi.org/10.1145/263699.263712) | 证明随执行对象携带、验证器独立 | 我们不能把“certificate + checker”本身算创新；差异必须落在跨世界 CP-RIR 的 transfer semantics |
| distributed runtime verification | *Runtime Verification for Decentralised and Distributed Systems*, 2018, DOI [10.1007/978-3-319-75632-5_6](https://doi.org/10.1007/978-3-319-75632-5_6)；SRDS 2021, DOI [10.1109/srds53918.2021.00044](https://doi.org/10.1109/srds53918.2021.00044) | 分布式事件、局部监视器、运行时违例 | sink trace/monitor/fault replay 不能直接构成新颖性；新增点只能是 repair-planning 与 safety-reflecting transfer 的联合性质 |
| assume–guarantee / component theories | *Compositional assume–guarantee reasoning for input/output component theories*, 2014, DOI [10.1016/j.scico.2013.12.010](https://doi.org/10.1016/j.scico.2013.12.010) | 组件假设—保证、组合验证 | D2 的组织边界若只有 ref/布尔字段，就是普通 compositional verification；必须证明 effect-complete cross-sink transfer 的特定反例与闭包 |
| TLA+/refinement | *Refinement of Distributed Object Systems*, 1997；*Refinement Types for TLA+*, 2014, DOI [10.1007/978-3-319-06200-6_11](https://doi.org/10.1007/978-3-319-06200-6_11) | concrete→abstract refinement、状态映射 | α projection、bad-state reflection、terminal closure 必须是可重放语义，不可只写字符串 witness |
| Saga/compensation | Garcia-Molina & Salem, *Sagas*, 1987（本轮未从 API 返回可核验 DOI，标记待人工核验） | forward repair、不可逆副作用、补偿 | 我们只能使用 compensation/forward repair 语义，不能宣称 rollback 或 exactly-once |
| reactive shield/synthesis | 检索词 “shield synthesis reactive systems safety”（本轮 Crossref 返回结果不具唯一性，待人工核验） | 在线阻断不安全动作 | shield 不是 CP-RIR；若没有有限干预支持、成本和跨世界 robust value，不纳入主线 |

结论：当前能避免成熟组件重叠的唯一候选，仍是“有限跨世界 repair policy + 可证明的 concrete-to-abstract safety-reflecting transfer + fail-closed coverageUnknown”。其余内容最多是支撑模块或实验边界。

### 37.2 八个候选的独立淘汰表

| 候选 | 处理 | 理由 |
|---|---|---|
| C1 finite closed-world CP-RIR | **保留主线** | 唯一完整研究对象，明确 hard safety、soft utility、有限干预和 abstain |
| C2 contingent intervention policy DSL | **并入 C1** | 是策略表示，不是独立贡献；需作为 typed policy object |
| C3 effect-complete α transfer | **保留为 D2 待证核** | 可能超出普通 planner+monitor，但必须 proof-producing、machine-checked |
| C4 owner/resource/sink binding | **并入 D2 TCB** | 解决 Org-Binding Twin，字段本身不新颖 |
| C5 receipt/fencing/linearization | **并入 D2 TCB** | 正确性前提与执行证据，不单列贡献 |
| C6 coverageUnknown/abstention calculus | **并入 C1/D1** | 是安全边界与 verdict 语义，不是单独算法 |
| C7 baseline monotonicity / collider tests | **保留为可证伪实验** | 反例和 oracle gate，不能作为方法创新 |
| C8 Γ-rel / privacy / INDEX | **淘汰出正文** | 无 theorem、matching lower bound、same-Γ artifact；容易被成熟信息共享/隐私工作击穿 |

### 37.3 本轮主张与评分

本轮采纳“局部重做 D2 proof kernel、保留 C1 论文身份”，拒绝继续以增加 schema 字段代替理论进展。独立审稿综合判断：当前创新度 **4.8–5.2/10**，投稿成熟度 **5.0–5.3/10（Weak Reject/Borderline）**；CAV **5.5–5.8**、ICSE **5.0–5.3**，SOSP/NeurIPS **<4**。完成 product-level A2 checker、至少一个正向 transfer case、一个 Org-Binding Twin 负例和可重放 receipt/linearization 后，方向潜力约 **7–7.5/10**。

当前不满足 Strong-Accept-capable 的一票否决项：

1. 仍没有独立 A2 semantic checker 和 proof-producing output；
2. D2 v0 未承载完整 `BadConcrete/BadAbstract`、horizon closure、scheduler/crash/communication fault 和 policy-tree semantics；
3. 现有 D2 fixture 仍是拒答路径，缺少 complete-mediation 正向证据；
4. G05 self-baseline sanity 是退化测试，不能替代严格 dominance paired mutant；
5. 跨组织边界和 sink evidence 仍可被同构 JSON/ref 伪造。

本轮没有修改当前 Janus/uBuddy 技术实现；新增研究能力全部保持 `planned/unverified`。

### 29.4 下一轮三项可执行任务

1. 生成并冻结 Gate A v1 的 machine-readable manifest、locked corpus hash、唯一复现命令和预期输出 hash；不修改 Janus runtime。
2. 对 G01/G04/G06 做独立 reference semantics 手工演算，并把 `Input/Candidate/Instance/Optimality/Runtime/Safety` null/NOT_EVALUATED 规则写成表格。
3. 让 Gate B 保持附录级 diagnostic；若没有正式 theorem、matching upper bound 和公平 same-Γ artifact，从所有摘要/贡献/结论中删除 T5/INDEX/隐私强表述。

## 32. 第十五轮：原始创新继续融合，不重做；把 artifact 从“自证草案”收缩为独立可反驳设计

本轮不新增主创新，也不推倒原始方向。C1 继续作为唯一核心；C2 并入 contingent policy object；C3–C7 继续作为 contract checker、typed executability、consistent cut、sink mediation 与执行证据链；C11 仅保留受限复杂度附录；C8/C9/C10/C13/C15 不进入正文贡献；C16/T5/INDEX 继续 Gate B 摘要级 NO-GO。

独立复核发现：如果 A1/A2/A3 能读取与实例放在同一 manifest 中的 expected verdict 或预计算 `worldValues`，它们可以回显答案，形成新的 soundness 自证循环。因此新增的结构化 verdict 与 runtime gold 只能计为“可证伪接口设计”，不能计为验证结果。正式 artifact 必须把原始 finite model/policy grammar 与 runner 私有 expected corpus 分离，并在输出封存后比较两个独立 hash。

G03 与 G11–G16 进一步分层：candidate-specific world filtering 是 artifact invalid，不是正常 instance UNKNOWN；receipt loss、half-commit、hidden effect、TOCTOU、old owner/generation、post-horizon time bomb 分别拆为 preflight evidence failure、冻结模型内 fault counterexample 和 deployed-runtime conformance failure。这样可避免把 planning UNKNOWN、runtime IN_DOUBT、confirmed HARD_VIOLATION 和 infeasibility witness 混为一类。

### 本轮对新颖性的判断

这些修正提升语义清晰度、可审计性和拒绝错误主张的能力，但不提升实质新颖性。schema、receipt、fencing、双 sink 和 gold mutants 本身仍是验证工程。能够真正提高论文创新度的条件仍只有一条：完成一个非平凡、机器可检查的 D2 abstract-to-concrete safety-reflecting transfer，并以真实 mediation evidence 证明其边界不是普通 planner+runtime verifier 的直接拼接。否则最终身份应保持：

> finite closed-world, contract/runtime-aware certified CP-RIR specialization

当前独立顶会评分约 **5.0–5.3/10，Weak Reject/Borderline**；方向潜力仍约 **7–7.5/10**。Gate A 与 Gate B 均未通过，不能使用 Strong Accept 或 Strong-Accept-capable 的完成式措辞。

### 本轮采纳与拒绝

- 采纳：统一 `{status,reasonCode,witnessRef}`；将 G09/G10 证书不确定性移入 Gate B；为 G03/G11–G16 建立 runner-side 三层 gold 草案；明确 old owner 与 old generation 分测；固定答案隔离规则。
- 拒绝：把上述字段和负例当成跨组织新协议、privacy、exactly-once、liveness、Byzantine 或通信复杂度贡献；把受限 NP-hard/FPT 结果包装成一般规划突破；把 planned payload 写成已实现能力。

### 下一轮三个任务

1. 真正拆分 `instanceManifest` 与 `lockedExpectedCorpus`，删除 artifact 输入中的 expected/worldValues，并给出两个可复现内容 hash。
2. 为 `ArtifactVerdict/PlanningVerdict/ExecutionVerdict` 写闭合 JSON Schema，加入 candidate vector、enumeration coverage、negative witness set 和联合不变量。
3. 将 runtime gold 草案中的 token、receipt、sink event 与 concrete/abstract simulation payload 连接到独立 A2 checker 规格；仍不修改当前技术实现。

## 33. 第十六轮：隔离证据不等于新颖性，Gate A 明确为 central-full specialization

本轮五个独立视角的共同意见是：答案隔离和唯一 reducer 是证据链必要条件，但不是新的 CP-RIR 算法贡献。它们修复了 EchoSolver 回显金标、candidate vector 缺失和 runtime/planning 轴混淆等一票否决漏洞，却没有把 C1 以外的候选提升为主贡献。

### 保留、合并与降级

- **保留**：C1/M1 finite closed-world contract-preserving robust interventional repair；G04/G06 和不可区分世界作为语义反例；D2 transfer 作为唯一待证的新技术核。
- **合并**：输入/金标隔离、三层 runtime gold、结构化 verdict、owner-fenced transaction、G11–G16 统一归入 artifact integrity、TCB 和 conformance evidence chain。
- **降级/淘汰**：跨组织不可替代性、privacy/noninterference、exactly-once/liveness/Byzantine、T5/INDEX、Blackwell minimality、通信下界，除非未来交付正式 theorem、same-Γ 对照和独立管理域 runner。

### 研究对象边界

Gate A `central_full` 给 solver 完整 finite world/transition/auth/effect/reward payload，因此只能支持“central-full exact specialization”的 D1–D3 正确性目标；它不能验证 sealed-Γ、owner-local hidden relation 或跨组织隐私主张。跨组织只保留为条件性威胁模型和未来 D2 实证边界。

当前综合评分仍为 **5.0–5.3/10（Weak Reject/Borderline）**，创新度约 5.2；本轮的隔离修订提升的是可复现性和严谨性，不是 novelty。方向潜力约 7–7.5/10，但依赖真实 D2 machine-checked safety-reflecting transfer、独立 sink runner 和完整候选全集证据。

### 下一轮三个任务

1. 对两个 answer-free input payload 运行递归引用闭包 lint，移除所有回指 combined/expected 文件的路径和 hash 暴露，并定义进程级 ACL 证据格式。
2. 以 `ubuddy-cp-rir-verdict-v1.reducer-invariants.json` 为规范，生成一个不含 expected 的 candidate vector/output fixture，仅由 comparator 注入私有金标。
3. 继续独立复核 D2：若抽象到具体的 safety-reflecting transfer 仍可被普通 planner+runtime verifier 直接替代，则删除跨组织/算法不可替代性措辞，不重做 C1。

## 34. 第十六轮补丁：安全派生字段与 baseline 对照不计为创新

本轮补丁进一步确认：删除 `hardTraceVerdicts`、补充 G05 baseline′ 输入、修正 runtime patch 路径，都是为了避免错误证据和不可执行 mutant，不增加 C1 以外的新颖性。G04/G06 仍是 model-relative policy-regime 语义边界；它们不识别 current-instance root cause，也不证明 population efficacy。

当前可接受的最小主张仍是：在 `central_full`、finite closed-world、固定 `Comp0/Π/π0`、完整原始 transition/auth/reward/contract payload 和强 TCB 前提下，CP-RIR 可以作为待 artifact 验证的 contract/runtime-aware certified repair specialization。任何 cross-organization、privacy、communication 或 algorithmic-indispensability 主张都需要额外的 sealed-Γ 定理、same-Γ 对照和独立管理域证据。

## 35. 第十七轮：从“结构草案”推进到可拒绝非法输出的 verdict gate

本轮没有改变主创新。新增的价值是：`ubuddy-cp-rir-verdict-v1.schema.json` 已将 Artifact/Planning/Execution 三层输出、candidate vector、worldwise witness 和 runtime conformance 约束写成可编译 schema，并对四类明显非法联合输出完成负向检查。该进展提升的是 correctness hygiene 和可证伪性，不是 novelty 跃升。

独立审稿仍应把以下内容打回为“非创新”：schema 字段、reducer invariants、answer-free closure、receipt/fencing、G11–G16 mutant。论文唯一可保留的主线仍是 C1/M1；D2 safety-reflecting transfer 是唯一待证技术核。

当前评分维持 **5.0–5.3/10（Weak Reject/Borderline）**。若后续只证明 schema 负向检查，而没有独立 A1/A2/A3、完整候选覆盖和真实 sink evidence，不得上调到 Strong-Accept-capable。

## 31. 第十四轮：Gate A/ Gate B / legacy OCCC 范围隔离

本轮的核心修正不是增加创新点，而是防止不同实验轨道共享编号却被误读为同一证明。`cp-rir-gate-a/v1` 只接受 `central_full + finite closed-world + A1 可重算` 的 correctness case；G07、G17、`POST_J_REL`、declassification 和 learned/open-world support case 只能放入 Gate B diagnostic。G03 在 Gate A 中表示 artifact invalid（candidate-specific world filtering），不能作为正常 sealed candidate UNKNOWN。

旧 OCCC `T0–T5` 计划与当前 CP-RIR `D1–D3` 不是同一编号体系：OCCC T2 的 full-state→certificate simulation 仅可作为 D2 的待重写证明义务，OCCC T4 progress 与当前 bounded-safety non-goal 冲突，OCCC T5 observation projection 只能作为 Gate B 附录。旧计划本轮不修改，论文材料中应标记为 `legacy/superseded-for-CP-RIR`，并建立 theorem→artifact→experiment 映射后再引用。

独立审稿因此维持：Gate A 是严谨性与可复现性 gate，不是新颖性自动增益；Gate B/T5/INDEX/隐私/通信 separation 仍为摘要级 NO-GO。正文唯一身份继续收敛为 `finite closed-world, contract/runtime-aware certified CP-RIR specialization`。

## 30. 第十三轮补丁：manifest 字段完整性与 Gate B 最终 NO-GO

独立顶会复核进一步检查了新增 `cp-rir-gate-a/v1` 示例 manifest。该 interface draft 现在包含 `publicDisposition`、G02/G05/G07–G18 case 条目、canonicalization 规则和 hash 的 `integrity_only/hidingClaim=none` 标记，并新增一个可由 Ajv 编译的 JSON Schema draft。它仍是 `illustrative_v0_draft`：多数 case 只有 expected disposition，没有可重算的 transition/effect/reward payload；`manifestHash`、`lockedCorpusHash`、版本和预期输出 hash 尚未计算，不能称为 locked corpus 或可复现 artifact 已完成。

本轮最终裁决如下：

- Gate A 只能先冻结 schema/金标，尚未通过 correctness gate；CAV/ICSE 的潜在价值来自之后真正实现的 D2 transfer 与 D3 独立 oracle，而不是字段数量。
- Gate B/T5/INDEX 摘要级 **NO-GO**。当前没有正式 Γ-relative soundness/completeness、matching upper bound、same-Γ Complete-Contingent artifact、完整 transcript accountant 或真实 sink enforcement。
- Gate A 不应支撑跨组织特异性、隐私、通信分离或算法不可替代性；最终摘要应优先写成 finite closed-world central-full contract/runtime-aware certified specialization。

本轮没有发现需要新增主创新。C1 保留；C2–C7 继续作为其 policy/checker/TCB 证据链；C8/C9/C15 降为隐私边界或未来工作；C11 仅附录复杂度；C16/T5 仅附录诊断。当前综合评分维持 **4.8–5.2/10，Weak Reject/Borderline**，Gate A 设计可实现性约 **6.5/10**，完成独立 artifact 后潜力约 **7–7.5/10**。

## 28. 第十二轮：拆分 Gate A/Gate B，修复 FEAS–Γ 循环

本轮五个独立视角和独立顶会审稿共同发现：原有“唯一 gate”同时要求 D1–D3 正确性闭环和 Γ/T5 接口新颖性差分，导致 ground-truth 语义、证书可得性和隐藏信息集混用。本轮不扩写新理论，而是做两项边界修正。

### 28.1 采纳的语义修正

- **FEAS 与 VerifyΓ 分层**：`FEAS_full/FEAS_robust` 现在只由有限模型语义决定（hard safety、typed/joint executability、不可弱化 refinement、nominal `V/Δ`、worst-case cost）；`Verify_Γ` 只判断 owner transcript/certificate 是否足以证明或反驳 FEAS。central-full oracle 不得调用 Γ 证书作为真值，避免 `Verify⇒FEAS` 变成循环定义。
- **空 completion 提前失败**：`Comp0=∅`、矛盾 transcript、digest/canonicalization 不一致在候选验证前返回 `Input=UNKNOWN`、`Plan=NOT_RUN`，不再作为候选级 `UNRESOLVED`。
- **可行性与最优性分层**：sealed-Γ 若已有已证可行计划但更低成本候选 `UNRESOLVED`，允许返回 `ACCEPT` + `FEASIBLE_NOT_PROVEN_OPTIMAL`；只有所有更低成本候选均有完整负证书才可声称 `OPTIMAL_WITHIN_Π`。
- **独立性成为 artifact 要求**：concrete explorer、abstract checker、solver 与 exact oracle 不得共享 evaluator、parser、canonicalizer、verdict reducer 或 replay 逻辑；最多共享冻结 schema、公开 test vectors 和输入 manifest。

### 28.2 两个嵌套 gate

1. **Gate A（必过）**：finite closed-world D1–D3。固定同一 `Comp0`、`Π`、`π0`、contract/evaluator、fault bound、token schema 和预算，验证 `FEAS`、D2 abstract-to-concrete safety transfer、D3 finite solver soundness/relative completeness/non-vacuity/OPT。至少包含一个非平凡可行实例，并对 empty completion、candidate filtering、wrong ValueCert、stale/equivocation、baseline monotonicity、authorization collider、hidden effect、TOCTOU、cross-sink half-commit 和 receipt loss 逐项检查。
2. **Gate B（可选附录）**：Γ/access/T5 diagnostic。单独固定 observer filtration、timing/length/status/padding/retry/declassification 和通信成本，比较 central-full、unary-Γ、relational-Γ、same-Γ Complete-Contingent。先做 observation-matched，再做 adaptive-information；若同 Γ 的完整 planner 与 CP-RIR 等价，只能保留 specialization/efficiency 定位。

Gate B 失败只删除 T5/INDEX、privacy 或 communication-separation 主张，不否定 Gate A；Gate A 失败则不能声称 D1–D3 已证明或跨组织安全修复已实现。该拆分使论文唯一身份保持为：

> **finite closed-world, contract/runtime-aware certified CP-RIR specialization**

而“cross-owner/cross-organization”继续只作为 split-knowledge、split-authority 和 sink-side mediation 的条件性威胁模型，不作为尚未证明的通信或隐私定理。

### 28.3 本轮评分与必须打回

独立顶会审稿评分：痛点重要性 **8.5/10**，普遍性 **6.5/10**，跨组织特异性 **5.0/10**，创新新颖度 **5.5/10**，不可替代性 **4.0/10**，技术严谨性 **6.5/10**，当前投稿成熟度 **4.5/10（Weak Reject）**。形式化/因果/安全视角给出的整体区间为 **4.5–5.2/10**，方向潜力约 **7–7.5/10**。

本轮继续打回：把 D1 定义、D3 有限枚举、D2 强 TCB 前提或普通 hash 写成新颖定理/隐私保证；把 same-Γ planner 未完成的差分当作 CP-RIR 算法优势；把 `Δ` 写成因果效应或 fault-robust utility；把 planned artifact 写成已实现能力；把 `FEASIBLE_NOT_PROVEN_OPTIMAL`、`UNKNOWN`、`IN_DOUBT` 压成一个布尔成功率。

### 28.4 下一轮最小三项任务

1. 冻结 Gate A 的版本化 machine-readable schema、实例/突变集 hash、唯一复现命令和失败阈值；完成 A1/A2/A3 独立性清单。
2. 将 `FEAS`、`Verify_Γ`、`CheckCompletionSet` 和分层 verdict 写成一份无循环的 reference semantics 表，并人工演算最小反例（错误 `min-min`、authorization collider、空 completion）。
3. 在不改当前 Janus 实现的前提下，决定 Gate B 是否仅作为附录；若没有正式 Γ-relative theorem、matching upper bound 和 same-Γ artifact，则从摘要/贡献列表删除 T5/INDEX/隐私措辞。

## 38. 第二十轮：修正 effect-stutter 矛盾，并把 G05 升级为严格 paired diagnostic（2026-09-01）

本轮继续采用“保留 C1、局部重构 D2 proof kernel”，不重做论文方向。唯一正文身份仍为：

> finite closed-world, contract/runtime-aware certified CP-RIR specialization

### 创新候选的处理

- **保留主线**：C1 finite closed-world CP-RIR；它的价值是把 hard contract、typed executability、worldwise robust improvement 与 runtime conformance 放进同一可拒答研究对象，而不是发明这些成熟模块。
- **保留唯一待证核**：C3 effect-complete abstract-to-concrete transfer。D2 只有在 machine-checked product semantics、正向 complete-mediation fixture 和真实 sink enforcement 下，才可能把 novelty 从组合工程提升为技术贡献。
- **合并**：C2 policy DSL 并入 C1；C4 owner/resource/sink binding 与 C5 receipt/fencing/linearization 并入 D2 TCB；C6 `coverageUnknown` 并入 D1/verdict。
- **保留为实验而非 contribution**：C7 G04/G05/G06。G05 现采用独立固定 K05、严格不同于 candidate 的 `incumbent_recovery` baseline，并只改变 baseline reference；G06 继续防止 authorization-collider 错判。
- **淘汰正文强主张**：C8 Γ/privacy/INDEX，以及 Blackwell minimality、communication separation、exactly-once/liveness/Byzantine、跨组织算法不可替代性、current-instance root cause 和 population efficacy。

### 本轮新颖性判断

修正 `COMMIT_R→STUTTER`、细分 verdict taxonomy 和增加 strict G05 都属于严谨性修复，不能单独提升 novelty。当前创新度仍约 **4.8–5.2/10**，综合投稿成熟度 **5.0–5.3/10（Weak Reject/Borderline）**；CAV 约 **5.5–5.8**，ICSE 约 **5.0–5.3**，SOSP/NeurIPS 仍低于 4。若完成真正 machine-checked D2、正向 transfer、Org-Binding Twin 和真实 sink enforcement，方向潜力约 **7–7.5/10**；这不是当前结果。

### 强接收阻塞项

1. D2 checker 仍只是 `planned/unverified` invariant contract，不是独立实现或 machine-checked proof；
2. 当前主 D2 fixture 仍明确 `completeMediationClaim=false`，且 sink-ledger 有 bypass writer、缺原子 effect+dedup+receipt；
3. 尚无正向 complete-mediation case、独立 credential-domain attestation 或能区分 Org-Binding Twin 的 sink-side witness；
4. `BadConcrete/BadAbstract`、scheduler/crash/communication fault 和完整 terminal policy semantics 尚未物化；
5. G05 strict pair 已有 answer-free schema/input 和私有金标算术，但尚无独立 reducer、support checker 与真实 digest 输出。

本轮没有修改 Janus/uBuddy 当前技术实现；所有新增研究能力均为 `planned/unverified`，目标继续 active。

### 下一轮三个任务

1. 定义最小正向 D2 complete-mediation fixture，并让同一只读 checker 对正例和 effect/reflection 负例产生不同结构化 verdict。
2. 建立 Org-Binding Twin：公开 trace/成本/局部结构相同，只改变隐藏 credential→owner→authoritative-sink 关系，并要求真实 attestation/sink enforcement 区分。
3. 为 strict G05 实现独立 answer-free reducer，输出六个 digest、逐世界 arithmetic、support 与 dominance witness，并对缺 support 先返回 `coverageUnknown`。

## 39. 第二十一轮：正向 D2 必须重构 fault semantics，G05 进入可运行 reducer 原型（2026-09-01）

### 本轮独立审查后的定位

五个研究视角和独立 CAV/ICSE/NSDI 审稿一致指出：当前 D2 的 frozen LTS 含有可达 `BYPASS_WRITE/STALE_WRITE→c-violation`，不能通过把 mediation/receipt 布尔值翻成 true 来制造正例。正向样例必须区分“攻击尝试被拒绝”和“未授权 effect 已应用”：前者是 `REFUSED_ATTEMPT→REFUSAL_SAFE` 且 version/receipt 不变，后者只放在负例中并映射到 `UNMEDIATED_EFFECT`。

因此新增 [D2 positive/negative pair](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-d2-positive-negative-v0.input.example.json) 与 schema。P001 使用 `EXHAUSTIVE_UP_TO_H`，枚举 nominal success、bypass/stale rejected 三条终止路径；P002 使用 `COUNTEREXAMPLE_WITNESS_ONLY`，只承载已应用 bypass effect。当前仍是 `planned/unverified`，不等于 D2_SOUND。

### Org-Binding Twin

新增 [Org-Binding Twin input](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-org-binding-twin-v0.input.example.json) 与 schema。两个 twin 共享公开 pre-effect prefix、proposal、动作、成本、contract/policy digest 和 public prefix digest；只通过 credential-domain→owner→authoritative-sink 的独立 attestation、sink challenge 和 post-effect outcome 区分 GOOD/ BAD。GOOD 拒绝旧 owner 且 version 不变，BAD 接受并产生 version/receipt 变化。该 artifact 仍不能证明真实跨组织管理域，除非未来由独立密钥和真实 sink runner 重放。

### G05 reducer 原型

新增只读 [G05 reducer prototype](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-g05-reducer-v0.mjs) 与 [reducer invariants](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-g05-reducer-v0.invariants.json)。原型实际执行：静态 answer-key denylist、canonical arm materialization、policy hash 重算、Auth/Exec/transition support、exact rational replay、`min_m(V_m(π)-V_m(π0))` 聚合、逐世界 dominance 和 eta/kappa/cost 门槛。实跑得到 base `SOFT_ACCEPT`、variant `SOFT_PLAN_REJECT(DELTA)`，但输出明确标记 shared-envelope pair binding 尚未达到独立双文件证明。

### 保留、合并、淘汰与评分

- 保留 C1、C3 和 G04/G05/G06；C3 仍是唯一可能提升实质 novelty 的 D2 核。
- 合并 C4/C5、fault replay、Twin attestation、receipt/fencing、`coverageUnknown` 到 D2 TCB/verdict；它们不是独立贡献。
- 淘汰 privacy/INDEX/T5、通信分离、exactly-once/liveness/Byzantine、current-instance root cause、population efficacy 和 algorithmic indispensability 的正文强主张。
- 当前创新度 **4.8–5.2/10**，综合成熟度 **5.0–5.3/10（Weak Reject/Borderline）**；CAV **5.3–5.8**、ICSE **5.0–5.5**、NSDI **3.5–4.3**。完成独立 A2、真实 sink enforcement、Twin 双域证明和 differential planner+monitor go/no-go 后，才有 **7–7.5/10** 条件性潜力。

本轮没有修改 Janus/uBuddy 当前技术实现；新增能力均为 `planned/unverified`，目标继续 active。

### 下一轮三个任务

1. 将 positive/negative D2 pair 接到最小 proof-producing checker，并显式区分 `D2_SOUND`、`MODEL_COUNTEREXAMPLE`、`WITNESS_INVALID`、`UNKNOWN_INPUT_NOT_PROVEN`。
2. 将 Org-Binding Twin 从自包含 artifact 推进到独立 credential/sink challenge witness；补同公开 prefix 的 structural equality checker。
3. 将 G05 reducer 从 shared-envelope 派生 pair 升级为双输入 canonical diff，并对缺失 candidate grammar/safety payload 维持 fail-closed。

## 40. 第二十一轮安全复核后的降级：正向 fixture 仍不是 D2 证明（2026-09-01）

独立问题定义、隐私、因果、分布式安全、形式化和顶会复核一致发现：本轮新增 fixture 提升了反例可见性，但没有关闭 D2 的 Strong-Accept blocker。

- **正向 P001 的边界**：虽然现在把拒绝 attempt 与 applied effect 分开，并枚举三条 terminal path，但 `ESCROW` 仍没有 crash/recovery/all-or-none 状态机；writer、ACL、attestation、receipt、linearization 仍未由真实独立密钥或 sink runner 验证。因此 P001 只能是 `BOUNDED_FIXTURE_PASS + UNKNOWN_INPUT_NOT_PROVEN`，不能是 `D2_SOUND`。
- **writer universe 修正**：closed universe 必须包含所有 accepted/rejected writer。P001 已将 `legacy-writer` 与 `old-owner` 纳入 writer inventory；这只修复结构矛盾，不证明 adversarial egress 被真实封锁。
- **D2 fault scope**：仍缺 crash/restart、drop/dup/reorder、partition、scheduler nondeterminism、receipt-loss 与 post-horizon time-bomb。论文 theorem 量词因此继续收窄到 bounded finite-LTS，不能写通用分布式故障覆盖。
- **Org-Binding Twin**：Twin checker 目前能验证 public-prefix equality、GOOD/BAD decision/outcome 差异和局部一致性，但 attestation/signature/real sink 均未验证；Twin 仍是 hidden-world diagnostic/TCB obligation，不是跨组织新颖性定理。
- **G05**：只读 reducer 已能实际重算 support、exact rational value、dominance 与门槛；pair diff 仍由 shared envelope 派生，不是双输入 changed-pointer 证明。G05 是实验诊断，不是算法贡献。

因此本轮没有新增主创新。C1 保留，C3 仍是唯一待证技术核；C4/C5/Twin/fault/receipt 合并 D2 TCB；privacy/T5/INDEX/通信 separation/algorithmic indispensability 继续淘汰出正文。当前总体仍为 **4.8–5.2/10，Weak Reject/Borderline**；条件性潜力 **7–7.5/10** 只有在真实 A2、fault/recovery、sink enforcement 和 differential baseline 完成后成立。

本轮没有修改当前 Janus/uBuddy 技术实现，所有新增能力仍为 `planned/unverified`。

### 下一轮三个任务

1. 为 P001 补完整 fault DFA、cross-sink ESCROW recovery、receipt-loss 和 terminal closure witness；没有这些证据时保持 UNKNOWN。
2. 为 Twin 增加双输入 canonical prefix diff、独立 issuer signature/MAC replay、expectedVersion/epoch/generation fencing 和同一 action/resource binding。
3. 将 G05 reducer 拆成真实 base/variant 双输入，加入 candidate grammar digest、完整 endpoint rows 和 fail-closed invalid-support fixtures。

## 41. 第二十一轮补充：prototype 已能拒绝伪正例，但距离证明仍远（2026-09-01）

本轮新增的只读 prototype 实跑结果改变了“下一步证据”，但没有改变论文定位：

- D2 pair checker 从 LTS 自行枚举 P001 的 3 条 terminal paths，输出 `BOUNDED_FIXTURE_PASS + UNKNOWN_INPUT_NOT_PROVEN`；P002 输出 `MODEL_COUNTEREXAMPLE`，并标注其类别为 `ABSTRACT_UNSAFE`，不是 safety-reflection failure。
- Twin checker 输出 `RELATIONAL_STRUCTURE_PASS + UNKNOWN_INPUT_NOT_PROVEN`：公开 prefix 相等、GOOD/BAD sink decision 与 effect outcome 相反，但签名和真实 sink 仍未验证。
- G05 reducer 已重算 exact rational support/value/delta，并输出 `SOFT_ACCEPT` 与 `SOFT_PLAN_REJECT(DELTA)`；它使用静态 denylist和 policy hash 重算，但仍是 shared-envelope pair，且 JSON 数值输入限定在安全整数范围。

独立安全/形式化审稿再次拒绝以下升级：`ESCROW` 枚举不等于 recovery protocol；`completeMediationClaim=true` 不等于 sink enforcement；P002 不是 reflection counterexample；结构性 prototype 输出不等于 D2_SOUND。当前创新度 **4.8–5.2/10**、投稿成熟度 **5.0–5.3/10（Weak Reject/Borderline）**，目标继续 active。

本轮没有修改当前技术实现；新增 checker/fixture/prototype 全部为 `prototype/unverified` 或 `planned/unverified`。

## 42. 第二十二轮：补上真正的 reflection negative，但不把局部反例检测冒充 D2 证明（2026-09-01）

本轮保持唯一论文身份：`finite closed-world, contract/runtime-aware certified CP-RIR specialization`。

新增 reflection-negative fixture 满足 `reachable ∧ BadConcrete ∧ ¬BadAbstract`：concrete 与 abstract 均保留 `MEDIATED_EFFECT`、effect identity、sink/resource、multiplicity 和 versionDelta，concrete 因错误 owner binding 到达 `c-bad`，abstract 却到达非坏状态 `a-safe`；checker 输出 `MODEL_COUNTEREXAMPLE/REFLECTION_COUNTEREXAMPLE`。另有 effect-stutter 负控和 effect-class laundering 负控，分别返回 `INPUT_INVALID/EFFECT_MAPPED_TO_STUTTER` 与 `INPUT_INVALID/EFFECT_CLASS_NOT_PRESERVED`。这修复了此前将 P002 `ABSTRACT_UNSAFE` 误当 reflection failure、以及把 external effect 洗成 abstract internal event 的问题。

该进展只证明负向语义回归原型能区分抽象不安全、反射失败和非法 stutter，尚未运行 ContractMonitor、fault/recovery、receipt/effect replay、complete mediation 或真实 sink，因此不能推出 `D2_SOUND`，也不增加独立主创新。

保留 C1；C3 effect-complete safety-reflecting transfer 仍是唯一待证技术核；policy DSL、binding、ACL、attestation、receipt/fencing、Twin、fault/recovery 合并为 D2 TCB；G04/G05/G06 与 reflection/stutter/P002 fixture 仅作 falsification suite。T5/INDEX、privacy、Blackwell、通信 separation、exactly-once/liveness/Byzantine、跨组织算法不可替代性、current-instance root cause、population efficacy 继续淘汰出正文。

采纳审稿意见：核对 supplied abstract witness、禁止 effect→stutter、维持 `UNKNOWN` 边界、复杂度只在联合 `G_joint` 上讨论。拒绝把 Twin 自报 digest、G05 shared-envelope pair、`completeMediationClaim` 或 `ESCROW` 枚举当作安全/跨组织证明。

当前创新度 **4.8–5.2/10**，投稿成熟度 **5.0–5.3/10（Weak Reject/Borderline）**；CAV **5.3–5.9**、ICSE **5.0–5.6**、NSDI **3.5–4.3**。P0 仍包括完整 monitor/fault/H-frontier product、P001 recovery/receipt、Twin blinded 双输入与真实 sink、G05 dual-file diff、以及 D2/G05 端到端 binding。本轮未修改 Janus/uBuddy 源码、API、schema、运行时协议或现有实验实现；目标继续 active。

下一轮：1) 完整化 `Concrete × Fault × Monitor × Recovery` product；2) 物化 P001 crash/receipt-loss/recovery/all-or-none；3) 将 Twin/G05 改为 blinded dual input 并重算 canonical diff/digest。

## 43. 第二十三轮：把 reflection 反例纳入 effect-preserving 前置条件（2026-09-01）

独立问题定义审查指出，上一版 reflection fixture 的 `UNMEDIATED_EFFECT → INTERNAL` 虽非 stutter，仍违反 D2-R08A 的 effect class/identity preservation。该反馈已采纳：当前主 reflection fixture 只改变 concrete 的 owner/ACL badness，保留 abstract/concrete 的 effect class、effectId、sink/resource、multiplicity 和 versionDelta，因此才可进入 R09 并输出 `REFLECTION_COUNTEREXAMPLE`；原 laundering 案例降为 `INPUT_INVALID` 负控。

本轮新增 D2 product checker v1，将 concrete、abstract、monitor、fault 四个状态维度联合重放，检查 bad prefix、monitor rule、fault transition、H-frontier 和 effect witness。对 P001 输出 `BOUNDED_PRODUCT_PASS + UNKNOWN_INPUT_NOT_PROVEN`，对 P002 输出 `MODEL_COUNTEREXAMPLE/ABSTRACT_UNSAFE`；它仍未实现 receipt cryptography、cross-sink recovery 或真实 sink，所以不能称 `D2_SOUND`。

五视角和顶会审稿仍维持 C1 主线、C3 唯一待证核；C4/C5/Twin/fault/recovery 合并 D2 TCB；G05 只能称 `fixed-kernel baseline-dominance metamorphic relation`，不得称一般 baseline monotonicity 或因果效果。当前创新度 **4.8–5.2/10**、成熟度 **5.0–5.3/10（Weak Reject/Borderline）**；CAV **5.4–5.9**、ICSE **5.1–5.6**、NSDI **3.6–4.3**。Strong-Accept blockers 仍是统一 canonical checker、recovery/receipt、真实 sink、Twin/G05 dual-input 和 D1–D2–G05 端到端 binding。

本轮未修改 Janus/uBuddy 当前实现，新增能力均为 `prototype/unverified` 或 `planned/unverified`；目标继续 active。

## 44. 第二十四轮：统一 canonical D2 suite，并把 recovery knowledge 与 planning 正交化（2026-09-01）

本轮建立统一的 answer-free D2 suite 和单一 reducer，使用随机样式 opaque case alias，而不是让 purpose-specific checker 猜测预期标签。六个 case 由同一输入结构和同一 verdict precedence 处理：bounded safe witness、abstract unsafe、effect-preserving reflection failure、effect→stutter invalid、effect-class laundering invalid、supplied-witness tampering。实跑结果分别为 `UNKNOWN_INPUT_NOT_PROVEN`、`ABSTRACT_UNSAFE`、`REFLECTION_COUNTEREXAMPLE`、两个 `INPUT_INVALID` 和 `WITNESS_INVALID`。

这使 D2 负向回归从多套脚本收敛为一个可审计 artifact，但不提升主创新度：process-level answer isolation、credential/receipt cryptography、真实 sink、完整 recovery product 仍未实现。统一 suite 只能证明 verdict taxonomy 在这些冻结小例子上稳定，不能证明 D2_SOUND。

本轮还明确 recovery/effect knowledge 与 planning 正交：`IN_DOUBT` 必须禁止盲目重试；receipt 丢失不能推出 `NO_EFFECT_CONFIRMED`；confirmed half-commit 可同时带 `HARD_VIOLATION` 与剩余 effect 的 `IN_DOUBT`；effect witness 只证明交付/知识，不证明 utility 改善或因果收益。

候选处理不变：C1 保留；C3 是唯一待证核；fault/recovery/receipt/ACL/Twin 合并 D2 TCB；G04/G05/G06 与 canonical suite 是 falsification/metamorphic diagnostics；privacy/T5/INDEX/跨组织算法不可替代性继续不进正文。当前创新度 **4.8–5.2/10**、成熟度 **5.1–5.5/10（Weak Reject/Borderline）**；CAV **5.5–6.0**、ICSE **5.2–5.7**、NSDI **3.7–4.5**。本轮未修改 Janus/uBuddy 源码、API、数据库 schema、运行时协议或现有实验实现；目标继续 active。

下一轮：1) 将 recovery state 接入统一 D2 product；2) 加入 process/namespace answer isolation 与 blinded public observer contract；3) 建立同一 candidate/world/contract/fault digest 的 D1–D2–G05 端到端 join。

## 45. 第二十四轮补充裁决：canonical suite 是 single-witness falsification，不是完整 product proof（2026-09-01）

独立形式化、隐私和分布式安全复核要求进一步收窄本轮表述：canonical suite 虽然统一了六类 verdict taxonomy，但每个 case 仍只重放一条 supplied witness；`solverVisible=canonicalPayload` 仍暴露完整语义结构，opaque alias 不是 process-level hiding。故该工件应称 **single-witness canonical falsification suite**，不能称 unified D2 product proof 或 blinded benchmark。

recovery 工件也已改为正交乘积模型：`EffectReality × EffectKnowledge × GlobalSafety × RecoveryPhase × PublicDisposition × AllowedActions`，并加入 per-sink half-commit 示例。checker 对混合 confirmed/possible sink 保持 `HARD_VIOLATION` 与 `IN_DOUBT` 的区分，但 `CRASH_BEFORE_EFFECT` 的权威 negative witness、receipt cryptography、ESCROW reservation/expiry、scheduler/fault exploration 和真实 sink 仍未实现。

本轮采纳：G05 金标显式使用 `SOFT_ACCEPT/SOFT_PLAN_REJECT`；canonical suite 只作负向回归；recovery knowledge 与 safety/retry 正交；privacy 只保留 Gate B/non-goal。拒绝：把 6-case replay、recovery 状态字符串、opaque alias、hash 或统一 reducer 包装成 soundness、privacy、exactly-once、liveness 或跨组织协议。

更新后评分：创新 **4.8–5.2/10**；成熟度 **5.1–5.5/10（Weak Reject/Borderline）**；CAV **5.5–6.0**、ICSE **5.2–5.7**、NSDI **3.7–4.5**。本轮仍未修改 Janus/uBuddy 源码、API、数据库 schema、运行时协议或现有实验实现；目标继续 active。

## 46. 第二十五轮：recovery mutation 只形成 fail-closed 诊断，尚未形成主创新（2026-09-01）

本轮新增并实跑 recovery mutation matrix，覆盖 pre-effect crash、post-effect receipt loss、late receipt、cross-sink half-commit、duplicate receipt 与 compensation failure。它把 effect reality、effect knowledge、global safety、public disposition 和 recovery action 分开，能够稳定拒绝两类危险推断：receipt 丢失不等于 effect 未发生；compensation 不能擦除历史 hard violation。checker 还加入 snapshot 一致性 lint，对重复 sink、knowledge/reality 矛盾、duplicate receipt/dedup 矛盾和缺失关键事件 fail-closed。

该进展不构成新的论文主贡献。当前 runner 仍按单个 supplied snapshot/trace 分类，没有探索 `Concrete×Abstract×Monitor×Fault×Recovery×EffectKnowledge` 的可达状态空间；输入中的 effect reality、knowledge、receipt/dedup/version 和 mutation 类型仍由 audit artifact 提供。即使字段写成 `VERIFIED`，没有独立 cryptographic/sink replay 时也只能返回 `UNKNOWN_INPUT_NOT_PROVEN`。因此 recovery mutation suite 的准确定位是 **audit-only falsification prototype**，不是 recovery protocol、D2 proof、exactly-once 或 hidden-state protection。

候选处理保持稳定：C1 finite closed-world CP-RIR 是唯一主对象；C3 proof-producing, effect-complete bounded transfer 是唯一待证技术核；recovery、receipt、ESCROW、ACL/fencing、Twin 与 G05 全部并入 D2 TCB 或 falsification diagnostics。G05 继续只称 `fixed-kernel baseline-dominance metamorphic relation`；effect/receipt witness 只能支持 delivery/knowledge，不能支持 utility improvement、current-instance root cause 或 population efficacy。privacy/T5/INDEX、Blackwell、通信 separation、cross-org indispensability、exactly-once/liveness/Byzantine 继续淘汰出正文。

五视角的共同 P0 是：recovery 尚未进入 canonical D2 reducer；D1、D2 与 G05 尚未共享 candidate/world/contract/fault/recovery digest；authoritative sink universe、receipt atomicity、scheduler/fault reachability、ESCROW reservation/capacity/expiry/reclaim/double-spend 和 process isolation 均未闭合。32 位十六进制 alias 只是格式约束，没有实际 fresh generator，也不构成 hiding。

独立顶会裁决维持：创新 **4.8–5.2/10**，成熟度 **5.1–5.5/10（Weak Reject/Borderline）**；CAV **5.5–6.0**、ICSE **5.2–5.7**、NSDI **3.7–4.5**。只有完整六维 D2 product、P001 正向 `D2_SOUND`、可达 recovery/all-or-none/ESCROW、独立 sink/receipt replay、Twin/G05 真 dual-input、D1–D2–G05 digest join、process isolation 与 same-grammar differential 同时成立，才可能接近 7/10 的条件性潜力。

本轮未修改 Janus/uBuddy 源码、API、数据库 schema、运行时协议或既有实验实现；新增与修改的研究工件均为 `prototype/unverified`，目标继续 active。

下一轮：1) 将 recovery transition system 和 per-sink vector 接入 canonical product；2) 建立 authoritative sink universe、targeted allowed-action 与独立 receipt/negative witness replay；3) 物化 D1–D2–G05 共享 digest 和 dual-input/process-isolated runner。

## 47. 第二十六轮：recovery 进入 canonical product，但仍不是完整联合证明（2026-09-01）

本轮把 recovery 从独立快照分类推进为 `canonical D2 case + recovery transition sequence` 的集成 artifact。新增 v1 schema/input/checker，要求每个 recovery step 绑定 canonical concrete trace 的 `canonicalStepIndex/canonicalEvent`，并输出 `perSinkRuntime`、`currentSafety`、`effectKnowledge`、`recovery`、`planningSafety`、`unknownReasons` 与共享 planning binding。实跑结果保持分轴：安全 witness 为 `modelTransferStatus=UNKNOWN_INPUT_NOT_PROVEN, runtimeStatus=UNKNOWN`；abstract unsafe 为 `MODEL_COUNTEREXAMPLE, HARD_VIOLATION`；reflection negative 为 `MODEL_COUNTEREXAMPLE, IN_DOUBT`。

本轮采纳的关键修正：receipt/effect replay 未独立验证时，`MEDIATED_EFFECT_OBSERVED` 只能进入 `EFFECT_POSSIBLE`，不能直接进入 `EFFECT_CONFIRMED`；recovery step 必须检查 canonical event binding、from/to 可达转移、sink universe 不变和 version 单调性；`IN_DOUBT` 的 retry disposition 必须为 `DO_NOT_RETRY`；model-transfer status 与 runtime status 不再共享一个顶层安全标量。

独立五视角与顶会复核仍认为这只是 C3 的证据链增强，不产生新的主创新。C1 finite closed-world CP-RIR 继续保留；C3 proof-producing, effect-complete bounded transfer 继续作为唯一待证核。recovery/receipt/ESCROW/scheduler/ACL/Twin/G05 仍归入 D2 TCB 或 falsification diagnostics；C2 policy DSL、C4 owner/sink binding、C5 receipt/fencing、C6 coverageUnknown 为支撑，C7 metamorphic suite、C8 privacy/INDEX 为诊断或淘汰项。

形式化边界：v1 checker 的新增检查复杂度仅是 supplied sequence 上的多项式 replay（约为步数乘 sink 数，再加 canonical reducer 开销），没有探索 scheduler、fault interleaving 或 recovery all-prefix closure，不能推出 FPT、NP-hardness、D2_SOUND 或完整性。分布式边界：没有 reservation/capacity/expiry/reclaim/double-spend、receipt MAC/signature、epoch/generation fencing、真实 authoritative sink 或 process isolation。隐私边界：64-hex shared binding 只是格式和完整性占位，solver/audit 数据仍同处 JSON，不能声称 hiding、unlinkability 或 blinded benchmark。

独立审稿评分暂维持：创新 **4.8–5.2/10**，成熟度 **5.2–5.7/10（Weak Reject/Borderline）**；CAV **5.5–6.0**、ICSE **5.2–5.8**、NSDI **3.5–4.3**。Strong-Accept P0 仍是：完整 `Concrete×Abstract×Monitor×Fault×Scheduler×Recovery×EffectKnowledge` product、P001 正向 `D2_SOUND`、独立 sink/receipt replay、ESCROW all-or-none、D1–D2–G05 真实 digest join、Twin/G05 dual-input、process isolation 和 same-grammar differential。

本轮未修改 Janus/uBuddy 源码、API、数据库 schema、运行时协议或既有实验实现；新增能力为 `prototype/unverified`。目标继续 active。

下一轮：1) 将 canonical event 的 sink/effect/version/epoch 绑定写入 recovery step 并建立可达 fault/scheduler 分支；2) 物化 ESCROW reservation 与 receipt/negative-witness replay；3) 将 shared binding 从格式占位升级为跨 artifact canonical bytes 的 domain-separated digest join。

## 48. 第二十六轮补充：关闭 recovery witness 的可篡改入口，但不扩大主张（2026-09-01）

分布式安全和独立顶会审稿对 v1 构造了删除 sink、重复 canonical index、final snapshot 脱钩、状态回退、危险 retry 和缺字段等变体。补充修正已落地：checker 入口执行 Ajv 校验；canonical index 必须严格递增且不可复用；event class 必须与 canonical edge 一致；per-sink universe、version、effect reality、dedup 和 verified receipt 不得回退；final snapshot 必须逐字段等于最后 post；canonical reducer 非零退出会 fail-closed。

这些变化只关闭 supplied witness 的 artifact-level 篡改入口，不改变 C1/C3 的论文定位，也不证明 recovery 可达性。scheduler、crash/restart、partition、drop/dup/reorder、receipt atomicity、epoch/generation fencing、ESCROW all-or-none、真实 authoritative sink、process isolation 和跨 D1–D2–G05 的 domain-separated digest join 仍是 P0。审稿意见因此被采纳为“加强 falsification artifact”，而不是恢复已淘汰的 privacy、exactly-once、liveness、Byzantine 或 Strong-Accept 主张。

补充裁决评分不变：创新 **约 5.0/10**，成熟度 **约 5.4/10**；CAV **5.5/10**、ICSE **5.0/10**、NSDI **3.5/10**，总体 Weak Reject/Borderline。下一轮应从 checker lint 转向真正的联合 transition kernel，而不是继续堆叠 snapshot 字段。

## 50. 第二十八轮：把 branch fixture 的证据域和非因果边界显式化（2026-09-01）

本轮针对第27轮独立隐私与因果审查做了语义收紧：v2 schema 增加 `observerContract`，明确 solver/audit 仍未进程隔离；canonical-case digest 统一使用 domain-separated encoding；sink 状态拆成 `declaredEffectReality` 与 `verifiedEffectReality=UNKNOWN_UNVERIFIED`；每个 branch 强制 `utilityStatus=NOT_EVALUATED` 和 `causalScope=NOT_EVALUATED`。closure 输出改为 `SUPPLIED_BRANCH_SET_CHECK_ONLY`，不再暗示 exhaustive。

这些修改只提高证据诚实性和跨工件完整性检查，不提高主创新度。固定 alias、公开 authority/receipt/branch 字段和同 JSON observer 仍导致执行状态泄漏；`allowedBranches` 与 branches 仍同源，未解决外部 scheduler grammar、独立 generator、all-prefix closure、crash/restart、ESCROW 或真实 sink。C1/C3 主线、TCB/diagnostic 分层和 privacy/exactly-once/liveness/causal 强主张淘汰结论均不变。

本轮审稿评分维持创新 **4.9–5.2/10**、成熟度 **5.2–5.6/10（Weak Reject/Borderline）**；CAV **5.6–6.1**、ICSE **5.3–5.8**、NSDI **3.8–4.6**。本轮未修改 Janus/uBuddy 源码、API、数据库 schema、运行时协议或既有实验实现；目标继续 active。

## 49. 第二十七轮：bounded branch fixture 前进一步，但不宣称穷尽闭包（2026-09-01）

本轮新增 `d2-recovery-branch-closure-v2`，固定一个 canonical mediated effect，覆盖 `DELIVER_RECEIPT`、`DROP_RECEIPT`、`CRASH_AFTER_EFFECT` 三个手工定义分支。分支记录绑定 canonical effect fact、authoritative sink、owner/writer/epoch/generation、receipt claim、version delta、runtime disposition 和 action set；checker 输出 `SUPPLIED_BRANCH_SET_CHECK_ONLY`，并把 `declaredEffectReality` 与 `verifiedEffectReality=UNKNOWN_UNVERIFIED` 分离，明确 `utilityStatus=NOT_EVALUATED`、`causalScope=NOT_EVALUATED`。

该 artifact 的价值是把 receipt 丢失与 crash 后的不确定性写成可回归的负向边界，而不是引入新的主创新。独立问题、隐私、因果、分布式和顶会审查一致指出：`allowedBranches` 与 branches 仍来自同一输入，三键集合相等不是 scheduler 全覆盖；horizon 只有 1，未建模 query/reconcile/compensation、cross-sink/ESCROW、partition/drop/dup/reorder 或真实 sink。固定 alias、公开 branch labels、owner/writer/receipt/epoch 和 digest 仍造成完整执行泄漏，不能声称 hiding 或 blinded benchmark。

候选收敛不变：C1 为唯一主对象，C3 为唯一待证 transfer 核；branch closure、receipt/fencing、ESCROW、scheduler、Twin 和 G05 归入 D2 TCB/falsification diagnostics；privacy/INDEX、exactly-once/liveness/Byzantine、cross-org indispensability、causal utility 强主张继续淘汰。创新约 **4.9–5.2/10**，成熟度 **5.2–5.6/10**，总体 Weak Reject/Borderline。

本轮没有修改 Janus/uBuddy 源码、API、数据库 schema、运行时协议或既有实验实现；新 artifact 为 `prototype/unverified`。下一轮应使用外部冻结 scheduler grammar 和独立 branch generator，避免把自报分支集合误称 exhaustive closure。

## 51. 第二十九轮：external grammar 驱动的 branch-set integrity（prototype/unverified，2026-09-01）

本轮新增独立、版本化 scheduler/fault grammar、rule enumerator、branch manifest，以及不再含 `kernel.allowedBranches` 的 recovery witness schema/input。external closure checker 从 grammar 重算 manifest，核对 grammar/manifest digest、alphabet coverage、固定 scheduler×fault→semantic 映射，并将 witness 与 generator 输出做 omitted/extra/duplicate/semantic-mismatch 分类；正例仍返回 `UNKNOWN_INPUT_NOT_PROVEN`，四类负例全部通过。

准确定位是 **external rule-enumerated branch-set integrity and falsification harness**，不是 scheduler reachability、recovery protocol 或 D2 soundness。grammar 仍无签名/预注册 root，horizon 固定 1，无 all-prefix closure、phase guard、interleaving、跨 sink 或 ESCROW；branch semantic 仍需独立 oracle。普通 SHA-256 仅提供完整性命名空间，不提供 provenance、hiding 或 noninterference。

候选收敛：C1 finite closed-world CP-RIR 保留唯一主对象；C3 effect-complete bounded safety-reflecting transfer 保留唯一待证核；grammar/generator/manifest、authority/version/action gate 并入 D2 TCB；abstention 和 negative corpus 保留为 verdict/diagnostic；privacy/INDEX/Blackwell、exactly-once/liveness/Byzantine、causal efficacy 继续淘汰正文。

独立最终复核评分：痛点 **7.5/10**，创新 **5.2/10**，成熟度 **5.7/10**；CAV **5.9/10**、ICSE **5.4/10**、NSDI **4.0/10**，总体仍 Weak Reject/Borderline。采纳 external set 独立性、manifest 重算、四类负例、canonical/authority/version/action fail-closed；拒绝把文件分离称 trusted/frozen，把 set equality 称 exhaustive closure，把 digest/alias 称 privacy/provenance。

本轮未修改当前技术实现；新增工件均为 `prototype/unverified`。下一轮：1) 多步 recovery FSM 与 phase/guard；2) 独立 semantic oracle 接入 sink/receipt/authority replay；3) D1–D2–G05 canonical-byte join 及 grammar/authority/version 负例。

## 54. 第三十二轮：FSM–canonical–branch 跨工件 binding（prototype/unverified，2026-09-01）

本轮新增 `FSM_CANONICAL_BRANCH_JOIN_ONLY` binding artifact。checker 从实际 canonical case、external branch witness、scheduler/fault grammar、recovery FSM grammar 和 FSM manifest 重算五类 digest，验证 witness canonical digest 与 canonical case 一致、FSM manifest 与 grammar 一致，并把证据政策固定为：receipt、negative witness 和 compensation 均需独立证据，历史 hard violation 不得被擦除。五类 digest 篡改负例全部通过。

同时将 recovery 语义从 `COMPENSATE/MANUAL` 收窄为 `COMPENSATION_PENDING → REMEDIATED/MANUAL_INTERVENTION`，把补偿动作与补偿结果分离。该 binding 仍不是 D1–D2–G05 完整 join，也不是 sink/receipt replay 或 recovery protocol。独立评分暂为创新 **5.5/10**、成熟度 **6.2/10**；CAV **6.3/10**、ICSE **5.9/10**、NSDI **4.3/10**，总体仍 Weak Reject/Borderline。

保留 C1/C3；binding 与 FSM 归 D2 TCB，negative corpus 归诊断；privacy、exactly-once、liveness、causal efficacy 和 Strong Accept 继续拒绝。下一轮需要把 binding 从 digest 一致性推进到逐步 canonical sink/effect/receipt authority 语义和真实 replay。

## 55. 第三十三轮：recovery evidence ledger 与 false-verified 拒绝（prototype/unverified，2026-09-01）

本轮将 receipt、negative witness、compensation 从 FSM 事件名拆成独立 evidence ledger。每个 claim 必须分别通过 authority、integrity、atomicity、linearization、dedup、fencing、pre/post hash 七类 replay check；当前 fixture 全部 `NOT_IMPLEMENTED`，因此 receipt、negative witness、compensation 三项均输出 `UNKNOWN_INPUT_NOT_PROVEN`。把任一 claim 自报为 `VERIFIED` 而不补齐 replay check 的三类负例全部被拒绝。

binding gate 现合取 canonical reducer、external branch closure、FSM closure 和 recovery evidence checker；它仍不能推出安全，只能证明四个子检查在冻结 prototype 上没有发现输入级矛盾。C1/C3 不变；evidence ledger 归 D2 TCB，不能单列创新。评分暂维持创新 **5.5**、成熟度 **6.2**；CAV **6.3**、ICSE **5.9**、NSDI **4.3**，总体 Weak Reject/Borderline。

## 52. 第三十轮：有限 recovery FSM 的 prefix-closure 检查（prototype/unverified，2026-09-01）

本轮新增 horizon=5 的有限 recovery FSM，显式覆盖 `EFFECT_POSSIBLE → CRASHED → RESTARTED → RECEIPT_QUERY → IN_DOUBT/EFFECT_CONFIRMED/NO_EFFECT_CONFIRMED → COMPENSATE/MANUAL`。独立 generator 物化 9 个前缀路径，closure checker 检查父前缀、路径长度、terminal flag 和 horizon dead-end；omitted-prefix、terminal-flag、path-digest 三类负例全部通过。

准确定位仍是 **externally enumerated finite recovery-FSM prefix-closure falsification artifact**，不是 recovery protocol。sink reality、receipt cryptography、真实 crash/restart、fairness、ESCROW 和 all-or-none 仍未验证；确认/无效果状态没有独立证据时必须 UNKNOWN。独立最终评分为创新 **5.4**、成熟度 **6.1**；CAV **6.2**、ICSE **5.8**、NSDI **4.2**，总体仍 Weak Reject/Borderline。generator 还增加 terminal-state、transition-ID、隐式非确定和 unreachable state/transition lint；这些只证明 grammar well-formedness。本轮未修改当前技术实现。
## 56. 第三十四轮：evidence ledger 的 fail-closed binding 收紧（prototype/unverified，2026-09-01）

本轮把上一轮审稿指出的 evidence P0 逐项收窄为可回归的完整性条件：输入 claim 不得自报任何 `PASS`；`claimId` 唯一且受长度/字符集约束；`RECEIPT`、`NEGATIVE_WITNESS`、`COMPENSATION` 三类标签必须覆盖；evidence `caseAlias`、`effectId/sinkId` 必须落在当前 canonical case 的 effect/sink universe；evidence digest 使用按 `(effectId,sinkId,kind,claimId)` 的规范排序；binding schema/input/actual/bindingDigest 纳入 branch manifest 与 recovery-evidence digest；branch manifest 改为由 binding 的显式 source 传入并与 grammar 生成结果逐字一致。

这次保留的真实创新增量仍是 **artifact-level fail-closed falsification hygiene**：它能检测 ledger 自报、重复/缺失 claim、跨 case/effect/sink 移植、manifest swap 和 digest mismatch。它不建立独立 issuer、签名/MAC、可信冻结 root、sink replay、runtime trace、per-step FSM 绑定或证据真实性。因此只能说“referential integrity 与可证伪边界更强”，不能说 evidence authenticity、provenance、complete mediation、privacy、noninterference 或 tamper-proof ledger。

候选收敛不变：C1 finite closed-world CP-RIR 是唯一主对象；C3 proof-producing, effect-complete bounded transfer 是唯一待证技术核；FSM/binding/evidence/receipt/fencing/ESCROW 归 D2 TCB；negative corpus 归 falsification diagnostics。原始 DAG、provenance、causal、repair、gateway 仍不能以模块拼接形式单列贡献；privacy/Blackwell、exactly-once、all-or-none、liveness、Byzantine 与 causal efficacy 继续淘汰正文强主张。

独立五视角与顶会复核采纳了本轮修复，但指出稳定 SHA-256 digest 仍可 link，细粒度错误码仍形成 case/effect/sink membership oracle，source 路径仍不是签名 allowlist；kind coverage 目前只对单 effect fixture 形成三类覆盖，不等于多 effect/sink 完整覆盖。因果轴继续固定为：evidence 只支持 delivery/epistemic knowledge；`COMPENSATION_PENDING/REMEDIATED` 不是反事实 rollback 或 causal success；没有 independent replay 时必须 `UNKNOWN_INPUT_NOT_PROVEN`。

保守评分：痛点 **7.8/10**，创新 **5.8–6.0/10**，成熟度 **6.4–6.6/10**；CAV **6.5–6.7**、ICSE **6.0–6.2**、NSDI **4.4–4.6**，总体仍 **Borderline/Weak Reject**。本轮未修改 Janus/uBuddy 源码、API、数据库 schema、运行时协议或既有实验实现；新增/修改工件全部为 `prototype/unverified`，目标继续 active。

下一轮三个任务：1) 将 claim 绑定到具体 FSM transition/path 与 runtime sink transcript；2) 设计独立 signed replay verifier、可信 manifest root 与统一粗粒度错误通道；3) 把 D1–D2–G05/runtime/verifier attestation 纳入共享 root，并加入跨 sink fault injection。
## 57. 第三十五轮：evidence claim 到 recovery FSM step 的绑定（prototype/unverified，2026-09-01）

本轮将 evidence claim 从“属于某个 canonical effect/sink”进一步绑定到 recovery FSM 的具体 `pathId/stepIndex/transitionId/event/from/to`。新增 step-binding schema、样例、checker 和六类负例；正例覆盖 `RECEIPT→VERIFIED_RECEIPT`、`NEGATIVE_WITNESS→VERIFIED_NEGATIVE_WITNESS`、`COMPENSATION→COMPENSATION_VERIFIED` 三条具体路径。主 FSM binding 已把该 checker 作为第五个 semantic subcheck，并将 step-binding artifact digest 纳入 composite root。

保留的真实增量是 **cross-artifact step-level referential integrity**：可以拒绝漏绑 claim、错误 path、错误 transition、事件/状态不一致和 step-binding digest 篡改。它仍只验证声明图上的语法对应关系，不能证明该 transition 在运行时发生，更不能证明 sink effect、receipt、negative witness 或 compensation 成功。正例继续输出 `UNKNOWN_INPUT_NOT_PROVEN`；runtime transcript、independent replay、crash/restart 和 causal/utility 仍为 unknown。

本轮候选审查维持八项以上候选池：C1 finite closed-world CP-RIR（主线）；C2 policy/intervention DSL（并入 C1）；C3 effect-complete bounded transfer（唯一待证技术核）；C4 owner/sink binding（D2 TCB）；C5 receipt/fencing/linearization（D2 TCB）；C6 coverageUnknown/abstention（verdict）；C7 grammar/FSM/evidence mutation corpus（falsification）；C8 privacy/Blackwell（淘汰正文）；C9 ESCROW/recovery scheduler（未来 TCB）；C10 Twin/G05 dual-input（真实性诊断）。没有把 step binding 单列为新算法贡献。

独立审查采纳：claim 必须绑定具体 FSM step，主 binding 必须真正调用该 checker 并纳入 root；拒绝：把 path/transition 字段或 digest 解释为 runtime provenance、transition execution、repair efficacy、D2 soundness、privacy 或 exactly-once。残余风险包括 source 路径未签名 allowlist、稳定 digest linkability、细粒度 error oracle、step binding 尚未连接 runtime sink transcript，以及同步替换 artifact 与 expected root 的威胁模型缺口。

保守评分：痛点 **7.8/10**，创新 **5.8–6.0/10**，成熟度 **6.5–6.7/10**；CAV **6.5–6.8**、ICSE **6.0–6.3**、NSDI **4.4–4.7**，总体仍 **Borderline/Weak Reject**。本轮未修改 Janus/uBuddy 源码、API、数据库 schema、运行时协议或既有实验实现；所有新增工件均为 `prototype/unverified`，目标继续 active。

下一轮三个任务：1) 引入最小 runtime sink transcript fixture，并要求 claim→FSM step→transcript 三方一致；2) 设计独立 signed replay verifier 与 trusted locked root；3) 对外统一 fixed-shape error/abstain 输出，并把 D1–D2–G05/runtime/verifier attestation 纳入共享 root。

复审修正：step binding 现显式校验 `effectId/sinkId`；主 binding 强制 step artifact 与主 ledger 的 source、evidence digest、claim identity set 三重一致，并对 bindings 规范排序后再入 root。该修复关闭输入级错绑、ledger split-brain 和排列 fingerprint，但仍不证明 runtime transition 或 sink effect。

## 58. 第三十六轮：runtime-shaped path catalog 的语义收窄与六方 binding（prototype/unverified，2026-09-01）

本轮将 runtime 工件从容易被误读的“transcript”收窄为 `MUTUALLY_EXCLUSIVE_HYPOTHETICAL_PATH_CATALOG`：`realizedPathId=null`，每条 record 固定 `HYPOTHETICAL_UNREALIZED`，因此 receipt、negative-witness、compensation 三条路径明确是互斥假设，不是同一次运行的三个结果。checker 现在重新执行 canonical reducer、external branch closure、recovery-FSM closure 与 evidence-step checker，并逐项核对 canonical index/event/effect/resource/multiplicity/versionDelta、FSM state/transition、branch scheduler/fault、authority epoch/generation/version/receipt state、recordId 和 path 唯一性。`branchVersionAfter` 只表示 branch snapshot；`hypotheticalPostVersion=null`，不再把 compensation 或 negative-witness 后状态伪装成已知版本。

主 binding 已将该 catalog 作为第六个 semantic subcheck，检查 source identity，并把规范化 catalog digest 纳入 composite binding root。实跑正例仍为 `UNKNOWN_INPUT_NOT_PROVEN`；runtime negatives **12/12**、主 binding negatives **21/21** 通过。新增能力的准确定位是 **cross-artifact hypothetical-catalog referential integrity**，不是 runtime occurrence、sink authenticity、recovery correctness 或因果证据。

五视角与独立审稿采纳：互斥路径和 unrealized 标志必须显式化；canonical/branch/FSM/step/authority 交叉 join 必须 fail-closed；digest 只能表示 integrity-only。拒绝：把 catalog 称为真实 transcript、把 `VERIFIED_*` 声明当作已验证事件、把 branch version 当作 rollback/repair 成功、把第六方 binding 当作 D2 soundness、trusted provenance、privacy 或 causal efficacy。隐私上完整 catalog、稳定 digest、细粒度错误码和自由 source 仍泄漏 topology/linkability，process isolation、fixed-shape error、signed root 尚未实现。

保守评分：痛点 **8.0/10**，创新 **6.1–6.3/10**，成熟度 **6.7–6.9/10**；CAV **6.8–7.0**、ICSE **6.3–6.5**、NSDI **4.7–4.9**，总体仍 **Borderline/Weak Reject**（CAV artifact/formal track 可接近 Weak Accept 边缘）。Strong-Accept blockers 仍是 signed authoritative sink/receipt/negative/compensation replay、唯一 realized-path proof、pre/post linearization/dedup/fencing、真实 crash/restart、cross-sink/ESCROW、D1–D2–G05 shared root 和 process-isolated observer。

本轮未修改 Janus/uBuddy 源码、API、数据库 schema、运行时协议或既有实验实现；所有工件继续标记 `prototype/unverified`。下一轮：1) standalone checker 自行验证所有 source schema 并粗化错误投影；2) 增加 signed realized-path proof 的 planned schema 与伪造负例；3) 设计跨 sink partial-commit/ESCROW replay 的最小可证伪 fixture。

## 59. 第三十七轮：从单 sink 引用闭合扩展到 proof boundary 与跨 sink partial-commit（2026-09-01）

本轮没有把 planned proof 或 ESCROW 名词升级为创新，而是补齐两个可证伪边界。第一，standalone runtime catalog checker 现在自行 Ajv 验证 canonical、external witness、branch grammar/manifest、recovery grammar/manifest、evidence 和 step-binding 八类 source，并增加公开投影 `publicErrorCode=UNKNOWN/CATALOG_INVALID`；内部细粒度 `reasonCode` 仍只适合作为 ACL audit，且当前没有定长输出、恒时执行或 process isolation。第二，新增 `planned/unverified` realized-path proof schema，签名和 verification 只能是 `NOT_IMPLEMENTED`，三类伪造输入均被拒绝；因此它只是未来 proof interface，不选择任何真实路径。第三，新增双 sink partial-commit/ESCROW catalog，正例显式输出 `UNKNOWN_INPUT_NOT_PROVEN`、`allOrNoneStatus=NOT_VERIFIED`，并以 4/4 负例拒绝 duplicate sink、effect/sink 错绑、version regression 与自报 all-or-none。

候选池继续维持十项：C1 finite closed-world CP-RIR（唯一主问题）；C2 intervention DSL（并入 C1）；C3 effect-complete bounded transfer（唯一待证技术核）；C4 owner/sink authority、C5 receipt/fencing/linearization、C9 cross-sink ESCROW（并入 D2 TCB）；C6 abstention（verdict）；C7 mutation/falsification corpus（支撑）；C8 privacy/Blackwell（淘汰正文强主张）；C10 Twin/G05/shared-root（真实性诊断/未来）。本轮没有产生第三条独立主线。

真实增量仅是：source-schema assumption 被显式检查；公开/审计错误面开始分离；signed proof 与 cross-sink all-or-none 的“不可自报”边界成为可执行负例。不能声称 signed provenance、realized runtime path、cross-sink atomicity、ESCROW safety、compensation success、exactly-once、privacy/noninterference、D2_SOUND 或 causal repair efficacy。

独立五视角与顶会复审采纳：source schema 必须由 standalone checker 自行验证；公开结果必须与 audit diagnostics 分离；planned proof 不得伪造 realized path；ESCROW 只保留 partial-commit 反例。审稿人拒绝把 `publicErrorCode` 本身解释成 privacy/noninterference：本轮新增 public projector 的 2/2 固定长度负例只证明序列化形状，未证明恒时、资源隔离或 topology hiding。C1/C3 主线不变，新增 proof/ESCROW/projector 均归 D2 TCB 或 falsification support。

独立评分：痛点 **8.1/10**，创新 **6.3–6.5/10**，成熟度 **6.9–7.0/10**；CAV **7.0–7.1**、ICSE **6.5–6.6**、NSDI **4.9–5.0**，总体 **Borderline/Weak Reject**（CAV artifact/formal track 可接近 Weak Accept 边缘）。隐私单项 **2.0–2.4/10**，privacy novelty 约为 0。仍不可声称 fixed-shape observer、process isolation、signed realized path、ESCROW/all-or-none、D2_SOUND、causal efficacy 或 Strong Accept。

本轮未修改现有技术实现；目标继续 active。下一轮优先：1) 将 public projector 的 audit/public 双通道接入主 binding 但保持独立 ACL 边界；2) 为 realized proof 设计 case/branch/step/nonce payload binding 的 planned negative matrix；3) 为 ESCROW 增加 reservation/expiry/reclaim/double-spend/owner-epoch 负例。

## 60. 第三十八轮：proof payload binding 与 ESCROW 语义负例矩阵（prototype/unverified，2026-09-01）

本轮继续不重做主创新，而是把两个审稿 P0 转化为可证伪边界。realized-path proof 的 planned schema 增加 payload 对 `caseAlias/branchId/pathId/stepIndex/transitionId/nonce/sequence/transcriptDigest` 的绑定，并由 planned checker 重算 domain-separated payload digest；wrong case/path 触发 binding mismatch，wrong branch/step/nonce/transcript 触发 digest mismatch，任何 `VERIFIED` 自报仍 schema fail，负例 **7/7**。这仍不能选择或证明 realized path：`signature=NOT_IMPLEMENTED`、`verificationStatus=NOT_IMPLEMENTED`。

cross-sink ESCROW catalog 增加 `observedTick/globalSafety`、effect epoch、effect versionDelta、reservation capacity/reservedUnits、expiry/reclaim；checker 拒绝 old-epoch effect、versionDelta mismatch、capacity exceed、expired-not-reclaimed、partial-commit→SAFE 和 self-asserted all-or-none，负例 **8/8**。正例继续是 `UNKNOWN_INPUT_NOT_PROVEN` 与 `HARD_VIOLATION_UNVERIFIED`，不是 atomicity、all-or-none、rollback 或 causal repair。

五视角复核仍把 C1 finite closed-world CP-RIR 作为唯一主线、C3 作为唯一待证核；proof/ESCROW 只是 D2 TCB 的必要语义条件，projector 只是输出边界。隐私复审拒绝把固定长度应用层输出当作 process isolation/noninterference；因果复审拒绝把 `APPLIED_DECLARED`、`PARTIALLY_COMMITTED_UNVERIFIED` 或 compensation 状态当作 effect/utility/repair 事实；分布式与形式化复审指出尚无签名验签、reservation ledger、double-spend、linearization、跨 sink replay 或联合 product。

保守评分：痛点 **8.1/10**，创新 **6.3–6.5/10**，成熟度 **7.0–7.1/10**；CAV **7.0–7.2**、ICSE **6.5–6.7**、NSDI **4.9–5.1**，总体仍 **Borderline/Weak Reject**。本轮没有修改 Janus/uBuddy 现有实现、API、数据库 schema、运行时协议或实验实现；目标继续 active。

## 61. 第三十九轮：把 model-set、契约完整性与非空洞性设为前置门槛（conceptual tightening，未改实现，2026-09-01）

本轮不再增加 proof/ESCROW 字段，而是处理独立问题定义审查发现的三个语义漏洞：`M_hat` 的候选世界选择可能 cherry-pick，固定契约可能本身不完整，以及 empty-action/empty-world 可以制造“安全但无用”的空洞结论。新增 `planned/unverified` contract-gate 与 model-set differential 工件只检查 supplied declaration/manifest 和自报 disposition 的一致性；它们不能写成已验证定理。

### 61.1 三层结果语义固定

正文统一使用下列标签，禁止互换：

```text
Instance：真实私有世界 m*、真实 sink effect 或 realized path 未被独立证据确认；不能声称 current-instance root cause/repair efficacy。
Model-set：对候选集合 M_hat 的 model-relative robust feasibility/value；这是 CP-RIR 的 exact 主语义。
Population：任务分布上的 policy value 或外部效度；仅作未来扩展/基线，不进入 exact ACCEPT。
```

因此 `FEAS_robust(M_hat,π)` 只表示“在冻结声明世界集合内对所有世界成立”，不表示 `m*∈M_hat` 已被观测证明，也不表示某次失败已经被修复。`coverageUnknown` 只能表示输入支持、证书或观测边界不足，不能被用来掩盖 model-set 未冻结。

### 61.2 两道不可合并的契约门

新增概念定义：

```text
ContractComplete(C_pub) :=
  schema/scope/input-domain/assumption/obligation/footprint/
  projection/exception/deadline/attempt/freshness/idempotence/
  authorization/evaluator/cost 均存在、规范化、版本锁定，且其适用范围与环境闭包明确。

ObligationConservation(C_pub,π) :=
  π 不缩小原始可接受输入域、不强化调用方前置条件、不删除或降格 required effect，
  不改变 evaluator/projection，不把 hard obligation 移入 soft/exception/timeout，
  并保持 freshness、attempt、idempotence、authorization 与 frame 义务。
```

`ContractComplete=false` 时结论为 `INPUT_INVALID/CONTRACT_INCOMPLETE`；只有通过第一道门后才有资格检查第二道门。固定一份不完整 ROC 不能推出有意义的 contract-preserving。

独立形式化复核进一步要求 `ContractComplete` 相对于候选无关、独立冻结的 `Req*` normative registry 定义，而不能只比较同源 `contractBefore/contractAfter`。当前原型尚无该独立 registry、逐前缀 obligation ledger 或 authoritative trace replay，因此输出必须保持 `contractComplete/obligationConservation=UNVERIFIED_SEMANTIC_GATE`；schema、hash 和字段相等只属于 input validity。

### 61.3 non-vacuity 与 model-set sensitivity

CP-RIR 的 canonical exact 实例必须满足：`|M_hat|>0`、typed action 库非空、至少存在一个候选无关基线 `π0`、成本严格为正，并在锁定 benchmark 中包含至少一个 `FEAS_robust(M_hat,π)=true` 的非平凡正例。`empty completion`、`reject-all`、把所有危险世界过滤掉、或令 `π0` 退化为必败策略，均标为 invalid/mutation，而不是安全结论。

`M_hat` 必须由候选搜索前的预注册 manifest 或独立 benchmark oracle 冻结；不得按候选 repair 的结果过滤世界。需要加入 world-set sensitivity 检验：若 `M⊆M'`，则 `FEAS_robust(M',π)⇒FEAS_robust(M,π)`，扩大世界集只能保持或削弱 robust 可行性，不能让结论无证据地变强；任何 world-set 置换、删除困难世界、改变 alias 顺序都必须进入 digest/negative corpus。

### 61.4 cross-organization 的主张降级规则

在尚未完成 `Γ`-relative necessity/sufficiency、通信下界与 matching upper bound 前，`cross-owner` 只表示威胁模型/部署条件：至少两个独立管理域、无主体同时拥有全部私有状态和全部 sink 写权限、且 sink-side mediation 不可旁路。它不是 privacy、communication-separation 或 planner expressiveness 定理；C16/T5 保留 Gate B 附录，不进入当前主贡献。

### 61.5 本轮候选与审稿裁决

候选池仍维持 C1–C16 至少八项，但正文只保留 C1（finite model-relative robust contingent repair）与 C3（effect-complete bounded transfer）；C2 是 policy object，C4–C7/C9–C10 是 D2 TCB 或 falsification，C8/C15 是 privacy non-goal，C11/C16/T5 是附录研究议程。上述门槛提高了可证伪性和主张诚实性，但没有新增独立算法或已证明的新颖性。

保守评分维持创新 **6.1–6.5/10**、成熟度 **7.0–7.2/10**；痛点 **7.5–8.1/10**；CAV **7.0–7.2**、ICSE **6.5–6.7**、NSDI **4.9–5.1**，总体仍 **Borderline/Weak Reject**。Strong-Accept blocker 从“继续增加字段”转为：独立验证上述两道契约门、非空洞性和 world-set sensitivity，并完成 C3 的真实联合 product/sink replay。当前没有修改 Janus/uBuddy 代码、API、schema、运行时协议或既有实验实现。

本轮实跑：contract-gate 正例为 `UNKNOWN_INPUT_NOT_PROVEN`，6/6 负例通过；model-set differential 正例同样为 `UNKNOWN_INPUT_NOT_PROVEN`，6/6 负例通过。它们证明的是 fail-closed 输入分类，不是 robust result、contract completeness 或 obligation conservation。下一轮优先：1) 增加独立 `Req*` registry 与 separation pair（CC false/OC vacuous true；CC true/OC false）；2) 实现逐前缀 obligation ledger mutation；3) 让 world-set differential 调用独立 finite solver，而不是比较自报 disposition。

## 62. 第四十轮：逐前缀 obligation ledger 与 Contract/Obligation 分离反例（prototype/unverified，2026-09-01）

本轮将上一轮的两个概念门进一步落到 supplied-trace replay：独立 normative registry 提供 obligation identity/multiplicity/cancelability；checker 根据 `TRIGGER/DISCHARGE/VIOLATE/CANCEL/COMPENSATE/ACCEPT` 事件重算 `issued/pending/satisfied/violated/cancelled` 账本，不信任输入自报的 `VERIFIED` 或最终状态。它因此能表达“合同字段完整但候选逐前缀删除义务”的逻辑分离，而不是把 contract hash 相等当作 conservation。

正例运行结果：两个 required hard obligation 均完成 discharge，账本为 `issued=1,pending=0,satisfied=1,violated=0`；输出仍为 `UNKNOWN_INPUT_NOT_PROVEN / OBLIGATION_LEDGER_REPLAY_SELF_CONTAINED_RUNTIME_UNVERIFIED`，因为 trace 未签名、没有 authoritative runtime replay、sink effect replay 或独立 registry signature。负例 **6/6**：registry/contract mismatch、contract obligation removal、pending-at-accept、historical violation erasure、discharge-without-pending、projection erasure。

该轮的真实增量是 **supplied-prefix obligation accounting 与 CC/OC separation 的可证伪边界**，不是 obligation-conservation theorem、runtime conformance、historical safety proof 或 causal repair。补偿只能保持历史 `violated`，不能把它擦除成 satisfied；没有逐步 authoritative effect witness 时继续 abstain。正文主线仍为 C1+C3，ledger 归 D2/contract semantic TCB。

独立审稿评分维持创新 **6.1–6.4/10**、成熟度 **7.1–7.3/10**；痛点 **7.5–8.1/10**；CAV **6.4–6.8**、ICSE **5.9–6.3**、NSDI **4.5–4.9**，总体 **Borderline/Weak Reject**。下一轮必须补独立 registry 的签名/锁定 root、真实或独立模拟的 authoritative trace/effect replay、以及 CC=false/OC-vacuous-true 与 CC=true/OC=false 的机器可检查 separation pair。

## 63. 第四十一轮：机器可检查的 CC/OC separation 与历史违例边界（prototype/unverified，2026-09-01）

本轮新增 `obligation-separation-v0` fixture/checker。它固定同一独立 registry，构造两个逻辑相反的案例：

1. `CC_FALSE_LEDGER_SELF_CONSISTENT`：合同义务集合与独立 registry 不匹配，因此 `ContractComplete=false`；但 supplied ledger 的 `TRIGGER→DISCHARGE` 自洽，说明 obligation accounting 不能替代 contract completeness。
2. `CC_TRUE_LEDGER_VIOLATION`：合同集合匹配 registry，因此声明级 CC 通过；但 `TRIGGER→VIOLATE→ACCEPT` 触发 `FALSE_COMPLETION`，说明 contract completeness 不能替代逐前缀 obligation conservation。

主 checker 输出 `SEPARATION_PAIR_CHECKED / LOGICAL_GATE_INDEPENDENCE_ONLY`；separation negatives **3/3** 通过（缺 discharge witness、第二案例合同错配、未知 obligation）。这是真正的逻辑分离反例，但不构成 `ContractComplete` 或 `ObligationConservation` 定理：registry 未签名、trace 非权威、effect/receipt 未重放，仍必须 UNKNOWN。正文主线仍为 C1+C3，separation fixture 属于 D2/contract falsification support。

独立审稿评分维持创新 **6.1–6.4/10**、成熟度 **7.1–7.3/10**；痛点 **7.5–8.1/10**，总体 **Borderline/Weak Reject**。下一步需将 registry obligation 扩展为 trigger/scope/deadline/multiplicity，并把 `VIOLATE→COMPENSATE` 的 `violatedEver` 单调性接入同一 canonical product。

## 62A. 第四十轮补充：proof–catalog 语义绑定与非空洞门控收紧（2026-09-01）

本轮继续保留 C1+C3，不重做主创新。realized-path proof 现在至少绑定 runtime catalog 的 transcript digest 及 branch/path/step/transition membership；contract gate 增加独立 normative registry 摘要，且把 `obligationSemanticReplay` 明确保持 UNKNOWN；model-set differential 与最小双困难世界 cross-sink fixture 只作为非空洞性和反例工件。所有这些仍是 `planned/unverified` 或 `prototype/unverified`，不构成 signed proof、robust solver、ESCROW 或 privacy。

### 第四十一轮对抗性复核补充

修订后的 ledger 已对 supplied sequence 强制 instance ID 唯一、discharge witness 一次性、ACCEPT 终止，以及 `violatedEver` 单调；ledger negatives 已扩展为 **10/10**。这些是有价值的 parser/replay guards，但仍不建立 ContractComplete 或 ObligationConservation：contract semantics 仍主要是 ID set 与未认证 digest，normative registry 是 supplied declaration，trigger/effect completeness 不可观测，compensation 没有 token/linearization 语义。required→optional metadata mutation、伪造 digest、未触发 required obligation 的部分 REMEDIATION 仍可保持 UNKNOWN。因此工件只能称 fail-closed sequence consistency，不能称 semantic conservation 或 historical safety。

## 64. 第四十二轮：metadata-bound obligation ledger 与触发覆盖边界（prototype/unverified，2026-09-01）

本轮不重做 C1/C3 主线，也不把 ledger guards 宣称为新算法；目标是把“契约未被修复过程弱化”从 obligation ID 集合提升到可重算的 obligation metadata。新增 `ubuddy-cp-rir-obligation-ledger-v1.*`，将 `trigger/scope/deadline/discharge/compensation/multiplicity` 纳入 canonical registry root 和 before/after contract root。checker 现在拒绝 stale/forged root、required→optional 或 HARD→SOFT 变更、contract metadata mismatch、缺失 required trigger coverage、错误 sink/issuer/effect witness、receipt/nonce replay、重复 compensation 和同一 violation 的二次补偿。

该轮的研究价值是把 `ContractComplete` 的候选无关输入与 `ObligationConservation` 的逐前缀语义再次拆开，并明确“未认证触发流不能被当成没有触发”。但它仍只检查 supplied declaration 和 supplied prefix：registry signature 为 `NOT_IMPLEMENTED`，trigger/effect stream 与 previous ledger root 均 `SUPPLIED_UNAUTHENTICATED`，因此最终仍为 `UNKNOWN_INPUT_NOT_PROVEN`。这不是 signed provenance、exactly-once、runtime conformance、历史安全或 compensation success。

候选处理：C1 finite closed-world CP-RIR 仍是唯一主问题；C3 effect-complete bounded transfer 仍是唯一待证技术核；metadata root、witness binding、compensation token、trigger coverage 归 D2 TCB/falsification support，不单列第三条主创新。审稿评分不提升：痛点 **8.1/10**，创新 **6.3–6.5/10**，成熟度 **7.0–7.2/10**；CAV **7.0–7.2**、ICSE **6.5–6.7**、NSDI **4.9–5.1**，总体仍 **Borderline/Weak Reject**。

本轮未修改 Janus/uBuddy 源码、API、数据库 schema、运行时协议或既有实验实现。下一轮优先：1) 为 registry/contract root 设计签名与 key-lifecycle 的 planned negative matrix；2) 将 authoritative trigger/effect stream 与 prefix root 接口化并保持缺失时 abstain；3) 设计 REMEDIATION/UNKNOWN 下 trigger scope/deadline 的显式策略。

## 65. 第四十三轮：root authentication envelope 的边界收窄（planned/unverified，2026-09-01）

本轮新增 `ubuddy-cp-rir-root-auth-envelope-v0.*`，将 registry、contract 和 ledger-prefix root 的认证接口拆为 issuer/keyId/algorithm、key lifecycle、signed root 与 verification status 四部分。checker 拒绝 signed-root/key mismatch、撤销或过期 key 自报 VERIFIED、rotation self-loop、活动 key 携带撤销证据以及自报 VERIFIED/INVALID；正例仍输出 `ROOT_AUTHENTICATION_NOT_IMPLEMENTED`。

这一步只把“canonical integrity”与“authenticated provenance”在研究语义上分离，不能声称签名、密钥解析、轮换日志重放、不可伪造 provenance 或 runtime trust anchor。C1/C3 主线不变，root authentication 继续归 D2 TCB；评分不提升，目标保持 active。

## 66. 第四十四轮：effect-complete transfer 与普通组合的可区分反例（prototype/unverified，2026-09-01）

本轮转向 C3 技术核，新增有限 typed LTS 的 effect-complete bounded transfer checker。它自行探索 concrete/abstract/monitor product，检查 state/event map 总性、effect footprint 保持、非法 stutter、monitor step、terminal closure 和 horizon closure，而不是信任 supplied abstract trace。

关键结果是 `COMPOSITION_SEPARATION_HIDDEN_EFFECT`：普通 abstract planner+monitor 的 reachable product 没有坏状态，但 concrete 的 `C_HIDDEN_WRITE` 含有 `sink-b/resource-y` effect，被映射为 stutter，checker 给出 `EFFECT_MAPPED_TO_STUTTER`。这构成“普通 planner+monitor 组合通过 ≠ effect-complete concrete transfer 成立”的最小可区分反例，是目前 C3 最接近实质新颖性的证据。

但该 checker 仍只覆盖 supplied finite LTS，尚无真实 sink mediation、签名 receipt、一般化 safety-reflection theorem 或 Janus runtime conformance。故 C3 仍标记 `prototype/unverified`，C1+C3 主线保留，评分暂不跳升为 Strong-Accept-capable。

### 第四十四轮补充：多步跨 sink composition 与 bounded obligations

新增 `MULTI_EFFECT_ORDERED` 三步案例，覆盖 `sink-a/resource-x → sink-b/resource-y` 的有序 effect composition。checker 输出 `INSTANCE_LEVEL_OBLIGATIONS_CHECKED`，逐项记录 map totality、effect preservation、stutter closure、monitor uniqueness、bad-prefix reflection、terminal/horizon closure；正例仍是 `UNKNOWN_INPUT_NOT_PROVEN`。这只说明给定 finite LTS 上的 bounded obligations 可被枚举检查，不能外推为任意系统的归纳证明。

## 67. 第四十五轮：proof-carrying transfer certificate 的可达覆盖约束（prototype/unverified，2026-09-01）

本轮没有继续扩展 runtime 字段，而是为 C3 增加独立 certificate verifier。证书携带 input digest、product edges 和 terminal tuples；verifier 重新查询 concrete/abstract transition、α map、monitor edge 与 effect footprint，并额外要求所有 terminal tuple 从初始 product tuple 可达。删除 terminal edge 的负例不再被“字段合法”绕过，而是触发 `TERMINAL_TUPLE_NOT_REACHABLE`。

这使 C3 的证据链形成三层：有限 product 自行探索、effect-complete 反例、独立 proof-carrying certificate replay。仍然不能声称签名证书、运行时 mediation、一般归纳 soundness 或 Strong Accept；贡献暂定为 finite model-relative certified specialization。

## 68. 第四十六轮：exhaustive product certificate 与分支完备性（prototype/unverified，2026-09-01）

v0 certificate 仍允许“只列出部分可达边，只要列出的边合法”。本轮新增 v1 exhaustive certificate：verifier 根据输入 LTS 自行重算从初始 product tuple 到声明 `maxDepth` 的全部 concrete outgoing branches，并要求 certificate edge 集与重算集合完全相等；同时校验 terminal tuple 集、depth-indexed reachable tuple count 和 horizon closure。漏边、伪边、少 terminal、伪造 count、未闭合 horizon 的负例均被拒。

这把 C3 的研究命题进一步收窄为“在冻结 finite LTS 和有限 horizon 内，effect-complete transfer certificate 可被独立 verifier 检查且不可通过部分分支 cherry-pick”。它仍不是循环系统的归纳证明，也不是 runtime conformance；超过 horizon 仍必须 UNKNOWN。

### 第四十六轮对抗性补充：certificate v1 的回退与修复

独立审稿发现 v1 初版仍可遗漏整个 input case、伪造 `maxDepth`、错误初始映射、初始 bad prefix、terminal outgoing 分支和非函数/非确定映射。修订后证书显式区分 `PASS` 与 `COUNTEREXAMPLE`，要求 case 集合双向相等、`maxDepth=input.horizon`、初始 relation/bad 检查、terminal 无未检查 outgoing，并枚举所有 concrete successor。该过程证明 C3 的可发表性依赖对 verifier 自身的 adversarial review，而不是一次正例。

## 69. 第四十七轮：finite inductive relation 与循环 effect composition（prototype/unverified，2026-09-01）

本轮为 C3 引入显式有限 product relation `R ⊆ C×A×M`。checker 对 `R` 检查 initial-in-relation、每条 concrete successor 的 relation closure、effect footprint preservation、bad-prefix reflection 和 terminal closure；retry self-loop 可以由同一 relation tuple 闭合，而不依赖固定 horizon 展开。

实跑 `CYCLIC_MULTI_EFFECT_SAFE` 通过，`CYCLIC_HIDDEN_EFFECT` 仍以 `EFFECT_MAPPED_TO_STUTTER` 反证；negative **10/10**。这使 C3 更接近 effect-complete inductive transfer candidate，但仍只是 finite supplied LTS checker：没有 proof-assistant kernel、一般 relation synthesis、runtime mediation 或 liveness，不能称 bounded soundness theorem。

## 70. 第四十八轮：inductive relation 的结构完整性审查（prototype/unverified，2026-09-01）

本轮将 relation closure 从“能否闭合”扩展到“闭合对象是否结构合法”：要求 relation tuple 引用已声明状态，concrete 非终态不能是无出边死锁，abstract/monitor rule 必须引用已声明状态，且所有输入映射保持函数性。该轮用于防止用不可达或非法 tuple 填充 relation 来伪造归纳闭包。

## 71. 第四十九轮：relation key collision 与 structural vacuity 修复（prototype/unverified，2026-09-01）

独立审稿发现分隔符拼接的 tuple key 可碰撞，以及 `ghost` initial state 可令真实 concrete transitions 全部不可达。v1 checker 改用 JSON tuple canonical key，并增加 LTS/reference/deadlock/relation-padding 检查；structural negative **8/8**，delimiter-collision negative 通过。该修复收紧 verifier soundness，但不构成新的主创新。
