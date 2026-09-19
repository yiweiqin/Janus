# uBuddy OCCC 最终实验计划

## 1. 实验目标

验证四件事：

1. 当前 Agent 完成逻辑是否存在可复现的 false completion；
2. OCCC 是否在 planning loss、handoff loss、evidence loss 和 epoch drift 下保持 sound；
3. OCCC 是否在正常、有限、证据齐备的工作流中收敛，而不是 always-reject；
4. OCCC 相比现有机制增加多少延迟、证书和跨域披露成本。

## 2. 研究问题

```text
RQ1 Problem：任务图完成与根义务完成之间的缺口有多大？
RQ2 Soundness：OCCC 能否阻止各类 false completion？
RQ3 Completeness：正常工作流能否被 OCCC 正确接受？
RQ4 Necessity：Coverage/Ownership/Redemption/CutValid 是否缺一不可？
RQ5 Cost：OCCC 的延迟、存储、证书和隐私披露代价是多少？
RQ6 Generality：效果是否跨任务类型和跨 Owner 数量保持？
```

## 3. 实验层级

### 3.1 L1：确定性 OCCC controlled suite

建立带 gold ODG、gold owner、gold effect 和 gold verdict 的可重复场景。

至少 12 类场景，每类不少于 20 个实例：

| 类别 | 注入故障 | Full OCCC 期望 |
|---|---|---|
| F1 | 根义务未映射 | Coverage reject |
| F2 | children 存在但 residual 丢失 | Coverage reject |
| F3 | proofMode=unknown/LLM 自证 | Coverage unknown/reject |
| F4 | sender 单边 handoff | Ownership reject |
| F5 | receiver 已接受但未 seal | Ownership reject |
| F6 | task done/self-report，无 verifier evidence | Redemption reject |
| F7 | 消费旧对象版本 | Redemption reject |
| F8 | write conflict/frame violation | Redemption reject |
| F9 | SEAL 后新义务或 late event | Cut invalid/new epoch |
| F10 | verifier 后续反证 | revoke old closure |
| F11 | required exception | closed/accepted，非 verified success |
| N1 | 正常单 Owner | verified success |
| N2 | 正常多 Owner + 动态 handoff | verified success |
| N3 | 正常 retry 后成功 | verified success，attempt lineage 保留 |

最低规模：`14 × 20 = 280` 个确定性实例。

### 3.2 L2：现有真实 pilot 回放

使用：

- `experiments/runs/orgbench-appworld-pilot-1787754135156`
- `experiments/runs/orgbench-appworld-canary-1787752579797`
- `experiments/runs/orgbench-appworld-canary-1787808955857`

目的：

- 证明当前逻辑可出现 `result_accepted` 与官方 evaluator failure 共存；
- 离线重建最小 ROC/ODG，验证 OCCC 会在哪个 closure 条件拒绝；
- 不用 4 个 pilot 样本估计生产发生率，只作为可复现 failure witness。

### 3.3 L3：AppWorld official-evaluator main study

任务选择：

- 至少 50 个具有明确状态修改和官方 evaluator 的任务；
- 覆盖读取、创建、更新、删除、保留 frame、版本消费和答案返回；
- 至少 3 个独立 seed；
- 每个方法使用相同模型、temperature、最大步骤和成本上限。

最低主实验规模：

```text
50 tasks × 3 seeds × 4 primary methods = 600 episodes
```

primary methods：

```text
B0 current Janus M3：event/version/hash/ACK + task-status join
B1 workflow join + official-style terminal checks
B2 coverage/contract-only gate
OCCC full
```

复杂消融放在 controlled suite 和选定 20-task subset，避免主实验成本失控。

### 3.4 L4：跨域泛化

从现有 adapter 中选择至少一个非 AppWorld benchmark：

- TheAgentCompany：长期工具任务；或
- SWE-bench/代码修改任务：版本和测试 evidence；或
- Who&When/MARBLE：跨 Agent 协作与责任转移。

最低：30 个任务 × 3 seeds，对比 current baseline 与 full OCCC。选择标准必须在运行前冻结，不能按结果挑 benchmark。

## 4. 基线与消融

### 4.1 外部基线

```text
B0 当前 Janus status aggregation
B1 workflow join/barrier
B2 termination/snapshot-style cut
B3 contract/coverage-only
B4 provenance/evidence-only
B5 ownership/commitment-only
```

### 4.2 OCCC 消融

```text
A-Cov：去掉 CoverageClosed
A-Own：去掉 OwnershipClosed
A-Red：去掉 RedemptionClosed
A-Cut：去掉 CutValid/revocation
A-Trust：LocalCert 仅 hash，无 sound trust mode
A-Residual：refinement 不保留 residual
A-Converge：允许 always-reject
Pairwise：Coverage+Ownership、Coverage+Redemption、Ownership+Redemption
Full OCCC
```

controlled suite 必须验证每个消融重新暴露其对应故障，而不是只报告平均性能下降。

## 5. Ground truth 与防止评估泄漏

### 5.1 Controlled suite

- gold ROC/ODG、owner lineage、effect 和 verdict 由确定性生成器产生；
- fault label 对被测方法隐藏；
- verifier 单元独立于 closure aggregator。

### 5.2 AppWorld

- official evaluator 只在 episode 完成后运行；
- OCCC 执行时不得读取 ground-truth solution 或 official pass/fail；
- OCCC verifier 只能使用公开 contract、实际 API action/change set 和允许的 review evidence；
- official evaluator 作为 post-hoc root truth，用于计算 false completion/false rejection。

## 6. 主要指标

### 6.1 正确性

```text
False Completion Rate (FCR)
= internal verified_succeeded ∧ official/gold failure
  / all internal verified_succeeded

False Rejection Rate (FRR)
= official/gold success ∧ OCCC not verified_succeeded
  / all official/gold success

Coverage-loss recall / precision
Ownership-loss recall / precision
Redemption-failure recall / precision
Revocation correctness
```

### 6.2 可用性

```text
Conditional Convergence Rate
Time-to-Close
normal-case acceptance rate
open/unknown/exception distribution
retry recovery rate
```

### 6.3 成本

```text
end-to-end latency
seal/close latency
LLM token cost
ledger events per root
certificate bytes per owner/epoch
cross-owner disclosed bytes
verifier calls
```

### 6.4 任务质量

```text
official task success
official checkpoint/pass percentage
completed required effects
unintended changes/frame violations
```

## 7. 预注册成功门槛

在运行 main study 前冻结以下门槛：

1. Controlled suite：Full OCCC 的 false completion 必须为 0；
2. Controlled suite：每个 fault class 的检测 recall 必须为 100%；
3. Normal N1–N3：conditional convergence 不低于 95%；
4. Full OCCC 的 FCR 显著低于 B0/B1，且 95% CI 不与零改进重叠；
5. FRR 相比使用 official evidence 的合理 gate，绝对增幅不超过 5 个百分点；
6. 每个单项消融至少在对应 targeted fault 上显著劣于 Full OCCC；
7. p95 seal+close 协议延迟不超过 episode 总耗时的 10%，或报告不可接受；
8. certificate 不包含 prompt、private memory、credential、原始私有文件路径；
9. late contradiction 必须使旧 closure stale/revoked；
10. 含 required exception 的 case 不得标记 verified success。

门槛未满足时不能把结果包装成 Strong Accept；必须报告具体失败条件。

## 8. 统计方法

- 同一 task/seed 上使用 paired comparison；
- 比例指标报告 Wilson 95% CI；
- paired binary outcome 使用 McNemar test；
- latency/cost 使用 paired bootstrap 95% CI；
- 多消融比较使用 Holm correction；
- 同时报告 absolute difference、relative reduction 和 raw counts；
- pilot/canary 只作案例证据，不与 main study 混合估计总体效果。

## 9. 故障注入矩阵

每种 fault 明确注入点与预期 failure code：

| Fault | 注入点 | 预期 failure code |
|---|---|---|
| root omission | planner output | `coverage_gap` |
| residual loss | refinement event | `residual_missing` |
| self-signed proof | proof adapter | `proof_unknown` |
| unilateral handoff | sender ledger | `handoff_in_flight` |
| hidden receiver | participant set | `reachable_owner_unsealed` |
| self-report done | executor output | `self_report_only` |
| stale read | bridge consumption | `stale_consumption` |
| conflicting write | effect ledger | `write_conflict` |
| frame mutation | effect checker | `frame_violation` |
| late obligation | post-SEAL ledger | `cut_invalid` |
| verifier contradiction | post-close evidence | `completion_revoked` |
| untrusted certificate | LocalCert | `certificate_untrusted` |

## 10. 实验执行顺序

1. 单元测试和模型不变量；
2. controlled suite；
3. 真实 pilot 离线回放；
4. 5-task real canary；
5. 20-task ablation subset；
6. 50-task AppWorld main study；
7. 非 AppWorld 泛化；
8. 成本/隐私审计；
9. 独立复算和 artifact package。

任何阶段若出现以下问题则暂停扩大实验：

- normal case 无法稳定收敛；
- official evaluator 泄漏到 OCCC verifier；
- failure code 与注入 fault 不匹配；
- private payload 进入证书；
- run artifact 无法独立复算。

## 11. 最终 artifact

每次正式运行必须输出：

```text
config.json
episodes.jsonl
obligations.jsonl
handoffs.jsonl
evidence.jsonl
closure-certificates.jsonl
official_evaluation.json/jsonl
metrics.json
verification.json
report.md
environment-lock.json
```

独立 verifier 应能仅凭 artifact 重算：四个 closure 条件、FCR、FRR、convergence、revocation 和成本指标。
