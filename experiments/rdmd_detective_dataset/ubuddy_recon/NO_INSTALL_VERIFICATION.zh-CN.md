# 无安装验证闭环与交接

> **目的**：不装任何桌面客户端、不打包、不碰真实群任务，用**已有测试**把 RDMD 这条链的逻辑与接缝全部跑一遍；
> 然后诚实地说清"这样证明不了什么"。
>
> 配套文档：[CODE_OWNERSHIP_AND_FLOW.zh-CN.md](CODE_OWNERSHIP_AND_FLOW.zh-CN.md)（归属与流程）、
> [OWNED_CODE_AUDIT.zh-CN.md](OWNED_CODE_AUDIT.zh-CN.md)（逐文件审计）。
> 基准：HEAD `467d93f`，`upstream/main` = `799b10b`。

---

## 一、为什么可以完全不装

三条结构性事实，决定了"不装也能验"：

1. **自有代码是纯函数 + 可注入依赖。**
   `uBuddyReverseDetective.js` / `uBuddyPlanExec.js` / `uBuddyAgentPlanSteps.js` 零依赖、零 IO；
   `planExecDriftService.js` 的云通道与 `store` 都是**注入**的（`cloud: () => ({...})`），
   测试里换成假的即可，不需要 Electron、不需要网络。

2. **桌面侧的 store/db 可以脱离 Electron 直接开真 SQLite。**
   证据：`planExecDriftShadow.test.js` 就是这么干的——它 `import { openDatabase } from 'src/main/db.js'`
   与 `import { Store } from 'src/main/store.js'`，在临时目录开真库、灌 30+ 条 `task_events`、
   跑真实的影子提案与后续观察，然后关库清理。**没有一个 Electron API 参与。**
   也就是说"桌面建图 + 漂移记录"这段接线是**可以被无头测试覆盖**的。

3. **云端队列用 `pg-mem`，worker 判定是纯函数单测。**
   `cloud:test:rdmd` 用 `pg-mem` 起内存 Postgres 跑作业队列；
   `experiment:rdmd-worker:test` 只测 `verdict_from_record` 的降级不变量，无需 GPU、无需 torch。

**前提（已核实）**：`node_modules` 就绪（`pg-mem` / `express` / `pg` 均在位），
所有关键测试文件在位。**唯一不需要做的事就是 `npm install` 和打包。**

---

## 二、发生了什么（三分钟版）

### 2.1 归属

分叉点 `94e5172` **连 `src/` 目录都没有**（只有 README/config/打包脚本）。
全部源码是 `ca4437f`（2026-08-27，「Preserve current Janus development state」）一次拉进来的：
**563 个文件 / +270,688 行**，其中 464 个 `src/` 文件里 **462 个与 `upstream/main` 逐字节相同**。

真正属于我们的：

| 层 | 数量 | 内容 |
| --- | --- | --- |
| 桌面 `src/` | **16** | 10 个新增（4 契约 + 1 服务 + 5 测试）+ 6 个挂接点 |
| 云端 `cloud/` | **25** | RDMD 模块 4 + 协作/组织 6 + 迁移 4 + 挂接 6 + 支撑若干 |
| 工具 `scripts/` | **20** | worker / 训练 / 评测 / 闸门 / 运维 |
| 实验 `experiments/rdmd_detective_dataset/` | **117**（tracked） | 语料、SFT、OOD/对抗探针、recon |

### 2.2 Codex 边界

- **我们的自有代码零 Codex import**：6 个挂接点的 diff 里 `codex` 一行未碰；
  10 个新文件里 `codex` 只出现在注释里。
- **Codex 全在拉来的宿主里**：`src/main/codex.js`（3491 行，5 个 spawn 点）+ 8 个同族文件，
  以及 `src/main/modules/orchestration/application/` 下的规划器。
- **7 个 Codex 规划器里只有 4 个是活的**：
  活跃 = `uBuddyContinuousPlanner`（群任务主规划）、`uBuddyTurnDecisionPlanner`、
  `uBuddyTaskGraphPlanner`、`uBuddyDeliveryReviewService`；
  **死代码 = `uBuddyCollaborationPlanner`、`uBuddyTaskIntakePlanner` 的 `decideUBuddyTaskIntake`、
  `uBuddyTaskReadinessAuditor`**（全仓无调用点，改它们不会有任何效果）。

### 2.3 唯一真正的耦合（必须知道）

`src/shared/contracts/uBuddyAgentPlanSteps.js` 的文件头写死了：

```
// ## 数据来源只有一个
//
//   Codex app-server 的 `turn/plan/updated` 通知
//     -> src/main/codex.js（activityType: 'plan'）
//     -> src/main/scheduler.js（TASK_PROCESS_STRUCTURED_FIELDS 白名单含 'plan'）
//     -> task_events.payload_json.plan
```

"**除了 task_events，没有第二条通路**"。所以 RDMD 的 `agent_step` 层只能从 Codex 产生的
plan 事件投影出来。我们的代码不调用 Codex，但**拿不到 Codex 的数据就没有可对比的执行路径**。
这是数据耦合，不是代码耦合。

---

## 三、无安装验证闭环

按"离外部依赖由远及近"分五层。**全部不装桌面、不打包。**

### 第 0 层：环境自检

```powershell
cd D:\Cli-anything\Janus
npm run cloud:test:hygiene
```

覆盖：UTF-8 BOM / 编码卫生（本项目反复踩过的坑）。
判据：exit 0。**任何编码问题会在这里先炸，而不是在别处被误读成逻辑错。**

### 第 1 层：纯函数的单元与契约（无外部依赖）

```powershell
node --test src/shared/contracts/uBuddyReverseDetective.test.js
node --test src/shared/contracts/uBuddyPlanExec.test.js
npm run experiment:rdmd-chain-to-dag:test      # stepDependencyMap.test.mjs
npm run experiment:rdmd-worker:test            # python，worker 判定降级不变量
npm run experiment:rdmd-acceptance:test        # python，接受闸门（自带合成夹具）
```

覆盖：漂移检测 / 相近度 / 最小编辑、`(G_plan,G_exec)` 契约与有效必填、
序列→DAG 映射、worker 的 `valid!=True` 降级、接受闸门的四条判定路径。
判据：全 exit 0。**这一层证明的是"逻辑对"。**

### 第 2 层：桌面↔云接缝（真 HTTP + 真 SQLite + pg-mem，无 GPU/无 Electron）

```powershell
npm run cloud:test:rdmd-transport   # planExecDriftCloudTransport + planExecDriftService
npm run cloud:test:rdmd-shadow      # 影子/动作纪律 + 能力位默认值
npm run cloud:test:rdmd             # 云端作业队列（pg-mem）
```

覆盖与关键断言：

| 套件 | 证明的东西 |
| --- | --- |
| `cloud:test:rdmd-transport` | 桌面对云端**真发 HTTP**、轮询到终态、失败一律归一成 `record_only`；直连与云的形状一致 |
| `cloud:test:rdmd-shadow` | 影子**只写 `task_events`**、**永不改协作图**；`taskFamily` 分组；`shadowApplyGate` 在 observed=0 时**产不出 `apply`**；`planExecDriftApply` 默认关 |
| `cloud:test:rdmd` | 云端作业状态机：去重（一 run 一作业）、领取/租约、重试耗尽收尸、出处 CHECK 按终态区分 |

判据：全 exit 0。**这一层证明的是"接缝对、纪律对"。**
（`cloud:test:rdmd-shadow` 是**唯一**同时在无头环境里跑真 SQLite 桌面库 + 真服务 + 真 store 的套件。）

### 第 3 层：云侧图与组织（pg-mem）

```powershell
npm run cloud:test:collaboration-research      # collaboration-state-graph
node --test cloud/test/ubuddy-collaboration-graph.test.mjs
npm run cloud:test:organization-evolution
```

覆盖：协作图发布/读取（含 `safePublicJson` 屏蔽敏感键）、状态图与归因、组织演进路由。
判据：exit 0。

### 第 4 层：语料闸门（确定性，可自行重生成；无 GPU）

```powershell
npm run experiment:rdmd-ood:gate            # 会重新生成 OOD/对抗语料再比对钉住的基线
npm run experiment:rdmd-ood:gate:selfcheck
npm run experiment:rdmd-acceptance:real     # 需要真语料；缺语料时 exit 3（=未测，不是失败）
```

判据与退出码：

- OOD 闸门：**0** 全过 / **1** 闸门失败 / **3** 未测
- `rdmd-acceptance:real`：**3** 表示本机没有语料（`sft/test.jsonl`、`data/test.jsonl` 被 gitignore），
  即"未测"而非"错"——这是**刻意设计**，避免把缺数据误读成失败

> 注意：`data/*.jsonl` 与 `sft/*.jsonl` 被 gitignore，干净克隆下必须先
> `node experiments/rdmd_detective_dataset/generate.mjs` → `prepare_sft.mjs` 才能跑第 4 层的 real 变体。
> OOD 闸门例外：它自己会重新生成语料。

### 第 5 层（可选，仍需"不装桌面"）：真云端 E2E

在 GPU 盒上跑，**依然不装桌面**：

```bash
# 需要 DATABASE_URL / JWT_SECRET / RDMD_API
node scripts/rdmd_cloud_e2e.mjs --stage all --backend gpu_worker
bash scripts/_rdmd_worker_daemon.sh start
bash scripts/_rdmd_zombie_sweep.sh
```

覆盖：真实 Postgres + 真实 cloud API + 真实 worker 的**无 mock**全链（提交→领取→推理→回传判定+出处）。
判据：`EVIDENCE` 里出现终态判定，且 出处 四项（adapter sha256 / base model / contract / rule）非空。

### 一条命令跑完第 0–3 层

```powershell
cd D:\Cli-anything\Janus
npm run cloud:test:hygiene; `
npm run cloud:test:rdmd-transport; npm run cloud:test:rdmd-shadow; npm run cloud:test:rdmd; `
npm run cloud:test:collaboration-research; npm run cloud:test:organization-evolution; `
npm run experiment:rdmd-worker:test; npm run experiment:rdmd-acceptance:test; `
npm run experiment:rdmd-chain-to-dag:test
```

---

## 四、这条闭环证明不了什么（诚实清单）

**能证明**：逻辑、契约、失败关闭行为、桌面↔云接缝、云端状态机、语料闸门。
**证明不了**（只能靠真跑）：

| 缺口 | 为什么测不到 | 谁来补 |
| --- | --- | --- |
| 真群任务**是否真的产生** `task_events.payload_json.plan` | 需要 Codex app-server 真跑一轮 turn | 真装后跑 1 个群任务 |
| 桌面**是否真的建出** `collaboration_graph_*` 四张表 | 需要 Electron 应用启动时跑迁移 | 真装后首次启动 |
| `planExecDrift.record` **是否真的在终态触发** | 需要 scheduler 真把任务跑到终态 | 真装后跑 1 个群任务 |
| 云端 `/api/rdmd` **桌面能否连上** | 服务器当前绑 `127.0.0.1`，外部不可达 | 改绑定或加隧道（运维） |
| 影子观测**能否累积到** `SHADOW_MIN_OBSERVATIONS=30` | 需要真实多轮任务 | 长期真跑 |

三种补法，按代价排序：

1. **真装**（你要避开的）——一次装、跑两个群任务，上面五项一次补齐。
2. **无头 harness**（要新增脚本，本轮不改）——用 `src/main/db.js` 开真库 + 灌一条带
   `activityType='plan'` 的合成 `task_events` + 调 store 投影与 `planExecDriftService.record`，
   断言诊断事件落库。第 2 层的 shadow 套件已经跑通了 90% 的路径，只差"合成 plan 事件"这一段。
3. **让别人装**——把第 5 层与第四节第一项的判据交给有环境的人跑。

---

## 五、审查发现（只记录，本轮不改）

按严重度：

| 级别 | 位置 | 问题 |
| --- | --- | --- |
| **高** | `cloud/src/modules/rdmd/index.mjs` `recordVerdict` | 只按 job id 查，**不校验属主**；任何持 `rdmd:infer` 的设备可给任意作业回传判定。与迁移 `097` 注释自称的交叉校验**矛盾**（`read` 有属主范围，只有 verdict 漏了） |
| **高** | 未被 git 跟踪、也未被 ignore | `scripts/tdb_completion.py`（被 `train_qlora_rdmd.py` 导入 → 干净克隆**训练器跑不起来**）、`src/shared/contracts/uBuddyTaskPublicMemory.js`（契约集成员）、3 份 recon 文档。干净克隆会**静默丢失** |
| 中 | `cloud/src/modules/rdmd/index.mjs` | `running` / `failed_retryable` 被 schema 允许但代码**从不写入**；`151–153` 注释描述的退避机制**不存在** |
| 中 | `cloud/database/migrations/097_rdmd_inference_jobs.sql` | **无任何 GRANT**（`094` 有），应用角色可能不可达 |
| 低 | `cloud/src/modules/organizationEvolution.mjs:4` | `UBUDDY_ORG_PLAYBOOK_VERSION` 死导入 |

这些都不影响本轮的测试闭环，但**属于应该在真上线前处理**的项。

---

## 六、仍然只能人做的三件事

1. 决定**云端那半的落脚点**：`123.207.22.235`（发布/同步服务器）还是独立地址。
   现状 `RDMD_CLOUD_URL` 是"只判断不路由"的半成品，**改它不影响提交目标**。
2. 若要走真装路线：准备一个**与官方 Janus Test 数据隔离**的实例
   （`JANUS_HOME` 指向 D 盘目录，不设任何 `JANUS_*` 更新/分发环境变量）。
3. 给 GPU 盒做一次**异地备份**：v4 适配器、worker、实验云库目前只在那台机器上。

---

## 七、一页速查

```
不装任何东西，先跑这 9 条（第 0–3 层）：
  npm run cloud:test:hygiene
  npm run cloud:test:rdmd-transport
  npm run cloud:test:rdmd-shadow
  npm run cloud:test:rdmd
  npm run cloud:test:collaboration-research
  npm run cloud:test:organization-evolution
  npm run experiment:rdmd-worker:test
  npm run experiment:rdmd-acceptance:test
  npm run experiment:rdmd-chain-to-dag:test

再加语料闸门（第 4 层）：
  npm run experiment:rdmd-ood:gate          # 0 过 / 1 失败 / 3 未测

退出码速记：
  acceptance.py        0 可用 / 1 不可用 / 2 数据不足 / 3 未测
  ood gate             0 全过 / 1 闸门失败 / 3 未测
  acceptance:real      3 = 本机没语料（未测，不是错）

前提：node_modules 已就绪（已核实）；data/ 与 sft/ 的 *.jsonl 被 gitignore，
      第 4 层的 real 变体需要先 generate.mjs → prepare_sft.mjs。
```
