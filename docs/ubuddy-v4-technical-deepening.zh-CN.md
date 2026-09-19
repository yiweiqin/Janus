# uBuddy v4 技术深化（冻结基线上的研究设计）

> 状态说明：`implemented` 表示当前代码已有证据；`prototype` 表示已有局部实验代码但未形成完整语义；`planned` 表示本目标允许设计、尚未实现；`unverified` 表示缺少证明、机器检查或独立实验。本文不修改源代码、API、数据库 schema、运行时协议或实验实现。

## 1. 当前基线审计

已检查：

- `D:\Cli-anything\Janus\experiments\ubuddy_orgbench\core\evolutionCoordinator.mjs`
- `D:\Cli-anything\Janus\experiments\ubuddy_orgbench\change-manifest.md`
- `D:\Cli-anything\Janus\docs\ubuddy-joint-evolution-implementation-method.zh-CN.md`

当前实现可确认的能力：事件/证据引用抽取、固定置信度、候选 hash/namespace、隐私 finding 和 shadow regression gate、组织/个体候选路由、激活与回滚工程流程。当前实现**尚不能**证明：因果 attribution、intervention support、WorldAtCut、CMRS、Action Gateway 线性化、confidence sequence、组合 coverage 或 typed `coverageUnknown`。因此后文一律标记为 `planned` 或 `unverified`，不得将设计写成系统已支持。

## 2. 形式化映射（planned）

将现有 P/E/lineage 事件映射到有限 typed transition system：

canonical core 统一为 world-indexed `W_m=(S_m,s0_m,A_m,δ_m,O_m,D,C_hard,Inv,U,Ω,Λ,H,Auth_m,Exec_m,Effect_m,K_soft^m)`；后文所有简写都指向该元组，不再另定义删减版本。

- P/DAG：计划依赖和候选动作先后，映射为 `D`；
- E/DAG：实际事件序列，映射为 `δ` 的 concrete trace；
- lineage/hash：证据索引与 artifact identity，不等于因果证明；
- organization/agent owner：`Ω`；权限、版本和能力：`Λ`；
- evaluator/contract：只读 `C_hard`、`Inv` 和 soft evaluator `U`，不允许 repair 修改；
- random seed/external snapshot：使 fork/replay 的转移可重置、可比较。

当前 P/E 图仍是观察和切片底座（`implemented/prototype`），typed transition、随机快照和 consistent cut 为 `planned`。

### 2.1 有限核心与非空性（planned/unverified）

canonical exact 模型使用上述完整 `W`：状态、动作、观察字母和时域有限，概率为有理数或有明确 bit complexity 的紧致因子；`C_hard/Inv` 编码为显式有限 monitor automata（或 bounded Boolean circuits），`U` 为有限 terminal/reward monitor 上的有理函数，cost/threshold 也有显式 bit width。`FreezeWorldSet(h_pub,spec)` 从 benchmark/specification 读取 `M_hat`，检查每个世界与给定 `h_pub/cut` 一致（正似然或显式 cut embedding）、schema、非空性、初始 observation closure、对所有 `Π` 可达未来 history 的 transition/observation totality、快照和版本 hash 后冻结。manifest 记录 `coverageMode∈{closed_world_exact,external_unverified}`；核心定理只在前者或显式条件 `m*∈M_hat` 下成立。world-set misspecification 是正交外部效度风险，不能由 UNKNOWN 自动消除。

计划 `π` 是带 filtration 的 history→probe/repair proposal regime。每个世界显式给出 `δ_m,Auth_m,Exec_m,Effect_m,O_m,K_soft^m`；动态语义是 `Q_t←π(F_t), Z_t←Auth_m(·|F_t,Q_t), A_t←Exec(Q_t,Z_t)`，不是直接 `do(A_t)`。`K_soft^m` 只产生 nominal 外生选择 `e_t`，再由 `δ_m(·|x_t,A_t,e_t)`、`Effect_m/O_m` 生成状态、effect 与观察；它不是第二套 transition model。canonical core 采用 **nominal-soft / adversarial-hard** 双语义：`P_soft^m(·|π)=Product(δ_m,Auth_m,Exec_m,Effect_m,O_m,K_soft^m;π)`，`V_m^soft(π)=E_{τ∼P_soft^m(·|π)}[U(τ)]`，再取 `V_rob^soft=min_m V_m^soft`；硬安全与 worst-case cost 另对 bounded fault automaton 的所有轨迹量化。该 utility 不称 fault-robust；若未来要评估故障下 utility，必须定义 `K_soft^m⊗F_dist^m` 或相应 Markov-game 目标。world index 在 `t=0` 固定并贯穿全部分支，禁止在每个 branch 独立选择最坏世界。它们是 closed-world model-conditional policy-value contrast，不等价于开放系统中单个 episode 的个体因果效应。

时序语义固定为 `F_t=σ(h_pub, owner允许披露的局部消息, Q_{<t},Z_{<t},A_{<t},Y_{≤t})`；policy `π` 输出 `F_t`-measurable proposal `Q_t`，`Auth_m` 产生 authorization/refusal `Z_t`，实际动作由固定函数 `A_t=Exec(Q_t,Z_t)` 决定，拒绝后的状态、成本和观察也属于世界转移。下一观察只在 `Q_t→Z_t→A_t` 之后产生，禁止把当前拒绝结果或未来 outcome 反向放入当前 filtration。baseline `π0` 在其自身 proposals 下使用同一个 conditional `Auth_m`，但不要求与 π 有相同的 realized refusal distribution。拒绝只属于 `Auth_m`，不再由 fault automaton 二次选择。若 learned 扩展中的授权由不可见私有状态决定，则目标量写为嵌套 regime `Y^{π,π_auth}`，或把候选限制为预授权模板；不能仅用 public-history propensity 宣称 exchangeability。

定义同一 cut、horizon、自然重试规则和 conditional `Auth_m` 下的 baseline regime `π0`，并把 `Δ_m^soft(π)=V_m^soft(π)-V_m^soft(π0)`、`Δ_rob^soft(π)=min_m Δ_m^soft(π)` 作为 nominal policy-value contrast；不能用两个 robust marginal 之差代替，也不写 `E[U^π-U^{π0}]`。该均值差不要求 common-random-number coupling；若未来声称 pathwise/individual effect，则必须额外给出结构方程、外生噪声和联合潜在结果模型。`U` 不含优化成本时，cost 只作为独立预算/优化目标；若 `U` 包含风险或延迟，`P_soft^m` 必须显式生成这些量。nature 在 `t=0` 固定一个世界。对 branch history `h_t` 定义 `M_hat(h_t)={m∈M_hat:P_soft^m(h_t|π)>0}`；该集合只用于判断 nominal exact branch 可达性，零概率 branch 规范化删除。learned 扩展中的零估计概率不等于不可能，应进入 no-support/coverageUnknown。

canonical baseline 必须是候选无关且预注册的 status-quo：`π0=no-op`，使用与 `π` 相同的 cut、horizon、`Auth/Exec`、retry/timeout、`K_soft` 和 evaluator；候选不得改变 `π0`。在固定同一 `M`、`Auth/Exec/K_soft/U` 下，若逐世界 `V_m(π0')≥V_m(π0)`，则逐世界 `Δ_m(π;π0')≤Δ_m(π;π0)`，从而 `Δ_rob(π;π0')≤Δ_rob(π;π0)`；该 baseline-monotonicity 是必须加入独立 oracle 的 metamorphic test。若未来要把 `Δ` 解释成因果潜在结果差，除 shared-U SCM 外还需 consistency、SUTVA 和 regime replacement 证明；当前文档只允许使用 model-relative policy-regime contrast。

### 2.2 隐私扩展边界（planned/unverified）

canonical core 不提供 privacy theorem；最多把 data locality 与 access control 作为设计约束。若未来单独保留量化隐私扩展，模型必须扩展为 `(W, X_priv, ~, V_C, K_π, ε_priv,δ_priv,B_priv)`：`X_priv` 是私有状态，`~` 是秘密相邻关系，`V_C` 是最多 `t` 个成员的联盟视图，`K_π` 是完整交互 transcript kernel，包含消息、授权/拒绝、分支、重试、timing/length/silence、证书元数据、public disposition、`IN_DOUBT/CommitUnknown`、receipt-query/reconciliation、cut manifest、owner membership/epoch、resource version、补偿、effect outcome、solver runtime、final status 和跨任务重复查询。需分别定义 decision sufficiency、certificate sufficiency、public declassification 和 privacy minimality；Blackwell 仅在固定动作/损失/先验或 ambiguity set 下讨论，不能声称唯一最小元。

统计 `δ_effect/δ_select/δ_world` 与隐私 `ε_priv,δ_priv` 分开记账。对外 unknown 使用 coarsened 或受预算约束的随机 disposition，内部 obstruction witness 只给 owner/审计者；`POSSIBLE_EFFECT_DO_NOT_RETRY` 是为安全恢复显式允许的 declassification，不计作零泄漏。若没有信息持有者矩阵、完整 transcript、secret adjacency、composition accountant 和攻击者实验，状态保持 `unverified`，正文不得声称 coalition privacy/noninterference。若 trusted benchmark oracle 集中读取完整 `M_hat`，必须称 trusted central model oracle，不得把这种 data locality 写成隐私保证。

### 2.3 Split-knowledge / split-authority 证书接口（附录研究议程，planned/unverified）

为了让 cross-owner 不只是执行标签，部署模式区分两个角色：benchmark oracle 可以读取完整抽象模型用于生成金标；deployed coordinator 不读取 owner raw state，也不能直接授权全部 effect。每个 owner `i` 持有局部抽象 `L_i`、动作集 `A_i` 和 sink capability，只通过签名接口 `Γ_i` 返回：

```text
WorldCommit_i(w, localAbstractStateHash)
LocalStep_i(w, proposal, observation, localEffectSummary)
Capability_i(action, epoch, version, opaqueFootprintCommitment)
RelCompat_i(instanceCtx, actionCommitments[], peerWorldCommitments[])
```

全局 `M_hat` 由 opaque world id、owner commitment 与显式 compatibility relation 组成；协调器可组合关系但不读取 raw payload。为使 T5 反例成立，owner-local `readSet/writeSet/idempotencyKey/resourceId` 对协调器只以不可比较 commitment 出现，只有本地 checker 或 `RelCompat` 可以判定跨 owner correlation；公开 cost、timing、message length、hash 也必须在 `S_good/S_bad` 中相同。若资源 ID/footprint 可全局比较，使协调器能从 unary capability 自行求交，则该实例不属于 `A_unary`，不能用作 T5 下界。

以下历史 T5 仅保留为附录研究议程，不属于 D1–D3 正文 theorem package，也不进入当前 contribution list。

下方保留的粗体 `T5` 仅是历史编号，为便于追踪旧审稿记录；其规范地位等同于附录 A3，不能被引用为正文目标或已成立结果。

**附录 A3（历史 T5）：unary owner-interface insufficiency（研究议程，planned/unverified）**。定义受限架构类 `A_unary`：协调器只能接收 action-local unary summary，不能查询 joint footprint/world compatibility。观察等价仅针对 pre-decision transcript；执行后的 sink/effect outcome 不在该等价关系内。构造同 public cut、contract、action grammar 且无替代可行计划的两个系统：在 `S_good` 中联合动作 `(a,b)` 恰好满足公共义务，在 `S_bad` 中相同联合动作因隐藏的共享 idempotency/resource correlation 违反 `C_hard`。任何 `A_unary` 对两系统输出分布相同：在 perfect soundness/zero-error completeness 版本中，接受坏实例或拒绝好实例分别构成错误；随机版本必须显式声明 `ε_sound/ε_complete`。加入 `RelCompat(w,{a,b})` 后两系统可区分。该命题只证明特定接口的信息不足，不属于 D1–D3；只有另行完成必要+充分 certificate theorem、relation arity/bits/query/round 下界、matching upper bound 和 artifact 后，才可在后续工作重新评估。

## 3. Repair DSL 与证据结构（planned）

每个 primitive 必须声明：

```text
kind ∈ {reassign, rewire, bind-version, patch, guard, compensate}
owner, readSet, writeSet, pre, post, permission, version, idempotencyKey
effectClass ∈ {reversible, idempotent, compensatable, irreversible-uncompensatable}
cost, risk, requiredCertificates
```

canonical exact core 使用已知 authorization/transition kernel，不要求 statistical positivity。核心中的 support obligation 只表示动作是否存在于 typed DSL、是否被 owner kernel 授权以及 Gateway 是否可执行；proposal/execution/outcome positivity 和 joint support 只属于 learned-model 扩展。

证据 token 至少包含 `sourceId, lineageId, epoch, snapshotId, seed, observedAt, expiry, signature, completenessHint`。签名/哈希只保证来源和一致性，不保证事实真实性或没有 omission。

## 4. Current consistent cut 与 contingent plan（planned）

当前失败点不是单一 scalar watermark，而是 vector-clock/causal-frontier 的 downward-closed consistent cut `k`。修复只作用 `suffix(k)`；历史 effect 不可抹除。

计划对象为：

```text
π = probe(q) → observation z → branch(z) → typed repair R
```

无探针时退化为静态 `R`。每条分支都必须重新验证 `C_hard/Inv` 和 semantic executability。未授权动作或组合 footprint 冲突是确定的 `PLAN_REJECT`；证明所有计划均失败才返回 `INSTANCE_INFEASIBLE`；模型输入、capability schema/TCB/快照不完整时返回 input-validity `UNKNOWN`；solver 资源耗尽单独返回 `TIMEOUT`。

### 4.1 Canonical CP-RIR-EVAL/SYNTH 算法（planned/unverified）

输入：冻结 `M_hat`、有限 policy-tree 类 `Π`、typed action DSL、owner certificate interface `Γ`、固定且可枚举的 `C_hard/Inv` monitor、`U` reward monitor、阈值 `(η,κ)`、预算 `k`、正成本函数 `C`、有限 fault/retry budget `B_f` 和当前 consistent cut。repair 模式要求 `κ>0`；`κ≤0` 只能称 utility-feasibility，不能宣称修复增益。`FEAS_full(m,π)` 与 `FEAS_robust(M_hat,π)` 是独立于访问接口和证书可得性的 ground-truth plan predicates，只包含模型语义上的 hard safety、typed/joint executability、不可弱化 refinement、nominal `V/Δ` 与 worst-case cost；`Verify_Γ(I_pub,T,π)` 才检查 Γ transcript/certificate 是否足以证明或反驳该谓词。central-full `Eval` 直接从明文有限模型重算 `FEAS`，不得调用 Γ 证书作为真值。`CP-RIR-OPT(I)=argmin_{π:FEAS_robust(M_hat,π)}C(π)`，无可行计划时为 `∞`。本稿固定 `C(π)=sup_{m,f,ρ∈Reach(π,m,f;B_f)}Σ_{e∈ρ}c(e)`，其中 f 包含 scheduler/communication/crash fault 而不重复包含 `Auth_m` 的合法拒绝；未实现的策略分支不收费，probe cost 按实际执行一次计。若允许的无限 retry 使上确界为 `∞`，该计划确定性 `PLAN_REJECT(cost-infinite)`。预算 `k`、oracle 和 tie-break 都使用同一语义，tie-break 为 `(C,branch-depth,probe-risk,canonical-id)`。

1. `ValidateWorldSet`：若 `M_hat` 为空、世界与 `h_pub/cut` 不一致、可达-history closure/编码/快照、contract/action/cost/evaluator monitor 或任一 `Π` 依赖的 capability schema 无效，返回 instance-level `UNKNOWN(model-input-invalid)`；
2. `EnumeratePolicy`：枚举所有非预知、分支深度≤B 的 `π`，不按 support 删除世界；
3. `ComposeTrace`：对每个 `(π,m)` 展开 owner authorization kernel 的所有≤H轨迹；
4. `CheckCandidate`：逐轨迹检查 `C_hard/Inv`、progress/deadline/attempt、footprint、fencing 和规划期 capability/mediation certificate；有反例只把当前 `π` 标为 `PLAN_REJECT(π,witness)`，然后继续枚举，不能提前结束 instance solver。执行后 runtime receipt/effect witness 由状态机 reconciliation 检查，不作为规划时已经存在的证据；
5. `ComputeValue`：分别构造 `P_soft^m(·|π)` 与 `P_soft^m(·|π0)`，精确求 `V_m^soft(π)=E_{P_soft^m(·|π)}[U]`、`Δ_m^soft(π)=V_m^soft(π)-V_m^soft(π0)`，取 `V_rob^soft=min_m V_m^soft`、`Δ_rob^soft=min_m Δ_m^soft`；fault/scheduler adversary 仅用于 hard safety 与 worst-case cost，不改变 nominal-soft 的语义；
6. `Aggregate`：central-full、total exact oracle 下，若存在可行计划，验证全部排序上更优的候选（包括同成本但 branch-depth/probe-risk/canonical-id 更优者）后按固定 tie-break 返回 `ACCEPT(π*)` 且 `Optimality=OPTIMAL_WITHIN_Π`；只有所有 `π∈Π` 都获得确定反例时才返回 `INSTANCE_INFEASIBLE`。在 sealed-Γ 模式中，候选级 `UNRESOLVED` 不能伪装成 `PLAN_REJECT` 或 infeasibility witness：若已经有 `CERTIFIED_TRUE` 计划但存在排序上更优的 `UNRESOLVED` 候选，可返回 `ACCEPT(π)` 与 `Optimality=FEASIBLE_NOT_PROVEN_OPTIMAL`；若尚无已证可行计划则返回实例级 `UNKNOWN`；只有所有候选均有完整负 witness 才返回 `INSTANCE_INFEASIBLE`。若输入/证书 preflight 失败，实例在枚举前返回 `UNKNOWN`；枚举/验证未完成为 `TIMEOUT`。UNKNOWN/TIMEOUT 不能作为 infeasibility witness。对外 API 将 `UNKNOWN` 编码为 `(publicDisposition, accessControlledDiagnosticReference)`：公开字段只说明安全处置类别（例如 `POSSIBLE_EFFECT_DO_NOT_RETRY`、`NEEDS_OWNER_CONFIRMATION` 或 `MODEL_INPUT_INVALID`），诊断引用在假设 ACL 下定位具体 counterexample、receipt、版本和隐藏世界信息，但不构成 confidentiality/privacy theorem；`IN_DOUBT/CommitUnknown` 不得被压成可盲目重试的普通 UNKNOWN。

该算法把 Gateway 可执行性、semantic-executability obligation、硬安全、nominal-soft value contrast 和成本放在同一个 decision problem 中；`minimum-cost` 与 `inclusion-minimal` 分别报告。

## 5. Anti-evasion contract refinement（planned/unverified）

公共硬契约统一写为 `C_hard=(Assume,Input,Obligation,PublicFootprint,Projection,Exception,Deadline,Attempt,Freshness,Idem,Auth)`；soft evaluator `U` 独立存在。`Assume` 是环境 trace 的显式 admissibility predicate；repair 不得使原本 admissible 的输入/环境变成 inadmissible，环境原本不满足 Assume 时记录正交 `ENVIRONMENT_OUT_OF_SCOPE` 标志，不以空轨迹获得 vacuous safety。repair 不修改合同，只验证 implementation trace 是否在 progress/divergence-sensitive refinement 下保持原合同：不强化 Assume、不缩小 Input/scope、不删除/延迟 Obligation、不扩大未授权 PublicFootprint、不改变 Projection/Exception/abstain/deadline/attempt，并固定 `U`、action library 和 cost hash。

这一偏序和局部到全局的 assume–guarantee 组合目前是 `unverified`，需要形式化证明或模型检查 artifact。

## 6. Owner-fenced Action Gateway 状态机（planned）

建议状态：

`ObservedCut → Diagnosed → Proposed → SupportChecked|Unknown → OwnerPrepared → VersionFenced → Committing → Committed|IN_DOUBT → VerifiedAtCut → Finalized`。

异常：`Aborted / CompensationPending / Compensated / Revoked / Stale / Exception / HistoricalViolation / Remediation / Timeout`。

关键语义：

1. `repairId + generation + ownerEpoch` 唯一；重试复用语义 token；
2. OFFER/ACCEPT 与 fencing version durable 绑定，旧 owner 永不能 redeem；
3. PREPARE 不产生外部副作用；COMMIT 记录 linearization point、输入版本、pre/post hash 和 change-set；
4. 并发 repair 需检查 `GlobalEffectCompat`、read/write footprint 和 serializability；
5. 分区无 quorum/fencing 时安全优先阻塞或 unknown，不能同时宣称无阻塞 liveness；
6. gateway 外写入不可观察时，安全结论降级为 cooperative/crash-fault scope。

7. `WorldAtCut` manifest 包含 causal frontier、in-flight channel state、owner membership/epoch 和每个 authoritative resource 的 snapshot/version；只有稳定 cut 才能进入验证。
8. fencing 必须在每个资源 sink 的线性化点执行 `commitIfVersion(expectedVersion,expectedEpoch,changeSet)`；仅在中央 registry 记录 epoch 不足以拒绝旧 owner。
9. COMMIT 后 receipt 丢失进入 durable `IN_DOUBT/CommitUnknown`；恢复流程先查询 sink 的持久 idempotency/receipt，再决定 finalize、compensate 或人工 remediation，禁止盲重试不可幂等 effect。
10. effect witness 包含 actor、repairId/generation、resource version、epoch、transitive footprint、完整 change-set、receipt 和独立 observer；hash/signature 只证明来源/一致性，不证明无遗漏或因果作者。
11. 无线性一致 fence authority/quorum 的分区期间禁止 commit；`VerifiedAtCut` 只有在 quiescence/lease/monotonic invariant 后才能升级为 `Finalized`。

Gateway、fencing、幂等和补偿的具体实现当前均为 `planned`；不要把 `evolutionCoordinator` 的现有 rollback 误写成该状态机已实现。

## 7. Verifier 与证书（planned/unverified）

独立 bounded verifier 接受：

- typed transition 与有限时域 `H`；
- immutable `C_hard/Inv` 与只读 soft evaluator `U`；
- 局部 assume–guarantee 证书；
- WorldAtCut、权限/版本/幂等、无冲突 footprint；
- 规划期 capability/mediation certificate，以及执行后 runtime receipt/effect witness 与 gateway 线性化点；两者不能互相替代。

canonical core 的安全证书证明所有允许轨迹的硬性质，exact value certificate 给出 `V_rob^soft/Δ_rob^soft` 的精确有理值或 DP witness；统计 LCB 只属于后续 learned-model 扩展。Planner/LLM/searcher 不属于安全 TCB。若局部 monitor 无 completeness witness，只能证明已见事件，不得推出全局无遗漏。

### 7.1 最小定理草案（unverified）

#### 正文唯一编号与证据映射

投稿正文只使用以下三个编号；后文历史 `T1/T2` 分别是 D2/D3 的证明草案，`T3/T4/T5` 不属于正文贡献编号。

| 正文编号 | 唯一 statement | 主要证明义务 | 最小 artifact test |
|---|---|---|---|
| D1 | well-formed finite CP-RIR：`Comp0/M_hat` 有限、非空、候选无关、闭包有效，并独立定义 `FEAS_full/FEAS_robust`、固定 `π0`、`V/Δ`、hard safety 与 worst cost | non-vacuity、world-index 一致、baseline binding、verdict type consistency | empty/contradictory completion、candidate filtering、baseline monotonicity、exact value recomputation |
| D2 | fixed-plan bounded safety：abstract product checker 接受，且 safety-reflecting simulation、完整 mediation、cut、token、cross-sink/terminal closure 前提成立，则 concrete bounded trace 满足 `C_hard∧Inv` | abstract checker soundness；`Safe(ατ)⇒Safe(τ)`；effect-complete transfer；sink/cut/cross-sink lemmas | stale/equivocation、old-owner write、half commit、receipt loss、hidden effect、post-horizon closure |
| D3 | central-full finite synthesis：在 total exact oracle 与有限可枚举 `Π` 下，solver 终止、sound、relative-complete，并返回 minimum-cost feasible policy 或完整证据支持的 `INSTANCE_INFEASIBLE` | fixed-plan checker 等价；enumeration coverage；tie-break/cost correctness；UNKNOWN/TIMEOUT 不作 infeasibility witness | independent oracle confusion matrix、OPT equality、all-plan negative witnesses、same grammar differential check |

后文的 T3 不可组合例只作 motivating counterexample；T4 受限复杂度只作附录；T5/INDEX 只作 access-model research agenda。三者不得出现在正文 contribution list，也不得与 D1–D3 并列编号。

**D2（历史 T1）：bounded conditional hard-safety soundness（正文目标）**。给定 `CutAdmissible`、非空冻结 `M_hat`、固定且认证的 owner/channel/resource universe 及可检查 `CompleteCutCert`、所有外部 effect 的 CompleteMediation、sink-side 原子提交 `(effect,dedup-record,receipt)` 并检查完整 token binding（至少 `epoch/version/repairId/generation`）、跨 sink 不变量的原子事务/escrow 或正式可分解与串行化证明、total 且 divergence-sensitive 并安全反射的 concrete-to-model simulation `α`、局部 rely→guarantee 或无冲突 footprint+commutation、world-indexed `Auth_m` 的全部 authorization/refusal outcomes、对 `Reach_soft∪Reach_fault` 全部 information histories total/non-anticipative 的 proposal policy（或合同显式授权的 safe-abort/abstain）、terminal closure/inductive invariant，以及无历史/未决合同违例。除此之外还必须有独立的抽象安全前提：对每个 `m` 和完整 policy tree，`CheckAbstract(Product(W_m,π,C_monitor,Fault_H))=SAFE`，或逐条证明所有 abstract reachable trace 满足 `C_hard∧Inv`；capability/mediation 证书本身不蕴含抽象安全。若每个 branch 的规划期 capability certificate 通过独立 checker，且上述 abstract checker sound，则对所有 `m∈M_hat`、所有 `Auth_m` 可达 outcome 和 gateway scheduler/crash/communication-fault nondeterminism 下的 `τ_impl∈Trace^impl_H(m,π)`，concrete trace 本身及 `α(τ_impl)` 均满足 `C_hard∧Inv`。执行后 receipt 只用于 reconciliation/finalization，不倒充规划证书。该结论是 model-relative bounded safety，不声称 `m*∉M_hat` 或 H 之外的完整 liveness。若一般前提不可证，返回 `UNKNOWN(INPUT_INVALID)`；仅 cut 前已有硬违例才输出 `HISTORICAL_VIOLATION/REMEDIATION`。

**D3（历史 T2）：Exact robust decision 与 non-vacuity（正文目标）**。本定理只针对 `central-full + total exact semantic oracle` canonical core；sealed-Γ 的三值 verifier 由附录接口研究与第 18 节单独规定。区分 `CP-RIR-EVAL(I,π)`（给定计划的有限检查）与 `CP-RIR-SYNTH(I,G_Π)`（由紧凑 policy grammar/bounds 合成计划）。在冻结、闭包有效的 `M_hat`、total transition/authorization/executability/effect oracle、固定 nominal-soft kernels `K_soft^m`、固定成本和 contract/evaluator hash 下，`EVAL` 直接重算 `FEAS_robust(M_hat,π)`、硬安全、`V_rob^soft`、`Δ_rob^soft` 和成本，不依赖 Γ certificate；对可枚举的 `G_Π`，`SYNTH` 通过有限枚举终止。对满足 canonical schema 的有效有限 central-full 实例，`Solve(I)=ACCEPT` 当且仅当存在 `π` 满足 `FEAS_robust(M_hat,π)`，否则返回 `INSTANCE_INFEASIBLE`；不存在第三种语义答案。该二值结论不得外推到 sealed-Γ：即使 public input 有效，证书 omission/coverage 不足/verifier unresolved 仍返回 `UNKNOWN` 或只证明 `FEASIBLE_NOT_PROVEN_OPTIMAL`。central-full 中的 `UNKNOWN`（对外别名 `INPUT_INVALID/abstain`）仅表示输入/manifest/TCB 不满足 canonical 前提，`TIMEOUT` 仅是资源受限实现的运行结果，二者都不能充当语义 infeasibility witness。硬安全/成本反例可用具体轨迹；`V_rob^soft<η` 或 `Δ_rob^soft<κ` 必须给出 `(m, exact rational value, DP/table hash)` 算术证书；`INSTANCE_INFEASIBLE` 的全量计划证书可能是指数大小，不未经证明声称存在 succinct counterstrategy。这给出 central-full relative completeness/non-vacuity，防止 reject-all。

**统计扩展（不属于 canonical T2）**。若未来从随机干预数据学习 `M_hat` 或 transition/effect，则另行定义 outer confidence-set 构造、联合 `(Z_t,A_t)` assignment、estimator、simultaneous confidence、选择后覆盖以及依赖 `μ^{-H}` 的样本复杂度。该扩展不得改变 exact core 的 ACCEPT 语义，也不能用 public-history positivity 消除隐藏授权 collider。

**附录 A1（历史 T3）：不可组合 motivating counterexample（非正文贡献）**。在两个公共观察相同的世界 `m_a,m_b` 中，动作 `a` 只在 `m_a` 达到 `U=1`、在 `m_b` 违反 `C_hard`；动作 `b` 对称；低风险 probe `q` 可在一次预算内区分两世界。任何固定顺序的“因果评分→独立 set-cover→局部 verifier”流程，若在看到 `q` 前选择动作，则要么在一个世界误接受/违反硬契约，要么为同时覆盖两世界支付超过预算 `k`；集成 contingent regime `q→a/b` 在 `k` 内可行。该命题只针对明确定义的有限 DSL、共享 footprint 和成本模型，不声称击败任意完备 contingent planner。

**附录 A2（历史 T4）：受限复杂度边界（非正文贡献）**。NP-hard 归约落在 `CP-RIR-SYNTH` 的 deterministic one-world、zero-observation branching、policy 编码为 n-bit action subset（或长度≤n 的 deterministic action sequence）、每 primitive 至多一次、`π0=noop` 且 `U(π0)=0`、`U(π)=1` 当且仅当覆盖全集、`η=1,κ=1`、正整数成本和预算 `k` 特例；transition/utility 使用多项式大小的 factored bit-vector/circuit representation，而不是显式枚举 `2^{|E|}` 状态。因此 `V_rob=1` 且 `Δ_rob=1` 当且仅当覆盖全集，weighted set cover YES 当且仅当 CP-RIR-FEAS YES。其它动作库为空或成本超过预算，重复动作可规范化删除，不能通过 no-op、重复动作或隐藏替代动作绕过归约。该受限 factored deterministic 子类可给 NP membership（subset 证书由电路在多项式时间验证）；一般 succinct `SYNTH` 不声称 NP membership。唯一 FPT 候选限定于完整 decision-variable/world/non-anticipativity/executability 的显式 bounded-arity extensional `G_joint`，参数包含 `(w,K,H,B,max-domain,policy-memory,arity,representation-width,probability-bit-width,cost/threshold-bit-width)`，separator DP 保留每世界 value/safety 状态并精确求 FEAS/OPT；缺任一域/编码参数时不声称 FPT。

### 7.2 D2（历史 T1）证明骨架与失败边界（unverified）

为了避免循环论证，T1 不把“证书 sound”当作前提后再推出“证书 sound”。证明拆为四个可独立检查的引理：

1. **Cut completeness lemma**：先冻结并认证 owner/channel/resource universe；`WorldAtCut` 的 vector-clock frontier、in-flight channel state、owner membership 和 authoritative resource versions 对该 universe 中所有 cut 之前已发生/在途事件构成 downward-closed manifest。若 universe 不可枚举或存在未纳入的 channel/resource，`CompleteCutCert` 校验失败，结果只能 `UNKNOWN`。
2. **Sink fencing lemma**：每个 effect sink 在同一 linearization point 原子验证 token 的签名集合、`issuerSequence` 单调性、`expiry`、`repairId/generation`、`tupleHash`、`contractHash/dslHash/gammaHash`、`worldCommitVecHash`、`nonEquivocationProof`、`expectedVersion/expectedEpoch` 与 dedup key，并原子持久化 effect、dedup record 与 receipt；因此旧 epoch、stale version、跨合同 token 和重复 concrete write 被拒绝或可唯一 reconciliation。若任一 sink 允许旁路写、receipt 与 effect 非原子，或仅由中央 registry 检查，不能应用该引理。
3. **Local-to-global trace lemma**：固定合同 hash 下，每个 typed action 的局部 assume–guarantee 证书满足 progress/deadline/attempt-sensitive trace refinement，且 transitive footprint closure 无冲突；跨 sink 不变量还必须由单一原子事务、escrow，或正式的可分解/串行化证明承担，不能由多个局部 CAS 自动推出。该引理需要对异步 effect、shadow route、补偿和人工 abort 的语义显式枚举。
4. **Simulation/reflection lemma**：`α` 对 concrete steps total、divergence-sensitive 且安全反射；任何 concrete external effect 都映射为可见 abstract effect，且 `Safe(α(τ))` 足以推出 `Safe(τ)`。否则抽象模型可能隐藏真实违例。
5. **Branch induction lemma**：对 policy tree 深度与 horizon 双重归纳；probe 分支只更新公开 filtration，不改变已冻结 `M_hat`；每个 child branch 重新满足前述四个引理，并由 terminal closure/inductive invariant 处理 horizon 边界，故所有 `≤H` reachable traces 满足硬性质。

T1 结论分两级：在 `CompleteCutCert ∧ CompleteMediation ∧ AtomicEffectReceipt ∧ CrossSinkInvariant ∧ SafetyReflectingSimulation ∧ LocalRefinement ∧ NoHistoricalViolation` 下，`∀m∈M_hat,∀τ∈Trace_H^impl(m,π): Safe_C(τ)=1`；若另有 `Reach_H⊆SafeClosed` 且 `SafeClosed` 对所有 admissible 后续步归纳闭合，则 safety 延伸到任意长度，但仍不推出 eventual completion/liveness。任何必需前提不可证时，不得把局部 verifier 通过升级为全局 safety；输出 input-validity `UNKNOWN` 或 `HISTORICAL_VIOLATION/REMEDIATION`。

### 7.3 附录 A2（历史 T4）归约和参数化边界（unverified）

**NP-hard 归约草案**：给定 weighted set-cover 实例 `E={e_i}`、集合 `S_j` 和成本 `c_j`，构造 `CP-RIR-SYNTH` 的单世界、zero-observation-branching 特例。policy grammar 以 n-bit subset 编码动作选择，factored state 含 `covered_i∈{0,1}`，动作 `r_j` 用多项式大小电路将对应 bits 置 1，horizon≤n；固定 `π0=noop,U(π0)=0`，terminal reward circuit 输出 1 当且仅当 `∧_i covered_i`，`C_hard/Inv=true`，`η=1,κ=1`，cost=`Σ_j c_j`，预算为 `k`。重复动作 idempotent、正成本且无新增覆盖，可规范化去重。于是存在 cost≤k 且 `V_rob=1,Δ_rob=1` 的 policy 当且仅当存在 weighted set cover，factored 编码规模多项式；subset 是多项式可验证证书，因此该受限 factored deterministic 子类为 NP-complete。一般 succinct CP-RIR-SYNTH 不声称 NP membership。

**唯一正结果候选**：完整联合 `G_joint` 同时包含 shared decision/non-anticipativity、contract monitor、executability、world 和 utility 因子。只有在该联合图本身（或一个对所有 world 共同适用的树分解）treewidth≤`w`、最大非世界域≤`D`、世界数 `K`、时域 `H`、数值/cost/threshold bit width≤`b` 时，才可尝试对共享策略做一次联合 DP，目标复杂度写为 `O(K·N·D^{w+1}·poly(H,b,L))`，其中 `N` 为联合图 extensional factor 数，`L` 包含 policy-memory/grammar encoding、factor representation width 与有理数 bit-growth。不能把每个世界分别优化后再聚合；那只适用于固定 policy 的 evaluation。若 world 作为联合变量进入 bags，则改用 `D'=max(D,K)` 的联合图口径并使用 `O(N·D'^{w+1}·poly(H,b,L))`。只约束每个 world 的 transition graph treewidth 不足；若联合 decision graph、域或编码位宽未参数化，不声称 FPT。该结果的新颖性有限，artifact 完成前保持 `unverified`。

该归约和 DP 只是证明计划，当前状态 `unverified`；删除对真实 robust 目标的次模近似和无条件 `1−1/e` 保证。

### 7.4 D2 最小可机械检查模型（planned/unverified）

为使 T1 不停留在“完整 mediation”口号，先定义一个可由有限模型检查器重算的最小实例。其 manifest 必须包含：

```text
Universe = (Owners, Channels, Resources, Sinks)
CutCert = (frontier, inFlight[Channels], ownerEpoch[Owners], resourceVersion[Resources], hash)
Concrete_m = (X_m, x0_m, →_m, bad_C,m, ext_m, H)
Abstract_m = (S_m, s0_m, ⇒_m, bad_A,m, α_m)
Model = ({Concrete_m,Abstract_m,δ_m,Auth_m,Exec_m,Effect_m,O_m,K_soft^m}_{m∈M_hat})
Contract = (C_hard, Inv, Deadline, Attempt, Footprint, Idem)
Certificate = (Γ-world/capability/RelCompat, mediation, refinement, crossSinkInvariant, terminalClosure)
```

concrete 状态至少包含 `x=(t,epoch,resourceVersion,debit,ledger,dedup,receipt,inFlightQueue,gatewayPC,faultMode)`；所有域和队列容量、消息字母在 benchmark 中显式有限，`bad_C` 是前缀闭集。固定合同先编译成有限 monitor automaton `M_C=(Q,q0,step,bad,accept)`，deadline/attempt/progress 违例进入 `bad`。`K_soft^m` 是与 adversarial scheduler/crash/communication-fault 自动机分离、固定且有理数编码的 nominal 外生选择 kernel；它必须与 `δ_m/Auth_m/Exec_m/Effect_m/O_m` 共同组成 `P_soft^m`。合法 authorization/refusal 已由 `Auth_m` 产生，不在 fault 自动机中重复选择。安全性对 fault 自动机的所有轨迹量化，成本取同一自动机下的 worst-case，`V_m^soft/Δ_m^soft` 只对 `P_soft^m(·|π)` 与 `P_soft^m(·|π0)` 的概率轨迹求期望。

检查器按以下顺序运行，任何前提失败都生成可定位的 obstruction，而不是默认为安全：

```text
CheckT1(instance, π):
  1. CheckUniverseAndCut(CutCert, Universe)
  2. CheckTotality({Concrete_m, Abstract_m, δ_m, Auth_m, Exec_m, Effect_m, K_soft^m}_{m∈M_hat}, horizon=H)
  3. CheckCapabilityAndMediation(Certificate.capability, Certificate.mediation)
  4. CheckAtomicEffectDedupReceipt(all Sinks)
  5. CheckCrossSinkInvariant(Certificate.crossSinkInvariant)
  6. CheckRefinementAndReflection(Certificate.refinement, α)
  7. CheckTerminalClosure(Certificate.terminalClosure, H)
  8. for each m∈M_hat, ModelCheck(Abstract_m × M_C): no reachable bad_A/monitor-bad state
  9. Check Init relation, label-preserving forward simulation with stutter,
       stutter-divergence rank, external-effect completeness and safety reflection
 10. return SAFE iff all finite certificate obligations hold; otherwise return obstruction witness
```

这里不再把 `C_hard(τ)∧Inv(τ)` 直接写成 checker 的结论断言；abstract model-checking 与 concrete-to-abstract simulation 是两个独立可审计层。`AtomicEffectDedupReceipt` 不是“每个 sink 各自 CAS”这么弱：同一 effect 的业务写入、去重记录和 receipt 必须在 sink 的原子提交域内一起落盘；跨 sink 约束必须由单一原子事务、escrow，或 manifest 中可检查的串行化/可分解证明承担。external-effect simulation 必须按 `(repairId,resource,version,changeSet)` 保持标签、顺序和重复次数，不能只比较 effect 集合。规划期 `capability/mediation/refinement` 证书与 COMMIT 后 `receipt/effect witness` 分离，后者只用于 reconciliation/finalization。

最小故障反例必须自动生成并通过 checker 拒绝：

1. **双 sink 半提交**：支付 sink 的 CAS 成功并扣款，账本 sink 尚未提交，协调器崩溃且 receipt 丢失；若无原子跨 sink 约束，`CrossSinkInvariant` 失败，不能返回 SAFE。
2. **旧 owner 延迟写**：epoch=1 的旧 owner 在 epoch=2 修复已提交后到达 sink；若 sink 只检查中央 registry 而不执行原子 `(epoch,version,repairId)` fence，`SinkFence` 失败。
3. **抽象隐藏 effect**：concrete trace 产生未以相同 repairId/resource/version/change-set、顺序和 multiplicity 映射到 abstract trace 的外部写入；effect-complete label simulation 失败。
4. **post-horizon closure mutant**：前 H 步满足契约但终态不在 `SafeClosed`，或存在允许的后续环境步离开 `SafeClosed`，`CheckTerminalClosure` 失败；只有证明所有 t=H 可达状态进入永久安全闭包后，才可生成“bounded safety + safety closure”证书，仍不声称 liveness。

该模型只支持 bounded、model-relative safety；它不证明开放世界安全、长期 liveness 或真实系统中的 world-set coverage。

### 7.5 Finite closed-world benchmark 规范（planned）

每个 benchmark instance 是一个可序列化的 manifest：

```text
solver_worlds: [m_1,...,m_K]          # 求解器可见，冻结且非空
workflow_m: (S_m,s0_m,A_m,δ_m,O_m,H) for each m∈solver_worlds  # 有理概率/有限状态
contract: (C_hard,Inv,U,Projection)   # evaluator hash 固定
policy_class: (Π,B,non-anticipativity)
actions: typed DSL + owner/auth/version/footprint/cost
cut: vector-clock frontier + channel/resource snapshots
baseline: π0                          # 同一 cut/H/重试/授权
fault_automaton: crash/drop/dup/reorder/partition/receipt-loss + finite budget B_f
evaluation_only: hidden_worlds + manifest_corruptions + resource_budgets
```

manifest 不保存预计算答案。独立 oracle 从原始 transition/contract/policy manifest 重新枚举，并输出四个分层对象：`plan_semantics(π)={Safe,V_m,Δ_m,cost,PLAN_REJECT witness}`、`instance_semantics={OPT,ACCEPT|INSTANCE_INFEASIBLE}`、`input_validity={VALID|UNKNOWN(reason)}`、`execution_outcome={TIMEOUT|runtime status}`。`HISTORICAL_VIOLATION/REMEDIATION` 是前缀分类；`IN_DOUBT/Committed/Finalized` 是运行时状态，均不得塞进五态 solver verdict。hidden worlds 只用于 world-set enlargement/OOD 敏感性，不倒推 canonical exact guarantee。

独立 oracle 的伪代码必须与被测 solver 分离 parser、evaluator 和搜索实现：

```text
Oracle(I):
  Validate(I)                         # hashes, finite monitors, total kernels, cut/universe
  Π := CanonicalizeAndEnumerate(G_Π)  # fixed alpha-renaming/canonical id
  for π in Π:
    for m in solver_worlds:
      P_soft[m,π] := Product(δ_m, Auth_m, Exec_m, Effect_m, O_m, K_soft^m, π, SoftRewardMonitor)
      P_hard[m,π] := Product(δ_m, Auth_m, Exec_m, Effect_m, O_m, π, FaultAutomaton, ContractMonitor)
      P_soft[m,π0] := Product(δ_m, Auth_m, Exec_m, Effect_m, O_m, K_soft^m, π0, SoftRewardMonitor)
      plan[m,π] := (hard_trace_witness from P_hard,
                    exact rational V_m^soft/Δ_m^soft from P_soft,
                    worst_cost from P_hard, capability/refinement status)
    aggregate plan over fixed world index m, then apply thresholds/tie-break
  aggregate all plan results into instance semantics
  emit metamorphic digest and layered status schema
```

预注册 metamorphic gates：world 顺序置换不改变结果；插入不可达状态不改变结果；复制 dominated action 不改变 `OPT`；扩大 `M_hat` 的 robust `V_rob^soft/Δ_rob^soft` 不增加；提高预算不应把 `ACCEPT` 变为 `INSTANCE_INFEASIBLE`；提高 `η/κ` 不应把 reject 变为 accept；policy-tree alpha-renaming 不改变结果。任何 gate 失败都标记 oracle/solver artifact invalid，而不是解释成算法差异。

四类必测实例：

1. **World ambiguity**：两个公共等价世界、`q→a/b` 才可行；测试冻结 `M_hat` 和 PLAN_REJECT；
2. **Executability trap**：每个 primitive 单独存在且可授权，但组合 footprint、版本或 owner kernel 不可执行；测试不得把 primitive executability 当成完整 policy executability，也不得按候选删世界；
3. **Contract laundering**：删除输入、修改 evaluator、H+1 违规、shadow route 或无限 retry；oracle 必判 refinement 失败；
4. **Protocol fault**：old-owner delayed effect、TOCTOU、partition split-brain、COMMIT-after-effect receipt loss；无 sink CAS/observer 时 input-validity oracle 判 `UNKNOWN`，真实执行故障机单独产生 `IN_DOUBT` 等 runtime status。

oracle 规则分层：若某计划存在硬违例、`V_rob<η`、`Δ_rob<κ` 或 worst-case cost `>k`，plan oracle 返回 `PLAN_REJECT(π,witness)`；仅当对所有 `π∈Π` 均有确定反例时，instance oracle 返回 `INSTANCE_INFEASIBLE`。模型/manifest/规划期 capability certificate 不完整由 input-validity oracle 标为 `UNKNOWN`；求解预算耗尽由 runner 标为 `TIMEOUT`。cut 前已有硬违例记录为 `HISTORICAL_VIOLATION/REMEDIATION`，COMMIT 后 receipt 不明记录为 `IN_DOUBT`，两者均是正交字段。实验分别报告 plan-level、instance-level、input-validity 和 runtime confusion matrix、每类 obstruction recall/precision、minimum-cost 与 inclusion-minimal 的差异，以及算法是否错误地返回 reject-all。

## 8. 统计扩展、选择和 UNKNOWN（planned，非 canonical exact core）

canonical finite-world exact core 不使用 LCB/OPE。若未来从数据学习 transition/effect 或 `M_hat`，候选搜索只在 development episodes；locked holdout 只进行一次最终评估。预注册候选族大小为 `M` 时，可使用 simultaneous LCB（误差项含 `ln M`）；自适应继续生成候选时使用 confidence sequence、alpha-spending 或 reusable holdout，并补齐 outer confidence-set coverage 与选择后保证。

统计扩展的 `coverageUnknown` 只表示 learned/open-world 覆盖不足：

`no-support / OOD-hidden-modifier / authorization-nonpositivity / unreplayable-or-unmodeled-effect`。

canonical input-validity `UNKNOWN` 单独表示 `model-input-invalid / certificate-unavailable / verifier-incomplete / tcb-untrusted`；`privacy-budget-exhausted` 是 privacy release status；`execution-unknown/IN_DOUBT` 是 runtime status。已完整建模的不可逆 effect 属于确定语义，只有不可捕获或不可重放时才进入 learned coverageUnknown。

每个 unknown 内部记录 obstruction witness、缺失证据和后续动作；公开接口只返回经过安全投影的 `publicDisposition`。安全 unknown 必须 deny/abstain；effect unknown 时不得产生 `PLAN_FEASIBLE` 或外部 effect，只能建议合同明确授权的只读 probe/人工确认。报告 selective risk、coverage、unknown precision，不能用拒答隐藏难例。`IN_DOUBT/CommitUnknown` 必须映射到不可盲目重试的公开处置类，具体 receipt 查询和 effect 见证只交给 owner/审计者。

第二轮语义审查要求再拆两类状态：epistemic `UNKNOWN`（canonical 输入、typed executability、TCB 或 manifest 完整性不足）与计算性 `TIMEOUT`（资源限制内未完成）。`M_hat(h_pub)` 必须在搜索前冻结、非空，并声明 model-relative 条件 `m*∈M_hat`；无法观察的 world-set misspecification 是独立外部效度风险，不能假装由 runtime UNKNOWN 自动检测。不能先按 action support 过滤有害世界而制造 vacuous ACCEPT。对单个计划存在坏世界时只能返回 `PLAN_REJECT(plan, counterexample)`；只有证明所有有限计划都有安全/value/effect/cost 反例才返回 `INSTANCE_INFEASIBLE(counterstrategy)`。若 cut 之前已有硬不变量违例，结论必须是 `historical-violation/remediation`，不能生成全前缀 safety certificate。

统计扩展中的动态计划需显式定义 filtration、policy regime、顺序识别和与 no-op 的 `Δ`；自然恢复不能被误称为 repair。顺序 overlap 需量化为每个可达历史 action 的 `p_min`，并记录组合概率可能指数衰减。canonical exact core 直接使用已知 authorization/transition kernel。

契约验证采用冻结合同/evaluator/action-library/cost hash 上的 progress- 与 divergence-sensitive trace refinement，覆盖 deadline、attempt、abstention、transitive footprint、shadow routing 和异步 effect；`UNKNOWN` 若不在原契约中，必须在任何外部 effect 前作为安全终态显式授权。

`C_hard/Inv` monitor 必须对所有 `≤H` 可达轨迹成立；canonical core 中 soft `U` 通过精确 `V_rob/Δ_rob` 约束，统计扩展才使用 LCB。若合同只声明 bounded-H safety，则 H+1 不在结论内；若论文声称后续 safety，所有 t=H 终态必须进入对允许后续步归纳闭合的 `SafeClosed`。无限 retry、shadow/pending 路由、把人工 abort 或补偿记作 required success，均视为 refinement 失败。cut 前已有违例时不生成全前缀证书，而进入 remediation 语义。

## 9. CMRS 求解器与复杂度边界（planned）

可行域：类型/owner 合法、契约保持、硬安全、closed-world typed executability（action existence、authorization reachability、Gateway capability、组合 footprint）完整、精确 `V_rob≥η` 和精确 `Δ_rob≥κ`。明确区分：

- `minimum-cost`：全局成本最小；
- `inclusion-minimal`：无可行真子集；
- `Pareto-minimal`：多目标前沿；
- `heuristic/α-approx`：仅在已验证结构下使用。

复杂度正文只保留两个对象：`CP-RIR-EVAL(I,π)` 验证给定计划，`CP-RIR-SYNTH(I,G_Π)` 从紧凑 policy grammar 合成计划。weighted set-cover 只证明 `SYNTH` 的受限 deterministic static-subset 子类 NP-complete；一般 succinct `SYNTH` 不宣称 NP membership。正结果仅在完整 decision-variable/world/contract/executability/non-anticipativity 因子图宽度、域和数值 bit complexity 均参数化时作为 bounded-treewidth WCSP specialization 给出。证明和 artifact 完成前状态为 `unverified`。

删除 #P-hard、次模近似、`1−1/e` 和 solver portfolio 的正文贡献主张。robust `min_m` 通常不保持次模，任何未来 surrogate 结果只能对 surrogate OPT 负责。

## 10. 实验设计（planned）

### 10.1 穷举微基准

32 个有限状态 workflow（8 拓扑 × 4 组织/权限布局），注入单故障、双故障和未见组合；固定 snapshot/seed，穷举有限 policy-tree 类 `Π` 的完整 probe–branch–repair 计划。独立 oracle 逐世界展开完整策略树，计算 `Safe`、`V_m`、`Δ_m`、worst-case cost、`PLAN_REJECT` witness、`ACCEPT/INSTANCE_INFEASIBLE`，并另外生成 manifest-corruption/hidden-world sensitivity、`UNKNOWN` input-validity 与 runner `TIMEOUT` 标签。静态 repair 子集只作为消融基线，不再作为 canonical CMRS 金标。验证 soundness、relative completeness、typed executability、最小性和不可组合反例。

### 10.2 Locked AppWorld

开发集与 locked task family 分离；对比 NoRepair、causal-RCA top-1、workflow-only、code-only APR、contract/CEGIS、central full-state oracle。报告官方成功率、hard-contract violation、repair cost/OPT、过修复率、恢复时间、abstention correctness、stale/duplicate effect 和 p50/p95/p99 提交延迟。

### 10.3 独立跨域 runner

至少两个独立管理域/隔离进程（若要测试多方组合则使用三个或更多）、各 owner 独立凭证和私有 DB/local monitor；协调器只获得边界证书。注入 crash/restart、drop/dup/reorder、partition、并发 repair、TOCTOU 和不可补偿副作用。若实验仍是共享数据库或中央管理员全读，只能称 multi-agent workflow，不能声称 cross-organization。

### 10.4 公平的不可替代性对照（planned）

为了避免把“统一定义”误写成“击败所有 planner”，对照实验固定同一 `M_hat`、transition/effect oracle、typed action DSL、`C_hard/Inv/U`、consistent cut、Gateway、故障自动机、策略树深度和预算。比较三类求解器：

1. `CP-RIR`：联合搜索 probe–branch–repair，并在同一策略树上检查契约、可执行性、成本、`V_rob` 和 `Δ_rob`；
2. `Complete-Contingent`：允许同样的 policy-tree 表达能力、`Γ` relational certificate oracle、world oracle、contract/refinement checker 和 Gateway capability checker；规划阶段不读取或调用 COMMIT 后 effect witness，runtime receipt/effect witness 只进入独立执行评估；
3. `Fixed-串联`：先 diagnosis，再独立 repair subset，再 local verifier，且在 probe 前锁定 repair，作为 T3 motivating counterexample 的受限架构基线。

`Complete-Contingent` 与 CP-RIR 必须接收同一 `Γ` relational certificate oracle、DSL、world model、contract/refinement checker、Gateway capability、fault/cost 预算和 timeout。若二者得到相同可行集和最优成本，则 CP-RIR 的贡献应诚实改写为“contract/runtime-aware problem formulation 与 certified specialization”，不能声称算法级不可替代；只有在明确定义接口限制并得到 separation witness 时，才报告受限架构上的严格优势。所有结果同时报告 plan-level verdict、instance-level optimum、input-validity、runtime status，不以单一成功率代替语义比较。

## 11. 实现状态总表

| 能力 | 状态 | 证据/边界 |
|---|---|---|
| 事件/P-E/lineage 记录 | implemented/prototype | 现有 OrgBench 与 coordinator |
| hash/namespace/evidence gate | implemented | `evolutionCoordinator.mjs` |
| 组织/个体候选与 rollback 工程流程 | implemented/prototype | change-manifest；非因果证明 |
| typed transition/WorldAtCut | planned | 尚无代码/证明 |
| learned-model intervention support/joint positivity | planned extension | 尚无随机 fork 适配器；不属于 canonical exact core |
| robust contingent CMRS | planned | 尚无求解器与 oracle |
| anti-evasion refinement verifier | unverified | 需形式化 artifact |
| owner-fenced gateway/effect witness | planned | 当前 rollback 不等价 |
| simultaneous LCB/confidence sequence | planned | 当前固定 confidence 不是统计保证 |
| learned/open-world typed coverageUnknown | planned extension | 当前 gate reasons 不是识别语义；canonical exact 使用 `INPUT_INVALID/abstain` |
| 独立管理域 runner | unverified | 至少两个独立域；多方组合实验可使用三个或更多 |

## 12. 明确不做的事情

本轮不修改源代码、API、数据库 schema、运行时协议或现有实验实现；不把上述 planned/unverified 能力写成已经支持；不把补偿称为 rollback；不以一次 replay、LLM judge 或静态 confidence 声称因果根因、全局最优或 Strong Accept。

## 13. 附录研究议程：历史 T5/C16 严格接口草案（planned/unverified）

### 13.1 查询语言与观察等价

公开输入固定为 `x=(cutHash,contractHash,DSLHash,evaluatorHash,budget,threshold,H)`。`Γ_unary` 的一次查询只能包含 public `x`、单 owner、单动作、单 world projection、epoch 和 version，回复来自固定有限字母 `Σ_unary`。协调器可以随机和自适应，但最大轮数、总 query、总 bytes 和 timeout 必须是实例输入；proposal、answer、refusal、timing、length、hash、cost、status 都进入 transcript。不能把完整 tuple、peer commitment 或 coordinator 私有上下文隐含塞进 unary reply。

`Γ_rel` 额外允许查询 `RelCompat(T)`，其中 `T=(world/action/footprint/owner-set)` 为有限 tuple。证书绑定 `cutHash/worldCommit/contractHash/DSLHash/evaluatorHash/ΓHash/epoch/version/actionTuple/nonce/expiry`；omission、equivocation、stale、timeout 不得默认通过。签名只证明来源，不替代完整性、无陈旧和无 equivocation 证明。

定义 `S ≡_Γ^{pre-decision} S'`：在 coordinator 作出 `π`/`ACCEPT`/`REJECT` 决策之前，对任意受预算、轮数和随机性约束的协调器，所有可见 unary-query transcript（含 payload、refusal、timing、length、hash、status、proof size、retry 和 silence）分布相同。执行后的 sink/effect/receipt outcome 不属于该观察等价关系；若把它们纳入 transcript，通常 good/bad 系统已可被执行结果区分，T5 反例不成立。随机版本必须分别声明 `ε_sound` 与 `ε_complete`（或 perfect soundness/zero-error completeness），不能用“正概率接受”直接推出 soundness 失败。

### 13.2 Soundness、relative completeness 与防止 all-UNKNOWN 绕过

对完整明文模型，定义 `Truth_θ(π)=(Safe_θ,Exec_θ,V_θ^soft,Δ_θ^soft,Cost_θ)`。对 sealed-interface 模型，严格区分三层：`Truth_θ` 是隐藏实际世界 `θ` 的离线 ground truth；`Verify_Γ(I_pub,T_Γ,π)` 只判断 transcript/certificate 是否足以覆盖这些真值；`Solve_Γ(I_pub,Γ_θ)` 才是协调器输出。Γ 证书不能凭空创造 `V/Δ` 真值。

因此，`Γ_rel` 通过后只有在证书覆盖 `Truth_θ` 的全部安全、执行、value、增益和成本分量时，才可映射为 `PLAN_FEASIBLE`。若 T5 限定为 deterministic `H=1` INDEX 家族，关系 bit 直接决定 `U(success)`，可明确写 `V_θ^soft(π_j)=Δ_θ^soft(π_j)=x_j`；一般 sealed-world CP-RIR 若要声称 value/增益保证，则必须增加 attested transition/reward factors 或 `ValueCert(π,worldCommit,V,Δ,DPHash)` 及组合 checker。

统一语义下，`CP-RIR-FEAS^Γ` 只是 sealed-Γ access regime 的接口简称，不是第二个 ground-truth 谓词。其 soundness 应写成：

```text
Verify_Γ(I_pub,T*,π)=CERTIFIED_TRUE
    ⇒ FEAS_robust(M*,π),  M*=Comp(I_pub,T*)
```

若可信 TCB 另证 `θ*∈M*`，才可推出 `FEAS_full(θ*,π)`；若 `M*={θ*}`，则退化为 singleton actual-world 语义。relative completeness 必须以固定的 `M*`、完整且诚实可用的 Γ 证书为条件：`FEAS_robust(M*,π) ∧ CertComplete_Γ(M*,π) ⇒ CERTIFIED_TRUE`。在 valid-input 域，不能用 `UNKNOWN/abstain` 逃避对可判定计划的判断；但证书缺失、覆盖不足、矛盾或 TCB 不可信属于 `UNRESOLVED→UNKNOWN`，不自动是 reject。有效 `RelCompat=false` 且其负 witness 覆盖当前计划时，才是 `CERTIFIED_FALSE→PLAN_REJECT`。

### 13.3 下界候选

`INDEX_d`：A 持有 `x∈{0,1}^d`，B 在 A 的 unary 摘要发送后选择 `j`，联合可行性为 `x_j=1`。固定 one-way 顺序下，bounded-error unary transcript 需 `Ω(d)` bits；若允许按 `j` 重新查询 A，则只需一个 bit，说明 query chronology 是必要前提。

`PAIR-DISJ_d`：构造所有 unary marginal、cost、timing、hash 相同而隐藏 pair relation 不同的系统。无结构黑盒下，zero-error 判断是否存在可行 pair 需最坏 `Ω(d)` relation queries/bits；r-ary tuple 可扩展到 `Ω(d^r)`，但仅在无结构关系假设下成立。

### 13.4 匹配上界与联合授权

联合授权定义为 `Auth_joint(T)=(∧_i Auth_i(T_i))∧RelAuth(T)`；拒绝、沉默或冲突不能默认通过。sink 必须在同一 linearization point 原子检查完整 token binding（签名、issuer sequence、expiry、repairId/generation、tuple/contract/DSL/Γ/world digests、non-equivocation、epoch/version 和 dedup key），再原子提交 effect、dedup record 与 receipt；否则不得应用 sink-fencing soundness lemma。

若完整联合 decision/non-anticipativity/executability/contract/world factor hypergraph treewidth≤`w`、最大非世界域≤`D`、世界数为 `K`、scope≤`w+1`，且 `Γ_rel` 返回 exact extensional factors，则可在一个联合 DP 中保留共享 decision，再以 min-world/worst-cost semiring 聚合；目标复杂度 `O(K·N·D^{w+1}·poly(H,b,L))`，其中 `N` 为联合图 extensional factor 数。逐世界独立优化后再聚合是不 sound 的；固定 policy 的 evaluation 才可分别计算。`L` 必须包含 policy grammar/memory、factor table/circuit encoding 和有理数 denominator growth。证明必须覆盖共享决策耦合、factor composition、certificate composability 和 sink enforcement；DP 本身接近已有 WCSP/CSP 结果，不能单独宣称新颖。

## 14. 本轮 schema 与概率语义残差修正（planned）

manifest 的 `workflow` 统一写成每世界 `workflow_m=(S_m,s0_m,A_m,δ_m,O_m,H)`。为避免 `δ_m` 与 `K_soft^m` 双重计数，定义：

```text
e_t ~ K_soft^m(· | h_t,Q_t,Z_t)
x_{t+1} ~ δ_m(· | x_t,A_t,e_t)
Y_t,Effect_t ~ O_m/Effect_m(x_t,A_t,e_t)
P_soft^m(·|π) := Product(δ_m,Auth_m,Exec_m,Effect_m,O_m,K_soft^m; π,U)
P_hard^{m,f}(·|π) := Product(δ_m,Auth_m,Exec_m,Effect_m,O_m; π,f)
```

其中 `f` 只表示 scheduler/通信/crash/partition 等 adversarial fault，不重复采样合法 `Auth_m` refusal。成本统一为
`C(π)=sup_{m,f,ρ∈Reach(π,m,Auth_m,f;B_f)}Σ_{e∈ρ}c(e)`；`ModelCheck`、`CheckRefinementAndReflection` 和 `Reach` 均按所有 `m∈M_hat` 建立 indexed product。`π` 必须对 `Reach_soft∪Reach_fault` 的所有 information histories total/non-anticipative，或显式使用合同授权的 safe-abort/abstain；否则返回 `UNKNOWN(INPUT_INVALID)`。

## 15. 附录研究议程：历史 T5-INDEX-CP-RIR 下界草案（planned/unverified）

### 15.1 受限问题族

定义 `INDEX-CP-RIR_d` 为一个 split-knowledge、固定一轮的受限 `CP-RIR-FEAS^Γ` 家族。这里 `CP-RIR-FEAS^Γ` 是 interface-relative 版本：public manifest 固定，owner 私有状态 `x` 不作为 coordinator 的明文输入，只能通过 `Γ` 访问；centralized semantics 仅作为隐藏的实际世界 `m_x` 判定 oracle。它不是把当前 exact core 的明文 `M_hat` 输入域偷偷改写成分布式算法。

1. owner A 持有私有 bit-vector `x∈{0,1}^d`，在 `attestationCut` 之前发送一次与 `j` 无关的 `Γ_unary` 摘要 `σ_A(x)`；owner B 的私有索引 `j∈[d]` 只在该 cut 之后揭示，`revealOrder` 规定 round 2 只能由 B 输出，`postCutQueryPolicy=forbid-A-query` 禁止 coordinator/owner 再向 A 发送含 `j` 的 query。摘要和全部 x-dependent metadata 的编码长度计入总预算 `B`；`log|Σ_unary|=O(1)`，不存在 x-dependent preprocessing/shared advice。
2. owner B 随后揭示私有索引 `j∈[d]`，协调器只能提出唯一目标计划 `π_j={a,b_j}`；策略 grammar 中没有替代 repair、额外 probe 或 safe-abort（或这些动作的成本/utility 使其不满足 `k,η,κ`），`π0=noop` 且 `U(noop)=0`。
3. `a`、`b_j` 的 typed capability、footprint、版本和合同公共部分对所有 `x,j` 完全相同；唯一影响该受限实例 FEAS 的隐藏变量是 `RelAuth_x(a,b_j)=x_j`，不存在其它会改变 `δ/U/κ/epoch/cost` 的隐藏变量。本地 `Auth_i` 均允许，只有联合关系决定：当且仅当 `x_j=1` 时，`π_j` 原子成功，`U(success)=1` 且满足 `C_hard/Inv`；当 `x_j=0` 时，`Auth_joint` 拒绝、无外部 effect，且 `U=0`，从而得到确定的 `PLAN_REJECT(value/Δ)` 而非 hard-contract counterexample。设置 `η=κ=1`、`c(a)=c(b_j)=1`、`k=2`，使 `Truth_{x,j}(π_j)` 的 FEAS 恰好等价于判断 `x_j=1`。`M_hat` 不向 coordinator 公开包含 x 的完整世界；它是 sealed owner-state，centralized semantics 只作为离线判定 oracle。
4. 每个 `x,j` 都映射到同一 public schema/cut/contract/DSL/evaluator/cost/threshold，并通过相同 canonical preflight；只有 sealed owner state 不同，不能因缺少 joint relation 而判 `input-invalid`。在该 valid-input 域内，relative completeness 禁止用 `UNKNOWN/abstain` 替代对 `a_j` 的可行性判断。

### 15.2 候选定理与证明路线

**定理（候选）**：任意满足 `attestationCut/revealOrder/postCutQueryPolicy=forbid-A-query` 的 phase-ordered one-way `Γ_unary` coordinator，且 round-1 全部 x-dependent transcript 总量为 `B`（固定 `|Σ_unary|`，所有 hash/timing/length/status/commitment 均计入或信息论隐藏），若对均匀独立的 `(x,j)` 满足

```text
Pr[ACCEPT(a_j) | x_j=1] ≥ 2/3
Pr[ACCEPT(a_j) | x_j=0] ≤ 1/3
```

则 `B=Ω(d)`。在 deterministic zero-error 情形可写为至少 `d` bits；若错误概率为 `ε<1/2`，标准编码界给出候选下界 `B≥(1-h_2(ε))d`（正式引用与证明仍待核验）。证明路线是把 coordinator、owner A 的 round-1 摘要和 owner B 的 round-2 索引揭示直接转成计算 `INDEX` 的 one-way protocol；若 `B=o(d)`，与 one-way `INDEX` 的标准 randomized lower bound 矛盾。定理要求 x-dependent commitment/hash 使用信息论隐藏且其编码计入 `B`；若只依赖计算隐藏假设，必须明确密码学假设。该归约不证明一般 CP-RIR 或所有 Γ 接口的下界，只证明 phase-ordered one-way 协议、无替代动作、valid-input 且禁止 all-UNKNOWN 的 `Γ_unary` 子类。

若允许 B 在揭示 `j` 后重新查询 A，允许 x-dependent metadata 通过 timing/length/status/hash 泄漏，或允许 unary capability 暴露可比较的全局 footprint，以上下界不成立；这些情况必须作为不同接口和实验条件报告。若允许错误概率，定理应显式使用 `ε_sound+ε_complete<1`；其中 valid `x_j=1` 上 `UNKNOWN/REJECT` 均计 completeness error，invalid `x_j=0` 上 unsafe `ACCEPT` 计 soundness error。若要求 zero-error，则 valid instance 上不得输出 `UNKNOWN/abstain`，invalid instance 上不得接受。

更严格的信息论表述：令 `M` 为 `j` 揭示前完整、prefix-free 编码的 transcript，`R` 为与 `X` 独立的公共随机性，`X,J` 独立均匀。若平均 INDEX 判定错误率 `p̄=1/2·Pr[REJECT|X_J=1]+1/2·Pr[ACCEPT|X_J=0]`，则可将候选下界写为 `I(X;M|R)≥d(1-h₂(p̄))`，并在固定/最坏通信长度下令 `B≥I(X;M|R)`。变长或期望通信需另行处理 Kraft/entropy；连续 timing、silence、verifier runtime 若未量化，不能声称已有有限 `B`。

### 15.3 与 Γ_rel 的对照

在同一实例族中，`Γ_rel` 允许 B 揭示 `j` 后查询一次 `RelCompat(a,b_j)`；查询本身需传输 `log d` bits 的索引，owner response/certificate payload 可为 `O(1)` bits，因此总通信应写成 `O(log d)+O(1)`，而不是无条件 `O(1)`。这不是“关系证书总是更省通信”的定理，因为证书生成、绑定、完整性和 sink enforcement 的成本尚未计入。正式比较必须报告 `B_unary`、`B_rel`、rounds、certificate bytes、verifier time 和 false accept/reject。

该草案的创新含义非常受限：它把 interface-relative `CP-RIR-FEAS^Γ` 的 split-knowledge 时序约束连接到一个可复现的通信下界。它不能单独证明 `RelCompat` 的最小性、不能击败 same-`Γ_rel` 的 Complete-Contingent，也不能推出隐私或 coalition safety；若把明文 `M_hat` 仍交给 coordinator，整个下界立即失效。未完成正式归约、引用核验和 artifact 前，状态保持 `planned/unverified`。

### 15.4 语义边界：通信判定不等于可执行授权

`attestation/query` 若发生在 repair horizon 内，其延迟、bytes、risk 和 timeout 必须进入 `P_soft/P_hard` 与 `C(π)`；INDEX 草案暂将其定义为 cut 前的 preflight，action horizon 从证书阶段完成后开始，通信量单独计费。不得一边利用 `Γ_rel` 改变 FEAS，一边把其时间/成本从 policy value 和预算中删除。

bounded-error INDEX 只证明信息复杂度判定下界：`x_j=0` 时允许误报 `ACCEPT`。它不能直接继承 T1 的 zero-false-positive hard-certificate soundness。若 `ACCEPT` 被解释为可执行计划，主安全定理必须改用 zero-error 或 one-sided soundness `Pr[ACCEPT|x_j=0]=0`；bounded-error 版本只能作为辅助通信结果，真实 sink 仍需重新验证 `RelAuth` 并 fail-closed。

## 16. 统一语义与两种访问 regime（planned）

论文和 artifact 应只保留一个 canonical 真值：

```text
FEAS(Complete(I_pub,θ),π)
```

其中 `Complete` 将 public manifest 与 sealed owner state/world `θ` 完整化为冻结 typed model。`central-full` regime 将该 completion 明文提供给 solver；`sealed-Γ` regime 只允许通过 Γ transcript 和证书访问同一 completion。`CP-RIR-FEAS^Γ` 只能作为后一种 access regime 的简称，不应被叙述成第二个独立真值问题。T5 的 singleton-world、`H=1` INDEX 是该统一语义下的受限 access-model necessity lemma。

对 sealed transcript `T_Γ` 定义与其一致的 completion 集 `Comp(I_pub,T_Γ)`。若不声明 trusted actual-world attester，soundness 应写成：

```text
VerifyΓ(I_pub,T_Γ,π)=true
  ⇒ ∀θ∈Comp(I_pub,T_Γ), FEAS(Complete(I_pub,θ),π)
```

若 T5 只研究一个 trusted sealed actual `θ`，则必须明确这是 TCB 假设下的 instance-relative 结论，而不是对所有 completion 的 robust guarantee。单个 `RelCompat(a,b_j)=COMPATIBLE` 通常只能将 completion set 限制为 `{θ:x_j=1}`，并不证明 singleton；只有完整 world attestation、coverage/non-equivocation proof 且无其它隐藏变量时才可声明 `Comp_Γ={θ*}`。所有 `x,j` 必须共享同一 public schema并通过相同 preflight；隐藏关系变化不能把实例变成 `UNKNOWN`。如果把 `M_hat={m_x}` 明文交给协调器，T5 下界无意义；如果将全部 `m_x` 放入 robust set 再取 `min_m`，则可能把所有实例变成恒 infeasible。两种错误都必须在 manifest validator 中拒绝。

统一记号为：`Θ(I_pub)` 是 public manifest 允许的完整世界，`FEAS_full(θ,π)` 是单世界真值，`FEAS_robust(M,π)=∧_{θ∈M}FEAS_full(θ,π)` 是显式冻结集合上的 robust 谓词。sealed transcript 诱导 `Comp_Γ(I_pub,T_Γ)⊆Θ(I_pub)`，因此 verifier 的 robust 目标是 `FEAS_robust(Comp_Γ(I_pub,T_Γ),π)`；只有可信 singleton attestation 时才退化为 actual-world 命题。`Solve_Γ` 只搜索候选并调用 verifier，不定义新的 FEAS 真值。

### 16.1 最小 `Γ_rel + Auth_joint + sink-token` manifest（草案）

```text
instanceId: I_42
public:
  cutHash: h_cut
  contractHash: h_contract
  dslHash: h_dsl
  evaluatorHash: h_eval
  gammaHash: h_gamma_rel
  horizon: 1
  policyClass: [pi_j]
  thresholds: {eta: 1, kappa: 1, budget: 2}
sealedOwners:
  A: {worldCommitRoot: c_A, localRef: owner-local://x, neverSerialized: true, attestationCut: t0}
  B: {privateIndex: j, revealOrder: after(t0)}
queries:
  gammaUnary: {rounds: 1, postCutQueryPolicy: forbid-A-query, maxBytes: B_u}
  relCompat: {phase: POST_J_REL, tuple: [a,b_j], maxQueries: 1,
              declassifies: [tupleIndex,compatBit], queryPrivacy: NONE}
certificates:
  world: {cutHash, worldCommitRoot, epoch, version, nonce, expiry}
  relation: {actionTuple, ownerSet, relationDigest, gammaHash, signature}
  jointAuth: {unaryCaps, relationCert, authHash, epoch, version, dedupKey}
sinks:
  - check: [signatureSet, issuerSequenceMonotonic, expiry, repairId, generation,
           jointAuth, tupleHash, contractHash, dslHash, gammaHash,
           worldCommitVecHash, nonEquivocationProof, epoch, version, dedupKey]
    commit: atomic(effect, dedupRecord, receipt)
    stalePolicy: reject
    omissionPolicy: reject_or_unknown_before_effect
    equivocationPolicy: reject_and_audit
runtime:
  receiptLoss: IN_DOUBT
  possibleEffect: POSSIBLE_EFFECT_DO_NOT_RETRY
sideChannelModel:
  {alphabet, clockResolution, encoding: prefixFree,
   sharedRandomnessIndependentOfX: true, maxBits, maxMsgs, maxRounds}
```

`Auth_joint(T)=(∧_i Auth_i(T_i))∧RelAuth(T)`；任一 owner 拒绝、沉默或关系证书冲突都不能默认授权。`relationDigest` 只能在声明 honest-attesting owner、proof-carrying local checker 或 TEE 等信任模型下支撑 soundness；签名本身不证明关系真实、完整或无陈旧。

manifest 必须区分 `PRE_J` unary pre-attestation token 与 `POST_J_REL` relational token。若 A 在 j 揭示后对完整 tuple 共签，则该步骤已经属于 Γ_rel，不能仍计作 unary phase。Γ_rel 以新增反向 query/round 和显式 declassification，只为该 compatibility 子判定提供所需关系信息：A 会获知 tuple/index，协调器与 sink 会获知 compatibility verdict；它本身不构成完整 CP-RIR decision sufficiency。完整 FEAS 仍需 value/transition/reward/coverage certificate。反例是两个 completion 拥有相同 `RelCompat=true`、Auth/Exec/safety/cost transcript，但 terminal value 分别为 1 和 0，在 `η=1/2` 时 FEAS 相反。当前不提供 query privacy。若要隐藏 j，必须另建 PIR/OT/MPC/TEE 模型并计入安全参数、proof bytes、计算与轮次。

### 16.2 Mutant oracle 预期

| mutant | 预期规划/执行结果 | 理由 |
|---|---|---|
| omission：A 未返回 relation/capability | `UNKNOWN(certificate-missing)`，不产生 effect | 规划证书缺失；不要误标为 schema/input invalid |
| equivocation：A 对两个 owner 返回不同 relation | 规划前 `UNKNOWN(certificate-equivocation)` + fail-closed 审计；若已产生 unsafe effect 则 `HARD_VIOLATION` | 签名不证明无 equivocation |
| stale：epoch/version 过期 | 仅当有可验证负 witness 证明在当前 cut/horizon 内不存在任何 refresh/合法版本、当前计划必然无 effect 时，才 `PLAN_REJECT(stale-known-unrefreshable)`；普通过期、版本未知或 refreshability 未证为 `UNKNOWN(STALE_CERT)`；仅执行期发现则 `Runtime=STALE_REJECTED` | fencing 失败需区分规划与运行期 |
| receipt-loss：COMMIT 后 receipt 丢失 | runtime `IN_DOUBT` + `POSSIBLE_EFFECT_DO_NOT_RETRY` | 不能倒充规划 UNKNOWN 或盲目重试 |
| hidden joint conflict：unary 均允许、`RelCompat=false` | `PLAN_REJECT(joint-relation)` | 有效输入中的确定性坏计划 |
| bypass write：旧 owner 旁路写 sink | hard-safety/refinement failure | CompleteMediation 或 sink fence 失败 |

上述 manifest 和 mutant 目前均为 `planned/unverified`，不能写成现有 Janus runtime 已支持的协议。

## 17. 最小安全语义 manifest 与 mutant oracle（planned/unverified）

为避免把规划、输入有效性、运行时和安全事实压扁成一个状态，Gate A 的 artifact 应至少输出以下 product schema：

```yaml
schema: cp-rir-gate-a/v1
instance: {id, accessRegime: central_full, cutHash, contractHash, dslHash,
           evaluatorHash, gammaHash: null, horizon, eta, kappa, budget, policyClassHash,
           completionMode: singleton_trusted|robust_comp_set,
           attestationTranscriptHash, comp0Digest, comp0Version,
           completionCardinality, nonEmptyProof, actualMembershipMode}
universe: {owners: [{id, epoch, snapshotId}], resources: [{id, version, sinkId}],
           channels: [{id, capacity}], sinks: [{id, mediated, atomicEffectDedupReceipt}]}
cut: {frontier, inFlightDigest, ownerEpochDigest, resourceVersionDigest, hash}
contract: {hardInvariantHash, inputDomainHash, assumptionScopeHash,
  obligationSetHash, registeredObligationHash, evaluatorSemanticsVersion,
  footprintHash, projectionHash, exceptionHash, deadlineHash, attemptHash,
  freshnessHash, idempotenceHash, authorizationHash,
  refinementDirection: implementation_strengthens_specification,
  refinementRuleHash}
actions: [{actionId, owner, tupleRole, typedCapabilityHash,
           opaqueFootprintCommit, idempotencyKeyHash, effectClass, cost}]
owner_attestations: [{ownerId, ownerEpoch, snapshotId, version, cutHash,
  tupleHash, actionSetHash, worldCommitHash, relationScopeHash,
  relationDomainCommit, coverageProof, complete,
  seq, nonce, expiry, payloadHash, signature}]
certificates: {requiredComp0Digest, requiredComp0Version,
  completionLineage: [{parentDigest, childDigest, reason, probeId, revalidatedAllCandidates}],
  safety: [{scopeHash, coverageRoot, proofHash}],
  value: [{kind: EXACT|BOUNDED, policyHash, baselinePolicyHash,
           completionId, factorRoot, openingRoot, proofHash}]}
Gamma_rel: {queries: [{qId, tuple, queryNonce, epochVec, versionVec}],
  replies: [{qId, result: COMPATIBLE|INCOMPATIBLE|UNKNOWN,
    relationWitnessHash, reason, refreshability, scopeHash, seq, nonce, expiry, signature}],
  sideChannelBudget: {timing, length, status, hash, metadata}}
Auth_joint: {formula: "AND_i Auth_i(T_i) AND RelAuth(T)",
  local: [{ownerId, actionId, decision, proofHash}],
  rel: {decision, proofHash}, allPositiveRequired: true, failClosed: true,
  tupleHash, cutHash, epochVec, versionVec}
sink_token: {tokenId, instanceHash, cutHash, contractHash, dslHash, gammaHash,
  worldCommitVecHash, tupleHash, relationProofHash, capabilityProofHash,
  transactionGroupId, sinkSetHash, commitMode, crossSinkProofHash,
  changeSetHash, receiptSchemaHash, nonEquivocationProofHash, issuerSequence,
  epochVec, versionVec, repairId, generation, dedupKey, effectHash,
  nonce, issuedAt, expiry, issuerSet, signatures, oneShot: true,
  atomicCommit: effect+dedup+receipt, sinkIds}
status: {certificateStatus, effectStatus, faultWitness}
```

Gate A 中 `accessRegime=central_full` 是强约束；`gammaHash`、sealed transcript、owner query 和 declassification 字段必须为 `null/forbidden`，不能偷偷改变 D1–D3 的 ground truth。所有 `*Hash` 仅表示完整性/相等性标识，必须带 `purpose=integrity_only` 和 `hidingClaim=none`；普通 digest、签名或 owner-local 计算不构成隐私保证。Gate B 使用另一个版本化 access-diagnostic schema，不得复用本段 schema 伪装成同一问题。

当前随文档提供的 `ubuddy-cp-rir-gate-a-v1.manifest.example.json` 是 `illustrative_v0_draft`：它用于固定字段、reason code 和 gold-case 形状，模型/策略/证明内容仍以占位 hash 表示，不能驱动 exact oracle。只有当外部 reference files、canonical bytes、manifest/corpus/output hashes、A1/A2/A3 版本和唯一可执行命令全部存在时，状态才可升级为 `normative_draft` 或 `executable_locked`。

为避免 artifact 只输出模糊布尔值，三个状态字段至少使用以下封闭枚举（`planned/unverified`）：

```text
certificateStatus =
    NOT_CHECKED
  | VALIDATED_COMP0
  | CERTIFIED_TRUE
  | CERTIFIED_FALSE
  | MISSING
  | INCONSISTENT
  | STALE
  | COVERAGE_INCOMPLETE
  | VALUE_UNVERIFIABLE
  | TCB_UNTRUSTED

effectStatus =
    NOT_RUN
  | PREPARED
  | ABORTED_NO_EFFECT
  | COMMITTED_RECEIPTED
  | COMMITTED_RECEIPT_LOST
  | POSSIBLE_EFFECT
  | EFFECT_CONFIRMED
  | HALF_COMMITTED
  | BYPASS_DETECTED

faultWitness =
    NONE
  | CRASH_WINDOW
  | DROP_DUP_REORDER
  | PARTITION_NO_QUORUM
  | STALE_EPOCH
  | EQUIVOCATION
  | TOCTOU
  | OLD_OWNER_WRITE
  | CROSS_SINK_INCONSISTENCY
  | UNKNOWN_EFFECT
```

映射规则固定为：`MISSING/INCONSISTENT/COVERAGE_INCOMPLETE/VALUE_UNVERIFIABLE/TCB_UNTRUSTED` 属于输入或证书层 `UNKNOWN`；`STALE` 默认也是 `UNKNOWN(STALE_CERT)`，只有附带可验证的“当前 horizon 内无任何 refresh/合法版本且该计划必然无 effect”负 witness 时才例外生成 `PLAN_REJECT(stale-known-unrefreshable)`；`CERTIFIED_FALSE` 只有伴随完整负 witness 时才生成 `PLAN_REJECT`；`COMMITTED_RECEIPT_LOST/POSSIBLE_EFFECT/UNKNOWN_EFFECT` 只能生成运行时 `IN_DOUBT` 与 `POSSIBLE_EFFECT_DO_NOT_RETRY`，不得回写为规划期 `UNKNOWN`；`BYPASS_DETECTED` 或已确认不变量破坏才是 `HARD_VIOLATION`。

状态投影必须保持正交：

```text
InputVerdict     = VALID | UNKNOWN(kind)
CandidateVerdict = PLAN_FEASIBLE | PLAN_REJECT(kind,witness) | UNRESOLVED(kind)
InstanceVerdict  = ACCEPT(policy) | INSTANCE_INFEASIBLE(witnessSet) | UNKNOWN(kind) | TIMEOUT
RuntimeVerdict   = NOT_RUN | ABORTED | STALE_REJECTED | COMMITTED | IN_DOUBT | FINALIZED
SafetyVerdict    = SAFE | HARD_VIOLATION(kind,witness) | HISTORICAL_VIOLATION
```

其中 `INCOMPATIBLE/REFUSE` 在 valid input 中是 `PLAN_REJECT`；证书 omission/equivocation/stale、universe/mediation/TCB 不可检查才是 `UNKNOWN`；COMMIT 后 receipt 不明是 `IN_DOUBT`，公开处置必须是 `POSSIBLE_EFFECT_DO_NOT_RETRY`；已确认 unsafe trace 是 `HARD_VIOLATION`，不得改写成 UNKNOWN。

优先级必须固定：`Γ_rel.result=UNKNOWN`、owner silence、冲突或缺 reason/witness 时，输出 `Input=UNKNOWN(relation-unresolved), Plan=NOT_RUN`；只有 `INCOMPATIBLE` 携带签名、scope/coverage 完整且版本一致的负 witness 时，才输出 `Input=VALID, Plan=PLAN_REJECT`。`COMPATIBLE` 也只证明 relation 分量，仍需其它 FEAS certificate。普通过期优先映射 `UNKNOWN(STALE_CERT)`；只有完整负 witness 证明当前 horizon 内不可刷新且无 effect 的 plan-specific 情况，才允许 `PLAN_REJECT(stale-known-unrefreshable)`。

最小 mutant 集合及 oracle 预期：

| mutant | 预期投影 |
|---|---|
| local refuse / relational incompatible | 若拒绝轨迹仍满足 deadline/obligation/contract，则 `Input=VALID, Plan=PLAN_REJECT, Runtime=NOT_RUN, Safety=SAFE`；若拒绝导致硬义务或 deadline 违例，则以 hard counterexample 优先，`Plan=PLAN_REJECT(hard)` / `Safety=HARD_VIOLATION` |
| omission before commit | `Input=UNKNOWN(certificate-missing), Runtime=NOT_RUN` |
| equivocation before commit | `Input=UNKNOWN(certificate-equivocation)`，fail-closed |
| stale fence | 完整负 witness 证明当前计划不可刷新→`Plan=PLAN_REJECT(stale-known-unrefreshable)`；否则 `Input=UNKNOWN(STALE_CERT)`；执行期 sink 拒绝→`Runtime=STALE_REJECTED`，无 effect |
| stale bypass / hidden effect | `Safety=HARD_VIOLATION(old-epoch/hidden-effect)` |
| receipt loss after atomic commit | `Runtime=IN_DOUBT` + `POSSIBLE_EFFECT_DO_NOT_RETRY` |
| cross-sink half commit | 已破坏不变量→`HARD_VIOLATION(cross-sink)`；effect 未知→`IN_DOUBT` |
| post-horizon not closed | 规划期 `PLAN_REJECT(terminal-closure)`；真实越界→`HARD_VIOLATION` |
| partition without quorum | 已知未越过 commit/无 effect→`Runtime=ABORTED`；若 mediation/TCB 不可检查→`Input=UNKNOWN(TCB)`；effect 是否发生不明→`Runtime=IN_DOUBT` |

该 schema 的目的不是增加一个新的 runtime API，而是让独立 oracle 能区分“候选被证伪”“输入无法证明”“effect 可能已发生”和“已确认违反硬契约”。当前仍为 `planned/unverified`。

## 18. Certificate-sufficiency 定理草案（planned/unverified）

### 18.1 Completion set 的有效性

给定 public manifest `I_pub` 与 transcript `T_Γ`，定义有限、可枚举或以已验证因子表示的 completion set：

```text
Comp_Γ(I_pub,T_Γ)
 = {θ∈Θ(I_pub) | θ satisfies the fact-level bindings,
                    world/state commitments, cut/epoch/version,
                    relation-domain commitment and attestation coverage
                    in the pre-candidate transcript T_attest}
```

`ValidateComp` 必须检查：

1. `Θ(I_pub)` 与 `Comp_Γ` 的 representation/bit width 有限且可由独立 checker 解释；
2. `Comp_Γ≠∅`，禁止用空集上的全称量化制造 vacuous `PLAN_FEASIBLE`；
3. 若声明 actual-world/TCB soundness，则可信 attestation 证明实际 `θ*∈Comp_Γ`；
4. 所有 certificate 绑定同一 instance/cut/contract/DSL/evaluator/Γ/epoch/version；
5. `relationDomainCommit + coverageProof` 覆盖 π 的全部可达 history、action tuple、owner、footprint、authorization、transition/reward 和 sink；
6. contradiction、双签、过期、无 opening 或 mutually inconsistent commitment 返回 `UNKNOWN(CERT_INCONSISTENT|CERT_INVALID)`，不得通过把 `Comp_Γ` 缩成空集或排除实际世界而 ACCEPT。

因此 preflight 必须显式执行 `CheckCompletionSet`: `finite ∧ nonEmpty ∧ transcript-consistent ∧ reachability-closed`；`completionCardinality=0`、digest 不匹配或 `nonEmptyProof` 无法验证时，输出 `Input=UNKNOWN(empty-completion|contradictory-transcript)`、`Plan=NOT_RUN`。`min_{θ∈Comp_Γ}` 与 `∀θ∈Comp_Γ` 在该检查之前都不得求值。

#### 两阶段冻结与证书非循环性（新增约束）

不得让一个候选的 `RelCompat`、`SafetyCert` 或 `ValueCert` 先删除不利 completion，再在删除后的集合上证明自己。否则会出现“证书声明可行 → 证书缩小世界集 → 在缩小集合上验证该声明”的自证循环。规范流程固定为：

```text
Comp0 = Comp(I_pub, T_attest)
M0Digest = H(domainTag || schemaVersion || CanonicalEncode(
               Comp0,T_attest,cutHash,epochVec,versionVec,
               contractHash,dslHash,evaluatorHash,gammaHash))
ValidateComp0(Comp0)                         # 先检查 finite/non-empty/consistency
Freeze(M0Digest)
Verify relation/safety/value certificates against the same M0Digest
```

`Comp0` 只能由 public schema、world/state commitments、cut/epoch/version、经验证的事实 attestation 及其 `coverageProof` 定义；它不能读取候选计划的 value 结论。所有 `RelCompat`、`SafetyCert`、`ValueCert` 必须携带同一 `M0Digest`、`T_attest`、`cutHash` 和版本向量，并被解释为对 `Comp0` 的全称证明或逐世界 opening。`π` 与 baseline `π0` 的 value 证书也必须绑定完全相同的 digest/version，禁止出现 ghost-world。

若后续 Γ 回复确实揭示了新的世界信息，可以产生显式的新公共版本 `T1`、`Comp1` 和 `M1Digest`；但这被视为一次有成本的 probe/branch，必须重新执行 `ValidateComp1`，并对 `π`、`π0` 及所有候选重新验证，不能只为当前候选局部缩集合。任何 `Comp1⊂Comp0` 的收缩都必须由独立 checker 验证 soundness、non-empty、coverage 和（若声明）`θ*∈Comp1`；candidate-specific 证书本身没有修改 completion set 的权限。

建议的独立检查器伪代码如下（`planned/unverified`）：

```text
CheckCompletionSet(I_pub, T_attest):
    if !FiniteRepresentation(Θ(I_pub)):
        return UNKNOWN(CERT_INVALID, "unbounded-world-representation")
    C0 := EnumerateOrFactorizeCompletions(Θ(I_pub), T_attest)
    if C0 == ⌀:
        return UNKNOWN(CERT_INCONSISTENT, "empty-completion")
    if !TranscriptConsistent(T_attest) or !BindingsAgree(T_attest):
        return UNKNOWN(CERT_INCONSISTENT, "contradictory-binding")
    if !ReachabilityClosed(C0, I_pub) or !CoverageProofValid(C0, T_attest):
        return UNKNOWN(COVERAGE_INCOMPLETE)
    if T_attest.claimsActualMembership and !ActualWorldMemberProof(T_attest, C0):
        return UNKNOWN(ACTUAL_MEMBERSHIP_FAILED)
    preimage := CanonicalEncode(C0,T_attest,I_pub.cutHash,I_pub.epochVec,
                                I_pub.versionVec,I_pub.contractHash,
                                I_pub.dslHash,I_pub.evaluatorHash,I_pub.gammaHash)
    return FROZEN(C0, M0Digest=Hash(domainTag || schemaVersion || preimage))
```

`CheckCompletionSet` 必须在任何 `∀θ∈C0` 或 `min_{θ∈C0}` 计算之前运行。`ValueCert`、`RelCompat` 和 `SafetyCert` 只能引用返回的 `M0Digest`；不能反向修改 `C0`。

为阻止“候选级查询间接改世界集”，`T_attest` 必须由 candidate-independent 的 preflight/query schedule 产生：query 顺序、最大轮数、停止条件、timeout、padding、重试次数和失败码在 `policyClassHash` 之外另行固定，并且不得依赖候选的暂时 verdict。若无法预先枚举全部 relation tuple，则必须使用 constant-rate/dummy query，或把查询本身提升为 policy 的显式 probe/branch；此时新 transcript 版本对 `π`、`π0` 及所有候选共同生效，且所有查询、等待、padding、proof generation 和 declassification 成本进入同一 `C(π)`。`T_π`、candidate-order、early-stop、silence、timing、proof length、retry count 不得改变 `Comp0`，schema checker 应拒绝未绑定 `T*` 的候选。

`M0Digest` 不是密码学正确性的替代品。正式 artifact 必须规定 canonical serialization（字段顺序、长度前缀、Unicode/数值编码）、domain separation tag、hash 算法、碰撞/第二原像假设、签名验证和 key/epoch rotation；digest mismatch、canonicalization ambiguity 或未验证的 opening 都返回 `CERT_INVALID/UNKNOWN`，而不是继续求解。

普通 hash 只提供 binding，不提供 hiding。若 `Comp0` 或私有 bit-vector 低熵/可枚举，公开 `M0Digest` 会遭受离线字典攻击；跨实例稳定 digest 还会产生 equality/linkability side channel。若 T5 需要 transcript indistinguishability，必须使用带随机 nonce/salt、域隔离和明确可见性边界的 hiding commitment，或把 digest 仅暴露给可信 verifier；否则必须把 digest 全长计入通信与泄漏，并删除 `opaque/private` 暗示。不得把普通 hash 同时当作隐私封装和信息论隐藏承诺。

定义 `Obs_Γ(T)` 为协调器可见的完整 transcript 投影，包括 payload、refusal、UNKNOWN/status、timing、length、hash、proof size、query count、retry 和 early-stop。策略 history 必须满足二选一：要么这些字段经 padding/coarsening 变为 candidate-independent 且禁止进入 `π`；要么它们显式成为 policy-tree 的 observation/branch，纳入 non-anticipativity、`K_soft`、hard-fault model、baseline `π0`、risk、delay、declassification 和 cost。若 solver 依据未建模的 `Obs_Γ` 选择 repair，则 oracle 必须判定为 hidden-side-channel branch，当前 trial/schema 无效。

### 18.2 正证书充分性

定义：

```text
Verify_Γ(I_pub,T_Γ,π) ∈ {CERTIFIED_TRUE,CERTIFIED_FALSE,UNRESOLVED}
```

`CERTIFIED_TRUE` 只能在以下条件同时成立时返回：

- `ValidateComp` 通过且预先由事实 attestation 冻结的 `Comp0≠∅`；
- 对所有 `θ∈Comp0`，typed action、`Auth_joint/Exec`、relation、transition/effect、contract/refinement、terminal closure 和 worst-cost 因子均由 sound certificate 覆盖；
- `V_θ^soft(π)` 与 `V_θ^soft(π0)` 由可独立重算的 exact factors/value proof 给出，而非只有 owner 签名或 `DPHash`；
- verifier 精确得到 `V_rob^soft=min_{θ∈Comp0}V_θ^soft≥η`、`Δ_rob^soft=min_{θ∈Comp0}(V_θ^soft(π)-V_θ^soft(π0))≥κ`；
- 所有 relation/safety/value 证书绑定同一个预冻结 `Comp0Digest`，且没有证书通过自己的结论修改 `Comp0`；
- T1 的 composition/refinement 与 sink mediation 前提通过。

**附录候选 Γ-Sufficiency**：若所有局部 certificate checker sound，`ValidateComp` 与 factor coverage 通过，且 `Verify_Γ(I_pub,T_Γ,π)=CERTIFIED_TRUE`，则

```text
FEAS_robust(Comp0,π)
```

成立；若另有可信 actual-world membership `θ*∈Comp0`，则得到 `FEAS_full(θ*,π)`。证明路线是先验证 completion-set 构造不依赖候选证书结论，再对 `Comp0` 上每个 θ 应用 factor coverage、T1 composition 与 exact value/cost checker，最后作有限全称合取。当前未机器检查，不能写成已证明。

manifest 必须选择 `completionMode`：

- `robust_comp_set`：预冻结 `Comp0` 非空且可能含多个 completion，使用 `V_Γ^rob=min_{θ∈Comp0}V_θ`、`Δ_Γ^rob=min_{θ∈Comp0}(V_θ(π)-V_θ(π0))`；
- `singleton_trusted`：可信 attestation/TCB 必须同时验证 actual membership、non-equivocation、完整 coverage 和 `Comp0={θ*}`；仅写枚举字段不构成证明。只有此模式允许附录 INDEX toy family 使用 actual-world acceptance gap。

不能在同一 theorem 中一边用 robust completion-set soundness，一边使用未知 actual `x_j` 的 completeness。每个 `ValueCert` 必须绑定同一 θ、π、π0、Auth/Exec/K_soft/U/contract/evaluator/baseline hash；禁止用 `min_θV_θ(π)-min_θV_θ(π0)` 代替 `min_θ[V_θ(π)-V_θ(π0)]`。

### 18.3 Relative completeness 与负证书边界

relative completeness 只在 certificate language 足够表达真实 completion、owner 在线且无 omission/equivocation、所有需要的 exact value/transition/relation factors 可生成时成立。固定计划 completeness 与 synthesis completeness 必须分开：

- plan completeness：`FEAS_robust(Comp0,π)` 且存在完整证书 ⇒ `Verify_Γ=CERTIFIED_TRUE`；
- synthesis completeness：存在可行 `π∈Π` 且枚举/搜索完备 ⇒ `Solve_Γ` 找到某个经 verifier 接受的 π。

`CERTIFIED_FALSE/PLAN_REJECT` 需要覆盖当前 π 的有效负 witness；从所有 π 均失败推出 `INSTANCE_INFEASIBLE`，还需要 policy-class coverage、relation-domain coverage 与每个候选的签名负证书。silence、timeout、未枚举 relation 或缺少正证书只能是 `UNRESOLVED/UNKNOWN`，不能作为 infeasibility witness。

为防止 plan-dependent world filtering，定义 `T*=T_attest`，先冻结同一 cut/commit/epoch 和 common completion set `M*=Comp0(I_pub,T*)`；候选证书另记 `T_cert(π)`，只能证明 `π` 在 `M*` 上的性质，不能修改 `M*`。全部 `π∈Π` 必须在同一 `M*` 上验证；禁止每个计划使用自己的 `T_π/Comp_π` 再比较最优值。若证书只覆盖部分计划或 solver early-stop，不能返回 `INSTANCE_INFEASIBLE`。

candidate-specific `RelCompat/ValueCert` 只能证明某个 `π` 在 `M*` 上的性质，不能删除未覆盖的 θ。若 Γ query 真正提供了会缩小世界集合的新观察，它必须作为 policy 的显式 probe/branch，纳入 filtration、通信、延迟和 cost；不能作为规划器内部免费的 world filtering。该规则与“不按 support 过滤危险世界”完全同构。

更完整的候选定理为：给定 finite `Π`、valid `I_pub`、common frozen `T*`、非空/闭包有效的 `M*`、actual membership（若声明）和覆盖全部 `Π` 的 `CertComplete_Γ`：

1. `Verify_Γ(I_pub,T*,π)=CERTIFIED_TRUE ⇔ FEAS_robust(M*,π)`；
2. `CERTIFIED_FALSE` 仅在有效反证覆盖全部 FEAS 分量时等价于不可行；否则返回 `UNRESOLVED`；
3. solver 终止时，`ACCEPT(π*)` 当且仅当 `π*` 是同一 `M*` 上的 minimum-cost feasible policy；
4. `INSTANCE_INFEASIBLE` 当且仅当每个 `π∈Π` 都有完整负证书；
5. transcript/TCB/coverage 不完整返回 `UNKNOWN`，资源耗尽返回 `TIMEOUT`。

### 18.4 新增 oracle mutants

| mutant | 必须输出 |
|---|---|
| contradictory commitments 令 `Comp_Γ=∅` | `UNKNOWN(CERT_INCONSISTENT)`，不得 vacuous ACCEPT |
| certificate 排除可信 actual `θ*` | `UNKNOWN(ACTUAL_MEMBERSHIP_FAILED/TCB_INVALID)` |
| relation scope 未覆盖某一可达 tuple | `UNRESOLVED/UNKNOWN(COVERAGE_INCOMPLETE)` |
| 仅有 `DPHash`/签名，无 exact value opening | `UNKNOWN(VALUE_CERT_UNVERIFIABLE)` |
| valid negative relation witness | `CERTIFIED_FALSE → PLAN_REJECT(joint-relation/value)` |
| silence/timeout 被错误当负证书 | oracle 必标 verifier unsound |

本定理草案只规定证书充分性，不产生隐私保证，也不证明当前 Janus 已实现该 checker。

### 18.5 Value/Δ 证书的最小数学条件

对非空 completion set `C`，canonical 定义为

```text
V_C(π) = min_{θ∈C} V_θ^soft(π)
Δ_C(π) = min_{θ∈C} [V_θ^soft(π) - V_θ^soft(π0)]
```

若证书只提供 bounds，而非 exact value，则证明 `Δ_C(π)≥κ` 至少需要对每个 θ 给出
`LB_θ(π)-UB_θ(π0)≥κ`；不能用两个 lower bound 相减，也不能用 `min V_θ(π)-min V_θ(π0)` 替代。`ValueCert` 必须绑定 `{completion/worldCommit,cutHash,πHash,π0Hash,AuthHash,KsoftHash,U/evaluatorHash,H,retryRule,Vπ,Vπ0,Δ,DPHash,scope/coverage}`，且 `π0` 在每个 θ 上 total 并使用同一 conditional authorization/kernel。

`Verify_Γ` 的三值结果固定为：

```text
CERTIFIED_TRUE  : CheckCompletionSet 已通过，全部 completion 的 safe/exec/value/Δ/cost 证书均充分
CERTIFIED_FALSE : CheckCompletionSet 已通过，存在有效 θ 反例或有效负证书
UNRESOLVED      : 输入有效，但 coverage 缺失、证书不可验证或信息不足
```

`C=∅`、矛盾 transcript、digest/canonicalization 不一致必须在任何候选验证之前映射为 `Input=UNKNOWN(...)`、`Plan=NOT_RUN`，不属于候选级 `UNRESOLVED`。只有前两种分别映射为 `PLAN_FEASIBLE` 与 `PLAN_REJECT`；候选级 `UNRESOLVED` 按第 4.1 节的 feasibility/optimality 分层规则传播。语义上确实不可行但 verifier 没有有效反证时，不能伪造 `PLAN_REJECT`。

### 18.6 Exact 与 bounded `ValueCert` 形式（planned/unverified）

Exact 形式要求 independent checker 能从公开或 attested factor opening 重算每个 completion 的值，而不是信任 owner 自报：

```text
ExactValueCert = {
  instanceHash, M0Digest, completionId,
  cutHash, epochVec, versionVec,
  policyHash, baselinePolicyHash,
  authExecHash, transitionFactorRoot, rewardFactorRoot,
  evaluatorHash, horizon, retryRuleHash,
  exactRationalVPolicy, exactRationalVBaseline,
  exactRationalDelta, dpTableRoot,
  reachableHistoryCoverageRoot, signatureSet
}
```

checker 必须验证 `exactRationalDelta = exactRationalVPolicy - exactRationalVBaseline`，并从同一 `M0Digest`、同一 conditional `Auth/Exec/K_soft` 和同一 evaluator 重算三者。`dpTableRoot` 只用于定位 opening；hash 相等本身不证明算术正确。

Bounded 形式允许只给 interval，但必须使用成对保守界：

```text
BoundedValueCert = {
  ...same bindings...,
  LB_policy, UB_policy,
  LB_baseline, UB_baseline,
  boundMethod, numericPrecision, roundingMode,
  factorErrorBudget, coverageRoot, proofOpenings
}
```

证明 `V_C(π)≥η` 需要对每个 `θ∈C` 验证 `LB_θ(π)≥η`；证明 `Δ_C(π)≥κ` 需要逐世界验证 `LB_θ(π)-UB_θ(π0)≥κ`。若任何 completion 缺 opening、数值舍入方向不安全、`π/π0` digest 不同或 coverage root 不覆盖全部可达 history，返回 `UNRESOLVED(VALUE_CERT_UNVERIFIABLE)`，不能用平均界或两个 lower bound 相减替代。

### 18.7 `coverageProof` 的可检查条件（planned/unverified）

`coverageProof` 不是一个布尔字段；它至少提交并允许独立 checker 验证以下域的有限承诺：

```text
ownerUniverse × resourceUniverse × channelUniverse × sinkUniverse
reachableHistory(C0,Π,H,B_f)
actionTuple × footprint × authorizationOutcome
transitionFactor × rewardFactor × terminalClosure
cut × epoch × version × retry/timeout rule
```

对每个可达 history，checker 必须能在 domain commitment 中找到唯一且版本一致的 factor/opening，或得到显式 signed negative witness。缺项是 `COVERAGE_INCOMPLETE`，重复且冲突的项是 `CERT_INCONSISTENT`，过期项是 `STALE`；都不得解释为负 relation 或自动 `PLAN_REJECT`。声明 `complete=true` 只有在 universe commitment、policy-class hash、horizon/fault bound 和全部 domain roots 一致时有效。

## 19. 统一 access-regime 差分实验 schema（设计稿，不运行）

### 19.1 决策问题与假设

实验问题分成两个不混淆的层次：在固定同一 observation/filtration 时，接口是否只改变可证明性、通信和拒答，而不改变 ground-truth `FEAS_robust(Comp0,π)`；当 `POST_J_REL` 允许新增观察并进入 policy 时，新增信息是否改变的是 policy class/决策质量，而不是被误报成 certificate-only 优势？

预注册假设：

- H1：在 **observation-matched** 子实验（relation opening 作为不可进入决策的证书，或四臂共享同一显式 probe/branch）中，`central-full` 与拥有完备 certificate language 的 `relational-Γ` 在 plan/instance semantics 上与独立 oracle 一致；
- H2：受限 `unary-Γ` 在 relationally indistinguishable 实例上出现 completeness loss 或通信爆炸，但不能以 unsafe ACCEPT 换取覆盖率；
- H3：在 **same-filtration** 子实验中，`same-Γ Complete-Contingent` 与 CP-RIR 使用完全相同的 Γ、policy grammar 和 verifier 时，应能表达同一 feasible policy class；在 **adaptive-information** 子实验中，必须单独报告 `POST_J_REL` 带来的 policy-class/信息增益，不能把它归因于证书格式；
- H4：empty completion、candidate-specific filtering、wrong value opening、stale/equivocation 和 receipt-loss mutants 会被分层 oracle 正确区分。

### 19.2 四个对照臂与固定条件

| 对照臂 | 可见信息 | 允许查询 | 必须固定 |
|---|---|---|---|
| central-full | 完整冻结 `Comp0` 与全部 factors | 无 sealed query | 同一 `Π/H/B_f/C_hard/U/η/κ/k` |
| unary-Γ | public manifest + pre-cut action-local unary transcript | 禁止 post-index owner 回查 | 同一 `Comp0` ground truth、同一 candidate order |
| relational-Γ | public manifest + `POST_J_REL` relation/value openings | 按 manifest 计 query/bytes/rounds | 同一 policy grammar 与 verifier obligations |
| same-Γ Complete-Contingent | 与 relational-Γ 完全相同的接口和证书 | 完全相同 | 同一 search budget、tie-break、timeout 与硬件 |

不得给 CP-RIR 更强 Γ、额外 world hint、不同 action library 或更宽 policy tree。central-full 只作为语义 oracle/上界对照，不能与 sealed 模式直接比较隐私。实验应采用至少一个 2×2 因子：`observation={pre/post-j}` × `declassification={certificate-only/decision-visible}`；必要时再交叉 `access={central/sealed}`。这样才能把信息集变化与证书充分性分离。

### 19.3 实例、变量和指标

实例族采用同一生成器产生至少以下 strata：single relation bit、multi-world contingent branch、negative relation、value-gap、empty/extra/missing completion、coverage omission、stale/equivocation、cross-sink receipt mutant。正式样本量在预注册时由可枚举 grammar 决定；在最小 artifact 中先穷举所有有限微实例，不报告伪造的经验结果。

独立变量：access regime、relation arity、world count、factor treewidth、policy depth、certificate completeness、fault mutant。固定变量：ground-truth instance、`Comp0Digest`、contract/evaluator/action/cost hash、random seed、solver budget和硬件。

主要指标：

1. plan-level `CERTIFIED_TRUE/FALSE/UNRESOLVED` confusion matrix；
2. instance-level `ACCEPT/INSTANCE_INFEASIBLE/UNKNOWN/TIMEOUT` confusion matrix；
3. unsafe false accept（主安全指标，目标为 0）、false reject、unknown coverage；
4. OPT cost gap 与 policy equality/semantic equivalence；
5. total bytes、queries、rounds、certificate bytes、owner 端生成/预计算、padding、验证、搜索、失败重试和 declassification/延迟成本；
6. transcript leakage：在声明的 observation model 下报告 `I(Θ;T)` 或 TV/adversary success；若不提供正式隐私界，只报告泄漏测量，不使用“privacy-preserving”措辞；
7. mutant classification accuracy：certificate、effect、fault witness 三个正交维度。

### 19.4 判定规则

- 若 same-Γ Complete-Contingent 找到 CP-RIR 找不到的可行策略，说明 CP-RIR solver/grammar 不完整，不能归因于接口创新；
- 若两者策略语义相同但 CP-RIR 更快或证书更小，只能声称 specialization/efficiency，并需统计置信区间与消融；
- 若 unary-Γ 通过 `UNKNOWN` 避免错误，计 completeness loss，不计安全成功；若 unsafe ACCEPT，直接判 soundness failure；
- 若任一臂使用不同 completion set 或 candidate-specific world filtering，该 trial 无效并由 schema checker 拒绝；
- 本节仅设计实验，没有运行、没有结果，也没有修改当前实验实现。

## 20. 第十二轮 artifact release gate（planned/unverified）

本轮将原先混在一起的“正确性闭环”和“隐藏接口新颖性”拆成两个嵌套 gate。两者共享研究材料，但不能互相替代。

### Gate A：D1–D3 finite closed-world correctness

Gate A 只回答：在固定、非空、候选无关的 `Comp0`、有限 `Π`、固定 `π0`、合同/执行语义和故障界内，`FEAS`、bounded safety transfer 与有限求解器是否正确。最小 artifact 必须由三个物理或进程级独立组件组成：

1. `A1 ReferenceSemantics`：独立 parser、`CheckCompletionSet`、concrete finite-state explorer 和 exhaustive exact-rational oracle；从原始 manifest 重算 `FEAS_full/FEAS_robust`、`V_m`、`Δ_m`、cost 和反例。
2. `A2 TransferChecker`：被测 abstract checker，独立验证 abstract product 的 `SAFE`、effect-complete/safety-reflecting simulation、CompleteMediation、sink token/receipt 和 terminal closure；不得把 A1 的 verdict 或 concrete trace 当作证书。
3. `A3 Solver`：被测有限策略搜索器；与 A1 共享的只能是冻结 schema、test vectors 和输入 manifest，不得共享 transition/effect evaluator、contract parser、canonicalizer、verdict reducer 或随机 replay 实现。

Gate A 的 machine-readable manifest 必须冻结：`schemaVersion`、实例集合及 `manifestHash`、`Comp0/M0Digest`、`Π/policyClassHash`、`C_hard/Inv/U/evaluatorHash`、`π0`、`H/B_f/η/κ/k`、fault automaton、token/receipt schema、candidate canonicalizer、tie-break、seed、solver/verifier 版本、资源预算和硬件。唯一复现入口、输出 schema 和 expected hash 必须随 artifact 发布。

Gate A 硬通过条件：

- 所有有限有效微实例上，A3 与 A1 的 plan/instance verdict、exact rational `V/Δ` 和 `OPT` 完全一致；
- D2 的 concrete/abstract transfer 对 hidden effect、old epoch/generation、TOCTOU、cross-sink half-commit、post-horizon time bomb、receipt loss 等 mutant 的 unsafe false accept 为 0；
- `Comp0=∅`、矛盾 transcript、candidate-specific filtering、错误 ValueCert、baseline monotonicity、authorization collider、stale/equivocation 均按分层 verdict 处理；
- `INSTANCE_INFEASIBLE` 只有在全部 `π∈Π` 具备完整负证书时出现；必须区分 `FEASIBLE_NOT_PROVEN_OPTIMAL` 与 `OPTIMAL_WITHIN_Π`；
- world permutation、unreachable insertion、合法扩大 `Comp0`、dominated action、预算/阈值单调性和 policy alpha-renaming 的 metamorphic gates 全部通过；
- 至少存在一个非平凡安全可行实例，防止 reject-all 或永远 UNKNOWN 的伪通过；所有输出可由固定命令和冻结 hash 重现。

Gate A 未通过时，不得在论文中写“D1–D3 已证明”“已具备跨组织安全修复”或 `Strong-Accept-capable`。

### Gate B：Γ/access/T5 diagnostic（可选附录 gate）

Gate B 单独回答：sealed-owner 接口在何种 observation/filtration 下改变的是证书可证明性、通信成本或 policy class。它必须使用与 Gate A 相同的 `Comp0`、`Π`、verifier、token schema、fault/cost budget 和 canonicalizer，并增加完整 `Obs_C`/filtration、timing/length/status/padding/retry/declassification accountant。至少比较 `central-full`、`unary-Γ`、`relational-Γ` 和同 Γ 的 `Complete-Contingent`；先做 observation-matched，再做 adaptive-information。

Gate B 通过并不补足 Gate A；Gate B 失败只删除 T5/INDEX、privacy 或 communication-separation 主张，不否定 Gate A 的 finite specialization。若 same-Γ Complete-Contingent 找到 CP-RIR 找不到的可行策略，结论是 CP-RIR grammar/solver 不完整；若策略相同而仅速度或证书大小不同，只能声称 specialization/efficiency。没有正式归约、matching upper bound 和全成本 artifact 时，T5/INDEX 只能保留为接口必要性研究议程。

### 20.1 状态传播和失败策略

输入层 invalid（空 completion、矛盾、digest 不一致）在候选枚举前终止；候选层 `UNRESOLVED` 不得生成负证书。sealed 模式若已有可行候选但更低成本候选 unresolved，输出 `ACCEPT` 与 `FEASIBLE_NOT_PROVEN_OPTIMAL`；若无已证可行候选则输出实例级 `UNKNOWN`。`TIMEOUT`、silence、omission、TCB 不可信和 receipt loss 均不能充当 `INSTANCE_INFEASIBLE` witness。该传播表必须由 A1 独立 oracle 和 locked mutant corpus 逐项检查。

Gate A 与 Gate B 不共享同一个结果对象。Gate A 使用 privacy-neutral 的 `CorrectnessTrialResult`；Gate B 另用 `AccessDiagnosticResult` 记录观察、通信和泄漏测量。这样不会把 Gate A 的正确性证据误读为隐私证据。

Gate A 的 `CorrectnessTrialResult` 至少包含：

```text
TrialResult = {
  inputVerdict,
  candidateVerdict,
  instanceVerdict,
  optimalityVerdict,
  runtimeVerdict,
  safetyVerdict,
  policyHash, witnessHash,
  exactWorldValues, exactWorldDeltas,
  robustValue, robustDelta, worstCost,
  comp0Digest, manifestHash,
  bytes, queries, rounds, proofGenerationTime, verificationTime, searchTime
}
```

Gate B 的 `AccessDiagnosticResult` 至少包含 `observerModelHash`、`filtrationHash`、`declassificationPolicyHash`、`wireBytes`、`payloadBytes`、`certificateBytes`、`logicalQueries`、`transportRequests`、`onlineRounds`、`offlineRounds`、`timingBins`、`lengthBins`、`grossLeakage`、`residualLeakage`、`pairwiseTV`、`dictionaryRecovery` 和 `linkabilityAdvantage`。这些字段只表示测量结果；没有 secret adjacency、组合规则和机制证明时，不得转换成 `(ε,δ)` 或 privacy theorem。Gate A 中的所有 digest/hash 继续标注 `purpose=integrity_only, hidingClaim=none`。

Gate A 的 `exactWorldOracle` 不能只保存聚合值；每个候选必须保存逐世界记录：

```text
exactWorldOracle[m] = {
  worldId, worldCommitHash, policyHash, baselinePolicyHash,
  policyValue: {num, den}, baselineValue: {num, den},
  delta: {num, den},
  hardSafetyVerdict, executabilityVerdict, refinementVerdict,
  worstCost: {num, den}, rejectionComponents[], arithmeticWitnessHash
}
baselineBinding = {
  baselinePolicyHash, cutHash, horizon, authExecHash,
  transitionKernelHash, nominalKernelHash, rewardEvaluatorHash,
  retryTimeoutHash, contractHash, completionSetDigest
}
```

输入 preflight 未通过时，这些字段必须为 `null/NOT_EVALUATED`，不能使用空数组或零值伪装为已计算结果。聚合必须同时保存 `robustPolicyValue=min_m policyValue[m]`、诊断用 `robustBaselineValue=min_m baselineValue[m]` 和唯一门槛量 `robustDelta=min_m delta[m]`；严禁从前两个聚合值相减生成 `robustDelta`。成本最优还要检查同成本但 tie-break 更优的候选，不得只检查严格更低成本候选。

### 20.2 Locked manual gold corpus v0

在生成式穷举 corpus 之前，先固定以下人工金标；实现不得依据测试 ID 写特殊分支。每个 case 必须由 A1 直接从 manifest 重算，并由 A2/A3 给出独立结果。

| ID | 变体 | 必须结果 |
|---|---|---|
| G00 | 非空单世界、唯一安全且 `V/Δ/cost` 达标计划 | `VALID → PLAN_FEASIBLE → ACCEPT + OPTIMAL_WITHIN_Π`，证明不是 reject-all |
| G01 | `Comp0=∅` | `Input=UNKNOWN(empty-completion), Plan=NOT_RUN` |
| G02 | 两份 attestation 矛盾 | `Input=UNKNOWN(CERT_INCONSISTENT), Plan=NOT_RUN` |
| G03 | candidate certificate 删除坏世界 | `UNKNOWN(CERT_INVALID/ghost-world)`，不得 ACCEPT |
| G04 | `Vπ=(0.8,0.9), Vπ0=(0.7,0.1), κ=0.5` | 正确 `Δrob=0.1`，`PLAN_REJECT(delta)`；错误 `min-min=0.7` 必被抓获 |
| G05 | self-baseline sanity：同一 C0002 kernel 中 `π0′=π=repair` | `Δrob′=0≤0.1`；仅作配对绑定/算术 sanity，不支持一般 monotonicity theorem |
| G06 | exact authorization collider，动作无增益 | `Δ=0`，`PLAN_REJECT(delta)` |
| G07 | learned/opaque authorization 且无 positivity/support | `UNKNOWN(authorization-nonpositivity)`，不得用 authorized-only success ACCEPT |
| G08 | ValueCert 仅有签名/DPHash 或错误 rounding/opening | `UNRESOLVED(VALUE_CERT_UNVERIFIABLE)` |
| G09 | stale token，是否可刷新未知 | planning `UNKNOWN(STALE_CERT)`；sink 拒绝时 runtime `STALE_REJECTED` |
| G10 | owner equivocation/double-sign | `UNKNOWN(CERT_EQUIVOCATION)`；若 unsafe effect 已发生则另报 `HARD_VIOLATION` |
| G11 | effect 已 commit、receipt 丢失 | `Runtime=IN_DOUBT` + `POSSIBLE_EFFECT_DO_NOT_RETRY` |
| G12 | cross-sink half commit | `HARD_VIOLATION(CROSS_SINK_INCONSISTENCY)`；状态不全时并列 `IN_DOUBT` |
| G13 | hidden/bypass effect | `HARD_VIOLATION(HIDDEN_EFFECT/BYPASS_DETECTED)` |
| G14 | prepare 后版本变化（TOCTOU） | 正确 sink `ABORTED/STALE_REJECTED` 且无 effect；若写入则 `HARD_VIOLATION` |
| G15 | old owner 或 old generation token redeem | `HARD_VIOLATION(OLD_OWNER_WRITE)`；正确 fence 必拒绝 |
| G16 | post-`H` time bomb / terminal closure 缺失 | 规划可见时 `PLAN_REJECT(terminal-closure)`；实际发生时 `HARD_VIOLATION` |
| G17 | 已证可行计划，但更低成本候选 `UNRESOLVED` | `ACCEPT + FEASIBLE_NOT_PROVEN_OPTIMAL`，不得伪称最优 |
| G18 | 全部有限候选都有完整负 witness | `INSTANCE_INFEASIBLE`；任一 UNKNOWN/TIMEOUT 均使该 witness 不完整 |

G04 与 G06 同时用于阻止因果过度表述：它们只验证 model-relative policy-regime contrast 和授权选择边界，不证明 current-instance root cause。G11–G16 验证的是 bounded safety 与 forward recovery；不得把 compensation/remediation 写成反事实 rollback 或 exactly-once/liveness。

### 20.2.1 Gold case scope split

`cp-rir-gate-a/v1` 只把 `central_full`、finite closed-world、可由 A1 重算的 case 作为 Gate A correctness corpus。G07（learned/open-world authorization non-positivity）、G17（sealed 下最优性未证）以及任何需要 `POST_J_REL`、declassification 或 query filtration 的 case 只能进入 Gate B diagnostic corpus，不能作为 Gate A 的 D1–D3 通过条件。G03 在 Gate A 中是 schema/artifact invalid（candidate-specific world filtering），而不是一个正常的 sealed candidate `UNRESOLVED`。运行时 fault case（G11–G16）只有在规划前证书已完整且 fault 注入发生于 commit/recovery 阶段时，才保留原 planning verdict 并写入 Runtime/Safety 轴；若在 preflight 发现 mediation/token/closure 证据缺失，则应先返回 Input `UNKNOWN`、Candidate `NOT_RUN/UNRESOLVED`。

### 20.3 三个人工金标的 reference derivation v1

**G01 empty completion**：`CheckCompletionSet` 得到 `cardinality=0` 后，必须在任何 `min`、全称量化、policy enumeration 或 baseline product 之前终止。canonical reason code 固定为 `EMPTY_COMPLETION`；`CERT_INCONSISTENT` 只用于非空但相互矛盾的 commitments。期望输出为：

```text
Input=UNKNOWN(EMPTY_COMPLETION)
Candidate=NOT_RUN
Instance=UNKNOWN(EMPTY_COMPLETION)
Optimality=NOT_APPLICABLE
Runtime=NOT_RUN
Safety=NOT_EVALUATED
exactWorldOracle=null
robustPolicyValue=null
robustBaselineValue=null
robustDelta=null
worstCost=null
```

任何 `PLAN_REJECT`、`INSTANCE_INFEASIBLE`、`ACCEPT`、空集合全称真或 OPT 输出都使 artifact invalid。

**G04 min-of-differences**：设其他 FEAS 分量全部通过、`η≤4/5`、`κ=1/2`：

| world | `V_m(π)` | `V_m(π0)` | `Δ_m` |
|---|---:|---:|---:|
| `m1` | `4/5` | `7/10` | `1/10` |
| `m2` | `9/10` | `1/10` | `4/5` |

因此 `robustPolicyValue=4/5`、诊断用 `robustBaselineValue=1/10`、唯一合法 `robustDelta=min(1/10,4/5)=1/10`，并以 `m1` 为 delta witness 返回 `PLAN_REJECT(delta)`。若实现得到 `4/5-1/10=7/10` 并接受，判 oracle/solver invalid。

**G06 authorization collider**：单世界 nominal kernel 内 `H∈{0,1}` 且各概率 `1/2`；自然/no-op utility 为 `U=H`。候选恒提出动作，授权 `Auth=H`：`H=1` 执行且 `U=1`，`H=0` 拒绝且 `U=0`。`π` 与 `π0` 共享同一 horizon、kernel、authorization 与 evaluator；设 `η≤1/2`、`κ=1/10`，其余 FEAS 分量通过。exact oracle 得 `V(π)=1/2`、`V(π0)=1/2`、`Δ=0`，故 `PLAN_REJECT(delta)`。只保留已授权轨迹会得到条件成功率 1，但该数值不是 policy-regime value。

### 20.4 新增 P0 schema/metamorphic mutants

- candidate-dependent baseline、baseline hash/cut/evaluator swap：输入或证书 binding invalid，不得计算 repair gain；
- authorized-only filtering：exact oracle 必须保留拒绝轨迹；
- evaluator drift：`π/π0` evaluator 不同则不可比较；
- branchwise world switching：world 在 `t=0` 固定并贯穿整棵 policy tree；
- soft/hard kernel contamination：只改变 fault automaton时，nominal `V/Δ` 不得变化；
- equal-cost、tie-break 更优候选 `UNRESOLVED`：不得声称最终 tie-break 已证明；
- contract-evasion mutant：缩小输入域、删除 obligation/deadline/freshness/idempotence/auth 或更换 evaluator 即使提高成功率也必须 refinement fail；
- digest dictionary/linkability mutant：只影响 Gate B privacy claim，不得改变 Gate A FEAS；所有 hash 明确为 integrity-only。

## 21. Legacy OCCC 文档与 CP-RIR D1–D3 的映射（planned/unverified）

目录中的 `ubuddy-code-change-plan-v4.zh-CN.md` 与 `ubuddy-experiment-plan-v4.zh-CN.md` 仍沿用 OCCC/T0–T5（lineage、token conservation、GlobalEffectCompat、conditional progress）术语；它们不是当前 CP-RIR Gate A 的实现计划，也不能直接作为 D1–D3 证据。为避免编号漂移，暂定以下只读映射：

| legacy OCCC 对象 | CP-RIR Gate A 对应 | 处理 |
|---|---|---|
| OCCC T0 trace-only impossibility | CP-RIR A1 motivating counterexample / Gate B access diagnostic | 不计正文定理 |
| OCCC T1 lineage preservation | D2 abstract/concrete effect-complete refinement obligation | 需重新给 typed LTS 和独立 checker |
| OCCC T2 full-state→certificate simulation | D2 safety-reflecting transfer | 只有 machine-checked transfer 后才可复用 |
| OCCC T3 consistent-cut + GlobalEffectCompat | D2 CompleteCut/CompleteMediation/CrossSinkInvariant TCB | 不单列创新 |
| OCCC T4 conditional progress | CP-RIR 非目标（无 liveness/exactly-once） | 从正文移除 |
| OCCC T5 observation projection | Gate B/T5 附录接口议程 | 摘要级 NO-GO |
| OCCC full/certificate experiment | A1/A2/A3 differential artifact | 需重写输入、verdict、`V/Δ/OPT` 和 locked mutants |

在该映射正式落地前，旧 OCCC 计划应在论文材料中标记 `legacy/superseded-for-CP-RIR`；本轮不修改这两份用户已有文档，以避免越权改写实验计划。当前唯一规范编号仍为 D1–D3（Gate A）与 Gate B diagnostic，不把同名 T1–T5 交叉引用为同一理论。

## 22. 第十五轮：答案隔离与运行时双/三层 gold（planned/unverified）

本轮依据独立复杂度、分布式安全和顶会审稿复核，补齐 artifact 设计中的两个 P0 边界。它们提高可审计性，但不构成新算法或已实现能力。

### 22.1 原始输入与 expected corpus 必须隔离

`ubuddy-cp-rir-gate-a-v1.manifest.example.json` 继续只是接口草案。真正的 runner 必须把输入拆为：

```text
instanceManifest = finite transition/auth/effect/reward/policy grammar + contract + fault model
lockedExpectedCorpus = expected verdict + negative witnesses + metamorphic oracle
```

`A1/A2/A3` 只能读取 `instanceManifest` 及其内容哈希，不能读取 `lockedExpectedCorpus`。runner 在三个独立输出封存后，才按 `lockedCorpusHash` 做比较。G04 的逐世界 `V/Δ`、G05 的 baseline 变体和 G06 的 collider kernel 都必须从 transition/auth/reward payload 重算；expected 数值不能作为 override 输入。若输入和 expected 仍在同一可读对象中，Gate A 只能标记 `SPEC_ONLY`，不能计入 soundness/completeness 证据。

### 22.2 三层 mutation 语义

G11–G16 不再用一个 case 同时表达多种事实，而在 [runtime gold draft](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-gate-a-v1.runtime-gold.example.json) 中拆成：

1. `PREFLIGHT`：缺少 cut/token/receipt/mediation/closure 证据；结果是 artifact/input `UNKNOWN`，candidate `NOT_RUN`，不运行规划。
2. `CONCRETE_MODEL`：故障已写入冻结的 finite fault automaton；A2 应在规划期发现反例并返回 `PLAN_REJECT` 或 `d2TransferVerdict=COUNTEREXAMPLE_FOUND`。
3. `DEPLOYED_RUNTIME`：模型原本排除该行为，但真实 sink 发生 half-commit、bypass、stale write 或旧 generation 写入；规划轴继承 base output，运行时轴报告 `IN_DOUBT`/`HARD_VIOLATION`，并将 `implementationConformance=FAILED`。这不是把 D2 定理“证伪”，而是说明 TCB 前提在部署中被破坏。

每个 runtime variant 至少绑定 `baseManifestHash`、`basePlanningOutputHash`、`mutationLayer`、`mutationStage`、规范化 `inputPatch/faultTrace`、`effectState`、`receiptState`、`sinkEvents` 和结构化 expected axes。receipt loss 不能自动推出 `SAFE`；只有独立 effect/safety witness 才能给出安全结论。old owner epoch 与 old repair generation 是两个不同 fencing obligation，必须分别测试。

### 22.3 结构化 verdict 的实现边界

最终 reducer 预期分成三个对象：

```text
ArtifactVerdict   = {status, reasonCode, witnessRef}
PlanningVerdict   = {input, candidateResults[], enumerationCoverage,
                     selectedCandidateId, instance, optimality}
ExecutionVerdict  = {runtime, planningSafety, runtimeTraceSafety,
                     effectKnowledge, publicDisposition}
```

其中 `candidateResults[]`、`enumerationCoverage`、`negativeWitnessSet` 和 `unresolvedSet` 是 `INSTANCE_INFEASIBLE` 与 `OPTIMAL_WITHIN_Π` 的必要证据；不能让 gold 只填写一个 candidate status 后由 reducer 猜出实例结论。当前 schema 已将单轴 expected 统一为 `{status,reasonCode,witnessRef}` 草案，但尚未强制上述完整 reducer，也未实现独立 A1/A2/A3；因此仍为 `planned/unverified`。

### 22.4 复杂度文字最终收窄

正文只保留：受限 factored deterministic static-subset `CP-RIR-SYNTH` 的 weighted-set-cover NP-complete 归约；以及在完整联合 decision/world/contract/executability/non-anticipativity 因子图显式给出 treewidth `w`、最大非世界域 `D`、世界数 `K`、时域 `H`、联合图 extensional factor 数 `N`、概率/成本/阈值 bit-width `b` 时的 bounded-treewidth exact synthesis/evaluation 候选复杂度 `O(K·N·D^{w+1}·poly(H,b,L))`。共享的 non-anticipative decision 必须在同一联合求解中保留；逐 world 独立优化只可用于固定 policy evaluation。若把 world 作为联合变量，则改用 `D'=max(D,K)` 的联合图口径，不再额外乘 `K`。`L` 包含 policy grammar/memory、factor encoding 与 rational bit-growth。没有这些编码参数、共享决策证明或正式结果时，结论标记 `unverified`，不宣称一般 succinct synthesis 属于 NP，也不宣称该 DP 本身具有新颖性。

本轮没有修改 Janus/uBuddy 源代码、API、数据库 schema、运行时协议或已有实验实现。

## 26. 第十八轮：D2 transfer 结构 gate 与 G05 固定 kernel 修正（planned/unverified）

本轮只在冻结的研究 artifact 层补充证据接口，不改变当前技术基线。新增/收紧的 D2 input 结构包括：

1. 顶层 `$schema` 与 input-only purpose；Ajv 2020-12 可编译并通过示例 fixture。字符串扫描不再把 purpose 中的 `NO_EXPECTED_OUTPUT` 误判为答案字段，答案隔离检查只检查对象键和可达引用。
2. `resource→organization→owner→authoritativeSink` 绑定、`actionFootprintHash`、sink ACL 引用、epoch/generation 高水位及每 sink 的 ACL、线性化点、effect+dedup+receipt witness 引用。它们仍是引用接口，不能把占位 ref 当成真实 ACL、attestation 或原子提交证明。
3. concrete/abstract LTS 的 `modelKind`、事件类别、冻结 fault automaton、每 trial 的 `traceModelRelation`、trace commitment、sealed-base binding、concrete trace、abstract trace 与 alpha projection ref。该结构可以让 checker 拒绝“没有声明轨迹层/没有 projection ref”的输入，但不能仅凭字符串 ref 证明 safety reflection、effect completeness 或 trace membership；这些仍需独立 witness checker。

本轮 D2 fixture 的只读检查结果为：JSON parse 通过、Ajv fixture 通过、禁止答案键集合为空、组织数 2、resource binding 数 2、sink evidence 数 2、trial 数 3；一个轻量 relational lint 还检查了 resource/sink/owner/epoch/generation 对齐、LTS 状态/事件闭包及 T001 的 concrete→abstract 投影。`completeMediationClaim=false`、所有 attestation/ref/commitment 为 draft 占位，因此结果只能记为 `SPEC_STRUCTURALLY_VALID`，不能记为 `D2_SOUND`。

### 26.1 G05：从“改 kernel”改为“同一 kernel 换 baseline policy”

此前 G05 的 `B0001` 同时更换了 `noop` 的转移概率并声称 nominal kernel unchanged，无法测试 baseline monotonicity。本轮将其明确为 C0002 的 paired input：

```text
M/Auth/Exec/U/nominal transitions/evaluator 固定；
π0      = noop       ⇒ Δ  = min(0.8−0.7, 0.9−0.1) = 1/10；
π0′     = repair     ⇒ Δ′ = min(0.8−0.8, 0.9−0.9) = 0；
```

因此 `Δ′≤Δ` 是同一完整 finite kernel 上仅替换已登记 baseline policy 的可重算关系。`finiteKernelRef` 使用标准数组 JSON Pointer `#/cases/1`，不再使用按 id 解析的非法 `#/cases/C0002`。由于 `π0′=π`，G05 只能作为 `SELF_BASELINE_SANITY`，不是一般 baseline-monotonicity 证据；当前 locked expected corpus、baseline variant 和跨对象算术/alias 绑定尚无独立 reducer，状态保持 `planned/unverified`。

### 26.2 本轮未关闭的 D2 P0

- JSON Schema 仍不能表达 owner/resource/sink 的集合相等、所有 trace edge 的可达性、`Safe(ατ)⇒Safe(τ)`、receipt 内容/hash 匹配、线性化原子性或部署 runtime 与 modelled fault 的语义分离；需要独立 A2 checker/property tests。
- runtime-input 仍没有独立正式 schema、materialization/hash 规范和 machine-readable `inputId↔variantId` join；R014/R016 的 old-owner 与 old-generation 载荷若不补 epoch/generation 事实，仍会形成不可辨识对。
- sink evidence 是 draft reference，不是证明；`completeMediationClaim=false` 的 fixture 只能验证拒答/不充分输入路径，不能作为正向 D2 transfer 结果。
- G05 的严格输出仍缺 `baseInputHash`、`variantInputHash`、fixed-binding digest、`deltaBase`、`deltaPrime` 和 monotonicity witness 的独立输出 schema。
- D2 v0 仍不能承载正文中更强的 theorem scope：fault model 没有 scheduler/crash/communication-fault 语义、horizon/terminal-closure product、authorization/refusal kernel 或 policy-tree non-anticipativity；这些前提必须在 theorem 与 artifact 中逐一对齐，否则只能声称有限示意接口。
- 正向 D2 证据仍缺失：当前 fixture 的 `completeMediationClaim=false`，sink-ledger 有 bypass writer 且 `atomicEffectDedupReceipt=false`；它只能测试“不充分证据应拒答”。T001 已改为完整 `COMMIT_R→COMMIT_LEDGER`，但仅凭占位 projection/ref 仍不能证明 `Safe(ατ)⇒Safe(τ)`。
- `organizationId/ownerId/resourceId/sinkId` 的唯一性、跨引用集合相等、transition endpoint/trace path 可达性、monitor rule 闭包和 receipt 内容/hash 仍由独立 checker 负责；JSON Schema 的 `minItems`/字符串 ref 不能替代这些语义检查。

本节所有对象均为 `planned/unverified`；本轮没有修改 Janus/uBuddy 源代码、API、数据库 schema、运行时协议或现有实验实现。

## 27. 第十九轮：product-level D2 checker 规范草案（planned/unverified）

新增 [D2 checker invariants artifact](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-d2-transfer-checker-v0.invariants.json)。它不是 runtime API，也不是已实现验证器；目标是把 D2 从字段接口推进为可失败的 semantic-checker contract。

### 27.1 checker 输入与 fail-closed 输出

Checker 只能读取 D2 input 与独立 materialized witnesses，不能读取 locked expected/planning/runtime gold。缺少 witness 时返回 `UNKNOWN_INPUT_NOT_PROVEN`；发现可重放反例时返回 `COUNTEREXAMPLE_FOUND`。正向 `D2_SOUND` 只有在 complete mediation、完整 alpha、冻结 fault language、可达性、effect completeness、receipt replay、terminal closure 和 bad-state reflection 全部通过时才允许产生。

### 27.2 product-level obligation

定义：

```text
P_C = ConcreteLTS × FrozenFaultAutomaton × ContractMonitor
P_A = AbstractLTS × ContractMonitor
```

checker 必须显式 materialize `InitConcrete/InitAbstract`、`BadConcrete/BadAbstract`、`TerminalClosure`、有限 horizon `H` 和 fault-prefix language。对每个 concrete reachable state/trace，重放 alpha state/event map；声明的 stutter 只能隐藏无外部 effect 的内部步，不能隐藏 sink effect、version change、dedup、receipt 或 cross-sink commit。要求：

```text
ConcreteTracePath ∧ Reachable ≤ H
  ⇒ alpha(ConcreteTrace) = AbstractTrace
  ∧ (BadConcrete ⇒ BadAbstract)
  ∧ effect-complete
```

`safetyReflectionWitnessRef`、`faultAutomatonMembershipRef`、`alphaProjectionRef`、`receiptCommitWitnessRef` 仅是定位符；独立 checker 必须从 payload 重算，不能信任 ref 的字符串内容。

### 27.3 目前仍不能声称正向 D2

当前 D2 示例的 `completeMediationClaim=false`，sink-ledger 存在 `legacy-writer` 且 `atomicEffectDedupReceipt=false`；因此它只能验证“证据不足时拒答”。下一步必须新增一个独立正向 fixture（所有 sink ACL、effect+dedup+receipt、cross-sink recovery、fault DFA、horizon closure 均可重放），再新增只改变 owner→sink binding 的 Org-Binding Twin 负例。若两者无法通过同一 checker 区分，D2 不能作为非拼接式创新。

### 27.4 G05 的当前边界

`SELF_BASELINE_SANITY` 只验证同一 kernel、同一 candidate 与 baseline 相同的退化情况：`Δ′=0≤Δ=1/10`。它不能证明存在严格不同于 candidate 的 `π0′` 且逐世界支配 `π0`。正式 baseline theorem 仍需：

```text
sameInputProjection(base, variant) = true
diff(base, variant) ⊆ {baselinePolicyRef}
∀m: V_m(π0′) ≥ V_m(π0)
⇒ Δrob(π;π0′) ≤ Δrob(π;π0)
```

本节及 checker artifact 全部保持 `planned/unverified`，本轮没有修改当前实现。

## 23. 第十六轮：输入引用闭包、EchoSolver 反例与唯一 reducer（planned/unverified）

本轮五视角复核发现，上一轮的“拆分文件”仍不足以证明答案隔离：如果输入 payload 的 provenance 或 transitive reference 能回到含有 expected 的 combined manifest，或 runtime input 直接携带 base planning verdict，EchoSolver 可以按 case id 回显金标而不执行 FEAS/OPT。因而本轮做三项收紧。

### 23.1 answer-free input closure

新增 [input closure schema](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-gate-a-v1.input-closure.schema.json)，对 A1/A2/A3 可见文件执行有限字段名/文件名 denylist lint，覆盖 `expected[_-]verdict`、`world[_-]values`、`robust[_-]delta`、`planning[_-]output` 等常见形式。该 lint 不能证明语义 closure，仍可能被 `answerKey`、结构指纹、canonical payload hash、字符串编码或外部 side channel 绕过。`instance-manifest.example.json` 的显式 allowlist 当前包含三个 answer-free 草案：finite soft-value input、runtime mutation input 和 baseline variant；禁止跟随 combined manifest、reference payload 或 locked expected corpus。`runtime-input.example.json` 删除了直接泄漏的 `ACCEPT/OPTIMAL_WITHIN_PI` 和 planning output hash，只保留 base input、token/sink/fault facts；规划结果由 comparator 私域在 A1/A3 封存后绑定。

真正的 answer-free closure 应定义为 gold noninterference：固定 public/model input `I`，对任意两个 comparator-private gold corpora `E0,E1`，A1/A2/A3 在输出 seal 前的完整观察视图（mount/ref/argv/env/sidecar/hash/error/status/length/timing/resource behavior）满足 `View_A(I,E0) ≡ View_A(I,E1)`。字段 lint、allowlist 和 ACL attestation 只是该性质的检查项，不是证明。blinded alias 每 trial 应独立采样至少 128-bit 随机值、映射仅 comparator 可见且不复用；它只提供 alias unlinkability，不提供 payload indistinguishability，也不能单独排除按 canonical payload hash 查表的 EchoSolver。

该 schema 只是必要的递归 lint，不是进程级 ACL 证据。真实 Gate A 仍需不同进程/命名空间、expected corpus 对 A1/A2/A3 不可读、固定错误/超时通道和 blinded case alias；公开 expected hash 也不能被当作 hiding，因为低熵 corpus 可被字典枚举。

### 23.2 唯一 reducer 与候选全集

新增 [verdict reducer invariants](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-verdict-v1.reducer-invariants.json)。最终输出分为 `ArtifactVerdict`、`PlanningVerdict` 和 `ExecutionVerdict`；`PlanningVerdict` 必须包含 `candidateResults[]`、`enumerationCoverage`、`negativeWitnessSet/unresolvedSet` 和 `selectedCandidateId`。`INSTANCE_INFEASIBLE` 仅在全集枚举完成且所有 canonical candidate 都有完整负 witness 时成立；`OPTIMAL_WITHIN_Π` 仅在所有排序更优候选被确定排除时成立；runtime fault 不得回写 planning axes；`IN_DOUBT` 必须对应 `POSSIBLE_EFFECT_DO_NOT_RETRY`。

这些跨字段规则当前以 machine-readable invariant draft 记录，尚未实现 reducer、独立 oracle 或 property-based checker，因此不能把 schema 通过解释为 D1–D3 已证明。

### 23.3 研究对象和跨组织边界再确认

答案隔离只改变证据链，不改变 finite CP-RIR 的数学真值；但 `accessRegime=central_full` 的 Gate A 与 sealed-Γ/cross-owner 叙事是两个不同实验对象。Gate A 的结果只能支持 central-full exact specialization。跨组织特异性仍需要至少两个独立管理域、owner-local private relation、不可旁路 sink mediation 和故障注入证据；当前没有这些运行时实现。

隐私术语继续收窄：hash 只提供基于抗碰撞假设的 equality/binding，签名/MAC 才在密钥管理假设下提供来源认证和完整性；二者都不提供 semantic truth、completeness、hiding 或 unlinkability。若未来报告 `I(Θ;T)`，必须同时冻结 SecretDomain、Prior、Adjacency、AttackerView 和 transcript conditioning；否则标记 `NOT_EVALUATED`。

本轮仍未修改 Janus/uBuddy 源代码、API、数据库 schema、运行时协议或已有实验实现。

## 25. 第十七轮：严格 verdict schema 与非法联合输出拒绝（planned/unverified）

本轮把第 23 节的 reducer 约束进一步落到 [ubuddy-cp-rir-verdict-v1.schema.json](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-verdict-v1.schema.json)。这是结构 gate，不是 theorem 或运行时实现。

### 25.1 三层输出结构

`ArtifactVerdict`、`PlanningVerdict`、`ExecutionVerdict` 现在分别使用按轴限定的状态枚举。`PlanningVerdict` 必须携带：

- `candidateResults[]`：每个 canonical candidate 的 AST/hash、policy/baseline/Comp0 binding、逐世界 safety/executability/refinement/value/baseline/delta/cost；
- `enumerationCoverage`：canonical candidate ID 集、visited ID 集、digest、完整性、unresolved/negative witness 集；
- `selectedCandidateId`、`instance`、`optimality`。

`ExecutionVerdict` 必须携带 runtime/planning-safety/runtime-trace-safety/effect-knowledge/public-disposition、mutation layer、base input hash 和 execution envelope hash。

### 25.2 已执行的负向 schema 检查

使用 Ajv 2020-12 对 output fixture 做结构检查，并构造四个非法变体：

| 变体 | 结果 |
|---|---|
| `Input.status=ACCEPT` | 拒绝 |
| `Instance=INSTANCE_INFEASIBLE` 但存在可行 candidate | 拒绝 |
| `Runtime=IN_DOUBT` 且 `PublicDisposition=NONE` | 拒绝 |
| deployed runtime `HARD_VIOLATION` 但 conformance=`PASSED` | 拒绝 |

这证明 schema 的局部联合约束已能拒绝明显矛盾输出；它不证明 candidate 集合确实完整、worldwise `Δ` 算术正确，也不替代唯一 reducer。`R01–R10` 仍需由独立 checker 执行。

### 25.3 Scope 与复杂度边界

显式 `policyClass` fixture 只支持 `Θ(|Π|·K·T_eval)` 的 finite enumeration regression；它不能支撑 weighted-set-cover 或 bounded-treewidth 的复杂度结论。后两者必须另建 succinct grammar/circuit 与 factor-graph artifact。Gate A 仍只支持 central-full exact specialization，不外推 sealed-Γ 或隐私。

本轮没有修改 Janus/uBuddy 源代码、API、数据库 schema、运行时协议或已有实验实现。

## 24. 第十六轮补丁：移除派生 safety 标签，补 baseline mutant 与 patch materialization（planned/unverified）

独立因果/复杂度/分布式复核又发现三处不能留在“已隔离”表述中的问题，已作为草案修正：

1. `instance-input-payload.example.json` 删除每个 world 的 `hardTraceVerdicts`，避免把 hard-safety oracle 作为 A1/A3 输入；新增 [专用 finite-input schema](D:/Cli-anything/Janus/docs/ubuddy-cp-rir-finite-input-v0.schema.json)，并把 `safetyInputStatus` 明确为该 soft-value fixture 未包含 safety payload。未来 A2 必须读取独立 contract monitor/fault/effect payload，而不是信任 SAFE 标签。
2. 新增 `baseline-variant-input.example.json`，固定模型、授权、执行、evaluator，仅改变 baseline policy reference，作为 G05 self-baseline sanity 的 answer-free 输入；它仍需独立 reducer 检查，不能称一般 baseline monotonicity 已验证。
3. runtime JSON Patch 的 target 已改为现有 `/tokenTemplate/...`、`/universe/crossSinkInvariant/checkerVersion`、`/completionBinding` 和 `/mediationCoverage` 字段。正式 runner 仍需先执行 `materialize(base tokenTemplate/universe → variant object)`，再按 RFC 6902 应用 patch；未定义 materialization 前，G03/G11–G15 仍不可执行。

输入 fixture 现在仅能证明 JSON/schema/lint 层的边界；它仍然公开 case 的结构、动作和转移语义，不能防止带内置查表的 EchoSolver。必须通过私有 blinded alias、未知 holdout、运行时 ACL 和独立 contract/effect checker 才能把“答案隔离”提升为可审计证据。

## 28. 第二十轮技术深化：D2 product 输入层、effect-complete α 与 strict G05（planned/unverified）

### 28.1 D2 事件语义修正

旧 fixture 将 concrete `COMMIT_R` 标为 `MEDIATED_EFFECT`，同时产生版本递增与 receipt，却映射到 abstract `STUTTER`。这违反“外部 effect 不得被 stutter 隐藏”。现改为：

```text
COMMIT_R -> COMMIT_RESOURCE
c-r-committed -> a-r-committed
```

abstract LTS 与 ContractMonitor 都增加中间状态，正常路径变为 `PREPARE ; COMMIT_RESOURCE ; COMMIT`。monitor 明确消费 `ABSTRACT_AFTER_ALPHA` 事件。fault automaton 对正常非 fault 事件采用 self-loop，并使用有界 finite-prefix acceptance；输入显式提供 `H=4`。这些只闭合示例语义，不证明 D2 soundness。

### 28.2 Verdict taxonomy

D2 checker 现在区分：`INPUT_INVALID`（模型闭包、binding 或 effect-map 语义非法）、`WITNESS_INVALID`（trace/projection/receipt witness 不可重放）、`UNKNOWN_INPUT_NOT_PROVEN`（证据缺失或仍是不可独立验证的 ref）、`MODEL_COUNTEREXAMPLE`（有效冻结模型内可达反例）和仅在全部 obligations 通过时允许的 `D2_SOUND`。因此 dangling trace 或 projection mismatch 不再自动冒充模型反例。

### 28.3 G05 strict baseline-dominance pair

新增 `ubuddy-cp-rir-g05-baseline-dominance-v0.schema.json` 与 `ubuddy-cp-rir-g05-baseline-dominance-v0.input.example.json`。两臂固定 K05、world set、Auth、Exec、U、H、threshold、candidate 与 evaluator；candidate 仍只有 `repair`，`noop` 与 `incumbent_recovery` 只登记为 baseline，不参与 candidate Π。两臂唯一变化是 baseline reference。

私有金标重算得到：`m1: repair=4/5, noop=7/10, incumbent=79/100`；`m2: repair=9/10, noop=1/10, incumbent=41/50`。故 base `Δ=(1/10,4/5), robustΔ=1/10`，variant `Δ'=(1/100,2/25), robustΔ'=1/100`，且 variant baseline 在每个世界严格支配 base baseline。输入不含 expected、worldValues、robustDelta、verdict 或 dominance witness；缺 Auth/Exec/总 transition mass 时优先返回 `coverageUnknown(BASELINE_SUPPORT_MISSING)`，不能当作零效用或 `PLAN_REJECT`。该 soft fixture 的 safety 轴为 `NOT_EVALUATED`。

### 28.4 尚未闭合

当前 artifact 没有实现 A2/reducer，也没有正向 D2、真实 attestation、receipt replay、Org-Binding Twin 或独立 sink runner。schema validation 只能证明结构符合草案；所有能力保持 `planned/unverified`，未修改 Janus/uBuddy 源代码、API、数据库 schema、运行时协议或实验实现。

## 29. 第二十一轮技术深化：positive/negative D2、Twin 与 G05 reducer（planned/unverified）

### 29.1 D2 正向与负向 fixture

新增 `ubuddy-cp-rir-d2-positive-negative-v0.{schema,input}.json`。正例 P001 的 concrete LTS 将攻击尝试和 effect 分开：`BYPASS_ATTEMPT/STALE_ATTEMPT` 经过 sink ACL/fence 后到 `c-refused`，eventClass=`REFUSED_ATTEMPT`，version 不变、无 receipt；抽象事件为 `REFUSAL_SAFE`。正常提交路径为 `PREPARE_R ; COMMIT_RESOURCE ; COMMIT`，每个外部 effect 都有 effect witness。

P001 的 `EXHAUSTIVE_UP_TO_H` 三条终止路径为：

```text
PREPARE_R ; COMMIT_R ; COMMIT_LEDGER
PREPARE_R ; BYPASS_ATTEMPT
PREPARE_R ; STALE_ATTEMPT
```

负例 P002 的 `BYPASS_APPLIED` 产生 version 增量并到达 `c-violation`，coverage mode 为 `COUNTEREXAMPLE_WITNESS_ONLY`。因此不能把现有 D2 输入中的 T002 deployed trace 误当 frozen-model member；T002 已降为 `PREFLIGHT_NOT_CHECKED`，不参与正向 D2 聚合。

### 29.2 Org-Binding Twin 约束

`ubuddy-cp-rir-org-binding-twin-v0` 固定公开 pre-effect view：proposal/action/cost、trace prefix、contract digest、policy grammar digest 和 public state digest 必须相同。GOOD/BAD 唯一语义差异是隐藏 credential-domain→owner→authoritative-sink relation 的独立 attestation、sink challenge outcome 与 post-attempt effect。Twin checker 必须验证：

1. public prefix canonical bytes 完全相同；
2. 两个 credential attestation 的 nonce、issuer sequence 和 binding digest 可由独立 issuer 重放；
3. GOOD 的拒绝决定对应 `effectApplied=false`、`versionAfter=versionBefore`；
4. BAD 的接受决定对应真实 effect、receipt 与版本变化。

目前这些字段仍为 draft witness，不能当作真实跨组织 enforcement。

### 29.3 G05 reducer prototype

`ubuddy-cp-rir-g05-reducer-v0.mjs` 是研究目录下的只读原型，不接入 Janus runtime。执行顺序固定为：

```text
answer-key check
→ canonical arm materialization
→ fixed-binding / policy identity
→ Auth + Exec + endpoint + probability-mass support
→ exact rational V and Δ replay
→ strict baseline dominance
→ eta/kappa/cost threshold
```

失败优先级为 `INPUT_INVALID > PAIR_BINDING_UNKNOWN > BASELINE_SUPPORT_UNKNOWN > HARD_SAFETY_NOT_EVALUATED > SOFT_ARITHMETIC > DOMINANCE_CHECK > THRESHOLD_VERDICT`。原型实跑输出：base `Δrob=1/10`、variant `Δrob'=1/100`、base `SOFT_ACCEPT`、variant `SOFT_PLAN_REJECT(DELTA)`。它同时明确声明 pair binding 仍由 shared envelope 派生，未证明独立双文件的实际 changed-pointer 集。

### 29.4 文献排雷记录

本轮只记录检索线索，不把相邻工作当成新增贡献：Proof-Carrying Code（DOI `10.1145/263699.263712`）、Three-valued asynchronous distributed runtime verification（DOI `10.1109/memcod.2014.6961843`）、Assume-Guarantee Abstraction Refinement for Probabilistic Systems（DOI `10.1007/978-3-642-31424-7_25`）、Shield synthesis（DOI `10.1007/s10703-017-0276-9`）、causal automatic program repair（DOI `10.1109/ijcnn55064.2022.9892168`）。检索日期为 2026-09-01，标题/年份/DOI 仍需人工核验，差异仅能来自 CP-RIR 的具体有限闭世界语义和 effect-complete transfer。

## 30. 第二十一轮技术限制：fault/recovery 与真实性证据仍缺失（planned/unverified）

本轮安全复核要求将 positive fixture 的 `ESCROW` 从一个枚举值推进为可重放状态机。至少需要：`PREPARE→COMMIT_1→CRASH→RECOVER→COMMIT_2/ABORT`、drop/dup/reorder/partition、receipt-loss、重试禁止和 `H+1` terminal time-bomb。当前 P001 只有 nominal/refusal 三条路径，故 `crossSinkMode=ESCROW` 只能视为待实现约束，不能支撑 all-or-none。

完整 mediation 证据还需封闭 writer/egress inventory（包含 accepted 与 rejected writer）、带 nonce/issuer sequence 的独立签名或 MAC、sink-side ACL challenge、expectedVersion/epoch/generation fencing、effect+dedup+receipt 原子记录以及 pre/post state digest。当前字符串 digest/ref 只能用于定位，checker 必须在未来 materialized witness 上重算。

P001 的 `EXHAUSTIVE_UP_TO_H` 目前由 prototype 枚举三条终止路径验证，但 schema 尚未表达 prefix closure、scheduler choice 或故障分支全覆盖；因此输出只能为 bounded fixture pass，不能为 D2_SOUND。P002 的 `COUNTEREXAMPLE_WITNESS_ONLY` 则明确输出 `MODEL_COUNTEREXAMPLE`。

Org-Binding Twin 的结构 checker 只验证公开 prefix 相等以及 GOOD/BAD 的拒绝/接受结果。要升级为可信跨组织证据，还必须验证双输入 canonical diff、独立 issuer signature/MAC、同一 action/resource footprint、sink-side challenge 和真实 private-state/credential domain；否则属于结构性 hidden-world diagnostic。

G05 reducer 当前输出的 pair binding 文本明确为 shared-envelope 派生。下一步需接收两个独立 answer-free input，实际计算 changed-pointer 集并在缺 candidate grammar、endpoint rows、support mass 或 safety payload 时将下游数值和 verdict 置 null。

## 31. 第二十一轮 prototype 回归与剩余语义边界（prototype/unverified）

已运行三个研究级只读原型：

```text
node docs/ubuddy-cp-rir-d2-pair-checker-v0.mjs docs/ubuddy-cp-rir-d2-positive-negative-v0.input.example.json
node docs/ubuddy-cp-rir-org-binding-twin-checker-v0.mjs docs/ubuddy-cp-rir-org-binding-twin-v0.input.example.json
node docs/ubuddy-cp-rir-g05-reducer-v0.mjs docs/ubuddy-cp-rir-g05-baseline-dominance-v0.input.example.json
```

输出含义严格限定：P001 为 bounded fixture pass 但因 attestation/signature 未实现而 `UNKNOWN_INPUT_NOT_PROVEN`；P002 为 `MODEL_COUNTEREXAMPLE/ABSTRACT_UNSAFE`；Twin 为 relational structure pass 但 semantic unknown；G05 为 soft-axis base/variant 对照，hard safety=`NOT_EVALUATED`。

原型修正了三点：D2 faultRun 由显式 fault transition table 重放；G05 使用静态 answer-key denylist、重算 canonicalAst hash、弱支配+至少一个严格不等的 dominance 规则；G05 输出改用 `SOFT_ACCEPT/SOFT_PLAN_REJECT`，避免把未评估 safety 轴冒充整体安全。仍未解决：双输入 canonical diff、签名/MAC、真实 sink、完整 crash/recovery fault product、以及大于 2^53 的通用精确有理数编码。

## 32. 第二十二轮技术深化：reflection counterexample 与 effect-stutter invalid（prototype/unverified）

新增 reflection schema/input/checker、effect-stutter invalid input 和 effect-class laundering invalid input。主 fixture 的 concrete/abstract effect 均保留 class、effectId、sink/resource、multiplicity 和 versionDelta，仅 concrete owner binding 导致 bad state；checker 重放 edge、核对 supplied witness、state projection、terminal closure，并拒绝 effect→stutter 或 effect→internal laundering。实跑结果：`MODEL_COUNTEREXAMPLE/REFLECTION_COUNTEREXAMPLE`（`badConcrete=true, badAbstract=false`）、`INPUT_INVALID/EFFECT_MAPPED_TO_STUTTER` 和 `INPUT_INVALID/EFFECT_CLASS_NOT_PRESERVED`。

已检查义务仅包括 concrete replay、abstract witness replay、state projection、effect non-stutter 和单 trace terminal closure；未检查 ContractMonitor product、fault membership、effect/receipt replay、complete mediation 与 crash/recovery。因此 artifact 是负向语义回归，不是 `D2_SOUND` 证书。P0 仍包括 H-frontier/bad-prefix、ESCROW recovery、Twin/G05 双输入和 D2-G05 共享 digest binding。全文 bounded-treewidth 继续只允许联合 `G_joint` synthesis；逐 world 独立优化只能用于固定 policy evaluation。

draft hash record 已加入新增工件并按 raw UTF-8 SHA-256 重算；该 hash 只表示草案完整性，不表示语义正确性、hiding、D2 soundness 或 Strong Accept。本轮未修改 Janus/uBuddy 当前技术实现。

## 33. 第二十三轮技术深化：四维有界 product checker（prototype/unverified）

新增 `ubuddy-cp-rir-d2-product-checker-v1.mjs`。它对每条 supplied trace 联合维护 `(concreteState, abstractState, monitorState, faultState)`，并执行 concrete/abstract replay、monitor rule replay、fault transition replay、bad-prefix 检查、effect witness 基本字段一致性和 H-frontier 枚举。当前 P001 的 `hFrontierCount=0`，结果仍因 cryptographic attestation 未实现而是 `UNKNOWN_INPUT_NOT_PROVEN`；P002 为 `ABSTRACT_UNSAFE`。

该 checker 仍是 research prototype：没有 recovery/receipt-knowledge 状态、scheduler nondeterminism、drop/dup/reorder/partition、独立 sink、完整 `BadConcrete` 谓词或端到端 CP-RIR digest binding，不能产生 `D2_SOUND`。上一版 effect laundering 已单列为输入非法，不再与 reflection counterexample 混淆。复杂度口径继续要求联合 `G_joint`，逐 world 独立优化只用于 fixed-policy evaluation。

## 34. 第二十四轮技术深化：canonical D2 suite 与 recovery/effect-knowledge 状态表（prototype/unverified）

新增：

- `ubuddy-cp-rir-d2-canonical-suite-v0.schema.json`
- `ubuddy-cp-rir-d2-canonical-suite-v0.input.example.json`
- `ubuddy-cp-rir-d2-canonical-reducer-v0.mjs`
- `ubuddy-cp-rir-recovery-effect-knowledge-v0.schema.json`
- `ubuddy-cp-rir-recovery-effect-knowledge-v0.input.example.json`

canonical reducer 对六个 opaque aliases 使用同一语义优先级：

```text
safe witness       -> UNKNOWN_INPUT_NOT_PROVEN
abstract unsafe    -> MODEL_COUNTEREXAMPLE / ABSTRACT_UNSAFE
reflection failure -> MODEL_COUNTEREXAMPLE / REFLECTION_COUNTEREXAMPLE
effect -> stutter  -> INPUT_INVALID / EFFECT_MAPPED_TO_STUTTER
effect laundering  -> INPUT_INVALID / EFFECT_CLASS_NOT_PRESERVED
witness tampering  -> WITNESS_INVALID / SUPPLIED_ABSTRACT_WITNESS_MISMATCH
```

recovery truth table 的最小状态为 `PRE_EFFECT`、`EFFECT_POSSIBLE`、`EFFECT_CONFIRMED`、`NO_EFFECT_CONFIRMED`、`IN_DOUBT`、`REMEDIATED`、`HARD_VIOLATION`、`MANUAL_INTERVENTION`。核心不变量是：`IN_DOUBT ⇒ POSSIBLE_EFFECT_DO_NOT_RETRY`；receipt loss 不能推出无 effect；confirmed half-commit 可保留 hard violation 与剩余 effect unknown；compensation 是 forward repair/remediation，不是反事实 rollback。

canonical suite 当前仍是 bounded semantic regression：没有 process-level mount/ACL、独立 issuer/sink、真实 receipt 验签、scheduler/recovery product 或 CP-RIR candidate/world digest join。所有新能力保持 `prototype/unverified`，不能产生 `D2_SOUND` 或 privacy guarantee。

recovery checker `ubuddy-cp-rir-recovery-effect-knowledge-checker-v0.mjs` 当前只验证 product snapshot 的基本互斥条件、per-sink half-commit safety、allowed-action domain 和历史违例不被 compensation 擦除；实跑输出 `PROTOTYPE_OUTPUT`。它主动把 receipt confirmation 标为“需要 cryptographic atomicity、当前未检查”，不把 `VALID_RECEIPT_FOUND` 当作已证 effect。

canonical reducer 的 `observerContract` 目前只是 schema-level contract：`canonicalPayload` 对 solver 可见，case alias 为固定 8 字符示例，process/namespace isolation 未实现。因而 answer isolation 仅是 lexical key-denylist 回归，不能称 hiding 或 blinded benchmark；复杂度仍不从六个单 witness 推出 NP/FPT 或联合 `G_joint` 结果。

## 35. 第二十五轮：recovery mutation audit-only prototype（prototype/unverified）

新增并验证：

- `ubuddy-cp-rir-d2-recovery-mutation-v0.schema.json`
- `ubuddy-cp-rir-d2-recovery-mutation-v0.input.example.json`
- `ubuddy-cp-rir-d2-recovery-mutation-checker-v0.mjs`

该 artifact 将 recovery 快照拆为每个 sink 的 `effectReality`、`effectKnowledge`、`receiptState`、`dedupState`、`version`，并把全局 `globalSafety`、`recoveryPhase`、`publicDisposition` 和 `allowedActions` 保持正交。六个冻结 mutation 的当前输出为：pre-effect crash=`UNKNOWN_INPUT_NOT_PROVEN`（negative witness 尚未独立验证）；post-effect receipt loss=`IN_DOUBT`；late valid receipt=`UNKNOWN_INPUT_NOT_PROVEN`（receipt cryptography/atomicity 尚未独立 replay）；half-commit=`HARD_VIOLATION + IN_DOUBT`；duplicate receipt=`IN_DOUBT`；compensation failure=`MANUAL_INTERVENTION` 且历史 violation 保留。

本轮 checker 只新增 fail-closed snapshot consistency lint：重复 sink、`NO_EFFECT_CONFIRMED` 与 applied reality 矛盾、duplicate receipt 与 dedup 状态不一致、以及 mutation 缺失关键事件都会返回 `INPUT_INVALID`。它不会信任输入中的 `effectKnowledge`、`receiptCrypto=VERIFIED` 或 `sinkAtomicity=VERIFIED`，也不会把 per-sink `PRESENT_VERIFIED` 自动提升为已验证 effect；late receipt 仍要求独立 cryptographic/atomic replay。

证据边界必须明确：当前 checker 只重放单个 supplied snapshot/事件集合，不执行 transition reachability、scheduler nondeterminism、crash/restart、partition、drop/dup/reorder、receipt-loss product、ESCROW reservation/expiry/reclaim/double-spend 或 authoritative sink enforcement。因此该 suite 是 **audit-only falsification prototype**，不是 recovery protocol、all-or-none 保证、exactly-once、liveness 或 `D2_SOUND`。recovery 也尚未进入 canonical D2 reducer，尚未与 D1/G05 共享 candidate/world/contract/fault/recovery digest。

observer 仍然不满足隐私要求：`solverVisible` 仅限制 schema 级字段，audit-only event trace、receipt、negative witness 和 sink private state 仍处于同一 JSON 输入；32 位十六进制 alias 没有实际 fresh generator，不能声称 process/namespace isolation、hiding 或 blinded benchmark。

本轮 hash record 已按 raw UTF-8 SHA-256 更新 recovery knowledge 与 recovery mutation 三件新增工件。hash 仅表示草案完整性，不表示 semantic validity、replay authenticity、privacy、D2 soundness 或 Strong Accept。未修改 Janus/uBuddy 当前实现。

## 36. 第二十六轮：canonical-recovery product v1（prototype/unverified）

新增：

- `ubuddy-cp-rir-d2-canonical-recovery-product-v1.schema.json`
- `ubuddy-cp-rir-d2-canonical-recovery-product-v1.input.example.json`
- `ubuddy-cp-rir-d2-canonical-recovery-product-v1.mjs`

v1 checker 读取 answer-free canonical suite 与 recovery product 两个输入，先由 canonical reducer 计算 model-transfer 结果，再对 recovery sequence 做有限 replay。新增检查包括：canonical case digest join、`canonicalStepIndex/canonicalEvent` 绑定、恢复事件 from/to 可达性、per-sink universe 不变、version 单调性、`IN_DOUBT ⇒ DO_NOT_RETRY`，以及 `EFFECT_CONFIRMED` 必须具备独立 receipt/sink replay（当前 fixture 因 `NOT_IMPLEMENTED` 而不满足）。

该 gate 的范围仅覆盖由 `MEDIATED_EFFECT_OBSERVED` 触发的 recovery state transition；它不会把输入快照里已有的 `effectKnowledge=EFFECT_CONFIRMED` 追溯提升为独立证据。故 per-sink confirmation 仍必须视为 declared state，直到 receipt/effect atomic replay 与 authoritative sink witness 实际接入。

输出不再压缩成一个 status，而是拆成：`modelTransferStatus`、`runtimeStatus`、`currentSafety`、`effectKnowledge`、`perSinkRuntime`、`recovery`、`planningSafety` 和 `unknownReasons`。这只修复语义混轴，不代表任何 safety 或 causal guarantee。`planningSafety` 当前固定为 `NOT_EVALUATED`，防止从 effect/recovery 状态直接派生 planning ACCEPT。

当前示例运行结果：

```text
7Q2P9K4M -> model UNKNOWN_INPUT_NOT_PROVEN, runtime UNKNOWN
4L8M2X6C -> model MODEL_COUNTEREXAMPLE, runtime HARD_VIOLATION
9R3K7V1N -> model MODEL_COUNTEREXAMPLE, runtime IN_DOUBT
```

尚未实现的联合义务：recovery step 与 canonical sink/effect/receipt/epoch/generation 的完整绑定；scheduler 与 crash/restart、partition、drop/dup/reorder；ESCROW reservation/capacity/expiry/reclaim/double-spend；独立 receipt signature/MAC、dedup atomicity 和 authoritative sink；跨 artifact 的 candidate/world/contract/fault/recovery domain-separated digest；process/namespace isolation 与 fixed-shape observer。

因此 v1 的复杂度只能写为 supplied sequence replay 的多项式检查，不能写成完整 product exploration、FPT、NP-hardness、D2_SOUND 或 recovery protocol。共享 digest 目前是 64-hex 格式占位，完整性不等于语义绑定或 hiding。

### v1.1 fail-closed 修正

分布式安全变体审查构造了删除 sink、重复 canonical index、改写 final snapshot、状态回退、危险 retry 与缺字段输入。对此 checker 已增加：入口 Ajv 校验；canonical index 单调且不可复用；recovery event class 必须与 canonical edge 一致；per-sink universe 不得增删；version、effect reality、dedup 和 verified receipt 不得回退；final snapshot 必须逐字段等于最后一步 post；缺字段或 canonical reducer 非零退出统一返回 `INPUT_INVALID`。

这些修正只关闭 artifact-level witness tampering，不形成 recovery completeness。当前仍可接受的语义空洞包括 scheduler/fault interleaving、ESCROW 状态机、receipt atomicity、真实 sink enforcement、跨 artifact digest 重算和 observer isolation。因此 v1.1 仍只能标记 `prototype/unverified`。

### 36.1 变体回放记录（prototype/unverified）

对以下变体进行只读回放：删除初始 sink、重复 canonical index、改写 final snapshot、降低 version/receipt/dedup 状态、在未确认状态开放 `RETRY_SAME_EFFECT`、以及删除必填字段。当前 checker 分别返回 `SCHEMA_VALIDATION_FAILED`、`RECOVERY_SINK_UNIVERSE_CHANGED`、`CANONICAL_STEP_ORDER_OR_REUSE_INVALID`、`RECOVERY_FINAL_SNAPSHOT_MISMATCH`、对应的 regression/unsafe-action `WITNESS_INVALID`，或统一的 schema failure；不会崩溃后误报通过。

该结果只证明 witness-integrity 负控有效。它没有证明 canonical event 的 effect identity、receipt nonce/issuer sequence、epoch/generation、scheduler choice、fault transition 或 ESCROW reservation 的正确性；per-sink `effectKnowledge=EFFECT_CONFIRMED` 在输入中仍可能是自报状态。特别地，`EFFECT_CONFIRMED` gate 只约束 mediated recovery transition，不是所有 per-sink confirmation 的独立验证。

## 37. 第二十七轮：bounded recovery branch closure v2（prototype/unverified）

新增：

- `ubuddy-cp-rir-d2-recovery-branch-closure-v2.schema.json`
- `ubuddy-cp-rir-d2-recovery-branch-closure-v2.input.example.json`
- `ubuddy-cp-rir-d2-recovery-branch-closure-v2.mjs`

v2 固定一个 canonical mediated effect（`E1/e1/s1/r1`, `versionDelta=1`），定义三个可回归 branch：

```text
DELIVER_RECEIPT + NONE          -> PRESENT_UNVERIFIED / EFFECT_POSSIBLE / AUDIT_ONLY
DROP_RECEIPT    + RECEIPT_DROP  -> LOST / IN_DOUBT / DO_NOT_RETRY
CRASH_AFTER_EFFECT + CRASH_RESTART -> ABSENT / IN_DOUBT / DO_NOT_RETRY
```

checker 重算 canonical case 的 domain-separated digest，校验 branch key 集合、branchId 唯一性、canonical event/class/effect identity、authority sink/resource、version delta 和分支语义。为避免把自报事实当证据，输出保留 `declaredEffectReality`，并强制 `verifiedEffectReality=UNKNOWN_UNVERIFIED`；所有 branch 显式带 `utilityStatus=NOT_EVALUATED` 与 `causalScope=NOT_EVALUATED`。

当前闭包模式命名为 `SUPPLIED_BRANCH_SET_CHECK_ONLY`，不再使用容易误解为穷尽性的 `EXACT_SUPPLIED_KERNEL_BRANCH_SET`。原因是 `allowedBranches` 与 cases 同源于输入，checker 没有外部冻结 scheduler/fault grammar 或独立 generator；因此不能证明 omitted branch、interleaving、fairness 或 all-prefix closure。

v2 当前复杂度是固定 branch fixture 上的多项式检查，约为 `O(|branches| × |sinkFacts|)` 加 canonical digest 计算。尚未实现 scheduler exploration、crash/restart 状态演化、receipt MAC/signature、sink-side atomicity、epoch fencing、ESCROW reservation/capacity/expiry/reclaim/double-spend/all-or-none、process isolation 或 fixed-shape observer。所有结论保持 `UNKNOWN_INPUT_NOT_PROVEN` 或 `INPUT_INVALID`，不能称 `D2_SOUND`、recovery protocol、exactly-once 或 privacy guarantee。

## 38. 第二十八轮：v2 evidence-domain tightening（prototype/unverified）

v2 现将 canonical-case digest 与其他 product digest 统一到显式 domain-separated hash；输入 schema 增加 `observerContract`，声明 solver-visible 目标字段、audit-only 字段和 `processNamespaceIsolation=NOT_IMPLEMENTED`。`sinkAfter` 同时携带 `declaredEffectReality` 和固定的 `verifiedEffectReality=UNKNOWN_UNVERIFIED`，防止 receipt loss/CRASH fixture 把输入自报状态误当权威 sink read。每个 branch 还固定 `utilityStatus=NOT_EVALUATED` 与 `causalScope=NOT_EVALUATED`。

这不是隐私实现：authority、receipt、branch label、owner/writer、epoch/generation 仍在同一 JSON；domain tag 只提供 hash namespace，不提供 hiding/unlinkability。`allowedBranches` 仍是输入自报集合，checker 只做 `SUPPLIED_BRANCH_SET_CHECK_ONLY`，不做 scheduler generation、all-prefix closure 或 recovery reachability。所有结果继续保持 `prototype/unverified` 与 UNKNOWN/INPUT_INVALID 边界。

## 39. 第二十九轮技术深化：external grammar → manifest → closure（prototype/unverified）

## 40. 第三十轮技术深化：recovery FSM prefix manifest（prototype/unverified）

新增 recovery FSM grammar、generator、manifest、closure checker 和 negative fixtures。grammar 当前 horizon=5，包含 9 个 state、8 条 transition、4 个 terminal state；generator 通过有限 DFS 保留 root 和全部可达前缀，共 9 条 path。checker 验证 grammar/manifest digest、path 唯一性、父前缀存在、stepCount/数组长度、terminal flag 及 horizon dead-end。

通过时输出 `UNKNOWN_INPUT_NOT_PROVEN` 与 `ALL_PREFIX_CLOSURE_CHECKED_BUT_RUNTIME_EVIDENCE_UNVERIFIED`。显式 FSM 的 DFS/物化成本可按 `O(|Q|+|T|+Σ_p|p|)` 记录；这不是联合 `Concrete×Abstract×Monitor×Fault×Recovery×Sink` product 复杂度。真实 sink/receipt、crash/restart、fairness、ESCROW 和 all-or-none 仍为 `planned/unverified`，本轮未修改 Janus/uBuddy 实现。

generator 还执行 `TERMINAL_STATE_NOT_DECLARED`、`DUPLICATE_TRANSITION_ID`、`NONDETERMINISTIC_TRANSITION_UNDECLARED` 和 `UNREACHABLE_STATE_OR_TRANSITION` lint，并提供 grammar-only unreachable negative fixture。它们只防止声明图的结构性悬空，不验证状态语义、sink authority、receipt真实性或超出 horizon 的完整性。

## 42. 第三十二轮技术深化：FSM–canonical–branch binding（prototype/unverified）

新增 binding schema/input/checker 和 digest-negative runner。binding scope 明确为 `FSM_CANONICAL_BRANCH_JOIN_ONLY`：重算 canonical case、external witness case、branch grammar、recovery grammar、recovery path-set 五类 domain-separated digest，并验证 witness→canonical、manifest→grammar 的一致性。输出同时携带 `evidencePolicy`：verified receipt、verified negative witness、compensation verified 均要求独立证据，`historicalViolationErasure=FORBIDDEN`。

FSM 状态更新为 `COMPENSATION_PENDING`、`REMEDIATED`、`MANUAL_INTERVENTION`；补偿失败进入人工介入，不能把补偿动作本身解释为修复成功。binding checker 现合取 canonical reducer、external branch closure 和 FSM closure，且外部 mismatch 只返回 `BINDING_INVALID`；通过时仍为 UNKNOWN，因为没有验证 sink ledger、receipt cryptography、dedup atomicity、epoch fencing、真实 crash/restart、ESCROW 或 D1–D2–G05 full join。所有新增能力为 `prototype/unverified`。

## 43. 第三十三轮技术深化：recovery evidence ledger（prototype/unverified）

新增 evidence schema/input/checker/negative runner。RECEIPT、NEGATIVE_WITNESS、COMPENSATION 三类 claim 均需 authority、integrity、atomicity、linearization、dedup、fencing、prePostHash 七项全部 PASS 才能输出 VERIFIED；`verificationStatus=VERIFIED` 但任一 replay check 未通过时，返回 `VERIFIED_CLAIM_REQUIRES_ALL_REPLAY_CHECKS`。当前三项全部 `NOT_IMPLEMENTED`，binding 的第四个 semantic subcheck 因此保持 UNKNOWN。

该 ledger 只是证据接口与 fail-closed prototype，没有真实签名、sink query、atomic linearization 或 compensation replay。它不能证明 effect reality、no-effect、remediation success、utility 或 causality。

新增 grammar、generator、manifest、external witness、closure checker 和 negative-fixture 工件。执行链为 `Γ(grammar) → M(manifest) → W+M+canonical → closure`。witness 不再含 `kernel.allowedBranches`；checker 重算 grammar/manifest digest，检查 alphabet coverage、固定 pair→semantic 映射、canonical/effect/authority/version/action gate，并验证 omitted、extra、duplicate-id、semantic-mismatch 四类 mutation。

复杂度仍仅是显式规则展开；未来有限前缀树的输出敏感上界可记为 `O(P·H·C_step)`，当前 limitations 明确包含 `NO_MACHINE_CHECKED_REACHABILITY`、`NO_ALL_PREFIX_CLOSURE`、`NO_REAL_SCHEDULER_REPLAY`。真实 scheduler、sink/receipt replay、multi-step recovery、ESCROW、process isolation、D1–D2–G05 join 仍为 `planned/unverified`；本轮未修改 Janus/uBuddy 实现。
## 44. 第三十四轮技术深化：evidence/binding fail-closed 约束（prototype/unverified）

本轮在冻结技术基线上补充证据账本的输入级约束，没有改变现有 API 或运行时协议。evidence checker 现在执行：

1. schema 通过后拒绝任一输入 `PASS`（`INPUT_PASS_FORBIDDEN_WITHOUT_INDEPENDENT_VERIFIER`）；
2. claim ID 唯一、非空并限制字符集/长度；
3. 三类 claim kind 的覆盖与 `(effectId,sinkId,kind)` 唯一性检查；
4. 对 claims 按 `(effectId,sinkId,kind,claimId)` 规范排序后计算 domain-separated `evidenceDigest`；
5. 所有当前 claim 仍输出 `UNKNOWN_INPUT_NOT_PROVEN/REPLAY_NOT_IMPLEMENTED`，不会由输入字段升级为 VERIFIED。

binding checker 新增显式 `sources.branchManifest`，把 branch manifest 作为输入依赖传给 external-branch closure；它重算 grammar→manifest，并要求 supplied manifest 与生成结果一致。`expected`、`actual` 和最终 binding root 现在包含 `branchManifestDigest` 与 `recoveryEvidenceDigest`。此外，evidence `caseAlias`、effect/sink pair 必须分别匹配 binding case 与 canonical concrete effect universe；每个 canonical pair 在当前 fixture 要求三类 evidence 各一条。非法 evidence 会以 `RECOVERY_EVIDENCE_INPUT_INVALID` 阻断总 binding。

状态标注：上述 checker/schema/fixture 为 `prototype/unverified`；它们只验证 artifact schema、引用完整性和 digest join。没有 issuer key、signature/MAC、trusted root、sink read、receipt linearization、dedup/fencing、runtime trace、FSM-step binding 或 process isolation。source 路径尚未限定到签名 manifest allowlist，错误细节仍可能泄漏成员关系，故不称 provenance、hiding 或 privacy。

复杂度：evidence 规范排序为 `O(C log C)`（`C` 为 claim 数），kind/join 检查为 `O(C+E)`；binding 仍由四个 supplied-artifact checker 加显式 digest 计算组成，未探索联合 scheduler×fault×recovery product。该轮不能推出 D2_SOUND、exactly-once、all-or-none、liveness 或 causal/utility 结论。
## 45. 第三十五轮技术深化：claim→FSM path/transition step binding（prototype/unverified）

新增 `ubuddy-cp-rir-d2-recovery-evidence-step-binding-v0` schema/input/checker/negative runner。输入将每个 evidence claim 绑定到一条 manifest path 的具体步骤，并重复核对 grammar transition 的 `from/event/to` 与 path 的 `states/events/transitionIds`。kind 到事件的静态映射为：`RECEIPT→VERIFIED_RECEIPT`、`NEGATIVE_WITNESS→VERIFIED_NEGATIVE_WITNESS`、`COMPENSATION→COMPENSATION_VERIFIED`。checker 先调用现有 evidence checker、重算 grammar→manifest，并在任何 schema、digest、case、claim coverage 或 step mismatch 时 fail-closed。

主 FSM binding 已新增 `evidenceStepBinding` source 和 `evidenceStepBindingDigest`，第五个 semantic subcheck 为 `evidenceStepBinding`；默认输出仍为 `UNKNOWN_INPUT_NOT_PROVEN`。因此当前可声称的是 claim/path/transition 的 referential integrity，不是 runtime transition occurrence。runtime sink transcript、receipt cryptography、negative-witness replay、compensation replay、crash/restart 和 process isolation 仍为 `planned/unverified`。

复杂度：step checker 对 `C` 个 claim 和 manifest 总步数 `L` 做哈希、索引和一次遍历，约为 `O(C log C + L)`（其中排序继承 evidence canonicalization）；主 binding 仍是多个 supplied-artifact checker 的组合，未探索 scheduler×fault×recovery×sink 的联合状态空间。负例覆盖 omitted claim、wrong path、wrong transition、wrong event、wrong effect/sink、digest tamper 和 case alias mismatch。

边界：step binding 不提供真实性、签名 provenance、完整 coverage、noninterference、Blackwell sufficiency 或因果识别；`VERIFIED_RECEIPT`、`NO_EFFECT_CONFIRMED`、`REMEDIATED` 仍不能由声明字段升级。所有新增工件状态为 `prototype/unverified`，本轮未修改现有实现。

复审修正：bindings 要求与 evidence claim 的 `effectId/sinkId` 一致；主 binding 比较 step artifact 与主 ledger 的 source、evidence digest、claim identity set，并对 step bindings 规范排序后计算 digest。仍只属于 artifact-level integrity。

## 46. 第三十六轮技术深化：runtime-shaped hypothetical catalog 与六方 composite binding（prototype/unverified）

新增并修订：

1. `ubuddy-cp-rir-d2-runtime-sink-transcript-v0.schema.json` 增加 `pathSemantics=MUTUALLY_EXCLUSIVE_HYPOTHETICAL_PATH_CATALOG`、`realizedPathId=null`、record `realizationStatus=HYPOTHETICAL_UNREALIZED`；每条 record 的 `pathId` 必须唯一，禁止在无签名 proof 时声明 realized path。
2. runtime checker 读取并运行 canonical reducer、external branch closure、FSM closure、evidence-step checker；重新计算八个上游 digest，并执行 claim→step→FSM→branch→canonical→authority 的引用 join。
3. 每条 record 检查 `canonicalStepIndex`、event/effect/resource/multiplicity/versionDelta、FSM state/transition、scheduler/fault、authority `epoch/generation/versionBefore`、`receiptStateAtBranch`、唯一 `recordId/pathId`；`branchVersionAfter` 必须等于 branch `sinkAfter.versionAfter`，而 `hypotheticalPostVersion` 固定 `null`。
4. runtime 输出固定为 `UNKNOWN_INPUT_NOT_PROVEN`、`verifiedEvent=UNKNOWN_UNVERIFIED`、`utilityStatus=NOT_EVALUATED`、`causalScope=NOT_EVALUATED`，并显式记录 `MUTUALLY_EXCLUSIVE_PATHS_NOT_REALIZED`。该输出是 catalog referential integrity，不是 runtime replay。
5. 主 FSM binding 新增 runtime transcript source、source identity join、第六 semantic subcheck 和 `runtimeTranscriptDigest`；digest 对规范化 records 按 `(claimId,kind,effectId,sinkId,pathId,stepIndex,transitionId,recordId)` 排序后使用 domain-separated SHA-256。该 digest 仅用于 integrity bookkeeping，`hidingClaim=none`。

负例与状态：runtime negative runner **12/12**（claim/path/branch/sink/root/omitted/index/authority/version/duplicate record/duplicate path/realized-without-proof）；主 binding negative runner **21/21**。全量 evidence、step-binding、FSM closure、syntax、hash record、`git diff --check` 通过。新增能力均为 `prototype/unverified`；standalone runtime checker 假定 source artifact 已有效，主 composite binding 才负责同时调用 evidence 与 step checker。

复杂度：runtime catalog 规范排序为 `O(R log R)`，其中 `R` 为 records；索引与字段 join 为 `O(R+P+E)`（P 为 FSM path 步数，E 为 canonical effect 数）。这仍是有限 supplied-artifact 的多项式一致性检查，不能推出 runtime reachability、D2_SOUND、receipt authenticity、exactly-once、all-or-none、liveness、privacy 或因果识别。

实现状态：schema/input/checker/negative runner 为 `prototype/unverified`；真实 sink read、签名/MAC、pre/post hash、linearization、dedup/fencing、crash/restart、唯一 realized-path proof、cross-sink ESCROW 均为 `planned/unverified`。本轮没有修改现有 Janus/uBuddy 实现、API、数据库 schema 或运行时协议。

## 47. 第三十七轮技术深化：source validation、planned path proof 与 cross-sink ESCROW catalog

runtime standalone checker 新增 source schema validation：逐个编译并校验八类 source schema；external witness 的外部 `$ref` 由 recovery-branch-closure-v2 schema 显式注册。失败输出增加固定公开 bucket `CATALOG_INVALID`，成功/abstain 为 `UNKNOWN`；但 JSON 完整输出仍包含内部 reason、case、count、digest，且不同分支耗时不同，故 `FIXED_SHAPE_CODE_ONLY_NOT_PROCESS_ISOLATED` 只是接口标记，不是 noninterference 证明。

新增 realized-path-proof schema/input/negative runner，状态严格为 `planned/unverified`。当前 schema 固定 `signature=NOT_IMPLEMENTED`、`verificationStatus=NOT_IMPLEMENTED`；self-asserted signature、false VERIFIED、非法 payload digest 三类负例 3/3 通过。没有 verifier、issuer key、key lifecycle、trusted timestamp、nonce/replay protection 或 payload canonicalization，不能把该接口称为 signed proof implementation。

新增 cross-sink ESCROW schema/input/checker/negative runner，建模两个 owner/sink、两个 effect、partial commit 与 reservation metadata。正例只返回 `CROSS_SINK_PARTIAL_COMMIT_CATALOG_VALID_REPLAY_UNVERIFIED`；`allOrNoneClaim=HYPOTHESIS_NOT_VERIFIED`、`runtimeStatus=UNKNOWN_INPUT_NOT_PROVEN`、utility/causal 均 `NOT_EVALUATED`。4/4 负例覆盖 duplicate sink、effect/sink mismatch、version regression 与 self-asserted all-or-none。

复杂度仍为显式 catalog 的 `O(S+E)` 索引/连接；没有并发 interleaving、lease/expiry semantics、double spend、ABA/old-owner write、quorum、linearization 或补偿 replay。所有新工件均为 `planned/unverified` 或 `prototype/unverified`，未改 Janus/uBuddy 现有实现。

## 48. 第三十七轮补充：audit/public projector 与错误通道边界（prototype/unverified）

runtime checker 的完整 JSON 现在明确标记为 `channel=AUDIT_ONLY`；新增 `ubuddy-cp-rir-d2-runtime-public-projector-v0.mjs` 仅序列化固定键集：`schemaVersion/implementationStatus/channel/statusCode/decision/padding/limitations`。有效与 realized-path 非法输入的 public JSON 长度均为 **265 bytes**，public code 分别为 `UNKNOWN________` 与 `CATALOG_INVALID`；projector negative runner **2/2** 通过。

这只是 application-level serialization contract。checker 仍在同进程读取 source、执行多子检查，且内部路径、CPU/内存、退出时间和调用者可见的 process 行为未隔离；因此不能声称 constant-time、process isolation、noninterference、traffic-analysis resistance 或 privacy-preserving observer。内部 `reasonCode`、digest、caseAlias、recordCount 仅应进入授权审计通道，当前仓库 prototype 尚未提供 ACL/mount enforcement。

实现状态：public projector/checker 为 `prototype/unverified`；planned proof 与 ESCROW catalog 为 `planned/unverified`。本轮没有修改现有 Janus/uBuddy 源码、API、数据库 schema、运行时协议或实验实现。

## 49. 第三十八轮技术深化：realized-proof payload 与 ESCROW semantic guards

realized-path proof planned checker 现在对 payload 进行规范化 SHA-256：`CP-RIR-D2-REALIZED-PATH-PAYLOAD-V0\0 || canonical(payload)`。payload 覆盖 case、branch、path、FSM step/transition、nonce、sequence 与 runtime catalog digest；外层 `caseAlias/pathId` 必须与 payload 相等，digest 不匹配即 fail-closed。当前输入的 payload digest 可重算，但签名仍 `NOT_IMPLEMENTED`，所以输出是 `PROOF_PAYLOAD_BOUND_SIGNATURE_UNVERIFIED`，不是 authenticated proof。负例 **7/7**。

ESCROW checker 增加以下有限语义 guard：

1. effect 的 epoch 必须等于目标 sink epoch；
2. 当 sink 为 `APPLIED_DECLARED` 时，`versionAfter-versionBefore` 必须等于 effect `versionDelta`；
3. `reservedUnits≤capacity`；
4. observed tick 超过 expiry 时必须显式 `RECLAIMED_UNVERIFIED`；
5. `PARTIALLY_COMMITTED_UNVERIFIED` 禁止 `globalSafety=SAFE`；
6. all-or-none 只能是 `HYPOTHESIS_NOT_VERIFIED`。

ESCROW 正例仍输出 `CROSS_SINK_PARTIAL_COMMIT_CATALOG_VALID_REPLAY_UNVERIFIED`，负例 **8/8**。这些 guard 是 catalog consistency，不是 reservation ownership、lease fencing、reclaim linearization、double-spend prevention、cross-sink atomic replay 或 compensation efficacy。

复杂度：proof payload canonicalization 为 `O(K log K)`（K 为 payload 字段数，常数级），ESCROW guards 为 `O(S+E)`；没有 solver、并发状态空间、概率保证或因果识别。新增工件状态继续为 `planned/unverified`。

## 50. 第三十九轮技术深化：ContractComplete、ObligationConservation 与非空洞性门控（planned/unverified，2026-09-01）

本轮只在冻结技术基线上增加形式化门控和负例设计，不修改现有 API、数据库 schema、运行时协议或源代码。目标是防止“契约固定但未定义完整”“删除义务后仍声称 preservation”以及“空世界/空动作导致 vacuous safety”三类输入漏洞。

### 50.1 输入与门控对象

定义规范化合同摘要：

```text
C0 = (schemaVersion, scope, inputDomain, assumptions, obligations,
      footprint, observationProjection, exceptionPolicy, deadline,
      attemptLimit, freshness, idempotence, authorization,
      referenceEvaluator, costModel, contractDigest)
```

`ContractComplete(C0)` 是 schema-independent 的语义谓词：所有字段必须存在且可规范化，scope/环境闭包明确，`referenceEvaluator`、观察投影和成本模型由锁定 manifest 指定。字段存在不等于语义正确；因此该谓词当前只能规划为独立 oracle/checker 输入，不能由 JSON schema 单独证明。

`ObligationConservation(C0,Cπ)` 逐义务比较修复前后合同：调用方 assumption/input domain 不得被强化或缩小；required effect、freshness、attempt、idempotence、authorization、frame 和 deadline 不得删除、延迟、降格为 soft、exception 或 manual fallback；实现保证可以加强，但公共承诺与 evaluator/projection 不得改变。当前原型只做 declaration-level anti-evasion 预检，没有逐前缀 obligation ledger、authoritative trace replay 或 violation-history 证明，因此只能输出 `UNVERIFIED_SEMANTIC_GATE`。

### 50.2 model-set 与 non-vacuity 检查

将 exact 核心的世界集元数据固定为：

```text
M_hat_manifest = (worldIds, worldSnapshots, generatorVersion,
                  closureDigest, preRegisteredAt, baselineId)
```

要求 `worldIds` 非空、快照对公共 cut 闭包、动作库非空、`baselineId` 与候选无关，且至少有一个非平凡 canonical positive case。规划器不能根据候选结果删除世界或调整 baseline；`M⊆M'` 时应满足 robust feasibility 的逆单调性：`FEAS_robust(M',π) ⇒ FEAS_robust(M,π)`。

当前 research checker 所实现的是下面规则的输入级近似；伪代码中的 `RobustResult` 和语义 gate 仍未实现：

```text
if !ContractComplete(C0): INPUT_INVALID(CONTRACT_INCOMPLETE)
if |M_hat|==0 or |A_typed|==0 or cost(π0)<=0: INPUT_INVALID(NON_VACUOUS_INSTANCE_REQUIRED)
if !PreRegistered(M_hat_manifest) or CandidateDependentFilter: INPUT_INVALID(WORLD_SET_NOT_FROZEN)
if !ObligationConservation(C0,Cπ): PLAN_REJECT(CONTRACT_WEAKENED)
if RobustResult(M_hat,π) changes to ACCEPT after deleting a declared hard world:
    MUTATION_FAIL(WORLD_SET_SENSITIVITY_VIOLATION)
```

当前复杂度若只检查冻结摘要与 supplied manifest 为 `O(|C0|+|O|+|M_hat|+|A_typed|)`；它是输入有效性/反例回归，不是完整 CP-RIR solver 或 D2 soundness。真正的 `RobustResult` 仍需在完整 finite product 上计算。

### 50.3 计划中的最小 mutation corpus

至少覆盖以下变体，并要求 fail-closed：

| mutation | 预期结果 | 防止的逃逸 |
|---|---|---|
| 删除 deadline/attempt/freshness/idempotence/auth 字段 | `CONTRACT_INCOMPLETE` | 用 schema 缺口隐藏义务 |
| 将 hard obligation 改为 soft/exception/manual | `CONTRACT_WEAKENED` | obligation laundering |
| 缩小 input domain 或强化 caller precondition | `CONTRACT_WEAKENED` | vacuous refinement |
| 改变 evaluator 或 observation projection | `CONTRACT_WEAKENED` | evaluator/projection laundering |
| 空 `M_hat` 或空 action library | `NON_VACUOUS_INSTANCE_REQUIRED` | reject-all/empty-world |
| 按候选结果删除困难 world | `WORLD_SET_NOT_FROZEN` | cherry-picking |
| 删除困难 world 后 robust 结果变强 | `WORLD_SET_SENSITIVITY_VIOLATION` | 非单调 world-set 过滤 |
| 令 baseline 必败或候选相关 | `BASELINE_INVALID` | 虚假 value gain/post-treatment collider |

当前实跑：contract-gate 正例输出 `UNKNOWN_INPUT_NOT_PROVEN / ...ROBUST_REPAIR_UNVERIFIED`，6/6 负例通过；model-set differential 正例输出 `...RESULTS_SELF_DECLARED`，6/6 负例通过。两者均为 `planned/unverified`。没有候选无关的独立 `Req*` registry、逐前缀 obligation ledger、独立 robust solver、锁定 root 和 complete finite product前，不得把这些门控写成 ContractComplete theorem、ObligationConservation theorem、world coverage 或 cross-organization privacy guarantee。

## 51. 第四十轮技术深化：逐前缀 obligation ledger（prototype/unverified）

新增 `ubuddy-cp-rir-obligation-ledger-v0.schema.json`、示例、checker 和 negative runner。registry 独立性与合同义务集合先做输入门控；随后 checker 根据事件语义重算每个 obligation 的五元计数：`issued/pending/satisfied/violated/cancelled`。`ACCEPT` 只有在每个 required obligation 达到 registry multiplicity 且无 pending/violated 时才可通过 supplied-trace replay；`COMPENSATE` 不改变历史 violated 计数，`projectedAway`、无 pending discharge、非法 cancel、重复 trigger 和无 witness discharge 均 fail-closed。

实跑结果：正例输出 `UNKNOWN_INPUT_NOT_PROVEN / OBLIGATION_LEDGER_REPLAY_SELF_CONTAINED_RUNTIME_UNVERIFIED`，账本中 `o1/o2` 均为 `issued=1,pending=0,satisfied=1,violated=0`；negative runner **6/6** 通过。该 checker 仍只重放 supplied sequence：`traceSourceStatus=SUPPLIED_NOT_AUTHENTICATED`，`obligationSemanticReplay=UNKNOWN_INPUT_NOT_PROVEN`，unknown 原因包括 `NO_AUTHORITATIVE_TRACE`、`NO_RUNTIME_EFFECT_REPLAY` 和 `NO_INDEPENDENT_REGISTRY_SIGNATURE`。

该工件实现的是 declaration/sequence-level accounting，不是完整 `ContractComplete_H` 或 `ObligationConservation_H` 定理。要升级为语义证明，仍需独立签名 `Req*` registry、逐前缀 authoritative runtime/effect trace、multiplicity/trigger monitor 的独立 oracle、历史违例单调性检查，以及与 D1–D2–G05 canonical root 的绑定。

## 52. 第四十一轮技术深化：ContractComplete/ObligationConservation separation fixture（prototype/unverified）

新增 `ubuddy-cp-rir-obligation-separation-v0.schema.json`、输入、checker 和 negative runner。checker 使用同一 registry 重放两个案例：案例 A 的合同 obligation set 缺失 registry 项，但事件账本自洽；案例 B 的合同 obligation set 完整，但 `TRIGGER→VIOLATE→ACCEPT` 被重算为 `FALSE_COMPLETION`。输出 `SEPARATION_PAIR_CHECKED`，并显式写入 `contractCompleteTheorem=NOT_PROVEN` 与 `obligationConservationTheorem=NOT_PROVEN`。

复杂度为 registry 索引加事件单遍历，约 `O(|Req*|+|events|)`；它只证明两个 gate 在 supplied declaration/sequence 层逻辑独立。3/3 separation negative 通过。尚未实现独立签名、authoritative trace、sink effect replay、`violatedEver` 跨 compensation 历史账本或 finite product，因此不得将 separation pair 写成端到端安全证明。

## 51A. 第四十轮技术深化补充：catalog-bound proof 与独立门控（planned/unverified，2026-09-01）

proof checker 新增 runtime catalog digest 重算和 branch/path/step/transition membership，负例 9/9；contract gate 加入 independent-declared normative registry，输出 `DECLARATION_LEVEL_PRECHECK_ONLY` 与 `obligationSemanticReplay=UNKNOWN_INPUT_NOT_PROVEN`，负例 8/8；model-set differential 负例 6/6；最小双困难世界 cross-sink fixture 保持 UNKNOWN。以上仅为 artifact integrity、集合关系和非空洞结构检查，不是 authoritative replay、signed proof、finite product solver、ESCROW 或 theorem。

### 第四十一轮 ledger 对抗性修正与残余边界

ledger v0 已增加 `instanceId`、pending/violated instance 集合、全局唯一 discharge witness、terminal ACCEPT、`violatedEver`、required-cancel 拒绝、unmediated effect 拒绝与 compensation historical prerequisite；negative corpus为 **10/10**。仍未关闭：registry metadata/digest authenticity；同一 violation 的重复 compensation token；witness 与 effect receipt/sink/issuer/nonce 的绑定；REMEDIATION/UNKNOWN 下的 trigger completeness。故输出继续 `SUPPLIED_PREFIX_REPLAY_ONLY / UNKNOWN_INPUT_NOT_PROVEN`。

## 53. 第四十二轮技术深化：metadata-bound ledger v1（prototype/unverified，2026-09-01）

新增 `ubuddy-cp-rir-obligation-ledger-v1.schema.json`、示例、checker 与 negative runner。`Req*` obligation 现在包含 `trigger/scope/deadline/discharge/compensation/multiplicity`，并通过 domain-separated canonical SHA-256 计算 registry/contract root。checker 对 supplied prefix 重算账本，拒绝 required/HARD metadata mutation、缺失 required trigger coverage、错误 sink/issuer/effect witness、receipt/nonce replay、重复 compensation 与 forged root。

正例输出 `METADATA_BOUND_LEDGER_REPLAY_RUNTIME_UNVERIFIED`；negative runner **10/10**。该工件仍不是签名 provenance 或 runtime conformance：registry signature 为 `NOT_IMPLEMENTED`，trigger/effect stream 与 previous ledger root 未认证，receipt 仅为 `SUPPLIED_UNVERIFIED`，因此任何 ACCEPT 仍 fail-closed 为 UNKNOWN。复杂度为 root 排序 `O(|Req*| log |Req*|)` 加事件单遍历 `O(|events|)`；未实现项继续标为 `planned/unverified`。

## 54. 第四十三轮技术深化：root authentication envelope（planned/unverified，2026-09-01）

新增 `ubuddy-cp-rir-root-auth-envelope-v0.schema.json`、示例、checker 与 negative runner。envelope 统一描述 `REQ_REGISTRY/CONTRACT/LEDGER_PREFIX` 三类 root 的 issuer、key lifecycle、signed root 和 verification status。checker 显式检查 root/key 绑定、有效期、撤销状态、轮换前驱和自报 VERIFIED/INVALID 的 fail-closed 规则；正例返回 `ROOT_AUTHENTICATION_NOT_IMPLEMENTED`，负例 **8/8**。

该工件没有执行 Ed25519/ECDSA 验签，也没有解析公钥、轮换链或撤销日志，因此只能作为 planned interface 与反例矩阵。只有接入独立 trust store、签名验证器和 authenticated rotation log 后，才可能把 `registrySignature` 从 `NOT_IMPLEMENTED` 提升；在此之前任何 root 仍是 integrity-only。

## 55. 第四十四轮技术深化：effect-complete bounded transfer checker（prototype/unverified，2026-09-01）

新增：

- `ubuddy-cp-rir-effect-complete-transfer-v0.schema.json`
- `ubuddy-cp-rir-effect-complete-transfer-v0.input.example.json`
- `ubuddy-cp-rir-effect-complete-transfer-checker-v0.mjs`
- `ubuddy-cp-rir-effect-complete-transfer-negative-v0.mjs`

checker 对每个 concrete transition 同时验证：

1. state/event map 是 total/function；
2. mediated/unmediated effect 的 `effectFootprint` 在 α 映射后保持；
3. effect 不能被伪装成 stutter，stutter 必须在 allowlist 且不改变 abstract state；
4. abstract step 与 monitor step 唯一可重放；
5. concrete terminal 必须闭合到 abstract/monitor terminal；
6. horizon frontier 未闭合时返回 UNKNOWN，而不是假定安全。

正例 `TRANSFER_SAFE` 探索 4 个 product states、2 个 terminal products，输出 `BOUNDED_EFFECT_COMPLETE_TRANSFER_PASS_RUNTIME_UNVERIFIED`。分离案例中 abstract planner+monitor 仍通过，但 concrete hidden effect 触发 `EFFECT_MAPPED_TO_STUTTER`。negative **8/8** 通过。该证据支持一个候选命题：effect-complete transfer 不是普通 planner 与 monitor 的事后串接；不过尚未形成一般 theorem、soundness proof 或 runtime evidence。

补充 `MULTI_EFFECT_ORDERED` 三步案例后，checker 在同一 product 上记录 `boundedInduction.status=INSTANCE_LEVEL_OBLIGATIONS_CHECKED`，并显式列出八项局部 obligation。该字段是 proof-obligation inventory，不是 theorem certificate；当 horizon 截断或前缀未闭合时仍返回 `HORIZON_FRONTIER_UNCLOSED`/UNKNOWN。

## 56. 第四十五轮技术深化：独立 proof-carrying certificate verifier（prototype/unverified，2026-09-01）

新增 `ubuddy-cp-rir-effect-complete-transfer-certificate-v0.*`。certificate verifier 不信任 checker 输出，而是根据 input digest 重载有限 LTS，逐条重算：state/event map、concrete/abstract edge、monitor edge、effect footprint preservation，并构造 certificate adjacency，从初始 tuple 做 BFS，拒绝不可达 terminal tuple。

正例输出 `CERTIFICATE_REPLAY_FINITE_ONLY`；negative **6/6** 通过，覆盖 input digest、effect/event map、terminal edge reachability、monitor edge 和 terminal tuple closure。证书没有签名字段或 key verification；因此是可复核的完整性/可达性 artifact，不是 authenticated proof 或一般 theorem。

## 57. 第四十六轮技术深化：exhaustive certificate v1（prototype/unverified，2026-09-01）

新增 `ubuddy-cp-rir-effect-complete-transfer-certificate-v1.schema.json`、示例、checker 与 negative runner。v1 verifier 不仅检查证书中已有边的局部合法性，还从 concrete initial state 按 depth BFS 重算所有 product successor：

```text
ExpectedEdges(H) = ⋃_{d < H} Succ(concrete, α, monitor, d)
CertificateEdges = ExpectedEdges(H)
```

两集合必须 exact 相等；terminal tuple 也必须 exact 覆盖，`reachableTupleCount` 必须匹配。正例输出 `EXHAUSTIVE_CERTIFICATE_REPLAY_FINITE_ONLY`；负例 **5/5**：`CERTIFICATE_EDGE_MISSING`、`CERTIFICATE_EDGE_SPURIOUS`、`REACHABLE_TUPLE_COUNT_MISMATCH`、`CERTIFICATE_HORIZON_UNCLOSED`、`TERMINAL_TUPLE_MISSING`。

该 verifier 仍不处理签名、真实运行时 effect、无限循环归纳或故障注入；`maxDepth` 后仍有出边时 fail-closed，不允许把 bounded enumeration 写成 general soundness theorem。

### 第四十六轮对抗性修订细节

v1 checker 增加 `CASE_SET_MISMATCH`、`HORIZON_BINDING_MISMATCH`、`INITIAL_STATE_RELATION_MISMATCH`、`INITIAL_BAD_PREFIX`、`TERMINAL_OUTGOING_UNCHECKED`、`TERMINAL_CLOSURE_FAILED` 以及 map/rule/abstract-transition 非函数检查。`PASS` 只允许 exhaustive edge/terminal replay；`COUNTEREXAMPLE` 必须提供可重放的 concrete violating path。修订后的 negative 为 **11/11**。这些仍是 certificate completeness guards，不是签名、runtime mediation 或无限状态归纳证明。

## 58. 第四十七轮技术深化：finite inductive relation checker（prototype/unverified，2026-09-01）

新增 `ubuddy-cp-rir-effect-complete-inductive-transfer-v0.*`。relation `R` 是显式 tuple 集合；对每个 `r=(c,a,m)∈R` 检查：`initial∈R`、concrete successor 必须落回 `R`、α/event/monitor/effect 保持、bad concrete 必须反射到 abstract bad 或 monitor violation、terminal concrete 必须闭合到两个 terminal。

`CYCLIC_MULTI_EFFECT_SAFE` 含 retry self-loop，relation size 4 即可闭合；`CYCLIC_HIDDEN_EFFECT` 的 hidden effect 映射为 stutter 时拒绝。negative **10/10**，覆盖 relation successor、initial relation、effect、bad reflection、terminal、monitor、map、非确定性和伪 counterexample。该 checker 不自动综合最小 relation，也不调用 proof assistant，输出继续 `FINITE_INDUCTIVE_RELATION_CHECKED_RUNTIME_UNVERIFIED`。

## 59. 第四十八至四十九轮技术深化：inductive relation structural checker v1（prototype/unverified）

v1 使用 `JSON.stringify([concrete,abstract,monitor])` 作为 tuple key，并在语义 replay 前验证 initial/terminal/bad/transition/rule 的 referential integrity、state/event map 引用、relation tuple 引用、非终态出边、terminal 无 outgoing，以及 relation 的 reachable closure。structural negative **8/8**，另有独立 delimiter-collision negative；输出继续 `FINITE_EXACT_INDUCTIVE_RELATION_CHECKED_RUNTIME_UNVERIFIED`。

这些是 verifier-level anti-vacuity guards，不是 relation 自动综合、最小性、proof-assistant certificate、签名、sink authority 或 liveness 证明。
