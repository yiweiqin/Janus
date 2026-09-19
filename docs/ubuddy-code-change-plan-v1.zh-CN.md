# uBuddy 代码修改计划 v1（仅计划，不修改源码）

本文件把 OCCC 的实现拆成可验证阶段；本轮不执行源码修改。

本文件已由最终版 `ubuddy-code-change-plan-final.zh-CN.md` 取代；后续实现以最终版为准。

研究语义以 `ubuddy-pain-points-and-innovations-v67.zh-CN.md` 为准。实现必须分别计算 `CoverageClosed`、`OwnershipClosed`、`RedemptionClosed` 和 `CutValid`，只有四者同时为真才能产生 `verifiedSucceeded`。obligation ticket 只是可选内部编码，不应成为对外创新主张。LLM 只能提出 coverage/refinement 候选，不能签发 proof；无 sound certificate trust mode 时只能标记 `coverage_unknown`。在有限、证据最终齐备且无冲突的 epoch 中，四项 verifier 必须最终收敛，禁止实现成 always-reject。

## 1. 数据模型

涉及文件：

- `experiments/ubuddy_orgbench/schema.mjs`
- 新增 `experiments/ubuddy_orgbench/core/obligationLedger.mjs`
- 新增 `experiments/ubuddy_orgbench/core/obligationClosure.mjs`

增加事件：`obligation_committed`、`obligation_refined`、`obligation_derived`、`obligation_projected`、`obligation_operationalized`、`artifact_consumed`、`effect_observed`、`obligation_discharged`、`obligation_excepted`、`frontier_sealed`、`completion_close_requested`、`completion_closed`、`completion_revoked`。

每条事件包含：`obligationId`、`rootObligationId`、`ownerId`、`epoch`、`parentObligationId`、`evidenceRefs` 和相关版本。

## 2. Root Obligation Contract

涉及文件：

- `experiments/ubuddy_orgbench/core/scenario.mjs`
- `experiments/ubuddy_orgbench/core/policy.mjs`
- `experiments/ubuddy_orgbench/schemas/task-gold.schema.json`

实现目标：

1. 从用户确认约束或 evaluator gold 建立 ROC，而不是只生成 capability requirements；
2. 为每条根义务生成稳定 `obligationId`；
3. 记录 `coverage_unknown`；
4. 检查每条根义务至少映射到一个子义务或本地 action；
5. 检查每个子义务都能追溯到根义务，或显式标记为 `local_system_obligation`；
6. refinement 必须同时记录派生 children 与未被派生覆盖的 `residualObligations`，禁止用“已有一个子任务映射”冒充完整 coverage；
7. 每次 refinement 记录 `proofMode=machine_checked|review_signed|unknown`、verifier/reference 和验证结果；`unknown` 不能消费 parent ticket；
8. 为每个 root/epoch 导出当前叶子后代分区，保证每个 leaf 恰处于 open/redeemed/excepted，不能缺失或重复；导出 ticket transition audit，确认 parent 只能被一次合法 `refined` 替换，叶子只能被一次 `discharged`/`excepted` 消费。

## 3. Owner append-only ledger

涉及文件：

- 新增 `experiments/ubuddy_orgbench/core/obligationLedger.mjs`
- `experiments/ubuddy_orgbench/core/stateGraph.mjs`

必须支持单调 high-watermark、append-only 追加、幂等、父子引用、跨 Owner handoff 双边 commitment、frontier digest/count 导出，以及 SEAL 后禁止无标记回填旧 epoch。

ledger reducer 必须拒绝任何没有合法前序证明的开放义务删除。允许的终态转移只有 `refined`、`discharged`、`excepted`；普通 task `done/cancelled/blocked` 不改变 obligation frontier。delegation 必须有 sender offer 与 receiver acceptance 双边 receipt；receipts 匹配前 sender 保持唯一 owner，匹配后 currentOwner 原子更新为 receiver。joint obligation 必须使用显式独立类型，不能由重复 current owner 暗示。

实现 `deriveReachableOwners(rootOwner, epoch)`：从 root owner 出发，仅沿已形成 sender/receiver receipt 的 accepted handoff 求最小可达闭包。任何 pending/单边 handoff、可达但未 seal 的 Owner，或证书中出现但闭包中不存在的 Owner 都阻止 CLOSE。没有 sound trust mode 的局部证书不得参与 verifiedSucceeded。

## 4. Commit → SEAL → CLOSE

涉及文件：

- 新增 `experiments/ubuddy_orgbench/core/obligationClosure.mjs`
- `experiments/ubuddy_orgbench/orgbench_experiment.mjs`

SEAL 返回局部闭包证书：incoming obligation commitments、ROC/lineage digest、ledger high-watermark、open/redeemed/excepted leaf commitments 与数量、outgoing handoff receipts、evidence root、schema/object/verifier versions，以及证书来源/attestation mode。

CLOSE 只有在可达 Owner 闭包中的所有 Owner 已 seal、所有局部证书通过可信来源验证、ROC 无 coverage gap、所有 local open 为空、所有 cut 前叶子均为 redeemed 或 excepted、所有 residual obligation 已处置、所有 handoff 双边平衡、子证书 epoch 对齐且版本有效时才能成功。CLOSE 只产生 `obligationClosed`；仅当所有 required leaf redeemed 且无冲突/验证失败时，才产生 `verifiedSucceeded`。单独 digest/hash 不能被当作证书真实性证明。

实现四个独立 verifier：

- `verifyCoverageClosure(root, epoch)`：检查 root mapping、每次 refinement proof、children+residual 和 coverage unknown；
- `verifyOwnershipClosure(root, epoch)`：检查唯一 current owner、matched handoff、reachable Owners、seal 和 LocalCert trust mode；
- `verifyRedemptionClosure(root, epoch)`：检查 required leaf 的实际 action/consumption/effect/verifier evidence；
- `verifyCutValidity(root, epoch)`：检查 epoch/high-watermark、late event、版本漂移和 revocation。

最终状态必须记录四项结果及失败原因，禁止用一个布尔 `done` 压缩。

增加条件完备性测试：有限单 Owner/多 Owner 正常流程最终必须产生 `verifiedSucceeded`；Owner crash、分区、unknown proof、未接受 handoff、迟到反证和 required exception 分别验证“阻止或降级但不错误成功”。

## 5. 分离完成状态

涉及文件：

- `experiments/ubuddy_orgbench/core/stateGraph.mjs`
- `experiments/ubuddy_orgbench/orgbench_experiment.mjs`
- `experiments/ubuddy_orgbench/evaluators/metrics.mjs`

增加：`obligationClosed`、`verifiedSucceeded`、`accepted`、`exceptionSet`、`closureCertificateId`、`closureEpoch`。

禁止 `graph.result(... decision='adopted')` 直接产生语义成功；必须先通过 OCCC closure gate。

## 6. Action、消费和执行证据

涉及文件：

- `experiments/ubuddy_orgbench/orgbench_experiment.mjs`
- `experiments/ubuddy_orgbench/core/stateGraph.mjs`
- `experiments/ubuddy_orgbench/appworld_bridge.py`

绑定 action/check 与 `obligationId`，记录实际读取对象 ID、版本和 digest、实际 effect/change set，记录 runtime checker 结果和 evidence ref；Agent 自报不能直接产生 `discharged`；只有义务声明的 verifier 可执行 evidence redemption；L2/L3 义务降级为 `review_required`/`not_operationalizable`。

## 7. 动态义务与撤回

retry/reassign/replacement 产生新 attempt 或新 obligation；SEAL 后迟到事件进入 `late_evidence`；policy/catalog/schema/object/verifier 变化使证书 `stale`；冲突 evaluator 结果触发 `completion_revoked`；新义务只能进入新 epoch。

## 8. 独立测试

涉及文件：

- 新增 `experiments/ubuddy_orgbench/core/obligationClosure.test.mjs`
- `experiments/ubuddy_orgbench/tests/orgbench_core.test.mjs`

至少覆盖：root ticket 重复 mint、根义务未映射、父 ticket 仅部分映射且 residual 丢失、`proofMode=unknown` 试图消费 parent、LLM 自报 coverage、子 ticket 无根引用、parent 重复 refine、失败/超时 attempt 错误消费 live ticket、retry 不保留 attempt lineage、task done 试图删除开放 ticket、blocked child + root done、无消费 evidence、自报 done、旧版本消费、Owner 不响应、单边 handoff、receipt 匹配前所有权转移、accepted receiver 未进入静态名单但被可达闭包发现、可达 Owner 未 seal、仅 hash 无可信证书来源、含 exception 的 CLOSE 不得产生 verifiedSucceeded、SEAL 后新 Owner/新义务、正常多 Owner 合成、late evidence/revocation、`coverage_unknown` 禁止 `verified_succeeded`。

## 9. 评估指标和基线

记录：coverage closure rate、ownership closure rate、redemption closure rate、三者联合 closure rate、root obligation coverage、delegation conservation、silent loss、false completion、verified discharge、closure rejection、stale/revocation、seal latency、certificate size 和跨域披露量。

比较：当前 Janus event/version/hash/ACK、普通 workflow join、termination/snapshot-style join、仅 Coverage、仅 Ownership、仅 Redemption、两两组合、去掉 CutValid 的三闭包、完整 OCCC。

## 10. 实施顺序

1. 纯内存 ledger、ROC 和 OCCC 验证器；
2. 接入 OrgBench，阻止 `blocked → root done`；
3. 接入 AppWorld action/consumption evidence；
4. 加入多 Owner、动态义务、迟到事件和撤回；
5. 执行基线和成本评估。

## 11. 最低验收标准

- 无 closure certificate 的 root 不得 `verified_succeeded`；
- 任何 cut 前未处置义务都能阻止 CLOSE；
- blocked/failed child 不能被 root 静默覆盖；
- `coverage_unknown` 不能升级为 `verified_succeeded`；
- 迟到冲突证据能使旧 closure `stale/revoked`。
