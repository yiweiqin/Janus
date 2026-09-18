# RDMD v4 全量数据集报告（P3 重训 + 扩展验收）

本文是 P3 的交付物：v4 权重的验收结论、与 v3 的对照、以及**这份结论判的是谁**（出处）。
计划要求的「产出 `acceptance.json` 与 v3 的对照表」在这里成形。

为什么要有这份文档而不是只留 `acceptance.json`：评测产物目录 `experiments/rdmd_runs/`
在 [`.gitignore:13`](../../.gitignore) 里，**整个目录都不进版本控制**。所以写在那里的
任何东西都是临时证据 —— v4 与 v3 的对照表此前就只活在 `%TEMP%` 的一个日志里。
本文写在数据集目录（未跟踪但**未**被忽略，会随提交进入版本控制），与
[`V3_FULL_REPORT.zh-CN.md`](V3_FULL_REPORT.zh-CN.md) 同规格。

---

## 1. 结论

**`VERDICT: USABLE`，8 项门槛全过，`rdmd_acceptance.py` 退出码 0。**

v4 相对 v3 的全部改动，是**拿 step 层的表达能力去换训练分布与生产一致**。两条为此新增的
验收项都达标，而且证据显示模型没有走捷径：

| 新增项 | 值 | 门槛 | 这一项在回答什么 |
|---|---|---|---|
| `step_layer_node` | 0.9859 | 0.90 | 契约把 step 层收窄到 `title`+`status` 之后，这一层**没被砍废** |
| `status_shortcut`（差） | 0.7994 | 0.25 | 模型**不是**只学会了读新放进 prompt 的 `status` |

`status_shortcut` 那一项值得单独说：在同样的 1411 行上，**只看 `status`** 的确定性规则
Top-1 只有 **0.1999**，模型是 **0.9993**。差距 0.7994 就是这个差值 —— 它的意义不是"模型比
规则强"，而是"语料没有把答案泄露给一条读 `status` 的捷径"（语料侧另有一条同规格守卫，
见 §6）。

---

## 2. 训练事实与出处

| 项 | 值 |
|---|---|
| run tag | `qlora-v4` |
| 步数 | 1074（`globalStep`） |
| 用时 | 57,925 s ≈ **16h 05m**（训 16h05m + 训内开发集评测 25m22s） |
| `train_loss` | 0.02962 |
| `bestDevelopmentLoss` | 0.0007100011571310461 |
| 行数 | train 8,590 / development 1,745 |
| 基座 | `/root/autodl-tmp/models/Qwen3-8B` |
| 契约版本 | `ubuddy_plan_exec_v2` |
| adapter sha256 | `82855e1ea12723b71ebe1672b8e76e5f84005db5680c50cf56e4677490fbdd34` |
| adapter 字节数 | 174,655,536 |

**第一次起训被丢弃并重建。** 原因是出处错误而非训练失败：v4 语料当时仍自称
`rdmd_detective_sft_v3` —— `schema.json` 与 `lib/sft.mjs#SFT_SCHEMA` 的版本号忘了跟着升。
这种错比明着报错更难查：**adapter 是真的、出处是假的**，跑完 16 小时才发现验收表会把
「v4 的分数」记在 v3 的名下。修法是把两处版本号升到 v4，并确认**数据行 sha256 逐字节未变、
仅 manifest 升版**，然后重新上传起训。

这也正是本轮要补出处绑定的原因：同一个病，在验收环节原样存在过一次（见 §5）。

---

## 3. 验收门：8 项

来自 [`scripts/rdmd_acceptance.py`](../../scripts/rdmd_acceptance.py)，锚点是
[`V3_FULL_REPORT.zh-CN.md`](V3_FULL_REPORT.zh-CN.md) §3/§6 里量到的基线。

| # | 项 | split | n | 值 | 门槛 | 判定 |
|---|---|---|---|---|---|---|
| 1 | 定位（nodeId Top-1） | test | 1412 | 0.9986 | 0.95 | PASS |
| 2 | 类型（type Top-1） | test | 1412 | 0.9993 | 0.60 | PASS |
| 3 | UNKNOWN 弃权率 | eval_unknown | 142 | 0.9930 | 0.80 | PASS |
| 4 | no_drift 正确率 | eval_no_drift | 111 | 1.0000 | 0.95 | PASS |
| 5 | 无原因字段子集定位 | test | 676 | 0.9970 | 0.90 | PASS |
| 6 | **真凶在 step 层的定位** | test | 142 | 0.9859 | 0.90 | PASS |
| 7 | **模型 − 只看 status 的捷径** | test | 1411 | 0.7994 | 0.25 | PASS |
| 8 | 最差 split 解析错误率 | all | 0 | 0.0000 | 0.02 | PASS |

第 1 项的 `why` 里写着一条必须记住的上限：规则 D/E 在本地化上是 **1.0000**，模型最多只是
打平。**这个模型的正当性来自「不写图算法、只读文本」的部署形态，不是精度。**

---

## 4. v3 ↔ v4 对照，以及为什么不能当等号读

```
criterion                              qlora-v3     qlora-v4     delta
------------------------------------------------------------------------
test 定位（nodeId Top-1）                   0.9993       0.9986   -0.0007
test 类型（type Top-1）                     0.9979       0.9993   +0.0014
UNKNOWN 弃权率                             1.0000       0.9930   -0.0070
no_drift 正确率                            1.0000       1.0000   +0.0000
test 无原因字段子集定位                      0.9985       0.9970   -0.0015
test 真凶在 step 层的定位                       n/a       0.9859       new
test 模型 − 只看 status 的捷径（差）              n/a       0.7994       new
最后 split 解析错误率                        0.0000       0.0000   +0.0000
```

**两条 `new` 项不是漏测，是两侧无从对比：**

- `step_layer_node` —— v3 的 step 节点还带着富文本（`artifact`/`output`/`summary`），
  量的是另一件事；v4 的 step 层只剩 `title`+`status`。
- `status_shortcut` —— `status` 在 v3 的 prompt 里根本不存在（`schema.json` 当时把它列为禁键）。

**读法限制（重要）：**

1. 两版的语料版本不同（v3 vs v4），**split 规模也不同**：v3 的 test 是 1427 行、
   `eval_unknown` 226 行；v4 是 1412 与 142。所以分母不是同一批行。
2. 因此 `primary_derived_only`（无原因字段子集）这类比值**只能看量级，不能当等号读**。
3. 降幅本身（定位 −0.0007、弃权 −0.0070）在换分布的代价里属于预期范围；弃权率从
   1.0000 掉到 0.9930 是 v4 唯一一处实质下降，142 行里多了 1 行没弃权。

一句话：**v4 没有变强，它是变"对"** —— 训练分布从「step 层字段填满」改成真实数据里
step 节点实际有的字段，代价是几个千分点的指标。

---

## 5. 出处（provenance）：本轮新增

### 5.1 补上的洞

在这之前，`acceptance.json` 只写 `evalDir: .../eval-qlora-v4` —— 也就是说
**「这份 USABLE 判的是哪一份权重」只能靠目录名反推**。换个目录、或在同一目录里重跑一次，
结论就和权重脱钩了。而项目在 P4 云侧早已立了硬规矩：判定必须带 `adapter_sha256` /
契约版本 / 规则版本，云侧 `normalizeProvenance` 连 `'unknown'` 占位符都拒收。
**唯独这份唯一的 go/no-go 证据没有出处。**

现在有了，而且在**起 shard 之前**就落盘：`_rdmd_remote_eval_splits.sh` 会检查一次性标记
`$OUT/.eval_manifest.ready`，没有就硬停（exit 4）。理由很直接：等三个小时跑完再发现判决书
无法归属，代价是重跑；在起跑前停，代价是零。

### 5.2 本次 v4 的出处

| 项 | 值 |
|---|---|
| `source` | **`backfill`**（事后补记，见 §5.3） |
| adapter sha256 | `82855e1ea12723b71ebe1672b8e76e5f84005db5680c50cf56e4677490fbdd34` |
| base model | `/root/autodl-tmp/models/Qwen3-8B` |
| SFT schemaVersion | `rdmd_detective_sft_v4` |
| SFT sourceVersion | `rdmd_detective_dataset_v4` |
| SFT manifest sha256 | `286ea66cf46b866804b5dd7a1b7a79c60b183ce1f7ba5c104c3d82e98f655711` |
| 标签核对（4/4） | development / eval_no_drift / eval_unknown / test **全部 `match: true`** |
| `mergedTotal` | 3663（= 1665+142+111+1745，与 `merged.predictions.jsonl` 实际行数交叉核对一致） |
| evaluator sha256 | `6aa0c83d8bdd8ad6ea49fec5c407ee9af5a5652e5ae58c1b2f7f615d90e933d6` |

### 5.3 为什么是 backfill，以及它的证据力弱在哪

v4 评测跑在出处机制**落地之前**，所以起跑时没有写 manifest。补记调的是**起跑路径同一个
脚本**（`_rdmd_remote_eval_manifest.sh`），只把 `source` 标成 `backfill`。
算出处只允许有一处定义 —— 两份实现各自演化，就是这一轮要治的病本身。

**诚实记录效力差异**：launch 是「我在读这批文件、正要评测它们」时记的；backfill 是
「事后我去看磁盘上现在是什么」记的。两者能证明的东西不同，所以不冒充：`source=backfill`
会一路带进 `acceptance.json`，打印时明说「证据力弱于 launch」。

补记能拿到的最强交叉证据是**标签哈希逐 split 对上了**：manifest 记的是评测机当时读的那批，
本地这份 `sft/*.jsonl` 的 sha256 与之逐字节相同（`labelIntegrityOk: true`）。这说明
**从那批标签到这份报告之间，没有东西被改过**；它**不能**证明起跑那一刻磁盘上是什么 ——
那正是 launch 才有的能力。

### 5.4 evaluator 版本的坑（记录在案）

`evaluator.sha256` 记的是**评测机上**那份 `scripts/eval_rdmd_qlora.py`，与仓库里那份
**原始 sha 不同**：

```
box  （已经跑过 v3 与 v4）: 6aa0c83d8bdd8ad6ea49fec5c407ee9af5a5652e5ae58c1b2f7f615d90e933d6
repo （本地这份）          : 7eff7b20e0a222a3cd6c58caff0c002fb3e40a9bf648c46d60636263ae343d40
```

**差的是一个 UTF-8 BOM，逻辑逐字节相同**（BOM+CRLF 归一化后两份 sha 完全一致）。
两条结论：

1. v3 与 v4 是**同一个 evaluator** 评的，所以 §4 的对照表内部可比。
2. 但 BOM 会让 sha 不同 —— 拿 manifest 的 sha 去和仓库文件直接比会**误报**。要给
   `eval_rdmd_qlora.py` 做一致性判断，必须先归一再比。这是本项目反复出现的 BOM 问题
   在出处上的一个新表现。

---

## 6. 语料 v4 的守卫（P2 的验收，在此备案）

来源 [`data/validation.json`](data/validation.json)，阈值同为 0.35：

| 守卫 | 值 | 开火率 | 判定 |
|---|---|---|---|
| `lowestIdNodeTop1`（最小 id 规则） | 0.215 | — | ok |
| `statusOnlyTop1`（只看 status 的规则） | 0.1872 | `statusOnlyFired = 0.0891` | ok |

`statusOnlyFired` 必须单独报：它低的时候 Top-1 也没有说服力（规则会退回按最小 id 挑），
不报这个数，守卫就是一句自我安慰。

语料规模：drift 10,000 / no_drift 1,000 / UNKNOWN 1,000；split train 8,590 /
development 1,745 / test 1,665；图族 `flat_work_units` 6,025 / `layered_group` 5,975；
`graphs` 1,537；`rejected` 0；`validate.pass = true`。

step 层的能力边界（真实记录，不是估计）：`agent_step` 只能**独立表达** 3 种漂移
（`missing_dependency` / `local_replan` / `wrong_version`），`wrong_agent` 只能作为**后果**
出现（step 的 `agentId` 继承自父 `agent_task`），`wrong_acceptance` **完全不可表达**。
理由写在 [`PLAN_EXEC_TRUTH.zh-CN.md`](ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md) §8.2。

---

## 7. 复现

```powershell
# 验收门（读评测产物 + 原始 case + 对照基线）
python scripts/rdmd_acceptance.py --eval-dir experiments/rdmd_runs/eval-qlora-v4 `
  --run-tag qlora-v4 --compare-tag qlora-v3 `
  --data-dir experiments/rdmd_detective_dataset/data

# 验收门自身的测试（含 v2 负对照与三条例外路径）
python scripts/test_rdmd_acceptance.py

# 补一份出处（只有评测产物早于出处机制时才需要）
python scripts/_rdmd_backfill_eval_manifest.py --run-tag qlora-v4
```

一次性产物在各评测目录下（`experiments/rdmd_runs/` 被忽略，仅作本地复核）：
`acceptance.json`、`comparison.txt`、`eval_manifest.json`、`merged.predictions.jsonl`、
`summary.json`、四份 `*.report.json`。

---

## 8. 已知边界

- **本报告只谈离线验收**。v4 权重是否真的在生产推理里生效，是另一件事 —— 常驻 GPU worker
  的 adapter 由环境变量钉住，切换有独立的真机验收门。**离线 USABLE 不等于线上在用。**
  → 该门已于 §9 跑过并通过；§9 之后的结论是「v4 已在常驻 worker 上生效」。
- **第 1 项的定位维度只是打平确定性基线**，不是超越。见 §3。
- **step 层只有 3/5 种漂移能独立表达**，其余两条是显式例外。见 §6。
- **`primary_derived_only` 等比值跨版本不可当等号读**，分母不是同一批行。见 §4。
- 评测覆盖 `test` / `eval_unknown` / `eval_no_drift` / `development` 四个 split，
  **不覆盖** OOD 与对抗集（`ood.jsonl` / `adversarial.jsonl` 另有脚本）。

---

## 9. 真机切换门：v4 在常驻 worker 上生效（2026-09-19）

§1–§8 全部是**离线**事实。这一节是唯一回答「线上喂的是哪版权重」的证据，因为它读的是
真实云 API + 真实 Postgres + 真实 GPU 上跑出来的**作业行**，而不是评测产物。

### 9.1 切换前的状态（这是本门存在的理由）

活体常驻 worker 钉在 `qlora-v3`（`adapter_sha256=c5193c7c…`），而 v3 是三代里最不该上线的那一版
（它在「step 层字段填满」的旧形状上训练，对真实数据里空字段的 step 节点最不匹配）。
也就是说：**P1/P2/P3 对生产推理一直零影响**，直到本门跑过。

而且当时 `start` 只打印 `started pid=… device=…`，**不打印起了哪个 adapter** ——
判定照样 `completed`、出处照样齐全、形状照样合法，**只有 sha 不一样**。

### 9.2 一次性门（先验证，再常驻）

顺序：停 v3 daemon → `STAGE=submit` 放一条真实作业 → 用 **v4 + `cuda:0`** 跑一次
`_rdmd_run_worker_once.sh`（`--once`）→ `STAGE=verify` 核对。

作业 `rdmdjob_37edad7d-7efa-4d31-9107-d668bdbf1139`（夹具漂移形状 `wrong_agent`，gold = `n_step`）：

| 检查 | 结果 |
| --- | --- |
| 契约预检 `predict.py --dry-run` | `dry_run_exit=0`（不再有 `input_contract_violation`） |
| 作业终态 | `completed`，`error_code` 为空 |
| `adapter_sha256` | `82855e1ea12723b71ebe1672b8e76e5f84005db5680c50cf56e4677490fbdd34` = **v4** |
| `base_model_id` / `contract_version` / `rule_version` | `…/models/Qwen3-8B` / `ubuddy_plan_exec_v2` / `rdmd_cloud_jobs_v1` |
| 判定 | `{"status":"drift","nodeId":"n_step","type":"wrong_agent"}` —— **gold 全中** |
| `reason` | 空（**不是** `input_contract_violation`） |
| grant scope | 仅 `["rdmd:infer"]` |
| 隐私白名单 | 落库字段仅 `["G_prime","G_star","id"]`；`private_assistant` 与未知会话类型均 `not_eligible` |

### 9.3 门本身也要能被证伪

「判定带 v4 的 sha」如果只靠人看日志，那它和当年「常量悄悄指向 v3」是同一种证据力。
所以给 verify 加了 `--expect-adapter`，并做了负对照：

| 断言 | 期望 v3 sha | 期望 v4 sha |
| --- | --- | --- |
| 退出码 | `1`（`E2E_FAILED`，`期望 c5193c7c… 实际 82855e1e…`） | `0`（`E2E_OK`，`[ok] adapter 出处核对`） |

**这个过程本身抓到一个真问题**：第一次跑负对照时它**通过了** —— 本该失败。原因是
`rdmd_cloud_e2e.mjs` 在盒子上是从 `/root/Janus/scripts/` 的**副本**执行的（不像 `.sh` 走
`bash -s` 管道用本地副本），本地改完不部署等于没改。部署（`rdmd_cloud_deploy.py`，114/114
文件 hash 逐一比对）之后负对照才如预期失败。**「本地改了」不等于「跑的是我改的那份」。**

### 9.4 daemon：去掉静默兜底

- `_rdmd_worker_daemon.sh` 的 `ADAPTER="${RDMD_ADAPTER:-…/qlora-v3/adapter}"` 已删除：
  未设 `RDMD_ADAPTER` 时 **`exit 1`**，并列出盒上现有的 adapter 与一条完整示例。
  该校验只作用于 `start` —— `status`/`log`/`stop` 正是在「我不确定现在跑的是什么」时才要用的，
  它们若也要求先给 adapter，就是在最需要答案的时候把人挡在门外（这个过度拦截是改完当场发现的）。
- `start` 现在打印 `adapter=`、`adapter_sha256=前16位 (与上次相同/不同)`、`worker_id=`（**实际生效值**，
  凭据文件里已钉了一个，它把「哪份 device grant」与「哪个 worker 身份」配对，不该被设备名覆盖）。
- `status` 从 **worker 自己的日志**里读回 sha，分别打印 `adapter(running)` 与 `adapter(last start)`；
  两者不一致才告警。第一版直接比整串，而 worker 只往日志写前 16 位、落盘文件是 64 位，
  于是**每跑一次都喊一个不存在的告警** —— 一个总是响的告警等于没有告警。现已按前 16 位比对，
  并用「往落盘文件里植一个 v3 的 sha」验证过告警真的会响。
- 以 v4 + `cuda:0` 重启常驻，`RDMD_DEVICE` 默认从 `cuda:1` 改为 `cuda:0`（训练已结束，三卡空闲）。

### 9.5 无人值守自清队列（非空队列上验的）

`_rdmd_worker_autopull_check.sh` 前两版都栽在「把没事可做说成事情做完了」上：第一版在**空队列**上
等 `PENDING==0`，一开始就是 0，循环立刻 break，然后打印 OK；第二版要求「开始时就真的有活」，
方向对了，但在活体 worker 面前会误报 —— 人从开发机提交作业再跑检查，中间隔着几十秒，
worker 早就干完了（实测就是这么失败的）。

现在这条检查**自己往队列里放一条真实作业**、记下 jobId，然后除了等待不再动手：

```
注入的作业 jobId=rdmdjob_b1bb0cf5-e19d-45d6-acb1-863c99d54601
rdmdjob_b1bb0cf5-… -> completed | adapter=82855e1ea12723b7 | worker=rdmd-gpu-worker/1 | err=-
OK：无人值守自清队列 —— 放进去之后没有任何人再动手，它自己走到了终态
```

新 jobId 让判定与「跑得快慢」无关：它不可能在放进去之前就被处理过，所以不需要去抢那几十秒的时间窗。

### 9.6 接缝与回归

本轮改了 daemon、一次性门、E2E harness、autopull 检查，故复跑：

| 套件 | 结果 |
| --- | --- |
| `cloud:test:rdmd-transport`（桌面↔云接缝） | 35/35 |
| `cloud:test:hygiene`（BOM） | 4/4 |
| `cloud:test:rdmd`（真实 Postgres 语义） | 26/26 |
| `cloud:test:rdmd-shadow`（影子 + 开关） | 38/38 |
| `experiment:rdmd-worker:test` | 12/12 |

### 9.7 本节**不能**证明的事

- **没有真实群任务**：作业表里全部是 E2E 夹具（`completed ×4 + failed_terminal ×1`），
  云库 `collaboration_graphs = 0`。夹具的 `G_star`/`G_prime` 是脚本造的，不是任何真实任务产的。
- **上游接线仍未核对**：桌面端 `cloud_sync_state.server_url` 指向哪台云 API 读不出来，
  必须由人在真机上确认它指向 bjb1 这台（`8787`），否则真实任务永远进不到作业表。
- **`ubuddy_plan_exec_drift_apply` 仍关着**：真实判定一条都没有，影子度量无从累积。
