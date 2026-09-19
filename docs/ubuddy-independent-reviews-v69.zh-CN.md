# uBuddy v68 三位独立顶会审稿汇总与 v69 响应

## 1. 独立评分

| 审稿视角 | v68 评分 | 倾向 | 最核心拒稿理由 |
|---|---:|---|---|
| SOSP/OSDI/NSDI/EuroSys | 4/10 | Reject / Weak Reject | 没有可执行分布式协议语义；证书 soundness 和原子 handoff 被当前提；整体仍像已有机制集成 |
| NeurIPS/ICML/ICLR/ACL/AAMAS | 5.5/10 | Weak Reject / Borderline | ROC、coverage proof、effect verifier 和 LocalCert 把最难问题交给人工/gold oracle |
| CAV/POPL/PLDI/ICSE/安全 | 5.5/10 | Weak Reject / Borderline | T1 定义自证、T2 assumption laundering、T3 条件化平凡、T4 尚非信息下界 |

三位审稿人的共同判断：痛点重要且表述较强；创新尚未靠定义、定理和协议摆脱 `contract + commitment + runtime verification + snapshot` 的组合质疑。

## 2. 共识硬伤及 v69 修改

| v68 硬伤 | v69 响应 |
|---|---|
| “未发生义务”容易暗示发现未登记意图 | 明确拆分 specification completeness 与 registered-obligation conservation，只解决后者 |
| A/B 反例只证明需要规格 | 固定同一 ROC，定义 trace-only 观察投影，证明缺少 lineage/proof/effect 时的不可区分性 |
| ODG 最大路径条件会重复解释共享节点 | 改为带原子 refinement 超边的 derivation hypergraph，frontier 是唯一 antichain，禁止共享 token |
| T1 是 Verified 定义的展开 | 增加状态 `Σ`、小步事件和逐事件归纳守恒定理，成功仅作为推论 |
| LocalCert sound 直接作为假设 | 明确 trusted local monitor/attested reducer 为 TCB，证书需 completeness witness；Byzantine host 降级为 unknown |
| OFFER/ACCEPT 不是异步协议 | 增加 durable accept、transferId 与 ownership fencing version；旧 owner 不能 redeem |
| scalar high-watermark 不是一致 cut | 改为 causal frontier/vector clock 与 downward-closed cut |
| T3 是“所有事情完成则完成” | 引入公平异步条件、well-founded refinement/progress rank 和显式 unknown/exception 终态 |
| T4 只是消融 | 改为针对四类语义信息的观察投影与 indistinguishability lower bounds |
| effect verifier 可能只检查当前状态 | 引入 world transition、pre/post hash、linearization point 和 action causal provenance |
| 可撤回成功与最终成功混淆 | 分离 `verified_at_cut` 与需要领域 fencing/finalization 的 `finalized_succeeded` |

## 3. 仍需由论文与实现证明的事项

v69 只是更严谨的研究定义，并不意味着定理已经完成。投稿前至少需要：

1. 一个可执行 reference semantics 或 TLA+/PlusCal/Alloy/Lean/Coq 模型；
2. T1 对所有事件类型的 preservation proof；
3. T2 的 local abstraction、compatibility 和 canonical composition proof；
4. T3/T5 的 causal-cut soundness 与不可区分下界；
5. crash-recovery、消息重排、证书 replay、hidden transition 和 TOCTOU 的攻击性测试；
6. ROC 质量与协议质量分开评估，避免用同一个 gold oracle 同时定义输入合同和最终标签。

## 4. 当前综合判断

v69 不再把概念蓝图直接评价为 Accept。它把可投稿贡献收缩为一个可验证命题：

> 在 trusted local monitors 完整观察 authoritative obligation transitions、coordinator 只能获得边界证书的条件下，能否用 obligation-conservation 状态机和因果证书组合，得到与全状态语义等价但披露更少的根级 cut-relative completion？

如果这个命题被形式化证明并在真实系统中验证，创新有顶会潜力；如果证书最终只是中心化全状态的摘要，或 ROC/effect oracle 承担全部难度，则仍应拒稿。
