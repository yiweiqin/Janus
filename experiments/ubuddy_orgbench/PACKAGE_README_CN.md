# uBuddy-AppWorld Hybrid Benchmark v2：给审阅者的快速说明

## 这是什么

这是 Janus/uBuddy 的实验评测协议，不是一次已经跑完的实验结果。它用于评估“实验室式”的双层协作：一个 requester uBuddy 负责理解总问题和组织协作，多个 recipient uBuddy 各自管理自己的内部 Agent。

## 最重要的设计

- AppWorld 官方 evaluator 负责判断外部任务是否真的完成；
- Janus 状态图和事件日志负责判断协作过程是否合理；
- 八个维度分别报告，不把所有分数压成一个总分；
- 主实验使用 M0–M3 四个逐步增强的方法；
- 自进化实验使用 Round 1→Round 2 的同 task family 不同实例配对；
- 正式数据只允许在 Linux 远程机产生。

## 八个评测维度

1. 项目组织效果：整个团队有没有形成有效组织并完成项目；
2. 原子任务执行效果：内部 Agent 是否真正完成可验收的小任务；
3. 反馈后的自进化效果：第二轮是否因第一轮经验变好，是否发生负迁移；
4. 任务拆解与依赖：有没有漏任务、重复任务或错误依赖；
5. 跨人选择与内部 Agent 分配：两层调度是否接近隐藏能力真值下的最优；
6. 看板与通信：共享状态是否及时、有效、不过期、不冲突；
7. 故障恢复：失败、超时、工具不可用和需求变化后能否局部恢复；
8. 分层归因：能否判断问题来自 requester、recipient、内部 Agent 或环境，并给出证据。

## 怎样看分数

- `official_checkpoint_rate`：AppWorld 官方 checkpoint 通过比例，是外部任务结果；
- `targetCoverage`、`dependencyCorrectRate` 等：任务理解和拆解质量；
- `recipientAllocationRegret`、`meanInternalAllocationRegret`：离隐藏最优分配有多远，越低越好；
- `staleReadRate`、`conflictStateRate`、`boardTokenCost`：看板和通信代价，越低通常越好；
- `faultDiscoveryRate`、`recoverySuccessRate`：故障发现和恢复能力，越高越好；
- `macroF1`、`multiCauseIoU`、`evidencePrecision/Recall`：归因是否找对责任和证据；
- `meanTransferGain`、`negativeTransferRate`：自进化带来的净收益以及负迁移风险。

## 目录怎么读

- `BENCHMARK_PROTOCOL.md`：论文级正式协议、假设、控制变量、统计方法和结论边界；
- `REMOTE_RUNBOOK_CN.md`：远程 Ubuntu 运行步骤；
- `task_protocol.manifest.json`：development/validation/locked_test/boundary 划分；
- `transfer_pairs.manifest.json`：Round 1→Round 2 迁移配对；
- `fault_manifest.example.json`：八类标准故障；
- `schemas/`：任务 gold、故障、归因和运行配置格式；
- `evaluators/`：八维评分器和独立复算验证器；
- `adapters/`：AppWorld 主适配器，以及 TheAgentCompany、MARBLE、Who&When、SWE-bench 的外部参考适配器；
- `orgbench_experiment.mjs`：远程运行时入口。

## 当前状态

本包只包含代码、协议、schema 和 manifest，不包含模型密钥，也不包含正式实验数据。当前已通过本机静态检查和 15 个单元测试；AppWorld 正式运行仍需在远程机执行。

本目录已包含 AppWorld bridge、远程安装脚本和 v2 任务 manifest；但正式运行仍需要完整 Janus 仓库中的 Cloud 模块、npm scripts、Node 依赖和官方 AppWorld 数据。
