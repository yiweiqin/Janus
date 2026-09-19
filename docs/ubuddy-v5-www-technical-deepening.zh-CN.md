# uBuddy/Janus v5：WWW 技术深化

> 本文只在冻结的 Janus/uBuddy 技术基线上提出 Web-specific 形式化、算法、协议和实验方案。所有新增内容均为 `planned/unverified`，除非明确标注为已有 prototype；不修改源代码、API、数据库 schema、运行时协议或现有实验实现。

## 1. Web typed transition model（planned/unverified）

定义状态：

```text
s = (browserProfile, sessionEpoch, oauthSubject, tenant,
     apiVersion, etag, webhookCursor, sinkVersion,
     receiptState, hardLedger, disclosureBudget)
```

事件类型：`DOM_OBSERVE`、`HTTP_REQUEST`、`OAUTH_GRANT`、`API_RESPONSE`、`WEBHOOK_DELIVER`、`WEBHOOK_DROP`、`SINK_COMMIT`、`RECEIPT_QUERY`、`PROBE`、`REPAIR`、`ABSTAIN`。每个动作带 `ownerId、scope、readSet、writeSet、effectClass、cost、risk`。不可逆 effect（支付、发邮件、权限变更、工单关闭）必须显式进入 `writeSet` 和 hard contract footprint。

状态空间可分为 `Concrete × WebAbstract × ContractMonitor × Fault × RepairLedger`；当前系统没有该联合 product，故只作为论文模型。

## 2. Contract-Preserving Interventional Repair

给定公共 cut `h_pub`、候选世界集 `M_hat(h_pub)`、typed actions `A` 和不可修改合同 `C_hard`，计划 `π` 是一个有限 contingent tree。每个节点先执行零或多个低风险 probe，再决定 repair 或 abstain。

### 2.1 Web contract

```text
C_web = (scope, oauthScope, tenant, inputDomain, footprint,
         requiredEffects, projection, exceptionPolicy, expiry,
         attemptLimit, freshness, idempotenceKey, versionFence,
         evaluator, costModel)
```

`ContractComplete` 要求这些字段由候选无关 registry 锁定；`ObligationConservation` 要求 repair 不缩小输入域、不伪造前端 success、不把 OAuth denial/timeout 改成 success、不删除 webhook/effect obligation、不降低 version fence/idem/auth。`COMPENSATE` 只能产生新的 forward effect，不能把历史 violation 改写为未发生。

### 2.2 Probe support 与 abstention

为每个 probe 定义支持集 `Supp(p,h_pub) ⊆ M_hat` 和副作用上界 `Risk(p)`。只有在：

```text
Supp(p,h_pub) 非空；
∀m∈Supp(p,h_pub)，probe 可由声明 owner/scope 执行；
Risk(p) ≤ budget；
probe 不提交不可逆 sink effect；
```

时，planner 才能扩展模型后验。若多个世界仍对所有低风险 probe 给出相同观察且高风险 repair 的安全性不同，则返回 `ABSTAIN_UNTIL_PROBE_OR_CERTIFICATE`。该规则是 planned semantic condition，不是现有 runtime 能力。

## 3. 算法目标：PBES（Probe-Before-Effect Synthesis）

```text
PBES(h_pub, M_hat, A, C_web, B):
  reject if ContractComplete(C_web) is unknown
  reject if M_hat/A/support/owner certificate is empty or candidate-dependent
  for each finite contingent tree π in cost/risk order:
      compute reachable belief sets B_node ⊆ M_hat
      for each probe node:
          update B_node using declared observation partition
      verify hard contract and effect-footprint refinement on every m∈B_node
      compute V_rob(π)=min_m U(π,m), Δ_rob(π)=min_m(U(π,m)-U(π0,m))
      accept only if hard safety, value lower bound, and Pareto constraints hold
  otherwise return ABSTAIN/INFEASIBLE with an access-controlled diagnostic reference
```

计划中的 pruning：相同 belief、contract ledger、OAuth scope、version fence 和 remaining budget 的节点合并；不可合并时保留分支。该算法尚未接入 Janus runtime。

## 4. 多步 PBES belief-tree（prototype/unverified）

depth-1 只能证明“一个 probe 后立即 repair”的有限性质。为回应“只是 safe planning 小实例”的审稿意见，本轮定义有限深度 `H` 的 contingent belief-tree。节点状态为：

```text
n = (B_n, r_n, d_n, O_n, L_n)
```

其中 `B_n⊆M_hat` 是仍可能的 hidden worlds，`r_n` 是剩余 risk budget，`d_n` 是剩余 probe depth，`O_n` 是本分支已获得的 typed observations，`L_n` 是 hard-contract ledger/version fence/idempotence 状态。probe `p` 只允许在 `r_n≥Risk(p)`、owner/scope 支持存在、`p.effectClass=READ_ONLY` 且未重复执行时展开；按 `obs_p(m)` 对 `B_n` 分区。每个 cell 递归选择下一个 probe、universally-safe repair 或 `ABSTAIN`。相同 `(B_n,r_n,d_n,O_n,L_n)` 的节点 memoize 合并，避免把 belief-equivalent 分支重复计算。

v1 原型工件：`ubuddy-cpir-web-pbes-v1.schema.json`、`ubuddy-cpir-web-pbes-v1.input.example.json`、`ubuddy-cpir-web-pbes-checker-v1.mjs` 和 `ubuddy-cpir-web-pbes-negative-v1.mjs`。它在三个示例中覆盖二步 probe、预算耗尽和不可区分世界；仍是锁定 finite typed world table 的 `prototype/unverified`，不读取预期答案，也不宣称 runtime replay。当前 `safeByWorld` 由 fixture 声明，checker 只做逐 cell universal lookup；尚未从 typed transition 与 `C_web` 自动推导 action legality，因而只是 supplied-artifact consistency。

```text
Solve(B, budget, depth, observations, ledger):
  candidates ← universally-safe repairs in B satisfying contract/utility
  best ← cheapest safe repair or ABSTAIN
  if depth = 0: return best
  for each supported read-only probe p with Risk(p) ≤ budget:
      partition B by declared obs_p
      child[o] ← Solve(B_o, budget-Risk(p), depth-1, observations∪{o}, ledger')
      candidate ← p ; child[o]
      rank by repaired-world coverage, worst-path risk, cost, depth
  memoize and return best
```

该排序不把 soft utility 当 safety：任何 branch 只要违反 hard contract 就不能计为 repaired。若某 cell 无 universally-safe repair，分支必须 abstain；若所有可执行 probe 都无法进一步区分且高风险动作在不同 world 中安全性相反，则整个节点只能 abstain。当前用“repaired world count”选择 partial plan 只是 prototype heuristic，会随等价 world 的枚举方式变化；它不是 minimum-cost、Pareto-minimal 或 representation-invariant objective。正式算法需改为锁定 world measure/robust value，或输出非支配 plan set。

### 4.1 模型内证明草案（尚未机器证明）

**多步 bounded soundness。** 设 `M_hat`、contract registry、support table 在搜索前锁定且对每个节点闭包；所有 probe 为只读且风险累计不超过预算；并额外假设 `safeByWorld` 已由一个尚未实现的 transition/contract checker 正确推导。递归返回 `REPAIR` 的条件是该 repair 对 cell 内每个 `m∈B_n` 的声明 safety 为真且 utility 达标。对深度 `H` 归纳：`H=0` 时由 universal table lookup 直接成立；归纳步中 probe 按模型声明不改变不可逆 effect，观测只将 `B_n` 划分为子集，各子节点由归纳假设安全，故整棵 accepted tree 的每个 realized declared-model branch 均安全。该草案尚不能推出 `C_hard` 的真实保持，因为 transition-derived legality、漏建模 world、伪造 receipt、运行时竞态与 adapter bug 均未验证。

**Abstention necessity。** 若节点 belief cell `B` 中任意候选 repair `a` 都存在 `m_a∈B` 使 `Safe(a,m_a)=false`，且剩余支持 probe 的 observation 在 `B` 上均为常值，则任一仅依赖该 observation 的 fail-open 确定 planner 选出的 `a` 至少在 `m_a` 违反 hard contract；因此安全策略必须继续寻找带区分力的 certificate/probe，或 abstain。该结论只关于声明的 probe/action 集合，不声称现实世界已穷举所有观测。

### 4.2 复杂度边界

对最大深度 `H`、`W=|M_hat|` 个 worlds、`P` 个 probes 和 `R` 个 repairs，显式树最坏节点数为 `O(P^H)`，每个节点的 cell/repair 检查至多 `O(W(P+R))`；因此这是有限模型上的指数级搜索。memoization 可把实际复杂度降到 belief-state 数量 `N_B` 的 `O(N_B·W(P+R))`。固定 `H`、有限 observation alphabet 与受限 belief graph 时可研究 DP/FPT；当前不声称 NP-hard、#P-hard、近似比或完整求解器定理。

## 4.3 Contract-conflict hypergraph（planned/unverified；旧公式已废弃）

为了避免把 PBES 仅表述为通用 POMDP，本轮显式定义 Web contract 冲突对象。对锁定的 world 集 `M_hat` 与候选 repair 集 `A`，定义：

旧版 `Unsafe(a) ∪ Safe(a)` 公式恒等于 `M_hat`，不能表达冲突子集，已废弃。正确的高阶 edge 定义为：

```text
E_conf = { B ⊆ M_hat | B inclusion-minimal,
           ∀a∈A, ∃m∈B: Eval(C_web,m,a) ≠ SAFE }
```

其中 `Eval` 的结果是三值 `{SAFE, VIOLATED, UNKNOWN}`；`UNKNOWN` 不能当作 `SAFE`，也不能无条件当作 `VIOLATED`。只有当 `B` 上没有共同安全 repair，且每个 world 至少存在一个单世界可行 repair（non-vacuity）时，才把 `B` 记录为 conflict edge。pairwise edge 只是 `|B|=2` 的特例；必须保留三元及更高阶 edge。

实际实现使用更直接的 pair/edge 表：

```text
e = (worldSubset, obligationIds, unsafeRepairs, separatingProbeIds,
     minRisk, minDepth, certificateStatus)
```

其中 `worldSubset` 是 inclusion-minimal conflict subset；`obligationIds` 必须指向 tenant、subject、version、receipt、effect-cardinality 等 hard obligations；`witnessByRepair` 为每个 repair 提供至少一个违反 obligation 的 world。probe `p` 分离 `e`，当且仅当其 observation partition 在 `worldSubset` 上产生足以让每个叶 cell 获得共同安全 repair 的区分，或者明确生成 branch-level abstain。目标不再是最大化熵，而是覆盖 conflict edges，同时禁止 probe 本身触发不可逆 effect。

### 4.3.1 Abstention certificate

一个 declared-model certificate 为：

```text
Cert = (publicCut, conflictEdges, candidateProbeClosure,
        budget, depth, unsupportedScopes, terminalCells,
        witnessWorldByRepair, status)
```

`ABSTAIN_REQUIRED_DECLARED_MODEL` 只有在以下条件同时成立时才可生成：

1. `conflictEdges` 非空且每条 edge 都由至少一对 world 的 hard-obligation 分歧见证；
2. `candidateProbeClosure` 覆盖所有声明为可执行的 read-only probes；
3. 在给定剩余预算/深度下，对所有支持闭包内的 adaptive probe trees 都检查叶 cell；若叶 cell 没有 universally-safe repair，必须列出 branch-level `ABSTAIN` 原因。只有 closure 完整时，才能把它提升为全局 certificate；否则只能叫 `search-complete-under-declared-catalog`；
4. `witnessWorldByRepair` 为每个被拒 repair 提供一个违反 obligation 的 world；
5. certificate 本身不把“未观测”改写为“effect absent/failed”；`UNKNOWN`、`ABSTAIN`、`INFEASIBLE` 分开编码。

这些是有限声明模型上的 certificate checks，不等价于证明现实世界没有未建模 probe。

### 4.3.2 与 constrained POMDP 的诚实边界

任意有限 PBES tree 都可编码为 constrained POMDP policy；因此论文不能声称一般表达能力严格更强。可主张的差异是：

- state/action schema 直接暴露 Web contract obligations 与 effect cardinality，而不是把它们埋在 reward/constraint 黑盒中；
- 输出包含 conflict-edge 和 witness-world 的可审计 abstention certificate，而不是单一动作或 value；
- benchmark 以跨站 identity/version/receipt/effect ledger 标注 safety，而非仅以 episode reward 评价。

若实验无法证明这些 interface 和标注带来额外的 safety/diagnostic value，主贡献必须降级为 Web-specific formalization + benchmark，而不能包装成新 planner。

### 4.3.3 最坏路径最小 separating probe tree：NP-hard proof draft

定义判定问题 `BCS-TREE`：输入有限 worlds、repairs、确定性二元 read-only probes 及其非负 cost、预算 `K`；问是否存在一棵 adaptive probe tree，使每个叶 belief 都有至少一个 universally-safe repair，且任一 root-to-leaf probe cost 不超过 `K`。

从 Weighted Set Cover `(U,{S_j},c_j,K)` 归约：

1. 建立 worlds `M={w0}∪{w_u | u∈U}`；
2. 只有两个 repairs：`r0` 仅在 `w0` 安全，`r1` 在所有 `w_u` 安全而在 `w0` 不安全；
3. 对每个集合 `S_j` 建 probe `p_j`，cost 为 `c_j`；`p_j(w_u)=1` 当且仅当 `u∈S_j`，并令 `p_j(w0)=0`；
4. 所有 probe 都是确定性、二元、read-only，不产生不可逆 effect。

若存在 cost≤`K` 的 cover `J`，按任意顺序执行 `J` 中 probes；一旦观察到 `1`，belief 只含 element worlds，可执行 `r1`；全零路径因 `J` 覆盖 `U` 只剩 `w0`，可执行 `r0`。最坏路径是 `w0` 路径，cost≤`K`。

反之，若存在安全 BCS tree，沿 `w0` 的全零路径收集 probes `J`。若某元素 `u` 未被 `J` 覆盖，则 `w_u` 对路径上所有 probe 也返回 `0`，与 `w0` 到达同一叶；该叶不存在共同安全 repair，矛盾。因此 `J` 覆盖 `U`，且其 cost 不超过树的最坏路径预算 `K`。所以 `BCS-TREE` 至少 NP-hard，即使只有两个 repair、确定性二元只读 probe。该 proof draft 尚未经过同行或机器证明，不据此声称一般 PBES 的完整复杂度分类、NP-complete、近似界或 runtime hardness。

### 4.3.4 Partial repair 的非标量输出

当预算不足以分离全部 conflict edges 时，不能用 raw world count 作为论文目标。对 canonical conflict-edge registry `E_conf`，定义：

```text
Unresolved(T) = { e∈E_conf | 某个 abstain leaf 的 belief 完整包含 e }
Cost(T)       = worst-path action cost
Risk(T)       = worst-path probe/effect risk
```

理论算法返回 `(Unresolved(T),Risk(T),Cost(T))` 的 Pareto 非支配集合；`T1` 只有在 `Unresolved(T1)⊂Unresolved(T2)`、`Risk(T1)≤Risk(T2)`、`Cost(T1)≤Cost(T2)` 且至少一项严格时才支配 `T2`。只有 registry 预先给出 candidate-independent world measure `μ` 时，才允许进一步报告 expected/weighted coverage。v1 checker 的 repaired-world cardinality 仍只是 prototype heuristic，不等于 minimum-cost、inclusion-minimal 或 Pareto-minimal。

## 5. 协议/数据结构映射（冻结基线上的 adapter）

- 现有 P/E/lineage：映射为 Web event/effect/receipt 三元组；不改变原 API。
- browser/API adapter：把 DOM、HTTP、OAuth 和 webhook 观察转为 typed observation；`planned/unverified`。
- sink receipt adapter：要求 `effectId、sinkId、tenant、versionBefore/After、idempotenceKey、issuer、nonce`；当前只有 supplied fixture。
- Action Gateway：作为 owner/scope/version fence 的 planned TCB；不能把现有 gateway 名称当作已实现协议。
- public projector：只输出粗粒度 `ABSTAIN/UNKNOWN/SAFE_TO_CONTINUE`；固定长度不等于 privacy 或 process isolation。

## 6. 理论目标（尚未证明）

1. **Bounded soundness target**：若 `M_hat`、receipt/owner certificate、support 和 contract registry 均真实且 finite product 完整，则 PBES 接受的每条模型轨迹保持 `C_hard`。当前没有证明。
2. **Abstention necessity target**：若存在两个公共观察不可区分世界，所有低风险 probe 的 observation partition 相同，而任一高风险 repair 在其中一个世界违反 hard contract，则任何 fail-open planner 都不能同时满足安全性；CPIR-Web 应 abstain。当前只有反例设计。
3. **Complexity target**：显式 belief-tree 搜索为指数级；若 belief graph treewidth 或 horizon 固定，可研究 FPT/DP；不能直接声称 NP-hard、#P-hard 或近似比。

## 7. WWW benchmark 与实验矩阵

场景：跨站购物/支付、CRM→工单、日历→邮件、浏览器后台→SaaS API、OAuth scope 过期、API version drift、webhook drop/dup/reorder、sink commit 后 receipt 丢失。每个场景构造至少两个 paired hidden worlds 和一个非空 candidate-independent baseline。首批六个可执行 simulator 规格、trace envelope、gold effect ledger、fault timing、数据拆分与门槛见 `ubuddy-cpir-web-six-simulator-spec-v0.zh-CN.md`；当前均为 `planned/unverified`。

比较：retry、replan、reflection、日志/RCA、provenance-only、Saga/gateway-only、oracle-world、PBES（ablation：无 probe、无 contract gate、无 version fence、无 abstain）。

指标：contract violation rate、irreversible-effect error rate、abstention precision/coverage、`V_rob`、`Δ_rob`、worst cost、跨平台 observation alignment、token/latency；不得把一次成功率当作 causal efficacy。

实验状态：当前尚无真实 Web replay、OAuth trust-store、sink receipt 验签、浏览器进程隔离或 locked benchmark，均为 `planned/unverified`。旧版 schema/checker 只能作为 artifact/falsification 支撑。

独立 simulator 工件 `ubuddy-cpir-web-simulator-v0.mjs` 已接入 S1–S6，输出 `ubuddy-cpir-web-simulator-v0.output.json`。它固定 6 个场景、每场景 3 个 hidden worlds、5 个 deterministic seeds，共 90 条 traces；每条 trace 同时保存 public cut、hidden cause、policy result 和 gold effect ledger。独立 checker `ubuddy-cpir-web-simulator-checker-v0.mjs` 与 negative runner 已通过（5/5）。该结果仅是 `simulator/prototype` 证据：没有真实 browser/OAuth/payment/SaaS sink，不能外推 runtime safety 或真实 world coverage。

为降低自证风险，新增相互独立的研究模块：`ubuddy-cpir-web-world-catalog-v1.mjs` 只声明 world/contract/probe catalog；`ubuddy-cpir-web-policy-synthesizer-v1.mjs` 只生成 CPIR、safe-POMDP、active-diagnosis 和 one-step-diagnosis policy tree；`ubuddy-cpir-web-contract-evaluator-v1.mjs` 单独依据 catalog contract 评估 repair；`ubuddy-cpir-web-independent-baseline-runner-v0.mjs` 只负责组合与汇总。独立 runner 输出 6 场景×3 worlds×4 policies=72 rows，checker 通过。该拆分仍不能证明 catalog 与现实 Web 相符，但避免了由同一函数同时产出预期答案和评测标签。

独立 runner 的重要负结果：`safePOMDP` 在六个场景的安全/unknown 分布与 `cpir` 相同；`activeDiagnosis` 也与其相同，只有 `oneStepDiagnosis` 在 S1 和 S5 各产生一个 declared-model violation。由此不能声称 CPIR 的 policy 表达能力超过 constrained POMDP；当前可辩护的差异仅是 conflict-edge/certificate 接口和 effect-ledger benchmark。该结果是 simulator/prototype 证据，不是 runtime 或 population 结论。

## 9. 方法路线（仅关注新颖性与技术深度）

### 9.1 CACE-IL：Cross-plane Authority Continuity + Intent Lineage

一次不可逆 effect 的 admission envelope：

```text
E = (intentId,parentIntentId,attemptNo,lineageDigest,
     browserProfile,sessionEpoch,
     oauthIssuer,keyId,oauthSubject,audience,scopeSet,oauthEpoch,
     tenantId,tenantRevision,
     apiOrigin,apiVersion,etag,versionFence,
     effectId,effectClass,targetRef,idempotenceKey,
     publicCutDigest,observationRefs,coherenceKey,
     modelSetDigest,modelValidUntil,unsupportedScopes,
     verificationStatus)
```

只要 `subject/audience/tenant/resource` 中任一绑定无法由权威 snapshot 连续证明，或 session/tenant/API epoch 发生变化，envelope 就回退为 `ABSTAIN_*`；不能用 DOM success、普通 HTTP 2xx 或 planner 自报替代。该协议的技术难点是跨 origin alias、intent supersession、scope non-escalation 和 effect admission 的单点 fence，而不是增加字段。

### 9.2 RFRE：Receipt Freshness–Finality Reconciliation Envelope

receipt 状态：

```text
UNKNOWN < PENDING < COMMITTED_UNFINALIZED < FINAL_VERIFIED
```

旁路状态：`LOST_AFTER_COMMIT`、`STALE`、`REVOKED`、`CONFLICT`、`DUPLICATE`。只有 sink receipt verifier 同时确认 `effectId/idempotenceKey` 唯一、issuer/key 未撤销、generation/commitIndex 单调、version high-watermark 对齐、观察时间在 freshness window 内时，才允许 `FINAL_VERIFIED`。`FINAL_VERIFIED` 之后不得重试；commit 后 receipt 丢失只能 reconcile，不得盲重提交；compensation 记为新的 forward effect。

### 9.3 两阶段组合语义

```text
public cut
   ↓
 CACE-IL admission
   ↓ (only READY_FOR_EFFECT)
 irreversible sink linearization
   ↓
 RFRE reconciliation/finality
   ↓
 repair | reconcile | retry-same-key | abstain
```

可主张的最小定理包：

1. authority-continuity soundness：权威 snapshot 完整时，accepted effect 不跨 subject/tenant/audience；
2. stale-envelope rejection：epoch/version/intent supersession 不匹配时不可 admission；
3. receipt monotonicity：`FINAL_VERIFIED` 不回退，lost receipt 不被解释为 absent effect；
4. no-false-success：没有 final receipt 只能是 `UNKNOWN/IN_DOUBT`；
5. compensation non-erasure：forward compensation 不改变历史 violation。

这些性质目前是 `planned/unverified`，但比“PBES 是新 planner”更清晰、更有 Web 技术含量。

## 8. PBES depth-1 prototype（prototype/unverified）

工件：`ubuddy-cpir-web-pbes-v0.schema.json`、输入、checker 和 negative runner。每个 case 固定至少两个具有相同 `publicObservation` 的 world，probe 给出 `observationByWorld`，repair 给出 `safeByWorld/utilityByWorld`。算法不读取预期答案：

1. 计算无 probe 时是否存在对所有 world 均满足 safety 与 `utilityLowerBound` 的 repair；
2. 对每个低风险、无不可逆 effect、scope 可执行的 probe，按 observation 划分 belief cells；
3. 在每个 cell 中选择对全部 world 安全且 utility 达标的最低成本 repair；
4. cell 不存在安全 repair 时输出 ABSTAIN；
5. 最大化可修复 world 数，再最小化 probe+branch cost。

两条原型结果：

- `oauth-vs-webhook`：无 universally-safe repair；probe 后两个 cell 均可 repair，输出 `PROBE_CONTINGENT_PLAN`。
- `version-vs-committed-no-receipt`：probe 不区分两个世界，cell 无 universally-safe repair，输出 `ABSTAIN_NECESSARY_UNDER_DECLARED_MODEL`。

negative 6/6 覆盖候选相关 world set、公共观察不一致、probe/repair world coverage 缺失、重复 world/probe ID。

### 7.1 模型内性质

**Depth-1 safety lemma target**：若 world set 在搜索前锁定，probe 本身不产生不可逆 effect，且每个 observation cell 只选择对 cell 内所有 world 满足 hard safety 的 repair，则原型返回的每个 `REPAIR` branch 在声明模型内安全。当前由 checker 构造保证支持，尚未写成机器证明，且不外推到真实 world coverage。

**Abstention necessity target**：若某 belief cell 中不存在 universally safe repair，则任何只依赖该 cell observation 的确定 repair 都至少在一个声明 world 中不安全；安全 planner 必须继续 probe 或 abstain。这是有限集合上的直接反例论证，不代表所有现实 probe 已穷举。

### 7.2 复杂度

depth-1 显式实现对 `P` 个 probe、`W` 个 world、`R` 个 repair 的上界约为 `O(P·W + P·R·W + P·R log R)`；内存为 observation partitions 与 action table 的 `O(P·W+R·W)`。一般深度 `H` 的 contingent belief tree 最坏指数增长；尚未证明 FPT、hardness 或近似界。

### 7.3 与已有模块的不可替代性检查

- retry/replan：若没有显式 hidden-world cell 与 effect-safety universal check，会在两个世界中选择同一动作；
- provenance/RCA：可提供观察，但不自动产生 risk-bounded probe partition 与 repair legality；
- Saga/gateway：可约束提交，但不回答先 probe、repair 或 abstain；
- human confirmation：只有在呈现的问题能区分 world 或授权新证据时才增加信息，否则确认不能关闭 safety gap。

实现状态：仅 docs prototype；未接入 Janus/browser runtime。

## 10. P0/P1 可执行语义 v0（2026-09-01）

新增独立研究工件 `ubuddy-cpir-web-transition-evaluator-v0.mjs`，将 repair 评估拆为六个 obligation，并输出完整 `(obligationId, verdict, reasonCode, expected, actual, evidenceRefs)`。它不接受 `safeByWorld`，但仍只在 supplied typed snapshot 上运行，尚未定义真实环境 successor。

### 10.1 两层判定接口

后续 solver 不应把“动作可安全执行”和“任务已完成”混为一谈：

```text
Admit(C,S,a) ∈ {SAFE, VIOLATED, UNKNOWN}
Goal(C,S,a)  ∈ {SAT, UNSAT, UNKNOWN}

SafeTerminal(C,S,a)
  iff Admit(C,S,a)=SAFE ∧ Goal(C,S,a)=SAT
```

当前 evaluator 已增加 `terminalDisposition`：read-only `RECONCILE` 可以是 admissible `SAFE`，但在未证明 required effect 时必须保持 terminal `UNKNOWN`，不能进入 universally-safe terminal repair 集合。下一版 runner 必须基于 `SafeTerminal`，不能只看 action disposition。

### 10.2 已修复的反例

- effectful 语义由 `kind + effectDelta + writeSet` 决定；`RECONCILE(effectDelta>0)` 为 typed contradiction；
- COMMIT 缺 intent/effect/key/versionFence/requiredScopes/positive delta 时返回 `UNKNOWN`，不再默认为空 scope；
- OAuth expiry 或 evaluation time 缺失为 `UNKNOWN`；
- idempotence registry 必须绑定 intent/effect/tenant；
- receipt 必须绑定 sinkId/issuer/signature、versionFence、sink generation、commit high-watermark 和 trusted clock；
- RFRE 升级到 `NO_COMMIT/FINAL_VERIFIED` 需要 authoritative transition evidence；
- compensation 必须携带独立 typed forward contract/snapshot/action 并递归评估，不能只靠 contract ID 字符串。

### 10.3 AdmissionToken 与 terminal 语义（prototype/unverified）

effectful action 需要 `AdmissionToken`，并校验 tokenId、bindingDigest、nonce、expiry、signature/authority、未消费状态和 CACE `READY_FOR_EFFECT`。测试已覆盖 token replay 与 stale CACE。`COMMIT` 的 `SAFE` 现在只表示允许进入提交点；只有 `CLAIM_SUCCESS + FINAL_VERIFIED` 才能得到 terminal completion。`RECONCILE` 被强制 read-only 且永不 terminal。

### 10.4 尚未解决的核心深度

当前 CACE-IL 仍是 preflight predicate，不是原子 admission protocol：检查完成后到 sink commit 之间可能发生 OAuth revoke、tenant revision 或 version fence 变化。要真正形成 `continuous/linearized admission`，下一版 transition relation 必须由 sink 原子消费 `(tokenHash, envelopeDigest, intentId, effectId, tenantId, versionFence, idempotenceKey)`，并返回 `COMMITTED | REJECTED | NO_OP | UNKNOWN` 与 post-ledger delta。

P2 的 canonical witness atom 固定为：

```text
(worldId, actionId, obligationId, reasonCode,
 expected, actual, evidenceRefs, transitionId,
 preStateHash, outcome, postLedgerDelta, terminalStatus)
```

`VIOLATED` atom 进入 hard conflict；`UNKNOWN` atom只能进入 epistemic blockage。若某 world 没有任何 `SafeTerminal` action，它是 `INFEASIBLE_SINGLETON`，不得与其他 world 拼成 conflict edge。

## 11. P1.1 Cross-plane Linearization-bound Admission Token（finite prototype）

### 11.1 Transition relation

新增研究工件 `ubuddy-cpir-web-admission-transition-v0.mjs`，把提交点显式建模为：

```text
Reserve:
  stateRevision = r ∧ key absent ∧ token absent
  → RESERVED(token, r+1)

Consume:
  token = RESERVED ∧ expectedStateRevision = r
  ∧ bindingRevision/sinkGeneration/bootEpoch unchanged
  ∧ key reservation matches ∧ cardinality < locked bound
  → COMMITTED(receipt, r+1)

Finalize:
  receipt = COMMITTED_UNFINALIZED
  ∧ authoritative ∧ signatureVerified ∧ trustedClock
  ∧ token/receipt identity and generation/index match
  → FINAL_VERIFIED(r+1)
```

`createAtomicSinkStore` 用闭包保存当前 state；旧 revision 的 reserve/consume 会被拒绝，same-token replay 返回同一 receipt 的 `NO_OP`。这比单纯 snapshot predicate 更接近线性化语义，但仍是单进程研究模型，不能外推到真实 DB/sink transaction。

### 11.2 Cross-plane authority vector

Admission token 不再只绑定数字 epoch，而是固化：

```text
(intentId,effectId,tenantId,tenantRevision,
 browserProfile,sessionEpoch,
 oauthIssuer,oauthSubject,oauthAudience,scopeDigest,oauthEpoch,
 apiOrigin,apiVersion,versionFence,idempotenceKey,
 sinkId,sinkGeneration,bootEpoch,bindingRevision,stateRevisionAtReserve,
 tokenId,nonce,issuedAt,expiresAt)
```

这使 A→B→A fence、session rotation、OAuth subject rotation 和 sink restart 都产生不可复用的 revision/epoch 差异。它仍不证明 OAuth token 或 receipt 的密码学真实性；当前 hash 只是在受信 registry 假设下检测 supplied token 篡改。

### 11.3 已验证的 race/finality 反例

34 个测试覆盖：同 key 并发 reservation、旧 revision consume、identity-guarded token replay、version fence bump、session/OAuth rotation、A→B→A ABA、sink generation bump、future-issued token、immutable contract registry/cardinality、伪造 `NO_COMMIT` finality、receipt generation mismatch、cross-bound receipt/registry/state/cardinality mutation、统一 `step` pre/post hash witness 和 epoch/generation non-rollback。

### 11.4 仍不能主张的内容

- 不能称跨进程 atomic consume、exactly-once 或 crash-safe transaction；
- 不能称 cryptographic admission-token attestation 或真实 authoritative finality；
- 不能称已经解决 TOCTOU，只能称有限模型中对 state/binding revision race 的拒绝；
- CACE-IL 当前最准确名称是 `finite cross-plane admission transition specification`，若下一阶段没有真实 sink-side compare-and-consume 适配，应降为 formalization/interface。

### 11.5 P2 输入接口

下一版 conflict/blockage solver 接收：

```text
step(registry, state, event) → {
  transition: APPLY | STUTTER | REJECT | UNKNOWN,
  admitVerdict, goalVerdict,
  preStateHash, postStateHash, expectedStateRevision,
  obligations, linearizationWitness, receipt, postLedgerDelta
}
```

hard conflict 只由 `VIOLATED` terminal witness 构成；缺证据的 `UNKNOWN` 只生成 epistemic blockage。

## 12. P2/P3 设计输入（planned/unverified）

本轮独立技术复核后，下一阶段不再继续堆字段，而固定为四个可检验接口：

### 12.1 Versioned Coherence Cut（VCC）

浏览器、OAuth、tenant directory、API resource、sink 不能被假设为同一原子存储。每个 probe 只返回带 `sourceId/authorityId/revision/generation/validity interval/payloadDigest/signature` 的 evidence atom；aggregator 只有在 identity lineage、依赖 revision 和有效时间区间存在共同交集时才产生 `cutDigest`。reserve gateway 必须重新比较 cut 中所有关键 revision，不能信任 planner 自报的“coherent”。无共同交集返回 `FRACTURED_CUT`。

### 12.2 Probe-to-Reserve Evidence Escrow（PREE）

probe observation 绑定 `probeSessionId/challengeNonce/intentId/owner/scope/expiry`，原始 evidence 进入只读 escrow。reserve 只接受 `cutDigest + evidenceAtomIds + expectedStateRevision`，并在同一事务中验证 evidence、锁定 immutable contract registry、保留 idempotence key 和签发 AdmissionToken。probe 后任何 tenant/version/epoch 变化均产生 `STALE_PROBE`，不能复用旧 observation。

### 12.3 Two-stage Sink Receipt Finality（TSRF）

状态固定为 `NONE → RESERVED → COMMITTED_UNFINALIZED → FINAL_VERIFIED`，旁路为 `NO_COMMIT_VERIFIED/IN_DOUBT/REVOKED/CONFLICT/DUPLICATE`。`FINAL_VERIFIED` 必须引用之前唯一的 consumed token 和 `COMMITTED_UNFINALIZED` receipt；普通 404/timeout/HTTP 2xx 不能产生 `NO_COMMIT_VERIFIED` 或 finality。跨 generation 的历史 receipt 可审计，但不能授权当前 generation 新 commit。

### 12.4 Browser Context Epoch Broker（BCEB）

多 tab、Service Worker、BFCache 和导航恢复需要 `tabEpoch/pageEpoch/swEpoch/activationNonce`。BFCache `pageshow(persisted=true)`、SW controller change、profile/partition 变化必须撤销页面 token 并重新 probe/reserve；BroadcastChannel/Web Locks 只能做通知或性能优化，安全判定仍由 broker/sink registry 完成。

### 12.5 P2 统一 transition API

```text
step(Σ, event, immutableRegistry)
  → {transition: APPLY|STUTTER|REJECT|UNKNOWN,
     admitVerdict, goalVerdict,
     preStateHash, postStateHash,
     expectedStateRevision, linearizationWitness,
     token?, receipt?, blockage?}
```

`event` 包括 `PROBE_OBSERVED/RESERVE/CONSUME/FINALIZE/RECONCILE/COMPENSATE/ROTATE_EPOCH/CRASH_RECOVER`。registry 固定 `contractDigest/min/max/effectId/tenant/binding policy/allowed probe support/compensation refs`；action 不得自带或抬高 cardinality 上界。

## 13. P2.1 Admission-derived conflict/blockage execution（research-prototype/unverified）

新增 `ubuddy-cpir-web-admission-conflict-adapter-v0.mjs`，将上节统一 transition API 的有限实现接入 conflict registry。其输入是 immutable contract registry、initial sink state 和 typed admission plan；其内部固定执行：

```text
RESERVE(request)
  → CONSUME(token, action)
  → FINALIZE(receipt, authoritative evidence)
```

每个 action/world 的 evaluation 由 transition outcome 推导：

- 所有步骤成功且 `auditSinkState=SAFE`：`SAFE_TERMINAL`；
- 任一步 `REJECTED`：`VIOLATED`，并生成 `CACE_IL`、`RFRE`、`IDEM_UNIQUE`、`EFFECT_CARDINALITY` 或 registry witness；
- 任一步 `UNKNOWN`：`UNKNOWN`，只允许进入 `EPISTEMIC_BLOCKAGE`；
- contract/action 本身不可行：单例 `INFEASIBLE`，不能伪装成多 world conflict。

这使 P2 的核心对象从“对 safety table 做集合运算”变成：

```text
typed world state
→ linearization-bound admission transition
→ obligation-level rejection/unknown witness
→ SafeTerminal set
→ inclusion-minimal conflict/blockage edge
```

当前已验证的最小性质：

1. 两个只在 API version fence 上分裂的 world，对应两个不同 action plan 时生成二元 `HARD_CONFLICT`；
2. 缺失 immutable contract 时生成 singleton `EPISTEMIC_BLOCKAGE`；
3. 错误 contract digest 导致 singleton `INFEASIBLE`，不生成 edge；
4. terminal safe 必须同时满足 finality transition 和 sink invariant audit；单纯 `COMMIT` 不等于 terminal success。

测试工件 `ubuddy-cpir-web-admission-conflict-adapter-v0.test.mjs` 为 10/10；连同 typed evaluator、admission transition、conflict registry 的回归为 26 + 34 + 5 + 10 全通过。

### 13.1 技术含义与边界

该适配器提供了一个可检验的 **admission-derived Web effect conflict certificate** 接口：冲突边 witness 直接携带 transition reason、pre/post state hash、terminal status 和 sink audit，而不是由 planner 或 fixture 声明“该 action 安全”。这提升了技术深度，但仍不足以证明算法表达能力新颖。

仍需实现：probe evidence escrow、public-cut/closure certificate、跨进程 durable CAS、crash recovery、真实 authority verifier，以及与强 constrained-POMDP + 同一 verifier 的等价性对照。当前不得声称 runtime safety、exactly-once、cryptographic attestation 或真实 sink finality。

## 14. P2.2 VCC/PREE finite evidence semantics（research-prototype/unverified）

新增 `ubuddy-cpir-web-vcc-pree-v0.mjs`，把跨来源 evidence cut 明确为有限对象：每个 atom 绑定 `source/authority/keyRevision/probeSession/challenge/intent/effect/tenant/owner/scope/revision/validity interval/payloadDigest`。VCC 只在所有 required source 均有同一 probe/challenge/binding、当前时间有效、依赖 revision 满足且 authority registry（若声明）匹配时构造 canonical cut；否则返回 `UNKNOWN`。

PREE escrow 绑定 `effectId/tenantId/owner/scope`，具备 append-only `escrowRevision`、atom-id collision 检查和 cut digest。reserve 前必须从 escrow atoms 重建 `atomsBySource`、验证 source coverage、当前 validity interval、effect/tenant/session/challenge binding 和 expected state revision；无法重建或已消费的 cut 被拒绝。

当前验证 15 个断言：coherent cut、fractured interval、dependency revision mismatch、scope/owner/effect/tenant mismatch、stale probe revision、expired escrow、expired atom、forged cut、atom collision、Cartesian bound、escrow-store at-most-once 和未验证 signature 均有负例。状态仍是有限语义原型：`signatureVerified`/`authorityId` 是输入假设，不是密码学验证；`createEvidenceEscrowStore` 仅是单进程顺序存储，跨进程并发/崩溃持久性仍未实现。

### 14.1 复杂度和新颖性边界

当前默认 `UNARY_CANONICAL` 模式利用每个 atom 都必须在 reserve 时间有效的语义，逐 source 选 canonical candidate；复杂度近似为过滤 `O(N)` 加每源排序。为研究未来跨来源关系，保留显式 `CARTESIAN` 模式并设置 `maxCandidateCombinations`，超界 fail-closed 为 `UNKNOWN`。这避免把不必要的指数搜索误报为方法深度。

真正可辩护的技术对象是“probe/challenge/authority lineage 约束下的 cross-source cut refinement”，不是 interval intersection 本身。若成熟 stack 能提供同样的 atom provenance、cut 重建、reserve-time revalidation 和 fractured-read witness，则本模块应降级为 Web typed protocol interface。

## 15. ABCA profile：activation-bound coherent admission（planned/unverified）

为避免把 VCC、PREE、browser lifecycle 拆成三个“创新点”，当前将它们收敛成一个协议 profile：

```text
activation lineage
→ predecessor-coherent authority cut
→ challenge-bound escrow
→ reserve-time reconstruction/revalidation
→ sink admission/finality
```

最小 activation vector 为 `(activationRoot, tabEpoch, pageEpoch, swEpoch, partitionEpoch, activationNonce, partitionKeyHash)`。`pageshow(persisted=true)`、`controllerchange`、Service Worker restart、top-level navigation、storage partition/profile 变化都必须推进相应 epoch 或 nonce；旧 cut 在 reserve 时只能得到 `STALE_ACTIVATION_LINEAGE`，不能因墙钟 validity 仍未过期而继续提交。

当前 v0 已把 activation vector 与 atom、cut、escrow 绑定，并加入 reserve-time current-activation 比较；测试扩展到 17/17。尚未实现的是浏览器真实事件接入、authority predecessor/revocation DAG、签名密钥生命周期、durable cross-process escrow 和 sink-side atomic compare-and-consume。

### 15.1 四个必须锁定的正/负 pair

| pair | 正例 | 负例 | 目标性质 |
|---|---|---|---|
| AL | probe/reserve 同一 activation | BFCache/SW/partition 失效后复用旧 cut | activation non-revival |
| PC | downstream capability 的 predecessor 仍 ACTIVE | upstream revoke 已覆盖但下游局部仍新鲜 | predecessor/revocation closure |
| ER | cut 等于 escrow reconstruction，single-use | forged aggregate 或 crash-after-token | escrow refinement/durability |
| AN | `NO_COMMIT` 证据可分离 timeout worlds | committed/no-commit 不可区分 | abstention necessity |

每个 pair 都必须用独立 transition oracle 生成 gold verdict；候选与 baseline 共享 raw evidence、trust roots、fault schedule 和预算。

## 16. PC locked pair v0 与替代性证据（research-prototype/unverified）

工件：`ubuddy-cpir-web-pc-locked-pair-v0.mjs`。authority event log 记录 capability `ISSUE/REVOKE` 和 frontier revision；gold oracle 不读取候选 verdict，只从 event log 推导 predecessor 是否 ACTIVE。

结果：常见局部检查 baseline 对正负世界都返回 SAFE；ABCA 在 revoke world 返回 `PREDECESSOR_REVOKED_AT_SELECTED_FRONTIER`；最强成熟组合在获得同一 causal frontier verifier 后与 ABCA 等价。该结果验证了 predecessor closure 的必要性，也同时否定“ABCA 在该能力上天然不可替代”的强主张。

PC pair 当前只验证有限 authority log，不是真实 OAuth introspection/revocation endpoint，也没有签名、key rotation、delivery delay 或 equivocation。下一阶段不得重复做更多同型 fixture 来虚增深度；应转向 AOC 可重放 obstruction certificate 或 DRAS 偏序结构求解，并与通用 MUS/model checking 做严格对照。

## 17. Observation-aware AOC DP v1（research-prototype/unverified）

新增 `ubuddy-cpir-web-aoc-dp-v1.mjs`，把 obstruction/abstention 约束放回 observation cell，而不是对任意 world subset 直接做冲突枚举。递归定义：

```text
Win(K,b) = universally-safe terminal action
        ∨ separating probe p, cost(p)≤b, and ∀z: Win(K[p=z], b-cost(p))
```

若没有 universally-safe action，且预算内 probe 都无法让所有 child cells 赢，则返回 `LOSE`，并保留每个 losing probe/child witness。该实现采用 belief-cell + budget memoization，覆盖 informative probe、无 probe、无信息 probe和“错误 probe 不掩盖可行 probe”负例，8/8 通过。

这比旧 AOC wrapper 更接近正确的 probe–repair–abstain 算法对象，但仍不能称新 planner：它可直接表达为有限 constrained POMDP/active diagnosis。当前唯一可检验的算法闸门是与同一 transition oracle 的 robust-POMDP、model checking 和 deletion-MUS 比较状态展开、oracle calls、certificate closure 与成本；若等价则保留为 Web-specific certificate interface。

## 18. 当前算法边界与 oracle-v1 闸门

本轮 deletion-MUS 与 exhaustive registry 产生相同三元 core，故 AOC wrapper 的新算法主张淘汰。AOC-DP 只保留为 observation-aware bounded policy interface；它还缺少 terminal-cell minimal core、完整 transition trace、nondeterministic outcome-set 和独立 oracle。

下一版必须先冻结 candidate-independent `oracle-v1`：world/action/probe/fault manifest、contract hash、observation projector、trust roots、预算和 evaluator/verifier hash 均由 oracle 固定。AOC-DP、deletion-MUS、robust-POMDP 和强成熟组合必须消费同一 oracle 输出，timeout/bound 统一为 `UNKNOWN`。

最小正确性条件：world/action/probe ID 唯一；observation canonical digest；oracle 纯、确定、总（异常归 UNKNOWN）；belief cell 只按完整 transition projection 合并；每个 LOSE 节点给 terminal cell、最小 obstruction core 和所有 losing probe children；每个 WIN 节点给 terminal trace/linearization witness。当前这些是 `planned/unverified`。

## 19. Oracle-v1 冻结接口（research-prototype/unverified）

Oracle-v1 已实现为候选方法无关的有限 transition oracle，目的是防止 CPIR、robust-POMDP、MUS/MaxSAT 和成熟 Web stack 各自携带一份 `safeByWorld`。它不是 browser broker、OAuth 签名验证器、durable escrow/sink，也不是现实 runtime safety proof。

冻结输入包括：唯一 world/action/probe/fault ID，`contractRegistryHash`、`observationProjectorHash`、`transitionVerifierHash`、`trustRootHashes`，公共 projector、预算、finite hidden-world 初始状态、action guard/transition 和只读 probe projection。明确禁止 `safeByWorld`、`actionResults`、`probeResults`、`policy`、`candidate`、`expectedVerdict` 等答案或候选依赖字段。

```text
evaluate(manifest, worldId, actionOrProbeId, eventScheduleId, observationBudget)
  → { verdict: SAFE | VIOLATED | UNKNOWN,
       canonicalObservation, transitionTrace,
       preStateHash, postStateHash, linearizationWitness,
       activationVector, authorityAtoms/frontiers,
       escrowBinding, sinkLedgerDelta, witness, cost }
```

guard DSL 当前支持 `EQ/NEQ/DIGEST_EQ/TRUE/LTE_AFTER_DELTA/CAPABILITY_ACTIVE`。操作数缺失、authority frontier 不完整、timeout/bound/incomplete evidence、预算超限和异常均返回 `UNKNOWN`。AOC-DP 现在只接收物化后的 `(worldIds, actionIds, probes, oracleTables)`；任意 evaluator/observe callback 或 hidden world 对象会被拒绝。

当前测试：oracle-v1 `16/16`、oracle-only DP `6/6`、AOC-DP `8/8`。这只解决公平评测的基础 blocker，不证明算法新颖性。下一步是把 AL/PC/ER/AN 全部编译到同一 DSL，并让 deletion-MUS/MaxSAT、robust-POMDP/model checker 和强成熟组合共享 oracle，比较 verdict、certificate、linearization witness、状态展开、调用次数、时间/内存与 probe cost。

## 20. AL/PC/ER/AN 统一 manifest（research-prototype/unverified）

`ubuddy-cpir-web-oracle-locked-pairs-v1.mjs` 已将四类 pair 转为同一 oracle DSL：

| Pair | 关键 guard/transition | oracle 负例 |
|---|---|---|
| AL | activation vector digest equality | `STALE_ACTIVATION_LINEAGE` |
| PC | `CAPABILITY_ACTIVE` at authority frontier | `PREDECESSOR_REVOKED` |
| ER | signature、single-use、aggregate/reconstructed cut digest | `CUT_NOT_RECONSTRUCTIBLE` / `ESCROW_ALREADY_CONSUMED` |
| AN | `commitState=NO_COMMIT` 与 effect-cardinality bound | `COMMIT_AMBIGUITY_FORBIDS_RETRY` |

所有 pair 使用相同公共 observation projector；oracle 测试 `26/26`。这些 world state 仍是声明模型，不等价于真实 OAuth、浏览器或 sink 事件。下一步必须在同一 manifest/trace 上实现强成熟组合与 robust-POMDP，不能为每个 baseline 单独重写 gold。

## 21. Robust model-checker 对照与负结论

新增 `ubuddy-cpir-web-robust-model-checker-v1.mjs`，以不同代码路径执行 belief-state + budget DP；输入仍只允许共享 oracle tables。`ubuddy-cpir-web-oracle-baseline-comparison-v1.mjs` 对两类 consumer 做 canonical policy projection，并逐 world/action 比较同 verifier 下的 verdict、linearization witness 和 sink ledger delta。

当前结果：

- 可分 two-world fixture：AOC-DP 与 robust checker policy 等价，memo state 数相同；
- AL/PC/ER/AN manifest：两者 bounded policy 结论等价；由于当前 action catalog 没有覆盖所有失败分支的安全 repair，根节点均为 `LOSE`；
- strongest mature profile 若获得同一 transition verifier，逐 action trace 与候选完全等价；
- comparison 测试 `10/10`。

因此 AOC-DP 不再保留独立算法新颖性，ABCA/admission profile 也不再保留“不可由成熟组件复现”的协议主张。仍有技术价值的对象是统一 Web effect contract semantics、fail-closed oracle/certificate interface 和能揭示局部 freshness baseline 漏洞的 benchmark。后续技术深化应优先做 certificate information advantage、真实 browser/authority/durable-sink adapter 和 falsification coverage，而不是再实现同构 belief-tree solver。

### 13.2 复核修正

- finality evidence 不再由 adapter 默认自造；未提供权威证据时，`COMMITTED` 只能得到非 terminal 的 `UNKNOWN/RFRE`。测试专用 receipt 绑定必须显式声明，不代表真实签名验证。
- `expectedStateRevision` 的来源现在必须显式标记：`PLAN_EVIDENCE` 要求计划携带 revision，`GATEWAY_AT_EVENT` 才允许在模型线性化点读取当前 revision。
- sink audit 违例会形成 `EFFECT_LEDGER_AUDIT` atom，并进入 conflict/blockage witness。
- registry 使用显式 bounded enumeration（默认 `maxWorldClasses=20`），并保留 `MIXED_OBSTRUCTION` 记录，防止 unknown/violation 混合情形静默为 unresolved。

## 22. Certificate information gate（research-prototype/unverified）

新增 `ubuddy-cpir-web-certificate-information-v1.mjs`，比较 CPIR full obstruction certificate、generic model-checker full projection、mature-stack structured audit、native trace/audit 以及 MUS core。比较维度包括完整 transition replay、verdict replay、decision-evidence coverage、编码大小、cell 数和 commitment 一致性。

共享 oracle 上，CPIR 与 generic/mature full projection 完全语义等价；native profile 的差异只是字段覆盖；MUS core 不能完整重放 transition。当前只能报告“表示层信息增益”，不能报告“内在信息优势”。只有 baseline 获得同一 typed fields 后仍出现严格 replay、最小性、成本或诊断优势，才可恢复证书新颖性主张。测试 `18/18`。

## 23. 双故障 witness closure（research-prototype/unverified）

`ubuddy-cpir-web-oracle-double-faults-v1.mjs` 将 AL+PC、AL+AN、PC+ER、ER+AN 编译为同一个 action guard 集合。oracle 返回所有 violated guards，而不是只返回首个错误：例如 AL+PC 同时保留 activation 与 predecessor witness，PC+ER 同时保留 revoke 与 escrow reconstruction witness。timeout schedule 仍统一返回 `UNKNOWN`。测试 `17/17`。

这一步提升 obstruction certificate 的故障闭包和错误分析能力；不构成新 planner/protocol 证据，且完整 typed projection 与 generic/mature baseline 仍可等价 replay。

## 24. Durable escrow/sink research harness（research-prototype/unverified）

新增 `ubuddy-cpir-web-durable-sink-harness-v1.mjs`，使用 SQLite WAL、`BEGIN IMMEDIATE` 和显式 state revision 实现独立研究 harness；未触碰 Janus/uBuddy 数据库 schema。`ubuddy-cpir-web-durable-sink-harness-v1.test.mjs` 通过真实子进程验证 commit 后进程退出仍能识别已消费 token、stale revision 竞争只有一个成功、事务内失败回滚、idempotence key/effect cardinality/receipt-token binding/finality monotonicity 可审计。测试 `29/29`。这是本地 durable 语义证据，不等价于外部 Web 服务 exactly-once 或跨服务原子性；下一步仍需 browser lifecycle 和 authority signed-log adapter。

## 25. Signed authority event log（research-prototype/unverified）

`ubuddy-cpir-web-authority-signed-log-v1.mjs` 使用 Ed25519 签名、revision hash-chain、frontier completeness 和 equivocation detection；`SIGNED_CAPABILITY_ACTIVE` guard 已接入 oracle。测试 `12/12`。它把 PC pair 中的 `signatureVerified=true` 假设替换成可验证的本地事件日志，但仍不代表真实 OAuth endpoint、密钥轮换服务、consent 语义或跨域 authority authenticity。
