# uBuddy OCCC 顶会级实验计划 v2

> 目标不是只证明系统能运行，而是分别检验 v68 的四个研究主张：T1 义务解释守恒、T2 私有证书组合安全、T3 条件完备性、T4 接口必要性。所有实验都必须区分“事实验证失败”和“系统没有足够信息而安全拒绝”。

## 1. 研究问题与假设

- **RQ1 / T1**：动态 refinement、retry、reassign 是否仍保持 root obligation 的唯一解释？
- **RQ2 / T2**：只交换最小局部证书时，能否安全组合跨 Owner 的全局 cut，同时不泄露私有内容？
- **RQ3 / T3**：在有限、最终齐备、无冲突的工作流中，OCCC 是否有限时间收敛，而不是 always-reject？
- **RQ4 / T4**：去掉 lineage/residual、双边 ownership、effect/version evidence 或 epoch/high-watermark 后，是否出现不可区分的 false completion？

主假设：完整 OCCC 的 false-completion rate 显著低于所有基线；在可行工作流上 rejection rate 不显著增加到不可用；隐私披露量低于集中式全状态方案。

## 2. 受控合成协议实验：证明不变量与不可区分性

### 2.1 工作流生成器

生成 5 类有限 DAG/动态图：单 Owner、链式 handoff、多 Owner 汇合、replan/retry、跨版本外部副作用。每个实例包含 3–12 个 root obligations、2–20 个动态 leaves 和 1–6 个 Owner。生成器保存完整 gold explanation forest、owner transfer history、object versions、effect truth 和故障注入点。

至少 5,000 个随机实例、20 个随机种子；另生成 500 对“协调者可观察输入完全相同、真实根义务不同”的不可区分世界。

### 2.2 故障因子

- root requirement 漏拆；
- children 覆盖不全且 residual 丢失；
- sender 单边 handoff；
- receiver 动态加入但未被等待；
- blocked/failed child 被 root done 覆盖；
- 旧对象/旧版本消费；
- 设计正确但 effect 未发生；
- seal 后迟到新义务或冲突证据；
- unknown proof 或不受信 LocalCert；
- required exception。

### 2.3 对照组

| 组别 | 机制 |
|---|---|
| B0 | task DAG join + ACK/quiescence |
| B1 | 静态 ROC/refinement，无 residual frontier |
| B2 | B1 + ownership ledger，无 effect evidence |
| B3 | B1 + effect verifier，无跨 Owner 证书组合 |
| B4 | 三闭包相与，但无 boundary compatibility/epoch cut |
| B5 | 集中式全状态检查（性能/隐私上界） |
| OCCC | 完整 explanation conservation + local certificate composition |

所有组固定相同任务、模型、随机种子、故障注入和执行预算。

### 2.4 指标与判据

- false completion rate（最重要）；
- false rejection rate；
- T1 conservation violation detection rate；
- T2 certificate composition soundness；
- T3 feasible-case convergence rate、收敛步数和 seal latency；
- stale/revocation detection latency；
- certificate size、跨域披露字段数和字节数；
- 不可区分世界上的 decision consistency。

判据：OCCC 在 500 对不可区分世界中不得接受任何 gold-invalid 世界；在 gold-valid 世界中接受率达到 100%（允许明确的 trust/unknown 阻断样本单列）；所有结论报告 Wilson 95% CI。

## 3. 因子消融：验证“四类接口是必要的”

采用 2×2×2×2 factorial ablation，四个因子分别为：

1. root lineage + residual；
2. 双边 ownership receipt + reachable-owner closure；
3. actual object/version/effect evidence；
4. epoch/high-watermark/cut revocation。

每个配置至少 500 个实例。对每个故障类型报告 false completion、false rejection 和检测延迟，使用混合效应 logistic 回归（故障类型和任务模板为固定效应，seed/instance 为随机效应），同时报告交互项，证明完整 OCCC 的收益不是某个单独 verifier 可以解释的。

## 4. 私有 Owner 组合实验：组合性与隐私权衡

设置三种可见性：

- **Full-state**：协调者读取所有内部 frontier（仅作准确率上界）；
- **OCCC-cert**：Owner 只发送最小局部证书；
- **Digest-only**：Owner 只发送 hash/digest。

测量：全局判定准确率、false completion、证书通信开销、泄露字段数量、动态 receiver 发现率、未 seal Owner 阻断率。预期 OCCC-cert 接近 Full-state 的 soundness，显著优于 Digest-only，同时披露量显著更低。

## 5. 真实任务实验：OrgBench/AppWorld

从真实任务中筛选具有明确多步约束、外部对象修改和最终验收的样本；每个任务由 gold annotator 预先建立 ROC、required effects、exception policy 和故障真值。建议至少 300 个任务、6 个随机种子；若真实模型预算不足，先使用固定轨迹回放，再对代表性子集运行真实模型。

报告：根义务 coverage、ownership closure、redemption closure、联合 closure、false completion、返工次数、旧版本消费率、人工 review 比例、完成时间、token/调用成本及隐私披露量。

真实任务结论必须明确区分：

- OCCC 是否减少错误成功；
- OCCC 是否只是更保守地拒绝；
- 在证据最终齐备的任务上是否仍然收敛；
- 失败是否来自 planner/Owner/verifier，而非被 OCCC 隐藏。

## 6. 统计、可复现与审计

每条样本保存：ROC、gold explanation forest、事件序列、故障注入、局部证书、组合失败原因、最终状态、epoch、版本和指标。所有实验输出匿名化，不保存 prompt、私有 memory 或本地路径。

主要二元指标报告 95% CI 和效应量；时间/成本报告中位数、IQR 和 bootstrap CI；多重比较使用 Holm 校正。实验前固定随机种子、停止规则、主指标和排除规则；提供独立 replay verifier，重新从事件与证书计算所有结论。

## 7. 可能失败时如何诚实解释

- 若 OCCC 的 soundness 与 B4 无显著差异，说明“证书组合/cut”尚未证明独立价值；
- 若 OCCC rejection 显著升高且可行样本不收敛，T3 失败，不能宣称实用；
- 若 Digest-only 与 OCCC-cert 等价，说明最小证书接口没有带来必要信息；
- 若真实任务收益只来自更强 verifier 或更好的 ROC 标注，应将贡献收缩为协议安全性，不宣称 Agent 能力提升；
- 若任一不可区分 invalid 世界被接受，T2/T4 直接失败，必须撤回 `verified_succeeded` 主张。

## 8. 论文结果表的最低集合

1. 主表：各基线/OCCC 的 false completion、false rejection、收敛率；
2. 消融表：四个接口因子的主效应和交互效应；
3. 组合性表：Full-state、OCCC-cert、Digest-only 的准确率—披露量曲线；
4. 故障矩阵：每类不可区分反例的检测结果；
5. 成本表：证书大小、通信、seal 延迟、回撤延迟；
6. 真实任务表：OrgBench/AppWorld 的根义务 coverage 与真实 effect 验证结果。
