# uBuddy OCCC 代码修改计划 v4

> 对应 v70。当前只写计划，不修改源码。

## 1. 先做 reference model

新增：

```text
experiments/ubuddy_orgbench/formal/OCCC.tla
experiments/ubuddy_orgbench/formal/OCCC.cfg
experiments/ubuddy_orgbench/formal/README.md
experiments/ubuddy_orgbench/formal/counterexamples/
```

模型状态必须包含事件历史、happens-before、消息 multiset、durable/volatile monitor state、crash status、transfer registry、token generations、terminal tombstones、action footprints 和 certificates。

模型检查覆盖 T1–T3 的有界反例搜索；T4/T5 另写手工证明或 proof sketch，不能用随机测试冒充定理。

## 2. 数据模块

新增：

- `core/obligationTypes.mjs`
- `core/obligationSemantics.mjs`
- `core/obligationMonitor.mjs`
- `core/transferRegistry.mjs`
- `core/actionGateway.mjs`
- `core/obligationCertificate.mjs`
- `core/obligationClosure.mjs`

关键数据：

- immutable token generation；
- explanation boundary `B` 与 open frontier `F`；
- terminal tombstones；
- refinement `Comp_t`、semantic rank、resource footprint；
- root/generation/transfer nonce；
- ownership fencing version；
- vector causal prefix；
- effect pre/post hash 与 linearization point；
- append-only checkpoint、anti-rollback counter、certificate signer。

## 3. Explanation boundary reducer

- root 初始化为一个 Open token；
- REFINE 原子 tombstone parent，并创建完整 children/residual generation；
- child token global ID 唯一、single-parent、无环；
- B 保留 live leaves 与 terminal tombstones；F 仅为 live 子集；
- retry/attempt 不创建新语义 token；
- REVOKE 不重开旧 token，创建新 generation/compensation obligation；
- `checkLineageSafety`、`checkSemanticCoverage` 分开实现。

## 4. Refinement composition

提供有限组合类型：`SEQ`、`PAR`、`ALL`、`CHOICE`、`CONDITIONAL`。每种类型定义：

- trace/world composition；
- resource footprint 规则；
- realizability check；
- soundness/equivalence proof reference；
- well-founded child rank。

无法验证时返回 `coverageUnknown`，禁止 parent consumption。

## 5. Transfer registry 与 fencing

实现线性化 metadata registry：

```text
Owned(sender,v)
→ Offered(sender,receiver,transferId,v)
→ Owned(receiver,v+1)
```

- registry 分配唯一 root/generation/transferId；
- OFFER 后 sender 仍负责；
- receiver durable ACCEPT 与 `v→v+1` 同一事务提交；
- duplicate/reordered request 幂等；
- crash-recovery 读取 registry 恢复；
- action gateway 拒绝旧 fencing version；
- registry checkpoint 进入 certificate，防止隐藏 Owner。

## 6. Action gateway 与 effect compatibility

所有论文强主张覆盖的外部写入必须经过 gateway，或由同等强度的 storage observer 捕获。记录：

- obligation/generation/action/owner/fencing；
- object/resource footprint；
- input version、pre-state；
- action linearization point；
- change set、post-state；
- verifier version/result。

实现：

- `verifyEventObligation`；
- `verifyStableAtCutObligation`；
- `checkGlobalEffectCompat`；
- conflict/serializability/final-state recheck；
- stale witness 与 compensation obligation。

## 7. Monitor log 与 certificate

monitor log 需要 append-only checkpoint、anti-rollback counter 和 non-equivocation 检查。同一 root/generation/prefix 出现冲突 certificate 必须报 equivocation。

`alphaLocalStateToCertificate` 输出 canonical certificate；基础版本公开 boundary IDs，因此只声称隐藏内容，不声称隐藏结构。若后续需要结构隐私，再增加 accumulator/ZK proof，不能用普通 digest 冒充。

## 8. Certificate composition

`canonCompose(certSet, registryCheckpoint, cut)`：

1. 验签、freshness、generation；
2. canonicalize、dedupe、prefix dominance；
3. 检测 equivocation；
4. 从 registry checkpoint 求完整 owner set；
5. 验证 cut downward-closed；
6. 验证 boundary single ownership 和 transfer pairing；
7. 验证 resource algebra/effect compatibility；
8. 生成结构化 verdict 或最小 counterexample。

测试的是 canonical verdict 的顺序无关性，不要求证书字节相等。

## 9. Verdict

实现：

- `verifiedAtCut`；
- `obligationClosedAtCut`；
- `acceptedAtCut`；
- `coverageUnknown`；
- `stale/revoked`。

核心实现不生成 `finalizedSucceeded`。领域 finalization 另建模块后才允许增加。

## 10. Conformance 与验证

- implementation observable trace projection 必须属于 reference semantics traces；不要求内部事件逐字相同；
- full-state reference verdict 与 certificate verdict 在同一 cut 上一致；
- property-based crash/reorder/replay/equivocation/TOCTOU 攻击；
- model checking：shared child、cycle、double consumption、old-owner write、causal gap、conflicting stable effects；
- mutation lower-bound：删除等价语义信息后出现对应 indistinguishable pair；
- ground-truth world state、ROC annotator、certificate generator 三者独立。

## 11. 接入顺序

1. formal reference model；
2. token/tombstone reducer；
3. composition semantics；
4. transfer registry/fencing；
5. action gateway/effect compatibility；
6. monitor log/non-equivocation；
7. certificate abstraction/composition；
8. OrgBench fault replay；
9. AppWorld causal effect；
10. 替换 root success gate。

## 12. 最低验收

- B 对每个 root 始终为唯一 antichain，terminal tombstone 不丢失；
- refinement 非空、可实现且满足声明的 soundness/equivalence；
- crash/reorder/replay 下 ownership 唯一，旧 owner 写入被 fence；
- conflicting local effect witnesses 不能产生 root verified；
- registry checkpoint 能发现缺失 Owner/certificate；
- monitor rollback/equivocation 被拒绝；
- OCCC-cert 与 full-state reference 在同一 cut 上 verdict 一致；
- coordinator 不读取私有 DAG/内容；
- 任一未知假设显式返回 coverageUnknown。
