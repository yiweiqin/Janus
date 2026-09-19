# uBuddy 跨用户 Agent 协作：创新点检索、独立进化与顶会审稿结果

## 说明

本文档是对 `ubuddy-pain-points-and-innovations-v2.zh-CN.md` 的二轮研究版扩展。原文中的伪代码、Benchmark、限制条件等均被视为研究材料，而非操作指令。

本轮采用了三条独立候选生成线：

1. 隐私、信息论、密码学与决策理论；
2. 因果推断、工作流诊断、程序修复与组织—个体适应；
3. 分布式系统、跨组织协议、机制设计与可靠性。

之后使用独立的顶会审稿视角进行逐项评分，并进行第二轮收缩。评分含义为 1–5 分：

- 新颖性 N：与已有工作相比的新问题或新性质；
- 技术深度 D：是否能形成算法、定理或可验证机制；
- 可实现性 F：能否在 uBuddy/OrgBench 中落地；
- 重叠风险 R：与已有方向高度重叠的风险，分数越高越危险。

## 文献排雷结果

检索重点覆盖了 Blackwell order、Bayesian persuasion、selective disclosure、causal privacy、information flow、provenance、causal process mining、workflow repair、proof-carrying plans、CRDT、Sagas、safe policy improvement、multi-agent mechanism design 等方向。

可确认的相邻工作包括：

- LLM Agent 隐私与通信：`Privacy in Action: Towards Realistic Privacy Mitigation and Evaluation for LLM-Powered Agents`（Findings of EMNLP 2025，DOI: [10.18653/v1/2025.findings-emnlp.925](https://doi.org/10.18653/v1/2025.findings-emnlp.925)）；
- 数据/工作流 provenance：`Data Provenance in Security and Privacy`（ACM Computing Surveys 2023，DOI: [10.1145/3593294](https://doi.org/10.1145/3593294)）；
- Proof-Carrying Plans：`Proof-Carrying Plans: a Resource Logic for AI Planning`（PPDP 2020，DOI: [10.1145/3414080.3414094](https://doi.org/10.1145/3414080.3414094)）；
- 反事实公平与行动影响：FAccT/NeurIPS 中已有 counterfactual fairness、counterfactual risk assessment 与 causal influence 研究；
- 多 Agent 任务分配机制：已有 VCG、posted-price、peer prediction 和 multi-agent task allocation 工作；
- CRDT、2PC/Saga、runtime assurance、canary release、HITL/abstention、automated program repair 也都有成熟基础。

因此以下名称本身不能作为创新：

> provenance、causal、Blackwell、CRDT、2PC、zero-knowledge、rollback、reputation、workflow repair。

只有新的问题定义、可证明性质、干预语义或跨层实验，才可能构成论文贡献。

## 二轮筛选后的 9 个高潜力创新点

### 1. 机制级干预因果诊断（Mechanism-level Interventional Diagnosis）

**新命题**：将跨用户协作的 full-chain 事件抽象为时序结构因果模型。机制变量不是代码位置，而是 `data / logic / quality / freshness / review / capability / resource / risk / downstream-impact` 等依赖机制。定义机制必要性：

\[
N_j = E[Y\mid do(M_j=healthy)]-E[Y\mid do(M_j=faulty)]
\]

并寻找连接机制故障到终局验收失败的最小因果割集。

**与已有工作的边界**：provenance 只说明发生了什么；fault localization 只定位异常位置；credit assignment 通常只分配结果分数。这里要求执行受预算约束的机制干预，并估计对终局结果的影响。

**必须增加的技术内容**：明确干预语言、可识别性条件、时间变化混杂处理、未观测混杂敏感性分析，以及机制到真实工具调用的映射。

**关键实验**：正交注入约束丢失、旧版本消费、画像过期、工具超时、错误分配等故障；比较事件启发式、LLM judge、SHAP/相关性方法和 SCM 干预。报告机制 macro-F1、传播路径 IoU、ATE/PEHE 和干预次数。

**评分**：N=3，D=4，F=3，R=4。适合作为主线的诊断模块，不应仅声称“有三张图”。

### 2. 因果最小充分修复集（Causal Minimal Sufficient Repair Set, CMRS）

**新命题**：候选修复动作同时覆盖计划、路由、依赖、版本、契约、权限和 Skill。寻找最小代价集合：

\[
R^*=\arg\min_R cost(R),\quad P(Y=1\mid do(R))\geq \eta
\]

并要求修复不引入环、不越权且保留 liveness。

**可证明性质**：若干预效益是单调次模函数，贪心达到 \(1-1/e\) 近似；采用成功效应的下置信界作为上线条件，可控制错误修复采用概率；一般情况给 MILP/branch-and-bound 或 FPT 复杂度界。

**与已有工作的边界**：beam search 只枚举候选；fault localization 只输出可疑点；causal recourse 往往不处理 Agent 依赖和权限语义。CMRS 的对象是跨组织工作流中的联合干预集。

**关键实验**：多故障 episode，对比贪心、beam、只重规划、只改代码。报告成功率约束违例、修复成本、动作数、过修复率、恢复时间和近似比。

**评分**：N=4，D=5，F=4，R=3。当前最值得优先实现。

### 3. 契约—程序联合修复（Contract–Program Joint Repair）

**新命题**：把节点契约 \(\phi_e=(pre,post,schema,version,permission)\)、任务计划 \(\pi\) 和代码补丁 \(p\) 放入同一个 typed transition system。修复必须满足全局验收谓词 \(G\)：

\[
Exec(T,p,\pi,\sigma)\models G
\]

**可证明性质**：在给定补丁模板类和符号执行覆盖条件下，验证通过的修复对有界执行 sound；在模板类内部可给相对 completeness。

**与已有工作的边界**：SWE-bench/自动程序修复只改代码；workflow replan 只改图；二者都可能留下版本、权限、时序和下游消费契约不一致。新意必须来自统一语义，而不是把两个工具串联。

**关键实验**：AppWorld API 故障与 SWE-bench 风格代码错误组合；对比纯 patch、纯重规划和联合搜索。报告契约违例、回归率、修复正确率与跨任务迁移。

**评分**：N=3，D=5，F=3，R=4。适合作为 CMRS 的高价值修复动作类型。

### 4. 组织—个体双层因果共同适应（Bilevel Causal Co-adaptation）

**新命题**：组织策略参数 \(\theta_O\) 与个体能力参数 \(\theta_i\) 作为两个可干预层，使用 2×2 因子实验估计交互效应：

\[
\Delta_{int}=Y(1,1)-Y(1,0)-Y(0,1)+Y(0,0)
\]

它回答“增加验证节点与提升 Agent Skill 是互补、替代，还是重复成本”。

**可证明性质**：正交随机化下交互效应无偏；只有当其下置信界超过阈值时才允许长期更新；在局部 Lipschitz/强凸假设下，双层坐标更新可收敛到稳定点。

**与已有工作的边界**：多 Agent credit assignment 通常只分摊结果分数；hierarchical MARL 不直接区分组织编排与个体能力的干预交互。

**关键实验**：组织策略×Agent Skill 的 2×2×task-family 实验，测迁移收益、负迁移率、交互效应校准和责任层混淆。

**评分**：N=3，D=4，F=2，R=4。建议并入主因果框架，而不要单独作为整篇论文。

### 5. 证据门控的安全进化（Evidence-gated Safe Adaptation）

**新命题**：候选更新携带作用域、适用域、证据集合和隐私风险。用双重稳健 OPE 或随机 canary 估计干预效应 \(\tau_v\)，只有满足：

\[
LCB_\alpha(\tau_v)\geq\delta,\quad privacyRisk\leq\rho_{max},\quad shift\leq\kappa
\]

才允许采用。不可逆副作用不做“反事实回滚”，而使用补偿、撤销或向前修复。

**与已有工作的边界**：safe policy improvement、canary、runtime assurance 已分别存在；新意是把因果效应下界、证据陈旧、跨任务负迁移和隐私风险放入同一个发布判据。

**关键实验**：跨 task-family 的负迁移注入、分布漂移和错误证据；比较无门控、静态阈值、人工审核和因果门控。报告错误经验采用率、回滚/补偿恢复时间和 anytime 风险控制。

**评分**：N=3，D=4，F=3，R=4。适合作为系统治理层。

### 6. Blackwell 最小协作信号（Blackwell-minimal Collaboration Experiment）

**新命题**：把消息建模为统计实验 \(K:S\to\Delta(Z)\)，而不是字段子集。要求在任务效用至少达到 \(U^*-\epsilon\) 的可行集合中，寻找不存在更弱 garbling 的实验：

\[
\nexists K'\text{ feasible}: K\succ_B K'
\]

注意 Blackwell 偏序不是全序，不能不加条件地声称存在唯一全局最小实验。

**与已有工作的边界**：selective disclosure、互信息正则和 DP 通常优化字段、统计泄露或信息量；Blackwell 目标是决策实验在支配关系下的最小性，允许随机信号和多轮适应。

**关键实验**：排程、匹配、推荐任务上比较字段披露、MI bottleneck、DP 噪声和 Blackwell 协议；测同等成功率下消息长度、敏感属性行动推断和支配率。

**评分**：N=4（有定理时可到 5），D=5，F=3，R=3。理论型隐私主线候选。

### 7. 联盟反事实行动泄漏（Coalition Counterfactual Action Leakage）

**新命题**：隐私不只定义为“秘密能否被猜出”，而定义为敏感状态变化是否改变串谋 Agent 的后续行动。对最多 \(t\) 个 Agent 的联盟 \(C\)，要求：

\[
\sup_{s\sim s'} TV\big(\pi_C(A\mid do(S=s)),\pi_C(A\mid do(S=s'))\big)\leq\kappa
\]

可进一步研究多轮自适应视图下的组合界。若每轮条件机制在所有历史下满足 \(\kappa_r\) 约束，可用 Markov kernel 的收缩性质给出 \(\min(1,\sum_r\kappa_r)\) 型上界。

**与已有工作的边界**：per-agent ACL、DP 或互信息无法直接约束多视图拼接和行动后果；因果信息流和 noninterference 提供相邻基础，但不针对跨用户 Agent 的动态联盟协议。

**关键实验**：2–4 个 Agent 串谋、链式转发、模型记忆和策略漂移；比较 ACL、独立 DP 预算和联盟感知随机化。报告行动 TV、敏感决策差异、效用损失和组合界紧度。

**评分**：N=4，D=5，F=3，R=4。隐私论文建议将其与第 6 点合并，称为“决策充分信号与联盟反事实隐私”。

### 8. 认知证据格与语义事务状态机（Evidence Lattice + Semantic Transaction）

**新命题**：共享状态不是单值事实，而是不可约证据 token、来源/推导 ID、冲突集合、有效期和未决义务；join 只做集合并、去重和冲突保留，数值置信度是格上的可重算 projection。动作 capsule 携带前置/后置条件、幂等键和补偿 DAG。只有证据下界满足前置条件时才提交动作。

**可证明性质**：证据 join 满足交换、结合、幂等并最终收敛；在补偿闭包和明确分区假设下，动作提交保持安全不变量，但活性会付出延迟或阻塞代价。

**与已有工作的边界**：普通 provenance/event sourcing 只记录事件；CRDT 只保证状态收敛；2PC/Saga 只处理事务流程，不保证证据语义、前后置条件与不确定性传播。

**关键实验**：网络分区、冲突证据、过期画像、部分副作用和不可补偿动作；测收敛时间、错误信念存活、unsafe side-effect、补偿成功率和提交尾延迟。

**评分**：N=4，D=4，F=4，R=4。若不能处理非单调信念修订、相关证据双计数和补偿不可组合，应降级为系统组件。

### 9. 反事实运行时干预策略（Dynamic Intervention Policy）

**新命题**：在每个时刻选择 `continue / reassign / replan / human-review`，把人审和重规划视为动态 treatment，而非静态阈值。目标是最大化：

\[
success-\lambda delay-\mu humanCost
\]

在序列可交换性和 positivity 下，用 g-computation/TMLE 或 fitted Q evaluation 估计动态策略值和 regret。

**与已有工作的边界**：诊断方法回答“哪里可能出错”；固定阈值回答“达到条件就重规划”。DTR 学习的是“在什么证据状态下采取哪种干预”。

**关键实验**：故障恢复、需求修改、隐私边界冲突和人类不可用场景；比较固定规则、LLM heuristic、总是自动、总是人审和 DTR。报告单位人时成本成功率、无谓重规划和策略 regret。

**评分**：N=4，D=4，F=4，R=4。建议作为第 1–2 点的运行时扩展，不单独投稿。

## 淘汰或降级项

以下方向不建议目前单独列为主贡献：

- 普通字段级 selective disclosure、单纯 MI/DP 正则：与已有工作重叠太大；
- “因果信道容量防火墙”单独命名：容易被认为是 directed information、privacy funnel 或 causal information flow 的重命名；应并入第 7 点并给组合界；
- 多方隐私外部性否决：政策与机制设计成分太重，应作为第 7 点的治理扩展，并给 liveness、福利和 Sybil 约束；
- 单独 CRDT、2PC/Saga、Proof-Carrying Plan：已有基础成熟，必须合并成第 8 点的证据—动作语义并证明新性质；
- 隐藏挑战信誉、水印追踪、HITL 停止规则：适合作为审计或运行时组件；
- 私密偏好拓扑匹配、公平交换：除非能给出新的隐私定理或针对 Agent 探测攻击的上界，否则不宜作为主贡献；
- “反事实回滚”：现实副作用不可回滚，应改用补偿、撤销或向前修复。

## 推荐的两条论文主线

### 主线 A：Interventional Workflow Repair

统一对象：

\[
s=(SCM\ dependency\ graph, evidence, contract/program, pending\ actions)
\]

流程为：

```text
事件/谱系观测 → 机制级干预诊断 → 因果最小充分修复集
→ 契约/程序语义验证 → 提交、补偿或向前修复
```

建议正文主贡献为第 1、2、3 点，第 9 点作为运行时策略。

中心定理只承诺有限条件下的：

1. 机制识别概率至少为 \(1-\delta\)；
2. 修复阻断所有指定不安全因果路径并保留 liveness；
3. 修复代价为最优解的 \(\alpha\)-近似，或在参数化空间中 FPT；
4. 失败时不变量不被破坏。

### 主线 B：Governed Cross-Owner Co-Adaptation

统一对象：

\[
\text{evidence-conditioned signal and action protocol}
\]

流程为：

```text
决策需求 → Blackwell 最小信号 → 联盟反事实泄漏约束
→ 认知证据格合并 → 语义动作提交 → 因果证据门控进化
```

建议正文主贡献为第 6、7、8 点，第 5 点做发布治理，第 4 点做跨组织迁移实验。

不建议把两条主线的所有模块塞进一篇论文。若 uBuddy 当前工程能力主要集中在工作流、谱系和 evolutionCoordinator，主线 A 更容易先形成可验证成果；若拥有强密码学/信息论合作能力，主线 B 的理论新颖度更高。

## 必须修正的可识别性与实验原则

1. 仅凭自然运行日志不能证明因果关系。必须在 task family 内随机化故障注入、字段 mask、路由、依赖顺序或 Agent 分配；自然数据只用于外部效度。
2. 明确一致性、positivity、序列可交换性和无关键未观测混杂等假设；对不可随机化变量报告 Rosenbaum 或其他敏感性界。
3. `EvaluateDecision` 不能只靠一次 LLM 判断；应使用多次采样、规则 evaluator、隐藏标签或历史任务，并报告校准误差。
4. Blackwell 极小元不一定唯一；除非限定 garbling-closed 链或加入凸泄漏函数，否则只能声称 Pareto 极小或不存在更弱可行实验。
5. 联盟隐私组合界必须对所有历史条件成立，不能无条件把每轮泄漏相乘；相关视图和自适应转发必须进入威胁模型。
6. 认知证据格的主体应是证据 token 和冲突集合，置信度是可重算投影；不能直接把相关 confidence 当作 CRDT 的 join。
7. 不可逆外部副作用只能补偿或向前修复，不能声称“回滚反事实世界”。
8. 评估必须包含未见组织、未见机制、真实工具轨迹和自适应串谋者，避免只在合成 SCM 上自证。

## 当前建议的实现优先级

```text
P0: 机制级因果诊断 → 因果最小修复集 → 契约/程序联合验证
P1: 证据门控安全进化 → 组织×个体交互实验 → 动态干预策略
P2: Blackwell 最小信号 → 联盟反事实行动泄漏 → 认知证据格/语义事务
```

“至少 8 个创新点”的研究储备已经满足，但投稿时应将其组织为 1 个主命题簇、2–3 个支撑模块，而不是平铺 9 个并列贡献。

## 独立审稿结论摘要

独立顶会审稿代理的结论是：

- 最稳主线：第 1+2+3 点，形成“干预诊断—最小修复—契约验证”；
- 理论潜力最高：第 6 点，但必须给存在性、复杂度或近似定理；
- 隐私线应合并第 6+7 点，第 7 点单独命名会像已有 causal information flow/DP composition 的变体；
- 系统线可合并第 8 点，但必须解决信念修订非单调、证据双计数、2PC 阻塞和补偿不可组合；
- 第 4、5、9 点宜作为治理、迁移和运行时组件；
- 最大致命风险是概念重命名、SCM 假设不可验证、不可逆副作用被错误称为 rollback、修复搜索不可扩展，以及只用合成数据形成闭环自证。

## 第三、四轮强接收预审：主线收缩版

经过第三轮和第四轮独立审稿，建议将投稿主线固定为：

> **Contract-Preserving Interventional Repair for Cross-Organization Agent Workflows（CPI-Repair）**

不再把隐私、CRDT、机制设计、信誉和人类介入作为并列主贡献。它们最多作为扩展实验或实现组件。

### 受限但可验证的问题定义

工作流被定义为有限状态、有限时域的 typed transition system：

\[
W=(S,s_0,A,\delta,O,D,\mathcal{G},Inv,\Omega,\Lambda,H)
\]

其中：

- `S` 是有限状态或显式抽象后的有限状态；
- `A` 是带类型和组织所有权的动作；
- `δ` 是可重放转移，显式包含随机种子和外部世界快照；
- `O` 是公共观察投影；
- `D` 是允许在证书约束下重连的依赖 DAG；
- `\mathcal{G}` 是不可修改的全局目标/验收规格；
- `Inv` 是不可修改的公共不变量；
- `Ω/Λ` 是所有权和能力边界；
- `H` 是最大执行步数。

每个节点契约包含前置、后置、Schema、版本/时效、权限和幂等条件。修复只能是 refinement-only：原调用条件蕴含新实现可接受条件，新实现保证蕴含原保证；不能通过弱化原验收谓词来制造“成功”。

公共状态只能通过事件、版本哈希、权限元数据和证书观察。私有状态必须由组织内 trusted local monitor 和 Action Gateway 读取。若两个候选世界在公共观察上不可区分，系统返回 `coverageUnknown`，而不是给出未经支持的因果结论。

### 可执行干预与 CMRS

修复动作不是文本候选，而是可执行 primitive：

```text
reassign / rewire / bind-version / patch / guard / compensate
```

每个动作声明 read/write set、owner scope、成本和局部证明义务。给定失败历史 `h`、候选库 `L`、成功阈值 `η` 和风险水平 `α`，CMRS 是满足以下条件且 inclusion-minimal 的干预集：

1. 类型、所有权和能力边界合法；
2. 通过 Gateway 与 bounded verifier，保持不可变契约和不变量；
3. 在支持集内，\(LCB_{1-\alpha}P(Y=1\mid do(R),h)\geq\eta\)；
4. 不存在满足前述条件的真子集。

若没有足够的 replay/shadow 支持，必须 abstain 或返回 `coverageUnknown`。

### 达到 Strong Accept 所需的最小定理包

第四轮理论审稿认为，以下定理包是从 Weak Reject 提升到 Strong Accept 边缘的最低要求：

1. **Bounded contract soundness**：在有限状态、有限时域、局部 assume–guarantee 证书、边契约兼容、权限/版本/幂等检查通过且写集无冲突时，拓扑归纳保证所有可达轨迹满足原始契约、`\mathcal{G}` 和 `Inv`。
2. **Verifier soundness / relative completeness**：若有限抽象系统通过 forward simulation 覆盖 Gateway 的每个 concrete step，则 verifier 接受蕴含 concrete bounded soundness；只有在 ≤H 可达状态上 exact/bisimilar、模板库能表达目标修复且 solver 完备时，才声称相对于该模板库的 completeness。普通 over-approximation 不能直接推出 completeness。
3. **Interventional identification**：在 reset 隔离、consistency、序列可交换性、positivity、机制稳定和 TCB 观察完整等条件下，extended g-formula 识别修复效果；cross-fitted DR/TMLE 给一致估计和有限样本置信区间。不可区分世界必须返回 `coverageUnknown`。
4. **CMRS complexity/approximation**：一般 CMRS 至少 NP-hard；若真实增益或经过独立验证的保守 surrogate 是 normalized monotone submodular，给出正确的 cost-aware threshold-cover 近似界；存在高阶互补时切换 MILP/MaxSAT，不虚报 greedy 保证。
5. **Synthesis complexity**：明确有限状态验证、符号状态验证和程序 patch synthesis 的复杂度边界；把 solver timeout 和 abstention 作为结果，而不是隐藏失败。
6. **Holdout reuse**：所有候选搜索和调参只在 development episodes；locked holdout 只做最终一次评估。若候选类预注册且大小为 `M`，uniform Hoeffding 可同时控制误差 `sqrt(ln(2M/δ)/(2n))`；若允许从 holdout 继续生成候选，必须采用 reusable holdout/隐私筛选并限制输出信息量。
7. **不可逆副作用安全**：用 Action Gateway 的 linearization point、fencing token、幂等键和补偿闭包保证崩溃/重放下的不变量；无补偿动作只能在副作用前人工确认或 abstain，不能称为反事实回滚。

### 最小可行 Strong-Accept 实验

**穷举微基准**：32 个 finite-state workflow（8 个拓扑 × 4 个组织/权限布局），每个实例包含 6 类单故障、4 类双故障和 6–10 个候选 primitive。固定世界快照与随机种子，穷举所有安全子集，得到真实 CMRS 和真实 `V(R)`，用于验证 soundness、relative completeness、识别误差、最小性和近似界。

**AppWorld locked test**：24 个官方任务 × 3 个随机种子；开发集与 locked task family 严格分离。对比 NoRepair、causal-RCA top-1、workflow-only、code-only 和 CPI-Repair。首要指标是官方成功率、hard-contract violation（目标接近 0）、归一化修复成本、过修复率、恢复时间和 abstention correctness。

必要消融：

- 去掉因果估计；
- 去掉契约证书；
- 仅 workflow 修复；
- 仅 code 修复；
- 用点估计替代 simultaneous LCB；
- 去掉 Action Gateway。

### 第四轮预审结论

当前主线如果只停留在概念、日志回放或一次性成功案例，仍然约为 5–5.5/10（Weak Reject）。如果完成上述受限定义、T1–T7 中至少核心三项的形式证明或机器检查 artifact，并在穷举微基准和 AppWorld locked test 上验证：

- 契约硬违规接近 0；
- CMRS 成本/成功率优于 causal-RCA、workflow-only 和 code-only；
- `coverageUnknown` 能正确拒绝无支持的因果结论；
- 理论近似界与穷举结果一致；

则审稿预估可提升到约 7.5–8/10，达到 Strong Accept 边缘。该判断是有条件的，不代表仅凭当前文档即可声称已经 Strong Accept。
