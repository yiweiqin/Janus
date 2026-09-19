# TDB 完整会话训练数据集卡片 v1

## 数据来源

第一版数据由两部分组成：

1. **可重放合成协议数据**：仓库现有 finite-world evaluator、paired-noop/AB 反事实生成器和最小披露 solver，用于验证标签链路、泄露门和统计流程；
2. **真实授权 episode**：由 Janus Cloud 的 delegation、workspace/group messages、task events、TDB replay snapshot 和官方 evaluator 结果导出。只导出 viewer 有权访问的内容，并在模型输入前脱敏。

外部方法参考采用公开的 AppWorld（官方任务/evaluator）、MARBLE 组织基准和 Who&When 归因数据；它们用于任务环境或对照，不把第三方 judge 分数直接当作 TDB gold。

## 训练单位与切分

基本单位为一个 `taskFamilyId/taskInstanceId/episodeId`。train/development/calibration/test 按 task family 固定切分；另外生成未见 Agent-pair、relation type 和时间外推切分。`taskFamilyId` 只用于切分，不进入模型 prompt。

## 标签来源

- 依赖状态：独立 evaluator、可验证事件规则或双人标注；
- 最小披露：finite-world reference、authorization contract、独立 privacy checker；
- 进化优先级：paired intervention/noop 的收益、`G_exec-G_plan` 偏差、跨任务验证和双人标注；
- 没有独立依据的字段保持 `labelMask=false`，输出 UNKNOWN/PROBE，不转成伪标签。

## 质量和审查

每条记录保存原始 hash、脱敏 hash、replay token、trace hash、evaluator version 和 label provenance。人工标注通过本目录的本地网页完成，两个 reviewer 独立提交；不一致样本进入 adjudication 队列，记录 Cohen κ 或 Krippendorff α。

## 局限

合成数据不能证明真实泛化；真实数据需要足够多的 task family 和独立验收器。训练前只允许达到 `READY_FOR_HUMAN_REVIEW`，人工审核完成并生成 consensus 后才能开始有监督训练。
