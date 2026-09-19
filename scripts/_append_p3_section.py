# -*- coding: utf-8 -*-
"""把 P3 动作侧一节追加进受追踪文档；按文件里第一条 markdown 标题做幂等键。"""
import io
import re
import sys

PATH = 'experiments/rdmd_detective_dataset/ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md'

CONTENT = u"""
## 13. P3 动作侧：任务族、影子度量的分母、apply 双门（2026-09-19）

§9 把动作侧关在 shadow，理由是「没有证据就不该改图」。这一节做的是**把证据的容器建起来**，
并让「开图动作」这件事在结构上只能从两个门里进来。三件事：任务族、度量口径、apply 通道。

一句话结论：**apply 现在是可达的，但在真实环境里仍然不可达** —— 前者是代码事实，
后者是数据事实（度量门只可能看到 0 条观察）。这两句话不矛盾，也都必须成立。

### 13.1 任务族标识：为什么它不是"顺手的索引"

[`observeShadowFollowUp`](../../../src/main/modules/collaboration/application/planExecDriftService.js)
只能在**同一张协作图**里做事后观察：它比的是 `nodeId`。而 `nodeId` 是**图内标识**，
跨图比较没有意义（两张图的 `task_1` 完全可能是两件不同的事）。

这就把原来的度量逼进一个死角：它可以回答「我这轮建议的改动，我自己这轮后面做了吗」，
**回答不了**「下一个**同类任务**采纳了我上一轮的建议吗」—— 而后者才是「模型有没有用」的证据。

于是补上 [`planExecTaskFamily`](../../../src/main/modules/collaboration/application/planExecDriftService.js)：
族的定义 = `groupId`（协作组）优先，退到 `delegationId`，再退到 `taskRunId`；同时带一份
**结构形状指纹** `planExecFamilyShape(plan)`（那层有什么 kind、各几个）。

它随提案一起落进事件（`shadow.proposal.taskFamily`），所以**不需要回填历史**。

**诚实边界（必须写在这里，否则会被误读）**：族标识**没有**解决跨图节点身份问题。
今天的后续观察仍然只在本图内做，因此族分区现在**测不出跨任务一致率**。
它现在的价值是：数据从今天起开始带上族，等到跨图节点身份解决时不必回填。
报告里把这件事直说（见 13.3、13.7），而不是让「族数」看起来像一个已经工作的指标。

**退化提案**：当族退到 `taskRunId`（没有 `groupId`/`delegationId`）时，anchor 只有这一条 run，
**结构上不可能收敛**。`summarizeShadowAgreement` 把它们数成 `degenerateFamilyProposals`，
报告单独报出来 —— 否则「提案数在涨」会被读成「样本在积累」。

### 13.2 影子度量的分母口径

`SHADOW_MIN_OBSERVATIONS = 30` 一直没有被满足过，而原因不是"数据不够"：过去没有任何地方
把分母写清楚。现在口径被固定在 `summarizeShadowAgreement` 里，并随报告一起输出：

| 量 | 含义 | 进分母? |
| --- | --- | --- |
| `proposals` | 提案总数 | ✗ |
| `observed` | 提案之后图**真的又动过**（有更新的 revision） | **✓** |
| `unobserved` | 提案之后图没再变 | ✗ |
| `carriedOut` | 观察到的那些里，建议的改动**确实被做了** | 分子 |

`unobserved` **既不算同意也不算反对**：在一个真实产品里，多数任务跑完就结束了，
图不再变是常态。把它算进分母会把一致率系统性压低，算成同意则会系统性抬高 —— 两条都是
"报告看起来有数了"的假象。

### 13.3 apply 通道：双门 + 唯一写消费者

**门一（显式开关）**：能力位 `ubuddy_plan_exec_drift_apply`，默认 off。

**门二（度量门）**：[`shadowApplyGate`](../../../src/main/modules/collaboration/application/planExecDriftService.js)
要求**每一类 op** 各自 `observed ≥ 30` 且 `agreementRate ≥ 0.6`。
按 op 而不是按总数：总数够了不等于 `remove_node` 这一类也够 —— 而 `remove_node` 恰恰是最贵的那类。

[`resolveDriftPhase`](../../../src/main/modules/collaboration/application/planExecDriftService.js)
只在**两门同时满足**时才产出 `apply`，否则停在 `shadow`。所以 `RDMD_ACTION_PHASES` 里
虽然出现了 `'apply'`，"apply 不可达"这条不变量**没有被削弱**，它被改写成了一个更强的命题：
**双门不满足时不可达**（测试直接钉住这两种输入下的 `phase`）。

**唯一写消费者**：`writePlanPrior`。它写什么、不写什么是这个阶段的核心约束 ——

- 只处理 `minimal_plan_edit`。`similar_swap`（换人）是**方案二**的事，在 apply 阶段也 no-op；
- 只写**一行** `RDMD_PLAN_PRIOR_EVENT`（`rdmd_plan_exec_drift_plan_prior`）事件，
  **不碰任何图**：先验是给**下一轮规划**看的建议，不是对既有图的编辑；
- 记录里带 `graphMutated: false` 与之同行的还有 `gate`（凭什么被写下来），
  读这条先验的人应该能看见它的判据。

测试里有一条直接查库的断言：整段 apply 流程跑完，`collaboration_graph_nodes` 与
`collaboration_graph_edges` 仍然是 0 行。**"改图"这件事只有结果能证明，不能只靠函数名。**

### 13.4 一个"看起来该写却写不出"的分支：`target_incomplete` 不可达

`planPriorFromRecord` 里有一条防线：`fields` 点名了某个字段、但 `target` 里没有这个值 → no-op。
写测试时想造一条真实可达的这种图（plan 的节点有 `kind`、exec 的没有），**造不出来**：

`normalizeDriftGraph` 会把每个被比较的字段归一成**字符串**（缺失 → `''`），而 `shadowProposal`
的 `target` 抄的正是这个归一化后的 exec 节点 —— 于是 `target.kind === ''`，仍然"有值"，仍然 eligible。

结论被写成了断言而不是删掉：**它是纵深防御，不是活路径**。今天唯一能覆盖它的层是纯函数测试
（人为构造一条不完整提案）。把它断言成"不可达"，是为了不让后来的人以为线上路径正在覆盖它。

### 13.5 幂等：一族**多条**是有意的

先验事件 id 是 `rdmd_plan_prior:{taskFamilyId}:{taskRunId}`，不是一族一行。

为什么不做成一行：`recordTaskEvent` 把事件 id 绑在一条 run 上（同 id 换 run 会抛
`Task event identity conflict`，是 store 的既有不变量）。硬做成一族一行只有两条路，都不能走 ——
改写上一条 run 的行（等于伪造它写下的时间与内容），或者后来的先验直接丢弃。

所以：**一族多条 = 一条时间线**。消费者（下一轮同类任务的规划轮）按族查询取**最新**一条。
幂等的正确表述是「同一个 (族, run) 反复评估只留一行」，测试钉的就是这句。

### 13.6 验收

| 门 | 命令 | 结果 |
| --- | --- | --- |
| 动作侧不变量 | `npm run cloud:test:rdmd-shadow` | 56 passed |
| 传输层 | `npm run cloud:test:rdmd-transport` | 35 passed |
| 云侧作业 | `npm run cloud:test:rdmd` | 26 passed |
| 编码卫生（含探针） | `node --test cloud/test/encoding-hygiene.test.mjs` | 5 passed |
| worker 判定 | `npm run experiment:rdmd-worker:test` | 12 OK |

只读报告在**真实库**上跑：

```powershell
node scripts/rdmd_shadow_report.mjs "$env:USERPROFILE\\.janus-test\\data\\janus.db"
```

输出 `影子提案 0 条，后续观察 0 条` —— 并且**不把这读成 0%**：它明确说
「能力位还没开过，或者还没有真实群任务跑完，这时候开真动作无从谈起」。
报告里同时带上分母口径、族数、退化提案数，以及"两道门"的判据原文。

### 13.7 P3 的验收标准：闭环接好且**可证被闸住**

- 写入路径存在：`writePlanPrior` 有调用点、有事件 id 规则、有幂等测试、有"不碰图"的查库断言。✅
- 默认不可达：能力位默认 off + 度量门（真实环境 0 观察）→ `resolveDriftPhase` 恒产出 `shadow`。✅
- 有测试钉住：双门不满足时的 `phase`、度量边界（分母口径）、写入幂等、`similar_swap` no-op。✅

**本轮结束时 apply 在真实环境仍不会生效** —— 无真实判定、无度量。这是**预期结果**，
不是未完成项。与 §12.7 同源：那一条人做的交接（装新构建 → 跑 ≥2 个真实群任务）
不完成，度量门的分母就永远是 0 —— 而**这正是闸门在正确工作**。
"""


def main():
    text = io.open(PATH, encoding='utf-8').read()
    headings = re.findall(r'^## .+$', CONTENT, flags=re.M)
    marker = headings[0] if headings else CONTENT.strip()[:60]
    if marker and marker in text:
        print('already present, skip:', marker)
        return 0
    io.open(PATH, 'w', encoding='utf-8', newline='\n').write(text.rstrip('\n') + '\n' + CONTENT)
    print('appended; new length =', len(io.open(PATH, encoding='utf-8').read()))
    return 0


if __name__ == '__main__':
    sys.exit(main())
