# uBuddy 核心技术：依赖集束引擎

> 研究设计稿。依赖集束是贯穿三个技术模块的关系状态层，不是 Agent 本体属性，也不是两个 Agent 之间的长期关系标签。

## 1. 核心定义

依赖集束绑定在“某个任务中的某条关系边”上：

\[
TDB(\tau,e,t)=Bundle(\tau,e,u,v,a_u,a_v,r,version,stateVector_t)
\]

其中：

- \(\tau\)：任务 ID；
- \(e\)：关系边 ID；
- \(u,v\)：源节点和目标节点；
- \(a_u,a_v\)：源 Agent 和目标 Agent；
- \(r\)：关系类型；
- `version`：关系或结果版本；
- `stateVector`：依赖状态向量。

如果两端分别由两个 Agent 执行，依赖集束表现为 Agent–Agent 关系，但它仍然属于具体任务和具体关系边。

## 2. 三层对象

### 2.1 TDB：任务依赖集束

\[
TDB^{task}_{\tau,e}(t)
\]

表示当前任务某条边在某一时刻的实时状态。

### 2.2 TDB-Trace：任务依赖集束轨迹

\[
Trace_{\tau,e}=\{TDB^{plan},TDB^{active}(1),\ldots,TDB^{exec}\}
\]

表示一个任务从计划到执行结束的完整变化过程。

### 2.3 HDBP：历史依赖集束先验

\[
HDBP_g=Aggregate(Trace_{\tau_1},\ldots,Trace_{\tau_n})
\]

其中 \(g\) 可以按 Agent 对、角色对、组织对、任务类型或关系类型分组。HDBP 只作为新任务初始化先验，不直接替代当前任务 TDB。

## 3. 状态向量

定义：

\[
x_e(t)=[d,l,q,f,r,c,s,k,i,u]
\]

| 符号 | 维度 | 含义 |
|---|---|---|
| \(d\) | data | 数据可用性、完整性和版本可消费性 |
| \(l\) | logic | 输入输出逻辑约束满足度 |
| \(q\) | quality | 结果质量和来源可信度 |
| \(f\) | freshness | 结果、版本或证据的新鲜度 |
| \(r\) | review | 审核、复核和验证状态 |
| \(c\) | capability | 目标 Agent 对该结果的能力匹配度 |
| \(s\) | resource | 队列、负载、工具和资源状态 |
| \(k\) | risk | 继续沿该关系执行的风险 |
| \(i\) | downstreamImpact | 对下游节点的影响范围 |
| \(u\) | uncertainty | 当前状态估计的不确定性 |

完整记录还应包含：

```text
owner, version, relationType,
evidenceRefs, updatedAt, sourceRevision,
privacyClass, confidence
```

## 4. TDB 状态生命周期

\[
TDB^{plan}\rightarrow TDB^{active}(t)\rightarrow TDB^{exec}
\]

计划—执行差异：

\[
\Delta TDB_e(t)=x^{active}_e(t)-x^{plan}_e
\]

任务结束后不删除实时数据，而是形成轨迹归档：

\[
Trace_{\tau,e}=\{x^{plan}_e,x^{active}_e(1),\ldots,x^{exec}_e\}
\]

## 5. 事件驱动更新

事件集合：

\[
\mathcal E=\{publish,consume,review,timeout,retry,handoff,versionChange,resourceChange,failure\}
\]

事件到依赖维度的映射：

\[
event_t\mapsto \Delta x_e(t)
\]

一般更新器：

\[
x_{e,k}(t+1)=\lambda_kx_{e,k}(t)+(1-\lambda_k)\hat x_{e,k}(event_t)
\]

其中 \(\lambda_k\) 是维度记忆系数。

新鲜度衰减：

\[
f_e(t)=\exp(-\rho_e\Delta t)
\]

若结果版本发生替换：

\[
f_e(t+1)=Freshness(version_{new},consumer_{current})
\]

## 6. 可信度与不确定性

依赖集束不应只存一个分数，还应存可信度：

\[
confidence_e=Calibrate(sourceQuality,review,recency,evidenceCompleteness)
\]

可定义不确定性：

\[
u_e=1-confidence_e
\]

对冲突证据：

\[
u_e\uparrow,\quad status_e=CONFLICT
\]

对证据缺失：

\[
status_e=UNKNOWN
\]

而不是把缺失证据当成低分或高分。

## 7. 依赖集束评分

可解释的维度评分示例：

\[
q_e=0.5Q_{data}+0.3Q_{source}+0.2Q_{review}
\]

\[
i_e=Importance(target)\times AffectedNodes(e)\times BlockageLevel(e)
\]

\[
k_e=Severity(e)\times Irreversibility(e)\times Exposure(e)
\]

不建议把所有维度压成一个固定总分。若必须排序，可使用上下文相关函数：

\[
Score(e\mid q)=w(q)^\top x_e
\]

其中权重 \(w(q)\) 由当前下游决策 \(q\) 决定。

## 8. 机器学习的合理位置

机器学习负责估计不可见状态和选择策略，硬约束仍由显式规则控制。

### 8.1 状态估计

\[
\hat x_{e,t}=F_\theta(x_{e,t-1},events_{1:t},results_{1:t})
\]

候选：Bayesian filter、HMM、时序 Transformer、校准分类器。

### 8.2 条件化披露

使用 constrained contextual bandit：

\[
a_t^{share}=\pi_\phi(context_t)
\]

约束：

\[
PrivacyLeak(a_t)\leq \epsilon_p
\]

### 8.3 进化优先级

使用因果 uplift 或 Bayesian optimization 估计干预价值：

\[
Uplift(e,a)=E[U\mid do(a_e=a)]-E[U\mid do(a_e=noop)]
\]

## 9. 六类作用

\[
TDB\rightarrow\{
关系建模,
公共语义投影,
计划—执行证据,
任务内归因,
进化优先级,
跨任务历史先验
\}
\]

## 10. 历史先验聚合

对同一关系群组 \(g\)：

\[
\mu_g=\frac{\sum_{\tau}w_\tau x_{\tau,g}}{\sum_{\tau}w_\tau}
\]

加入时间衰减：

\[
w_\tau=\exp(-\rho\Delta t_\tau)\times EvidenceQuality(\tau)
\]

形成：

\[
HDBP_g=(\mu_g,\Sigma_g,n_g,confidence_g,decay_g,cause_g)
\]

## 11. 事件更新算法

```text
Input: current TDB, event, result, review, time
1. Locate all edges affected by the event.
2. Map event fields to dependency dimensions.
3. Update observed dimensions using the dimension-specific updater.
4. Update hidden dimensions using belief/state estimator.
5. Recompute freshness, risk, impact and uncertainty.
6. Attach evidence references and source revision.
7. Emit TDB-active(t+1) and append it to TDB-Trace.
```

## 12. 关键边界

- TDB 属于关系边，不属于 Agent 本体；
- HDBP 是先验，不是新任务实时事实；
- 分数用于估计、排序和解释，不自动替代硬规则；
- 缺失证据应保留 UNKNOWN；
- 任务结束后保留 Trace，再聚合 HDBP；
- 新任务必须用当前事件重新生成 TDB。

## 13. 技术链路图

```mermaid
flowchart TB
  W[当前协作世界 W0] --> P[TDB-plan\n任务规划依赖集束]
  P --> A[TDB-active(t)\n执行中的实时状态]
  A --> E[TDB-exec\n任务结束状态]
  E --> T[TDB-Trace\n完整任务轨迹]
  T --> G[跨任务聚合、校准、时间衰减]
  G --> H[HDBP\n历史依赖集束先验]
  H -. 新任务初始化先验 .-> W
  A --> S[条件化公共语义投影]
  A --> C[任务内归因]
  T --> X[跨任务进化证据]
  H --> I[新任务 belief 初始化]

  classDef state fill:#245047,stroke:#52C49A,color:#fff,stroke-width:2px;
  classDef archive fill:#4C5B78,stroke:#90CDF4,color:#fff,stroke-width:2px;
  classDef prior fill:#694B1F,stroke:#F6AD55,color:#fff,stroke-width:3px;
  classDef output fill:#243B72,stroke:#7AA2F7,color:#fff,stroke-width:2px;

  class P,A,E state;
  class T,G archive;
  class H prior;
  class S,C,X,I output;
```
