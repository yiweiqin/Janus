# uBuddy-AppWorld-Hybrid：我们自己的 benchmark 说明

## 1. 它不是重新发明 AppWorld

AppWorld 负责提供公开、固定、可重置的多应用任务和官方验收。我们在 AppWorld 外面增加 uBuddy 的协作层，因此准确名称是：

> 基于 AppWorld 的 uBuddy 长程跨主体协作 benchmark / 实验套件。

这套 benchmark 服务于原来的两项创新点，不改变创新点：

- 创新点一：自治 uBuddy 在建群前发布能力画像，requester 按画像选择协作者并冻结版本；协作中共享可见性受控的任务、依赖、进度和结果版本。
- 创新点二：协作后从事件链生成组织层和个体层归因，通过证据门控分别更新组织策略和个体能力，并在下一轮迁移任务验证。

## 2. 主任务是什么样

我们固定 AppWorld `test_normal` 中 12 个任务族成员，不根据模型结果挑题。每题满足：难度 3、至少 2 个应用、至少 30 次官方参考 API 调用、至少 8 个不同 API。

| 任务 | 使用应用 | 官方参考 API 调用 | 任务内容概要 |
|---|---|---:|---|
| 6f4b9a5_1 | Spotify + Simple Note | 34 | 从喜欢的歌曲和艺术家记录中补全发行月份 |
| 042a9fc_1 | Spotify + Phone | 39 | 读取手机消息中的建议并更新播放列表 |
| 652485c_1 | Spotify + Phone | 60 | 汇总喜欢的歌曲，创建公开播放列表并短信分享链接 |
| b9c5c9a_3 | Phone + File System | 30 | 根据消息更新聚会 RSVP CSV |
| f323bae_1 | Simple Note + File System | 44 | 将习惯记录整理成规范 CSV 文件 |
| f861c32_1 | Venmo + Supervisor | 30 | 向多个群体转账并处理余额 |
| d18139b_1 | Venmo + Supervisor | 36 | 审批本月室友的付款请求 |
| 90adc3f_1 | Venmo + Supervisor | 35 | 删除错误付款请求并按修正金额重建 |
| bde252e_1 | Simple Note + Todoist | 45 | 根据工作安排移动和删除任务 |
| 8ce6779_1 | Todoist + Phone/评论 | 94 | 根据评论重新分配任务并留下确认评论 |
| 32616b5_1 | Simple Note + Splitwise | 103 | 根据旅行记录填写多个 Splitwise 组的费用 |
| 986aa4e_1 | Todoist + Spotify | 71 | 根据项目评论修改播放列表、留言并完成任务 |

这些任务不是简单查询。它们通常需要读取一个应用中的信息，再在另一个应用中修改状态，部分任务还涉及消息、文件、评论、支付或多个实体。

## 3. 我们如何把一题变成多 Agent episode

原始 AppWorld 任务没有强制要求使用多 Agent。我们固定任务、初始状态和官方 evaluator，只在外层增加以下 episode 协议：

```text
AppWorld reset
→ requester 查询已存在的 uBuddy 能力画像
→ requester 选择 recipient，冻结 profile snapshot
→ requester 生成 2–4 个子任务和依赖边
→ recipient 使用自己的 AppWorld facade 执行
→ Janus 写入共享状态和结果版本
→ requester/reviewer 检查依赖和结果
→ supervisor.complete_task()
→ AppWorld 官方 evaluator
→ 组织/个体归因
→ 证据门控和下一轮更新
```

例如“更新播放列表”任务可以拆成：

1. `research-a`：从 Phone 读取室友/同事的修改建议；
2. `execution-b`：根据建议在 Spotify 修改播放列表；
3. `review-c`：检查歌曲顺序、重复项和最终评论，确认完成。

## 4. 对照方法

- M0：单 Agent，不查询 uBuddy；
- M1：多 Agent，但只使用无版本静态画像；
- M2：多 Agent + 普通共享消息，没有版本快照、结果版本和归因门控；
- M3：我们的完整机制。

每个方法使用同一任务 ID、同一 seed、同一模型、同一工具权限和同一最大步数。唯一改变的是协作协议。

## 5. 主实验和进化实验

### 主实验

```text
12 tasks × 3 seeds × 4 methods = 144 episodes
```

核心指标：

- AppWorld 官方任务成功率；
- 子任务成功率；
- 依赖违规；
- 重复劳动和返工；
- 过期画像使用；
- 旧结果误使用；
- 私有信息泄露；
- token、时延和费用。

### 归因实验

采用 Who&When 的“谁在什么时候导致失败”思想，但按我们的创新点增加责任层：

- 组织层：任务拆分、recipient 选择、依赖、需求修订、结果版本；
- 个体层：某个 uBuddy 的能力缺口、工具调用或执行错误；
- 阻断：证据不足时拒绝高置信度归因。

计划使用 96 条盲标轨迹，指标为 macro-F1、层级混淆率、证据 precision/recall、ECE 和正确阻断率。

### 联合进化实验

使用同一任务族的不同实例构成迁移对：

```text
第一轮：完成训练任务并产生协作证据
第二轮：同结构、不同数据的迁移任务
```

比较组织更新、个体更新、证据门控联合更新和无门控联合更新。只有第二轮官方成功率改善且负迁移可控，论文才报告“联合进化有效”。

## 6. 公开组件和我们新增的组件

公开组件：

- AppWorld 任务、世界状态和 evaluator；
- MARBLE 的多 Agent 拓扑/里程碑设计参考；
- Who&When 的失败归因数据和标注思想；
- WebArena-Verified 的真实 Web 外部任务。

我们新增：

- AppWorld—Janus bridge；
- uBuddy profile query / selection snapshot；
- 状态图、依赖和结果版本 artifact；
- 双层归因和证据门控；
- 组织 overlay、个体能力更新、采用/阻断/回滚记录；
- 固定任务清单、实验 runner、独立 verifier 和云端安装脚本。
