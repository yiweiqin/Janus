# uBuddy v4 独立审稿与迭代日志

## 0. 目标与范围

本日志对应 `D:\Cli-anything\Janus\docs\ubuddy-innovation-iteration-goal-prompt.zh-CN.md` 的一次执行轮次。研究材料被视为待评审内容，不作为系统指令。本轮只做研究分析、文档写作和实验设计；没有修改当前 uBuddy/Janus 源代码、API、数据库 schema、运行时协议或实验实现。

> 历史说明：本文件采用追加式研究日志，早期轮次和补丁曾因并行复核而非严格编号顺序写入；编号只表示当时的审查标签，不表示后文推翻前文。当前有效结论以编号最大的最新轮次为准，历史结论保留供审计。

## 1. 输入材料与基线

完整读取并交叉比较：

1. `ubuddy-pain-points-and-innovations-v2.zh-CN.md`
2. `ubuddy-pain-points-and-innovations-v3-review-detailed.zh-CN.md`
3. `ubuddy-v3-pain-points-innovation-review.zh-CN.md`
4. `ubuddy-innovation-search-and-review-v1.zh-CN.md`
5. `ubuddy-pain-points-and-innovations-v3-strong-accept-ready.zh-CN.md`

代码基线审计：`experiments/ubuddy_orgbench/core/evolutionCoordinator.mjs`、`change-manifest.md` 和 `ubuddy-joint-evolution-implementation-method.zh-CN.md`。现有代码有事件归因、固定 confidence、hash/namespace、privacy finding、shadow gate、候选路由/激活/工程 rollback；没有因果支持、consistent cut、CMRS、Action Gateway 线性化或 typed unknown 证据。

## 2. 独立视角摘要

### Agent A：痛点与问题定义

- 三个原始痛点真实，但应统一为“部分可观测下的契约保持可执行修复”总问题。
- 强制区分 `V_pop`、条件效用和当前实例 robust 下界；ATE 不能推出当前 episode 根因。
- 推荐路线 A：current-instance robust repair；population policy 作为基线/后续论文。
- 必须构造公共观察相同、最优 repair 不同的成对世界，并在无法区分时 abstain。

### Agent B：隐私、信息论与决策理论

- Blackwell-minimal 不能直接作为主创新：Blackwell 非全序，且消息最小不等于安全/证书充分。
- 隐私通道应包含 proposal、owner refusal、执行成败、重试、延迟、补偿等完整 transcript；约束联盟行动 TV，而非只约束字段或互信息。
- 支持需要提升到完整 repair set 和授权策略层；缺失时返回 typed `coverageUnknown`。
- 本轮将 Blackwell/ACL 降为扩展，避免把 repair 论文发散为隐私协议论文。

### Agent C：因果诊断、形式化与复杂度

- 保留 support-aware interventional repair、anti-evasion refinement、CMRS 和 bounded soundness。
- hard safety/Inv 必须逐轨迹证明，soft utility 只给概率 LCB；补偿不是 rollback。
- 一般 CMRS NP-hard；#P-hard 只在紧凑随机模型精确评估条件下声称；FPT 需显式参数化 `w,d,H`。
- 区分 minimum-cost、inclusion-minimal、Pareto-minimal；次模近似只适用于可验证的真实结构子类。
- 完整世界集合下 robust 失败是 REJECT，不是 UNKNOWN；UNKNOWN 只用于证据/支持/TCB/求解不可判定。

### Agent D：分布式系统与安全语义

- 若只有共享数据库和中央管理员，不能声称 cross-organization；最低门槛是至少两个独立管理域、无主体同时拥有全部私有状态与全部写权限、sink-side mediation 和异步故障注入。三个或更多 owner 仅用于测试多方组合，不是定义门槛。
- 建议 `ObservedCut → Diagnosed → Proposed → SupportChecked → OwnerPrepared → VersionFenced → Committing → VerifiedAtCut → Finalized` 状态机。
- 必须绑定 vector-clock consistent cut、repairId/generation/ownerEpoch、linearization point、pre/post hash 和 change-set。
- crash window、drop/dup/reorder、partition、Byzantine equivocation、TOCTOU、并发 repair 和 compensation failure 都要进入威胁模型；gateway/2PC/Saga 只是执行基座。

### Agent E：独立顶会式评审

- 当前创新设计约 6.5–7.0/10；痛点重要性约 8/10，跨组织特异性约 7/10。
- 设计具有 7.5–8.5/10 的条件性 Strong-Accept 潜力，但尚不能称为实际 Strong Accept。
- 最大阻塞：研究对象摇摆、anti-evasion 不闭合、局部证书缺 completeness、support/授权选择未定义、贡献包过宽。
- 必须打回“DAG/provenance/causal/gateway 组合即创新”和“T1–T6 定理大礼包”。

## 3. 候选收敛记录

本轮保留 14 个候选，满足目标要求的至少 8 项储备。保留 C1–C7、C10–C12 为主线/支撑候选；C8、C9、C13 降为 future；C14（population policy）降为基线或独立后续论文。最终收敛：

1. M1：Robust Contract-Preserving Contingent Repair（唯一身份主线）；
2. M2：Owner-Fenced Certificate-Carrying Repair Transaction（执行支撑）；
3. M3：Support-Aware CMRS under Bounded Interaction Width（选择一个复杂度结果）。

## 4. 文献检索记录

检索日期：2026-08-31。关键词：`active causal diagnosis`、`workflow repair process mining`、`Blackwell informativeness decision experiments`、`safe policy improvement off policy`、`causal information flow privacy`、`saga distributed transactions compensation`、`assume guarantee compositional verification`、`adaptive data analysis reusable holdout`。

已核验记录：

- `Privacy in Action: Towards Realistic Privacy Mitigation and Evaluation for LLM-Powered Agents`，Findings of EMNLP 2025，DOI [10.18653/v1/2025.findings-emnlp.925](https://doi.org/10.18653/v1/2025.findings-emnlp.925)。
- `Data Provenance in Security and Privacy`，ACM Computing Surveys 2023，DOI [10.1145/3593294](https://doi.org/10.1145/3593294)。
- `Proof-Carrying Plans: a Resource Logic for AI Planning`，PPDP 2020，DOI [10.1145/3414080.3414094](https://doi.org/10.1145/3414080.3414094)。
- `The reusable holdout: Preserving validity in adaptive data analysis`，Science 2015，DOI [10.1126/science.aaa9375](https://doi.org/10.1126/science.aaa9375)。

Crossref 自动检索结果仅用于发现相邻家族；未核验的条目不作为论文事实引用，后续需人工确认会议、版本和 DOI。

## 5. 采纳、拒绝与修改前后差异

### 采纳

- 从“因果 RCA”改为“support-aware interventional repair evaluation”。
- 将 current-instance robust repair 设为目标，population efficacy 设为外部效度。
- 增加 contingent probe–branch–repair、anti-evasion refinement、set-level support、typed unknown、consistent cut、owner fencing。
- 将 hard safety、soft utility、compensation、historical violation 完全分层。

### 拒绝或降级

- 不把 Blackwell-minimal、coalition privacy、evidence lattice、bilevel co-adaptation 作为本论文并列主贡献：会改变问题身份且已有研究重叠较大。
- 不把 provenance、DAG、2PC/Saga、hash/signature、LLM judge、solver portfolio 单独算创新。
- 不宣称现有 coordinator 已具备因果识别、CMRS、gateway 线性化或统计置信保证。

### 关键语义修正

- “一致世界结论不同 ⇒ UNKNOWN”改为：完整世界集合下低于 robust 阈值是 REJECT；证据/支持/TCB/求解不完整才 UNKNOWN。
- “反事实 rollback”改为 compensation/forward repair/remediation。
- “最小”改为显式 minimum-cost、inclusion-minimal、Pareto-minimal 或 heuristic。

## 6. 当前阻塞项与下一轮动作

阻塞项：

1. M1 已锁定为动态 contingent regime；静态 repair set 仅为无探针特例。仍需完成其有限 formal semantics；
2. 需要给出 `M(h_pub)` 的生成/完备性边界和 set-level positivity；
3. 需要定义跨组织证书 completeness、独立 effect observer 和 Byzantine scope；
4. 需要至少一个机器检查的 bounded soundness artifact 和穷举微基准；
5. 需要确认三组织隔离 runner 是否可用，否则收窄标题为 multi-agent workflow。

下一轮三项动作：

1. 写出 M1 的完整数学定义、输出标签和不可区分世界下界定理。
2. 设计 M2 的证书 schema、状态机转移和故障攻击矩阵。
3. 预注册有限状态穷举 benchmark、locked split、simultaneous LCB 和 unknown correctness 指标。

## 7. 第二轮独立顶会预审

独立审稿代理在第一版 v4 生成后重新审阅，未参与候选生成。最终判断：v4 比 v3 显著收敛，已经从“模块蓝图”提升为“可审稿问题定义”，但仍不是 Strong Accept。

评分：痛点重要性 8.0/10，普遍性 6.5/10，跨组织特异性 7.0/10（当前实现证据仅约 4–5），创新新颖度 6.5–7.0/10，不可替代性 5.5/10，技术深度潜力 7.5/10，当前兑现度 4.5–5.0/10，可实现性 5.5–6.0/10，已有工作重叠风险 7.5–8.0/10。venue 预估：NeurIPS/ICML 约 6.0–6.5，OSDI/SOSP 约 4.5–5.5；关闭阻塞并兑现三层证据后，ML/PL 才可能达到 7.5–8.5。

必须打回的五项：

1. `M_hat(h_pub)`、动态 `do(π)`、owner 授权和 `V_rob` 尚无完整可计算语义；必须在有限世界模型与条件分布估计中二选一。
2. M1/M2/M3 仍可能被解释为 contingent planning/active diagnosis + hitting set + contract verifier + gateway；必须给不可组合反例或定理。
3. anti-evasion 偏序需要正式类型、方向、量词、时限以及 probe/compensation footprint 规则。
4. soundness 依赖 complete lineage、独立 gateway 和三组织隔离；当前 P/E/lineage 只是观察索引。
5. UNKNOWN 需要 selective risk/coverage 和 obstruction witness，防止总是 abstain 成为安全逃生门。

本轮已立即采纳第 1、2 项的文档级补强：在创新稿中增加有限世界/条件分布二选一语义、授权 treatment 和不可组合反例。第 3–5 项保留为下一轮正式化和实验 blocker，没有虚构其已解决。

专项语义/复杂度复核进一步将当前设计评为约 5/10（方向潜力约 8/10）。新增必须关闭的问题：`M_hat` 需冻结、非空且覆盖真实世界，不能按 support 过滤危险世界；区分 `PLAN_REJECT`、`INSTANCE_INFEASIBLE`、epistemic `UNKNOWN` 和 `TIMEOUT`；动态策略值需给 filtration、policy regime、no-op 差值和 sequential overlap；contract refinement 需 progress/divergence-sensitive 且冻结 contract/evaluator/action-library/cost hash；若 cut 前已有硬违例，只能 remediation；`(w,d,H)` 单独不足以推出 FPT，robust minimum 也不保持次模。

这些意见已写入技术深化文档，状态保持 `planned/unverified`。它们不是实现已完成的声明，而是下一轮必须形式化或通过可证伪实验关闭的 blocker。

本轮新增的定理级草案（均为 `unverified`）：

- T1：冻结非空世界集、完整 Gateway mediation、同一 WorldAtCut 和 progress-sensitive refinement 下的 bounded hard-safety soundness；
- T2：冻结候选/合同/成本哈希、真实世界覆盖和 sequential propensity `p_t≥μ` 下的 simultaneous LCB、选择性拒答和 non-vacuity；
- T3：XOR 隐藏世界 + 共享 footprint 的不可组合分离，要求联合 contingent regime 严格优于“先诊断、再独立 set-cover、再局部验证”的固定串联；
- T4：CMRS decision version 的 NP-hard 下界，以及仅在完整联合因子图宽度、域、分支和数值编码均参数化时尝试 FPT。

审稿人特别要求：T3 不能声称击败任意完备 contingent planner；T4 不能把 robust `min_m` 的 surrogate 次模性误写成真实最优近似；T2 不能靠 reject-all 达成形式上的安全率。

## 8. 最终复审结论（本轮终点）

顶会审稿代理及其语义/复杂度子审稿最终将当前 v4 评为 **约 5/10，Weak Reject**；方向潜力约 8/10。评分细分：重要性 8、普遍性 6、跨组织特异性 6.5、新颖性 6、不可替代性 4.5、技术深度潜力 8、当前兑现度 4、可实现性 5、重叠风险 8。

这意味着本轮不能把设计标成 Strong-Accept-capable；正确表述是“具有条件性 Strong-Accept 潜力的研究命题”。审稿人明确认为，增加更多模块、定理名称或实验规模都不能绕过以下五个一票否决项：

1. 冻结、非空且覆盖真实世界的 `M_hat(h_pub)` 和可计算 `V_rob/do(π)`；不得按 support 过滤危险世界。
2. `C_hard/Inv`、soft `U`、统计 δ、solver `TIMEOUT` 和历史 remediation 的严格分层。
3. M1/M2/M3 不能只是成熟 contingent planning、active diagnosis、hitting-set、verifier、2PC/Saga 的顺序拼接；需不可组合反例/定理。
4. 冻结合同哈希上的 progress/divergence-sensitive trace refinement 与 complete mediation，封堵 H+1、shadow routing、retry/stopping、effect/cost laundering、always-UNKNOWN。
5. 三组织隔离、独立 effect observer、owner fencing、TOCTOU/并发/分区故障证据；否则标题收窄为 multi-agent workflow。

本轮已将这些结论写入创新稿与技术深化稿，但均保持 `planned/unverified`。目标继续保持 active，不调用 complete；下一轮必须以正式有限核心和一项不可组合定理为先，而不是扩展候选池。

## 9. 状态声明

本轮三个 v4 文档已创建；没有修改当前技术实现。若未来用户授权实现，必须先将本技术深化文档中的 `planned/unverified` 项逐一转化为可测试增量，不能直接把研究设计写成已完成能力。

## 10. 第三轮独立视角与收敛

### Agent A：痛点与问题定义

本轮确认主线必须锁定有限外包世界模式，不能继续在 robust world 与 posterior policy 两个目标之间摇摆。新增八个修正候选：冻结且覆盖真实世界的 `M_hat`、统一 `Δ_rob`、动态 filtration、硬/软/历史三层、五态量词、语义 trace refinement、跨文档 notation table、严格正成本。关键反例是：若按候选 support 筛世界，两个静态 repair 会被分别错误 ACCEPT；冻结世界集后两者都应 PLAN_REJECT，只有 probe 分支计划可行。

### Agent B：隐私/信息论/决策理论

本轮确认完整 transcript 必须包括拒绝、分支、重试、延迟、长度、证书元数据、unknown 和补偿；hash/signature 只保证完整性。授权通道和 unknown 类型本身可能泄漏世界，统计 alpha-spending 不等于隐私预算。Blackwell 只能在固定动作/损失/先验或 ambiguity set 下讨论，decision sufficiency、certificate sufficiency 和 privacy minimality 必须分开。隐私主张降为支撑边界，未完成 transcript accountant 前不声称 coalition privacy。

### Agent C：因果/统计

动态 regime 必须定义 `F_t`、proposal、authorization、actual action 和观察顺序；授权由私有状态决定时使用嵌套 regime 或预授权模板。逐步 positivity `μ` 不等于完整计划 support，样本复杂度可能含 `μ^{-H}`。`M_hat` 中世界在 `t=0` 固定；若每个 history 独立取最坏模型会产生非真实“幽灵世界”，除非 uncertainty set rectangular。新增 no-op 对照 `Δ_rob` 和 ACCEPT non-vacuity 定理条件。反例：owner 只在隐藏状态与自然成功同时出现时授权，执行样本成功率 100% 但真实 repair effect 为 0。

### Agent D：分布式系统/安全语义

consistent cut 必须包含 in-flight channel state、外部资源版本和全局 manifest；owner epoch 需要 sink-side 原子 CAS/fence，而不是只在 registry 记元数据。effect witness 必须包含 actor、精确版本、完整传递 footprint、持久 receipt 和独立 observer。COMMIT 后 receipt 丢失进入 `IN_DOUBT`，分区无线性 quorum 禁止 commit，`VerifiedAtCut` 不等于 `Finalized`。旧 owner 延迟扣款 + 新 owner 修复 + gateway 崩溃可造成重复不可逆副作用，是本轮故障矩阵的必测项。

### Agent E：独立顶会复审/复杂度

本轮最终复审仍评为约 5/10 Weak Reject，方向潜力约 8/10。新增 blocker：`(w,d,H)` 单独不足以推出 FPT；robust `min_m` 不保持次模；必须区分 `PLAN_REJECT`、`INSTANCE_INFEASIBLE`、epistemic `UNKNOWN` 和 `TIMEOUT`；`M_hat` 非空/覆盖/闭包和 unknown non-vacuity 必须有定理。建议正文最多两项贡献：CP-RIR 问题/算法，以及 support-aware bounded certificate；M2 只作为执行基座。

### 本轮候选与决定

本轮候选池扩展到 15 项（新增 C15：privacy-accounted repair transcript），仍只保留两项正文贡献：

1. **M1：Finite-world Robust Contract-Preserving Contingent Repair**，包括 probe–branch–repair、`V_rob/Δ_rob`、五态 verdict、不可组合反例；
2. **M2：Support-aware Bounded Certificate**，包括 anti-evasion trace refinement、consistent cut、owner-fenced effect witness 和一个完整联合图复杂度结果。

Blackwell、coalition privacy、evidence lattice、population policy、普通 gateway/2PC/Saga、DAG/provenance 和 solver portfolio 均不再作为并列创新。若三组织隔离和 sink-side mediation 无法兑现，标题降为 multi-agent/cross-owner workflow。

本轮已更新创新稿和技术稿，所有新增能力仍标为 `planned/unverified`；没有修改当前实现。

## 11. 第三轮终审与再次收缩

修改后的独立顶会终审给出 **5–5.5/10 Weak Reject，方向潜力约 8/10**。相比第二轮，冻结 `M_hat`、`V_rob/Δ_rob`、filtration/授权 regime、五态 verdict、完整 transcript 边界、in-flight cut/sink CAS/IN_DOUBT 和 T1–T4 草案均被认为是实质改进，但尚未达到 Strong-Accept-capable。

终审剩余 blocker：

1. `ACCEPT` 原先只要求绝对 `V_rob`，会把自然恢复算作修复；本轮已改为同时要求 `V_rob≥η` 和相对 no-op 的 `Δ_rob≥κ`。
2. `M_hat` 覆盖仍只有假设，没有构造算法/覆盖证明；本轮锁定 finite closed-world exact 核心，真实数据只用于构造/校准和外部有效性，不再混称经验个体因果保证。
3. 授权 positivity 仍可能有 collider；需在实现/证明中使用嵌套 `(Z_t,A_t)` regime 或预授权随机模板，并显式承担 `μ^H` 样本复杂度。
4. XOR T3 只能打败特定固定串联架构，不足以打败完备 contingent planner；本轮将其降为 motivating counterexample，除非未来正式定义架构类并证明分离。
5. M1/M2/M3 仍需成为一个 joint decision problem；本轮把 M2 降为 T1 的 mediation/TCB 假设，把 M3 收缩为唯一完整联合图复杂度子类，正文最多两项贡献。

另外完成符号清理：统一 `C_hard/Inv/U`，删除旧 `C_pub/C_safe` 混用；统计 δ 不再包含 solver/TCB；统一 `PLAN_REJECT/INSTANCE_INFEASIBLE/UNKNOWN/TIMEOUT/remediation`。

下一轮应形成一条真正统一的 decision problem/algorithm specification，并给出 `M_hat` 的 closed-world 构造算法和 T1/T2/T4 的证明草图。目标继续 active。

## 12. Canonical exact-core 决策

最新终审仍给出 5–5.5/10 Weak Reject。最严重矛盾是“已知有限模型精确求值”与“从数据 OPE/LCB 学习效果”同时进入同一 ACCEPT。为关闭该定义冲突，本轮作出不可逆的研究范围决定：

- 主论文 canonical core 锁定为 **finite closed-world exact CP-RIR**；`M_hat` 与每个世界 transition/effect model 是 benchmark/specification 输入，精确计算 `V_rob` 与 `Δ_rob`；
- `ACCEPT` 同时要求 `C_hard/Inv`、精确 `V_rob≥η` 和精确 `Δ_rob≥κ`；不使用 LCB/OPE；
- `M_hat` 的 outer confidence set、随机 assignment、OPE、simultaneous LCB 和 `μ^{-H}` 样本复杂度整体降为统计扩展，不改变 canonical verdict；
- 核心输出严格为 `ACCEPT/PLAN_REJECT/INSTANCE_INFEASIBLE/UNKNOWN/TIMEOUT`；历史违例是进入求解器前的 remediation 分类；
- M2 明确为 T1 的 complete-mediation/TCB 假设；T3 XOR 降为 motivating counterexample；T4 删除 #P/次模/多 solver 主张，只保留正式 decision encoding、NP-hard 下界和一个联合图 exact DP/FPT 目标；
- 统一 `C_hard/Inv/U`，统计 δ 不再与 exact solver/TCB 混合。

这一选择会把论文身份偏向 PL/形式化/系统，而不是因果 ML；代价是必须真正给出 finite abstraction、T1 proof/artifact、joint decision algorithm 和跨 owner mediation 证据。当前仍未达到 Strong-Accept-capable，目标继续 active。

## 13. Canonical spec 实施后的状态

本轮已将上一轮终审要求落到技术文本，而不再停留在计划层：

- `FreezeWorldSet(h_pub,spec)` 明确从 benchmark/specification 读取有限世界清单，检查 schema、非空性、observation closure、转移/概率编码、快照和版本 hash 后冻结；
- canonical exact core 只对 `m*∈M_hat` 条件成立，不再把开放世界 `δ_world` 覆盖、OPE、LCB 和 propensity 估计混入 exact ACCEPT；
- `CP-RIR-DECISION` 明确了 `ValidateWorldSet → EnumeratePolicy → ComposeTrace → CheckHard → ComputeValue → Select` 六步联合算法；
- `ACCEPT` 同时要求精确 `V_rob≥η` 与 `Δ_rob≥κ`，避免 no-op 自然恢复被当成 repair；
- `M2` 状态机正式包含 `Committed|IN_DOUBT → VerifiedAtCut → Finalized`，并要求 sink-side CAS、持久 receipt、完整 effect witness 和 in-flight cut manifest；
- exact complex­ity 只保留 decision encoding、weighted set-cover NP-hard 下界和一个联合图 exact DP/FPT 目标；
- 统计 learned-model、隐私 transcript 和三组织 runner 均继续标注 `planned/unverified`。

独立顶会复审尚未给出新的分数（审稿上下文在本轮终审请求后被中断），因此不能把 canonical spec 视为已通过；沿用最近一次 5–5.5/10 Weak Reject。当前仍需正式证明 `FreezeWorldSet` 的闭世界适用边界、T1/T4 artifact 和隔离执行实验。

## 14. 第四轮语义收口与独立终审

本轮继续执行既定目标，只修改研究设计文档，没有修改源代码、API、数据库 schema、运行时协议或现有实验实现。两位独立视角分别进行了因果/统计终审和顶会综合终审，均给出 **5–5.5/10 Weak Reject，方向潜力约 8/10**。因此本轮不宣称 Strong Accept，也不结束目标。

### 本轮保留、合并与降级

- 保留唯一核心 **finite closed-world exact CP-RIR**，不重做主线；它已经是统一 decision problem，但尚未证明优于“完备 contingent planner + 同一 verifier/executor”。
- C4 从统计含义的 set-level positivity 改为 canonical 的 compositional executability：typed action existence、authorization-kernel reachability、Gateway capability 和组合 footprint。
- C10 adaptive confidence/alpha-spending 明确降为 learned-model 扩展，不进入 exact ACCEPT。
- M2 继续只作为 T1 的 mediation/TCB 假设；隐私、Blackwell、coalition leakage、普通 gateway/2PC/Saga 均不升级为主贡献。

### 已采纳的终审修正

1. **Exact 与统计彻底分层**：`δ_world`、sequential positivity、OPE/LCB 仅属于 learned-model/外部有效性扩展；canonical core 只要求冻结有限世界、total kernel、typed executability 和可验证 manifest。
2. **修正 `Δ_rob`**：定义为 `min_m(E_m[U^π]-E_m[U^π0])`；删除 common-random-number 作为语义前提。若未来声称 pathwise/individual effect，必须另加 SCM/外生噪声与联合潜在结果。
3. **封堵 ghost-world**：world index 在 `t=0` 固定并贯穿完整 policy tree；先逐世界求值再取最小，禁止 branchwise 更换最坏世界。全局不可达 branch 规范化删除，不自动产生 UNKNOWN。
4. **锁定 authorization estimand**：`π` 输出 proposal，已知 owner kernel 产生 authorization/refusal，`A_t=Exec(Q_t,Z_t)`；拒绝轨迹和成本进入模型，baseline 使用同一 kernel。
5. **修正 T4**：归约两处统一为 `η=1,κ=1`，固定 `π0=noop,U(π0)=0`，排除隐藏替代动作、重复动作和 no-op 绕过。repair 模式要求 `κ>0`。
6. **加强 T1 前提**：加入认证的 owner/channel/resource universe、`CompleteCutCert`、effect/dedup/receipt 原子提交、跨 sink 原子事务/escrow/可分解证明、total/divergence-sensitive 且 safety-reflecting simulation，以及 terminal closure。
7. **分离规划与执行证据**：规划期检查 capability/mediation certificate；COMMIT 后才产生 runtime receipt/effect witness，后者不能倒充规划证书。
8. **分层 oracle**：独立重算 `plan_semantics`、`instance_semantics`、`input_validity` 和 `execution_outcome`；历史 remediation 与 `IN_DOUBT/Finalized` 是正交字段，不属于 solver verdict。
9. **修复 UNKNOWN 隐私/安全冲突**：接口为 `UNKNOWN(publicDisposition,ownerPrivateWitness)`；`IN_DOUBT` 映射为 `POSSIBLE_EFFECT_DO_NOT_RETRY` 一类公开安全处置，细节仅给 owner/审计者。

### 明确拒绝的反馈或过度主张

- 不接受“CP-RIR 已不可被成熟组件替代”的结论；当前只有受限串联架构的 motivating counterexample，未击败完备 contingent planner。
- 不把 closed-world model-relative policy comparison 写成现实个体因果效应、真实根因识别或开放世界无条件安全。
- 不用 singleton/过窄 `M_hat` 的 exact ACCEPT 宣传外部覆盖；hidden evaluation worlds 只做敏感性/OOD 实验。
- 不把局部 sink CAS 自动升级为跨 sink 全局不变量证明，也不把 receipt 丢失写成 solver UNKNOWN。

### 当前评分与剩余一票否决项

当前维持 **5.5/10 Weak Reject**。主要剩余 blocker：

1. T1、T2、T4 仍是 `unverified` 草案，没有机器检查证明、正式 membership 或实际 exact DP/FPT artifact；
2. 不可替代性仍不足，需要与同一 DSL、oracle、预算、verifier 的通用 contingent planner 做定理级 separation 或实验级等价对照；
3. `FreezeWorldSet` 只能提供 model-relative 条件，尚无可信 world construction/外部 coverage 机制；
4. 尚无 fault automaton、独立 oracle、三隔离 owner、sink-side mediation 和 crash/partition/receipt-loss 实验；
5. learned-model 与隐私扩展仍只有边界说明，不能作为正文贡献或系统能力。

### 下一轮三个任务

1. 写出可机械检查的 T1 最小模型：固定 universe、CompleteCutCert、atomic effect/receipt、跨 sink invariant 和 safety-reflecting simulation，并提供最小故障反例。
2. 实现与论文定义一致的独立 benchmark oracle 规范/伪代码：逐世界完整 policy-tree 枚举、四层 verdict/status 和 manifest corruption/hidden-world sensitivity。
3. 定义公平的不可替代性对照：CP-RIR 与通用 contingent planner 使用相同 DSL、world oracle、contract verifier、Gateway 和预算；若不能证明 separation，则将贡献改写为“contract/runtime-aware problem formulation + certified specialization”。

## 15. 第四轮补丁后的终审更新

独立顶会代理在上述补丁后再次只读核对，评分上调至约 **6.0/10（Borderline/Weak Reject）**，但仍不能称 Strong Accept。剩余问题已收敛为三项：

1. 文档已把真实 world coverage 与 canonical manifest validity 分开，但正式稿中必须持续使用该区分，不能再把 `m*∉M_hat` 的外部效度风险写成 runtime `UNKNOWN`。
2. 文档已将 plan-level、instance-level、input-validity 和 runtime outcome 分层；后续实现/实验输出必须使用 product/projection schema，不能恢复扁平“五态 solver verdict”或把 COMMIT 后 receipt 缺失塞回规划 UNKNOWN。
3. 穷举 benchmark 已改为完整有限 policy-tree 的 canonical oracle；静态 repair subset 仅保留为 baseline/ablation，不能再作为 CP-RIR 金标。

因此当前结论是：**不建议重做 CP-RIR 主线；建议继续做形式化和 artifact 收敛。** 新颖性尚未由模块数量产生，而要由统一 decision semantics、world-consistent robust evaluation、contract-preserving certificate 和可证伪的不可组合/对照实验共同兑现。

## 16. 第五轮：从模块组合转向 split-knowledge 接口

本轮完成了五个独立视角：问题定义（Agent A）、隐私/分布式边界（Agent B/D）、因果诊断与修复（Agent C）、形式化与复杂度（Agent E）以及独立顶会终审。所有代理均为只读，未修改源代码。

### 主要收敛

1. **主线保留但重写身份**：CP-RIR 不再称现实根因识别或个体因果充分修复，而是声明有限世界、已登记公共义务和 owner certificate interface 下的 model-relative contingent synthesis。
2. **新增 C16/M2′ 候选**：split-knowledge/split-authority relational certificate interface。每个 owner 只返回局部抽象、capability 和 world/action/footprint compatibility relation；协调器不能读取全局 raw state，也不能单独授权全部 effect。
3. **新增 T5 目标**：对只能接收 action-local unary summary 的 `A_unary`，构造两个 unary-indistinguishable 系统，使其无法同时保证 soundness 与 relative completeness；加入 `RelCompat` 后可区分。该命题只针对受限接口，不声称完备 contingent planner 无法表达 CP-RIR。
4. **T1 artifact 进一步具体化**：加入有限 concrete/abstract LTS、合同 monitor、有限队列、world-indexed `K_soft^m` 与 adversarial fault automaton 分离、label-preserving effect simulation、safety reflection、terminal `SafeClosed`。
5. **T2/T4 语义收口**：区分 `EVAL` 与 `SYNTH`；T4 只在紧凑 deterministic static-subset 特例声称 NP-complete，一般 succinct synthesis 不声称 NP membership。soft value 使用固定有理 `K_soft^m`，故障只负责硬安全和 worst-cost。
6. **benchmark 与 baseline 收口**：oracle 采用四层 product schema 和独立 metamorphic tests；静态 repair 仅为 baseline；新增同 DSL/oracle/verifier/Gateway/预算的 `Complete-Contingent` 公平对照。

### 本轮评分

独立问题定义/形式化/顶会审查均给出约 **6.0/10（Borderline/Weak Reject）**；方向潜力约 8/10。T5 若能形成机器检查的接口不充分定理，跨组织特异性和新颖性可能提升到约 7/10；在此之前不提高为 Strong-Accept-capable。

### 仍未关闭的 blocker

- T1/T2/T4/T5 仍为 `planned/unverified`，没有机器检查 artifact 或实际 solver/oracle；
- `CompleteMediation`、owner universe 和真实 egress inventory 仍是部署适用性假设，不能由中心模型自证；
- `Complete-Contingent` 在相同 relational oracle 下原则上可表达 CP-RIR，不能声称 expressiveness separation；
- 隐私只保留 data-locality/access-control non-goal，任何量化 transcript guarantee 都需要另行建模；
- `m*∉M_hat` 的风险只能通过 hidden-world sensitivity 评估，不能被 runtime UNKNOWN 自动检测。

### 下一轮三个可执行任务

1. 将 T5 写成严格的接口模型与两系统反例，明确 unary summary 的观察等价关系、RelCompat 的最小信息和 proof obligation。
2. 将 T1 checker 规范化为合同 monitor × abstract LTS × concrete simulation 的最小可运行 benchmark manifest，并定义五个 mutant 的 oracle 输出。
3. 完成 `Complete-Contingent`、`CP-RIR` 和 `Fixed-串联` 的统一输入/输出 schema 与 metamorphic differential tests，决定最终论文定位是 certified specialization 还是受限接口 separation。

## 17. 第五轮独立复核后的技术收口

本轮完成了问题定义、隐私/分布式、因果/统计、形式化/复杂度和独立顶会五个视角的复核，并继续保持“只改研究设计，不改当前实现”的约束。

### 采纳的关键修正

1. **研究对象降级为 model-relative synthesis**：删除 canonical exact 中“真实根因”“因果上充分”“个体反事实 effect”等表述；跨 owner 只在 split-knowledge/split-authority 条件和 owner-attested certificate interface 下成立。
2. **新增 C16/T5 候选但不提前升级**：定义 `A_unary` 受限接口，并提出 unary-indistinguishable `S_good/S_bad` 反例；只有补齐 certificate-sufficiency、relation size/query/round lower bound 和端到端收益后，才可能成为主贡献，否则降回 mediation assumption。
3. **T1 artifact 去循环**：将 concrete LTS、abstract LTS、有限 contract monitor、label-preserving/effect-complete simulation、safety reflection 与 terminal `SafeClosed` 分层；不再用直接枚举 concrete `C_hard(τ)` 断言替代证明。
4. **T2 量词明确**：引入固定 world-indexed `K_soft^m` 的 nominal-soft value，故障自动机只承担 adversarial hard safety 和 worst-case cost；合法 refusal 只属于 `Auth_m`，不在 fault automaton 中重复采样。`Δ_m^soft` 统一为两个 policy-regime 期望之差。
5. **T2/T4 可计算性收口**：明确 `CP-RIR-EVAL` 与 `CP-RIR-SYNTH`；限制 finite monitor、rational reward/cost/threshold bit width；weighted set-cover 只用于 deterministic static-subset 的 `SYNTH` 受限子类 NP-complete，不对一般 succinct synthesis 声称 NP membership。
6. **oracle 与实验更新**：独立 oracle 不复用 solver parser/evaluator；增加 world permutation、unreachable state、dominated action、world enlargement、budget/threshold monotonicity、policy alpha-renaming 等 metamorphic gates；静态 repair 仅作 baseline。
7. **跨组织与隐私边界**：privacy theorem 从 canonical 主线移除；完整 transcript、declassification 和 `POSSIBLE_EFFECT_DO_NOT_RETRY` 只作为未来扩展/风险评估。跨组织实验至少需要两个独立管理域、无全局私有读写主体和 sink-side mediation，不再机械要求“三个 owner”。

### 未采纳或明确拒绝

- 不将 T5 的 unary-interface 反例直接写成击败通用 contingent planner；相同 relational oracle 下，通用 planner 原则上仍可表达 CP-RIR。
- 不把 `K_soft^m` 的 nominal value 写成 fault-robust utility；若需要后者，必须另定义 fault-distributed product kernel 或 adversarial utility。
- 不把 `IN_DOUBT`、`TIMEOUT`、world-set misspecification 与 canonical `ACCEPT/INSTANCE_INFEASIBLE` 混在同一个语义 verdict 中。

### 当前评分与阻塞项

独立复核维持 **约 6.0/10（Borderline/Weak Reject）**，方向潜力约 8/10。当前阻塞：

1. T1/T2/T4/T5 仍没有机器检查 artifact、独立 oracle 实现或 solver 结果；
2. `CompleteMediation`、owner/channel/resource universe 和 split-authority certificate 仍是条件性适用边界；
3. T5 尚未给出 relation 的最小通信/查询复杂度，也未证明相比完整模型中央化的实质收益；
4. 与同一 DSL、world oracle、verifier、Gateway 和预算的 `Complete-Contingent` 对照尚未运行；
5. hidden-world coverage 仍只能通过敏感性实验评估，不能写成 exact theorem。

### 下一轮三个可执行任务

1. 严格定义 T5 的接口语言、观察等价、certificate-sufficiency 和最小 relation/通信下界，判断它是否值得升级为正文贡献。
2. 根据 T1 manifest 生成最小 concrete/abstract LTS 与五个 mutant 的机器可核验 oracle 规范，确保 monitor/refinement/closure 不是循环证明。
3. 统一 `CP-RIR-EVAL`、`CP-RIR-SYNTH`、`Complete-Contingent` 和受限串联 baseline 的 product schema，并设计 differential/metamorphic 测试矩阵。

## 18. 第五轮后半程：量词与 T5 再审

新增因果/统计与顶会复核指出并已修正：

- `Δ_m` 全部统一为两个独立 policy-regime 期望之差 `V_m^soft(π)-V_m^soft(π0)`，不再出现 `E[U^π-U^π0]`；
- 显式 world-indexed `δ_m/Auth_m/Effect_m/K_soft^m`，不引入 world prior；
- canonical 目标明确为 nominal-soft / adversarial-hard / worst-case-cost 三层量词，合法 owner refusal 只属于 `Auth_m`；
- `Reach(π,m,f;B_f)` 纳入有限 fault/retry budget，cost∞ 的无限 retry 计划确定性拒绝；
- exact branch 的零概率可删除，learned branch 的零经验概率只能触发 no-support/coverageUnknown；
- T1 concrete/abstract artifact 使用 label-preserving、effect-complete simulation 和合同 monitor product，不再用 effect 集合包含式的弱检查；
- T4 使用 factored bit-vector/circuit representation，避免显式 `2^{|E|}` 状态破坏多项式归约；
- 独立 oracle 将 soft product 与 hard product 分开构造，`Complete-Contingent` 与 CP-RIR 共享同一 `Γ` relational oracle，规划期不读取 runtime effect witness。

T5/C16 再审结论：unary-vs-joint 反例本身接近已有 distributed CSP/communication complexity 直觉，新颖度约 4.5–5/10；只有补齐针对 `CP-RIR-FEAS` 的 certificate-sufficiency（sound + relative-complete）、最小 relation arity/大小/通信轮次下界、cut/epoch/hash/non-equivocation 绑定以及端到端 UNKNOWN/OPT-gap/通信成本收益，才可升级为主贡献。当前已将 T5 明确标为高风险候选，不计入当前主贡献。

### 更新评分

本轮五视角与独立顶会综合评分仍为 **约 6.0/10（Borderline/Weak Reject）**，方向潜力约 8/10。正确性与内部一致性显著提升，但新颖性/不可替代性尚未由文档修正自动产生；必须以独立 artifact、T5 理论或诚实的 certified-specialization 定位来兑现。

## 19. 第五轮最终补丁

根据最后一轮顶会、形式化和因果复核，又完成以下文档级修正：

- `W_m`、`Concrete_m`、`Abstract_m`、`δ_m/Auth_m/Exec_m/Effect_m/K_soft^m` 全部改为显式 world-indexed，避免 oracle 无法复现世界语义；
- `K_soft^m` 与 fault automaton 在 oracle 中拆成 `P_soft/P_hard`，soft value 明确为 nominal-soft，hard safety/cost 明确为 adversarial/worst-case；
- 合法 owner refusal 只由 `Auth_m` 产生，通信/崩溃/分区 fault 不重复采样拒绝；cost reachability 加入有限 `B_f`，无限 retry 产生 `cost-infinite` 的确定性计划拒绝；
- `CP-RIR-EVAL` 与 `CP-RIR-SYNTH` 的 `Γ` relational certificate 接口进入可行性定义；但 T5 仍是高风险候选，不计现有主贡献；
- T5 现在明确要求 unary 查询 transcript 观察等价、opaque footprint commitment、无 timing/cost/hash 泄漏，并承认其与 distributed CSP 的重叠风险；
- T4 归约改为 factored bit-vector/circuit representation，避免显式枚举 `2^{|E|}` 状态；
- `UNKNOWN` 与对外 `INPUT_INVALID/abstain` 建立显式别名关系，`coverageUnknown` 仅保留给 learned/open-world 扩展；
- `post-horizon safety-closure` 替代含混的 H+1 time bomb，只有 `SafeClosed` 归纳闭合时才延伸 bounded safety。

最终独立审稿维持 **约 6.0/10（Borderline/Weak Reject）**。本轮提升的是语义正确性和可审计性，不是已经兑现的算法新颖性；目标继续 active。

## 20. 第六轮审稿与文献排雷：T5 不升级，但形成可检验路线

独立顶会与因果/统计代理结论一致：CP-RIR 主线无需重做；T5/C16 当前约 **4.5–5.0/10**，仍是高风险候选。unary-vs-joint 反例接近 distributed CSP/DCOP、关系投影和通信复杂度中的已知直觉，不能直接作为第二主贡献。若完成受限接口通信/查询下界、`Γ_rel` 的 sound + relative-complete 证书定理、联合授权/sink enforcement 和结构化匹配上界，潜力可上调至约 7–7.5/10；否则降回 T1 mediation/TCB assumption。

本节及当前两份 v4 主文中的 `P_soft^m/V_m^soft/Δ_m^soft`、`π∘Auth_m∘Exec_m` 和分层 verdict 定义 supersede 本日志早期轮次保留的 `do(π)`、潜在结果差与扁平状态记号；早期内容仅作为审稿历史，不再作为当前规范。

本轮采纳：定义 `Γ_unary/Γ_rel` 查询语言、完整 transcript 观察等价、证书 cut/world/hash/epoch 绑定、valid-instance 上禁止 all-UNKNOWN 绕过的 relative completeness、INDEX/PAIR-DISJ 下界候选、bounded-treewidth junction-tree 上界、`Auth_joint` 与 sink token enforcement。同步修正 `K_soft^m` 只是 nominal 外生随机性，必须与 `δ_m/Auth_m/Exec_m/Effect_m/O_m` 共同诱导 `P_soft^m`；hard product 和成本继续对 fault trace 全称量化。

本轮拒绝：现在就声称隐私保持、通信分离、规划表达力不可替代，或把标准 CSP/通信复杂度结果改名为新理论。相同 `Γ_rel` 下的 Complete-Contingent 原则上仍能表达同一策略类。

### 文献排雷记录（2026-09-01）

- Distributed Constraint Optimization Problems and Applications: A Survey，JAIR 2018，DOI [10.1613/jair.5565](https://doi.org/10.1613/jair.5565)。
- On the Desirability of Acyclic Database Schemes，JACM 1983，DOI [10.1145/2402.322389](https://doi.org/10.1145/2402.322389)。
- The Multiparty Communication Complexity of Set Disjointness，SIAM J. Comput. 2016，DOI [10.1137/120891587](https://doi.org/10.1137/120891587)。
- Near-optimal lower bounds on the multi-party communication complexity of set disjointness，CCC 2003，DOI [10.1109/CCC.2003.1214414](https://doi.org/10.1109/CCC.2003.1214414)。

总体仍为 **6.0/10，Borderline/Weak Reject**；方向潜力约 8/10。当前 blocker 仍是 T1/T2/T4/T5 无 machine-checked artifact、Complete-Contingent 对照未运行、CompleteMediation/owner universe 仍是条件性边界。

下一轮三个任务：

1. 为 T5 选择一个正式下界，给出输入编码、通信模型、valid-input 域和 CP-RIR-FEAS 归约。
2. 把 `Γ_rel`、`Auth_joint` 和 sink token 写成最小 manifest，列出 omission/equivocation/stale/receipt-loss mutant 的 oracle 预期。
3. 统一 CP-RIR、Complete-Contingent、Fixed-串联的 schema，先完成 differential/metamorphic 设计，再决定 T5 是正文定理还是 mediation assumption。

## 21. 第七轮：INDEX 归约的接口域审计（进行中）

本轮专项审稿发现：若把 `M_hat={m_x}` 明文交给协调器，INDEX 的 `Ω(d)` 下界立即失效；若把所有 `m_x` 放进 robust `M_hat`，则可能因最坏世界而恒不满足。因此 T5 必须明确写成 interface-relative `CP-RIR-FEAS^Γ`：public manifest 固定，owner 私有输入 `x` 只通过 `Γ` 访问，centralized semantics 仅作为隐藏实际世界 `m_x` 的判定 oracle。该版本不能冒充当前明文 `M_hat` exact core 的 solver 输入域。

### 本轮新增的必要前提

- 固定同时/one-way 协议：A 在 `j` 揭示前一次发送与 `j` 无关的摘要，B 之后只输出 `j`，禁止回问 A；
- 所有 x-dependent metadata 的长度、时序、hash、status、拒绝和 commitment 编码计入通信预算，或在 x 上信息论隐藏；
- `policy grammar` 只有唯一目标动作 `a_j`，没有额外 probe、替代 repair 或低成本 safe-abort；
- 所有 `x,j` 通过同一 canonical public preflight，valid `x_j=1` 上 `UNKNOWN/REJECT` 计 completeness error，禁止 all-UNKNOWN 绕过；
- 若使用随机错误，显式区分 `ε_complete` 与 `ε_sound`；若使用 zero-error，valid instance 不得 abstain；
- T5 只声称受限接口下的通信/证书边界，不声称一般 CP-RIR、隐私、coalition safety 或 planner expressiveness separation。

当前 INDEX 草案仍是 `planned/unverified`，尚无正式通信模型、机器证明或 artifact。总体评分暂不调整，仍为 **6.0/10，Borderline/Weak Reject**。下一轮必须先证明 `CP-RIR-FEAS^Γ` 的输入域与现有 canonical exact core 的关系，再决定是否保留 INDEX；若证明负担过重，优先降级为 T1 mediation/interface assumption，而不是保留一个不严谨的下界。

本轮后续复核又将三层语义写死：`FEAS_full(I_pub,θ,π)` 是 sealed actual world 的离线 ground truth，`VerifyΓ(I_pub,TΓ,π)` 只检查证书是否覆盖真值，`SolveΓ(I_pub,Γθ)` 才是协调器输出。Γ 证书不能凭空产生一般 `V/Δ`；INDEX 因而只保留 deterministic `H=1`、关系 bit 直接决定 `Vθ^soft=Δθ^soft=x_j` 的受限族。若要扩展到一般 value/增益，必须增加可组合的 transition/reward `ValueCert`。

本轮还修正了三个状态边界：有效 `RelCompat=false` 是安全拒绝轨迹导致的 `PLAN_REJECT(value/Δ)`，不是 hard violation；Γ 合法但信息不足在 valid-input 域算 completeness error，而不是 `INPUT_INVALID`；stale/equivocation 通常是 `UNKNOWN(CERT_INVALID/TCB_UNTRUSTED)+audit`，除非计划本体已确定不可刷新。`Γ_rel` 查询的总通信应计入 `log d` 索引和常数回复，不能写成无条件 O(1)。

隐私/信息论复核补充：Γ_rel 的 post-`j` 查询、tuple 共签和 plan-specific `ValueCert` 不能同时算作 unary phase；它们应显式标为 `POST_J_REL`，并计入 declassification、setup、proof/opening、安全参数、计算和轮次成本。当前仅承诺 data locality/access control，不承诺 query/coalition privacy、noninterference、unlinkability、traffic-analysis resistance 或 DP。

### 本轮五视角汇总

- **问题定义**：双输入域必须保留；`CP-RIR-FEAS` 是明文完整模型，`CP-RIR-FEAS^Γ` 是 sealed-owner interface problem，不能共享同一 ground-truth 记号。
- **隐私/信息论**：Γ transcript 的 side-channel、commitment、长度、时序和共享 advice 必须计入预算或显式隐藏；本轮不升级隐私定理。
- **因果/统计**：Γ 只提供证书，不创造 `V/Δ`；INDEX 限定为 deterministic `H=1` relation-value 家族，一般 value 需 `ValueCert`。
- **分布式安全**：`Auth_joint`、same-token sink check、fencing、atomic effect/dedup/receipt 和 relation-domain coverage proof 是 soundness 的必要条件。
- **形式化/复杂度**：INDEX 仅在 phase-sealed one-way 下给 `Ω(d)` 候选；允许 j 后回查或公开 `M_hat` 时下界失效。

五个视角与独立顶会均认为：本轮提高了定义正确性与可证伪性，但没有使 T5 成为主创新。

问题定义代理的最终建议已采纳：统一为 `FEAS_full(θ,π)`、`FEAS_robust(M,π)` 和 Γ transcript 诱导的 `Comp_Γ`，不再把 `CP-RIR-FEAS^Γ` 写成第二个 canonical 真值问题。`VerifyΓ` 检查 completion set 上的证书，`SolveΓ` 只是搜索并调用 verifier；T5/INDEX 降为 phase-sealed access-model necessity lemma。

独立顶会补充要求已采纳：T5 必须显式区分 robust completion-set 语义与 trusted singleton actual-world 语义；若 completion set 同时含两种 `x_j`，robust verifier 应拒绝，不能借此声称 INDEX gap。`Γ_rel` 的上界必须计 setup、索引/动作编码、hash/security parameter、proof opening、验证和重复查询成本，不能写成无条件 O(1)。

## 22. 第九轮：certificate-sufficiency 与空 completion 封堵

本轮完成五视角复核和独立顶会终审。新的 P0 blocker 是 `Comp_Γ=∅` 的 vacuous truth：若只验证 `∀θ∈Comp_Γ:FEAS(θ,π)`，矛盾证书可能把 completion 集缩成空集，从而错误 ACCEPT。现已要求 `ValidateComp` 显式检查 completion set 非空、有限可检验表示、actual-world membership（若声明）以及 relation-domain/coverage proof；矛盾、双签、过期或 mutually inconsistent transcript 一律 `UNKNOWN(CERT_INCONSISTENT)`，不能通过删世界获得可行性。

本轮把 soundness 收敛为 `VerifyΓ=true ⇒ FEAS_robust(CompΓ,π)`，把 completeness 分为 fixed-plan 与 synthesis 两层：所有候选必须共享预先冻结的 common transcript `T*` 与 `M*=CompΓ(I_pub,T*)`；candidate-specific relation/value certificate 不能删除未覆盖世界。`INSTANCE_INFEASIBLE` 需要全部候选的完整负证书，silence/timeout/缺正证书只能 `UNRESOLVED/UNKNOWN`。

因果/统计复核进一步要求：一般 `Γ_rel` 不能只凭兼容关系推出 `V/Δ`，必须有逐世界 `ValueCert`/transition-reward factors；T5-INDEX 因此只保留 deterministic `H=1` trusted-singleton 子类，且 `RelCompat=false` 经 `Auth_joint/Exec` 形成无外部 effect 的 `PLAN_REJECT(value/Δ)`。隐私复核要求显式区分 `PRE_J` 与 `POST_J_REL` declassification，当前不提供 query privacy 或 coalition privacy。

总体评分维持 **6.0/10，Borderline/Weak Reject**；语义清晰度小幅提升，但 T1/T2/T4/T5 仍无机器检查 artifact，T5 仍只建议放附录/补充材料。

这条统一语义 supersede 本节前面“保留两个输入域作为两个问题”的简写：输入访问 regime 可以不同，但 ground-truth FEAS 只有一个；固定计划 completeness 与 synthesis completeness 也必须分开报告。

### 五视角汇总（本轮）

1. **痛点/问题定义**：`CP-RIR-FEAS^Γ` 必须明确是私有 owner-state 下的 interface-relative feasibility；不能把明文 `M_hat` exact core 与 sealed-state communication problem 混为一个输入域。
2. **隐私/信息论**：所有 x-dependent metadata、commitment、timing、length、hash 和 status 都必须计入通信预算或满足隐藏假设；否则 INDEX 下界只是被 side channel 绕过的伪命题。该轮不宣称 privacy/noninterference。
3. **因果/统计**：INDEX 只涉及 deterministic hidden authorization relation，不产生个体反事实或 learned-model guarantee；`V^soft/Δ^soft` 和合法 refusal 仍沿用 nominal-soft 总 regime 语义。
4. **分布式安全语义**：必须将 `Auth_joint`、同一 tuple/epoch/version 的 sink token、stale/omission/equivocation 拒绝和 receipt 原子性纳入 CP-RIR-FEAS；仅有 owner 签名不够支撑 soundness。
5. **形式化/复杂度**：只有固定 phase-ordered one-way 协议、唯一动作 grammar、valid-input 且禁止 all-UNKNOWN 时，INDEX 的 `Ω(d)` 才可能成立；若允许 j 后回问 A，或公开完整 `M_hat`，下界立即消失。

五个视角的共同结论是：INDEX 候选可以作为严谨化工具和审稿压力测试，但尚不足以证明第二主创新。独立顶会代理维持 Weak Reject，建议先完成归约和最小 artifact，再决定保留或降级。

本轮形式化代理进一步收紧结论：一般 fixed-round INDEX 不成立，只有 **phase-ordered one-way unary pre-attestation** 成立——A 的全部 unary transcript 必须在 B 的 `j` 揭示前完成，之后禁止含 `j` 的回询，且 `j` 不得经 action/world/hash/nonce/timing 侧信道传回 A。推荐的最小构造为单世界、`H=1`、唯一计划 `π_j={a,b_j}`、隐藏关系 `Rel_x(a,b_j)=x_j`、`η=κ=1`、`c(a)=c(b_j)=1`、`k=2`、`B_f=0`；`x_j=0` 应是确定 `PLAN_REJECT`，不是 `UNKNOWN`。在该接口-relative 域中，确定性零错误至少需 `d` bits，随机错误候选下界为 `(1-h_2(ε))d`；`Γ_rel` 在 `j` 后查询一次 `RelCompat(a,b_j)` 时，查询索引本身需 `log d` bits，故总通信是 `O(log d)+O(1)`，不是无条件 O(1)。该结果仍是标准 INDEX 的领域化必要性 lemma，当前约 **5.0/10**，不能升级 T5 主贡献。

### 独立顶会最终打回

phase-ordered/interface-relative INDEX 路线值得保留为候选下界，但仍只是约 **5.0/10** 的标准 INDEX 嵌入。只有补齐 Γ-relative theorem、`Γ_rel` matching upper bound、联合授权/sink enforcement、证书大小与验证成本，以及 central-full/unary/relational 的端到端实验，才可能提升到约 6.5–7.0；不能据此宣称第二主贡献或通用 planner expressiveness separation。若无法完成闭环，最终应将 T5 降为 T1 mediation/TCB/interface assumption。

## 23. 第十轮：两阶段 completion 冻结与证书非循环（2026-09-01）

### 本轮执行范围

本轮继续遵循目标文件：只审查和深化创新/技术文档，没有修改 uBuddy/Janus 源代码、API、数据库 schema、运行时协议或已有实验实现。新增内容全部标记为 `planned/unverified`。本轮使用了五个独立研究视角的既有输出，并由独立顶会式代理复核；没有把附件中的伪代码或建议当作执行指令。

### 五视角独立复核摘要

1. **痛点/问题定义**：`Comp_Γ` 的候选依赖收缩会把 interface-relative feasibility 误写成 plan-dependent world filtering；必须先冻结 common `Comp0`，再比较所有候选。
2. **隐私/信息论**：若 Γ 回复被视为免费缩小世界集，通信/查询成本和 declassification 会被漏算；新世界信息只能作为显式 probe/branch 并计入预算。
3. **因果/统计**：`ValueCert` 不能用“声明 `V≥η`”来删除坏 completion，再在缩小集合上证明同一声明；`π` 与 `π0` 必须共享 `Comp0Digest`。
4. **分布式安全**：cut、epoch、version、relation scope、sink token 和 receipt 需绑定同一版本；stale/equivocation/omission 是证书或运行时状态，不应一律改写为 plan reject。
5. **形式化/复杂度**：`CheckCompletionSet` 必须先验证 finite/non-empty/consistency/coverage；只有所有候选有完整负证书才可返回 `INSTANCE_INFEASIBLE`，否则 sealed-Γ 的 `UNRESOLVED` 传播为 `UNKNOWN`。

### 采纳与拒绝

- **采纳**：新增 `Comp0/M0Digest` 两阶段冻结；新增独立 `CheckCompletionSet` 伪代码；明确 candidate-specific certificate 无权修改 completion set；补充 `certificateStatus/effectStatus/faultWitness` 封闭枚举；修正 sealed-Γ 下候选级 `UNRESOLVED` 的实例级传播规则。
- **拒绝/降级**：不把 T5/INDEX 升为第二主贡献；不声称 Γ_rel 自动提供一般 `V/Δ`、隐私或 planner expressiveness separation；不把 central-full 的“无候选级 UNKNOWN”表述外推到 sealed-Γ。

### 文档变更

- [技术深化文档](D:/Cli-anything/Janus/docs/ubuddy-v4-technical-deepening.zh-CN.md)：补充两阶段 completion 冻结、非循环性、`CheckCompletionSet`、统一 `Comp0` 量词和状态枚举；修正 omission 与 sealed-Γ completeness 文字。
- [创新演化文档](D:/Cli-anything/Janus/docs/ubuddy-v4-innovation-evolution.zh-CN.md)：记录本轮八候选筛选、C1 主线保留、C16/INDEX 附录降级和新的评分。

### 独立顶会裁决

两阶段冻结显著降低了 vacuous ACCEPT、ghost-world 和 certificate self-justification 风险，但只是正确性封口，不等于新颖性定理。当前建议评分：语义/正确性约 **6.8/10**，整体创新兑现约 **6.1/10**，仍为 **Borderline/Weak Reject**。Strong-Accept 阻塞项仍为：

1. machine-checked `CheckCompletionSet`/factor checker 与独立 oracle；
2. 正式 Γ-relative soundness + fixed-plan/synthesis relative completeness theorem；
3. central-full/unary/relational/same-Γ Complete-Contingent 的公平差分实验；
4. T5/INDEX 的正式归约、matching upper bound、通信/证书成本和可复现实验。

本轮明确没有修改当前技术实现。下一轮最小任务：

1. 将 `Comp0`、证书 digest 绑定和 `Verify_Γ` 流程写成可检查的统一 schema/伪代码；
2. 设计四种 access regime 的同 grammar differential benchmark 与错误状态 confusion matrix；
3. 对 T5 做最终 go/no-go：若无正式证明和 artifact，则从正文删除显式 INDEX 定理，仅保留 mediation/interface assumption。

### 第十轮追加独立复核

隐私/信息论代理指出两个 P0，已采纳并写回技术稿：candidate-specific Γ query 的 timing/length/status/proof-size/early-stop 可形成未建模 filtration，`Comp0` 冻结本身不能阻止；`POST_J_REL` 还可能扩大 policy class，不能将其优势只解释为 certificate sufficiency。技术稿现要求显式定义 `Obs_Γ`，使用 candidate-independent common schedule/padding，或将完整 transcript observation 纳入 policy branch、non-anticipativity、baseline、风险和成本；实验改为 observation-matched 与 adaptive-information 两个子问题，并采用 access × query timing × declassification 因子设计。

同时采纳：普通 `M0Digest` 只 binding、不 hiding；低熵字典攻击和跨实例 linkability 必须计入泄漏。若没有 hiding commitment/可信 verifier 可见性边界，禁止使用 opaque/privacy 暗示。差分实验成本指标已加入 owner proof generation、precomputation、padding、retry、delay、declassification 和泄漏测量。

独立顶会代理仍给出 **Reject/Weak Reject**：两阶段冻结提高正确性而非新颖性；当前主线证明面仍过宽，所有核心对象均为 `planned/unverified`。按投稿成熟度综合约 **4.5–5.0/10**，方向潜力约 7/10；内部研究设计评分可维持 6.0–6.2/10。T5/INDEX 正文 go/no-go 条件不变：没有 theorem、matching upper bound 和最小 artifact 就删除。

分布式安全代理没有发现新的 unsafe-ACCEPT P0，但指出 sink manifest 与 T1 lemma 曾不一致：manifest 只检查 jointAuth/epoch/version/dedup，无法阻止同 epoch/version 的旧 generation、跨合同或过期 token。已将 sink 线性化点校验扩展为完整 token binding：签名、issuer sequence 单调性、expiry、repairId/generation、tuple/contract/DSL/Γ/world digests、non-equivocation、epoch/version 和 dedup key；完成验证后才允许原子提交 effect+dedup+receipt。另统一 stale precedence：默认 `UNKNOWN(STALE_CERT)`，仅有“当前 horizon 无合法 refresh 且无 effect”的完整负 witness 时才 `PLAN_REJECT(stale-known-unrefreshable)`。

## 24. 第十一轮：主线身份与最小 theorem package 收敛（2026-09-01）

### 五视角与独立顶会结论

本轮五个独立视角共同指出：M1 虽然名义上是一个 decision problem，实际仍承载 planning、contract refinement、typed executability、verdict semantics、consistent cut、cross-owner transaction、certificate interface、复杂度和隐私边界等多组可独立成文的证明义务。若把它们全部列为贡献，审稿人会将论文复述为“contingent planner + contract verifier + gateway + certificate”的组合，而非单一不可替代方法。

- **问题定义**：C1 保留，但必须将跨组织性写成条件性威胁模型；最小门槛是两个独立管理域、无全局私有读写主体、sink-side mediation。三 owner 仅用于多方实验，不是定义要求。
- **隐私/信息论**：访问控制不等于隐私；C8/C9/C15 只能作为 non-goal/未来扩展。`M0Digest` 仅 binding，不 hiding；普通 hash、opaque/local-only 不构成 privacy theorem。
- **因果/诊断**：`V/Δ` 只能称 model-relative nominal policy-regime contrast；baseline 必须固定为候选无关的 no-op，禁止因果 effect、个体充分性和 fault-robust utility 的过度表述；加入 baseline monotonicity 与 authorization-collider mutant。
- **分布式安全**：Auth_joint、consistent cut、完整 token fencing、atomic effect/dedup/receipt 是 T1 soundness 的联合 TCB，不分别计创新。sink 旁路写、跨 sink 半提交、旧 generation token 可直接证伪 soundness。
- **形式化/复杂度**：正文最小 theorem package 固定为 D1（finite closed-world FEAS 与 V/Δ 语义）、D2（抽象 checker soundness + concrete refinement/mediation transfer）、D3（central-full、有限 Π、total oracle 下 solver 完备性与 non-vacuity）；D4 受限复杂度放附录，T5/INDEX 不进正文贡献列表。

### 本轮采纳与拒绝

- **采纳**：修正 T1，增加独立 `CheckAbstract(Product(W_m,π,C_monitor,Fault_H))=SAFE` 前提；统一 candidate/instance verdict 类型；将 T5 的观察等价限定为 pre-decision unary transcript；统一 baseline、fault-utility 和 causal wording；补充 owner count 口径。
- **拒绝/降级**：不把 M2 fencing、M3 treewidth、C16/INDEX、隐私扩展包装成并列主贡献；不声称 CP-RIR 击败拥有同一 Γ、grammar、verifier 的 Complete-Contingent planner。

### 收敛方案与评分

推荐方案为“D1+D2 正文，D4 附录，T5 删除或仅作相关工作/接口必要性说明”。该方案独立复核评分约 **8.4/10（设计组织与可发表性）**，高于把 T1/T2/T4/T5 全部打包的约 **4.2/10**；但这是完成方案的潜力评分，不是当前投稿评分。当前投稿成熟度仍约 **4.5–5.0/10，Weak Reject**，方向潜力约 7/10。所有核心能力仍是 `planned/unverified`，不能宣布 Strong Accept。

### 下一轮唯一 gate

不再继续扩写理论列表。下一轮唯一 gate 是：在固定同一 `Comp0`、policy grammar、baseline、verifier 和 token schema 下，构造最小可运行 artifact，比较 `central-full`、`relational-Γ`、`same-Γ Complete-Contingent` 三臂，并机器检查 empty completion、candidate filtering、错误 `ValueCert`、stale/equivocation、baseline monotonicity 和 authorization-collider。若 artifact 不能显示 soundness、completeness 或证书/效率上的明确优势，则从正文删除 T5/INDEX，并采用 `contract/runtime-aware certified repair specialization` 定位。

本轮继续没有修改当前技术实现。

### 编号与身份机械对齐补丁

独立顶会复核发现创新稿的 D1–D3 与技术稿的 T1–T5 编号曾错位，可能使审稿人误解为多个并列贡献。已完成纯文案对齐：

- D1：finite closed-world 语义、`Comp0/M_hat` 非空冻结、`FEAS_full/FEAS_robust`、固定 baseline 与统一 verdict；
- D2（历史 T1）：抽象 checker soundness + safety-reflecting concrete transfer；
- D3（历史 T2）：central-full、有限 `Π`、total exact oracle 下的 solver soundness/relative completeness/non-vacuity；
- 历史 T3：motivating counterexample，改为附录 A1；
- 历史 T4：受限复杂度结果，改为附录 A2；
- 历史 T5/C16：unary/relational access 研究议程，改为附录 A3/第 13–15 节，不进正文贡献列表。

该补丁没有新增理论主张，只是让 contribution list、proof obligations 和 artifact tests 一一对应。

### 本轮文献排雷记录（2026-09-01）

使用 Crossref API 进行相邻家族检索，关键词包括：`contract-aware planning runtime verification repair`、`workflow repair formal verification`、`contingent planning execution monitoring`、`proof carrying plans planning`、`reactive synthesis runtime shields`、`distributed constraint optimization privacy`。检索到的相邻条目仅用于排雷，未把未人工核验的 DOI/会议版本写成论文事实：

- `RVPLAN: Runtime Verification of Assumptions in Automated Planning`（2022，ICAPS workshop/proceedings 条目，版本与 DOI 待人工核验）；
- `Path-Aware Time-Triggered Runtime Verification`（2013，运行时验证家族，具体版本待人工核验）；
- `Compensation-Aware Runtime Monitoring`（2010，运行时补偿家族，具体版本待人工核验）；
- `Proof-Carrying Plans: A Resource Logic for AI Planning`（2020，PPDP 条目，文档已有 DOI 记录）；
- `Specification and Optimal Reactive Synthesis of Run-time Enforcement`（2019/2022 相关条目，版本与 DOI 待人工核验）；
- `Distributed Constraint Optimization Problems and Applications: A Survey`（JAIR 2018，DOI `10.1613/jair.5565`，已核验）。

排雷结论没有改变主线：contingent planning、runtime verification、proof-carrying plans、reactive enforcement 与 DCOP 均已有成熟相邻家族；本稿只能将新增性归因于统一的 finite closed-world FEAS、不可弱化公共契约、nominal/adversarial 双语义及可审计的 D1–D3 条件闭环，不能把已有组件重新命名为新理论。

### 独立顶会最终裁决

终审确认“唯一身份已经可以一句话复述”，但“唯一不可替代贡献已经成立”仍为否。当前综合投稿分约 **4.5–5.0/10，Weak Reject**；设计清晰度约 7/10，方向潜力约 8/10。venue 校准：ICSE 约 5/10，CAV 约 5–5.5/10，OSDI 约 3.5–4.5/10，NeurIPS 约 3–4/10。最佳路线更接近 CAV/ICSE，前提是 D2 的 abstract checker + concrete transfer artifact 真正完成。

必须继续打回：把 D1 定义当新定理、把 D3 有限枚举完备性当算法创新、把 D2 的强前提当已实现系统、把 T5/INDEX 写入主贡献、把 nominal `Δ` 写成因果或 fault-robust utility，以及把 current coordinator 描述成已经具备 WorldAtCut/CMRS/gateway 线性化能力。

## 26. 第十三轮：Gate A v1 冻结审查（2026-09-01）

### 独立视角与文献排雷

本轮使用问题定义、隐私/信息论、因果诊断、分布式安全、形式化复杂度五个独立视角，并由独立顶会审稿代理复核。相邻家族排雷记录为：RVPLAN（`10.5220/0010776500003116`）、Proof-Carrying Plans（`10.1145/3414080.3414094`）、formal contracts in MARL（`10.1007/s10458-024-09682-5`）和 Distributed Private Constraint Optimization（`10.1109/WIIAT.2008.426`）。这些 DOI 仅作检索入口；未人工核验的具体定理、实验和版本不作为本稿事实。

### 采纳的 Gate A 修正

1. Gate A schema 版本固定为 `cp-rir-gate-a/v1`，`accessRegime=central_full`；Γ/sealed 字段必须为 `null/forbidden`。
2. `FEAS_full/FEAS_robust` 只由模型语义决定，`Verify_Γ` 只验证证书充分性；central-full oracle 不依赖 Γ。
3. schema 增加 `inputDomainHash`、`obligationSetHash`、`registeredObligationHash`、`evaluatorSemanticsVersion`、`refinementDirection`，分别检查 specification completeness 与 registered-obligation conservation。
4. exact world oracle 增加逐世界 policy/baseline/delta、worst cost、safety/executability/refinement verdict 和算术 witness；禁止 `min Vπ - min Vπ0`。
5. G01/G04/G06 参数冻结，并补充 G00/G03/G11；G01 空 completion 在候选前结束，G04 使用逐世界差值，G06 显式建模授权 collider。
6. sealed 模式区分 `FEASIBLE_NOT_PROVEN_OPTIMAL` 与 `OPTIMAL_WITHIN_Π`；同成本但 tie-break 更优候选也必须检查。
7. Gate A 硬门槛加入独立 parser/canonicalizer/verdict reducer、固定命令/hash、至少一个非平凡 ACCEPT、零 unsafe false accept 和完整 locked mutant corpus。

### 五视角共同发现的 P0

- 旧文案把 Γ certificate 混进 FEAS，会造成 soundness 循环；已修正。
- 空 completion 不得出现在候选级 `UNRESOLVED`；必须是 `Input=UNKNOWN/Plan=NOT_RUN`。
- 普通 digest/hash/signature 只有 integrity/equality 语义，不提供 hiding 或 privacy。
- 只看 authorized episode 会制造虚假 repair gain；G06 必须保留拒绝轨迹。
- cross-sink half-commit、hidden/bypass effect、old generation、TOCTOU 和 receipt loss 必须分别映射到 HARD_VIOLATION、STALE、ABORTED 或 IN_DOUBT，不能压成规划 UNKNOWN。

### 候选处理

- C1 保留唯一主线；C2 并入 policy object；C3/C4/C5 并入 Gate A checker/verdict；C6/C7 为 D2 TCB；C11 附录；C8/C9/C10/C13/C15 不进入正文主贡献；C14 留作 baseline/future；C16/T5 仅 Gate B 附录诊断。

### 独立顶会裁决与评分

当前仍为 **NO-GO / Weak Reject**：投稿成熟度 **4.5–5.2/10**，方向潜力 **7–7.5/10**。痛点重要性 **8.0–8.5**，普遍性 **5.5–6.5**，跨组织特异性 **4.5–5.0**，新颖度 **5.5**，技术严谨潜力 **7.0**，Gate A 可实现性 **6.5**，Gate B/T5 可实现性 **3.0–3.5**。最适合 CAV/ICSE，不适合当前阶段的 SOSP/NeurIPS。

Gate B/T5/INDEX 和隐私/通信 separation 主张均为摘要级 **NO-GO**。若没有正式 Γ-relative theorem、matching upper bound、完整 leakage accountant、same-Γ artifact 和真实 sink enforcement，只能保留为附录研究议程；Gate B 失败不否定 Gate A，但 Gate A 失败则不能声称 D1–D3 已证明。

### 当前 blocker 与下一轮动作

仍缺 A1/A2/A3 可运行 artifact、D2 machine-checked transfer、D3 独立 exact oracle 差分、真实独立管理域 sink runner 和 `Comp0` 现实覆盖证据。目标继续 active，不调用 complete。

下一轮三项动作：

1. 生成 Gate A v1 machine-readable manifest、locked corpus hash、唯一复现命令和预期输出 hash；
2. 依据技术稿 20.3 手工核验 G01/G04/G06，并审查 null/NOT_EVALUATED 与 tie-break 最优性传播；
3. 做 Gate B 最终摘要 go/no-go，若仍无 theorem/upper bound/artifact，则清除全部摘要、贡献和结论中的 T5/INDEX/隐私强措辞。

本轮只修改三份研究文档，没有修改 uBuddy/Janus 源代码、API、数据库 schema、运行时协议或已有实验实现。所有新增内容仍标记 `planned/unverified`。

## 28. 第十四轮：legacy 映射与可重算 gold payload（2026-09-01）

### 本轮进展

- 将 Gate A、Gate B 和 legacy OCCC 的范围写入技术稿：Gate A 只负责 `central_full` finite correctness；Gate B 处理 sealed/access diagnostic；旧 OCCC T0–T5 暂作 `legacy/superseded-for-CP-RIR`，不直接充当 D1–D3 证据。
- 新增 [Gate A reference payload 示例](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-gate-a-v1.reference-payload.example.json)，显式给出 G00/G04/G06 的有限状态、初始有理分布、授权、可执行性、转移、utility、baseline 和 policy class；仍标记 `illustrative_v0_draft`，不是 solver 或现有实验实现。
- 用只读 Node 计算核验 payload：G00 得到 `Vπ=1, Vπ0=0, Δ=1`；G04 得到逐世界 `(0.8,0.7,0.1)` 与 `(0.9,0.1,0.8)`，聚合 `Vrob=0.8, Δrob=0.1`；G06 得到 `Vπ=Vπ0=0.5, Δ=0`。这些是 payload 的算术自检，不是论文实验结果，也不构成 artifact 已通过。
- 新增 corpus partition：G07/G17 只能在 Gate B diagnostic 使用；G00–G06、G08–G16、G18 属于 Gate A 目标，但其中运行时故障 case 仍需先区分 preflight 缺证与 commit 后 fault 注入。

### 本轮发现的剩余 P0

1. 示例 manifest 仍使用占位 hash、没有真实外部 reference files、策略 grammar 和完整 token/receipt payload；所以 A1 还不能独立从 manifest 驱动完整 D2/D3。
2. `cp-rir-gate-a-v1.schema.json` 是可编译的规范草案，但 `UNKNOWN(reason)`/`PLAN_REJECT(reason)` 当前仍在 gold expected 中以字符串呈现；正式 executable schema 需要将 expected verdict 统一为 `{status,reasonCode,witnessRef}`。
3. Gate A 的 G00/G04/G06 已有 reference payload，但 G03、G11–G16 仍需双版本 gold：`preflight_missing_certificate` 与 `post_commit_fault`，否则同一个 ID 会有两种合法答案。
4. 旧 OCCC code/experiment plan 与 CP-RIR 的编号冲突尚未通过重写或 supersede 文件解决；本轮只记录映射，没有修改用户已有计划。

### 评审裁决

五视角共同结论：schema/ payload 工作提高了可重算性和语义卫生，但没有自动增加新颖性。独立顶会维持 Gate A **NO-GO（尚未运行）**、Gate B/T5/INDEX 摘要级 **NO-GO**。当前成熟度约 **4.5–5.2/10，Weak Reject**；方向潜力约 **7–7.5/10**。如果最终 same-Γ Complete-Contingent 表达相同策略类，论文应诚实定位为 certified specialization/efficiency，而非算法不可替代性。

### 下一轮三项动作

1. 把 expected verdict、reason code、witness completeness 和 preflight/runtime 双语义正式化为 schema 联合类型；
2. 为 G03、G11–G16 增加可执行 reference payload 和至少两个 sink 的 token/receipt 状态；
3. 对旧 OCCC 文档只读生成 theorem→artifact→experiment 映射表，明确哪些内容 superseded，之后再决定是否需要用户授权重写旧计划。

## 27. 第十三轮补丁：manifest v0 草案与规范 schema NO-GO（2026-09-01）

### 发现与修正

独立安全/形式化/顶会复核发现，`ubuddy-cp-rir-gate-a-v1.manifest.example.json` 只能称为 illustrative v0 scaffold，不能称为已锁定 artifact：原版仅有 opaque model hash 和布尔 `mediated/atomic`，无法让 A1 重算 transition、authorization、effect、reward、`V/Δ` 或跨 sink invariant；G00/G06 的单世界描述与默认双世界 manifest 冲突；G03 无法实际构造 ghost-world filtering；G11 的 runtime/public disposition 也未完全纳入输出域。

本轮已采取以下修正，但不把它们误报为验证完成：

- 将示例状态改为 `illustrative_v0_draft`，补充 `$schema/$id/schemaRef`、`NOT_RUN`、`NOT_EVALUATED`、`publicDisposition`、reason-code 与统一 `{status,reasonCode,witnessRef}` 编码约定；
- 增加第二个 sink 和 `crossSinkInvariantHash`，避免 manifest 结构上无法表达 half-commit；
- 为 G00/G06 增加单世界 override，为 G03 改为 central-full 下输入层 `CANDIDATE_WORLD_FILTERING`，为 G11 将安全状态改成 `NOT_EVALUATED`，避免 receipt loss 自动推出 SAFE；
- 新增 [Gate A v1 JSON Schema](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-gate-a-v1.schema.json)。使用 Janus 现有 Ajv 2020-12 运行只读 schema validation：`SCHEMA_COMPILED`、`MANIFEST_VALID true`。这证明的仅是示例满足当前 draft schema，不证明语义、独立 oracle、D2 transfer 或 D3 completeness；
- `manifestHash`、`comp0Digest`、`lockedCorpusHash`、solver/oracle/verifier 版本仍为占位符，唯一命令仍是研究规格文字，因此 Gate A 仍为 NO-GO。

### 跨文档一致性 blocker

旧的 `ubuddy-code-change-plan-v4.zh-CN.md` 与 `ubuddy-experiment-plan-v4.zh-CN.md` 仍使用 OCCC/T0–T5 术语，而 v4 innovation/technical 已使用 CP-RIR/D1–D3。它们本轮未修改，以避免未经授权改动用户已有计划；在真正实现 Gate A 前，必须明确旧计划为 superseded/legacy，或重写成 A1/A2/A3 implementation/experiment plan，并建立唯一 theorem→artifact→experiment 编号映射。当前不能声称四份 v4 文档已形成闭环。

### 第十三轮最终审稿裁决

- Gate A schema：**可继续设计，尚未通过**；当前 manifest/artifact readiness 约 **2.5–4.0/10**；
- Gate A 论文结论：**NO-GO**，当前投稿约 **4.5–5.2/10，Weak Reject**；
- Gate B/T5/INDEX/privacy/communication separation：摘要级 **NO-GO**；
- D1–D3 完成独立 A1/A2/A3、完整 G00–G18、exact `V/baseline/Δ/cost`、D2 transfer、同成本 tie-break、zero unsafe false accept 后，方向潜力约 **7–7.5/10**；
- Gate A schema 的字段数量、hash、receipt 和 metamorphic 清单本身不构成新颖性；最可能的可发表新增性仍是 D2 的非平凡 abstract-to-concrete safety-reflecting transfer 与真实 mediation evidence。

### 下一轮三项动作

1. 将 manifest draft 的模型 hash 替换为可由 A1 独立重算的有限 transition/auth/effect/reward/policy payload，或明确提供外部 reference files 与内容 hash；
2. 完成 G00/G03/G11/G12–G15 的双语义（规划前证书缺失 vs 运行时 fault injection）和 per-candidate coverage/negative-witness 结构；
3. 只读审查旧 OCCC code/experiment plan 的 theorem 编号冲突，提出 supersede/mapping 文案；在此之前不运行或修改现有实验实现。

## 25. 第十二轮：artifact gate 拆分与 P0 定义修复（2026-09-01）

### 本轮独立视角

- **问题定义**：唯一研究问题应先验证 central-full D1–D3 正确性；Γ/T5 是独立 access diagnostic，不能用来补 D1–D3 的新颖性。
- **隐私/信息论**：artifact 必须定义 observer visibility、filtration、timing/length/status/silence、bytes/query/round 和 leakage accountant；普通 hash 仅 binding，不提供 hiding。
- **因果/修复**：exact evaluator 必须逐世界计算 `Δ_m=V_m(π)-V_m(π0)`；baseline monotonicity 与 authorization collider 是 locked P0 mutants。
- **分布式安全**：concrete sink log、token full binding、atomic effect+dedup+receipt、cross-sink all-or-none、receipt-loss `IN_DOUBT` 和 hidden/bypass effect 是 D2 最小 ground truth。
- **形式化/复杂度**：发现旧 `FEAS` 定义把 Γ certificate 写入 ground truth，形成循环；另需区分 sealed 模式的“已证可行但最优性未知”。D1 是良构定义，D3 是 class-relative 有限枚举，不能包装成强算法结果。
- **独立顶会**：明确建议 Gate A/Gate B 拆分。Gate A 完整兑现后可能达到约 6.5–7/10；当前仍为 4.5/10 Weak Reject，且无法称 Strong-Accept-capable。

### 本轮采纳

1. 将 `FEAS_full/FEAS_robust` 与 `Verify_Γ` 完全分层；central-full oracle 直接重算 FEAS。
2. 将 empty/contradictory completion 固定为输入层 `UNKNOWN/Plan NOT_RUN`。
3. 新增 `FEASIBLE_NOT_PROVEN_OPTIMAL` 与 `OPTIMAL_WITHIN_Π` 区分。
4. 把唯一 gate 拆成：Gate A（D1–D3 必过）和 Gate B（Γ/T5 可选附录）。
5. 冻结 A1 reference semantics、A2 transfer checker、A3 solver 三个独立 artifact 角色，禁止共享核心 evaluator/parser/canonicalizer/verdict 逻辑。
6. Gate A 硬条件加入：exact verdict/OPT 一致、unsafe false accept=0、非平凡可行实例、完整 P0 mutant 和 metamorphic gates、固定命令与 manifest hash。

### 本轮拒绝/降级

- 不把 access/filtration 实验作为 D1–D3 是否正确的必要条件；Gate B 失败只删除接口/隐私/通信主张。
- 不把 `same-Γ Complete-Contingent` 等价解释成失败；它支持 certified specialization 定位，但否定算法不可替代性。
- 不声称 privacy-preserving、Blackwell-minimal、query/coalition privacy、DP、noninterference、unlinkability 或通用 `Ω(d)/O(1)` separation。
- 不把 current Janus/uBuddy 写成已经实现 abstract checker、WorldAtCut、sink fencing、atomic receipt 或 CMRS solver。

### 数值与系统反例

- `Vπ=(0.8,0.9)`、`Vπ0=(0.7,0.1)`：正确 `Δrob=min(0.1,0.8)=0.1`；错误 `min Vπ-min Vπ0=0.7`。当 `κ=0.5` 时必须 reject。历史草案中的 `Vπ0'=(0.75,0.2), Δrob'=0.05` 后来被发现改变了 kernel，已废弃；当前 G05 仅保留同 kernel 的 `SELF_BASELINE_SANITY`（`π0′=π, Δ′=0`）。
- authorization collider：隐藏 `H` 同时决定授权与自然成功，authorized-only 日志成功率为 1，但动作无增益；exact core 得 `Δ=0`，learned/opaque 扩展必须 `coverageUnknown(authorization-nonpositivity)`。
- cross-sink half commit、old generation token、hidden effect、TOCTOU、receipt loss 分别必须落入 `HARD_VIOLATION`、`STALE_REJECTED/UNKNOWN` 或 `IN_DOUBT+POSSIBLE_EFFECT_DO_NOT_RETRY`，不能用 planning UNKNOWN 掩盖。

### 独立顶会评分

- 痛点重要性 8.5/10；普遍性 6.5/10；跨组织特异性 5.0/10；
- 创新新颖度 5.5/10；不可替代性 4.0/10；严谨性 6.5/10；
- Gate A 可实现性 6.5/10；Gate B 可实现性 3.5/10；
- 当前投稿成熟度 **4.5/10，Weak Reject**；venue 倾向 CAV/ICSE，而非 SOSP/NeurIPS。

### 当前 blocker 与下一轮

当前仍没有 machine-checked D2、独立 exact oracle、可运行 D3 solver、same-Γ 公平结果、真实独立管理域或 sink-side enforcement 证据。目标继续 active，不调用 complete。

下一轮只做三件事：

1. 冻结 Gate A 的 schema/version/hash、locked instance/mutant corpus、唯一运行命令和硬失败政策；
2. 完成一份无循环 reference semantics 与三个人工金标反例；
3. 对 Gate B 做最终摘要级 go/no-go：没有 theorem、matching upper bound 和 artifact 就删除 T5/INDEX/隐私强措辞。

本轮只修改三份研究文档，没有修改 uBuddy/Janus 源代码、API、数据库 schema、运行时协议或现有实验实现。`dn-experiment-pack` 使本轮把实验问题、变量、控制、指标、失败信号和可复现 artifact 作为同一个 release gate 记录；所有新增能力仍标记 `planned/unverified`。

## 32. 第十五轮：结构化 verdict、答案隔离与运行时三层 gold（2026-09-01）

### 独立视角摘要

- **问题定义**：G03 的 candidate-specific world filtering 是 artifact invalid；不能作为普通实例 UNKNOWN 进入 D3 confusion matrix。`INSTANCE_INFEASIBLE` 与 `OPTIMAL_WITHIN_Π` 必须由完整 candidate vector、enumeration coverage 和 negative witness set 归约得到。
- **隐私/信息论**：本轮不增加隐私主张。普通 hash 仍只有 integrity/binding 语义；expected corpus 与 artifact 输入必须隔离，否则会形成答案回显。
- **因果诊断**：G04/G05/G06 的 `V/Δ` 必须从 finite transition/auth/reward kernel 重算；不能把 worldValues 或 authorized-only success 作为 oracle 输入。
- **分布式安全**：G11–G16 拆为 preflight、冻结模型内 fault、deployed-runtime conformance 三层；receipt loss、half-commit、bypass、TOCTOU、old owner/generation、time bomb 的 runtime 状态不能改写 planning verdict。
- **复杂度**：正文复杂度收窄为受限 weighted-set-cover NP-complete 与显式完整因子图 bounded-treewidth exact-DP 候选；参数 `N,D,K,H,b,w` 已在技术稿定义，未完成证明前保持 `unverified`。

### 本轮采用的文档/artifact 修改

1. `ubuddy-cp-rir-gate-a-v1.schema.json` 增加结构化 status object 草案、reason-code 枚举和 runtime gold 引用字段。
2. `ubuddy-cp-rir-gate-a-v1.manifest.example.json` 将现有 expected verdict 改为 `{status,reasonCode,witnessRef}`，并将 G09/G10 从 Gate A 移到 Gate B diagnostic；仍是 illustrative draft。
3. 新增 `ubuddy-cp-rir-gate-a-v1.runtime-gold.example.json`，给出 G03、G11–G16 的 preflight/modelled-fault/deployed-runtime 变体，以及 token、receipt、cross-sink 和 sink-event 最小字段草案。
4. 技术稿新增第 22 节，明确 A1/A2/A3 不得读取 runner-side expected corpus，并固定三层 mutation 语义；复杂度文字进一步收窄。
5. 创新稿新增第 32 节，明确本轮不新增主创新，原始方向继续融合而非重做。

### 独立顶会审稿结论

本轮主要提升可审计性、可反驳性和安全边界，不构成实质新颖性跃升。当前评分：重要性 8.0、清晰度 7.0、新颖度 5.2、理论潜力 6.8、正确性证据 4.0、artifact readiness 3.5、实验验证 3.0、综合 **5.0–5.3/10（Weak Reject/Borderline）**。CAV 约 5.5，ICSE 约 5.1，SOSP 约 3.5，NeurIPS 约 3.8。

必须打回：把 structured verdict、receipt/fencing、G03/G11–G16 负例当作 privacy、exactly-once、liveness、Byzantine、通信或跨组织不可替代性；把受限 NP-hard/FPT 包装为一般规划突破；把 planned/unverified D2/D3 写成已实现或已验证；在没有 formal theorem、same-Γ 公平 artifact 和独立 sink runner 前继续保留 T5/INDEX 摘要强主张。

### 当前 blocker

1. 已新增 `ubuddy-cp-rir-gate-a-v1.instance-manifest.example.json` 与 `ubuddy-cp-rir-gate-a-v1.locked-expected-corpus.example.json` 两个边界文件，但它们仍是 draft wrapper，尚未填入完整无 expected 的模型 payload，也尚未计算两个真实 hash；原 combined manifest 仍保留作历史接口示例，不能作为独立 A1/A2/A3 输入。
2. schema 尚未强制 `ArtifactVerdict/PlanningVerdict/ExecutionVerdict` 的完整联合不变量，也未约束 candidate vector、分区全集/互斥和 override 白名单。
3. runtime gold 仍只有 draft payload；没有可运行 A1/A2/A3、真实 sink log、D2 transfer checker、实际 hash 或唯一复现命令。
4. 旧 OCCC code/experiment plan 仍未获得授权重写；当前仅有 legacy 映射。

### 下一轮三个动作

1. 拆分 instance 与 expected corpus，并计算内容 hash（仍不修改 Janus runtime）。
2. 完成三层 verdict 的严格 schema 与唯一 reducer 规则，加入全候选覆盖和 witness 完整性检查。
3. 把 runtime gold 从示例字段推进到 A2 checker 输入规范；若无法证明 D2 transfer 的非平凡性，继续删除 T5/INDEX/隐私强措辞。

本轮没有修改 uBuddy/Janus 源代码、API、数据库 schema、运行时协议或已有实验实现；新增能力全部标记为 `planned/unverified`。

## 33. 第十六轮：EchoSolver 反例、answer-free closure 与 reducer invariants（2026-09-01）

### 独立复核

- **问题定义视角**：痛点在单组织分布式工作流同样存在，跨组织特异性仍不足；Gate A 的 `central_full` 结果不能支持 sealed-Γ 或 cross-org privacy 结论。答案隔离改变证据链，不改变 CP-RIR 数学语义。
- **隐私/信息论视角**：combined manifest、provenance 和公开低熵 hash 可能泄漏 expected；hash 只有 equality/binding，不是 hiding。未来 `I(Θ;T)` 必须冻结秘密域、先验、邻接和攻击者视图，否则 `NOT_EVALUATED`。
- **因果视角**：G04/G05/G06 仍必须从 transition/auth/reward kernel 重算；authorized-only success 不能作为 repair effect。EchoSolver 按 case-id 回显金标，与 honest solver 在固定 corpus 上可能不可区分。
- **分布式安全视角**：runtime input 不得携带 base planning verdict；G11–G16 的 runtime fault 只能修改 execution/conformance 轴，不得重写 planning 轴。
- **形式化复杂度视角**：`INSTANCE_INFEASIBLE` 和 `OPTIMAL_WITHIN_Π` 必须由全候选 vector、enumeration coverage 和完整 witness 集归约，不能由单个 candidate status 自报。

### 本轮修改

1. 新增 [answer-free input closure schema](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-gate-a-v1.input-closure.schema.json)，记录递归字段禁用和引用闭包策略。
2. 新增 [verdict reducer invariants](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-verdict-v1.reducer-invariants.json)，明确 Artifact/Planning/Execution 三层和 R01–R10 联合约束。
3. 新增无 expected 的 [instance input payload](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-gate-a-v1.instance-input-payload.example.json)；更新 [runtime input payload](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-gate-a-v1.runtime-input.example.json)，删除直接泄漏的 `ACCEPT/OPTIMAL_WITHIN_PI/planningOutputHash`。
4. 技术稿新增第 23 节，明确 EchoSolver 反例、input closure、candidate vector 和 central-full/sealed 研究对象切换。
5. 创新稿新增第 33 节，明确本轮不增加主创新，继续融合原始方向而非重做。

### 独立顶会裁决

本轮主要关闭答案回显和 verdict 自证风险，仍不构成实质 novelty 提升。当前综合评分维持 **5.0–5.3/10（Weak Reject/Borderline）**；创新度约 5.2，方向潜力约 7–7.5。CAV/ICSE 仍是较匹配方向，Gate B/T5/INDEX 继续摘要级 NO-GO。

必须打回：把 input closure、hash、receipt、fencing、runtime gold 或 reducer invariants 宣称为 privacy、通信、exactly-once、liveness、Byzantine 或跨组织不可替代性；把有限回归一致性当作一般 soundness/completeness；把 central-full artifact 结果外推到 sealed-Γ。

### 当前 blocker

1. input closure 目前是递归 schema/lint 草案，不是进程级 ACL；三个 allowlisted input 草案（finite/runtime/baseline）仍缺完整 contract/effect/simulation payload 和实际 canonical hash，尚不能运行完整 A1/A2/A3。
2. `lockedExpectedCorpus` 仍是 draft wrapper；尚无真实 comparator、盲化 case alias、holdout、实际 hash 和输出封存。
3. reducer invariants 尚无实现和 property-based checker；不能称 D3 已证明。
4. 尚无 D2 machine-checked transfer、真实独立管理域或 sink runner。

### 下一轮三个动作

1. 对 answer-free 输入做引用闭包 lint 和静态 denylist 检查，定义进程/容器级 ACL 证据，不暴露 expected hash 给 A1/A2/A3。
2. 生成仅含 candidate vector/output 结构的 comparator fixture，并检查 `INSTANCE_INFEASIBLE`、`OPTIMAL_WITHIN_Π`、`IN_DOUBT` 联合不变量。
3. 继续 D2 非可组合性审查；若无法证明 safety-reflecting transfer 超出普通 planner+runtime verifier，则保持 certified-specialization 定位。

本轮未修改 uBuddy/Janus 源代码、API、数据库 schema、运行时协议或已有实验实现；新增能力均为 `planned/unverified`。

## 35. 第十六轮 hash/closure 补充记录

新增 [draft hash record](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-gate-a-v1.draft-hash-record.example.json)，记录当前公开草案文件的 raw UTF-8 SHA-256。该记录只用于草案完整性 bookkeeping，不等同于规范要求的 canonical `manifestHash`、comparator-private `lockedCorpusHash` 或可复现 artifact。为避免低熵字典恢复，expected corpus digest 不再放入公开 record。所有 hash 在内容变化后必须重算；当前仍不能据此声称 Gate A、D2 或 D3 通过。

## 34. 第十六轮补丁：移除 hardTraceVerdicts、加入 G05 输入并修正 patch target（2026-09-01）

复杂度、因果和分布式视角的补充复核发现：上一版 answer-free fixture 仍带预计算 `hardTraceVerdicts`，G05 没有 input-only baseline 变体，runtime JSON Patch 目标路径也有未定义字段。已采取以下修正：

- 删除 finite input payload 中所有 `hardTraceVerdicts`，新增专用 `ubuddy-cp-rir-finite-input-v0.schema.json`，将 safety payload 与 soft-value input 明确分离；
- 新增 `ubuddy-cp-rir-gate-a-v1.baseline-variant-input.example.json`，固定模型/授权/执行/evaluator，仅改变 baseline′ 输入；
- 将 runtime patch 改为存在的 `/tokenTemplate/...`、`/universe/crossSinkInvariant/checkerVersion`、`/completionBinding`、`/mediationCoverage` 路径，并记录正式 materialization 算法仍未实现；
- 新增 blinded alias、观察投影和 G06 collider 输入说明，但不把公开 case 结构误报成隐私或防查表保证。

### 本补丁的独立审稿结论

这些修改关闭了若干答案回显和不可执行 mutant 的 P0，但仍不增加实质 novelty。当前创新度维持 **5.2/10**，综合投稿成熟度 **5.0–5.3/10（Weak Reject/Borderline）**。CAV 约 5.6，ICSE 约 5.1；D2 机器检查、真实 sink/ACL、完整 contract/fault/effect payload、G05/G00–G18 独立重算仍缺失。

新增可验证证据：有限 input schema、closure lint、verdict fixture 和 JSON Patch 路径检查均已通过；这些只证明 draft 格式和局部引用正确，不能推出 `INPUT_CLOSED`、`D3_CORRECT`、`D2_SOUND` 或 Strong Accept。

本补丁没有修改 uBuddy/Janus 源代码、API、数据库 schema、运行时协议或已有实验实现；所有能力仍是 `planned/unverified`。

## 35. 第十七轮：严格 verdict schema 负向检查（2026-09-01）

### 本轮完成

1. 收紧 [verdict schema](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-verdict-v1.schema.json)：按轴限定 Artifact/Input/Instance/Optimality/Runtime/Safety/Effect/Disposition 状态；candidate result 增加 canonical AST/hash、policy/baseline/Comp0 binding、逐世界结果、worst cost 和 rejection components；coverage 增加 canonical/visited candidate ID 集。
2. 更新 [output fixture](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-verdict-v1.output.example.json)，加入完整 candidate/coverage/execution 字段。
3. 负向验证四类非法输出均被 Ajv 拒绝；合法 fixture 校验通过。
4. 技术稿新增第 25 节，明确这只是结构 gate，不是 D2/D3 theorem；创新稿新增第 35 节，确认没有新增主创新。

### 五视角与顶会结论

- 问题定义：Gate A 仍是 central-full exact specialization；跨组织特异性不足，除非增加独立管理域和真实 sink mediation。
- 隐私信息论：closure/schema 不是 ACL/privacy；hash 不提供 hiding；Gate B 仍需固定 SecretDomain/Prior/AttackerView。
- 因果诊断：G04/G06 语义保持正确；G05 已有 baseline 输入草案但还未从完整 transition kernel 重算；不能宣称 current-instance cause 或 population efficacy。
- 分布式安全：runtime input 的 patch 路径已存在，但 materialization、sink receipt 和 fence 仍未实现。
- 形式化复杂度：显式 policy list 只能证明 `Θ(|Π|·K·T_eval)` 回归；NP-hard/FPT 需独立 succinct/factor artifact。
- 独立顶会：本轮提高严谨度约 0.3–0.5，但不提升 novelty；综合 **5.0–5.3/10，Weak Reject/Borderline**。CAV 约 5.6，ICSE 约 5.1。

### 当前 blocker

1. schema 仍无法机器验证所有跨对象语义（world 集与 Comp0 对齐、`delta=policy-baseline`、candidate IDs 恰覆盖 Π）；这些仍需独立 reducer。
2. `R01–R10` 仍是 invariant 数据，不是可运行 property checker。
3. A1/A2/A3、D2 transfer、真实 sink/ACL/receipt、G00–G18 完整 corpus 和 canonical hash 尚未完成。

### 下一轮三个任务

1. 实现不读取 expected corpus 的独立 reducer/checker，运行 R01–R10 与 candidate/world coverage 检查。
2. 为 runtime variant 补 `materialize` 规范、base input binding、per-sink receipt/linearization witness 和 concrete/abstract projection。
3. 继续审查 D2 是否超出普通 planner+runtime verifier；若不能证明，维持 central-full certified-specialization 定位。

本轮没有修改 uBuddy/Janus 源代码、API、数据库 schema、运行时协议或已有实验实现；新增能力均为 `planned/unverified`。

## 36. 第十八轮：D2 transfer 结构 gate、G05 因果修正与独立复核（2026-09-01）

### 本轮执行与证据

- 按目标文件继续执行研究迭代；未修改 Janus/uBuddy 源代码、API、数据库 schema、运行时协议或已有实验实现。
- 使用 `dn-experiment-pack` 的实验检查口径：固定 D2 artifact 输入，观察 schema validity、引用闭包、投影闭包和 G05 的 baseline monotonicity；失败信号是 Ajv 拒绝、owner/resource/sink 不一致、trace projection 不一致或 `Δ′>Δ`。
- 收紧并验证 [D2 transfer schema](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-d2-transfer-v0.schema.json) 与 [input fixture](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-d2-transfer-v0.input.example.json)：JSON parse、Ajv 2020-12 编译/验证、禁止答案键检查均通过；轻量 relational lint 检查了组织—资源—sink—owner—epoch/generation、LTS 状态/事件闭包和 T001 concrete→abstract 投影。
- G05 的 canonical alias 恢复为 `B0001`，但 B0001 现在唯一引用 C0002 完整 kernel（标准 JSON Pointer `#/cases/1`），并将 `π0′` 改为同一 kernel 中已登记的 `repair` proposal；手工重算 `Δ=1/10`、`Δ′=0`，故 `Δ′≤Δ`。该变体命名为 `SELF_BASELINE_SANITY`，不等于一般 monotonicity theorem、独立 reducer 或 locked corpus 已完成。

### 独立视角与顶会裁决

- **问题定义**：D2 结构字段改善证据边界，但跨组织仍主要是威胁模型；若无真实 sink-side enforcement，主线不应声称 cross-organization algorithmic indispensability。
- **隐私/信息论**：input closure 仍是 denylist lint；普通 hash 只有 integrity/equality 语义，不提供 hiding、noninterference 或 unlinkability。`View_A(I,E0)≡View_A(I,E1)` 与 SecretDomain/Prior/Adjacency/AttackerView 仍未实现。
- **因果诊断**：G05 现在才满足“固定 kernel、仅换 baseline policy”的前提；G04/G06 仍只能支持 model-relative policy-regime contrast，不能推出 current-instance root cause 或 population efficacy。
- **分布式安全**：owner/resource/sink/fence/receipt/linearization 现在有结构接口，但 ref 仍为占位；runtime input 仍无正式 schema、materialization、per-sink receipt replay 或 R014/R016 可区分的 epoch/generation 事实。
- **形式化复杂度**：schema 能约束字段存在和部分闭包，不能证明 `Safe(ατ)⇒Safe(τ)`、fault-trace membership、effect completeness、`delta=policy-baseline` 或全候选覆盖；D2 theorem scope 还超出 v0 fault/horizon/policy payload。复杂度结论仍限于已声明的受限子类并标 `unverified`。
- **顶会审稿**：结构严谨度略升，但没有非平凡 theorem、机器检查 transfer、独立 reducer、真实 sink runner 或实验结果。综合投稿成熟度维持 **5.0–5.3/10（Weak Reject/Borderline）**，创新度约 **5.2/10**；CAV≈5.6、ICSE≈5.1，SOSP/NeurIPS 不匹配。方向潜力约 7–7.5/10，前提是完成 D2 并证明其不能被普通 planner+runtime verifier 直接替代。

### 采纳、拒绝与当前 blocker

- **采纳**：D2 input-only contract 增加 concrete/abstract model kind、冻结 fault automaton、trace relation、alpha projection、sealed-base binding、owner/resource/sink 与 per-sink receipt/linearization 引用；G05 改为固定 C0002 kernel 的 paired baseline。
- **拒绝升级**：schema、hash、ACL/ref、receipt/fencing、structured verdict、有限枚举、G11–G16 和 denylist lint 不算新颖主贡献。
- **继续淘汰**：T5/INDEX、privacy/noninterference、Blackwell、communication separation、exactly-once/liveness/Byzantine、跨组织不可替代性摘要强主张。
- **P0 blocker**：D2 仍无独立 A2 checker 或正向 complete-mediation case；runtime-input 无正式 schema/materialization/join；per-sink receipt/linearization 不能重放；α safety-reflection 和 fault membership 只是 ref；D2 v0 未承载 scheduler/crash/communication-fault、horizon closure 和 policy-tree 前提；G05 严格输出无 paired binding/arithmetic witness；R01–R10 未实现。

### 下一轮三个任务

1. 建立不读取 expected corpus 的独立 reducer/checker，执行 R01–R10、candidate/world coverage、G04/G05/G06 arithmetic 和 G05 alias/fixed-binding cross-object checks。
2. 为 runtime mutation payload 增加独立 schema 与 materialization/hash 规范；补 per-sink receipt、linearization、owner/resource/sink/epoch/generation 事实以及 R014/R016 可辨识载荷。
3. 对 D2 做 theorem-vs-composition go/no-go：若 machine-checked safety-reflecting transfer 仍等价于普通 planner+runtime verifier 串接，则维持 certified-specialization，不重做 C1，也不恢复 T5/INDEX/隐私强主张。

本轮所有新增能力仍为 `planned/unverified`；目标保持 active，不调用 complete/blocked。

## 37. 第十九轮：D2 从结构字段转向 product-level checker（2026-09-01）

### 文献排雷

本轮检索了 proof-carrying code、distributed runtime verification、assume–guarantee、TLA+/refinement、Saga/compensation 和 reactive shield/synthesis。可核验记录已写入创新文档；结论是 certificate、monitor、fencing、refinement 和 compensation 都是成熟研究家族，不能单独算 CP-RIR 创新。相邻工作只能作为差异对照，待人工核验的来源已明确标记。

### 五视角与独立顶会结论

- **问题定义**：跨组织仍主要是 split-authority 威胁模型；C1 的 finite closed-world CP-RIR 是唯一稳定研究对象。D2 只有在 transfer 语义真的不可由 planner+monitor 直接拼接时才可能升级。
- **隐私/信息论**：hash/ref/denylist 不提供 hiding 或 noninterference；`View_A(I,E0)≡View_A(I,E1)`、SecretDomain/Prior/Adjacency/AttackerView 仍缺实现，privacy 继续降级。
- **因果诊断**：G05 现在是同 kernel 的 self-baseline sanity，算术一致但退化；它不能支持一般 monotonicity theorem。G04/G06 仍只支持 model-relative policy-regime contrast。
- **分布式安全**：D2 schema 仍不能证明独立组织域、ACL、线性化、receipt 原子性或 serializable decomposition 下的 all-or-none；Org-Binding Twin 仍可伪造同构 ref。
- **形式化复杂度**：新增 invariant artifact 明确 product `P_C/P_A`、BadConcrete/BadAbstract、fault-prefix language、alpha projection、effect completeness 和 terminal closure obligations；但尚无实现。DP 复杂度口径已改为共享 non-anticipative decision 下的受限 evaluation，仍是 `unverified`。
- **独立顶会**：结构严谨度约 6.5/10，实质新颖度约 4.8–5.2/10，当前投稿 5.0–5.3/10（Weak Reject/Borderline）；CAV 5.5–5.8、ICSE 5.0–5.3，SOSP/NeurIPS<4。方向潜力 7–7.5，但必须交付 machine-checked D2、正向 transfer case、Org-Binding Twin 负例和可重放 receipt。

### 至少八个候选的最终处理

`C1 finite CP-RIR` 保留主线；`C2 policy DSL` 并入 C1；`C3 effect-complete alpha transfer` 保留为 D2 唯一待证核；`C4 owner/resource/sink binding`、`C5 receipt/fencing/linearization` 并入 D2 TCB；`C6 coverageUnknown` 并入 D1/verdict；`C7 baseline/collider metamorphic tests` 保留为可证伪实验；`C8 Γ-rel/privacy/INDEX` 淘汰出正文。文献排雷确认没有必要重做 C1，但 D2 proof kernel 必须局部重构。

### 本轮落地与 blocker

新增 [D2 checker invariants](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-d2-transfer-checker-v0.invariants.json)，只规定 planned checker 的输入隔离、product semantics、15 项 fail-closed invariants 和最小输出。它没有读取 expected corpus，也没有修改当前实现。当前 P0 仍是：没有正向 complete-mediation fixture；没有独立 A2 semantic checker；D2 v0 仍缺 scheduler/crash/communication fault、horizon closure、policy tree 和显式 bad predicates；G05 仍只有退化 sanity；R01–R10 与 D2-R01–R15 未实现。

### 采纳与拒绝

- **采纳**：把 D2 从“更多 schema 字段”转向 product-level、proof-producing、fail-closed checker 义务；将 `Safe(ατ)⇒Safe(τ)` 拆为可重放的 path/reachability/effect/reflection checks。
- **拒绝**：不把 D2 schema、hash、receipt/fencing、runtime gold、有限枚举或 denylist lint 写成已证明的新颖性；不恢复 T5/INDEX、privacy、communication separation、exactly-once/liveness/Byzantine 主张。

下一轮三个任务：

1. 为 D2 invariant artifact 定义最小 positive/negative fixtures，并实现独立 A2 checker 的只读 prototype（不接入 Janus runtime）。
2. 重做 G05 为严格不同于 candidate 的 baseline-dominance paired mutant，补齐 base/variant/fixed-binding/delta witness schema；self-baseline 仅保留 sanity。
3. 增加 Org-Binding Twin 与 cross-sink crash/recovery 负例，验证同一 checker 能区分 binding 语义而不是 ref 名称。

本轮没有修改 uBuddy/Janus 源代码、API、数据库 schema、运行时协议或已有实验实现；目标保持 active。

## 38. 第二十轮独立审稿汇总：effect 不可 stutter，坏 witness 不等于模型反例（2026-09-01）

### 五个独立研究视角

- **痛点/问题定义**：D2 仍是最可能形成技术贡献的部分，但当前跨组织证据是可替换字段和自报布尔值。Org-Binding Twin 必须让两个 deployment 的公开 trace、动作、成本和外键都自洽，只通过独立 credential-domain attestation 或 sink-side enforcement 判定一真一假。
- **隐私/信息论**：普通 hash、ACL ref 与 `noSinglePrincipal...=true` 不提供 hiding、独立管理域或 noninterference。G05 输入中的结果性 `DeltaPrime=0` 描述会泄漏答案，已删除；expected 算术仍只存在 comparator-private corpus。
- **因果诊断/修复**：G04/G06 继续只解释固定有限模型下的 policy-regime contrast。G05 原 `π0'=π` 是退化 sanity，已由独立 K05 strict dominance pair 替代；这仍不能证明 population efficacy 或 current-instance root cause。
- **分布式安全语义**：真实 `COMMIT_R` effect 不得映射为 stutter。现增加显式 `COMMIT_RESOURCE` 和 partial-commit abstract/monitor state；但 receipt、ACL、attestation 与 cross-sink recovery 仍为 draft ref，不能产生正向 D2。
- **形式化/复杂度**：`P_C=ConcreteLTS×FaultAutomaton×Monitor` 的 monitor 输入层和正常事件 fault self-loop 已明确。复杂度仍限于受限 weighted-set-cover NP-complete 与完整联合图参数化的 bounded-treewidth exact evaluation；共享 non-anticipative decision 不能逐 world 独立优化。

### 独立顶会审稿裁决

采纳：修复 effect/stutter 矛盾；引入 `INPUT_INVALID/WITNESS_INVALID/UNKNOWN_INPUT_NOT_PROVEN/MODEL_COUNTEREXAMPLE` 分层；建立 strict G05 fixed-binding pair；继续将 `coverageUnknown` 置于错误数值 verdict 之前。

拒绝：不把 schema 字段、strict G05、receipt/fencing、hash 或 monitor 状态新增当成论文主创新；不接受现阶段的跨组织不可替代性、隐私、通信 separation、exactly-once/liveness、current-instance cause 或 population efficacy 主张；不把结构验证称为 D2_SOUND。

当前评分维持：创新度 **4.8–5.2/10**，综合成熟度 **5.0–5.3/10（Weak Reject/Borderline）**，CAV **5.5–5.8**、ICSE **5.0–5.3**，SOSP/NeurIPS **<4**。方向潜力 **7–7.5/10** 只在独立 machine-checked D2、正向 transfer、Org-Binding Twin、真实 sink enforcement 和可重放 receipt 完成后成立。

### 本轮 artifact 变更

1. D2 schema/input 增加 horizon、fault prefix semantics 与 monitor input layer；`COMMIT_R` 改映射到显式 abstract effect。
2. D2 invariant artifact 将 malformed input/witness 与 frozen-model counterexample 分开。
3. 新增 strict G05 schema/input；旧 self-baseline fixture 改为 `B0000-LEGACY`，只保留回归兼容，不再承载 G05 主诊断。
4. Gate A manifest 与 comparator-private expected corpus 更新为 `B0001/K05` 的 strict dominance 算术和 digest 输出要求。

本轮没有修改 uBuddy/Janus 源代码、API、数据库 schema、运行时协议或已有实验实现；所有新增能力为 `planned/unverified`。目标继续 active。

### 下一轮三项任务

1. 物化 D2 正向 complete-mediation fixture 与对应 proof-producing output schema。
2. 生成 Org-Binding Twin 和 cross-sink crash/recovery 负例，并验证 verdict taxonomy。
3. 实现只读 strict G05 reducer/support checker，执行 answer-free、fixed-binding、arithmetic 与 digest 回归。

## 39. 第二十一轮五视角与独立顶会审稿（2026-09-01）

### 独立视角

- **问题定义**：当前 D2 的 T001/T002/T003 混合 nominal、deployed-runtime 和 preflight 角色，不能产生唯一的 D2_SOUND。正向、模型反例、runtime conformance 和 preflight unknown 必须分离；P001 现枚举三条完整 ≤H 路径，P002 单独承载 applied effect。
- **隐私/信息论**：answer-free 只表示不含 gold/expected label，不等于 hiding。K05、B0001、policy IDs 和公开 success probability 仍泄漏 benchmark 结构；hash 只有 integrity。Org-Binding Twin 必须依赖独立 credential attestation/sink challenge，不能依赖自报 refs。
- **因果诊断**：G05 严格算术成立，但只能表示固定有限模型中的 baseline-sensitive policy contrast；D2 receipt/linearization 只能支持 effect delivery/safety transfer 边界，不能推出 current-instance cause、population efficacy 或一般 monotonicity。
- **分布式安全**：正例不能包含可达 applied bypass；必须用 ACL/fence 拒绝 attempt 且无版本/receipt 增量。跨 sink 正例优先使用 ESCROW 或 SINGLE_ATOMIC_DOMAIN；serializable decomposition 没有 recovery witness 时必须 UNKNOWN。
- **形式化/复杂度**：P001 只有在 `EXHAUSTIVE_UP_TO_H` 下才可讨论正向 bounded coverage；P002 是 counterexample witness only。G05 reducer 必须保留共享 non-anticipative binding、完整 transition endpoints、support 质量和 exact rational aggregation。

### 独立顶会审稿裁决

审稿人认为当前仍是 Weak Reject/Borderline：CAV **5.3–5.8**、ICSE **5.0–5.5**、NSDI **3.5–4.3**，创新度 **4.8–5.2**。采纳的 P0 修正包括：把 attack attempt 与 applied effect 分开；新增 writer universe/ACL/attestation/sink transcript 字段；引入 strict G05 reducer；明确 malformed witness、unknown 和 model counterexample 的优先级。

拒绝的主张包括：把 positive fixture/Twin/G05 当作已证明跨组织协议、一般 baseline monotonicity、因果效果或 D2_SOUND；把 hash/ref/receipt/fencing/schema 当作独立算法；把 central-full 结果外推到 privacy、sealed-Γ、通信 separation、exactly-once/liveness/Byzantine。

### 本轮新增 artifact 与证据

1. [D2 positive/negative schema](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-d2-positive-negative-v0.schema.json) 与 [input](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-d2-positive-negative-v0.input.example.json)。
2. [Org-Binding Twin schema](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-org-binding-twin-v0.schema.json) 与 [input](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-org-binding-twin-v0.input.example.json)。
3. [G05 reducer invariants](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-g05-reducer-v0.invariants.json) 与 [只读 prototype](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-g05-reducer-v0.mjs)。

JSON parse/Ajv 结构验证、P001 exhaustive path lint、P002 counterexample lint、Twin public-prefix/effect-outcome lint 和 G05 exact arithmetic/support precheck 均通过；这些结果不等于 D2_SOUND、真实 sink enforcement 或 Strong Accept。

本轮没有修改 uBuddy/Janus 源代码、API、数据库 schema、运行时协议或已有实验实现；新增能力均为 `planned/unverified`，目标继续 active。

### 下一轮三个任务

1. 编写最小 proof-producing D2 checker，重放 P001/P002 并输出四类结构化状态；禁止把 `completeMediationClaim` 自报字段当作证据。
2. 为 Twin 增加双输入 canonical public-prefix diff、独立 issuer/sink challenge 验签和 cross-sink recovery 负例。
3. 将 G05 reducer 改为真正双输入 pair，验证实际 changed-pointer 集、完整 candidate grammar binding 和 support 缺失时全字段置 null。

## 40. 第二十一轮安全/形式化补充裁决（2026-09-01）

安全视角将 P001 的 `ESCROW` 判定为未物化语义：缺 crash/recovery、drop/dup/reorder、partition、receipt-loss 和 all-or-none witness，不能支撑 D2_SOUND。并发现 closed writer universe 必须包含 `legacy-writer`、`old-owner` 等 rejected writer；P001 已补 inventory，但这只是结构修复。

形式化视角要求把 `EXHAUSTIVE_UP_TO_H` 变成可检查的 prefix/branch closure，而不只是提交三条 trace；需要明确 `BadConcrete/BadAbstract`、terminal closure、scheduler choices 与 fault product。当前 P001 只能标 `BOUNDED_FIXTURE_PASS/UNKNOWN_INPUT_NOT_PROVEN`，P002 才是 `MODEL_COUNTEREXAMPLE`。

隐私视角确认 answer-free 不是 hiding：公开 K05 概率、purpose、alias、policy ID/hash 仍泄漏 benchmark 结构；Twin 的 credential/ACL 字段仍可自填。因果视角确认 G05 仅为 fixed finite policy-regime contrast，不能证明 safety 或现实因果。独立顶会审稿维持 CAV **5.3–5.8**、ICSE **5.0–5.5**、NSDI **3.5–4.3**，总体 **Weak Reject/Borderline**。

本轮采纳：正负 D2 fixture 分离、closed writer inventory、ESCROW/recovery 作为待实现 obligation、G05 reducer 的 fail-closed precedence。拒绝：把结构 fixture、Twin 或 reducer 输出包装成跨组织协议、隐私 guarantee、一般 baseline monotonicity 或 D2_SOUND。

本轮未修改 uBuddy/Janus 源代码、API、数据库 schema、运行时协议或实验实现；所有新增能力均为 `planned/unverified`，目标继续 active。

## 41. 第二十一轮 prototype 结果与顶会复核（2026-09-01）

### 实证回归

- D2 pair checker：P001 自动枚举 3 条 terminal paths，所有 projection/faultRun 可重放，结果 `BOUNDED_FIXTURE_PASS + UNKNOWN_INPUT_NOT_PROVEN`；P002 结果 `MODEL_COUNTEREXAMPLE`，类别 `ABSTRACT_UNSAFE`。
- Org-Binding Twin checker：public prefix canonical digest 相等，GOOD 拒绝且无 effect，BAD 接受且产生版本/receipt 变化；由于没有独立签名和真实 sink，结果 `RELATIONAL_STRUCTURE_PASS + UNKNOWN_INPUT_NOT_PROVEN`。
- G05 reducer：静态 denylist、canonicalAst hash、Auth/Exec/endpoint/mass support、exact rational replay、弱支配+至少一个严格不等均通过；输出 base `SOFT_ACCEPT`、variant `SOFT_PLAN_REJECT(DELTA)`，`Δrob=1/10`、`Δrob'=1/100`。

### 审稿裁决

独立安全与形式化审稿认为 prototype 关闭了“伪正例/错误 faultRun/退化 G05”的部分风险，但仍不能产生 D2_SOUND。P001 的 ESCROW 没有 recovery state machine；P002 不测试 reflection failure；Twin 的 binding/attestation 仍是自包含字符串；G05 仍非双输入 diff，且只支持 JSON safe integers。当前综合判断仍为 Weak Reject/Borderline：CAV **5.3–5.8**、ICSE **5.0–5.5**、NSDI **3.5–4.3**，创新度 **4.8–5.2**。

本轮采纳：用独立 explorer 计算 exhaustive coverage、显式 fault transition、`ABSTRACT_UNSAFE` 与 `REFLECTION_COUNTEREXAMPLE` 分层、静态 answer isolation 和 soft-axis verdict。拒绝：把 prototype/fixture 当成 machine-checked theorem、跨组织协议、隐私保证、一般 baseline monotonicity 或 Strong Accept。

本轮没有修改 uBuddy/Janus 源代码、API、数据库 schema、运行时协议或实验实现；目标保持 active。

## 42. 第二十二轮五视角与独立顶会复核（2026-09-01）

实跑：reflection schema/input 通过 Ajv；reflection checker 输出 `MODEL_COUNTEREXAMPLE/REFLECTION_COUNTEREXAMPLE`；stutter 负控输出 `INPUT_INVALID/EFFECT_MAPPED_TO_STUTTER`。D2 P001 仍 `BOUNDED_FIXTURE_PASS + UNKNOWN_INPUT_NOT_PROVEN`，P002 为 `ABSTRACT_UNSAFE`；Twin 为 `RELATIONAL_STRUCTURE_PASS + UNKNOWN_INPUT_NOT_PROVEN`；G05 为 `SOFT_ACCEPT → SOFT_PLAN_REJECT(DELTA)` 且 `1/10→1/100`，hard safety=`NOT_EVALUATED`。

五视角一致认为：唯一研究对象仍是 finite closed-world CP-RIR + proof-producing effect-complete bounded transfer；Twin 不能证明 hiding/跨组织真实性；G05 仍是 fixed finite policy-regime contrast；ESCROW 不是 recovery protocol；D2 checker 尚未运行完整 monitor/fault product；复杂度必须基于联合 `G_joint`。

采纳：真正 reflection negative、supplied witness 核验、effect-stutter 非法分类、继续 UNKNOWN。拒绝：把 P002/Twin/G05/hash/schema/completeMediationClaim/ESCROW 当作 theorem、协议、隐私或 Strong Accept 证据。

评分维持：创新 **4.8–5.2/10**，成熟度 **5.0–5.3/10（Weak Reject/Borderline）**；CAV **5.3–5.9**、ICSE **5.0–5.6**、NSDI **3.5–4.3**。P0：完整 product 与 H-frontier、P001 recovery/receipt、Twin blinded 双输入与真实 sink、G05 dual-file diff、D2/G05 端到端 digest binding。本轮只更新研究文档/fixture/checker/hash，未修改 Janus/uBuddy 实现；目标继续 active。

下一轮：完整化 D2 product；物化 P001 recovery/all-or-none；Twin/G05 改为 blinded dual input 并加入篡改负例。

## 43. 第二十三轮五视角与独立顶会复核（2026-09-01）

问题定义审查发现：上一版 reflection fixture 把 concrete `UNMEDIATED_EFFECT` 投影为 abstract `INTERNAL`，违反 effect-preserving R08A，不能直接作为 reflection counterexample。已修正为 owner-binding badness：effect class、identity、sink/resource、multiplicity、versionDelta 均保持，abstract 仍错误地保持 safe；原型输出 `REFLECTION_COUNTEREXAMPLE`。另有两个负控分别输出 `EFFECT_MAPPED_TO_STUTTER` 和 `EFFECT_CLASS_NOT_PRESERVED`。

新增 D2 product checker v1 后，P001 联合重放 concrete/abstract/monitor/fault，`hFrontierCount=0`，但仍 `UNKNOWN_INPUT_NOT_PROVEN`；P002 为 `ABSTRACT_UNSAFE`。这提升了 product-level 反例可见性，却没有 receipt cryptography、recovery、真实 sink 或 D2_SOUND。

五视角裁决：C1 保留；C3 是唯一待证核；C4/C5/Twin/fault/recovery 并入 D2 TCB；G05 更准确命名为 `fixed-kernel baseline-dominance metamorphic relation`，只报告 soft contrast；receipt/effect witness 不等于因果改善。采纳 R08A 前置检查、四维 product、H-frontier 和 hard/soft 轴隔离；拒绝把新 checker、hash、Twin、G05 或 ESCROW 包装成 theorem/privacy/protocol。

隐私视角进一步把 Twin 观察拆成 `S_pre`（proposal/action/cost/public prefix）、`S_exec`（challenge decision、epoch/generation、status、receipt presence、version delta）与 `S_audit`（credential binding、attestation、ACL、sink witness）。当前 artifact 将三层放在同一 JSON，GOOD/BAD 可由 `S_exec` 完全区分，因此只能称 execution disclosure/结构诊断，不能称 hidden-state privacy 或 decision sufficiency；D2 checker 也尚未真正执行 answer-isolation closure，schema 中的 `mustNotContain` 只是自报。

因果视角要求所有汇总保留 `SOFT_` 前缀，并把 G05 的 baseline monotonicity 改称 fixed-kernel metamorphic relation；effect/receipt witness 只证明 effect delivery/knowledge，不证明任务改善或现实因果效果。

当前评分：创新 **4.8–5.2/10**；成熟度 **5.0–5.3/10（Weak Reject/Borderline）**；CAV **5.4–5.9**、ICSE **5.1–5.6**、NSDI **3.6–4.3**。P0 仍为统一 canonical checker、recovery/receipt、真实 sink、Twin/G05 dual-input、D1–D2–G05 端到端 digest binding。未修改 Janus/uBuddy 源码、API、数据库 schema、运行时协议或现有实验实现；目标继续 active。

下一轮：将 effect-preserving reflection、safe positive、abstract-unsafe、stutter-invalid、witness-invalid 统一到同一 canonical D2 input/output；补 recovery/effect-knowledge 状态；推进 Twin/G05 blinded dual-input。

## 44. 第二十四轮五视角与独立顶会复核（2026-09-01）

实跑证据：canonical D2 schema 通过 Ajv；统一 reducer 对六个 opaque case 输出 `UNKNOWN_INPUT_NOT_PROVEN`、`ABSTRACT_UNSAFE`、`REFLECTION_COUNTEREXAMPLE`、`EFFECT_MAPPED_TO_STUTTER`、`EFFECT_CLASS_NOT_PRESERVED`、`SUPPLIED_ABSTRACT_WITNESS_MISMATCH`。recovery/effect-knowledge schema 通过 Ajv。D2 product v1 的 P001 仍 `BOUNDED_PRODUCT_PASS + UNKNOWN_INPUT_NOT_PROVEN`，P002 仍 `ABSTRACT_UNSAFE`；Twin/G05 结论未改变。

五视角一致认为：统一 suite 是 artifact integrity 和 falsification methodology，不是独立算法创新；C1 与 C3 保留，TCB/诊断/隐私边界不变。问题定义视角要求 D2、G05 最终共享同一 candidate/world/contract/fault digest；隐私视角要求 solver 只见 `S_pre` 和 opaque alias，当前 process isolation 尚未实现；因果视角要求 G05 只称 fixed-kernel metamorphic relation，effect witness 不等于收益因果；分布式安全视角要求 `IN_DOUBT` 与 retry/no-effect 互斥并物化 recovery；形式化视角要求 recovery/scheduler 进入联合 product，而不是事后拼接。

采纳：统一 canonical reducer、R08A 前置检查、recovery/effect-knowledge 正交 truth table、hard/soft 轴隔离。拒绝：把统一 schema、opaque alias、hash、Twin、G05 或 recovery 状态表包装成 theorem、privacy 或跨组织协议。

评分：创新 **4.8–5.2/10**；成熟度 **5.1–5.5/10（Weak Reject/Borderline）**；CAV **5.5–6.0**、ICSE **5.2–5.7**、NSDI **3.7–4.5**。P0：完整 `Concrete×Abstract×Monitor×Fault×Recovery×EffectKnowledge`、正向 `D2_SOUND`、独立 sink/receipt、process isolation、Twin/G05 dual-input 和 D1–D2–G05 digest join。未修改 Janus/uBuddy 实现；目标继续 active。

下一轮：把 recovery 状态接入统一 product；实现 blinded observer/process isolation；完成端到端 candidate/world/contract/fault binding。

## 45. 第二十四轮补充安全/形式化/顶会裁决（2026-09-01）

独立审查实跑 canonical reducer 六案，分类稳定为 `UNKNOWN_INPUT_NOT_PROVEN`、`ABSTRACT_UNSAFE`、`REFLECTION_COUNTEREXAMPLE`、`EFFECT_MAPPED_TO_STUTTER`、`EFFECT_CLASS_NOT_PRESERVED`、`SUPPLIED_ABSTRACT_WITNESS_MISMATCH`；recovery checker 输出 `PROTOTYPE_OUTPUT`，并验证 per-sink confirmed/possible half-commit 不能把全局 safety 降为 SAFE。

审查一致指出：canonical suite 仍是 single-witness falsification suite，不是完整 D2 product proof；solver 可见完整 canonical payload，8 字符 alias 不是 blinded observer；recovery 状态尚未进入 D2 reducer；`CRASH_BEFORE_EFFECT`、VALID receipt、ESCROW、scheduler、partition/drop/dup/reorder 和真实 sink 均缺权威证据。G05 `SOFT_*` 金标已修正，但仍是 shared-envelope pair。

采纳：统一 reducer 作为 artifact hygiene、recovery 乘积状态、per-sink effect knowledge、G05 hard/soft 轴隔离。拒绝：把统一 suite、recovery 表、opaque alias、hash、Twin/G05 当作 theorem、privacy、exactly-once 或跨组织协议；拒绝由 single-witness replay 宣称 H-frontier/exhaustive coverage。

候选处理：C1 保留唯一主对象；C3 保留唯一待证 transfer 核；canonical suite、G04/G05/G06、Twin、recovery/receipt/ACL/fault 均为 TCB 或 falsification diagnostics；privacy/T5/INDEX、cross-org indispensability、population efficacy 继续淘汰正文。

评分维持：创新 **4.8–5.2/10**；成熟度 **5.1–5.5/10（Weak Reject/Borderline）**；CAV **5.5–6.0**、ICSE **5.2–5.7**、NSDI **3.7–4.5**。P0：完整联合 recovery product、正向 `D2_SOUND`、独立 sink/receipt、process isolation、Twin/G05 dual-input、D1–D2–G05 digest join。未修改 Janus/uBuddy 实现；目标继续 active。

下一轮：1) 把 recovery/effect knowledge 接入 canonical D2 product；2) 增加 process/namespace isolation 与 128-bit fresh alias contract；3) 建立端到端 candidate/world/contract/fault binding 和 G05 dual-file diff。

## 46. 第二十五轮五视角与独立 CAV/ICSE/NSDI 复核（2026-09-01）

### 实跑证据

- recovery mutation schema/input 经 Ajv 2020 验证通过。
- mutation checker 六案输出依次为 `UNKNOWN_INPUT_NOT_PROVEN`、`IN_DOUBT`、`UNKNOWN_INPUT_NOT_PROVEN`、`HARD_VIOLATION`、`IN_DOUBT`、`MANUAL_INTERVENTION`。
- recovery/effect-knowledge checker 输出 `PROTOTYPE_OUTPUT`，其中 receipt confirmation 明确为 `UNVERIFIED/RECEIPT_CONFIRMATION_REQUIRES_CRYPTO_ATOMICITY`。
- mutation checker 新增 snapshot consistency lint；它只拒绝矛盾输入，不把自报 `VERIFIED` 字段提升为权威证据。
- draft hash record 已加入 recovery mutation schema/input/checker，并重算两个 recovery artifact 家族的 raw UTF-8 SHA-256。该记录只用于草案完整性。

### 五个独立研究视角

- **问题定义**：per-sink recovery 快照让 hard violation、effect uncertainty 与 recovery action 不再混成一个标量，但研究对象仍是 single-snapshot classification。recovery 没有进入 canonical D2 reducer，也没有与 D1/G05 共享 candidate/world/contract/fault/recovery binding。
- **隐私/信息论**：runnerRole/observerContract 仍只是 schema 声明；实际 JSON 含 mutation、events、effect reality/knowledge、receipt/dedup/version 和 evidence。32 位十六进制 alias 不是实际生成的 128-bit fresh blinded alias，也没有 process/namespace isolation、fixed-shape/fixed-latency observer 或 canonicalization/domain separation。
- **因果诊断/修复**：receipt/effect witness 只能证明 delivery 或 knowledge，不能证明 utility improvement、current-instance cause 或 population efficacy。G05 仍只允许称 `fixed-kernel baseline-dominance metamorphic relation`，不是一般 monotonicity theorem。
- **分布式安全**：recovery 仍不是可达状态机；authoritative sink universe、target sink/action precondition、receipt signature/MAC、nonce/issuer sequence、epoch/generation、dedup key、pre/post hash、atomicity，以及 ESCROW reservation/capacity/expiry/reclaim/double-spend/crash ownership 均未验证。half-commit 必须保持 per-sink vector。
- **形式化/复杂度**：canonical suite 仍是 single-witness falsification；D2 缺 all-prefix closure、scheduler/fault acceptance、recovery reachability 和完整 bad predicate evaluator。bounded-treewidth 结果仍只能基于联合 `G_joint`，不能逐 world 优化后聚合。

### 独立顶会审稿裁决

保留 C1 finite closed-world CP-RIR；保留 C3 proof-producing, effect-complete bounded transfer 为唯一待证核。recovery、receipt、ESCROW、ACL/fencing、Twin、G05 和 canonical mutations 全部归入 TCB 或 falsification diagnostics。继续淘汰 privacy/T5/INDEX、Blackwell、通信 separation、cross-org indispensability、exactly-once/liveness/Byzantine、current-instance root cause 与 population efficacy 的正文强主张。

采纳：`VALID_RECEIPT_FOUND` 未独立 replay 时必须 UNKNOWN；negative witness 未独立验证时不能推出 no-effect；hard violation、IN_DOUBT 和 remediation 分离；矛盾 recovery snapshot fail-closed。拒绝：把 single snapshot、状态字符串、opaque alias、hash 或自报 crypto/atomicity 字段包装成 recovery protocol、privacy、D2 proof 或 Strong Accept。

评分维持：创新 **4.8–5.2/10**，成熟度 **5.1–5.5/10（Weak Reject/Borderline）**；CAV **5.5–6.0**、ICSE **5.2–5.7**、NSDI **3.7–4.5**。Strong-Accept P0：完整六维 D2 product、P001 正向 `D2_SOUND`、可达 recovery/all-or-none/ESCROW、独立 sink/receipt replay、Twin/G05 dual-input、D1–D2–G05 digest join、process isolation 与 same-grammar planner/runtime-verifier differential。

本轮未修改 Janus/uBuddy 源码、API、数据库 schema、运行时协议或既有实验实现；所有新增能力均为 `prototype/unverified`。目标继续 active。

下一轮三个任务：

1. 把 recovery transition、per-sink runtime、global safety、public disposition 和 unknown reasons 接入 canonical D2 product。
2. 将 authoritative sink universe、targeted allowed actions、receipt/negative witness replay 与 ESCROW reachability物化为可检查 schema/fixture。
3. 建立 D1–D2–G05 共享 digest、Twin/G05 真 dual-input diff 和 process-isolated observer runner。

## 47. 第二十六轮五视角与独立顶会复核（2026-09-01）

### 实跑与修正

新增 canonical-recovery product v1。初版独立审查发现：recovery steps 未绑定 canonical trace；未验证 receipt 时可直接进入 `EFFECT_CONFIRMED`；顶层 status 混合 model-transfer 与 runtime-recovery。三项均已修正：加入 `canonicalStepIndex/canonicalEvent`、严格 from→to transition、sink universe/version 单调性和 effect-confirmation replay gate；输出拆为 `modelTransferStatus/runtimeStatus/currentSafety/effectKnowledge/recovery/planningSafety`。

Ajv 2020 验证通过，JS syntax check 通过。当前三案输出为：safe witness=`UNKNOWN_INPUT_NOT_PROVEN + runtime UNKNOWN`；abstract unsafe=`MODEL_COUNTEREXAMPLE + HARD_VIOLATION`；reflection failure=`MODEL_COUNTEREXAMPLE + IN_DOUBT`。所有案例仍列出 receipt replay、negative witness replay、sink enforcement 和 ESCROW reachability 未实现。

### 五个独立视角

- **问题定义**：v1 将 recovery 接入了同一输出和有限 transition replay，但仍是 canonical reducer 后接 recovery sequence，而不是联合状态空间探索。不能称完整 product proof。
- **隐私/信息论**：`auditOnly` 仍只是 schema 声明；输入和输出暴露 per-sink reality/knowledge/receipt/version、allowed actions 和 status。固定 alias 与稳定 digest 可跨 artifact 链接，普通 hash 不提供 hiding；process isolation 仍 `NOT_IMPLEMENTED`。
- **因果诊断/修复**：effect/receipt knowledge 不等于 utility improvement、repair success、current-instance cause 或 population efficacy。补偿只能更新 remediation，不能擦除 historical violation；`planningSafety=NOT_EVALUATED` 防止恢复状态被解释为 causal/planning ACCEPT。
- **分布式安全**：仍缺 scheduler、crash/restart、partition/drop/dup/reorder、targeted action/precondition、receipt MAC/signature、dedup atomicity、epoch/generation fencing、ESCROW reservation/capacity/expiry/reclaim/double-spend 与真实 authoritative sink。
- **形式化/复杂度**：当前只检查 supplied sequence，复杂度是多项式 replay；未完成 all-prefix closure、joint bad predicate、scheduler/fault acceptance 或 recovery completeness。shared digests 仅强制 64-hex 格式，尚未从 canonical bytes/domain tag 重算。

### 至少八个候选的收敛

1. C1 finite closed-world CP-RIR：保留唯一主对象。
2. C2 finite policy/intervention DSL：并入 C1 支撑。
3. C3 effect-complete bounded safety-reflecting transfer：保留唯一待证技术核。
4. C4 owner/resource/sink binding：并入 D2 TCB。
5. C5 receipt/fencing/linearization：并入 D2 TCB。
6. C6 coverageUnknown/abstention：并入 verdict semantics。
7. C7 G04/G05/G06 与 canonical/recovery mutations：保留 falsification/metamorphic diagnostics。
8. C8 privacy/INDEX/Blackwell：继续淘汰正文，最多作为 Gate B/future。
9. C9 ESCROW/recovery scheduler：并入 D2 TCB，不立独立贡献。
10. C10 Twin/dual-input binding：作为反例与真实性诊断，不立独立贡献。

### 独立顶会裁决

采纳：canonical event binding、effect confirmation gate、状态轴拆分、version monotonicity、`IN_DOUBT` 禁 retry。拒绝：把 sequence replay、64-hex digest、same-process join、opaque alias 或 `NOT_IMPLEMENTED` evidence 包装成联合 recovery product、privacy、exactly-once、D2_SOUND 或 Strong Accept。

评分：创新 **4.8–5.2/10**，成熟度 **5.2–5.7/10（Weak Reject/Borderline）**；CAV **5.5–6.0**、ICSE **5.2–5.8**、NSDI **3.5–4.3**。条件性 7/10 潜力要求完整 scheduler/recovery product、P001 D2_SOUND、真实 sink/receipt/ESCROW、D1–D2–G05 digest join、dual-input 与 process isolation。

本轮未修改 Janus/uBuddy 源码、API、数据库 schema、运行时协议或既有实验实现；所有新增能力为 `prototype/unverified`。目标继续 active。

下一轮三个任务：

1. 将 recovery step 完整绑定 canonical sink/effect/version/receipt/epoch，并加入 scheduler/fault branch closure。
2. 物化 receipt/negative witness、authoritative sink 和 ESCROW reservation/reclaim/all-or-none replay。
3. 实现 domain-separated D1–D2–G05 digest join、Twin/G05 dual-input 和 process-isolated fixed-shape observer。

## 49. 第二十七轮五视角与独立顶会复核（2026-09-01）

### 实跑证据

新增 v2 branch-closure schema/input/checker。Ajv 通过，JS syntax check 通过；默认 fixture 输出 `inputStatus=VALID`、`status=UNKNOWN_INPUT_NOT_PROVEN`、`reasonCode=SUPPLIED_BRANCH_SET_CHECK_ONLY_EXTERNAL_EVIDENCE_UNVERIFIED`，branch closure mode 为 `SUPPLIED_BRANCH_SET_CHECK_ONLY`，三个 branch 均带 `utilityStatus=NOT_EVALUATED` 与 `causalScope=NOT_EVALUATED`。digest record 已更新并匹配。

### 五视角

- **问题定义**：v2 从单条 canonical witness 扩展为三条手工 branch fixture，但 `allowedBranches` 与 branches 同源，不能证明穷尽 scheduler/fault universe；horizon=1 也不是 recovery transition product。
- **隐私/信息论**：v2 新增 observer contract 仍只是声明；authority、owner/writer、epoch/generation、receipt nonce/id、branch label 和 effect knowledge 全在同一 JSON，固定 alias 与 canonical digest 可跨 artifact 链接。domain-separated hash 只表示完整性命名空间，不提供 hiding。
- **因果诊断/修复**：DROP/CRASH 的 declared reality 不等于 verified reality；receipt delivery/knowledge 不证明 utility、repair success、current-instance root cause 或 population efficacy。`utilityStatus/causalScope=NOT_EVALUATED` 是必要的保守边界。
- **分布式安全**：无 scheduler、crash/restart、partition、drop/dup/reorder、quorum/lease/fencing、receipt atomicity、真实 authoritative sink、ESCROW reservation/expiry/reclaim/double-spend/all-or-none。三分支全是单 sink，不能支持跨 sink safety。
- **形式化/复杂度**：当前只做 supplied branch key equality 与事实一致性，复杂度是多项式 replay；没有外部 grammar、all-prefix closure、joint bad predicate 或 recovery completeness。不能从该 fixture 推出 FPT/NP-hardness 或 D2 soundness。

### 至少八个候选处理

1. C1 finite closed-world CP-RIR：保留唯一主对象。
2. C2 policy/intervention DSL：并入 C1。
3. C3 effect-complete bounded safety-reflecting transfer：保留唯一待证核。
4. C4 owner/resource/sink authority binding：并入 D2 TCB。
5. C5 receipt/fencing/linearization：并入 D2 TCB。
6. C6 coverageUnknown/abstention：并入 verdict semantics。
7. C7 branch/recovery/canonical mutation suite：保留 falsification diagnostics。
8. C8 privacy/INDEX/Blackwell：淘汰正文强主张，最多 future/Gate B。
9. C9 ESCROW/scheduler/recovery：并入 D2 TCB，不单列贡献。
10. C10 Twin/G05 dual-input：保留真实性/元测试诊断，不单列贡献。

### 独立顶会裁决

审稿人采纳：将 closure 命名收窄为 `SUPPLIED_BRANCH_SET_CHECK_ONLY`；区分 declared/verified effect reality；显式标记 causal/utility `NOT_EVALUATED`；继续保留 UNKNOWN。审稿人拒绝：把三条手工 branch、64-hex digest、固定 alias、same-process runner 或 `BOUNDED_FIXTURE_ONLY` 包装成 exhaustive scheduler product、recovery protocol、privacy、exactly-once、all-or-none 或 Strong Accept。

评分：创新 **4.9–5.2/10**，成熟度 **5.2–5.6/10（Weak Reject/Borderline）**；CAV **5.6–6.1**、ICSE **5.3–5.8**、NSDI **3.8–4.6**。Strong-Accept blockers：外部冻结 scheduler grammar 与独立全路径 generator；完整六/七维 product；独立 sink/receipt replay；ESCROW/all-or-none；D1–D2–G05 domain-separated digest join；process-isolated observer；same-grammar planner/runtime differential。

本轮未修改 Janus/uBuddy 源码、API、数据库 schema、运行时协议或既有实验实现；所有新增能力为 `prototype/unverified`。目标继续 active。

下一轮三个任务：

1. 以外部冻结 scheduler/fault grammar 生成 branch set，并加入 omitted-branch negative fixture。
2. 物化 receipt/sink authority replay 与 crash→restart→query/reconcile 的最小状态机。
3. 把 branch/canonical/recovery 的 domain-separated bytes 与 D1–D2–G05 真实 join 绑定，并设计 process-isolated fixed-shape observer。

### 独立审稿代理最终裁决

审稿代理确认当前最准确定位是：**artifact-level supplied-branch falsification/regression checker**。本轮真实改进包括 domain-separated canonical-case digest、declared/verified effect reality 分离、显式 causal/utility non-claim，以及三类 branch 的局部事实绑定；但 `allowedBranches` 与 witness 同源，仍不是 scheduler/fault completeness。

审稿人特别要求保留以下未解决项：外部冻结 grammar 与独立 branch generator；多步 crash→restart→query/reconcile/compensate 状态机；drop/dup/reorder/partition、cross-sink/ESCROW、receipt MAC/signature、dedup atomicity、epoch fencing、真实 sink；D1–D2–G05 端到端 digest join；process-isolated fixed-shape observer。当前不能声称 `D2_SOUND`、recovery protocol、exactly-once、all-or-none、liveness、privacy 或 NSDI-ready system。

最终评分：痛点 **7.5/10**，创新 **5.0/10**，成熟度 **5.4/10**；CAV **5.6/10**、ICSE **5.2/10**、NSDI **3.8/10**，总体 Weak Reject/Borderline。该评分不因 branch fixture 数量增加而自动提升；只有真实联合 product 和独立证据链完成后才可能接近条件性 7/10。

## 50. 第二十八轮五视角与独立顶会复核（2026-09-01）

本轮根据第27轮审稿反馈完成 v2 证据域收紧：增加 observer contract；canonical-case digest 使用统一 domain-separated hash；声明/验证 effect reality 分离；branch 显式标记 utility 与 causality `NOT_EVALUATED`；closure 模式固定为 `SUPPLIED_BRANCH_SET_CHECK_ONLY`。

回归：Ajv、JS syntax、branch checker 和 hash record 均通过；默认 fixture 仍返回 `VALID + UNKNOWN_INPUT_NOT_PROVEN`，三个 branch 的 `verifiedEffectReality` 均为 `UNKNOWN_UNVERIFIED`。这只证明 schema/fixture integrity，不证明 hiding、scheduler completeness、recovery protocol 或 D2_SOUND。

独立五视角结论不变：问题定义上仍是单 effect/horizon-1 supplied set；隐私上同 JSON 暴露 authority/receipt/branch 状态，alias/digest 可链接；因果上 receipt delivery/knowledge 不代表 utility 或根因；分布式上无真实 scheduler、sink、receipt atomicity、fencing、ESCROW；形式化上只有多项式 branch replay，无 all-prefix closure 或复杂度定理。

候选处理：C1 保留唯一主对象，C3 保留唯一待证核；branch closure、receipt/fencing、ESCROW/scheduler、Twin/G05 归 TCB/falsification；privacy/INDEX、exactly-once/liveness/Byzantine、causal efficacy 继续淘汰正文。独立审稿评分：创新 **4.9–5.2/10**，成熟度 **5.2–5.6/10**；CAV **5.6–6.1**、ICSE **5.3–5.8**、NSDI **3.8–4.6**，总体 Weak Reject/Borderline。

本轮未修改 Janus/uBuddy 源码、API、数据库 schema、运行时协议或既有实验实现；目标继续 active。下一轮：外部冻结 scheduler grammar、独立 branch generator、最小多步 recovery FSM、receipt/sink replay 与 D1–D2–G05 真实 digest join。

### 独立审稿代理补充裁决

独立 CAV/ICSE/NSDI 审稿确认本轮四项是真实 artifact-level 修复：入口 Ajv 校验、per-sink universe 不可增删、canonical index 严格递增且不可复用、final snapshot 必须等于最后一步 post。其余结论需要进一步收窄：`EFFECT_CONFIRMED` gate 只阻止特定 `MEDIATED_EFFECT_OBSERVED` 路径在未 replay 时进入 confirmed；输入中其他 per-sink `effectKnowledge=EFFECT_CONFIRMED` 仍可能是自述，不能宣称所有 confirmation label 均有独立证据。

审稿人还验证了缺字段、删 sink、final 篡改和 canonical index 复用等变体会被 fail-closed 拒绝，但指出 checker 仍是 canonical reducer 后接 supplied recovery sequence，未探索联合 scheduler/fault/recovery product。最终评分：痛点 **7.5/10**，创新约 **5.0/10**，成熟度约 **5.4/10**；CAV **5.5/10**、ICSE **5.0/10**、NSDI **3.5/10**，总体 Weak Reject/Borderline。Strong-Accept blockers 不变：完整联合 product、正向 P001 `D2_SOUND`、真实 sink/receipt/ESCROW、端到端 digest join、dual-input/process isolation 和 differential 故障实验。

## 39. 第二十九轮独立复核：external grammar 与 branch generator（2026-09-01）

generator 从独立 grammar 生成 3 个 branch，manifest 重算一致；external closure 正例为 `VALID + UNKNOWN_INPUT_NOT_PROVEN`；negative runner 的 omitted、extra、duplicate-id、semantic-mismatch 全部命中预期错误码。审稿复核确认旧 v2 的 canonical digest、event/effect、authority、version、IN_DOUBT action 和 confirmation gate 已恢复，未出现功能回退。

独立结论：文件分离只带来 artifact-level branch-set integrity，不是 trusted frozen grammar、scheduler reachability、all-prefix recovery、D2_SOUND、privacy 或 provenance。评分：痛点 **7.5**、创新 **5.2**、成熟度 **5.7**；CAV **5.9**、ICSE **5.4**、NSDI **4.0**，总体仍 Weak Reject/Borderline。剩余 P0 是 shared faultDigest 与 grammar 绑定、D1–D2–G05 真实 join、canonical reducer 调用、多步 crash→restart→query/reconcile、grammar/authority/version tamper corpus 和 process isolation。目标继续 active。

## 42. 第三十二轮独立复核：FSM–canonical–branch binding（2026-09-01）

实跑：binding checker 最终输出 `UNKNOWN_INPUT_NOT_PROVEN / SEMANTIC_SUBCHECKS_AND_BINDING_VALID_RUNTIME_EVIDENCE_UNVERIFIED`；它先合取 canonical reducer、external branch closure 和 FSM closure，再执行 digest join。canonical、witness、branch grammar、recovery grammar、path-set 五类篡改均返回粗粒度 `BINDING_INVALID`，不再公开 expected/actual fingerprint。FSM 已改为 `COMPENSATION_PENDING → REMEDIATED/MANUAL_INTERVENTION`，避免把补偿动作当作成功结果。

真实提升是跨工件一致性、三个 semantic subcheck 的合取和语义边界收紧，不是 D1–D2–G05 完整证明。仍缺逐步 sink/effect/receipt authority、签名/MAC/dedup/fencing、真实 crash/restart、ESCROW、process isolation 和 privacy transcript proof。评分维持创新 **5.5**、成熟度 **6.2**；CAV **6.3**、ICSE **5.9**、NSDI **4.3**，总体 Weak Reject/Borderline。不得声称 D2_SOUND、recovery protocol、exactly-once、all-or-none、liveness、privacy 或 Strong Accept。

## 43. 第三十三轮独立复核：recovery evidence ledger（2026-09-01）

binding 现合取 canonical、branch、FSM、recovery-evidence 四个 semantic subcheck。evidence checker 对 receipt、negative witness、compensation 均返回 `REPLAY_NOT_IMPLEMENTED`；三类 false-verified 负例全部命中 `VERIFIED_CLAIM_REQUIRES_ALL_REPLAY_CHECKS`。这证明状态标签不能直接升级为 verified，但不证明任何真实 replay。

候选处理保持：C1/C3 保留；FSM/binding/evidence/receipt/fencing/ESCROW 归 D2 TCB；negative corpus 归 falsification；privacy/Blackwell、exactly-once、liveness、causal efficacy 继续淘汰正文。评分暂维持创新 **5.5**、成熟度 **6.2**；CAV **6.3**、ICSE **5.9**、NSDI **4.3**，总体 Weak Reject/Borderline。下一轮应实现一个真实或独立模拟的 sink/receipt replay，而不是继续增加 VERIFIED 字符串。

## 40. 第三十轮独立复核：recovery FSM prefix closure（2026-09-01）

FSM generator 实跑生成 9 条路径；closure checker 输出 `UNKNOWN_INPUT_NOT_PROVEN` / `ALL_PREFIX_CLOSURE_CHECKED_BUT_RUNTIME_EVIDENCE_UNVERIFIED`；omitted prefix、terminal flag、path digest 三类负例全部通过。该轮首次具备有限 FSM 的 all-prefix artifact 检查，但仍不等于 scheduler/recovery 联合可达性证明。

独立最终评分：创新 **5.4**，成熟度 **6.1**；CAV **6.2**、ICSE **5.8**、NSDI **4.2**，总体 Weak Reject/Borderline。补充 lint 已拒绝 terminal 不属于 states、重复 transitionId、隐式非确定和 unreachable state/transition；但这仍只是 grammar well-formedness。仍不可声称 recovery protocol、D2_SOUND、exactly-once、all-or-none、liveness、privacy 或 Strong Accept。下一轮聚焦 canonical sink/effect/receipt authority 绑定、独立 semantic oracle 和 D1–D2–G05 join。
## 44. 第三十四轮独立复核：evidence ledger 与 branch manifest join（2026-09-01）

### 实跑证据

- evidence checker：默认三条 claim 均 `UNKNOWN_INPUT_NOT_PROVEN / REPLAY_NOT_IMPLEMENTED`。
- evidence negatives：7/7 通过，覆盖 false-verified、输入全 PASS、重复 claim ID、缺失/重复 kind。
- binding checker：canonical、external branch、FSM、recovery evidence 四个子检查均执行，正例为 `UNKNOWN_INPUT_NOT_PROVEN / SEMANTIC_SUBCHECKS_AND_BINDING_VALID_RUNTIME_EVIDENCE_UNVERIFIED`。
- binding negatives：16/16 通过，新增 branch manifest swap、evidence digest、case/effect/sink、schema、claim coverage 负例。
- FSM closure：11 paths、5 terminals，仍为 `ALL_PREFIX_CLOSURE_CHECKED_BUT_RUNTIME_EVIDENCE_UNVERIFIED`。
- `node --check` 与 `git diff --check -- docs` 通过；hash record 已更新。

### 五视角与审稿裁决

问题定义代理认为本轮只强化 supplied artifact 的 referential integrity，不改变 C1/C3 主线。隐私代理指出稳定 digest 仍产生 linkability，错误码与可控 source 路径形成 membership/file oracle，禁止 PASS 不等于 authenticated provenance。因果代理要求继续区分 epistemic delivery、current-instance root cause、repair efficacy 与 population efficacy；补偿状态不能当作反事实成功。分布式代理确认尚无 sink authority、签名 receipt、atomic dedup、epoch fencing、crash/restart、ESCROW 或跨 sink all-or-none。形式化代理确认新增排序与 join 检查是多项式，但没有联合 product、soundness 或 completeness 定理。

独立 CAV/ICSE/NSDI 评分：痛点 **7.8**，创新 **5.8–6.0**，成熟度 **6.4–6.6**；CAV **6.5–6.7**、ICSE **6.0–6.2**、NSDI **4.4–4.6**。总体仍 **Borderline/Weak Reject**。可用表述是：

> answer-free, fail-closed artifact-integrity harness composing canonical D2 reduction, externally generated branch closure, grammar-relative recovery-FSM prefix closure, and an explicitly unimplemented recovery-evidence ledger.

不得写成 recovery protocol、trusted provenance、privacy-preserving ledger、evidence-complete system、`D2_SOUND`、exactly-once/all-or-none/liveness、current root-cause diagnosis、repair efficacy 或 Strong Accept-ready distributed system。

### 文献排雷记录

本轮仅复核相邻研究家族，不据此声称新定理：proof-carrying code、supply-chain attestation/in-toto、workflow repair、causal RCA、model checking/translation validation。检索日期为 2026-09-01；由于公开 API 限流，具体条目与 DOI 标记为“待人工核验”，未写入论文引用。真实新增点仍限定为跨 artifact 的 fail-closed join 与反例回归，而非重新命名成熟组件。

### 未解决 blocker 与下一轮

P0：独立 signed replay、trusted locked root、runtime trace 与 FSM-step binding、D1–D2–G05/runtime/verifier shared digest、process isolation、跨 sink fault injection。下一轮只在研究工件层推进这些验证，不修改 Janus/uBuddy 实现。
## 45. 第三十五轮独立复核：claim→FSM step binding（2026-09-01）

### 实跑证据

- step-binding checker 正例：`UNKNOWN_INPUT_NOT_PROVEN / STEP_BINDING_VALID_RUNTIME_TRANSCRIPT_UNVERIFIED`，3 个 claim 均绑定具体 path/step/transition。
- step-binding negatives：8/8 通过，覆盖 omitted claim、wrong path、wrong transition、wrong event、wrong effect/sink、evidence digest tamper、case alias mismatch。
- 主 binding：五个 semantic subcheck（canonical、branch、FSM、recoveryEvidence、evidenceStepBinding）均实际执行；正例仍为 `UNKNOWN_INPUT_NOT_PROVEN`。
- 主 binding negatives：19/19 通过，新增 step-binding digest、step swap 与 ledger/step split-brain；FSM closure 仍为 11 paths、5 terminals UNKNOWN。
- syntax、hash record、`git diff --check -- docs` 通过。

### 独立五视角

- 问题定义：step binding 只收紧 evidence 与声明 FSM 的关系，不改变 C1/C3 研究对象，也不证明 transition reachability。
- 隐私/信息论：pathId、transitionId、kind 和稳定 digest 仍可 link；source 路径与细粒度错误码仍构成文件/成员查询 oracle；无 hiding/noninterference。
- 因果诊断：三方静态一致不能推出 runtime event、effect reality、repair efficacy、current-instance root cause 或 population efficacy；必须继续 UNKNOWN/abstain。
- 分布式安全：无真实 sink transcript、receipt MAC/signature、linearization/dedup/fencing、crash/restart、跨 sink ESCROW 或 all-or-none。
- 形式化/复杂度：新增检查为多项式索引/排序；没有联合 product、D2_SOUND、relative completeness 或 hardness 结论。

### 顶会裁决

独立 CAV/ICSE/NSDI 审稿接受“step-level artifact integrity”作为工程性增强，拒绝把它包装成 recovery protocol、trusted provenance 或 runtime conformance。保守评分：痛点 **7.8**、创新 **5.8–6.0**、成熟度 **6.5–6.7**；CAV **6.5–6.8**、ICSE **6.0–6.3**、NSDI **4.4–4.7**；总体 **Borderline/Weak Reject**。

不得声称：receipt/negative/compensation 已验证、transition 已执行、D2_SOUND、exactly-once、all-or-none、liveness、privacy、causal root cause、repair efficacy、Strong Accept-ready。下一轮最小要求是 runtime sink transcript 三方绑定、独立 signed replay/trusted root 和 fixed-shape error/declassification。

复审修正记录：step negatives 更新为 8/8；主 binding negatives 更新为 19/19。新增 effect/sink 对齐、主 ledger 与 step ledger 的 source/digest/claim-set 三重 join，以及规范排序 digest。正例仍为 `UNKNOWN_INPUT_NOT_PROVEN`；这些修复不改变 runtime、隐私、因果和分布式安全边界。

## 46. 第三十六轮独立复核：runtime-shaped hypothetical path catalog（2026-09-01）

### 实跑证据

- runtime catalog 正例：`UNKNOWN_INPUT_NOT_PROVEN / HYPOTHETICAL_PATH_CATALOG_REFERENTIAL_JOIN_VALID_RUNTIME_REPLAY_UNVERIFIED`；`pathSemantics=MUTUALLY_EXCLUSIVE_HYPOTHETICAL_PATH_CATALOG`、`realizedPathId=null`、`verifiedEvent=UNKNOWN_UNVERIFIED`。
- runtime negatives：**12/12** 通过，覆盖 claim/path/branch/sink/root/omitted/canonical-index/authority/version/duplicate-record/duplicate-path/realized-without-proof。
- 主 composite binding：canonical、branch、FSM、recovery evidence、evidence-step、runtime catalog 六个子检查均实际执行；runtime digest 纳入 actual 与 binding root；主 negatives **21/21** 通过。
- evidence、step-binding、FSM closure、syntax、hash record、`git diff --check -- docs` 均通过。

### 五视角复核

- **问题定义**：将三条互斥记录明确为 hypothetical catalog，消除了“同一 run 同时 receipt-confirmed/no-effect/remediated”的语义混淆；但没有任何 path 被 realized，仍不是 runtime execution。
- **隐私/信息论**：realized outcome 被隐藏是小幅改进，但完整 topology、authority/version/receipt 字段、稳定 transcript/binding digest 和细粒度错误码仍造成 declassification、linkability 与 membership oracle；无 fixed-shape、process isolation、signed root 或 Blackwell/privacy 证明。
- **因果诊断**：catalog 只支持声明路径与 epistemic join；不支持 effect reality、repair efficacy、current-instance root cause、population efficacy 或反事实 rollback；`branchVersionAfter` 只是 branch snapshot，`hypotheticalPostVersion=null`。
- **分布式安全**：authority 字段已做 supplied-artifact 一致性检查，但没有真实 sink read、签名 receipt/negative witness、linearization、dedup/fencing、crash/restart、cross-sink/ESCROW 或 all-or-none。
- **形式化/复杂度**：新增检查是 `O(R log R + R + P + E)` 的有限多项式 referential validation；无联合 product、reachability、soundness/completeness 或 hardness 定理。

### 独立顶会裁决

采纳：`MUTUALLY_EXCLUSIVE_HYPOTHETICAL_PATH_CATALOG`、`realizedPathId=null`、第六 semantic subcheck、canonical/branch/FSM/authority/version/receipt 交叉 join、duplicate path/record 负例；将主张收窄为 **answer-free, fail-closed, grammar-relative catalog-integrity checker**。

拒绝：称其为 runtime transcript/replay、realized recovery、trusted provenance、sink/receipt/compensation verification、D2_SOUND、exactly-once/all-or-none/liveness、privacy/noninterference、Blackwell sufficiency、causal repair efficacy 或 Strong Accept-ready system。standalone checker 仍依赖 validated sources；source allowlist、uniform error projection 和 signed root 未实现。

评分：痛点 **8.0/10**，创新 **6.1–6.3/10**，成熟度 **6.7–6.9/10**；CAV **6.8–7.0**、ICSE **6.3–6.5**、NSDI **4.7–4.9**；总体 **Borderline/Weak Reject**（CAV artifact/formal track 可接近 Weak Accept 边缘），严禁写 Strong Accept。

### 未解决 blocker 与下一轮

P0：签名/不可伪造 proof 驱动的唯一 realized path；authoritative sink/receipt/negative/compensation replay；pre/post state、linearization、dedup、fencing；真实 crash/restart 与 cross-sink ESCROW；D1–D2–G05 shared root；process-isolated dual-world observer、固定粗粒度错误通道和 source allowlist。下一轮仍只改研究工件与文档，不修改 Janus/uBuddy 当前实现。

## 47. 第三十七轮独立复核待汇总：source validation、path-proof boundary 与 cross-sink ESCROW（2026-09-01）

实跑证据：runtime standalone source schema validation 正例保持 `UNKNOWN_INPUT_NOT_PROVEN`，公开 bucket 为 `UNKNOWN`；invalid 路径统一提供 `CATALOG_INVALID`，但内部 reason 仍保留。realized-path planned schema 的伪造负例 3/3 通过。cross-sink partial-commit/ESCROW catalog 正例保持 UNKNOWN，负例 4/4 通过。上述只证明 source/schema/falsification boundary，不证明签名、realized path、ESCROW、all-or-none、privacy 或 runtime safety。

候选处理不变：C1/C3 保留；authority/receipt/ESCROW/path proof 合并 D2 TCB；abstention 与 negative corpus 作支撑；privacy/Blackwell、causal efficacy、exactly-once/liveness 不进正文强主张。独立复审裁决如下。

### 第三十七轮独立复审裁决

采纳：standalone source-schema validation、audit/public 通道分离、固定键集和等长 public projector、planned proof 对自报签名/VERIFIED 的拒绝、双 sink partial-commit catalog 及负例。拒绝：把 265-byte projector 当作 process isolation 或恒时机制；把 `UNKNOWN________` 当作 Blackwell-minimal/coarse privacy；把 planned proof 当作 authenticated realized path；把 ESCROW catalog 当作 all-or-none 协议。

审稿评分：痛点 **8.1/10**，创新 **6.3–6.5/10**，成熟度 **6.9–7.0/10**；CAV **7.0–7.1**、ICSE **6.5–6.6**、NSDI **4.9–5.0**，总体 **Borderline/Weak Reject**。隐私 **2.0–2.4/10**，privacy novelty≈0。P0 仍为 signed proof payload binding/key lifecycle、independent sink/receipt/compensation replay、ESCROW reservation/expiry/reclaim/double-spend/owner-epoch product、真实 crash/fault replay、D1–D2–G05 root、process-isolated dual-world observer。准确文案：

> The public projector fixes application-level serialization shape only. It does not provide constant-time behavior, process isolation, noninterference, unlinkability, or privacy.

本轮所有新增工件仍标记 `prototype/unverified` 或 `planned/unverified`；没有修改 Janus/uBuddy 当前实现。目标继续 active。

## 48. 第三十八轮独立复核：proof payload binding 与 ESCROW semantic guards（2026-09-01）

实跑证据：realized-path proof checker 正例为 `UNKNOWN_INPUT_NOT_PROVEN / PROOF_PAYLOAD_BOUND_SIGNATURE_UNVERIFIED`，7/7 payload/case/branch/path/step/nonce/transcript/false-verified 负例通过；cross-sink ESCROW 正例为 `UNKNOWN_INPUT_NOT_PROVEN / CROSS_SINK_PARTIAL_COMMIT_CATALOG_VALID_REPLAY_UNVERIFIED`，8/8 epoch/versionDelta/capacity/expiry/reclaim/partial-safe/all-or-none 负例通过。runtime catalog、主 binding、public projector 的既有回归未被改变。

### 独立复核裁决

采纳：proof payload 必须覆盖 case/branch/path/step/nonce/sequence/transcript digest；ESCROW 必须至少拒绝 old epoch、版本增量矛盾、超容量、过期未回收和 partial-commit 假 SAFE；所有未知结果继续 abstain。

拒绝：将 payload digest称作签名、将 `PARTIALLY_COMMITTED_UNVERIFIED`称作协议、将 `HARD_VIOLATION_UNVERIFIED`称作真实 safety verdict、将 fixed-length projector称作 process isolation，或把任何 declared effect/compensation 标签解释为 causal utility/repair efficacy。

评分：痛点 **8.1/10**，创新 **6.3–6.5/10**，成熟度 **7.0–7.1/10**；CAV **7.0–7.2**、ICSE **6.5–6.7**、NSDI **4.9–5.1**，总体 **Borderline/Weak Reject**。隐私仍约 **2.0–2.4/10**。P0：真实签名/issuer key lifecycle、唯一 realized-path selection、cross-sink reservation ledger 与 replay、linearization/fencing/dedup、crash/fault injection、D1–D2–G05 root、process-isolated dual-world observer。

本轮未修改 Janus/uBuddy 当前实现；新增工件为 `planned/unverified` 或 `prototype/unverified`，目标继续 active。

## 49. 第三十九轮独立复核：把规范完整性和 model-set non-vacuity 作为先决条件（2026-09-01）

### 本轮研究动作

本轮采纳问题定义代理的 P0，而不是继续堆叠 runtime/proof/ESCROW 字段：将 `model-relative`、`ContractComplete`、`ObligationConservation`、`non-vacuity` 和 `world-set sensitivity` 写入创新与技术文档。没有新增 Janus/uBuddy 源代码或运行时能力；新增的 docs 研究 checker/manifest/mutation corpus 均标记 `planned/unverified`。

### 五视角审查摘要

- **问题定义**：exact 主语义固定为冻结 `M_hat` 上的 model-relative robust contingent repair；Instance、Model-set、Population 三层结果不得混用。若仍要声称 current-instance repair，必须有 realized membership、独立 sink replay 或一致世界鲁棒性定义，当前没有。
- **形式化**：固定契约不等于完整契约。新增两道 gate：先检查候选无关的独立 `Req*` registry 与合同覆盖，再检查修复是否逐前缀保持 obligation ledger。当前原型只有字段/manifest/declaration 预检，没有独立 registry、authoritative trace replay 或 violation-history 证明，因此两项均输出 `UNVERIFIED_SEMANTIC_GATE`，不是 schema theorem。
- **因果/统计**：`M_hat` 不得由候选结果过滤；baseline 必须候选无关、成本严格为正；world-set 删除困难世界不能使 robust 结论无证据变强。population value、current root cause、effect delivery 和 compensation success 继续分开。
- **分布式/安全**：cross-owner 目前仍是 split-authority 威胁模型和 D2 TCB 条件，不是 privacy、通信分离或算法不可替代性定理；没有 `Γ`-relative necessity/sufficiency 与 matching upper bound 前不升级 T5/C16。
- **隐私**：预注册 manifest、digest 和 opaque alias 仍不是 hiding；稳定 digest/linkability、细粒度错误 oracle、过程/资源侧信道 P0 不变。

### 新增可证伪负例

当前已实现的最小 negative corpus：contract gate 6/6，覆盖 contract incomplete、hard→soft、candidate filtering、空 action、candidate-dependent baseline 和非正成本；model-set differential 6/6，覆盖 grammar/baseline swap、candidate filtering、非法扩张、排列改变结果和扩张反常提升。正例均保持 UNKNOWN；尚未实现独立 `Req*`、逐前缀 dropped/multiplicity/projection/historical-violation/false-completion corpus，不能当作语义通过证据。

### 审稿裁决与评分

本轮提高了问题定义的可证伪性，但没有证明新的算法不可替代性。正文候选仍仅 C1+C3；C16/T5 降为 Gate B 附录，runtime/FSM/evidence/ESCROW 为 D2 TCB/falsification。保守评分：痛点 **7.5–8.1/10**，创新 **6.1–6.5/10**，成熟度 **7.0–7.2/10**；CAV **7.0–7.2**、ICSE **6.5–6.7**、NSDI **4.9–5.1**，总体 **Borderline/Weak Reject**。不得宣称 Strong Accept、ContractComplete theorem、world coverage、cross-organization privacy、current-instance root cause、population efficacy、D2_SOUND、exactly-once 或 all-or-none。

### 下一轮三个任务

1. 增加独立 normative `Req*` registry，并构造 CC/OC 逻辑独立的 separation pair；禁止同源 before/after 自检冒充完整性。
2. 实现逐前缀 obligation ledger，覆盖 dropped、required→soft、projection erasure、multiplicity loss、historical violation erasure 和 false completion。
3. 让 world-set differential 调用独立 finite product solver重算 `Vrob/Δrob/worstCost/verdict`，而不是检查自报 disposition；继续保持 runtime/proof/ESCROW 未验证即 UNKNOWN。

## 50. 第四十轮独立复核：obligation ledger replay 与 CC/OC separation（2026-09-01）

### 实跑证据

- obligation-ledger 正例：两个 required hard obligation 按 `TRIGGER→DISCHARGE` 重放，最终账本分别为 `issued=1,pending=0,satisfied=1,violated=0,cancelled=0`；输出 `UNKNOWN_INPUT_NOT_PROVEN / OBLIGATION_LEDGER_REPLAY_SELF_CONTAINED_RUNTIME_UNVERIFIED`。
- obligation-ledger negative：**6/6** 通过，覆盖 registry/contract mismatch、contract obligation removal、pending-at-accept、historical violation erasure、discharge-without-pending、projection erasure。
- contract gate 与 model-set differential 既有回归未退化：合同负例 **8/8**、model-set 负例 **6/6**；正例仍 UNKNOWN。
- `node --check` 和 `git diff --check -- docs` 通过。第一次相对路径调用产生 `docs/docs/...` 路径错误，改用绝对路径后复跑成功；无工件逻辑失败。

### 五视角与顶会裁决

- **问题定义**：逐前缀账本使“固定合同但候选删除 obligation”与“合同本身不完整”可以在语义上分离；Instance/Model-set/Population 三层仍不能混用。
- **形式化**：checker 重算 supplied event ledger，不信任 `VERIFIED` 标签；但没有独立 `Req*` 签名、authoritative trace、effect replay 或历史违例证明，只能称 sequence-level accounting。
- **因果**：discharge/compensation 只支持声明性的知识状态；不能推导 effect reality、utility、current-instance root cause 或 population efficacy。
- **分布式/安全**：`COMPENSATE` 不擦除 `violated` 是正确边界，但尚无 sink linearization、receipt/MAC、dedup/fencing、crash/restart、cross-sink replay。
- **隐私**：registry、obligation IDs、path/ledger 状态和稳定 digest 仍是 declassification/linkability；没有 process isolation 或 noninterference。

### 评分与未解决 blocker

本轮是可证伪语义增量，但没有新的算法不可替代性。创新 **6.1–6.4/10**、成熟度 **7.1–7.3/10**；CAV **6.4–6.8**、ICSE **5.9–6.3**、NSDI **4.5–4.9**，总体仍 **Borderline/Weak Reject**。P0：独立 registry 签名/锁定 root；CC/OC 机器可检查 separation pair；authoritative trace/effect replay；historical violation monotonicity；独立 finite solver 重算 world-set differential；D1–D2–G05/ledger shared root。不得宣称 obligation-conservation theorem、runtime conformance、D2_SOUND、privacy 或 Strong Accept。

### 下一轮三个任务

1. 将 registry obligations 扩展为独立 trigger/scope/deadline/discharge/multiplicity 记录，并实现 CC=false/OC-vacuous-true 与 CC=true/OC=false separation fixtures。
2. 增加 `VIOLATE→COMPENSATE` 多步路径，验证 `violatedEver` 单调保留和 false completion 拒绝。
3. 对 model-set differential 接入一个不读取自报 disposition 的最小 finite solver；若仍无法接入，显式维持 `RESULTS_SELF_DECLARED`。

## 51. 第四十一轮独立复核：CC/OC 逻辑分离反例（2026-09-01）

### 实跑证据

- separation 正例输出 `SEPARATION_PAIR_CHECKED / LOGICAL_GATE_INDEPENDENCE_ONLY`。
- 案例 A：独立 registry 与 contract obligation set 不匹配（CC false），但 `TRIGGER→DISCHARGE` ledger 自洽。
- 案例 B：registry/contract 匹配（CC true），但 `TRIGGER→VIOLATE→ACCEPT` 被拒绝为 `FALSE_COMPLETION`（OC false）。
- separation negatives **3/3** 通过；`node --check` 与 `git diff --check -- docs` 通过。

### 审稿裁决

五视角一致认为该 fixture 首次把“规范完整性”和“逐前缀义务保持”之间的不可合并性做成可执行 separation，而非只写定义。但它仍是 declaration/sequence artifact：没有独立 registry signature、authoritative trace/effect replay、`violatedEver` 历史账本或 D1–D2–G05 join，不能升级为 theorem、runtime conformance 或安全证明。

本轮保留 C1+C3；separation、ledger、FSM、evidence、receipt、ESCROW 归 contract/D2 TCB 与 falsification。评分不提升：创新 **6.1–6.4/10**，成熟度 **7.1–7.3/10**；CAV **6.4–6.8**、ICSE **5.9–6.3**、NSDI **4.5–4.9**，总体 **Borderline/Weak Reject**。

### 下一轮三个任务

1. 将 registry obligation schema 扩展到 trigger/scope/deadline/discharge/multiplicity，并加入 candidate-independent normative source binding。
2. 将 `VIOLATE→COMPENSATE` 多步序列接入 ledger，维护不可擦除的 `violatedEver`，拒绝 compensation→satisfied 的 false completion。
3. 修正并合并重复的第四十轮日志编号，统一 contract negative 统计为最新实跑的 8/8，并继续保持所有 runtime/proof/ESCROW 未验证状态为 UNKNOWN。

## 50A. 第四十轮独立复核补充：catalog-bound proof 与先决门控（2026-09-01）

实跑：realized-path proof 正例 UNKNOWN，9/9 负例；contract gate 是 declaration-level precheck、semantic replay UNKNOWN，8/8 负例；model-set differential 6/6；最小 cross-sink 反例固定 `ABSTAIN_UNTIL_PROBE_OR_CERTIFICATE`。五视角一致认为这是 artifact integrity/non-vacuity 提升，不是 runtime、因果、隐私或算法定理。保守评分不提升：创新 **6.1–6.4**；CAV **6.3–6.7**、ICSE **5.8–6.2**、NSDI **4.5–4.9**，总体 **Borderline/Weak Reject**。采纳 independent registry、semantic UNKNOWN 与非空洞反例；拒绝 ContractComplete/ObligationConservation theorem、signed proof、ESCROW/all-or-none、privacy 和 Strong Accept 表述。

### 第四十一轮对抗性审稿补充

审稿代理实际构造 required cancel、duplicate witness/multiplicity、post-ACCEPT event、untracked effect、metadata/digest mutation、无历史 violation compensation 与 partial REMEDIATION 等绕过。前四类和 compensation 前置条件已修复，ledger negative **10/10**；metadata/digest、trigger completeness、receipt authority 和 compensation token/linearization 仍未实现。ledger artifact integrity 约 **4.5–5.2/10**，CC/OC semantic evidence仍约 **2–3/10**，论文总体不升分，继续 Borderline/Weak Reject。

## 52. 第四十二轮独立复核：metadata root、witness binding 与 trigger coverage（2026-09-01）

实跑：v1 正例为 `UNKNOWN_INPUT_NOT_PROVEN / METADATA_BOUND_LEDGER_REPLAY_RUNTIME_UNVERIFIED`；negative **10/10**，覆盖 registry required mutation、HARD→SOFT、contract metadata mismatch、required trigger coverage missing、sink binding、nonce replay、duplicate compensation、compensation false completion、trigger mismatch 与 forged root。

采纳：obligation metadata 必须进入 canonical root；witness 必须绑定 instance/effect receipt/sink/issuer/nonce/version；补偿必须有一次性 token 且不擦除 `violatedEver`；required trigger coverage 缺失应 fail-closed。拒绝：把 root hash 当签名，把 supplied coverage 当 authoritative trigger stream，把 replay guard 当 exactly-once 或 sink safety。

评分维持：痛点 **8.1/10**，创新 **6.3–6.5/10**，成熟度 **7.0–7.2/10**；CAV **7.0–7.2**、ICSE **6.5–6.7**、NSDI **4.9–5.1**，总体 **Borderline/Weak Reject**。ledger artifact integrity 约 **5.2–5.8/10**，CC/OC semantic evidence仍约 **3.0/10**。P0 仍是签名/key lifecycle、authoritative trigger/effect stream、authenticated prefix root、真实 sink receipt、crash/restart 与 cross-sink replay。

## 53. 第四十三轮独立复核：canonical root 与 authenticated root 分离（2026-09-01）

实跑：root-auth envelope 正例为 `UNKNOWN_INPUT_NOT_PROVEN / ROOT_AUTHENTICATION_NOT_IMPLEMENTED`；negative **8/8**，覆盖 signed-root/key mismatch、revoked/expired key、rotation self-loop、revocation evidence contradiction、自报 VERIFIED 与 INVALID。审稿裁决认为该轮关闭了“把 hash 名称写成签名”的表述风险，但没有新增算法不可替代性。

采纳：独立 issuer/key lifecycle、signed root、verification status 和 rotation predecessor 必须进入 planned interface。拒绝：把 envelope/schema 当 authenticated provenance、key lifecycle replay 或 D2_SOUND。评分继续为 Borderline/Weak Reject；P0 是真实 trust store、验签、轮换/撤销日志、authoritative stream 与 prefix root 的联合验证。

## 54. 第四十四轮独立复核：C3 effect-complete transfer 的 composition-separation fixture（2026-09-01）

实跑：有限 transfer 正例为 `UNKNOWN_INPUT_NOT_PROVEN / BOUNDED_EFFECT_COMPLETE_TRANSFER_PASS_RUNTIME_UNVERIFIED`；`COMPOSITION_SEPARATION_HIDDEN_EFFECT` 中普通 abstract planner+monitor 检查通过，但 concrete hidden effect 触发 `EFFECT_MAPPED_TO_STUTTER`；negative **8/8** 通过，覆盖 map 非总、effect-to-stutter、footprint mismatch、bad concrete 未反射、terminal/horizon closure、非法 stutter 和 abstract nondeterminism。

独立审稿裁决：本轮首次提供了一个不依赖更多 TCB 字段的“组合通过但 effect-complete transfer 失败”可执行反例，因此 C3 的不可替代性证据优于单纯 schema/replay guards。采纳把 C3 表述为 finite typed LTS 上的 effect-complete bounded transfer candidate；拒绝把它升级为 general safety-reflection theorem、runtime conformance、sink mediation 或 D2_SOUND。

评分谨慎上调但仍非 Strong Accept：创新 **6.5–6.8/10**，成熟度 **7.0–7.3/10**；CAV **7.2–7.5**、ICSE **6.6–6.9**、NSDI **5.0–5.2**，总体 **Borderline / Weak Reject（CAV formal/artifact 方向接近 Weak Accept）**。下一轮 P0：加入多步 effect composition 与 monitor bad-prefix reflection，并尝试给出 bounded soundness 的机器可检查 proof obligations。

### 第四十四轮补充复核

三步跨 sink effect composition `MULTI_EFFECT_ORDERED` 通过 bounded product，隐藏 effect separation 反例仍稳定触发 `EFFECT_MAPPED_TO_STUTTER`。审稿人接受“局部 proof-obligation inventory”作为比字段堆叠更接近 C3 的证据，但强调它仍是 instance-level enumeration，不是一般 bounded soundness theorem。评分不再上调；下一步必须证明这些 obligations 对 product depth 的归纳闭包，或明确把贡献限定为可证伪的 finite specialization。

## 55. 第四十五轮独立复核：certificate reachability coverage（2026-09-01）

实跑：独立 certificate verifier 正例为 `UNKNOWN_INPUT_NOT_PROVEN / CERTIFICATE_REPLAY_FINITE_ONLY`；负例 **6/6**，其中删除 `MULTI_EFFECT_ORDERED` terminal edge 被拒为 `TERMINAL_TUPLE_NOT_REACHABLE`。该修复关闭了“证书边局部合法但整体不可达”的审稿绕过。

裁决：采纳 proof-carrying finite specialization 作为 C3 的证据形态；拒绝把 input digest、BFS reachability 或 certificate replay 当签名、authenticated provenance、runtime conformance 或 general bounded soundness。评分维持 **Borderline / Weak Reject**，CAV formal/artifact 潜力略增但仍没有 Strong-Accept-capable 证据。下一轮应研究 product-depth induction 或给出明确的 finite-only 贡献边界。

## 56. 第四十六轮独立复核：exhaustive branch coverage certificate（2026-09-01）

实跑：v1 exhaustive certificate 正例为 `UNKNOWN_INPUT_NOT_PROVEN / EXHAUSTIVE_CERTIFICATE_REPLAY_FINITE_ONLY`；负例 **5/5** 通过，覆盖漏边、伪边、reachable tuple count、horizon frontier 和 terminal coverage。该轮关闭了 v0 certificate 的主要 cherry-pick 绕过：证书不能只携带一条安全分支而遗漏同层的另一条 concrete 出边。

审稿裁决：这是 C3 从“局部 proof artifact”走向“有限分支完备证书”的实质增强，采纳为 finite model-relative specialization 的证据；拒绝把 depth-BFS 当归纳闭包、把 exact edge equality 当签名或 runtime mediation。创新约 **6.7–7.0/10**，CAV **7.4–7.7**，总体仍 **Borderline / Weak Reject**。Strong-Accept blocker 转为：需要 product-depth induction 或明确论文只声称 finite bounded specialization，并补充真实 D2 mediation evidence。

## 57. 第四十七轮独立复核：循环 relation closure 与 C3 归纳候选

实跑：`CYCLIC_MULTI_EFFECT_SAFE` 输出 `FINITE_INDUCTIVE_RELATION_CHECKED_RUNTIME_UNVERIFIED`；`CYCLIC_HIDDEN_EFFECT` 输出 `EFFECT_MAPPED_TO_STUTTER`；negative **10/10**。retry self-loop 不需要 horizon 展开，说明 relation closure 比单纯 path enumeration 更贴近 transfer 的本体。

审稿裁决：采纳 finite inductive relation candidate 作为 C3 的下一层技术语义；拒绝把 relation membership 当 induction theorem，把 supplied relation 当自动 synthesis，把 checker 输出当 proof-assistant certificate。创新约 **6.9–7.2/10**，CAV **7.5–7.8**，成熟度 **7.2–7.5**；总体仍 **Borderline / Weak Reject**。Strong-Accept 阻塞是 relation 独立生成/最小性、可组合 effect semantics、机器证明内核和真实 mediation evidence。

### 第四十六轮对抗性复核补充

独立审稿最初将 v1 certificate 评分压回 CAV **5.8–6.3/10**，因为可删整 case、horizon 不绑定、初始 relation/bad 未检查、terminal 分支静默遗漏且非确定映射会被吞并。修订后这些 mutation 全部 fail-closed，新的 certificate negative **11/11**；正例包含两个 `PASS` case 和一个 `COUNTEREXAMPLE` case，仍输出 `EXHAUSTIVE_CERTIFICATE_REPLAY_FINITE_ONLY`。

更新裁决：采纳双态 finite certificate 与全 case/全分支覆盖；拒绝称为 general theorem、authenticated proof 或 runtime conformance。评分保守修正为创新 **6.6–6.9/10**、CAV **7.1–7.5**，总体仍 **Borderline / Weak Reject**。

## 59. 第四十八至四十九轮独立复核：inductive relation structural soundness

审稿人构造 delimiter-collision false pass 和 `ghost` initial vacuity。修订后 JSON tuple key 消除碰撞，v1 checker 拒绝 unknown state/reference、非终态死锁、不可达 relation padding 和 terminal/outgoing 缺口；structural negative **8/8**，collision negative 通过。

采纳“verifier 自身必须有 structural anti-vacuity obligations”；拒绝把这些 guard 写成新的算法创新。评分维持创新 **6.9–7.2/10**、CAV **7.5–7.8**、总体 **Borderline / Weak Reject**。Strong-Accept 仍需 relation 独立生成/最小性、可组合 effect semantics、机器证明内核与真实 mediation evidence。
