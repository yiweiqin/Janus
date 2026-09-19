# uBuddy OCCC 实验与验证计划 v3

> 本版区分“证明”“模型检查”和“经验评估”。随机实验与统计不能证明不变量或接口最小性；形式化结果与系统实验分别回答不同问题。

## 1. 研究问题

- RQ1：reference semantics 是否保持 obligation conservation？
- RQ2：边界证书能否在 coordinator 不读取私有 frontier 时，组合出与 full-state monitor 等价的 cut verdict？
- RQ3：异步、crash-recovery、消息乱序和迟到事件下，协议是否保持安全并最终给出 verified/unknown/exception？
- RQ4：四类语义信息是否分别具有不可区分下界？
- RQ5：真实 Agent 工作流中，减少 false completion 的收益是否超过 false rejection、人工 ROC 和证书成本？

## 2. 形式化验证轨

### 2.1 Model checking

使用 TLA+/PlusCal 或 Alloy 对小规模状态空间穷举：1–4 roots、1–5 Owner、0–8 refinements/transfers、crash/recovery、duplicate/reordered messages。验证：

- unique parent/single consumption；
- frontier antichain 与 conservation；
- ownership fencing；
- causal cut consistency；
- certificate composition order independence；
- verifiedAtCut 不接受 invalid effect/ownership/coverage。

报告所有状态数量、搜索深度、假设和发现的 counterexample。不得把 bounded checking 宣称为无界证明。

### 2.2 T5 information lower bounds

对每类信息给出正式观察投影 `π_j` 和成对运行 `W_j+/W_j-`。该部分是证明/附录，不使用 p-value：

1. lineage/residual 缺失；
2. OFFER/ACCEPT/fencing 缺失；
3. action-causal effect/version 缺失；
4. vector causal cut/freshness 缺失。

每对运行需保证协议其余输入相同，completion truth 不同。ROC 是协议显式输入，不把“不同用户要求”隐藏在观察之外。

## 3. 对抗性协议实验

生成独立于 implementation reducer 的 oracle traces，至少覆盖：

- shared child、cycle、duplicate consumption；
- crash after OFFER / after ACCEPT；
- delayed/replayed certificate；
- non-transitive boundary overlap；
- stale owner action；
- external concurrent update/TOCTOU；
- late obligation/effect contradiction；
- monitor bypass attempt；
- permanent partition 与 eventually-healed partition。

使用 property-based testing 和 mutation testing。主指标：attack success、false completion、false rejection、unknown rate、收敛步数、revocation latency。

## 4. 强基线

| 基线 | 目的 |
|---|---|
| DAG join/quiescence | 当前常见 completion |
| Central full-state contract monitor | 正确性上界与无隐私方案 |
| Goal refinement + runtime effect verification | 检验 OCCC 是否只等于 contract monitor |
| Commitment/transactional handoff + effect verifier | 检验 ownership 机制是否已足够 |
| Full-state provenance + causal snapshot | 检验 lineage/snapshot 组合是否替代 OCCC |
| OCCC without certificate abstraction | 分离 token conservation 与隐私组合收益 |
| OCCC-cert | 完整方法 |

Digest-only 只作为弱诊断基线，不作为主要 novelty 对手。

## 5. 证书组合与隐私

比较 full-state、OCCC-cert 和中心化脱敏摘要：

- verdict agreement；
- false completion/unknown；
- coordinator 可恢复的 obligation 数量、结构、owner 关系和业务属性；
- mutual-information/attribute-inference 或预定义泄露攻击成功率；
- certificate bytes、验证 CPU、seal latency、跨 Owner round trips。

仅统计“字段数”不足以声称隐私优势。

## 6. ROC 与 verifier oracle 分离

真实任务必须分别测量：

1. 人工 gold ROC；
2. 用户确认的自动提取 ROC；
3. 有噪声/缺失 ROC；
4. coverage_unknown/review_required。

ROC annotator 和最终 outcome annotator 分离；报告 inter-annotator agreement。不能使用同一 gold 逻辑同时生成合同和判定结果。

绘制 contract quality–false completion–false rejection–coverage 曲线，明确 OCCC 只保证 registered obligations。

## 7. 真实任务实验

选择含多步约束、外部对象修改、动态 replan/handoff 的 OrgBench/AppWorld 任务。主表必须同时报告：

- false completion；
- false rejection；
- verifiedAtCut、finalized、unknown、exception 比例；
- end-task success；
- ROC 构造成本和人工 review 率；
- effect causal witness 可获得率；
- latency、token、存储、证书和通信成本。

Agent/模型/任务/seed 固定配对。不得只在 OCCC 可 operationalize 的样本上报告结果；所有排除项和 unknown 样本进入主表。

## 8. 活性实验

在最终稳定的网络/Owner/object 条件下测量 protocol termination；分别注入：

- finite replan/retry；
- crash-recovery；
- eventually delivered message；
- verifier delay；
- epoch rollover。

报告达到 `verifiedAtCut | coverageUnknown | exception` 的比例和步数。永久分区、无限 replan 和持续冲突单列为模型外 liveness failure，不能混入正常拒绝率。

## 9. 失败判据

- OCCC-cert 与 full-state monitor 在同一 authoritative cut 上 verdict 不一致：T2 失败；
- 任一 invalid trace 获得 verifiedAtCut：T1/T3 失败；
- 删除某信息后无法构造观察等价 valid/invalid pair：对应 T5 主张撤回；
- 收益只来自 gold ROC 或更强 verifier：收缩为 contract-monitoring 系统贡献；
- 证书披露与 full-state 接近：撤回隐私组合优势；
- valid/stable workflow 大量停留 pending：T4 活性失败。

## 10. 论文最低结果包

1. reference model、配置、状态空间和 counterexamples；
2. T1/T2/T3/T5 的形式定义与证明/模型检查边界；
3. 强基线 false-completion/false-rejection 主表；
4. full-state 与 certificate 的等价性—披露—成本曲线；
5. crash/reorder/replay/TOCTOU 攻击矩阵；
6. ROC 质量敏感性；
7. OrgBench/AppWorld 真实任务结果；
8. 独立 replay verifier 与匿名化 artifacts。
