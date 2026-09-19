# uBuddy OCCC 代码修改计划 v2

> 本文件只描述后续实现，不代表本轮已经修改源码。实现目标必须服从 v68 的研究语义：核心是义务解释守恒与局部证书组合，不能退化为一个新的 `done` 布尔值。

## 1. 实现不变量

每个 root/epoch 必须维护一个 explanation forest 和当前 frontier。对每个 root，叶子只能处于 `open | redeemed | excepted` 之一；parent 只有在有效 `children + residual` proof 后才能被替换。普通 task `done/cancelled/blocked` 不得改变 obligation frontier。

必须满足四个独立谓词：`CoverageClosed`、`OwnershipClosed`、`RedemptionClosed`、`CutValid`；只有四者同时成立才可生成 `verifiedSucceeded`。同时保留每项失败原因和 `unknown`，禁止单布尔压缩。

## 2. 数据结构与事件

涉及：

- `experiments/ubuddy_orgbench/schema.mjs`
- 新增 `experiments/ubuddy_orgbench/core/obligationLedger.mjs`
- 新增 `experiments/ubuddy_orgbench/core/obligationClosure.mjs`
- 新增 `experiments/ubuddy_orgbench/core/obligationCertificate.mjs`

每条 obligation 记录：`obligationId`、`rootObligationId`、`epoch`、`parentObligationId`、`ownerId`、`kind`、`required`、`status`、`attemptId`、`objectRefs`、`evidenceRefs`、`proofMode`、`verifierVersion`。

至少支持事件：`obligation_committed`、`obligation_refined`、`obligation_derived`、`obligation_residual_recorded`、`handoff_offered`、`handoff_accepted`、`artifact_consumed`、`effect_observed`、`obligation_discharged`、`obligation_excepted`、`frontier_sealed`、`completion_close_requested`、`completion_closed`、`completion_revoked`。

## 3. 义务解释守恒 reducer

实现纯内存、可重放 reducer：

1. root 只能在 registered-before-use 后 mint 一次；
2. `refined` 必须同时提交 children、residual 和 proof；
3. proof `unknown` 不得消费 parent；
4. parent 只能被一次合法 refinement 替换；
5. retry/reassign 生成新 attempt 或新 leaf，保留 lineage；
6. failed/blocked/timeout 不得删除 live leaf；
7. 每个叶子只能被一次 `discharged` 或 `excepted` 消费；
8. 任意事件前缀都能导出 root explanation partition 和 frontier digest。

## 4. 局部证书与组合器

`SEAL(owner, epoch)` 输出 `LocalClosureCertificate`，至少包含：

- root/lineage boundary commitments；
- open/redeemed/excepted frontier commitments 与数量；
- incoming/outgoing matched handoff receipts；
- ledger high-watermark；
- consumed object/version、effect change-set 与 evidence root；
- schema/policy/verifier 版本；
- trust/attestation mode。

实现 `composeCertificates(certificates, root, epoch)`：

- 只沿匹配 handoff 求 `deriveReachableOwners`；
- 证书必须覆盖且仅覆盖可达 Owner；
- 检查 boundary disjointness、receipt pairing、epoch/high-watermark/version 一致性；
- residual/open/late/revoked 必须显式进入失败原因；
- 证书缺少 sound trust mode 时返回 `untrusted_certificate`，不得 verified success；
- 组合失败不能静默降级为 task done。

## 5. 四个 verifier 与状态机

涉及：`core/obligationClosure.mjs`、`core/stateGraph.mjs`、`orgbench_experiment.mjs`、`evaluators/metrics.mjs`。

- `verifyCoverageClosure`：root mapping、lineage、children+residual、proof mode、coverage unknown；
- `verifyOwnershipClosure`：唯一 current owner、双边 receipt、可达 Owner、seal、trust mode；
- `verifyRedemptionClosure`：required leaf 的 action、实际输入版本、effect、verifier evidence；
- `verifyCutValidity`：epoch/high-watermark、迟到事件、版本漂移、revocation。

状态必须区分：`obligationClosed`、`verifiedSucceeded`、`accepted`、`exceptionSet`、`stale`、`revoked`、`reviewRequired`。`accepted` 只能由 policy 明确允许的完整 exception set 产生，不能反向伪装成事实成功。

## 6. 与现有 OrgBench/AppWorld 接口接入

涉及：`core/scenario.mjs`、`core/policy.mjs`、`schemas/task-gold.schema.json`、`appworld_bridge.py`。

- 从用户确认约束或 evaluator gold 建立 ROC；
- 把 selected action、实际 consumed object/version、change-set 和 verifier result 绑定到 obligation；
- LLM 只能提出 refinement candidate，proof 由确定性规则、solver、review 或领域 evaluator 产生；
- L2/L3 不可 operationalize 语义进入 `coverage_unknown/review_required`；
- 私有 Owner 只输出证书边界，不把 prompt、memory、本地路径写入共享投影。

## 7. 测试门槛

新增：`core/obligationClosure.test.mjs`，扩展 `tests/orgbench_core.test.mjs`。

必须覆盖：root 重复 mint、漏映射、residual 丢失、unknown proof、LLM 自报 coverage、parent 重复 refine、retry lineage 丢失、blocked child + root done、无 evidence、旧版本消费、单边 handoff、匹配前责任删除、动态 receiver 未进入静态名单、可达 Owner 未 seal、无 trust mode、证书边界重叠、不同 epoch 证书、seal 后新义务/迟到反证、revocation、exception、正常单 Owner/多 Owner 收敛。

每个测试除检查最终状态，还要检查 reducer 不变量和可重放结果一致性。

## 8. 实施顺序

1. 纯内存 explanation forest、frontier reducer 和不变量测试；
2. LocalCertificate schema、seal 和组合器；
3. 四个 verifier 与状态分离；
4. 接入 OrgBench synthetic faults；
5. 接入 AppWorld 实际 action/effect evidence；
6. 加入动态 Owner、迟到事件、版本撤回和隐私过滤；
7. 最后才替换现有 root completion gate。

## 9. 最低验收标准

- 任意 root/epoch 都能导出不重复、不遗漏的 explanation partition；
- 无证书或证书不可组合时不得 `verifiedSucceeded`；
- blocked/failed child 不能被 root 静默覆盖；
- `coverage_unknown`、untrusted certificate、stale evidence 都只能阻止或降级；
- 有限、证据齐备、无冲突的单 Owner/多 Owner 流程最终必须 `verifiedSucceeded`；
- seal 后迟到冲突能使旧 closure `stale/revoked`。
