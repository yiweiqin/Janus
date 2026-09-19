# uBuddy V4 自动闭环实证（2026-09-19）

> 这一页是**给外部判读用的一页**：一轮真跑在远程盒子上的闭包，数字是什么、在哪一步验的、
> 以及**哪些数字不能当证据用**。所有数字都出自可复跑的产物，不是手抄的。
>
> 配套：[卡点核查基线](ubuddy-v4-blocker-audit.zh-CN.md)、[TPM 合约](ubuddy-v4-tpm-contract.zh-CN.md)、
> [CPDB 协议](ubuddy-v4-cpdb-protocol.zh-CN.md)、[RDMD 协议](ubuddy-v4-rdmd-protocol.zh-CN.md)。

## 0. 一句话

**一条命令**（`npm run experiment:sim-group:remote -- --adapter … --limit 16`）在远程盒子
bjb1 上跑完「模拟任务群 → 写协作图 → 提交 `/api/rdmd/jobs` → GPU worker 判定 → 回收算指标 →
TPM 原始层申请链」，**零人工**。本轮的闸门结论：**176/176 到终态，鉴权被拒 0，账目孤儿 0。**

这一轮的作用是**证明链路成立并且量级可比**，不是证明 v4 已经超过规则基线（见 §7）。

---

## 1. 这一轮跑的是什么

| 项 | 值 | 出处 |
| --- | --- | --- |
| 入口 | `python scripts/sim_remote_run.py --adapter /root/autodl-tmp/rdmd_runs/qlora-v4/adapter --limit 16` | `scripts/sim_remote_run.py` |
| 盒子脚本 | `experiments/sim_task_group/run_remote.sh`（8 步，全绿） | `experiments/sim_task_group/out/remote/run_remote.stdout.log` |
| 批次 | 16 个 brief → **176 条 case**（11 类 × 16） | `out/remote/out/report.json` |
| 生成模式 | `offline`（确定性，不调模型；密钥不必注入） | 同上 |
| 模拟耗时 | 47 分 45 秒（22:12:49 → 23:00:34） | 驱动日志 |
| 实际吞吐 | ≈ 3.7 条/分钟（单卡，v4 adapter） | 台账查询 |
| 云侧迁移头 | `099_ubuddy_task_public_memory.sql` | step 3 `migrationHead=` |
| worker 权重 | `82855e1ea12723b7…` | step 4 |
| worker 源码 | `5e145cb6d13a99f1…` | step 4（自报，见 §9.2） |

八个步骤各自的结论（这是**闸门**，不是日志）：

| 步 | 验的是什么 | 结论 |
| --- | --- | --- |
| 1 | bundle 不带 `node_modules` 也能解析 | `ok pg` |
| 2 | 云 API 幂等重启（确保后端就是这一份） | ok |
| 3 | `/readyz` + `/api/rdmd` 路由存在（未认证被拒） | `database.ready=true`、路由在 |
| 4 | worker 权重与**源码**都正是要的那份 | 两个 sha 一致 |
| 4.5 | 将要跑的 worker 回传协议带 `workerId` | ok（见 §9.1） |
| 5 | 生成模拟任务群 | 176 case |
| 6 | 写图 + 提交 | `submitted 176 / stored 176`，`skippedEdgeTotal 0`，越界字段 0 |
| 6.5 | TPM 原始层申请链 | `SIM_TPM_OK`（见 §4） |
| 7 | 回收 + 算指标 + 终态闸 + 鉴权闸 | 176/176 终态，鉴权被拒 0 |
| 8 | 打包回收 | `report_tar_bytes=205232` |

---

## 2. 闸门：先把「没量到」和「量错了」分开

| 字段 | 值 | 它防的是什么 |
| --- | --- | --- |
| `expected` | 176 | 提交端承诺的条数 |
| `scored` | 176 | 真进了分母的条数 |
| `notTerminal` | **0** | 「没回来的作业」被当成「对了的作业」 |
| `authRejected` | **0** | 采集端 token 中途过期，导致整批看起来像模型不行 |
| `orphanJobs` | **0** | 提交端有、生成端没有 = 账对不上 |

`authRejected` 是本轮**新加**的一类，理由很具体：`collect` 逐条轮询到终态，整批耗时由队列长度决定
（实测 1300 条要 ~4.8 小时），而 `run_remote.sh` 原来签的 token 只有 1 小时。于是后半批全部 401、
堆成 `notTerminal` —— 报告读起来像"模型/作业不行"，真相是采集端自己掉线了。现在 token TTL 默认
**21600s（6h）**，并且 401/403 **单独计数**、非零时 `run_remote.sh` 直接判这一轮报告不可信。

---

## 3. 结果：模型 vs 规则侦探（**同一批 case**）

模型 = 盒子上的 v4 adapter。规则基线 = 我们自己的 `detectMinimalDrift`，在**同一批** case 上跑。

| 指标 | 模型 | 规则基线 | 说明 |
| --- | --- | --- | --- |
| `nodeTop1`（定位命中） | **0.9792** | **0** | 规则在 step 层与 subtle 层明显掉 —— 那正是模型该赢的地方 |
| `typeTop1`（类型命中） | **0.9861** | 0.0417 | |
| `both`（定位+类型都对） | **0.9722** | — | |
| `abstainRate`（弃权） | **0** | 0.5833 | |
| `noDriftAccuracy` | 1 | — | **平凡可分，别当能力证据**，见 §7 |
| `noDriftFalsePositiveRate` | 0 | 0 | |
| `multiInjectAbstainRate` | **1** | 0.6875 | 双注入**只评 `UNKNOWN`**；模型全弃权 = 对 |

分层与可见性（同批）：

| 切片 | n | 定位 Top-1 | 类型 Top-1 | 全对 |
| --- | --- | --- | --- | --- |
| `agent_task` 层 | 80 | **1.0000** | 0.9875 | 0.9875 |
| `agent_step` 层 | 64 | 0.9531 | 0.9844 | 0.9531 |
| `visible` | 84 | 0.9643 | 0.9881 | 0.9643 |
| `subtle` | 60 | **1.0000** | 0.9833 | 0.9833 |

按 gold 类型：`wrong_agent` 48/48 全对；`wrong_version` 32/32 定位全对；`missing_dependency`
29/32；`wrong_acceptance` 与 `local_replan` 各 16/16。

规则基线的两个诊断数（**必须一起看**）：`ruleHitWithDecoys = 0`、
`ruleHitWithoutDecoys = 0.7778`、`unreachableEvenWithoutDecoys = 32`（**全部是 subtle**）。
decoy 是训练装置，真实投影图里没有；所以「模型赢了多少」里有一部分来自抗 decoy，有一部分来自读富文本。
**这两个数分开看才知道是哪一种。**

过 `routeEvolution` 的动作分布（`src/shared/contracts/uBuddyReverseDetective.js`）：

| 动作 | 模型 | 规则基线 |
| --- | --- | --- |
| `minimal_plan_edit` | 95 | 65 |
| `similar_swap` | 48 | 0 |
| `record_only` | 33 | 111 |

**`similar_swap` 只会从模型侧出现**（48 条）—— 规则侦探给不出"换一个能力最相近的 agent"这个动作。
这是方案二（能力画像 → 相似度 → 最小能力改动实验）在闭环里第一次真的产生动作。

---

## 4. TPM 原始层：申请链在真库上走通

`store.mjs` 把 G_plan/G_exec 写成基础层；省检摘要写成提升层；原始层**默认不可见，必须申请**。
每个 case 走三次申请，三种结局都被真的走到（3 个 case × 3 条 = `tpm_report.json`）：

| 申请 | 结局 | 谁判的 |
| --- | --- | --- |
| `…_ok` | `granted` | AI 预审过 → Owner 终审过 |
| `…_nopurpose` | `rejected_by_ai` | AI 预审拦下（`empty_node_window` 一类） |
| `…_ungrounded` | `denied_by_owner` | AI 放行、**人**拦下 |

审计流水（`cloud_work_memory_access_audits`）的结果码计数：
`raw_requires_grant 6 / granted 4 / revoked 1 / rejected_by_ai 1 / denied_by_owner 1`
—— 其中 `raw_requires_grant` 6 条正是「没授权就想读原始层被拒」，证明**默认关闭**是真的默认关闭。

图交叉核对：申请窗口里的每个 nodeId 都在协作图里，**24/24**（不是抽样，是全量）。

表结构见 `cloud/database/migrations/099_ubuddy_task_public_memory.sql`，
服务层 `cloud/src/modules/tpm/index.mjs`，纯函数状态机 `src/shared/contracts/uBuddyTaskPublicMemory.js`。
**申请与授权分两张表**、**不复用审计表存状态**，理由写在迁移的注释里。

---

## 5. 无头内核：去掉 Electron，我们自己的链一样成立

`npm run experiment:rdmd-headless-core`（纯 Node，真迁移 + 真投影 + 真读回 + 真 `record()`，
一处替身都不留），在**空库**上从零跑：

| 断言 | 结论 |
| --- | --- |
| `A6` 重复投影是幂等的 | 0 节点 0 边，图不变 |
| `A1` 四层投影 | kinds `root/agent_task/agent_step`；edges `parent_of/assigned_to/sequence_of/dependency_of` |
| `A2` 读回两张图 | plan 6 节点 / exec 8 节点 |
| `A2b` 两图**确实不同** | exec 里有 `cancelled` 的步，plan 里没有 |
| `A3` `record.status !== 'no_graph'` | `contract_gap` |
| `A4` 漂移事件真的落进 `task_events` | `rdmd_plan_exec:rdmd_headless_run_1`，1 条 |
| `A4b` 原始列与 API 一致 | 都是 `shadow` |
| `A5` `record()` **不改图** | 前后行数完全相同 |

为什么要有这一条：`planExecDrift.record` 在生产里由 `src/main/runtime.js` 在
`completed/failed/cancelled` 时触发，而它在 Electron 里。无头内核证明这条链**不依赖 Electron**，
而且 `record()` 本身并不要求终态 —— 只有 `runtime.js` 那样调。

---

## 6. CPDB 导出包（给外部 AI/人重判能力分）

产物：`experiments/cpdb_org_world/export/ai-judge-v1/`（`BUNDLE.json` 里逐文件 sha256 + 行数）。
入口 `npm run experiment:cpdb-export`，回收 `npm run experiment:cpdb-import`。

| 项 | 值 |
| --- | --- |
| pair / card | 8282 / 8282 |
| 盲标 test | **799**（teacher 分与模型基线分**都不在包里**） |
| train+dev | 7483（可带 teacher 参考分） |
| 切分 | train 6705 / development 778 / test 799 |
| twin | 2640 对（**不要承诺 `facet_twin`**，那个 kind 实际从不产生） |
| 试标行 | 17 行单列（`reference/trial_excluded.jsonl`），不属于 full gold |

三条必须照做的规则（写在 `TASK.json` 与 `schema/label_row.schema.json` 里）：

1. **两轴独立打分**，`dependency` 与 `similarity` 各自落在 `[0, 0.25, 0.5, 0.75, 1]`，
   **禁止合成一个总分**（`combined` 键连出现都不要出现）。
2. **`status` 不是输入，是派生量**（`single/agreed/needs_adjudication/adjudicated`），不要填。
3. 每个 pair 出**两份独立判断**（不同 `reviewerId`、互不可见）+ **第三份只裁分歧**，
   这样零人工也能产出金标。`reviewerId` 不得以 `prelabel` 开头。

---

## 7. 这一轮**不要**声称什么

- **不声称 v4 超过规则基线。** 两边都远高于随机，但这批 case 是**模拟**出来的；
  `nodeTop1 0.98` 与 `ruleHitWithoutDecoys 0.78` 的差距有多少来自"读富文本"、
  多少来自"抗 decoy"，还没有拆开。
- **`no_driftAccuracy = 1` 不是能力证据。** `no_drift` 样本的 `G_prime` 与 `G_star`
  **逐字节相等**（实测），任何"永远说没漂移"的判定都能拿满分。它只能当"链路没坏"的烟雾测试。
- **「影子提案」这一轮测不出东西。** 相近度阈值 0.8 是为真实漂移量标定的，而单点注入只占约
  3–5% 加权质量，所以 `minimalPlanEdits` **恒报 `alreadySatisfied`（176/176）**。
  这不是 bug，是**这一批数据的分辨率不够**；要它测得动，得让漂移的量级上去。
- **模拟任务群出的判定不是真实用户任务**，只证明链路成立与量级可比。
- **不声称生产云可用。** 生产云 `123.207.22.235` 跑的是旧 bundle（`/api/rdmd` 返 404），
  本轮完全不依赖它。
- **不声称外部 AI 的判分等同人工金标。** 会按 `labelSource` 分开报，
  并给 AI 内部一致性（3 份之间 κ）。

---

## 8. 怎么复现

```bash
# 整轮（在盒子上，零人工）
npm run experiment:sim-group:remote -- --adapter /root/autodl-tmp/rdmd_runs/qlora-v4/adapter --limit 16

# 不碰 GPU、只验链路（判定恒为 UNKNOWN）
npm run experiment:sim-group:remote:dry

# 本地不联网的部分
npm run experiment:sim-group:test      # 协议/生成/写库/提交/回收/TPM/bundle 七个套件
npm run experiment:rdmd-headless-core  # 无头内核
npm run experiment:cpdb-export         # CPDB 判分包
```

产物落点：`experiments/sim_task_group/out/remote/out/`（`collect_report.json` 是指标、
`collect_rows.jsonl` 是逐条明细、`tpm_report.json` 是 TPM 链路、`jobs.jsonl` 是提交台账）。

**批次规模要用 `--limit` 控制**，因为采集是逐条轮询：`--limit 16` ≈ 176 条 ≈ 48 分钟。
一次不限量跑是 1314 条 ≈ 4.8 小时。

---

## 9. 这一轮修掉的、**只在盒子上才现形**的问题

本地全绿、上传后才炸 —— 这三条的共性都是「报告看起来像是模型不行」。

### 9.1 云要求回传带 `workerId`，盒子上的 worker 没带（烧掉一整轮）

云侧 `recordVerdict` 现在要求回传带 `workerId`（否则任何一个 `rdmd:infer` grant 都能终结
**别人**在飞的作业）。但 worker 是**另一份部署**：只改云、不重推 worker，症状不是启动失败，而是
每条作业被 400 `rdmd_worker_id_required` 拒收 → 领活 → 重试 → `rdmd_attempts_exhausted`。
**实测 22 条 failed_terminal 全部如此**，而报告里只有一堆弃权/失败。

现在 `run_remote.sh` 的 step 4.5 会检查**将要跑的那份源码**里 `/verdict` POST 之后 25 行内有没有
`workerId` —— 只近不远，免得被文件里别处的 `workerId`（领活那次也带）误判成通过。

### 9.2 「文件更新了」不等于「跑的是新代码」

常驻进程把源码读进内存之后，磁盘上再新也不生效，而 `_rdmd_worker_daemon.sh start` 见到 pidfile
活着就返回"已在运行"。**sha 一致只说明「跑的就是磁盘上这份」，不说明「磁盘上这份是对的版本」**。

所以 worker 现在**自报** `worker_source_sha256`（由**运行中的那个进程**算，不是靠谁记得去看
mtime），`status` 把它打出来，`run_remote.sh` 发现与将要跑的那份不一致就**自动重启**；
"完全没有自报"同样按旧代码处理。

### 9.3 采集用的 token 活不到整批排空

见 §2。这条的危害是**报告会更可信地撒谎**：401 被并进通用 `http_error` 之后，
一整批 `notTerminal` 读起来像"作业没跑完"，而不是"采集端自己掉线了"。

---

## 10. 版本与出处

本轮的全部代码、契约、迁移、文档与实验轨道已进版本库并推到 `origin/main`
（`c4907e2`、`cf0dc49`、`c7e483b`、`2cc3e3c` 四个提交）。派生语料（CPDB 的
`annotation_cards.jsonl` / `pairs.jsonl` / `export/`）按 `.gitignore` 里的规则**不入库**，
理由与再生成方式写在 `.gitignore` 的注释里；**人工标注 `human_labels.jsonl` 入库**
（它是标注，不是派生量，丢了不可重建）。
