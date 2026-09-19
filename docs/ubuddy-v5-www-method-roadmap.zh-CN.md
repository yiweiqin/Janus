# CPIR-Web 后续方法路线图 v0

> 目的：把当前研究收敛成可以逐步执行的方法路线。本文只评审创新性和技术深度，不讨论论文排版、投稿措辞或当前 Janus runtime 改造。所有新增协议和 solver 均为 `planned/unverified`，除非另有标注。

## 1. 先做出的研究决策

### 不再作为主创新

- `PBES/belief-tree`：有限 policy 可被 constrained POMDP 表达，不能宣称新 planner。
- `conflict hypergraph` 单独命名：若只是把 safety table 画成图，属于表示层，不够新。
- `provenance / causal RCA / gateway / Saga / FSM / checker`：只作为支撑或 baseline。

### 当前保留的三条主线

1. **CACE-IL（Cross-plane Authority Continuity + Intent Lineage）**：在不可逆 effect admission 前，证明 browser session、OAuth subject/audience/scope、tenant、API version fence、intent lineage 和 target resource 属于同一授权连续性。
2. **RFRE（Receipt Freshness–Finality Reconciliation Envelope）**：在 timeout、webhook drop/dup/reorder、receipt 丢失和 sink commit 后，区分 effect 已发生、已最终确认、仅暂不可见；没有 freshness/finality 证据就不能重复 effect。
3. **Proof-carrying Web effect benchmark**：以 conflict edge、authority/receipt witness 和 gold effect ledger 作为评测对象，而不是只看任务成功率。

CACE-IL 与 RFRE 是互补的 admission/post-linearization 两阶段语义。PBES 只是调用二者的 policy interface；如果后续强 POMDP 加入同样的 verifier 后结果相同，论文应诚实定位为 Web protocol/formalization/benchmark，而不是 planner 创新。

## 2. 统一研究对象

每个 Web effect `e` 必须关联：

```text
E = (intentId, attemptNo, lineageDigest,
     browserProfile, sessionEpoch,
     oauthIssuer, oauthSubject, audience, scopeSet, oauthEpoch,
     tenantId, tenantRevision,
     apiOrigin, apiVersion, etag/versionFence,
     effectId, effectClass, targetRef, idempotenceKey,
     receiptId, sinkGeneration, commitIndex,
     freshnessDeadline, finalityState)
```

跨平面 observation 只有在 `coherenceKey=(intentId,sessionEpoch,tenantRevision,apiVersion,versionFence)` 相同时才可合并。DOM/HTTP 2xx/webhook 不是最终 effect 证据；OAuth issuer、tenant directory、API gateway、sink receipt verifier 是待明确的 authority boundary。

## 3. 分阶段执行顺序

### Phase 0：定义冻结（先做，不能跳过）

交付：`CACE-IL` 与 `RFRE` 的状态机、字段语义、三值结果 `{SAFE, VIOLATED, UNKNOWN}`、scope/owner/support 规则、effect cardinality、compensation 非 rollback 规则。

过关标准：任何字段都能回答“谁签发、绑定哪个 intent/tenant、何时过期、对应哪个 sink effect、缺失时返回什么”；不允许只增加字段而没有 transition predicate。

### Phase 1：Transition-derived legality

交付：把 repair legality 从 fixture `safeByWorld` 改为 `Eval(C_web,m,a)`：

```text
Eval = AUTH_CONTINUOUS
     ∧ TENANT_BOUND
     ∧ VERSION_FRESH
     ∧ IDEM_UNIQUE
     ∧ EFFECT_CARDINALITY_WITHIN_BOUND
     ∧ RECEIPT_POLICY_SATISFIED
```

每项都必须有可失败的 predicate；unknown 不得自动转 safe。输出 `SAFE/VIOLATED/UNKNOWN`，并记录 obligation witness。

过关标准：删除/增加一个 obligation 会可预测地改变 legality；构造 wrong tenant、stale version、unknown receipt、duplicate intent 四类负例，不能靠预填 safe table 通过。

### Phase 2：高阶 conflict edge 与 certificate

交付：

```text
E_conf = { B inclusion-minimal | ∀a∈A, ∃m∈B: Eval(m,a)≠SAFE }
```

要求支持 `|B|>2`，并区分：

- `CONFLICT`: 至少一个 repair 在每个 edge world 中失败，且每个 world 有单世界可行 repair；
- `INFEASIBLE`: 某 world 没有任何可行 repair；
- `UNKNOWN`: authority/effect evidence 不足；
- `ABSTAIN`: 当前 policy 选择不提交，不等价于数学不可行。

certificate 至少包含：`publicCut`、完整 probe closure、剩余 budget/depth、每个 terminal cell、每个 rejected repair 的 witness world+obligation、unsupported scope、closure status。若没有完整 closure，只能输出 `SEARCH_COMPLETE_UNDER_DECLARED_CATALOG`。

过关标准：

1. 两 world 有共同安全 repair时不得生成 edge；
2. 两 world 全部同样不可行时标 `INFEASIBLE`，不得伪装 `CONFLICT`；
3. 构造“三 world、两两有共同 repair、三者无共同 repair”时必须生成三元 edge；
4. 删除一个 separating probe 后 certificate 必须变为 branch abstain 或 unresolved edge；
5. 增加一个 universally-safe repair 后相应 edge 必须消失。

### Phase 3：CACE-IL admission protocol

交付：`CREATED→SESSION_BOUND→OAUTH_BOUND→TENANT_BOUND→VERSION_FENCED→COHERENT→READY_FOR_EFFECT→COMMITTING→COMMITTED`；任意 epoch、issuer、tenant revision、ETag、intent supersession 变化都使旧 envelope stale。

核心性质目标：

- authority continuity；
- no cross-tenant effect；
- no stale-intent commit；
- no scope escalation；
- stale envelope rejection。

注意：这些是 declared authority snapshot 下的有限性质，不是现实 OAuth authenticity 或 exactly-once。

### Phase 4：RFRE reconciliation protocol

交付：`UNKNOWN→PENDING→COMMITTED_UNFINALIZED→FINAL_VERIFIED`，并行异常态 `LOST_AFTER_COMMIT/STALE/REVOKED/CONFLICT/DUPLICATE`；只允许在权威 `NO_COMMIT`、envelope fresh、idempotence key 未使用时 `RETRY_SAME_KEY`。

核心性质目标：

- receipt monotonicity；
- no false success；
- effect cardinality upper bound；
- webhook cursor/tenant/effect coherence；
- compensation 不擦除历史 violation。

### Phase 5：算法层重新定位

PBES 保留为调用接口：选择 probe tree，但不再主张 planner 表达力新颖。可研究的算法问题是：在 canonical conflict-edge registry 上，最小化 `(unresolvedEdges, risk, cost)` 的 Pareto frontier；BCS-TREE 的 Set Cover hardness 仅作为待独立证明的理论支撑。

## 4. 停止条件与重做条件

若完成 Phase 2 后，强 constrained-POMDP + 同一 CACE/RFRE verifier 能生成完全相同的 certificate、风险和诊断成本，则停止“新 planner”路线，主线定为 Web effect-contract formalization + auditable protocol + benchmark。

若 CACE-IL 只是把 idempotence key 改名为 intentId，或 RFRE 只是普通 timestamp freshness check，则淘汰并重做；必须覆盖跨 tab/session epoch、OAuth subject/tenant alias、sink generation/commit index 和不可逆 effect admission。

## 5. 当前状态

- 已有：finite PBES v0/v1 prototype、synthetic six-scenario simulator、初步 conflict evaluator。
- prototype/unverified：world catalog、policy/evaluator 分离、simulator trace/checker、P0/P1 独立 transition evaluator。
- method-frozen/prototype-unverified：CACE-IL/RFRE v0 状态机、六项 obligation predicate、三值判定、compensation 边界和单调性检查。
- planned/unverified：把 typed snapshot 迁移到 S1–S6 主 runner、高阶 conflict certificate、公开 Web replay。
- 明确未实现：真实 OAuth/tenant trust、sink receipt authenticity、runtime mediation、exactly-once、rollback、privacy、population efficacy。

### P0/P1 本轮执行记录（2026-09-01）

- 新增 `ubuddy-cpir-web-transition-evaluator-v0.mjs`：不读取 `safeByWorld`，从 contract、typed snapshot 和 action 推导 `SAFE/VIOLATED/UNKNOWN`。
- 新增 `ubuddy-cpir-web-transition-evaluator-v0.test.mjs`：26 个 action、证据、状态、终止性和 admission-token 断言，全部通过。
- 新增 `ubuddy-cpir-web-cace-rfre-method-v0.zh-CN.md`：冻结状态机、obligation 语义、验收门槛和后续工作包。
- 当前只完成独立 evaluator 原型；旧 `ubuddy-cpir-web-contract-evaluator-v1.mjs` 与 runner 尚未迁移，因此不能写成 P1 主链完成。

### P1.1 Admission transition 执行记录（2026-09-01）

- 新增 `ubuddy-cpir-web-admission-transition-v0.mjs`：定义 reserve → consume → receipt-finalize 的有限 transition relation、`stateRevision`/`bindingRevision`、token hash、sink generation 和 receipt ledger。
- 新增 `ubuddy-cpir-web-admission-transition-v0.test.mjs`：34 个 transition、竞争、篡改、audit、step-witness 断言全部通过。
- 研究模型新增 authority vector：`browserProfile、OAuth issuer/subject/audience/scopeDigest、tenantRevision、session/oauth epoch、sink bootEpoch/generation`。
- `createAtomicSinkStore` 只提供单进程同步 CAS-like 语义；跨进程、数据库事务、崩溃恢复和真实签名仍为 `planned/unverified`。

### P2.1 Admission-derived conflict registry 执行记录（2026-09-01）

- 新增 `ubuddy-cpir-web-conflict-registry-v0.mjs`：从逐 world/action evaluation 生成 inclusion-minimal `HARD_CONFLICT` 与 `EPISTEMIC_BLOCKAGE`，并隔离 `INFEASIBLE` singleton；等价 evaluation signature 的 world 复制不会改变 registry。
- 新增 `ubuddy-cpir-web-admission-conflict-adapter-v0.mjs`：registry 的 evaluation 不再接受手工 `safeByWorld`，而是实际执行 `RESERVE → CONSUME → FINALIZE` transition，返回 disposition、terminalDisposition、obligation witness、trace、pre/post state hash 和 sink audit。
- 新增端到端测试：版本 fence 分裂产生二元 hard conflict；缺失 contract 产生 epistemic blockage；错误 contract digest 产生 infeasible singleton；复核后 10/10 通过，admission transition、typed evaluator、conflict registry 总计 26 + 34 + 5 + 10 全部通过。
- 该适配器仍是 finite single-process `research-prototype/unverified`。它证明的是 declared transition relation 到 conflict witness 的可执行闭环，不证明跨进程原子性、真实 authority authenticity 或 planner 新颖性。

### P2.2 VCC/PREE 执行记录（2026-09-01）

- 新增 `ubuddy-cpir-web-vcc-pree-v0.mjs`：定义 evidence atom、canonical coherence cut、probe-session/challenge escrow 与 reserve-time cut revalidation。
- 修复并覆盖 forged cut、expired atom、effect/tenant reuse、atom ID collision、signature-unverified、stale escrow revision 和 concurrent clone-return 边界；测试为 15/15。
- 默认采用 `UNARY_CANONICAL` 逐源选择，避免把不必要的 Cartesian 指数搜索误当技术贡献；`CARTESIAN` 仅作为显式受限研究模式，超出 bound 返回 `UNKNOWN`。
- 该工件提升了 VCC/PREE 的语义严谨性，但尚未实现 durable atomic escrow、真实签名/authority verifier、跨来源 predecessor graph 或 BFCache/SW activation lineage。

### P2.3 ABCA activation profile（2026-09-01）

- 将 VCC/PREE 与 browser activation lineage 收敛为单一 `Activation-Bound Coherent Admission (ABCA)` profile，不再平铺新增协议名。
- atom/cut/escrow 新增并绑定 `activationRoot/tabEpoch/pageEpoch/swEpoch/partitionEpoch/activationNonce/partitionKeyHash`；reserve 必须提供 current activation，BFCache/SW/partition 变化导致 `STALE_ACTIVATION_LINEAGE`。
- VCC/PREE 测试扩展为 17/17；仍为 `research-prototype/unverified`，因为真实 browser event、predecessor/revocation closure、signature verifier 和 durable atomic store 尚未实现。
- 下一步采用四个 locked pairs：Activation lineage、Predecessor/revocation、Escrow refinement、Abstention necessity；不允许只用最终任务成功率作为证据。

### P2.4 PC locked pair 结果（2026-09-01）

- 新增 predecessor/revocation authority-log oracle 与 PC+/PC− paired worlds，8/8 通过。
- 常见局部成熟组合无法分离 PC−；ABCA 可用 revoke frontier witness 拒绝。
- 最强成熟组合加入同一 causal frontier verifier 后与 ABCA 等价。因此 predecessor closure 保留为必要协议能力，但不再作为“不可替代新协议”证据。
- 下一步不继续堆同类 protocol fixture；转向 AOC obstruction certificate 或 DRAS solver 的算法/证书闸门。

### P2.5 Observation-aware AOC DP（2026-09-01）

- 淘汰 AOC wrapper 的新算法主张；新增 `ubuddy-cpir-web-aoc-dp-v1.mjs`，在 observation cell 和剩余 budget 上递归，并输出 losing probe/child witness。
- 8/8 测试通过；该工件只证明正确的 belief-cell fail-closed 语义，不证明超越 constrained POMDP。
- 下一步算法闸门固定为：candidate-independent oracle、same raw evidence、robust-POMDP/model-checking/deletion-MUS baseline、状态展开/调用次数/证书闭包比较。

### P2.6 AOC/DP 负新颖性闸门（2026-09-01）

- deletion-MUS 与 exhaustive registry core 相同；AOC wrapper 降级为 replay/checker interface。
- AOC-DP 作为 observation-aware bounded policy interface 保留，但未声称新 planner；下一步先实现 candidate-independent oracle-v1 和 terminal-cell obstruction core，再做 robust-POMDP/强成熟组合对照。
- AL/ER/AN locked pair 只能作为 counterexample fixtures；没有独立 oracle 和关键 interleaving replay，不计作协议定理或算法证据。

### P2.7 candidate-independent oracle-v1 执行记录（2026-09-01）

- 新增 `ubuddy-cpir-web-oracle-v1.mjs`、`ubuddy-cpir-web-oracle-v1.schema.json` 和 `ubuddy-cpir-web-oracle-v1.example.json`。
- oracle 接口固定为 `evaluate(manifest, worldId, actionOrProbeId, eventScheduleId, observationBudget)`，输出 verdict、canonical observation、transition trace、前后状态 digest、linearization witness、activation/authority/escrow/sink 字段和 cost。
- manifest 冻结 `contractRegistryHash`、`trustRootHashes`、`observationProjectorHash`、`transitionVerifierHash`、world/action/probe/fault 唯一 ID 和预算；digest 使用域分离 canonical JSON。
- action verdict 不再读取预填 `safeByWorld/actionResults/probeResults`。action 由声明的 guard DSL（`EQ/NEQ/DIGEST_EQ/TRUE/LTE_AFTER_DELTA/CAPABILITY_ACTIVE`）和有限 state transition 推导；probe 由只读 projection 推导。候选依赖字段、重复 ID、未声明对象均拒绝。
- timeout、bound、incomplete evidence、缺失 authority/receipt、预算不足和异常统一 fail-closed 为 `UNKNOWN`；该语义只覆盖冻结 finite manifest，不代表现实 Web 的完备 oracle。
- 新增 `ubuddy-cpir-web-aoc-dp-oracle-v1.mjs`：AOC-DP 先物化 oracle 表格，再只消费 `(worldIds, actionIds, probes, oracleTables)`；任意 evaluator/observe callback 或隐藏 world 对象都会被拒绝。
- 测试：oracle-v1 `16` 个断言、oracle-only DP `6` 个断言通过；原 AOC-DP `8` 个断言保持通过。新增工件均标记 `research-prototype/unverified`。

本轮不提高“算法新颖性”评分。oracle 解决的是候选自证和公平比较的基础 blocker，而不是新的 planner；下一闸门仍是同一 oracle 上的 robust-POMDP、deletion-MUS/MaxSAT 和强成熟 Web stack trace/certificate 等价性比较。

### P2.8 AL/PC/ER/AN oracle 编译执行记录（2026-09-01）

- 新增 `ubuddy-cpir-web-oracle-locked-pairs-v1.mjs`，把四类 locked pair 编译为 guard/transition/projection manifest；不再调用原 pair 的 gold/evaluator 函数。
- 新增 `ubuddy-cpir-web-oracle-locked-pairs-v1.test.mjs`：26 个断言通过，覆盖 activation stale、predecessor revoke、escrow forged/replay、timeout/receipt ambiguity、相同 public observation 以及 fault schedule 的 `UNKNOWN`。
- 该编译仍是 finite manifest 原型；PC 的 authority log、ER 的 reconstruction、AN 的 commit state 目前是声明的 world state，不是外部真实 authority/sink。

### P2.9 robust model-checker 等价性负结果（2026-09-01）

- 新增独立 `ubuddy-cpir-web-robust-model-checker-v1.mjs` 和共享 oracle comparison runner。
- 在具有 winning contingent policy 的 two-world fixture 上，AOC-DP 与 robust checker 输出相同 probe/policy、相同 memo state 数；在 AL/PC/ER/AN 统一 manifest 上，两者同为 `LOSE` 并给出等价 bounded-policy 结论。
- 使用完全相同 transition verifier 的 strongest mature profile 与候选在逐 world/action 的 verdict、linearization witness、sink delta 上 trace-equivalent。
- 10 个比较断言通过。这是有限 fixture 上的负新颖性证据，不是真实 Web baseline 实验。

据此继续执行停止条件：停止 AOC-DP/ABCA 的独立 planner/协议新颖性叙事。后续主线固定为 `Web typed effect-admission formalization + replayable certificate interface + falsification benchmark`；除非以后在预注册的复杂度、成本、信任假设或证书信息量上出现严格优势，才允许重新打开算法主张。
