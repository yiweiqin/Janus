# uBuddy OCCC 最终代码修改计划

> 本文件是实现计划，不在本轮修改源码。研究语义以 `ubuddy-pain-points-and-innovations-v68.zh-CN.md` 为唯一依据。

## 1. 当前代码中的直接缺口

### 1.1 根级成功由任务状态聚合产生

- `experiments/ubuddy_orgbench/core/stateGraph.mjs`
  - `result(..., decision='adopted')` 会直接把节点状态写成 `done`；
  - `update()` 允许普通状态覆盖，没有 obligation transition gate。
- `experiments/ubuddy_orgbench/orgbench_experiment.mjs`
  - `projectCompleted = tasks.every(...status === 'done')`；
  - 随后直接写 `project_root=done` 和 `result_accepted`；
  - 官方 evaluator 在这之后运行，因此内部成功可以与官方失败并存。

### 1.2 requirement 不是 Root Obligation Contract

- `experiments/ubuddy_orgbench/core/policy.mjs`
  - `discoverRequirements()` 生成 capability 类别，而不是 guarantee、residual、verifier 和 effect contract。
- `experiments/ubuddy_orgbench/schemas/task-gold.schema.json`
  - 只有 capability/dependency/decomposition 字段，无法表达义务覆盖和终态证据。

### 1.3 现有 event/version/hash 不能证明 absence

- `schema.mjs`、`stateGraph.mjs` 和实验日志已记录事件、版本和 hash；
- 它们能证明“发生了什么”，不能证明“根义务中本应发生的工作没有被漏掉”；
- 当前没有 ODG、open obligation frontier、双边 ownership transfer、redemption evidence 或 closure certificate。

## 2. 目标架构

新增两个核心模块，避免把 OCCC 分散到现有状态图逻辑中：

```text
core/obligationLedger.mjs
  append-only ODG、义务状态、owner transfer、epoch/high-watermark

core/obligationClosure.mjs
  CoverageClosed、OwnershipClosed、RedemptionClosed、CutValid
```

可选新增：

```text
core/obligationProofs.mjs
  machine_checked / review_signed / unknown proof adapter

core/obligationCertificates.mjs
  LocalCert 生成、验证和跨 Owner 合成
```

## 3. 阶段一：Root Obligation Contract

修改：

- `experiments/ubuddy_orgbench/schema.mjs`
- `experiments/ubuddy_orgbench/core/scenario.mjs`
- `experiments/ubuddy_orgbench/core/policy.mjs`
- `experiments/ubuddy_orgbench/schemas/task-gold.schema.json`

ROC 最小结构：

```json
{
  "obligationId": "roc_...",
  "rootId": "root_...",
  "required": true,
  "assumption": {},
  "guarantee": {},
  "verifier": {},
  "proofMode": "machine_checked|review_signed|unknown",
  "readSet": [],
  "writeSet": [],
  "frame": [],
  "versionGuard": {},
  "status": "open"
}
```

要求：

1. AppWorld 模式优先从 official task/evaluator 可见要求建立 ROC gold；
2. LLM 只能提出候选，不能把 `unknown` 升级为已证明；
3. 未能确认 ROC 完备性的 scope 标记 `coverage_unknown`；
4. capability requirement 保留用于分配，但不能替代 ROC。

## 4. 阶段二：Obligation Derivation Graph 与 append-only ledger

新增 `core/obligationLedger.mjs`，实现事件：

```text
obligation_committed
obligation_refined
obligation_derived
obligation_residual_registered
handoff_offered
handoff_accepted
handoff_cancelled
action_selected
artifact_consumed
effect_observed
obligation_redeemed
obligation_excepted
frontier_sealed
completion_closed
completion_revoked
```

ODG 内部结构必须能独立导出：

```text
V_obligation
E_refinement(parent, child/residual, proofRef)
E_ownership_transfer(obligation, sender, receiver, receipts)
E_terminal_witness(obligation, redemption/exception, evidenceRef)
```

closure verifier 必须遍历每个 ROC root 的最大派生路径，确认每条路径恰好到达一个终端 witness；存在绕过 cut 的 open/residual path 时禁止 closure。

必须维护：

- stable `obligationId/rootId/parentId`；
- `children + residual` 的完整 replacement；
- 一个义务在同一 epoch 只能被合法 refine/redeem/except 一次；
- failure/timeout/retry 不消费义务，retry 使用 `attemptId`；
- append-only、幂等、单调 high-watermark；
- SEAL 后禁止向旧 epoch 无标记回填。

## 5. 阶段三：Coverage closure

在 `core/obligationClosure.mjs` 实现：

```text
verifyCoverageClosure(rootId, epoch)
```

验证：

- 每个 ROC root 都在 ODG 中；
- 每个 derived node 可追溯到 root；
- 每次 refinement 有 `children + residual`；
- proof mode 已通过；
- `unknown`、missing residual、orphan child、重复 refine 均返回明确 failure code；
- 不允许“至少映射一个子任务”冒充完整 coverage。

建议 failure code：

```text
root_unregistered
coverage_gap
residual_missing
proof_unknown
proof_failed
orphan_obligation
duplicate_refinement
```

## 6. 阶段四：Ownership closure

实现双边 handoff：

```text
OFFER → ACCEPT → matched receipts
```

规则：

- ACCEPT 前 sender 保持 `currentOwner`；
- receipt 匹配后原子转移给 receiver；
- 单边、pending、超时 handoff 不减少 sender frontier；
- joint obligation 必须显式建模；
- `deriveReachableOwners(rootOwner, epoch)` 沿 matched handoff 求最小可达闭包；
- 所有可达 Owner 必须 SEAL。

实现：

```text
verifyOwnershipClosure(rootId, epoch)
```

failure code：

```text
owner_missing
owner_duplicated
handoff_in_flight
handoff_receipt_mismatch
reachable_owner_unsealed
certificate_untrusted
```

## 7. 阶段五：Redemption closure

修改：

- `experiments/ubuddy_orgbench/orgbench_experiment.mjs`
- `experiments/ubuddy_orgbench/core/stateGraph.mjs`
- `experiments/ubuddy_orgbench/appworld_bridge.py`

每个 required leaf 绑定：

```text
obligationId
selected action / code hash
actual object id + version/digest
actual effect/change set
verifier id/version/result
evidence timestamp/epoch
```

实现：

```text
verifyRedemptionClosure(rootId, epoch)
```

禁止：

- executor 返回 `status=done` 直接 redemption；
- `graph.result(... adopted)` 直接产生语义成功；
- execution output hash 被当作 effect proof；
- retry 成功覆盖此前失败而不保留 attempt lineage。

failure code：

```text
evidence_missing
self_report_only
consumption_missing
stale_consumption
effect_unknown
frame_violation
write_conflict
verifier_failed
required_exception
```

## 8. 阶段六：SEAL、LocalCert、CutValid 与撤回

每个 Owner 的 `LocalCert` 包含：

```text
incoming obligation commitments
ODG/leaf partition digest
ledger high-watermark
open/redeemed/excepted counts
matched handoff receipts
coverage proof refs
evidence root
schema/object/verifier versions
trust mode
```

实现：

```text
verifyCutValidity(rootId, epoch)
```

检查：

- 可达 Owner 的 epoch/high-watermark 对齐；
- LocalCert trust mode 被允许；
- 无 seal 后旧 epoch 回填；
- schema/object/verifier version 未漂移；
- late evidence、冲突或 official evaluator 反证触发 `stale/revoked`。

## 9. 阶段七：替换根级完成语义

修改 `orgbench_experiment.mjs`：

```text
旧：tasks.every(status === done) → project_root done/result_accepted

新：
coverage = verifyCoverageClosure(...)
ownership = verifyOwnershipClosure(...)
redemption = verifyRedemptionClosure(...)
cut = verifyCutValidity(...)

verifiedSucceeded = coverage.ok && ownership.ok && redemption.ok && cut.ok
```

状态严格分开：

```text
taskStatus
obligationClosed
verifiedSucceeded
accepted
exceptionSet
closureEpoch
closureCertificateId
closureFailureCodes
```

官方 evaluator 只作为独立 ground truth/evidence source，不能在同一实验中被 OCCC 提前读取以造成评估泄漏。

## 10. 阶段八：指标与报告

修改：

- `experiments/ubuddy_orgbench/evaluators/metrics.mjs`
- `experiments/ubuddy_orgbench/evaluators/independentVerifier.mjs`
- report/package 输出

新增：

```text
coverageClosedRate
ownershipClosedRate
redemptionClosedRate
cutValidRate
jointClosureRate
falseCompletionRate
falseRejectionRate
conditionalConvergenceRate
timeToClose
sealLatency
certificateBytes
disclosedBytes
revocationRate
```

## 11. 测试清单

新增：

- `experiments/ubuddy_orgbench/core/obligationLedger.test.mjs`
- `experiments/ubuddy_orgbench/core/obligationClosure.test.mjs`

接入：

- `experiments/ubuddy_orgbench/tests/orgbench_core.test.mjs`
- `package.json` 的 `experiment:ubuddy:orgbench:test`

必须覆盖：

1. root 未登记；
2. residual 丢失；
3. LLM 自报 coverage；
4. orphan/重复 refinement；
5. task done 删除 open obligation；
6. blocked/failed child + root done；
7. retry 不保留 attempt lineage；
8. 单边/in-flight handoff；
9. reachable receiver 未 seal；
10. self-report only；
11. 旧版本消费；
12. write/frame conflict；
13. only-hash certificate；
14. exception 被误报为 success；
15. SEAL 后 late event；
16. verifier 反证撤回；
17. 正常单 Owner 收敛；
18. 正常多 Owner 收敛；
19. unknown 阻塞但不错误成功；
20. official evaluator 与内部 closure 不一致时正确记为 false completion/false rejection。

## 12. 实施顺序与合并门槛

1. ROC schema + 纯内存 ODG；
2. Coverage closure；
3. Ownership handoff + reachable Owners；
4. AppWorld consumption/effect evidence；
5. SEAL/CutValid/revocation；
6. 替换 root success gate；
7. metrics/report；
8. controlled benchmark；
9. real AppWorld main run。

每阶段必须先有失败测试，再合并实现。最终合并门槛：

- controlled suite 中所有 false-completion fault 均被拒绝；
- 正常单/多 Owner case 均能收敛，不能 always-reject；
- `coverage_unknown`、untrusted certificate、late invalidation 不得升级为 `verifiedSucceeded`；
- 现有官方 evaluator 链路保持独立可用。

## 13. 明确不做

- 不让 LLM 自签 coverage proof；
- 不把 hash 当作真实性证明；
- 不声称恢复未登记隐含意图；
- 不在第一版实现自研零知识证明或新事务协议；
- 不把 UI、组织进化或 CAD 等旧方向重新加入核心贡献。
