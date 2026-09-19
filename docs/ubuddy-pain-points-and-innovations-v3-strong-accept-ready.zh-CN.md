# uBuddy 痛点与创新点 v3：Strong-Accept-Ready 收缩版

## 一、结论

原始的“最小充分披露”和“规划/执行双图 + 谱系 + 联合进化”不需要废弃，但不能继续作为两个宽泛的并列系统创新。经过四轮独立研究代理迭代和独立顶会审稿，建议将主论文收缩为一个问题：

> **Contract-Preserving Interventional Repair for Cross-Organization Agent Workflows（CPI-Repair）**：在跨组织、部分可观测、带随机性的 Agent 工作流中，通过可执行随机干预寻找不弱化固定公共契约的最小成本充分修复，并为因果成功概率和有界语义安全提供联合证书。

原始规划 DAG、执行 DAG 和谱系仍然保留，但只作为观察、切片和 replay 索引底座，不直接被宣称为因果创新。

## 二、重构后的痛点

### 痛点一：跨信任域下的失败世界在公共观察上可能不可区分

跨组织协调器通常只能看到公共事件、声明、版本哈希和边界证书，看不到其他组织的私有 Prompt、Memory、程序状态和工具内部状态。

因此，两种真实原因可能产生相同的公共轨迹：

- 上游 Agent 能力不足；
- 交接契约丢失约束；
- 下游绑定了旧版本；
- 私有工具产生了未记录副作用。

只依靠规划—执行差异或自然日志无法识别真正原因。关键痛点不是“日志不够多”，而是：

> 在部分可观察条件下，哪些修复效果可以通过可执行干预被识别；哪些只能返回 `coverageUnknown`？

### 痛点二：跨层修复可能恢复任务成功，却破坏原始公共契约

一个失败任务可以通过多种方式被“修好”：

- 更换 Agent；
- 重连依赖；
- 切换 artifact 版本；
- 修改验证器或 guard；
- 修改程序代码；
- 补偿已经发生的副作用。

但提高一次任务成功率不等于安全修复。修复可能越权、使用过期数据、重复执行外部动作，或者直接弱化验收条件。

因此问题不是寻找任意有效 patch，而是：

> 如何在计划、路由、版本和程序的联合动作空间中，找到因果上充分、成本最小、且不弱化原始契约的修复？

### 痛点三：修复搜索同时受到因果覆盖、组合交互和不可逆副作用约束

单故障排名无法处理以下情况：

- 两个修复必须同时采用才有效；
- 一个高责任根因没有可执行修复；
- 一个修复在历史数据中没有 positivity/support；
- 不可逆外部动作无法通过普通 replay 或 rollback 撤销；
- 大量候选上的自适应选择使静态置信区间失效。

因此系统必须同时决定：

1. 是否具有识别某个修复效果的覆盖；
2. 应采用 greedy、FPT、MILP/MaxSAT 还是拒绝回答；
3. 外部动作是否可幂等、可补偿或必须人工确认；
4. 返回修复还是 `coverageUnknown/abstain`。

## 三、统一形式化

定义有限状态、有限时域的跨组织工作流：

\[
\mathcal W=(\Sigma,\Sigma_0,\mathcal A,\rightarrow,Obs,D,\mathcal G,Inv,\Omega,\Lambda,H)
\]

- `Σ`：包含私有状态、公共状态、消息、owner、version、permission 和外部世界状态；
- `Obs`：公共观察投影；
- `D`：允许在证书约束下修复的依赖 DAG；
- `𝒢`：独立 reference evaluator 定义的随机软任务效用；
- `Inv` 与 `C_safe`：必须对所有有界轨迹成立的不可修改硬契约；
- `Ω/Λ`：所有权和能力边界；
- `H`：最大执行步数。

节点和边契约包括：

```text
Pre / Post / Schema / Version / Freshness / Auth / Footprint / Idempotence
```

修复动作是可执行 primitive：

```text
reassign(v, organization, executor)
rewire(edge, predecessors, successor)
bind(edge, artifact@version)
patch(node, finite-template-patch)
guard(node, predicate)
compensate(effect, compensation-action)
```

每个 primitive 必须声明 read/write set、owner scope、成本、随机重放语义和局部证明义务。

## 四、核心创新：CMRS

定义修复效果：

\[
V_h(R)=Pr[\mathcal G(\tau_R)=1\mid do(R),H=h]
\]

修复集合 `R` 是一个 contract-preserving causally sufficient repair，当且仅当：

1. 类型、所有权和权限合法；
2. 修复后所有 ≤H 的可达轨迹保持硬契约 `C_safe` 和 `Inv`；
3. 修复不弱化原始调用/保证契约，只允许 refinement；
4. 软任务效用的同时置信下界满足 `LCB(V_h(R)) ≥ η`；
5. 不存在仍满足上述条件的真子集。

最终求解：

\[
R^*=\arg\min_R\sum_{r\in R}c(r)
\]

若干预没有支持，或者与公开观察一致的候选世界对 `V(R)` 给出跨越阈值的结果，则返回：

```text
coverageUnknown
```

而不是外推或猜测。

## 五、三个主要创新贡献

### 贡献一：从观察性 RCA 升级为可执行干预诊断

规划 DAG、执行 DAG 和谱系首先用于 backward slice，定位可能违反契约的机制超图。因果结论只能来自：

- 可重置 fork；
- 相同 world snapshot；
- 随机化 route/version/validator/patch 干预；
- paired replay；
- sequential DR/TMLE 或其他满足识别条件的估计器。

这区别于只输出异常排名的 causal RCA：系统最终输出可执行修复集合及效果置信范围。

### 贡献二：最小成本充分修复与正确复杂度边界

一般 CMRS 可由 Weighted Set Cover/Hitting Set 归约，至少 NP-hard，并继承对数不可近似边界。对于概率 SCM，精确计算 `V(R)` 本身还可能是 #P-hard，因此必须明确使用显式 effect oracle、可穷举模型或 Monte-Carlo PAC 估计。

特殊情况：

- 成功增益单调次模：使用 cost-aware submodular cover，给对数或双准则近似，而不是错误套用 `1−1/e`；该情况仅作为 coverage 特例，因为 code+contract 等联合修复通常存在强互补；
- 修复交互图 treewidth 和高阶交互维数有界：使用动态规划/MaxSMT 给 FPT 精确求解；
- 非单调、强协同：使用 MILP/branch-and-bound，诚实声明没有一般近似保证；
- 覆盖不足：返回 `coverageUnknown`。

### 贡献三：独立契约验证器与跨域 Action Gateway

每个组织只暴露边界证书，本地 monitor 保留私有状态。修复提交协议为：

```text
repair proposal
→ owner authorization
→ local prepare / certificate verification
→ version-fenced commit
→ effect verification
→ compensation or manual-abort
```

所有真实外部写入必须经过 Action Gateway，记录 intent id、fencing epoch、linearization point 和结果哈希。

不可逆动作：

- 有补偿闭包时执行补偿/向前修复；
- 无补偿或状态不可查询时进入人工确认或 manual-abort；
- 永远不称为“反事实回滚”。

## 六、Strong Accept 最小定理包

### T1：Bounded Contract Soundness

在有限状态、有限时域、TCB 正确、局部 refinement certificate 成立、依赖兼容、权限/版本/幂等检查通过且写集无冲突时，所有 ≤H 的修复轨迹满足原始 `𝒢` 和 `Inv`。

### T2：Verifier Soundness / Relative Completeness

抽象 verifier 与 concrete gateway transition 建立 forward simulation；verifier 接受蕴含 concrete bounded safety。只有在抽象对 ≤H 可达状态 exact/bisimilar、模板库可表达目标修复且 solver 完备时，才声称相对于模板库的 completeness。

### T3：Interventional Identification

在 consistency、随机化干预、positivity、序列可交换性、episode 隔离、稳定 evaluator 和 lineage completeness 下，修复集合的总体效用 `V(R)` 可由 extended g-formula 识别；自适应查询使用 confidence sequence 或 simultaneous bounds。本文主张 population repair efficacy，不把平均干预效应直接称为某一次失败的个体根因；单 episode 归因只在已知、可确定重放的 SCM 中成立。

### T4：Finite-Sample Sufficiency

对于预注册有限候选族，以至少 `1−δ` 的概率，`LCB(R)≥η` 的返回规则保证真实成功概率超过 `η−ε`。若基础动作有 `m` 个且最多选 `k` 个，统一验证的组合复杂度至少包含 `k log(em/k)`；序列 off-policy 估计还必须报告最小 propensity 和随时域增长的方差风险。

### T5：Hardness / Approximation / FPT

证明一般 CMRS 的 NP-hardness 和对数不可近似边界；给次模特殊类的正确 threshold-cover 保证，以及有界 treewidth/交互阶数下的 FPT 复杂度。

### T6：End-to-End Certificate

在上述条件下，CPI-Repair 以至少 `1−δ` 的概率输出：

```text
contract-preserving repair
success ≥ η−ε
cost ≤ α·OPT
```

或者返回 `coverageUnknown/abstain`。

## 七、算法闭环

```text
1. 从 P/E/lineage 与本地 TCB 证书构造公开历史和当前 consistent cut
2. 对契约违例做 backward slice，得到候选机制超图
3. 在包含全部候选节点/边的 activation supergraph 上实例化有限修复 primitive，用 activation variable 表示 graph edit
4. 执行类型、owner、权限和 refinement certificate 过滤
5. 在随机 fork/replay 中检查 intervention support
6. 使用 confidence sequence 估计修复集合成功率
7. 按结构选择 submodular cover、FPT-DP 或 MILP/MaxSAT
8. 对 transformed model 重新验证新产生的因果路径，再删除冗余动作得到 inclusion-minimal 集合
9. 独立 bounded verifier 验证
10. 修复只作用于当前 consistent cut 之后的 suffix；过去副作用转化为 compensation obligation，再通过跨域 Action Gateway 授权、提交、验证或补偿
11. 覆盖不足、证明失败或不可补偿时 abstain
```

## 八、必须完成的三层实验

### A. Ground-truth 可穷举工作流

- 至少 1000 个可重置工作流；
- 20–100 个节点；
- 6–8 类机制；
- 单、双、三故障和非次模交互；
- 具有真实最小修复集。

测量：CMRS exact-set F1、CI 覆盖率、干预次数、`cost/OPT`、hard-contract violation 和拒答正确率。

### B. uBuddy/AppWorld Locked Test

- 至少 100 个任务实例；
- 至少 5 个随机种子；
- development/locked task-family 严格分离；
- 使用官方 evaluator，不使用 LLM judge 作为主真值；
- 包含未见故障组合。

基线：provenance/LLM-RCA、active causal diagnosis、反思/重规划、workflow-only、APR/code-only、contract/CEGIS/MaxSMT 和 oracle。

### C. 独立跨域系统

至少一个非 uBuddy runner，包含：

- 3 个隔离组织/进程/账号；
- 不同凭证与不同可见投影；
- 不共享管理员可读数据库；
- 本地 intervention broker 返回 attested outcome；
- 注入 crash/restart、drop/dup/reorder、partition、并发修复和不可补偿副作用。

如果没有该层，论文更适合 NeurIPS/ICML，标题应谨慎使用 `multi-agent workflow`，不应过度声称完整的 cross-organization 系统。

## 九、四轮审稿轨迹

| 版本 | 审稿判断 | 主要原因 |
|---|---:|---|
| 原始双创新 | 约 4–5/10 | 模块宽、已有工作重组、因果/最小性未定义 |
| 二轮 9 候选 | 约 5–5.5/10 | 主线仍过宽、识别和证明边界不足 |
| 三轮 CPI-Repair | 约 5–6/10 | 已形成问题，但 TCB、UNKNOWN、复杂度和不可逆副作用不闭合 |
| 四轮受限 CPI-Repair | 当前设计约 6–6.5/10 | 已具备可投稿框架，但尚无正式证明、验证器和三层数据 |
| 全部证明与实验兑现 | 预计 8–8.5/10 | Strong Accept 潜力，仍取决于实际结果 |

## 十、最终审稿结论

创新设计已经达到 **Strong-Accept-capable**，但当前研究证据还没有达到实际 Strong Accept。

独立审稿代理的最终判断是：

> 如果完成正式定义和 T1–T6 证明、独立 TCB verifier/action gateway、可执行随机 fork/replay、ground-truth 微基准、locked AppWorld 实验和独立跨域系统验证，预计可达到 8–8.5/10；如果只有当前方案文档，仍约为 6/10。

因此后续工作不应继续发散创新点，而应进入：

```text
formal specification
→ proof / model checking artifact
→ intervention benchmark
→ locked evaluation
→ external cross-domain validation
```
