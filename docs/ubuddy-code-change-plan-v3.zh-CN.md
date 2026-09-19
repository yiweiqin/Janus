# uBuddy OCCC 代码修改计划 v3

> 本计划对应 v69。当前不修改源码。v3 的首要目标不是先接入 OrgBench，而是先建立可执行 reference semantics、守恒不变量和证书组合模型；否则实现只能证明工程行为，不能支撑论文定理。

## 1. 第一阶段：Reference semantics 与模型检查

新增独立模型目录：

```text
experiments/ubuddy_orgbench/formal/
  OCCC.tla
  OCCC.cfg
  invariants.md
  counterexamples/
```

若团队更熟悉 Alloy/PlusCal，可替换工具，但必须覆盖：

- 状态 `Σ=(R,O,G,F,H,E,V,C,e)`；
- `REGISTER/REFINE/OFFER/ACCEPT/ATTEMPT/REDEEM/EXCEPT/SEAL/ADVANCE_EPOCH/REVOKE`；
- obligation uniqueness、single-parent hyperedge、acyclicity、frontier antichain；
- durable accept、ownership fencing、crash recovery、duplicate/reordered delivery；
- causal vector cut、certificate replay protection；
- T1 conservation、T2 compatibility、T3 cut-relative soundness；
- T0 trace-only impossibility witness、T4 progress/liveness rank、T5 observation-projection lower-bound cases；
- bounded counterexamples：共享 child、refinement cycle、hidden open leaf、迟到 handoff、TOCTOU、旧 owner redemption。

模型检查不是最终数学证明，但必须先于业务代码，作为 reducer 的规范来源。

## 2. 数据模型

新增：

- `core/obligationTypes.mjs`
- `core/obligationReferenceSemantics.mjs`
- `core/obligationLedger.mjs`
- `core/obligationCertificate.mjs`
- `core/obligationClosure.mjs`

使用明确代数状态，禁止自由字符串随意转移：

```text
Open(ownerId, ownershipVersion)
Offered(senderId, receiverId, transferId, ownershipVersion)
Redeemed(witnessId)
Excepted(exceptionId)
```

obligation 需要：`obligationId`、`rootId`、`parentRefinementTxId`、`semanticRank`、`denotationRef`、`required`、`epochNonce`、`status`。

refinement transaction 需要：`txId`、`parentId`、`childrenIds`、`residualIds`、`proofRef`、`proofMode`、`parentConsumedMarker`。

certificate/effect 需要：`signer`、`attestationRef`、`rootNonce`、`epochNonce`、`vectorClock`、`boundaryNamespace`、`completenessWitness`、`input/output state hashes`、`linearizationPoint`、`ownershipVersion`、`verifierVersion`。

## 3. 受信 local obligation monitor

实现 monitor API，application agent 不能直接写 ledger terminal state：

- `registerRootContract`；
- `proposeRefinement` / `commitRefinement`；
- `offerTransfer` / `acceptTransfer`；
- `recordAttempt`；
- `submitEffectWitness`；
- `exceptObligation`；
- `sealCausalFrontier`。

monitor 必须：

- 幂等处理重复事件；
- 对 tx/transfer/witness 做 root+epoch nonce 防 replay；
- 原子提交 parent consumption 和 children/residual creation；
- 持久化 durable accept 后递增 ownership fencing version；
- 拒绝旧 owner/version 的 redemption；
- 从完整 reducer state 生成 frontier set commitment 与 completeness witness。

无真实 TEE 时，实验实现应明确标为 `trusted_monitor_process`，不能把普通 hash 宣称为 Byzantine 安全证明。

## 4. Derivation hypergraph 与守恒检查

替换 explanation path 逻辑为 hypergraph：

- child/residual token 全局唯一；
- 每个非 root token 恰有一个 authoritative parent transaction；
- parent 只能被一次成功 transaction 消费；
- 拒绝 cycle、共享 child、重复 terminal consumption；
- retry 使用 attempt lineage，不创建新的语义 token；
- joint obligation 使用显式 group，不复用 token ID。

实现 `deriveFrontier(root, state)` 和 `checkConservationInvariant(state)`；其行为必须与 reference semantics 做 trace-by-trace conformance test。

## 5. Ownership transfer 与 crash recovery

实现状态机：

```text
Owned(sender,v)
→ Offered(sender,receiver,transferId,v)
→ Owned(receiver,v+1)
```

- OFFER 后 sender 仍负责；
- receiver durable ACCEPT 是 ownership version 的线性化点；
- sender 恢复后看到更高 fencing version，旧 action 不能 redeem；
- transfer message 可重复/乱序，但同 transferId 结果幂等；
- crash after OFFER/before ACCEPT、after ACCEPT/before sender acknowledgement 均有测试。

底层若依赖数据库事务，论文必须明确该假设与性能成本，不能把数据库提供的线性化声称为 OCCC 创新。

## 6. Effect witness

AppWorld bridge/领域 adapter 必须返回：

- action ID 和 obligation ID；
- actual input object/version；
- pre-state hash；
- action commit/linearization point；
- observed change set；
- post-state hash；
- verifier ID/version/result；
- ownership fencing version。

防止：action 写 v1、外部更新到 v2、verifier 只看到 v2 成功的 TOCTOU。仅有最终当前状态的 evaluator 不能生成 causal redemption，只能生成 observation evidence。

## 7. Causal certificate 与组合器

证书包括 vector clock/causal frontier，而非单 scalar high-watermark。`composeCertificates` 必须：

- 验证签名、root/epoch nonce 和 freshness；
- 验证 completeness witness 来源于 trusted monitor；
- 规范化 boundary 后检查全局 disjointness；
- 固定点计算 authoritative accepted-transfer owner set；
- 验证 receipt pairing 和 fencing continuity；
- 检查 causal cut downward-closed；
- 在 canonical form 上测试组合结合性、交换性、幂等性；
- 对冲突返回结构化 counterexample，不返回布尔 false。

## 8. Verdict 状态

实现并区分：

- `verifiedAtCut`；
- `finalizedSucceeded`；
- `obligationClosed`；
- `accepted`；
- `coverageUnknown`；
- `reviewRequired`；
- `stale/revoked`。

没有领域 finalization/fencing 条件时，禁止生成 `finalizedSucceeded`。revocation 只撤销 verdict；不可逆外部副作用需要新的 compensation obligation。

## 9. 验证体系

### 9.1 模型与性质

- TLA+/Alloy bounded model checking；
- property-based adversarial generation；
- reference semantics ↔ implementation conformance；
- certificate composition permutation tests；
- mutation tests：删除每类语义信息后必须出现对应 counterexample。

### 9.2 必测攻击/故障

- duplicate child/two parents；
- refinement cycle；
- non-transitive certificate overlap；
- hidden authoritative transition bypass attempt；
- replay old certificate across root/epoch；
- scalar-clock false cut；
- OFFER/ACCEPT crash windows；
- old-owner redemption；
- effect TOCTOU；
- exception/effect late race；
- new event after seal；
- vector clock causal gap。
- exception accepted 后迟到 failure/revocation。

### 9.3 T0/T4/T5 的可执行检验

- 对固定 ROC 构造 trace-only 观察等价的 valid/invalid replay，验证 T0；
- 记录 `progressRank(state)` 的每步变化，检测是否违反良基下降或出现无界 epoch；
- 对四类语义信息执行 mutation/observation projection，验证是否能生成 T5 的成对反例；
- reducer 与最终 outcome oracle 必须独立，不能从同一事件生成器同时产生合同和真值。

## 10. 接入顺序

1. reference semantics + bounded model；
2. pure reducer + conformance tests；
3. hypergraph/frontier invariant；
4. handoff fencing + crash recovery；
5. effect causal witness；
6. local monitor certificates + composition；
7. cut-relative verdict；
8. OrgBench fault replay；
9. AppWorld real effects；
10. 最后替换现有 root completion gate。

## 11. 最低验收标准

- reference model 在设定状态界内无 T1/T2/T3 反例；
- T0/T5 成对不可区分运行满足预期 lower-bound 结果；
- implementation 对 reference traces 100% conformance；
- 任何 authoritative root token 在所有事件前缀都有唯一 frontier/terminal explanation；
- 所有 crash/reorder/replay 场景不产生重复 ownership 或错误 redemption；
- OCCC-cert composition 与 full-state monitor 对同一 cut 的 verdict 一致；
- coordinator 无需读取私有 DAG；
- 没有 finalization 条件时系统只输出 `verifiedAtCut`；
- ROC/effect/certificate 任一 unknown 都显式阻止事实成功。
