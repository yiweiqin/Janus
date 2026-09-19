# uBuddy v3 痛点与创新点专项评审

> 评审对象：`ubuddy-pain-points-and-innovations-v3-strong-accept-ready.zh-CN.md`  
> 评审范围：仅评价问题痛点、创新主张、概念定义、研究边界与不可替代性  
> 不在本轮评价范围：实验是否完成、定理是否已经证明、系统是否已经实现、论文写作是否完整

## 0. 评审口径与结论先行

这不是一次完整论文审稿，而是一次“研究问题与创新点设计审查”。因此，本评审不会因为原稿目前没有实验结果、正式证明、完整相关工作或实现细节而扣分；这些内容只会被作为未来验证创新主张所需的证据列出。真正影响本轮判断的是：问题是否真实且聚焦、核心对象是否定义自洽、创新是否可被已有方向简单替代、各项贡献是否共同服务于同一个不可分割的研究内核。

总体判断如下：

- 选题重要，痛点具有现实性，且“从观察性根因分析转向可执行干预修复”是一个正确而有价值的方向升级。
- `intervention + fixed public contract + sufficient repair` 已经形成一个有潜力的创新三角，但当前尚未被压缩成足够尖锐、不可被拆解替代的唯一 novelty kernel。
- 当前最大的风险不是“没有实验”，而是核心目标在“总体分布上的修复有效性”和“修复当前这个失败实例”之间摇摆。这会直接改变问题定义、识别条件、返回语义和论文声称的价值。
- “不弱化契约”的直觉正确，但现有 refinement 定义仍存在通过强化前置条件、缩小输入域、改变观察投影等方式逃逸的空间。
- 软任务成功与硬安全属性在现有定义和 T1 中有语义混合；不可逆副作用与“所有轨迹始终满足 invariant”的主张也没有完全兼容。
- 痛点一、二、三不是三个平行的独立大问题，更适合被组织成一个总痛点下的三重困难：可识别性、合法性、可搜索/可执行性。
- 若只评价创新设计的当前成熟度，我会给出 **Borderline / Weak Accept 潜力**，而不是把它称为已经 Strong-Accept-ready。这里的保留意见来自概念边界和不可替代性，绝不是因为工作尚处在创新挖掘阶段。

建议当前阶段不要继续增加更多模块、定理或场景，而是优先完成一次“创新核收缩”：明确研究到底为谁、在什么信息条件下、对哪个失败对象、提供何种级别的修复保证。

## 1. 只针对创新阶段的评分

| 维度 | 评分 | 评语 |
|---|---:|---|
| 痛点重要性 | 4.5/5 | 跨组织、部分可观测、带外部副作用的 Agent workflow 修复是现实且有增长性的研究问题。 |
| 痛点真实性 | 4.5/5 | 三类困难都能在真实系统中出现，不是为了形式化而虚构的问题。 |
| 痛点聚焦度 | 3.0/5 | 三个痛点存在强重叠，当前表达容易让人感觉一项工作同时承诺解决三个大领域问题。 |
| 创新潜力 | 4.0/5 | “不弱化固定契约的干预式最小充分修复”有成为独立问题定义的潜力。 |
| 当前原创性表达 | 3.0/5 | 组合方式有新意，但尚未清楚说明哪项性质不是已有模块串联即可得到。 |
| 当前不可替代性 | 2.5/5 | active diagnosis、contract repair、CEGIS/MaxSMT、safe repair、Saga/gateway 等都能覆盖部分叙事。 |
| 概念自洽性 | 2.5/5 | population/instance、soft/hard、invariant/compensation、minimality/cost 等处仍有关键张力。 |
| 可证伪性 | 3.5/5 | 已有阈值、成本、拒答和安全义务，具备可验证雏形；仍需固定目标人群和评价条件。 |
| 研究边界成熟度 | 3.0/5 | 已经主动承认 coverageUnknown、有限模板、有限时域，但贡献包仍过宽。 |
| 综合创新阶段判断 | 约 6/10 | 具有明确潜力，但尚不宜自称 Strong-Accept-ready。 |

这里的 6/10 不是对未来完整论文的预测，也不是因缺少实验而给出的分数。它只表示：现有创新方案已经超过宽泛构想，但核心主张还需要一次实质性收缩和语义修复，才能成为顶会审稿人较难用“已有模块组合”否定的问题。

## 2. 对三个痛点的总体评价

### 2.1 三个痛点都成立，但不宜包装成三个并列主问题

原稿的三个痛点分别强调：

1. 公共观察不可区分，导致仅靠日志无法识别真正原因；
2. 有效 patch 可能恢复成功，却破坏原始公共契约；
3. 修复搜索受因果覆盖、组合交互和不可逆副作用共同约束。

这三点都是真问题。但从审稿人的结构视角看，它们并不是彼此独立的三个核心发现，而是同一问题的三类约束：

```text
部分可观测      → 什么效果可以被识别
固定公共契约    → 什么修复是合法的
组合与副作用    → 什么修复可以被找到并安全执行
```

如果把它们作为三个平行痛点，很容易产生“问题铺得过大”的观感：工作似乎同时试图解决因果识别、程序/契约修复、组合优化和分布式事务安全。更强的写法是先给出一个无法被现有工作完整表达的总痛点，再把这三点作为总痛点之所以困难的三个原因。

一个较好的总痛点候选是：

> 在部分可观测的跨组织 Agent workflow 中，如何基于可执行干预，找到一个对目标失败具有充分证据、成本最小、同时不弱化既定公共契约的可执行修复？

但这里暂时使用“目标失败”，而没有写“当前失败实例”，是因为原稿目前尚未解决个体修复与总体修复效果之间的定义冲突。该问题会在后文作为最高优先级问题展开。

### 2.2 痛点一：公共观察不可区分

#### 成立之处

这是三个痛点中理论动机最清晰的一项。跨组织环境天然存在私有 Prompt、Memory、工具内部状态、权限和业务数据，仅凭公共轨迹确实可能出现 observational equivalence：多个不同的私有机制产生相同的公开观察，却对应不同的最优修复。

原稿没有把问题简单描述为“日志不足”，而是进一步问“哪些修复效果可通过干预识别，哪些必须返回 coverageUnknown”，这是成熟且值得保留的表达。它避免了很多 Agent RCA 工作中的常见过度主张：从相关性、异常分数或单条执行轨迹直接跳到根因结论。

#### 当前不足

痛点一目前同时包含了三个层次：

- 观察不可区分；
- 干预效果是否可识别；
- 干预覆盖不足时是否拒答。

第一点是问题条件，第二点是技术挑战，第三点是合理输出策略。建议不要把三者都作为“痛点发现”来强调，否则 novelty 会显得来自常规因果推断术语的重新包装。

此外，原稿需要更明确地区分：

- 无法识别“真实根因”；
- 无法识别“某个候选修复的效果”；
- 无法证明“某个修复对当前实例有效”。

这三件事不是同一任务。一个系统完全可能不知道真实根因，却能通过随机试验发现某个 repair 在目标分布上有效；也可能知道总体平均有效，却无法判断当前失败是否属于受益子群。CPI-Repair 最有机会成立的路线是弱化“找出真实根因”的叙事，把重点放在“识别合法修复的效果和充分性”上。

#### 建议保留的痛点表述

> 跨信任域的公开历史不足以唯一确定私有失败机制，因此修复不能仅由观察性 RCA 排名产生；系统必须明确修复效果的干预识别边界，并在候选世界对修复结论不一致时拒答。

这比“识别真正原因”更稳健，因为它不要求解决一般意义上的个体因果归因。

### 2.3 痛点二：成功修复可能破坏公共契约

#### 成立之处

这是最可能构成 CPI-Repair 独有价值的一项。Agent workflow 中“让任务成功”常常可以通过降低验收标准、绕过权限、复用过期 artifact、跳过必要步骤或扩大执行者权限实现。若只优化 evaluator success，系统可能产生 reward hacking 或 contract laundering。

原稿强调 evaluator/validator 不应被修复过程随意弱化，并将固定公共契约作为修复合法性的边界，这是很有价值的研究立场。相比只追求成功率的自反思、重规划或 workflow optimization，该约束确实提出了不同的目标。

#### 当前不足

“不弱化契约”目前仍是直觉上强、形式上不够封闭。仅声明允许 refinement 并不能自动排除以下逃逸方式：

- 把原本接受的输入排除在修复后输入域之外；
- 强化调用方必须满足的 precondition；
- 修改环境 assumption，使困难场景不再属于系统责任；
- 改变 verifier 可见的投影或隐藏不利字段；
- 缩小 contract 的适用 scope；
- 把必须产生的正常结果改为允许返回 exception；
- 保留表面 Post 条件，却改变 freshness、frame condition 或授权语义；
- 通过重定义 reference evaluator 的输入，使任务“形式成功”。

这些方式都可能在某种局部逻辑顺序下被描述为 refinement，但从端到端公共承诺看属于实质弱化。

因此，痛点二若要成为创新核心，需要先给出一个对 Agent workflow 场景足够明确的 refinement order。至少应说明：

```text
调用方假设不得被强化；
原始可接受输入域不得被缩小；
required effect 不得删除或降格为可选/异常；
权限、freshness、版本和 frame 条件不得弱化；
reference evaluator 及其观察投影固定；
允许强化实现保证，或减少实现对环境的额外依赖。
```

如果论文真正能够把这种“anti-evasion contract preservation”定义清楚，它可能比“用了独立 verifier”本身更有原创价值。

### 2.4 痛点三：覆盖、组合交互和不可逆副作用

#### 成立之处

该痛点揭示了单点 root-cause ranking 与真实修复之间的距离：最相关的故障点未必有可执行 repair，单个 repair 可能无效而组合有效，外部动作可能不可回滚，自适应搜索还会影响置信保证。这些观察都准确。

尤其值得保留的是两点：

- 不把不可逆外部动作描述为“反事实回滚”；
- 当干预没有支持或验证义务失败时允许 abstain。

这两点体现了对系统语义和统计边界的克制。

#### 当前不足

这一痛点内部塞入了过多不同性质的问题：

- positivity/support 属于因果识别条件；
- repair synergy 属于组合搜索结构；
- 自适应选择属于统计推断；
- 不可逆副作用属于执行语义和恢复模型；
- solver 选择属于算法工程。

这些问题可以共同存在，但不能都被当成同等级核心创新。否则第三个痛点本身就足以拆成三篇论文。

建议把痛点三降为“从候选修复到可执行修复的闭环困难”，并只选择一个主要理论结构。例如：

> 即使单个合法干预的效果可估计，最小充分修复仍是集合级问题：候选动作存在互补关系，组合支持有限，且执行时受不可逆 effect boundary 约束。

然后明确本文主要解决集合级最小充分修复；gateway、补偿和 solver portfolio 是使问题可执行所需的边界，而不是三个额外平行贡献。

## 3. 对 CPI-Repair 核心创新的评价

### 3.1 当前最有希望的 novelty kernel

原稿最有希望成立的创新核，不是规划/执行双图、lineage、独立 verifier、Action Gateway、随机 replay 或某一种 solver。这些组件在各自领域都有充分先例。真正可能不可替代的是以下联合对象：

> 在固定、不可通过修复弱化的公共契约下，从有限可执行干预集合中，寻找一个具有目标级成功充分性保证的最小成本 repair set；当部分可观测性使该保证不可识别时，系统必须拒答。

其关键不在于简单地“同时使用因果、契约和优化”，而在于三者是否共同定义了一个过去工作没有表达的可判定对象：

```text
候选动作必须是真实可执行干预；
其有效性必须以干预语义而非观察相关性定义；
其合法性由固定公共契约而非可修改 evaluator 限定；
输出是集合级充分修复，而非 root-cause 排名或任意可行 patch；
不可识别时是 UNKNOWN，而非猜测。
```

后续所有贡献都应围绕这个对象服务。任何不能强化上述对象定义或解决其独特困难的模块，都应降级为系统支撑。

### 3.2 当前的“模块拼装”攻击仍然有效

从顶会审稿人角度，最自然的负面评价会是：

> 该工作把 active causal diagnosis 用于找 intervention，把 contract refinement/verified repair 用于筛除不安全 patch，把 CEGIS/MaxSMT/MILP 用于搜索最小 repair set，再用 Saga/transactional gateway 执行。每个部件均已有，联合主要是工程集成。

要抵御这一评价，不能只说“以前没有工作把这些都组合起来”。顶会创新通常要求说明：组合后出现了一个新的对象、新的不可兼容性、新的保证或新的复杂度结构，而不是模块数量更多。

建议用一个非常尖锐的问题检验每版创新：

> CPI-Repair 所保证的哪项性质必须同时依赖 intervention、contract preservation 与 cross-layer set repair，且任何单一已有方向都无法表达或通过顺序调用直接得到？

如果答案只是“最后同时获得成功率、安全和低成本”，仍然偏弱，因为这可能只是多约束优化。如果答案是“在 observationally equivalent private worlds 中，只有满足固定公共承诺且对所有一致世界达到条件充分性的最小干预集合才可返回，否则 UNKNOWN”，那么创新对象会明显更尖锐。

### 3.3 “跨组织”目前是必要条件还是应用包装，尚不清楚

跨组织设定带来了私有状态、owner authorization、边界证书和不能共享完整日志等约束。但需要追问：如果把同一问题放在单组织、模块化但部分可观测的 workflow 中，CPI-Repair 的主要定义和算法是否基本不变？

如果答案是基本不变，那么“cross-organization”更多是重要应用场景，而不是理论创新成立的必要条件。此时不应让多组织协议、Action Gateway、attestation 等内容与核心因果修复贡献争夺中心位置。

如果答案是不成立，则必须指出跨组织带来的独特不可约束，例如：

- 只能获得组织本地对命题的 certificate，而不能获得全局状态；
- repair authorization 本身会产生选择偏差；
- 不同 owner 的局部 refinement certificate 如何组合成端到端承诺；
- 组织拒绝某一 repair 时，效果估计和可行域如何变化；
- 公开可验证的充分性如何在不泄露私有机制的情况下成立。

只有当至少一个此类问题进入核心定义或核心保证，“跨组织”才不只是故事背景。

## 4. P0：当前必须先解决的概念问题

以下问题被标为 P0，并不是要求现在就给出实验或证明，而是因为它们会改变创新本身的含义。如果不先选择清楚，后续形式化、算法和实验都会朝不同目标发展。

### P0-1：population repair efficacy 与“修复当前失败实例”错位

原稿定义：

\[
V_h(R)=\Pr[\mathcal G(\tau_R)=1\mid do(R),H=h]
\]

同时在 T3 中明确声称的是 population repair efficacy，不把平均干预效应直接称为某一次失败的个体根因。这一克制在因果推断上是正确的。然而，全文的用户价值和语言又反复指向“修复一个失败任务”“当前 consistent cut 后的 suffix”和“当前失败的最小修复”。两者之间存在核心目标错位。

总体分布上成功率达到阈值，并不意味着修复适用于当前失败实例。例如，候选 repair 在 80% 的任务上有效，但当前失败恰好来自剩余 20% 的隐藏机制；由于私有状态不可见，系统无法判断当前实例属于哪一类。此时 `V_h(R) ≥ η` 只能支持“对某个目标分布采用该 repair policy 有较高成功率”，不能支持“这是当前失败的充分修复”。

创新阶段必须明确选择以下路线之一。

#### 路线 A：分布级修复策略

研究问题变为：

> 对来自指定任务/环境分布的一类失败 episode，寻找满足契约约束且总体成功率超过阈值的低成本 repair policy。

优点是更容易使用随机试验和 population efficacy；缺点是“诊断当前失败”“最小充分修复当前 episode”的叙事必须弱化。输出应被称为 high-confidence repair policy，而不是该实例的充分修复或根因修复。

#### 路线 B：当前实例的条件充分修复

研究问题变为：

> 给定当前公开历史、固定契约和可观察上下文，寻找对与当前信息一致的目标上下文具有条件充分性的修复。

此时效果应更接近：

\[
V(R\mid h_{pub}, C, x_{obs})
=\Pr[\mathcal G(\tau_R)=1\mid do(R),h_{pub},C,x_{obs}].
\]

还需要定义：隐藏 effect modifier 如何处理、当前上下文是否在支持内、历史轨迹的后验选择如何影响识别、OOD 上下文何时 abstain。如果要求对所有与公开历史一致的候选私有世界都成功，则是 robust/worst-case repair；如果只要求后验概率成功，则是 Bayesian/conditional repair。两者的保证强度和代价不同。

#### 本评审建议

如果 uBuddy 的核心产品价值是“对这个失败执行进行修复”，建议采用路线 B，并明确允许因隐藏状态不确定而频繁 abstain。若希望保留更强统计可操作性，则采用路线 A，但必须从标题、定义和贡献中删除个体充分修复的暗示。

这是下一版首先应该回答的一句话：

> CPI-Repair 返回的是对任务分布有效的 repair policy，还是对当前失败上下文有效的 repair set？

### P0-2：软成功与硬安全的语义混合

原稿已把 `𝒢` 描述为随机软任务效用，把 `Inv/C_safe` 描述为所有有界轨迹必须满足的硬契约。这一划分是合理的。但 T1 又声称所有修复轨迹满足原始 `𝒢` 和 `Inv`，与后文估计 `Pr[𝒢=1]` 直接冲突。

如果 `𝒢` 是随机成功事件，就不能同时要求每一条轨迹都满足 `𝒢`，否则成功概率天然为 1，也就不需要 LCB、阈值 `η` 和有限样本估计。相反，如果 `𝒢` 是硬后置条件，则不能再把它作为概率软效用。

建议从创新定义开始严格分层：

```text
Hard safety / fixed contract:
  对修复后所有允许的 ≤H 轨迹，C_safe 与 Inv 始终成立。

Soft task success:
  在指定条件或目标分布下，Pr[G=1 | do(R)] ≥ η。
```

若公共契约同时含有 safety 和 liveness/required outcome，则需要进一步拆分：

- safety obligation：任何前缀都不得违反；
- bounded response obligation：在满足 assumption 的轨迹上，H 步内必须产生响应；
- stochastic quality objective：成功概率或效用超过阈值。

这不是文字小修，而是决定“contract-preserving”和“causally sufficient”分别约束什么。

### P0-3：“不弱化契约”需要 anti-evasion 的偏序定义

当前以 refinement 作为合法修复标准，但在开放 Agent workflow 中，契约由 Pre/Post/Schema/Version/Freshness/Auth/Footprint/Idempotence 等多维内容组成，简单的局部 refinement 不一定等于端到端承诺不弱化。

建议下一版至少定义一个公开契约元组：

\[
C=(A,I,G,F,O,E),
\]

其中可以分别代表环境假设、输入域、保证、frame/footprint、观察投影和 evaluator。修复后的 `C'` 满足公共不弱化关系 `C' \preceq_{pub} C`，当且仅当至少满足：

1. 不强化环境/调用方必须满足的假设；
2. 不缩小原始输入域和适用任务域；
3. 不删除、延迟或降格原有 required guarantee；
4. 不扩大未授权读写 footprint；
5. 不降低 freshness、version 或 idempotence 要求；
6. 不改变 reference evaluator 及其公共观察投影；
7. 不把正常成功替换为 exception、人工绕过或静默失败；
8. 允许强化 guarantee，或减少实现方对环境的额外依赖。

如果某些维度允许变化，需要明确其授权主体和证明义务。例如 owner 可以授权扩大本组织内部 footprint，但这不等于公共契约自动允许跨组织权限扩大。

建议把这部分视为核心创新的一部分，而不是 verifier 的实现细节，因为它直接阻止“通过改规则获得成功”的伪修复。

### P0-4：不可逆副作用与 invariant preservation 冲突

原稿正确认识到不可逆动作不能普通 rollback，并引入 compensation / forward repair。但“补偿后恢复业务平衡”与“原 invariant 从未被违反”是不同性质。

例如，若 invariant 是“未经授权不得转账”，一次错误转账发生后，即使之后反向转账补偿，历史上仍然发生过未授权转账，安全属性无法被恢复。若性质是“账户最终净额恢复”，则补偿可以满足 eventual restoration，但中间状态仍可能违反 bounded invariant。

因此需要区分至少四类义务：

```text
Invariant preservation：任何允许前缀都不能违反；
Recoverable postcondition：失败后可通过恢复动作重新达到目标状态；
Compensatable effect：存在业务语义上的补偿闭包，但历史事实不被抹除；
Eventual restoration：允许中间偏离，但要求在时限内恢复某性质。
```

如果某个外部副作用可能违反不可恢复的硬 invariant，那么合法 repair 必须在动作发生前阻止它，事后 compensation 不能成为 contract-preserving 的证明。若只违反可补偿业务目标，则应把该目标从 invariant 中移到 recoverable/eventual 类。

建议在修复 primitive 上声明 effect class：

```text
reversible / idempotent / compensatable / irreversible-and-uncompensatable
```

然后分别给出允许的执行规则。这样 Action Gateway 才真正服务于核心语义，而不是单纯的事务协议组件。

### P0-5：唯一创新核尚未从多模块贡献包中凸显

当前方案同时覆盖：

- active causal diagnosis；
- causal effect estimation；
- workflow/model-based diagnosis；
- contract refinement；
- verified program repair；
- CEGIS、MaxSMT、MILP 和组合优化；
- transactional Action Gateway；
- Saga/compensation；
- proof-carrying certificate；
- 跨组织 authorization/attestation。

每一项都合理，但共同作为主要创新会引发两个问题：一是每个社区都会用本领域成熟工作来要求更深的理论或系统贡献；二是审稿人不容易记住论文到底发现了什么新问题。

建议把贡献分成三层，而不是三项平行创新：

1. **核心研究对象**：fixed-contract interventional sufficient repair；
2. **解决核心对象所需的新方法**：例如条件充分性 + anti-evasion refinement + 集合级 support-aware optimization；
3. **使方法在真实系统中成立的支撑机制**：P/E DAG、lineage、verifier、gateway、certificate、compensation。

只有第一层和确有新意的第二层应写成主要创新贡献。第三层即便工程上非常重要，也应避免与核心理论对象争夺 novelty。

## 5. P1：高风险但可在主线确定后处理的问题

### P1-1：部分可观测与干预识别假设之间存在授权选择偏差

跨组织场景中，repair 不是研究者可以无条件随机施加的 treatment。Owner 可能根据私有状态决定是否授权某个 repair，而该私有状态又可能影响 repair 的成功效果：

```text
私有风险/能力状态
   ├──影响 owner 是否授权 R
   └──影响执行 R 后是否成功
```

这样，即使系统表面随机提出 repair，最终实际执行样本也会受到 authorization-induced selection。若只在“被 owner 接受的 episode”上估计效果，随机化和 exchangeability 可能被破坏。

创新定义需要说明 intervention 的边界究竟是：

- 随机提出 repair proposal 的效果；
- 在 owner 接受条件下执行 repair 的效果；
- 一个包含 owner policy 的端到端 repair policy 效果；
- 仅对预先声明为可授权的 repair 空间进行随机化。

推荐最干净的初始边界是最后一种：有限 repair template 在进入候选集前已获得 owner policy 级授权，运行时拒绝被视为环境结果并触发 abstain。否则 T3 类识别主张会比表面复杂很多。

### P1-2：组合 repair 的 positivity 远比单 primitive support 更难

对于集合级 repair，单个动作均有历史支持，并不意味着它们的组合有支持。两个动作可能从未共同出现；联合执行还会改变后续状态分布，使 sequential propensity 极低。

需要明确 support 的单位：

- primitive-level support；
- pairwise/high-order interaction support；
- 完整 repair-set support；
- 由已知结构模型允许从局部效果组合推断的 support。

如果没有额外结构假设，要求每个候选集合都有完整干预覆盖会导致组合空间中的大多数集合都返回 coverageUnknown。此时方法理论上正确但实用上近乎总拒答。

下一版应说明从局部干预泛化到组合效果依赖什么，例如无交互、有界交互阶数、已知 SCM factorization、单调次模结构或可组合局部机制。并应把预计 abstention rate 作为未来验证创新可用性的关键指标，而不是只报告返回结果的正确率。

### P1-3：最小性的两个定义存在冗余或目标冲突

当前要求：

1. 不存在仍充分的真子集，即 inclusion-minimal；
2. 在所有 repair 中成本全局最小。

若每个 repair primitive 的成本严格为正，则任何全局 minimum-cost sufficient repair 天然是 inclusion-minimal：如果存在充分真子集，删除至少一个正成本动作会得到更低成本，形成矛盾。因此二者不需要同时作为独立性质。

若允许零成本、负成本或风险/代价是非加性的，则需要单独解释。否则建议选择一种主目标：

- **minimum-cost sufficient repair**：最适合做单一优化问题；或
- **inclusion-minimal repairs 的 Pareto frontier**：适合用户需要在成本、风险、授权数和成功率间选择。

“先求成本最小，再删除冗余动作”在严格正加性成本下也显得多余；如果 solver 只给近似解，删除冗余可以作为后处理，但不能声称因此得到全局最小成本。

### P1-4：复杂度贡献像结果目录，而不是围绕一个结构洞见

原稿同时设想 NP-hard、对数不可近似、#P-hard、次模 cover、treewidth FPT、MILP/MaxSAT 和 branch-and-bound。各结论可能都正确，但整体观感会像把常见复杂度结果覆盖一遍，而不是发现 CPI-Repair 特有的结构。

创新阶段建议只保留一个主复杂度故事：

```text
一般 CMRS 的 hardness
+ 一个由 Agent workflow 自然结构诱导的 tractable/FPT subclass
```

关键是特殊类必须来自问题本身，而不是为了得到正结果人为添加。例如，如果跨组织 workflow 通常具有低 treewidth 的组织交互图、有限跨域边界或低阶 repair interaction，那么 FPT 才有解释力。次模、MILP、MaxSMT 可以作为求解策略或 baseline，不必都成为理论贡献。

### P1-5：T6 联合证书目前更像多个结论的拼接

T6 希望同时返回：

```text
contract-preserving
success ≥ η−ε
cost ≤ α·OPT
```

但三类结论依赖不同假设和失败事件：

- contract-preserving 依赖 verifier/abstraction/TCB；
- success confidence 依赖识别、采样、选择和估计；
- approximation ratio 依赖目标函数结构与 solver。

需要显式预算联合失败概率，例如：

\[
\delta_{total}
=\delta_{effect}
+\delta_{adaptive\ selection}
+\delta_{verification}
+\delta_{solver}.
\]

同时，`α` 不可能在次模、非单调强协同、FPT 精确类和 coverageUnknown 情况下统一为同一个保证。更合理的是 certificate 带结构标签：

```text
exact-FPT / submodular-approx / heuristic-no-ratio / coverage-unknown
```

创新层面应避免先承诺一个看似统一、实际由互不兼容前提组成的终局定理。

### P1-6：有限时域与 suffix repair 的语义需要明确

原稿规定 repair 只作用于当前 consistent cut 之后的 suffix，过去副作用转化为 compensation obligation。这是现实的，但它意味着 repair 的保证不是“修复整个原始执行”，而是：

- 接受已经发生的历史；
- 判断当前状态是否仍可进入合法恢复区域；
- 对未来 suffix 提供安全与成功保证；
- 对过去 effect 提供单独的补偿义务。

因此，应明确当前状态如果已经违反不可恢复 invariant，系统不能再声称 contract-preserving，只能报告 historical violation 并执行 best-effort remediation。若 contract 允许 recovery window，则要把它编码为契约本身，而不是事后解释。

### P1-7：repair primitive 的跨层统一可能隐藏语义不一致

`reassign`、`rewire`、`bind`、`patch`、`guard` 和 `compensate` 被放在同一集合优化中，但它们作用的层次和效果语义差异很大：

- graph edit 改变控制/数据依赖；
- version binding 改变 artifact identity；
- code patch 改变 transition relation；
- guard 缩小可执行行为；
- compensation 是对已经发生 effect 的新业务动作。

若仅用统一成本和 `do(R)` 表示，可能掩盖它们不同的合法性、可交换性和验证义务。建议为 primitive 建立 typed intervention semantics，并明确组合顺序。特别是 `guard` 很容易通过禁止困难输入获得表面安全，必须受到“不缩小原输入域/required behavior”的限制；`compensate` 也不应被当成和预防性 patch 同义的 repair。

### P1-8：公开证书与私有真实性之间存在信任根问题

“各组织只暴露边界证书，本地 monitor 保留私有状态”是合理架构，但证书只能把信任转移到本地 TCB/attestation，并不能自动消除私有信息导致的不确定性。下一版需要区分：

- certificate 证明局部契约满足；
- certificate 证明某干预实际被执行；
- certificate 证明 outcome 测量真实；
- certificate 是否足以支持跨组织因果识别。

前三项是系统可信执行问题，第四项还需要统计和设计假设。不要用“有证书”替代“可识别”。

## 6. 已有方向的替代攻击矩阵

下表不是要求当前阶段写完整 related work，而是用来检验创新是否具有不可替代性。

| 已有方向 | 它已经能解决什么 | 它不能自动解决什么 | CPI-Repair 必须证明的剩余价值 |
|---|---|---|---|
| 观察性 RCA / provenance debugging | 根据日志、谱系和异常定位可疑节点 | 无法从观察相关性保证 repair 的干预效果 | 输出的不是排名，而是有识别边界的可执行 repair set |
| Active causal diagnosis | 通过试验区分候选机制或估计 treatment effect | 通常不处理固定公共契约和跨层 patch 合法性 | 干预必须受 anti-evasion contract order 约束 |
| Workflow replanning / self-reflection | 重新规划、换 Agent、重试，提高经验成功率 | 可能改变任务、绕过验证、重复副作用 | 成功提升不能靠降低承诺或扩大未授权行为 |
| Program repair / APR | 搜索使测试或规范通过的代码 patch | 通常聚焦程序内部，不含 route/version/owner 等跨层动作 | 一个统一但类型安全的跨层 repair semantics |
| CEGIS / MaxSMT contract repair | 在逻辑规范下合成满足约束的 patch | 规范常被视为已知，不处理随机成功和干预覆盖 | 在固定规范下加入条件干预充分性与 UNKNOWN |
| Safe planning / constrained MDP | 在安全约束下优化成功/回报 | 一般输出 policy，不一定解释当前 failure 或给最小 repair set | 修复集合的最小性、当前上下文条件性和固定契约 |
| Robust planning | 对模型不确定性寻找 worst-case policy | 不必区分观察数据与可执行干预的识别边界 | consistent-world repair 与 support-aware abstention 的连接 |
| Hitting set / diagnosis | 找最小解释、最小冲突集或修复集合 | 集合覆盖不等于真实干预后成功 | sufficient set 的成员关系由干预效果而非静态冲突决定 |
| Submodular cover | 在单调次模收益下做成本覆盖 | 强协同 repair 常不满足次模性 | 明确何时结构成立，不能把它当一般 CMRS 解法 |
| Saga / compensation | 管理跨服务长事务和业务补偿 | 不能恢复已经被违反的历史 invariant | 区分 prevention、compensation 与 eventual restoration |
| Transactional gateway / idempotency | 防重复写、版本栅栏、记录线性化点 | 不决定 repair 是否因果充分或契约不弱化 | gateway 只是可信执行层，不应取代核心创新 |
| Proof-carrying code / certificates | 携带可验证的局部安全证明 | 不自动给出统计成功效果和选择校正 | 明确逻辑证书与统计证书如何组合及其信任边界 |

通过该矩阵后，最强的创新陈述不应是“我们首次组合这些方向”，而应是：

> 现有方法分别能找相关根因、合成规范内 patch、执行安全事务或优化修复成本，但没有定义并求解这样一个返回对象：对指定失败上下文具有可识别充分性、跨层可执行、且在不可修改公共承诺下最小的 repair set；当任何一项无法证明时返回 UNKNOWN。

这句话只有在“指定失败上下文”“不可修改公共承诺”和“集合级充分性”被严格定义后才站得住。

## 7. 对三项贡献的逐项判断

### 7.1 贡献一：从观察性 RCA 到可执行干预诊断

**判断：应保留，但需要改名和收边界。**

优点：从排名到干预效果是实质升级；paired replay、随机 fork 和 coverageUnknown 使结论更可信；明确不把 ATE 当成单 episode root cause 是正确的。

风险：active causal diagnosis 本身不是新方向。如果最终输出仍是 population efficacy，那么“诊断当前失败”的措辞过强。如果输出面向当前实例，则必须增加条件充分性或一致世界鲁棒性。

建议把贡献重点写成：

> support-aware interventional repair evaluation under partial observability

而不是泛称“因果 RCA”。论文价值在 repair decision，不在宣布找到了真实根因。

### 7.2 贡献二：最小成本充分修复与复杂度边界

**判断：可能成为主要算法贡献，但目前范围过宽。**

优点：把输出从单故障定位提升为集合级 repair，能够表达协同和跨层组合；最小成本使结果具有明确决策意义。

风险：如果 repair effect 由黑盒 oracle 给出，外层很容易退化为已知 set cover/knapsack/cover optimization；如果 effect estimation 与搜索紧密耦合，则真正新问题可能是 adaptive combinatorial identification，而不只是优化。需要明确新难点究竟在哪里。

建议只选一个技术中心：

- support-aware adaptive search；或
- 有界交互图上的精确/FPT repair；或
- robust minimum repair over observationally equivalent worlds。

不要同时把所有复杂度和 solver 都列为同等贡献。

### 7.3 贡献三：独立 verifier 与跨域 Action Gateway

**判断：作为系统可信闭环很重要，但默认应降为支撑贡献。**

优点：独立 verifier 可以防止 repair 过程篡改 evaluator；gateway 能提供版本栅栏、幂等和真实 effect 记录；对不可逆动作的表述谨慎。

风险：transactional gateway、owner authorization、prepare/commit、compensation 等单独看都高度接近成熟分布式系统模式。若没有新的跨组织可组合证书或新的安全语义，它们不足以独立支撑一项顶会主创新。

建议将其定位为：为了让 interventional repair 的“do”在真实跨域系统中具有可信语义所需的执行基座。只有当你们能提出新的 certificate composition 或 authorization-aware identification 结果时，再提升为主要贡献。

## 8. 对 T1–T6 的创新层面审查

本节不要求现在证明定理，只审查这些定理是否共同支撑一个清晰创新，而不是形成“定理大礼包”。

### T1：Bounded Contract Soundness

应保留，但必须移除“所有轨迹满足随机软效用 `𝒢`”的表述，只证明 hard contract/safety。若含 bounded liveness，需单独定义 assumption 和期限。T1 最有价值的部分不是有限状态本身，而是跨层 repair 后局部 refinement 如何组合成端到端公共承诺。

### T2：Verifier Soundness / Relative Completeness

可作为系统/PL 支撑定理。Relative completeness 的条件已经较克制，但若 T2 需要大量篇幅，可能稀释主线。建议只在 verifier abstraction 本身有新意时作为主定理，否则作为 artifact soundness。

### T3：Interventional Identification

是核心候选定理，但必须先解决 population 与 current-instance 的选择。若只是标准 extended g-formula 在常见条件下识别，原创性有限；真正需要强调的是 partial observation、owner authorization、paired replay 或 consistent-world uncertainty 给识别带来的新结构。

### T4：Finite-Sample Sufficiency

有必要，但“有限候选族 + simultaneous lower bound”本身可能较标准。创新应来自候选是自适应生成/筛选、组合 repair support 稀疏，或返回规则与优化器耦合。否则作为严谨性保证即可，不宜单列主要理论贡献。

### T5：Hardness / Approximation / FPT

应收缩为一个 hardness 与一个自然结构正结果。不要为了显得全面同时承诺多类近似、#P-hard 和 solver。审稿人更关心 tractable subclass 是否对应真实 workflow，而不是复杂度结论数量。

### T6：End-to-End Certificate

作为最终合成定理有吸引力，但必须参数化不同 solver/识别/verifier 模式，并明确联合置信预算。建议它是 corollary 或 theorem schema，而不是在各种互斥前提下声称一个统一 `α,δ` 保证。

### 总体建议

更紧凑的最小定理骨架可能是：

1. 固定公共契约下，typed repair composition 的 bounded soundness；
2. 指定目标（分布级或实例条件级）下，repair sufficiency 的识别/拒答定理；
3. CMRS 的一般 hardness 与一个 workflow-natural tractable subclass；
4. 上述条件满足时的组合证书推论。

这比 T1–T6 全部并列更像围绕一个新研究对象展开。

## 9. 应保留、降级、谨慎处理和暂缓的内容

### 9.1 强烈建议保留

- 从观察性 RCA 转向真实可执行 intervention；
- 固定、独立、不可由 repair 弱化的公共契约/evaluator；
- repair 输出是集合级 sufficient repair，而不是 root-cause 排名；
- 无 support 或一致候选世界结论冲突时返回 UNKNOWN/abstain；
- 明确区分软成功概率与硬安全；
- 不把不可逆动作称为反事实 rollback；
- 有限 repair template、有限时域和明确 TCB 作为诚实边界；
- P/E DAG 与 lineage 用于观察、切片、replay 和证据索引，而非直接冒充因果创新。

### 9.2 建议降为支撑机制

- 规划 DAG / 执行 DAG 双图；
- provenance / lineage；
- backward slice；
- 独立 bounded verifier 的常规实现部分；
- Action Gateway 的常规事务、幂等和 fencing 机制；
- solver portfolio；
- compensation protocol。

这些内容对完整系统可能必不可少，但它们不都需要承担主要 novelty。

### 9.3 需要谨慎声称

- “当前失败的充分修复”：除非采用条件或 robust instance-level 定义；
- “识别真正根因”：repair efficacy 不等于唯一根因；
- “cross-organization”：除非核心定义确实依赖组织私有性和授权机制；
- “contract preserving”：除非 anti-evasion order 封闭；
- “所有轨迹安全”：若存在可补偿的中间违例，则不能如此声称；
- “最小”：需区分 inclusion-minimal、global minimum-cost 与近似解；
- “联合证书”：需明确各结论的不同前提和失败概率。

### 9.4 建议暂缓或删除出核心叙事

- 同时宣称 NP-hard、#P-hard、对数不可近似、次模近似、FPT 和 MILP 全套结果；
- 把 T1–T6 都写成 Strong Accept 的必要大礼包；
- 把每一种 repair primitive 都视为同质动作；
- 将 verifier、gateway 和跨域协议都列为与核心因果修复并列的独立创新；
- 在未解决目标对象前继续增加更多实验层或应用场景。

## 10. 三个推荐的创新主线收缩方案

以下是三个互斥程度较高的方向。建议选择一个作为主线，另外两个只作为边界或未来扩展。不要把三者全部并列承诺。

### 方案 A：当前失败的鲁棒充分修复

**核心问题**

> 给定当前公开历史和固定公共契约，在所有与公开历史一致且具有干预支持的私有候选世界中，寻找最小成本 repair，使成功条件成立；若候选世界对结论不一致则 UNKNOWN。

**最强之处**

- 最贴近“修这个失败实例”的用户价值；
- 部分可观测性直接进入定义，而不只是背景；
- UNKNOWN 具有清楚的逻辑含义；
- 与一般 population treatment effect 明显区分。

**代价**

- worst-case 可能保守，拒答率高；
- 需要定义候选世界集合、支持和模型不确定性；
- 搜索可能更难。

**最可能的独特贡献**

robust contract-preserving sufficient repair over observationally equivalent worlds。

### 方案 B：分布级的安全 repair policy 学习

**核心问题**

> 对指定任务分布，学习一个只能选择 contract-preserving action 的 repair policy，使总体成功率超过阈值且期望成本最小，无支持时拒答。

**最强之处**

- 与随机 fork、sequential DR/TMLE、confidence sequence 最自然兼容；
- 统计目标清楚；
- 比较容易形成可重复 benchmark。

**代价**

- 不能声称找到当前失败的充分 repair 或个体根因；
- 与 safe/constrained policy learning 更接近，必须突出 fixed-contract anti-evasion 和跨层 repair action space。

**最可能的独特贡献**

contract-constrained interventional repair policy learning with support-aware abstention。

### 方案 C：固定契约下的跨层最小 repair 合成

**核心问题**

> 在效果模型或 effect oracle 已知/可查询的前提下，对 graph、version 和 code 的 typed repair space，合成最小成本且不弱化端到端公共契约的 sufficient repair。

**最强之处**

- 技术中心最清楚，适合 PL/SE/系统方向；
- 可重点研究 typed composition、anti-evasion refinement 和自然 FPT 结构；
- 避免承担一般因果识别的全部难题。

**代价**

- 因果贡献会弱化为 oracle/数据接口；
- 需要证明跨层合成不是普通 MaxSMT/CEGIS 的直接应用。

**最可能的独特贡献**

anti-evasion contract refinement and typed cross-layer minimum repair synthesis。

### 本评审的优先推荐

若项目的核心叙事始终是“修复正在失败的跨组织 Agent workflow”，优先推荐方案 A。若团队优势主要在实验因果推断和 Agent benchmark，推荐方案 B。若团队优势在形式化、验证器和程序修复，推荐方案 C。

无论选择哪一个，另外两个都可以保留为系统接口，但不应继续共享同等创新权重。

## 11. 下一版应回答的关键问题

下一版不需要立刻补实验；只要能清楚、无歧义地回答以下问题，创新成熟度就会显著提高。

### 11.1 研究对象

- [ ] 返回的是当前失败实例的 repair，还是任务分布上的 repair policy？
- [ ] “充分”相对于什么成立：所有一致私有世界、条件后验分布，还是总体任务分布？
- [ ] 输出对象是 repair set、repair policy，还是带条件分支的 contingent plan？
- [ ] 你们是否还声称 root cause，还是只声称 repair efficacy？

### 11.2 契约语义

- [ ] reference evaluator 是否完全固定，谁有权修改？
- [ ] precondition、输入域、scope 和 assumption 是否禁止强化/缩小？
- [ ] exception、manual fallback 和 abstain 如何与 required outcome 区分？
- [ ] safety、bounded response、soft success 是否分别定义？
- [ ] contract refinement 是否端到端可组合，而不是只做局部节点检查？

### 11.3 因果与支持

- [ ] treatment 是 proposal、authorized action 还是实际执行 action？
- [ ] owner refusal 是否产生选择偏差，如何进入目标量？
- [ ] support 的单位是 primitive 还是完整 repair set？
- [ ] 从局部干预泛化到组合效果依赖什么结构假设？
- [ ] 对当前上下文 OOD 或隐藏 effect modifier 不可判定时是否 abstain？
- [ ] 预期拒答率是否可能高到使方法失去实用性？

### 11.4 最小修复与算法

- [ ] 主目标是 minimum-cost 还是 inclusion-minimal？
- [ ] 成本是否严格为正、可加、与风险/授权次数如何关系？
- [ ] effect estimation 是先验 oracle，还是与组合搜索联合进行？
- [ ] 唯一主复杂度正结果是什么，为什么对应真实 workflow 结构？
- [ ] heuristic 模式是否诚实地不提供 approximation ratio？

### 11.5 不可逆 effect

- [ ] 哪些属性必须始终保持 invariant？
- [ ] 哪些只要求 eventual restoration？
- [ ] compensation 是否只是新动作，而非抹除历史违例？
- [ ] 已发生不可恢复安全违例时，输出是否改为 remediation 而非 contract-preserving repair？
- [ ] 每类 primitive 是否具有明确 effect class 和 commit 规则？

### 11.6 创新不可替代性

- [ ] 是否能用一句话说出已有 active diagnosis + verified repair 顺序组合仍然缺少什么？
- [ ] 是否有至少一个定义、算法或保证必须由 intervention、fixed contract 和 set repair 三者共同产生？
- [ ] 去掉“跨组织”后核心问题是否改变？若不改变，是否愿意将其定位为应用场景？
- [ ] gateway/verifier 是核心新方法还是可信执行支撑？
- [ ] 是否能把主要贡献压缩到最多两项，而不损伤论文身份？

## 12. 未来需要什么证据，但不作为当前阶段缺陷

以下不是对当前稿件的拒稿理由，而是当创新定义稳定后，完整论文需要用来兑现主张的证据。此处列出它们，是为了帮助你们选择一个未来可验证、可证伪的创新方向。

### 如果选择实例级/鲁棒修复

- 构造公开观察相同、私有机制不同、最优 repair 不同的成对世界；
- 证明方法在无法区分时正确 UNKNOWN，在可通过干预区分时返回正确 repair；
- 报告 robust repair 的成本和 abstention rate；
- 与 population-optimal repair 比较，展示个体条件化的必要性。

### 如果选择分布级 repair policy

- 明确训练/部署任务分布和 transport 条件；
- 校准 success LCB 与真实 coverage；
- 报告 owner refusal、低 propensity 和 adaptive search 下的置信有效性；
- 与 safe planning、active causal diagnosis 和 replanning 比较。

### 如果选择跨层合成

- 给出不能被 code-only、workflow-only 或 version-only repair 解决的最小反例；
- 证明 anti-evasion refinement 阻止 evaluator/guard/precondition laundering；
- 证明 typed repair composition 的 soundness；
- 证明所选 FPT/tractable 结构在真实 workflow 中确实常见。

### 所有路线共同需要

- 展示至少一个“成功率更高但因弱化契约而必须拒绝”的 repair；
- 展示至少一个必须组合多个 primitive 才有效的非平凡例子；
- 展示 coverageUnknown 不是装饰性返回值，而是在真实不确定性下被正确触发；
- 区分预防性安全、补偿性恢复和不可恢复历史违例；
- 用独立 evaluator/verifier 防止 repair 通过改规则获胜。

## 13. 建议重写后的最小问题定义模板

下面给出一个偏实例级的模板，仅用于展示所需边界，不是要求逐字采用：

> 给定有限时域跨组织 workflow、当前公开历史 `h_pub`、不可修改的公共契约 `C_pub`、经 owner 预授权的有限 typed repair 集合 `A_R`，以及与 `h_pub` 一致且具有干预支持的候选机制集合 `M(h_pub)`，CPI-Repair 寻找成本最小的 repair set `R`，使得：
>
> 1. `R` 在类型、owner、权限、版本和 effect class 上可执行；
> 2. 对所有允许的未来轨迹，硬安全契约始终保持；
> 3. 修复后的公开承诺在 anti-evasion refinement order 下不弱于 `C_pub`；
> 4. 对目标候选机制集合，条件成功下界达到阈值 `η`；
> 5. 若第 4 项因支持不足或一致世界结论冲突而不可判定，则返回 `coverageUnknown`。

该模板的价值在于，它把五件容易混淆的事情分开：可执行性、硬安全、契约不弱化、软成功充分性、不可识别时拒答。

如果选择分布级路线，只需把第 4 项替换为目标任务分布上的 policy efficacy，并删除“当前失败充分修复”的语言。

## 14. 最终评审意见

### 值得肯定的核心

这份稿件已经摆脱了早期常见的“多放几个 DAG、加 provenance、再让 LLM 做 RCA”式创新。它认识到：观察性解释不等于可执行修复，成功率不等于合法性，repair search 不能忽略 support，外部副作用也不能被虚构成可回滚。这些判断是成熟的，也是 CPI-Repair 最值得继续推进的基础。

尤其值得保留的研究态度包括：

- 无覆盖就拒答，而不是外推；
- 不把 ATE 直接解释为单次失败根因；
- 注意自适应候选选择会破坏普通置信区间；
- 正确区分次模特殊类与强协同一般类；
- 不通过弱化 evaluator/contract 获得“成功”；
- 不把补偿称为反事实回滚。

### 当前最关键的否定意见

目前还不能把该创新设计称为 Strong-Accept-ready，主要不是因为缺少实验和证明，而是因为以下问题尚未关闭：

1. `V_h(R)` 是总体成功概率，但叙事目标是修复当前失败，两者尚未统一；
2. soft success、hard safety、recoverable effect 和 invariant 被部分混用；
3. contract refinement 尚不能阻止输入域、前置条件、观察投影和 exception 等逃逸；
4. 核心贡献仍可能被解释为 active diagnosis、verified repair、组合优化和事务 gateway 的顺序拼装；
5. 贡献和定理范围过宽，削弱了唯一创新核的辨识度。

### 最优先修改顺序

建议下一版只按以下顺序处理，不要先继续扩展模块：

1. 决定 population repair policy 与 current-instance repair 二选一；
2. 分开 hard safety、soft success、compensation 和 eventual restoration；
3. 给出 anti-evasion contract refinement order；
4. 用一句不可替代性陈述固定 novelty kernel；
5. 将三项贡献和 T1–T6 收缩为围绕该 kernel 的最小支撑集合；
6. 最后再决定跨组织协议、复杂度结果和实验体系各自承担多大权重。

完成前四步后，这个方向会从“有价值的多模块研究蓝图”提升为“有清晰身份、可以被严格验证的新问题”。在当前创新挖掘阶段，这比增加更多定理名、实验层或系统组件更重要。

## 15. 供下一轮复审使用的简短判定表

下一版提交后，可以用以下五项快速判断创新是否真正收紧：

| 问题 | 通过标准 |
|---|---|
| 研究对象是否唯一？ | 能明确说是实例 repair 或分布 policy，全文没有混用。 |
| 契约是否真的固定？ | 无法通过 precondition、scope、projection、exception 或 evaluator 修改逃逸。 |
| 充分性是否语义清楚？ | 明确相对于条件上下文、候选世界或任务分布中的哪一个成立。 |
| 创新是否不可拆解？ | 能指出已有诊断、修复、优化串联仍无法提供的单一性质。 |
| 贡献是否聚焦？ | 最多一项核心问题贡献和一项主要方法贡献，其余均为支撑。 |

若五项全部满足，我会把创新成熟度上调到明确的 Weak Accept，并开始评估它是否具有 Strong Accept 的理论或系统上限；若前两项仍未满足，即使增加更多实验或定理，核心创新评价也不会显著提高。
