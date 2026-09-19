# -*- coding: utf-8 -*-
"""把 P2 收尾一节追加进受追踪文档；按文件里第一条 markdown 标题做幂等键。"""
import io
import re
import sys

PATH = 'experiments/rdmd_detective_dataset/ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md'

CONTENT = u"""
## 12. P2 收尾：在库副本上把「投影与闸门」真跑了一遍（2026-09-19）

§11 的三处断点都是**静态**查出来的（读代码、读库、byte 搜索 asar）。这一节把它们放到
**库副本 + 产品自己的代码**上跑一遍，回答 §11 结尾留下的那句「当 plan 真发出时，投影与闸门是否成立」。

真实库与产品代码**一行未改**：快照是 `_snapshot_db.mjs` 出的单文件副本，所有写入都落在副本上。

### 12.1 先修探针自己的 bug：它从来没跑到过投影那一步

`_probe_layered_graph_e2e.mjs` 的文件头写着「在副本上跑真实迁移」，**代码里没有任何迁移调用**。
后果是一条链式失败：

1. `collaboration_graph_*` 在新快照上不存在（§11.3 的发布缺口）；
2. `projectTaskRunToCollaborationGraph` 抛异常，被 catch 进 `projectionError`；
3. 紧接着那句 `SELECT ... FROM collaboration_graph_nodes` 没有 catch，直接
   `no such table` 硬失败。

也就是说：**这个探针从来没有真正执行到「投影」和「闸门」**，而它的报告看起来"跑过了"。
（和 §11.1 的 `q()` 吞异常是同一类问题：失败没有被放在能被看见的位置。）

**修复**：在副本上显式调用产品自己的迁移入口 `migrateDatabase(db)`
（[`sqliteMigrations.js:517`](../../../src/main/modules/persistence/infrastructure/sqliteMigrations.js)，
其中第 553 行无条件调用 `ensureUBuddyCollaborationGraphSchema(db)`），并把迁移前后的表清单报出来。
同时把 `plan_events` 那一段改成**真实事件优先**（此前无条件注入）——注入的载荷再像也终究是我写的，
而这一段要回答的恰恰是「真实形状的载荷能不能走通」。

### 12.2 决定性证据：迁移一跑，4 张表就出来了

在**全新的干净快照**上：

```json
{"tablesBefore": [], "tablesAfter": ["collaboration_graphs", "collaboration_graph_nodes",
 "collaboration_graph_edges", "collaboration_graph_events"], "created": 4}
```

这把 §11.3 的结论从「byte 搜索推断」升级为**行为学证据**：在副本上调用产品自己的迁移入口，
缺的 4 张表就出现了；不需要改数据、不需要改代码、不需要任何探针侧的动作。
剩下的唯一变量就是**已安装构建里没有这段代码**。

### 12.3 投影成立：真实 plan 事件 → 四层图，第一次物化成功

- 选中的 task run：`task_60e1bf8f-0e0a-4419-a41c-794ed175b755`（真实群任务，
  所属协作组 `collab_group_PHIEeGYW8HiNaBcH`，delegation `agent_delegate_jkunevGGBMyDJHt0`）。
- plan 来源：**真实事件**（探针报告 `source: "real (…)"`），不是注入。
- 图形状（`collaboration_graph_nodes` 实查）：

  | kind | depth | n |
  | --- | --- | --- |
  | `root` | 0 | 1 |
  | `ubuddy` | 1 | 1 |
  | `agent_task` | 2 | 3 |
  | `agent_step` | 3 | 10 |

- 边（`collaboration_graph_edges` 实查）：
  `parent_of ×14`、`sequence_of ×8`、`assigned_to ×3`、`dependency_of ×2`、`delegates_to ×1`。
- 「相近效果」度量：`metric.ready = true`，`missing = []`。

**⇒ `agent_step` 层与 `sequence_of` 边在真实数据上物化成功**（在副本上）。
§11.2 里「级联推理在真实数据上退化」这个担忧，至少在投影侧被否证了 ——
退化的原因从来不是投影写不出，而是承载它的表不存在。

### 12.4 闸门**不**成立，但原因只有一个

`passes: false`，缺口 2 条：

| 字段 | kind | side | 节点 status |
| --- | --- | --- | --- |
| `output` | `agent_task` | `exec` | `cancelled` |
| `output` | `agent_task` | `exec` | `cancelled` |

两条都是**被取消的任务**。也就是说：`title`/`summary` 在两侧都齐、`status` 在 step 层也齐，
唯一过不去的是「一个被取消的任务没有交付文本」。

这不是投影坏了（投影如实反映了 `task_nodes.result_text` 为空），也不是数据没到
（cancelled 的结果**永远不会到**）。它是**契约的分类里没有这一格**：
[`summarizePlanExecGaps`](../../../src/shared/contracts/uBuddyPlanExec.js) 的注释把
「agent_task 层缺 output」解释成「没有执行结果」（= 该等结果），但 cancelled 的结果等不到。

### 12.5 豁免试算：一条规则是否**足够且最小**

探针新增 `gateWaiverDryRun`，**只试算、不落契约**：

- 规则：`exec` 侧 `agent_task` 的 `output`，在 `status ∈ {cancelled, failed}` 时不判缺。
- 结果：`gapsBefore: 2 → gapsWaived: 2 → gapsAfter: 0`，`wouldPass: true`、`remainingDetail: []`。
- 也就是说：**这一条规则就是把闸门归零的充分且最小改动**，没有第二种缺口藏在后面。

为什么它不是「放水」：`status` 本身就是 v2 已经判的字段，被取消这件事已经被 `status`
表达了一次；再要求一个 cancelled 节点吐出 `output`，是要求一个**数据源结构上写不出**的值
——和 §11 里 v2 把 `summary`/`output` 从规划侧必需集里摘掉是同一条道理（准入规则 (c)）。

**为什么本轮刻意不改契约**：改必需集要 **JS 与 `deploy/rdmd_detective.py#required_fields_for_kind`
同步改**、要 bump `PLAN_EXEC_CONTRACT_VERSION`；而版本号已经写进已完成任务的
`cloud_rdmd_inference_jobs.contract_version`（现存全是 `ubuddy_plan_exec_v2`，见
[`V4_FULL_REPORT.zh-CN.md`](../V4_FULL_REPORT.zh-CN.md) §9 与 §11 的真机切换门）。
一次未经验证的 bump 会让 v4 刚拿到的真机证据**失效**。所以先把它降级成一条**待决策项**，
证据留在 `gateWaiverDryRun` 里，随时可复现。

### 12.6 P2 断点清单（最终版）

| # | 旧结论 | 实测真因 | 最小修复 | 已修? | 需要人? |
| --- | --- | --- | --- | --- | --- |
| 1 | plan 事件 0 条 | 探针 SQL 用别名 + `q()` 吞异常；真实数据 6 事件 / 25＋步 | `json_extract` 进 WHERE；查询失败可见并非零退出 | ✅ | 否 |
| 2 | 依赖边全空 | 一半是 7/13 的真数据，一半是 `edgesOf` 投影 bug | plan 侧改喂原始行 | ✅ | 否 |
| 3 | `collaboration_graph_*` 缺失 | 安装构建缺该迁移 | **装新构建 + 重启** | ❌ | **是** |
| 4 | （本轮新增）闸门在真实数据上恒 fail | `output` 对 `cancelled` 节点恒缺，契约无此分类 | 终止负向状态豁免 outcome 字段（需 JS+Py 同步 + bump，待决策） | ❌ | **否（是决策）** |

### 12.7 P2 的验收：输入侧只剩一条人做的交接

输入侧的结论从「断路」收敛成**「通到最后一跳，卡在发布」**：

- 采集（codex → scheduler → `task_events.payload_json.plan`）：**真实数据已验证通**。
- 投影（`projectAgentPlanSteps` → `agent_step` + `sequence_of`）：**在副本上已验证通**（§12.3），
  图能撑起完整的四层结构，度量也能跑。
- 闸门（`planExecContractGaps`）：**在副本上已验证**，只差 §12.5 那一条规则。
- 缺的那一环是**装一个含 `ensureUBuddyCollaborationGraphSchema` 的构建**。

**唯一仍需人做的**（与 §H 的交接重合）：**装新构建 → 重启桌面端 → 跑 ≥2 个真实群任务**。
在那之前：
- 影子度量的分母只可能是 0；
- apply 的度量门不可能被满足。

这不是缺陷 —— 是**闸门在正确地挡着**（fail-closed 按设计工作）。

### 12.8 复现方式

```powershell
cd experiments/rdmd_detective_dataset/ubuddy_recon
node _snapshot_db.mjs "$env:USERPROFILE\\.janus-test\\data\\janus.db" "$env:TEMP\\janus_fresh.db"
node _probe_layered_graph_e2e.mjs "$env:TEMP\\janus_fresh.db"   # 见 steps / graph / gate / gateWaiverDryRun
```

读结果的辅助脚本：`_probe_layered_read.mjs`（`A 迁移效果 / B 四层图 / C 闸门 / D 缺口节点状态`）。
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
