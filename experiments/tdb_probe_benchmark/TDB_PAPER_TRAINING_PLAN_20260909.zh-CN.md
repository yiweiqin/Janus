# TDB 论文发表训练计划（2026-09-09）

## 目标

在 3 天内形成可投稿的最小可信证据包；最多延长到 7 天补充稳健性分析。当前证据边界保持 `SYNTHETIC_FINITE_WORLD_ONLY`。

## 机器分工

- `44930`（3×A800）：主线 QLoRA、多卡单机复现、checkpoint 汇总和最终评估。禁止跨机 NCCL。
- `11263`：若仍租用，执行独立 seed 或 1024-token 复核；否则只作为已归档结果来源。
- `10924`、`36302`：优先执行结构化 baseline、no-interaction ablation 或独立 seed；不得与 44930 做梯度同步。

## 0–72 小时交付

### 第 0–6 小时：启动门槛

检查数据/代码/模型 hash、GPU 显存、训练环境、磁盘和进程；生成唯一 run id。先在 44930 做单 batch 前向、QLoRA 梯度和 checkpoint 写入 smoke test。

### 第 6–30 小时：主线

在 44930 启动 3 个独立 seed 的四目标训练；若单机多卡吞吐或显存不稳定，立即回退为三张卡各跑一个独立单卡 seed。保留 `checkpoint-114`、训练 manifest、配置、日志和 SHA256。

### 第 30–48 小时：固定预算评估

对每个 seed 运行 512 与 1024 token development 评估，固定 scorer 生成 `target_metrics.json`，独立 checker 生成 projection 结果。不得读取 calibration 或 frozen test。

### 第 48–60 小时：对照与消融

并行执行结构化 baseline、`no_interaction`、均匀/历史启发式方向评分对照。比较单位为 task family，报告四目标、net-utility regret、decision agreement、sufficiency、UNKNOWN/CONFLICT、privacy 和 hard violations。

### 第 60–72 小时：论文包冻结

生成 aggregate、主结果表、消融表、失败样例、审计清单和复现实验命令。主结果至少两次独立运行方向一致且 hard violation 为 0，才冻结为论文主结论；否则只报告探索性结果并延长验证。

## 第 4–7 天（按需）

增加未见结构、关系类型、Agent-pair、时间外推和 OOD/校准数据。每项必须预先固定切分和指标；若没有独立 gold，只报告 UNKNOWN 和局限，不训练伪标签方向权重。

## 停止与回退条件

- 任何 OOM、NaN、数据泄漏、schema invalid、checkpoint 校验失败或硬约束违规：停止对应任务，保留日志，回退最近有效 checkpoint。
- 主线达到两次可复现且无硬违规后，停止扩大训练，优先整理论文证据。
- 3 天内未达到门槛时，不盲目增加 epoch；优先修复评估、审计和统计不确定性。

## 固定输出

每个 run 必须记录机器、seed、git/code/data/config hash、checkpoint、训练/评估耗时、完整日志、逐文件 SHA256、`metrics.json`、`target_metrics.json`、`projection_predictions.jsonl`、checker 结果和 `aggregate.json`。模型只能输出 `PROPOSED/UNKNOWN/CONFLICT`，`CERTIFIED` 只能由独立 checker 产生。
