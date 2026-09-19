# uBuddy 技术模块三：依赖集束驱动的反事实组织—Agent 联合进化

> 研究设计稿。本文定义如何使用任务依赖集束轨迹和规划—执行差异，区分节点问题、关系问题和组织问题，并生成可跨任务验证的最小进化策略。

## 1. 模块目标

模块三回答：

> 计划和现实哪里发生了偏差？偏差来自哪个节点、哪条依赖边、哪次交接、哪个版本或组织分工？下一轮应优先改哪里，如何证明不是单任务过拟合？

## 2. 输入对象

模块三使用：

\[
I_3=(G^{plan},G^{exec},Trace,O_2,HDBP,\mathcal D_{eval})
\]

其中：

- `Trace`：TDB-plan → TDB-active(t) → TDB-exec；
- \(O_2\)：模块二生成的公共语义和证据；
- \(HDBP\)：历史依赖集束先验；
- \(\mathcal D_{eval}\)：跨任务验证集合。

## 3. 计划—执行依赖差异

对每条关系边：

\[
\Delta_e=TDB^{exec}_e-TDB^{plan}_e
\]

完整轨迹：

\[
\mathcal T_e=\{TDB^{plan}_e,TDB^{active}_e(1),\dots,TDB^{exec}_e\}
\]

首次有效偏差时间：

\[
t_e^*=\min\{t:\|\Delta_e(t)\|>\delta_e\land Impact_e(t)>0\}
\]

该定义比“最早异常时间”更严格，因为一个异常只有在解释下游影响时才进入归因候选。

## 4. 候选原因空间

\[
\mathcal C=\{
C_{node},C_{edge},C_{handoff},C_{version},
C_{resource},C_{disclosure},C_{organization}
\}
\]

候选含义：

- \(C_{node}\)：某个 Agent 或节点能力不足；
- \(C_{edge}\)：依赖边逻辑、数据或时效状态断裂；
- \(C_{handoff}\)：交接过程中约束或版本丢失；
- \(C_{version}\)：结果、API 或 Memory 版本过期；
- \(C_{resource}\)：队列、工具、预算或负载问题；
- \(C_{disclosure}\)：公共投影不足或披露不匹配；
- \(C_{organization}\)：拆分、分工、Owner 或协作结构不合理。

## 5. 依赖向量归因

定义：

\[
P(c\mid e)=P(c\mid\Delta_e,\Gamma_e,HDBP)
\]

一个可解释的打分形式：

\[
Score(c,e)=\alpha_c^\top\Delta x_e+\beta_c^\top\Gamma_e+\gamma_c^\top HDBP_e
\]

归因分布：

\[
P(c\mid e)=softmax_c(Score(c,e))
\]

只有当：

\[
P(c^*\mid e)-P(c^{(2)}\mid e)\geq\delta_c
\]

才可以把 \(c^*\) 作为优先干预对象；否则保留多原因候选或请求 Probe。

## 6. 反事实干预

动作集合：

\[
\mathcal A_e=\{
replaceAgent,changeEdge,addEvidence,refreshVersion,
changeOrder,addReview,changeOrganization
\}
\]

单个动作的因果效应：

\[
CE(e,a)=E[U(\tau)\mid do(a_e=a)]-E[U(\tau)\mid do(a_e=noop)]
\]

依赖状态效应：

\[
CE_x(e,a)=E[x_e^{after}\mid do(a)]-E[x_e^{before}\mid do(a)]
\]

跨任务效应：

\[
CE_{gen}(a)=E_{\tau'\sim\mathcal D_{unseen}}[U(\tau';do(a))-U(\tau';noop)]
\]

## 7. 进化优先级

你提出的优先级定义为：

\[
EvolutionPriority(e)=Impact(e)\times Uncertainty(e)\times Risk(e)\times Coupling(e)\times Repairability(e)
\]

加入成本后：

\[
Priority'(e)=\frac{EvolutionPriority(e)}{Cost(e)+\epsilon}
\]

其中：

- `Impact`：影响的下游范围；
- `Uncertainty`：当前归因的不确定性；
- `Risk`：继续执行的潜在损害；
- `Coupling`：与其他节点或边的耦合程度；
- `Repairability`：可通过有限干预修复的概率。

## 8. 高依赖优先 vs 低依赖优先

定义两种实验策略：

\[
\pi_H=SelectTopK(Priority')
\]

\[
\pi_L=SelectBottomK(Priority')
\]

在固定任务集、固定预算和固定干预次数下比较：

\[
Metrics=\{T,N_{intervention},Comm,PrivacyLeak,Misattr,TransferGain,NegativeTransfer,Rollback\}
\]

收敛差异：

\[
\Delta Convergence=T(\pi_L)-T(\pi_H)
\]

这里的研究问题不是预设高依赖一定更好，而是实证检验：

> 先修复高影响、高不确定和高耦合关系，是否比先修复低依赖关系更快达到跨任务稳定？

## 9. 最小充分进化合成

设联合进化方案为：

\[
\Delta=(\Delta_{org},\Delta_{agent},\Delta_{edge},\Delta_{projection})
\]

目标：

\[
\Delta^*=\arg\min_\Delta Cost(\Delta)
\]

约束：

\[
E[U(\tau;do(\Delta))]\geq\eta
\]

\[
Safety(\tau;do(\Delta))=1
\]

\[
Contract(\tau;do(\Delta))\succeq Contract(\tau)
\]

\[
GeneralizationGap(\Delta)\leq\epsilon_g
\]

## 10. 双层联合优化

外层组织策略：

\[
\phi^*=\arg\max_\phi J_{org}(\phi;\mathcal D)
\]

内层 Agent 能力策略：

\[
\theta^*=\arg\max_\theta J_{agent}(\theta;\mathcal D,\phi^*)
\]

联合目标：

\[
J(\phi,\theta)=J_{task}-\lambda_1Cost-\lambda_2PrivacyLeak-\lambda_3NegativeTransfer
\]

外层不能通过修改契约或降低验收阈值制造表面收益。

## 11. 抗过拟合与跨任务验证

任务划分：

\[
\mathcal D=\mathcal D_{train}\cup\mathcal D_{val}\cup\mathcal D_{unseen}
\]

保留条件：

\[
Gain(\Delta,\mathcal D_{unseen})\geq\gamma
\]

\[
NegativeTransfer(\Delta)\leq\beta
\]

如果更新只改善训练任务，则：

```text
回滚、降权或标记为任务特定策略
```

## 12. 联合进化算法

### Algorithm 1：Dependency-Grounded-Counterfactual-Evolution

```text
Input: G_plan, G_exec, TDB-Trace, HDBP, task set D
1. Align planning nodes, execution nodes and result versions.
2. Compute ΔTDB for every relation edge.
3. Detect first effective deviation and downstream propagation.
4. Produce a posterior over node/edge/handoff/version/resource/disclosure causes.
5. Rank candidate edges with EvolutionPriority.
6. Run controlled local probes or counterfactual interventions.
7. Synthesize the minimum-cost organization–Agent update.
8. Evaluate on validation and unseen tasks.
9. Keep only updates satisfying utility, contract and transfer constraints.
10. Update HDBP, TDB estimators and projection policy; otherwise rollback.
```

## 13. 任务结束后的归档和先验更新

归档：

\[
Trace_\tau\rightarrow Archive(Trace_\tau,Attribution,Interventions,Outcomes)
\]

聚合：

\[
HDBP^{new}_g=Aggregate(HDBP^{old}_g,Trace_{\tau,g})
\]

新任务初始化：

\[
B^{new}_0=InitializeBelief(CurrentEvidence,HDBP^{new})
\]

旧任务的 TDB-exec 不得直接复制为新任务实时状态。

## 14. 技术链路图

```mermaid
flowchart TB
  P[TDB-plan] --> A[TDB-active(t)] --> E[TDB-exec]
  P --> D[计算 ΔTDB]
  E --> D
  D --> C[候选原因后验]
  C --> I[Probe 与反事实干预]
  I --> R[EvolutionPriority]
  R --> X[高依赖优先 vs 低依赖优先]
  X --> S[最小充分联合进化合成]
  S --> V[未见任务验证]
  V -->|稳定迁移| U[保留 Δ*]
  V -->|过拟合/负迁移| B[回滚或降权]
  U --> H[更新 TDB 估计、投影策略和 HDBP]
```
