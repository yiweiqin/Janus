# CPIR-Web CACE-IL / RFRE 方法规格 v0

> 状态：`method-frozen-v0 + research-prototype/unverified`。本文只深化研究方法，不修改 Janus/uBuddy 源代码、API、数据库、运行时协议或既有实验实现。

## 1. 本轮要解决的技术问题

旧原型能够在有限 world catalog 中搜索 probe tree，但 repair legality 仍接近人工 world 标签。P0/P1 的目标是把合法性改成可检查的 Web transition predicate：同一个 intent 的授权、租户、版本、幂等键、sink effect 和 receipt 必须形成连续证据链；任何缺项返回 `UNKNOWN`，而不是自动视为安全。

本轮不把 PBES 当作新 planner。研究核心暂定为一个跨不可逆 effect linearization point 的双阶段协议：

```text
CACE-IL：提交前证明谁、以哪个 intent、在哪个 tenant/version 上可以产生 effect
                              ↓ irreversible linearization
RFRE：提交后证明 effect 是否发生、证据是否新鲜、是否已经 final
```

二者只有共享同一 `(intentId, effectId, tenantId, idempotenceKey, versionFence)` 时才能组合。单独的 continuous authorization 或 receipt reconciliation 都不足以构成主创新；潜在新颖性来自这条跨 browser/OAuth/API/sink 的端到端 effect identity。

## 2. 类型化研究对象

定义一次决策输入：

```text
I = (C, S, a, t)

C = hard contract
S = typed Web snapshot
a = candidate action
t = evaluation time
```

`C` 至少包含：预期 browser profile/session epoch、OAuth issuer/subject/audience/epoch、tenant、API origin/version、intent/effect identity、effect cardinality bound。

`S` 由六类带来源的事实组成：

1. `session`：browser profile、session epoch、tenant；
2. `oauth`：issuer、subject、audience、scope、epoch、expiry、tenant；
3. `envelope`：intent lineage、authority binding、tenant revision、API/version fence、effect/idempotence identity；
4. `resource`：authoritative tenant、API version、ETag/version fence；
5. `idempotency`：key 是否未使用、为同 intent 预留、已提交或被其他 intent 使用；
6. `effect/receipt`：effect cardinality、sink generation、commit index、freshness 和 finality。

候选 action 的类型限定为：

```text
PROBE | COMMIT | RECONCILE | CLAIM_SUCCESS | COMPENSATE | ABSTAIN
```

`COMPENSATE` 是新的 forward effect，必须有独立 contract；它不会删除历史 violation。

## 3. CACE-IL 状态机

```text
CREATED
  → SESSION_BOUND
  → OAUTH_BOUND
  → TENANT_BOUND
  → VERSION_FENCED
  → COHERENT
  → READY_FOR_EFFECT
  → COMMITTING
  → COMMITTED
```

任意一步出现以下事件，旧 envelope 不可继续使用：

- browser profile 或 session epoch 改变；
- OAuth issuer/subject/audience/epoch 改变或 scope 不足；
- tenant/tenant revision 改变；
- API origin/version、ETag/version fence 改变；
- intent 被 supersede，或 idempotence key 与 intent/effect 不再一一绑定；
- authority evidence 缺失、过期或来源不可信。

已知不匹配进入 `REJECTED/VIOLATED`；无法判断进入 `STALE/UNKNOWN`。只有所有 admission obligation 都为 `SAFE` 才能到达 `READY_FOR_EFFECT`。

## 4. RFRE 状态机

主状态：

```text
NONE → PENDING → COMMITTED_UNFINALIZED → FINAL_VERIFIED
```

可观察的额外状态：

```text
NO_COMMIT | UNKNOWN | LOST_AFTER_COMMIT | STALE | REVOKED | CONFLICT | DUPLICATE
```

规则冻结如下：

1. `FINAL_VERIFIED` 只能由权威 sink verifier 产生，并绑定 intent/effect/tenant/idempotence key、sink generation 和 commit index；
2. `FINAL_VERIFIED` 不允许回退成 `NO_COMMIT`；新证据冲突时进入 `CONFLICT`，不能覆盖旧 finality；
3. retry 只在 fresh、authoritative、coherent 的 `NO_COMMIT` 下使用同一 key；
4. `PENDING / COMMITTED_UNFINALIZED / FINAL_VERIFIED / LOST_AFTER_COMMIT` 均禁止盲 retry；
5. `UNKNOWN / STALE / REVOKED / CONFLICT` 要求 reconcile 或 abstain；
6. 只有 `FINAL_VERIFIED` 能支持 terminal success；HTTP 2xx、DOM success、普通 webhook 均不是 finality。

## 5. 六个 hard obligations

```text
Eval(C,S,a)
  = AUTH_CONTINUOUS
  ∧ TENANT_BOUND
  ∧ VERSION_FRESH
  ∧ IDEM_UNIQUE
  ∧ EFFECT_CARDINALITY_WITHIN_BOUND
  ∧ RECEIPT_POLICY_SATISFIED
```

每个 predicate 输出：

```text
(obligationId, verdict, reasonCode, expected, actual, evidenceRefs)
```

判定代数：

```text
若任一 obligation = VIOLATED，则 Eval = VIOLATED
否则若任一 obligation = UNKNOWN，则 Eval = UNKNOWN
否则 Eval = SAFE
```

`VIOLATED` 表示已有证据证明 action 会破坏声明 contract；`UNKNOWN` 表示证据不足，不能推出安全或不安全。两者的 policy 结果都应是 fail-closed，但 certificate 原因必须不同。

### 5.1 `AUTH_CONTINUOUS`

要求 contract、session、OAuth 与 envelope 的 profile/session epoch/issuer/subject/audience/OAuth epoch 一致，token 未过期，action 所需 scope 是当前 scope 的子集。

### 5.2 `TENANT_BOUND`

要求 contract、session、OAuth、envelope 和 target resource 的 tenant 相同。tenant alias 若没有权威映射证据，结果为 `UNKNOWN`，不能自行归一化。

### 5.3 `VERSION_FRESH`

effectful action 必须消费当前 resource fence；contract、resource、envelope 的 API origin/version 以及 resource/envelope/action fence 必须一致。read-only reconcile 不消费写 fence。

### 5.4 `IDEM_UNIQUE`

intent、effect 和 key 必须在 contract/envelope/action/registry 中一致；key 只能是 `UNUSED` 或 `RESERVED_SAME_INTENT`。已提交、重复或属于其他 intent 时为 `VIOLATED`；registry 状态未知时为 `UNKNOWN`。

### 5.5 `EFFECT_CARDINALITY_WITHIN_BOUND`

根据权威 ledger 的当前 cardinality 与 action delta 计算 projected cardinality。cardinality 缺失为 `UNKNOWN`；越界或 terminal action 未达到最低 effect requirement 为 `VIOLATED`。

### 5.6 `RECEIPT_POLICY_SATISFIED`

- 首次 commit：必须没有 prior ambiguous effect；
- retry：必须有 fresh authoritative `NO_COMMIT`；
- claim success：必须是 coherent `FINAL_VERIFIED`；
- reconcile：可以不宣称 finality；
- compensate：必须引用另一份 forward-effect contract。

## 6. 已实现的可证伪检查

独立研究工件：

- `ubuddy-cpir-web-transition-evaluator-v0.mjs`：六项 obligation 的三值 evaluator；
- `ubuddy-cpir-web-transition-evaluator-v0.test.mjs`：不读取 `safeByWorld` 的 26 个 action、证据、状态、终止性和 admission-token 断言。

当前覆盖：valid first commit、wrong tenant、stale version、missing scope、unknown cardinality、duplicate intent、fresh `NO_COMMIT` retry、unknown receipt retry、lost-after-commit retry、final success、unfinalized success、false success、bare finality、stale sink generation、跨 intent registry、缺 action 字段、写入型/terminal reconcile、compensation separate contract、admission token replay/stale CACE，以及 CACE/RFRE 状态不回退和 read-only reconcile 非 terminal。

这些检查只证明声明 snapshot 上的 evaluator 行为；没有证明 OAuth/receipt 真实性，也没有接入现有 policy synthesizer。状态仍为 `research-prototype/unverified`。

## 7. P0/P1 验收结论

P0 方法语义已冻结到 v0：状态、字段责任、三值判定、compensation 边界和 transition predicate 已明确。

P1 只完成“独立 evaluator 原型”，尚未完成“替换主链”：旧 world catalog/policy runner 仍使用旧扁平 evaluator。因此下一阶段不能直接进入真实 adapter，必须先完成以下迁移门槛：

1. 为 S1–S6 每个 world 构造 typed snapshot，而不是 `binding/auth/version` 简写；
2. 让 policy synthesizer 只调用本 evaluator；
3. 删除主链上所有 `safeByWorld` 和旧式 `SATISFIED` 特判；
4. 确认 `UNKNOWN` leaf 总是生成 epistemic blockage，而不是空 conflict list；
5. 用 obligation witness 驱动 P2 的高阶 conflict subset。

### P1.1 AdmissionToken（prototype/unverified）

effectful action 现在要求一个未消费、未过期、带签名/authority 标记的 admission token，并绑定：

```text
(tokenId, bindingDigest, nonce, intentId, effectId,
 tenantId, session/oauth epoch, versionFence, idempotenceKey)
```

evaluator 已检查 token 与 contract/action 的一致性、`READY_FOR_EFFECT` 状态和 replay；但还没有 sink-side atomic reserve/consume。因而这只是把 TOCTOU 风险显式化的研究接口，不是 runtime 原子性保证。

## 8. 接下来可以照做的工作包

### WP1：P1 主链迁移

输入：S1–S6 world catalog。输出：typed snapshot catalog + v2 runner。验收：四类关键负例由 predicate 自动失败，catalog 中不得出现人工 `safeByWorld`。

### WP2：P2 高阶 conflict/blockage

枚举 inclusion-minimal world subset `B`，满足没有共同 `SAFE` repair；单 world 无 repair 标为 `INFEASIBLE`，只有 `UNKNOWN` 阻塞标为 `EPISTEMIC_BLOCKAGE`。验收：必须通过三元高阶 edge、共同 repair 消边、unknown singleton 三组反例。

### WP3：P3 closure certificate

输出完整 probe closure、terminal cells、每个 rejected repair 的 `(world, obligation, witness)`、unsupported scope、budget/depth 和 losing child。验收：删除 separating probe 后 certificate 必须变化；新增 universally-safe repair 后对应 edge 必须消失。

### WP4：新颖性闸门

把同一 evaluator 同时提供给 CPIR 和强 safe-POMDP。若二者在 action、certificate、risk/cost 上完全等价，则停止“新 planner”主张；只保留 CACE-IL/RFRE 的 Web effect protocol 与 proof-carrying benchmark。
