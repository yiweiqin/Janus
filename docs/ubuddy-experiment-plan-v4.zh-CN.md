# uBuddy OCCC 实验与验证计划 v4

## 1. 四条独立证据轨

### A. 形式化/模型轨

- T0 固定 ROC 的 trace-only impossibility proof；
- T1 小步 lineage preservation proof；
- T2 full-state→certificate abstraction simulation theorem；
- T3 consistent-cut + GlobalEffectCompat soundness；
- T4 公平稳定执行的 conditional progress proof；
- T5 四个 observation-projection indistinguishability lemmas；
- TLA+/Alloy 仅用于有界反例搜索，报告状态数、界和公平性配置。

### B. 协议攻击轨

覆盖：

- shared child/two parents；
- refinement cycle/empty denotation；
- partial redeemed + open boundary；
- OFFER/ACCEPT crash windows；
- duplicate/reordered transfer；
- old-owner fenced write；
- registry omission；
- certificate rollback/fork/equivocation/replay；
- scalar watermark false cut；
- vector causal gap；
- action TOCTOU；
- two locally valid but globally conflicting effects；
- stable predicate later destroyed；
- exception/effect late race；
- generation advance/revocation。

主指标：attack success、false completion、false rejection、unknown、检测延迟和恢复步数。

### C. 系统对照轨

强基线：

| 基线 | 比较目的 |
|---|---|
| DAG join/quiescence | 普通 Agent completion |
| Central full-state contract monitor | 正确性/披露上界 |
| Goal refinement + effect verification | 检查是否只是 contract monitor |
| Petri/workflow-net token conservation | 检查 token 语义的新意 |
| Linear/typestate workflow | 检查唯一消费/ownership |
| Transactional saga + fenced handoff | 检查 transfer/compensation |
| Full-state provenance + causal snapshot | 检查 lineage/effect/cut 组合 |
| OCCC full-state | 分离守恒语义与证书贡献 |
| OCCC certificate | 完整方案 |

比较同一 authoritative cut 上的 verdict agreement、false completion、false rejection、unknown、延迟、CPU、存储、通信和 certificate bytes。

### D. 真实 Agent 轨

在 OrgBench/AppWorld 中分别报告：

- registered-obligation disappearance 占全部失败的比例；
- OCCC 检出的 false completion；
- success-report calibration；
- 最终任务成功率（明确 OCCC 本身不修复 planner）；
- gold/user-confirmed/noisy ROC 三种质量；
- verifier 可获得率；
- coverageUnknown/reviewRequired；
- 人工分钟/任务；
- gateway/registry/certificate 成本。

ROC annotator、outcome annotator、world-state oracle 和 certificate generator 必须分离。

## 2. T2 核心实验

对同一 cut 同时运行：

```text
FullStateReference(K)
OCCC-Certificate(K)
```

要求 verdict 一致。随机隐藏 Owner 私有 DAG/内容，但不得隐藏 authoritative boundary；注入 rollback/fork/equivocation，验证证书方案拒绝攻击。若 certificate 仅在 trusted monitor 自报正常时成立，而攻击后无法检测，T2 主张失败。

## 3. Effect compatibility 实验

构造：

- `x=1` 与 `x=2` 的冲突 stable obligations；
- playlist invariant 先满足后被覆盖；
- 两个非冲突对象并行更新；
- 可序列化和不可序列化 change sets；
- old owner 绕过 action attempt；
- verifier 检查 v2、action 实际写 v1。

逐项验证 local witness 与 GlobalEffectCompat 的差异。

## 4. 隐私与披露

基础 OCCC 公开 boundary IDs 和 owner relationships，只隐藏内容/内部 DAG。报告：

- raw bytes；
- boundary size/shape leakage；
- owner-relation leakage；
- 属性推断攻击；
- 与 full-state 和中心脱敏摘要的比较。

若没有 ZK/accumulator，不宣称结构隐私或 Byzantine completeness。

## 5. 活性

仅在最终稳定、有限 attempt/generation、verifier 终止和消息公平送达条件下测量。报告到达：

```text
verifiedAtCut | coverageUnknown | exception
```

的步数和比例。立即返回 unknown 不计为 liveness 成功；必须按输入是否确实不可判定验证 disposition 正确性。

## 6. 失败判据

- T1 任一 reachable state 出现双 parent、双消费或 boundary 丢失；
- T2 certificate verdict 与 full-state reference 不一致；
- T3 local witnesses 全通过但冲突世界仍 verified；
- registry 缺失 Owner 未触发 unknown；
- rollback/equivocation certificate 被接受；
- old owner 实际写入未被 fence/观察；
- T5 不能保持其余观察相同构造成对世界；
- 收益仅存在于 gold ROC/gold verifier；
- false completion 降低完全由无差别拒绝造成。

## 7. 最低论文产物

1. 系统/故障/TCB 表；
2. 小步 semantics 和 reference implementation；
3. T0–T5 定理或明确 proof boundary；
4. bounded model-check artifacts；
5. full-state/certificate simulation 结果；
6. 强基线与攻击矩阵；
7. ROC/verifier 可用率与人工成本；
8. OrgBench/AppWorld 真实结果；
9. 独立 replay verifier 和匿名 artifacts。
