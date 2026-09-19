# 自研技术栈立场（用户决策记录）

> 记录时间：2026-09-19
> 记录人：AI（按用户口述整理，不加入 AI 的技术主张）
> 性质：**方向性决策**。本文档记录用户的判断和要求，作为后续工作的判据。
> 冲突处理：本文件与任何技术分析、既有注释、既有文档冲突时，**以本文件为准**。

---

## 1. 核心立场（用户原话要点）

1. **codex 报的那份 plan，不是我们自己做的。**
   那是远程第三方产出的东西，不是我们的产品能力。
2. **以后不要再拉远程官方的代码了，那是不对的。**
   不再去研究、引用、对齐、wiring 远程官方实现。
3. **我们根本不用 codex。**
4. **我们全程都是用我们自己做的东西。**

---

## 2. 这个立场对具体事物的判定

| 事物 | 判定 |
| --- | --- |
| `turn/plan/updated` 报出来的 plan steps | **不是我们的产物**，不作为我们的能力对外表述 |
| 远程官方 app-server 的协议、schema、二进制 | **不引入、不对齐、不作为依赖前提** |
| 我们自己的 `executionPlan.steps` | **这才是我们自己的规划产物** |
| 我们自己的 planner / 协作图 / RDMD | **我们的主线成果** |
| 任何"因为上游怎么怎么样，所以我们只能怎么怎么样"的论证 | **不成立**，不作为设计约束 |

---

## 3. 我们自己的规划产物在哪（已存在）

用户的判断成立：我们**自己**已经产出了规划步骤，与第三方无关。

| 环节 | 位置 | 状态 |
| --- | --- | --- |
| 生成 | `src/main/modules/orchestration/application/uBuddyTaskIntakePlanner.js` | 已有 |
| 契约 | `src/shared/contracts/uBuddyTaskIntake.js` → `executionPlan: { summary, steps[] }` | 已有 |
| 存储 | message metadata → `uBuddyPreDispatchPlan.executionPlan` | 已有 |
| 展示 | `src/renderer/app/views/chatView.js` | 已有 |
| 组织层规划 | `task_runs.metadata_json.taskGraphProposal`（我们 planner 产出） | 已有 |
| 执行 | `executeTaskNodeAsUnifiedAgentWork` → `sendChat` | 已有 |

**真实数据证据**（本机库 `.janus-test`）：

- 有 `taskGraphProposal` 的 run：**10** 个
- 有 `executionPlan.steps` 的 message：**5** 条以上，例：
  - 5 步「建立课程总纲… / 编写数学基础… / 编写字典学习… / 合并所有章节… / 逐章核验…」
  - 3 步「梳理可乐主题的可核查要点… / 依据框架撰写初稿… / 核对结构…修订定稿」

**结论：自研规划链是完整存在且有真实产出的。它才是我们的东西。**

---

## 4. 立场落地：需要收口的地方

以下是"让现实符合立场"的待办，不含任何"应该依赖第三方"的建议。

### 4.1 协作图的 agent 层数据源
- 现状：`agent_step` 层当前读的是外部上报的 plan。
- 目标：改为读**我们自己的** `executionPlan.steps`。
- 需要解决：
  - 粒度：我们的 `executionPlan` 是**每任务一份**，`agent_step` 需要挂到**每个任务节点**下 → 需要归属拆分。
  - 执行侧：`G_exec` 侧来源需要从**我们自己的执行记录**取（任务节点状态流转、我们自己的执行产物），不从外部取。

### 4.2 外部依赖清理
- 排查并移除对外部 app-server / 远程官方组件的运行时依赖。
- 排查并移除代码中"因为上游如此"类的注释与假设。
- 模型访问层：我们已有自己的本地中转（`src/main/codexProviderRelay.js`）与直连执行器（`src/cloud/modules/evolution/evolutionAuthority.js` → `createPlatformEvolutionModelExecutor`），这部分是自研的，保留。

### 4.3 文档与注释收口
- `experiments/rdmd_detective_dataset/ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md` 中把外部 plan 当作 `G_plan` agent 层来源的表述，需要改写。
- `src/shared/contracts/uBuddyAgentPlanSteps.js` 顶部"数据来源只有一个 → 外部通知"的表述，需要改写。
- `src/main/codex.js` 中相关注释同理。

---

## 5. 对 RDMD（反向侦探）的影响

- 模型吃的 `G_plan`(agent 层)，应当来自**我们自己的规划**，而不是外部上报。
- 这样模型回答的问题才从
  「agent 自己前后一致吗」（自洽性）
  变成
  「**agent 偏离了我们的规划吗、偏得对不对**」（执行力）。
- 后者才是我们真正要管的事，也才是自研链路的自然产物。

---

## 6. 一句话

> **我们自己的规划链本来就存在、有产出、有真实数据。**
> **它才是我们的东西。外部报出来的那份不是我们的，不应作为我们的能力、来源或前提。**
