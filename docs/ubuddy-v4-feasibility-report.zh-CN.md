# V4 自进化可行性验证

> 运行时间：2026-09-10T15:51:08.102Z  
> 总判定：**通过**  
> 本报告验证的是方案可执行、可打标、可用非训练基线分离，不是真实任务上的自进化已成立。

## 结论

三层公共 memory、反向侦探合成监督、能力画像两个分数，在当前契约和合成器上都能跑通，并且侦探基线明显优于末端归责。可以进入阶段 3/4 的数据规模化，不必先回到最小披露。

## 1. 任务公共 memory

| 闸门 | 结果 |
|---|---|
| inspect_drops_secrets | PASS |
| participant_hides_raw | PASS |
| stranger_sees_nothing | PASS |
| wide_request_rejected_before_owner | PASS |
| approved_excerpt_only | PASS |

## 2. 反向侦探（240 条单注入）

| 指标 | 数值 |
|---|---:|
| 侦探 Top-1 | 100.0% |
| 漂移类型准确率 | 100.0% |
| 末端归责 Top-1 | 40.0% |
| 字典序第一差异 Top-1 | 40.0% |
| 平均涉入节点数 | 4.3333 |
| 侦探平均证据节点数 | 1 |
| 无漂移识别率 | 100.0% |
| 双注入 UNKNOWN | 100.0% |

| 闸门 | 结果 |
|---|---|
| detective_hit_ge_0_80 | PASS |
| detective_beats_terminal_by_0_20 | PASS |
| no_drift_ge_0_95 | PASS |
| multi_unknown_ge_0_50 | PASS |
| evidence_lt_involved | PASS |

分类型命中：missing_dependency 100.0% (n=48)；wrong_agent 100.0% (n=48)；wrong_version 100.0% (n=48)；wrong_acceptance 100.0% (n=48)；local_replan 100.0% (n=48)。

## 3. 能力画像依赖集束

规划选人：A（依赖分）。失败替换：B（相似度）。二者 argmax 不同。

| 闸门 | 结果 |
|---|---|
| planning_picks_A_for_writer | PASS |
| replacement_picks_B_not_writer | PASS |
| dep_not_equal_sim_argmax | PASS |
| similar_swap_isolates_source_verify | PASS |
| failed_swap_hands_back | PASS |
| decay_is_monotonic | PASS |

## 4. 闭环路由

| 闸门 | 结果 |
|---|---|
| agent_goes_to_swap | PASS |
| structure_goes_to_plan_edit | PASS |
| unknown_does_not_update | PASS |

## 边界

- 侦探基线是“变化子图的唯一源点”，证明标答可学，不是已训练模型。
- 画像分数来自标签角色表，不是人工标注模型。
- 未接 PostgreSQL / 真实 Work Memory；未改 TDB 投影训练。
