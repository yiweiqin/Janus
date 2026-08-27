# uBuddy-AppWorld Hybrid Benchmark v2（简版）

## 一句话

这是一个评测“实验室式多 uBuddy 协作能力”的 benchmark：一个 requester uBuddy 负责组织，多个 recipient uBuddy 管理自己的内部 Agent。

## 主要测什么

1. 项目能不能组织起来并完成；
2. 内部 Agent 能不能完成具体任务；
3. 第一轮经验能不能让第二轮变好；
4. 总问题拆解是否完整、合理；
5. requester 和 recipient 是否选对协作者和内部 Agent；
6. 共享看板信息是否及时、准确、不过期；
7. 出现失败、超时、工具不可用后能否恢复；
8. 能否判断错误来自哪一层，并提供证据。

## 怎么评分

- AppWorld 官方 evaluator：判断外部任务最终是否真的完成；
- Janus 状态图和事件日志：评价协作过程；
- 两类分数分开报告，不混成一个总分。

## 对照方法

- M0：单 uBuddy；
- M1：多 uBuddy + 静态画像；
- M2：多 uBuddy + 普通共享看板；
- M3：Janus 完整机制，包括版本化画像、状态图、结果版本、归因门控和自进化。

## 实验划分

按 task family 划分 development、validation、locked test 和 boundary，避免相似题泄漏。自进化实验使用同一 task family 的不同实例做 Round 1→Round 2 配对。

## 运行原则

正式实验只在远程 Linux 机器运行，本机不跑 AppWorld、大模型或正式数据。本简版只用于方案沟通，不是完整可执行源码包。
