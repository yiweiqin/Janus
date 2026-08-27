# uBuddy-AppWorld Hybrid Benchmark v2

## 1. 研究问题与采用理由

本 benchmark 回答的不是“一个 Agent 会不会调用 API”，而是：在一个类似实验室的组织中，多个 uBuddy 能否像组员一样理解总问题、拆解任务、选择合作者、让各自内部 Agent 执行、共享进度、处理故障，并把一次运行中得到的可靠经验迁移到下一轮。

因此采用双真值设计：

1. **AppWorld 官方 evaluator** 是最终任务真值，回答“外部世界是否真的被正确改变”；
2. **Janus 状态图与事件链** 是过程真值，回答“谁在什么时候做了什么、依据什么版本、是否违反依赖或泄露私有信息”。

AppWorld 提供可重置、多应用、可审计的真实操作任务和官方 checkpoint；MARBLE 只作为组织实验的设计参考，Who&When 只作为分层归因任务的设计参考，SWE-bench/TheAgentCompany 作为后续外部验证，不把它们的 judge 分数混入主分数。

## 2. Episode 定义

一个 episode = `任务实例 × 方法 × 随机种子 ×（可选故障）× 轮次`。每个 episode 固定：任务文本、初始 AppWorld 状态、模型、工具权限、预算、seed 和故障 manifest，只改变协作协议。

主方法：M0 单 uBuddy、M1 静态画像、M2 无版本共享看板、M3 Janus 完整协议。进化实验另比较 E0–E4 的组织/个体更新组合。

### 题目与评分标准的绑定关系

AppWorld 的每个官方题目与其初始数据库状态、checkpoint evaluator 是绑定的，不能换掉题目文字后仍声称使用原官方分。我们可以做三件合规的事：选择官方题目的子集；在不改变官方 evaluator 的前提下增加组织过程评分；为自定义题目另写并冻结 evaluator。v2 主表采用前两种方式，自定义实验室题目只进入扩展表，不能冒充 AppWorld 官方成绩。

## 3. 数据划分

任务按 task family 分组，不能把同一家族的近重复实例同时放入训练/调参和 locked test：development 用于调协议，validation 用于选定参数，locked_test 只在冻结后运行，boundary 单独报告。正式结论至少使用 3 个 seed，并报告均值、95% bootstrap CI、配对差值和效应量。

## 4. 八个维度

### D1 项目组织效果

最终以官方 success/checkpoint rate 为主，同时报告完成率、返工数、组织形成时间、跨人委派数。

### D2 原子任务执行效果

以官方 checkpoint 逐项计分，补充叶子任务完成率、失败率、重试率。

### D3 反馈后的自进化效果

同一 task family 的不同实例组成 Round 1→Round 2 pair。报告迁移收益、负迁移率、错误经验采用率、回滚恢复率；只有通过官方 evaluator、归因证据门控且无隐私泄露的更新才允许进入 Round 2。

### D4 问题理解、拆解与依赖

任务 gold 只规定必要能力、必要/禁止依赖和可接受叶子数，不规定唯一任务树。报告目标覆盖率、遗漏率、重复任务率、依赖正确率、平均树深度、无效叶子率和项目成功率。

### D5 跨人选择与内部 Agent 分配

分成 requester→recipient 和 recipient→internal Agent 两层。使用隐藏能力真值计算约束最优收益，与实际收益之差为 allocation regret；同时报告能力匹配、过期画像使用、无工具 Agent 选择、负载方差、过载率和失败后重分配质量。

### D6 共享看板与通信

从事件时间戳和 board metadata 计算更新延迟、有效状态覆盖率、过期读取率、冲突率、重复更新率、每个有效里程碑的消息数、token 开销和避免的重复劳动次数。

### D7 故障恢复与动态重组

通过标准 fault manifest 注入 Agent 失败、recipient 超时、画像过期、工具不可用、结果被替换、需求修改、看板冲突和 Agent 过载。报告发现率/发现时间、恢复成功率/恢复时间、错误传播率、返工范围和不必要重规划率。

### D8 分层过程归因与证据

gold 同时标注责任层、原因集合和证据事件引用。报告原因 macro-F1、责任层混淆率、多原因 IoU、证据 precision/recall、证据不足阻断率、错误经验采用率和置信度 ECE。LLM judge 只能作补充，主指标来自事件和人工/规则 gold。

## 5. 统计与结论边界

官方任务分与过程分分开呈现；不定义一个掩盖失败类型的总分。基础设施失败（模型端点、AppWorld、数据库）单独计数，不能当作任务失败。canary/pilot 只能证明链路，不能支持“方法更好”的论文结论。只有 locked_test、官方 evaluator 完整、独立 verifier 通过的结果才进入主表。
