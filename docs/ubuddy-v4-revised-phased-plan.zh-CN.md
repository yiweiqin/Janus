# uBuddy V4 修订阶段性计划 + 现状盘点

> 状态：计划修订稿（2026-09-19）。
> 本文只做两件事：把「减弱依赖集束对跨人信息流通的作用 / 删掉最小披露 / 改用三层任务公共 memory」与
> 「主痛点收敛到跨人任务组织的可归因自进化、只留两个方案」写成**可执行的阶段计划**；并**如实盘点今天做到哪一步**。
> 上游口径（不重开）：[主张冻结](ubuddy-pain-points-innovations-v4-claim-freeze.zh-CN.md) ·
> [自进化收束稿](ubuddy-pain-points-innovations-v4-self-evolution.zh-CN.md) ·
> 三份协议：[TPM](ubuddy-v4-tpm-contract.zh-CN.md) · [RDMD](ubuddy-v4-rdmd-protocol.zh-CN.md) · [CPDB](ubuddy-v4-cpdb-protocol.zh-CN.md)
> 证据：仓库文档 + 2026-09-19 17:22 对远程 GPU 盒的**只读**探针（见 §4）。

---

## 0. 一句话

**修订方向已经在「文档 + 契约 + 模型」三层落地，卡的不是算法，是数据入口。**

- 公共 memory 取代披露：契约已写（`uBuddyTaskPublicMemory.js`），但**没有落库路径**，且**没进版本控制**。
- 方案一（反向侦探）：合成语料 → QLoRA v4 → 8 项验收全过 → **已在常驻 worker 上生效**；离真实任务只差「装构建 + 云路由部署」。
- 方案二（能力画像集束）：世界数据与三人盲标工具齐了，**人工标注量 = 0**（8282 条全是 `prelabel`）。
- 真实任务侧：云库 `collaboration_graphs = 0`、作业表里全是 E2E 夹具 —— **一条真实群任务都还没进来**。

---

## 1. 本次修订的两条口径（复述边界，不重开）

### 1.1 依赖集束降级 + 最小披露移出主线

| 维度 | V3（旧） | V4（本次修订） |
|---|---|---|
| 依赖集束用途 | 跨人披露 frontier + 决策充分性 + 联合进化，三处并用 | **只保留 \(D\)（依赖分）与 \(S\)（相似度）两个分数**：选人、换人、能力差归因 |
| 最小披露 | 主创新（finite-world solver、决策充分投影、`CERTIFIED` 证书） | **删除主创新**。看见什么交给任务公共 memory 的默认可见性 |
| 跨人信息流通 | 由依赖集束决定"向谁公开哪些字段" | 由 TPM 三层决定：本任务参与者默认只开基础层 + 提升层 |
| 禁止 | — | 不得把 \(D\)、\(S\) 加权成"依赖集束总分"再归因；不得用 \(S\) 当首选协作信号；不得用 \(D\) 当换人信号 |

### 1.2 任务公共 memory（TPM）三层

```text
基础层  G_plan、G_exec、节点状态、版本、结构依赖边        → 本任务参与者默认可见
提升层  经系统省检后的摘要（里程碑/结果版本/阻塞/验收/风险） → 本任务参与者默认可见
原始层  全部原始上下文（对话、文件、中间产物、未脱敏内容）   → 默认关闭；跨任务必须申请
```

**关于"审查机制"的定位（这里按你的"反正是很工程"拍死）**：

- 它是**工程门禁，不是算法贡献**，不进论文主创新，也不训练专用模型。
- 流程固定为：`申请单 → AI 预审（规则）→ 通过后交任务 Owner 终审 → 短时 / 只读 / 可撤回 / 可审计的授权`。
- AI 预审只查四类硬规则：缺用途、窗口为空、窗口过宽且要全文、目标任务不匹配（外加明文密钥/PII）。
- 输出只有 `pass | reject | need_human`；AI **不能**直接发授权。
- 失败不阻塞本任务继续执行，也不写进基础层（省检失败的条目不进提升层）。

> 这条今天只有契约函数（`createRawAccessRequest` / `reviewRawAccessByAi` / `reviewRawAccessByOwner` / `applyRawAccessPipeline`），**没有落库**——云库里还没有申请/授权表。见 §5.B3。

### 1.3 主痛点收敛

```text
P_evo  跨人任务组织无法准确自进化
  ├─ P_drift  规划理想路径 vs 现实可执行路径，找不到"最小引起后续分叉"的那一点
  └─ P_swap   失败后不知道该换谁，也无法把结果差归因到具体能力差
```

分工固定：**公共 memory 回答看见什么；方案一回答偏在哪；方案二回答找谁、换谁、差在哪项能力。**

---

## 2. 修订后的阶段计划

原计划的阶段 0–6 保留编号，另立一条**并行工程线 P1–P5**（真实任务接线），本次新增**阶段 7**。

### 阶段 0：主张冻结 —— ✅ 已完成

- 交付物：V4 主张冻结稿（主痛点只留 `P_evo`、两个子问题、非主张清单 8 条）。
- 验收：非主张清单必须写明「依赖集束总分 ≠ 因果根因」「生产自进化未验证」等 8 条。**已满足。**

### 阶段 1：方案骨架 —— ✅ 已完成

- 交付物：自进化收束稿（§5 方案一 / §6 方案二 / §7 闭环 / §8 训练与验收规格）。
- 验收：两条方案的输入、输出、监督信号分开写；漂移类型只允许 5 种。**已满足。**

### 阶段 2：任务公共 memory 契约 —— ✅ 契约完成 / ❌ 未接库表

- 交付物：`src/shared/contracts/uBuddyTaskPublicMemory.js`（三层 + 默认投影 + 申请/预审/终审/授权四段流水线）+ 单测。
- 验收门：`participant_hides_raw` / `stranger_sees_nothing` / `wide_request_rejected_before_owner` / `approved_excerpt_only` / `inspect_drops_secrets` **全 PASS**（见可行性报告 §1）。
- 未完成：**没有任何 PostgreSQL 表**；`foundation.plan/exec` 的 TPM 投影只有实验脚本（`tpm_from_real_tables.mjs`）。
- **风险：该契约文件未进版本控制**（`git status` = `??`）。见 §5.A1。

### 阶段 3：反向侦探（RDMD）—— ✅ 大幅超计划完成（原计划只要求"定义指标"）

| 子步 | 交付物 | 状态 |
|---|---|---|
| 3.1 数据协议 | `uBuddyReverseDetective.js` 契约 + 数据集卡 + 生成/校验 | ✅ |
| 3.2 合成语料 v4 | drift 10,000 / no_drift 1,000 / UNKNOWN 1,000；图族 2 类；split train 8,590 / dev 1,745 / test 1,665 | ✅ |
| 3.3 SFT + 训练 | QLoRA v4（Qwen3-8B + nf4 + LoRA r16），1,074 步 / 16h05m | ✅ |
| 3.4 离线验收 | `acceptance.json`：**8/8 门 PASS → `USABLE`** | ✅ |
| 3.5 出处绑定 | `adapter_sha256` + split 标签 sha256 + evaluator sha（`source=backfill`，证据力弱于 launch，已明写） | ✅ |
| 3.6 真机切换门 | 常驻 worker 从 v3 切到 v4，含负对照（期望 v3 sha 时必须 exit 1） | ✅ |
| 3.7 输入侧接线 | `agent_step` 四层图 + 影子提案 + apply 双门 | ✅ 代码 / ❌ 真实数据 |
| 3.8 输出侧接线 | 7 种判定形状 → `routeEvolution` 动作，7/7 闭合（含 103 条真实模型判定回放） | ✅ |

离线硬数字（v4 / test n=1,412）：定位 **0.9986**、类型 **0.9993**、UNKNOWN 弃权 **0.9930**、no_drift **1.0000**、step 层定位 **0.9859**、模型−只看 status 捷径 **0.7994**、解析错误率 **0.0000**。

> 必须一起记住的上限：**规则 D/E 在本地化上是 1.0000，模型最多只是打平。**
> v4 的正当性来自「不写图算法、只读文本」的部署形态，不是精度。

### 阶段 4：能力画像依赖集束（CPDB）—— ✅ 数据与工具就绪 / ❌ 人工标注 0

| 子步 | 交付物 | 状态 |
|---|---|---|
| 4.1 契约 | `uBuddyCapabilityDependencyBundle.js`：`dependencyScore` / `similarityScore` / 指数递减更新 / `forbidCombinedScore` / `attributeAfterSwap` | ✅ |
| 4.2 组织世界 | 12 组织 / 120 人 / 600 Agent / 8,282 配对；split 6,705 / 778 / 799 | ✅ |
| 4.3 标注工具 | 三人盲标页 + 仲裁 + Cohen κ 一致性 + gold 导出 | ✅ |
| 4.4 人工标注 | 甲/乙盲标 test、丙仲裁 + 复核 train/dev | ❌ **未开始**（8,282 条全 `prelabel`） |
| 4.5 训练第二份 QLoRA（学 D / S） | — | ❌ 未开始 |
| 4.6 替换归因 | 相似替换 / 随机替换 / 只改规划 三对照 | ❌ 未做（只有合成世界里的闸门） |

### 阶段 5：真实任务闭环 —— ❌ 卡在发布（唯一卡点是人）

```text
依赖分规划 → 执行入 TPM → 双树对照 → 侦探定位 → 相似替换或最小改规划 → 对照收益 → 允许或拒绝写入
```

现状：这条链**每一段都有代码与测试**，但**真实任务的 case 一条都没进来**。

| 断点 | 实测 | 性质 |
|---|---|---|
| `collaboration_graph_*` 四张表在已安装构建里不存在 | 已安装库：0 张表 / `collaboration_groups` 7 条 | 发布缺口 → **装新构建 + 重启** |
| 生产云 `123.207.22.235` 没有 `/api/rdmd` 路由 | 探测 `404`（若路由在，会是 `401`） | 部署落后 |
| 影子观测数 | `0`（分母必须是 observed，不是 proposals） | 没判定 → 观测恒 0 |
| `ubuddy_plan_exec_drift_apply` | 默认**关**（`SAFE_DEFAULT_OFF`） | 设计如此：没证据不许改产品 |
| 真实 case 过模型输入闸门 | 产品形状投影实测 **3/6**；残余缺口只有一档（终止态 `failed`/`cancelled` 的 `empty_output`） | 待决策（要 bump 契约版本） |

### 阶段 6：闭环与负迁移 —— ❌ 未开始

- 6.1 给侦探合成器**加噪声 + 合法重规划**（原"下一步"第一条）。
- 6.2 画像标注的**标注者间一致性**与模型拟合（需要先有阶段 4.4 的真标注）。
- 6.3 正式比较四种更新：不更新 / 只改组织 / 只改个体 / 联合更新，看跨任务负迁移与回滚率。
- 6.4 原始层审查落库（工单 + ACL）。

### 阶段 7（本次新增）：长程层能不能进主线的**前置裁决**

P5 的结论已经把这扇门关上了（`SEQUENCE_TO_DAG`）：

- 真实链上**可因果归因的图 = 0 / 22**；771 条边**全是 `sequence`（假设）**、0 条证据。
- 就算把"提到过同一路径"全认成证据：候选对 8,161 条（链边数的 10.6 倍），仍然 **0/22** —— 不是把链变瘦，是把它变成一张几乎全连接的图，**"最小漂移"失去唯一候选**。
- 因此 `STEP_DEPENDENCY_MAP_TRAINING_ALLOWED = false` + `assertNotForTraining()`（会抛，不是注释）。

阶段 7 的前置条件（**三条都满足才重开**）：① 同一图内节点 id 唯一（现在同 session 多 rollout 会撞 12 处）；② 出现可判定的依赖证据来源；③ 契约版本升级方案明确（不能悄悄 bump 掉 v4 的真机证据）。

### 停做清单（防止口径回漂）

1. 不恢复 finite-world 最小披露 solver、投影头 `CERTIFIED` 拟合、TDB 十维后验作为归因监督。
2. 不把 \(D\) 与 \(S\) 合成一个总分。
3. 不把成功执行树整段复制进组织模板（临时补救不是应当写入的结构）。
4. 不用长程层链式投影训练/评测 RDMD。
5. 不在真实任务上声称"生产自进化已验证"。

---

## 3. 计划进度总表

| 阶段 | 计划内容 | 状态 | 卡在哪 |
|---|---|---|---|
| 0 | 主张冻结 | ✅ | — |
| 1 | 方案骨架 | ✅ | — |
| 2 | TPM 契约 | ✅ 契约 / ❌ 库表 / ⚠️ 未入库版本控制 | §5.A1、§5.B3 |
| 3 | RDMD | ✅ 到真机生效；❌ 真实数据 | §5.C1、§5.C2 |
| 4 | CPDB | ✅ 数据+工具 / ❌ 人工标注 0 | §5.C3 |
| 5 | 真实任务闭环 | ❌ | 同上，全是发布/人力 |
| 6 | 噪声、负迁移、审查落库 | ❌ | 前置未完成 |
| 7 | 长程层前置裁决 | ⛔ 已判定"今天不能用" | 三条前置条件 |

---

## 4. 今天远程盒实测（2026-09-19 17:22，只读）

| 项 | 实测 |
|---|---|
| 主机 | `autodl-container-0zv0wuxn4h-b9dfbe0f`，up 204 天 |
| GPU | 3 × A800-SXM4-80GB，**显存 0 MiB / 利用率 0%**（三卡全空，训练容量可用） |
| 常驻常驻 worker | `rdmd_gpu_worker.py` pid 66760，device `cuda:0`，已跑 16h44m |
| 线上 adapter | `82855e1ea12723b7…`（= v4，与 `acceptance.json` 的 sha 逐字节一致） |
| 队列 | `0 queued, 0 claimed, 4 completed` |
| 云 API | `node cloud/src/index.mjs` pid 10496，监听 **127.0.0.1:8787**（仅本机），`RDMD_CLOUD_ENABLED=true`，`RDMD_BACKEND=gpu_worker` |
| 作业表 | `cloud_rdmd_inference_jobs`：`completed 4` + `failed_terminal 1`（全是 E2E 夹具） |
| 云库协作图 | `collaboration_graphs = 0` / nodes 0 / edges 0 / events 0 |
| 云库申请类表 | 只有 `cloud_memory_access_audits`、`cloud_work_memory_access_audits` 等可复用表；**没有 TPM 原始层申请/授权表** |
| 备份 | 最新云备份 `cloud_backup_20260919_002856.tar.gz`（9-19 00:28） |

**读法**：模型侧**在线上是生效的**（v4 在跑），但**真实任务一条都没进来**——这两句话必须同时成立，不能只报前半句。

---

## 5. 与计划的差距：下一步（按"谁能做"分类）

### A. 现在就能做（本机 / 云盒，不需要人、不需要 GPU）

1. **把修订载体纳入版本控制**——这是本轮最便宜、也最致命的一项：
   `uBuddyTaskPublicMemory.js(.test)`、`uBuddyCapabilityDependencyBundle.js(.test)`、整个 `experiments/cpdb_org_world/`、
   `cloud/src/modules/collaboration/evolutionEvidenceGate.mjs`、`tdbSnapshotRead.mjs` 等 **15+ 个契约/实验文件全是 `??` 未跟踪**。
   干净克隆会**静默丢失 TPM** —— 而 TPM 正是"公共 memory 取代披露"这条修订的落地载体。
2. **给侦探合成器加噪声 + 合法重规划**（阶段 6.1），纯 CPU。
3. **把 apply 度量门的分母口径在真实数据上预演**（读现有库副本即可），确认"观测不可达"是数据事实而不是代码事实。
4. **CPDB 预标审计**：把 `combined` 键从预标产物里去掉（见 §6.1），并核对预标分布是否会把标注者锚定。

### B. 需要你决策（我不能替你拍）

1. **终止态豁免规则**（`failed`/`cancelled` 节点的 `outcome` 字段豁免）：改它要 JS+Py 同步 + `bump PLAN_EXEC_CONTRACT_VERSION`，而版本号已经写进已完成作业行 —— **一次未经验证的 bump 会让 v4 刚拿到的真机证据失效**。（证据留在 `gateWaiverDryRun`，随时可复现。）
2. **生产云落脚点**：`123.207.22.235` 是不是 bjb1 那台？是 → 问题从"地址写错"变成"部署落后"；不是 → 要把桌面端地址改成 bjb1（注意 `server_url` 同时被同步与 RDMD 两处读）。
3. **原始层审查落库形态**：工单 + ACL，还是新增申请单/授权表？契约函数的形状已经定了，缺的是落点。

### C. 只能人做（三条，都是"最后一跳"）

1. 装含 `ensureUBuddyCollaborationGraphSchema` 的构建 → 重启桌面端 → 跑 **≥2 个真实群任务**（每个 ≥2 参与者，步骤一大一小）；验收看 §5 那张表里 `agent_step > 0` 与 plan 事件 `> 8`。
2. 把含 `cloud/src/modules/rdmd` 的构建部署到生产云并重启 API（复验：`/api/rdmd/jobs/__probe__` 从 `404` 变 `401`）。
3. CPDB 三人标注（甲/乙盲标 test、丙仲裁 + 复核 train/dev）→ 才能训第二份 QLoRA。

---

## 6. 今天探针的**新增**发现（之前文档里没有）

1. **CPDB 标注量 = 0**。`data/full/human_labels.jsonl` 8,282 行，`annotatorId` 全是 `prelabel_v1`、`status` 全是 `prelabel`。也就是说"方案二"目前只有数据集和工具，**没有任何人工金标**。
   另外，预标行里带一个 `combined: null` 字段（全 8,282 行都是 null）。值无害，但**键名与契约「配对没有 combined 总分」的措辞正面相冲**，建议在预标产物里删掉该键——否则将来一定会有人误读成"其实有总分"。
2. **TPM 契约未进版本控制**（`?? src/shared/contracts/uBuddyTaskPublicMemory.js`）。审批流水线只有函数、没有表、也没提交。
3. **云库没有原始层申请/授权表**：TPM §4.4 的落库路径不存在，只有可复用的审计表。
4. **worker 日志有一条易误读的旧记录**：`rdmd_worker_daemon.log` 里仍有 `adapter_sha256=c5193c7c…`（v3）的启动行，最后两行才是 `82855e1e…`（v4）。当前**运行的是 v4**（daemon `status` 读的是运行中 worker 自己的日志，两边一致）。不是问题，但读日志的人会误判。
5. **你给的新口令 `oSmmn/Cbr/K6` 在 `bjb1:48096` 上认证失败**（`paramiko … Authentication failed`，连试两次）。`scripts/_rdmd_env.ps1` 里既有的口令**可用**，本文 §4 的全部数字都是用它、以只读方式取的。请确认是不是换了实例/端口——若是，我只需要改 `_rdmd_env.ps1` 这一个文件。

---

## 7. 复现

```powershell
cd D:\Cli-anything\Janus
. scripts\_rdmd_env.ps1        # 远端端点（换盒子只改这一个文件）

# 离线验收（8 项门）
python scripts\rdmd_acceptance.py --eval-dir experiments\rdmd_runs\eval-qlora-v4 `
  --run-tag qlora-v4 --compare-tag qlora-v3 --data-dir experiments\rdmd_detective_dataset\data

# 远端只读状态
python scripts\rdmd_ssh.py --command "bash /root/autodl-tmp/Janus/scripts/_rdmd_worker_daemon.sh status"

# 输入侧（本机库副本）
cd experiments\rdmd_detective_dataset\ubuddy_recon
node _snapshot_db.mjs "$env:USERPROFILE\.janus-test\data\janus.db" "$env:TEMP\janus_fresh.db"
node _probe_layered_graph_e2e.mjs "$env:TEMP\janus_fresh.db"
```

---

## 8. 本文不声称

- 不声称生产自进化已验证（云库协作图 0、真实作业 0）。
- 不声称 v4 超过规则基线（本地化上限是打平）。
- 不声称 TPM 原始层审查是安全保证或算法贡献。
- 不声称长程层可用（0/22 可归因）。
- 不把 `source=backfill` 的出处当作与 launch 同等的证据力。
