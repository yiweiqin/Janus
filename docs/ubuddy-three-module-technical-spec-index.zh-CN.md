# uBuddy 三大技术模块文档索引

> **研究主张已切换（2026-09-10）。** 当前规范入口是 [V4 主张冻结](ubuddy-pain-points-innovations-v4-claim-freeze.zh-CN.md) 与 [V4 自进化收束稿](ubuddy-pain-points-innovations-v4-self-evolution.zh-CN.md)。本索引对应 V3 三模块（TDB + 最小披露 + 反事实联合进化），仅供追溯，不再作为当前主线。

这组文档按照当时确认的三模块技术路径组织，并将依赖集束作为贯穿全链路的核心关系状态层。

## 文档结构

1. [模块一：部分可观测协作世界建模](ubuddy-module1-partial-observable-world-model.zh-CN.md)
2. [核心技术：依赖集束引擎](ubuddy-dependency-bundle-engine.zh-CN.md)
3. [模块二：决策充分的条件化公共语义投影](ubuddy-module2-decision-sufficient-semantic-projection.zh-CN.md)
4. [模块三：依赖集束驱动的反事实组织—Agent 联合进化](ubuddy-module3-dependency-grounded-joint-evolution.zh-CN.md)

## 总体公式

\[
HDBP
\rightarrow
W_0
\rightarrow
TDB^{plan}
\rightarrow
TDB^{active}(t)
\rightarrow
PublicProjection
\rightarrow
TDB^{exec}
\rightarrow
CounterfactualEvolution
\rightarrow
TDB\text{-}Trace
\rightarrow
HDBP
\]

## 三模块分工

### 模块一：关系是什么？

构造当前任务的节点、关系、私人状态、规划图、Owner、义务和初始 `TDB-plan`。

### 模块二：现在应该公开多少？

根据当前任务 `TDB`、接收者和下游决策，选择最小但决策充分的公共语义投影。

### 模块三：哪里出了问题、下一步改哪里？

比较 `TDB-plan / TDB-active / TDB-exec`，进行依赖向量归因、反事实干预、进化优先级实验和跨任务验证。

## 依赖集束三层命名

```text
TDB       当前任务某条关系边的实时依赖集束
TDB-Trace 当前任务从计划到执行结束的依赖集束完整轨迹
HDBP      从多个任务轨迹聚合出的历史依赖集束先验
```

## 总体边界

- 依赖集束绑定关系边，不绑定 Agent 本体；
- 历史先验用于初始化，不直接替代当前任务事实；
- 公共语义投影不等于公开完整依赖集束；
- 机器学习负责估计和策略选择，硬约束由显式规则保持；
- 进化必须经过未见任务验证，否则回滚、降权或拒绝；
- 研究设计中的公式、算法和图不代表当前系统已经全部落地。

