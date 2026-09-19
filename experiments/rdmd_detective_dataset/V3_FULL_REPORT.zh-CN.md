# RDMD v3 全量数据集报告（路线 B）

日期：2026-09-13。种子 `20260910`，`--backend=local`。
本文是 v3 的权威记录；设计动机与改动清单见 `V3_SMOKE_REPORT.zh-CN.md`（smoke 阶段的历史记录）。

## 1. 产物

| 项 | 值 |
| --- | --- |
| 行数 | 12000（drift 10000 / no_drift 1000 / UNKNOWN 1000） |
| 图数 | 1659 |
| 拒绝行 | 0 |
| 生成器 | `rdmd_single_inject_v3` / `rdmd_multi_inject_v3` |
| train sha256 | `7bad3bb4…1e3c` |
| development sha256 | `9cb4ac83…5000f` |
| test sha256 | `6202565c…4a3e` |

SFT 切分（`sft/manifest.json`，`status: READY_FOR_QLORA`，`rejected 0`）：

| split | n | drift | no_drift | UNKNOWN |
| --- | --- | --- | --- | --- |
| train | 8465 | 7093 | 771 | 601 |
| development | 1771 | 1480 | 118 | 173 |
| test | 1764 | 1427 | 111 | 226 |
| eval_unknown | 226 | — | — | 226 |
| eval_no_drift | 111 | — | 111 | — |

`eval_unknown` 是 test 中 UNKNOWN 子集的评估副本（与 v2 设计一致，不参与训练）。
`mainLoss = [drift, no_drift, UNKNOWN]`，`unknownInMainLoss = 774`（train 601 + development 173，实测一致）。

Token 审计：p50 7462 / p95 7780 / max 8183，`recommendedMaxLength = 16384`。

## 2. 验收门禁

`node validate.mjs` → `pass: true`

| 门禁 | 结果 |
| --- | --- |
| `invalid` | 0 |
| `graphLeak`（graph_id 跨 split） | 0 |
| `hopOk`（首次效果 ≥ 3 跳） | 通过，minHop 3，meanHop 3.40 |
| `forms`（漂移形态数） | 100 |
| **`shortcut`（最小 id 规则）** | `lowestIdNodeTop1 = 0.1464` < 0.35 ✅ |
| `baselineOk`（旧结构启发式 < 0.95） | 0.000 ✅ |

`python check_readiness.py` → `DATA_READY`，failures 空。
`node --test dataset.test.mjs` → 7/7 通过。

## 3. 诚实基线（只读 prompt 的两棵树，不读 label）

test split，1427 条 drift：

| 规则 | 定义 | Top-1 |
| --- | --- | --- |
| A | 最小 id 且自身 `inputs/agentId/version/acceptance` 变化的节点 | 0.5270 |
| **B** | 最小 id 的变化节点（**v2 的满分短路**） | **0.1395** |
| C | 唯一「变化根」（变化节点且无变化上游） | 0.0000 |
| **D** | 「级联根」：变化节点、无变化上游、且至少一个有变化的下游 | **1.0000** |
| E | 完整基线：级联根唯一 → drift，≥2 → UNKNOWN | 定位 1.0000 / type 0.5270 |

| split | drift n | A | B | C | D | E 定位 | E type |
| --- | --- | --- | --- | --- | --- | --- | --- |
| train | 7093 | 0.5364 | 0.1482 | 0.0000 | 1.0000 | 1.0000 | 0.5364 |
| development | 1480 | 0.5412 | 0.1446 | 0.0000 | 1.0000 | 1.0000 | 0.5412 |
| test | 1427 | 0.5270 | 0.1395 | 0.0000 | 1.0000 | 1.0000 | 0.5270 |

no_drift：E 判定「两树相同」正确率 1.0000。
UNKNOWN：E 弃权率 1.0000。

v2 → v3 的关键位移：**规则 B 从 1.000 掉到 0.1395**，规则 C 从（未定义）0.000 保持 0.000。

## 4. 关键发现一：诱饵把旧启发式从「勉强及格」变成「主动栽赃」

`validate.mjs` 内的旧结构启发式 `detectMinimalDrift`（v2 上 drift Top-1 0.5379）在 v3 上是 **0.000**。
精确为 0 一度像指标 bug，实测后确认是真实行为（证据：`_baseline_probe.mjs`）：

| 行为 | 比例 |
| --- | --- |
| 答对金标 | **0.000** |
| **指认诱饵的无辜父节点** | **0.732** |
| 弃权（UNKNOWN） | 0.268 |

机理（两个机制叠加）：

1. `contrastDriftGraphs` 对**新增边**会把两个端点都标记为 involved，于是诱饵的父节点被卷进来；
2. 诱饵因此有了 involved 祖先，**不是**根；唯一根变成那个无辜的父节点。
3. 当金标只在派生字段（`artifact`/`summary`/`output`）上可见时，这个无辜父节点就是唯一的根 → 启发式很有把握地指认了一个替罪羊。

结论：诱饵不只是「增加噪声」，而是把基于「找唯一变化根」的规则**从失败推向自信的错答**。这正是我们想要的对短路的对抗效果。

## 5. 关键发现二：原因字段是「高精度、不完全」的信号

实测（train / test 一致，`rows_with_multiple_cause_nodes = 0`）：

- `inputs` / `agentId` / `version` / `acceptance` 的变化**永远只出现在唯一一个节点上，且该节点就是金标**。
- 因此规则 A 的精度是 **1.000**，但覆盖率只有 **0.527 / 0.536**。

含义：约 53% 的 drift 行里，真凶可以被一个「原因字段」直接认出来；剩下约 47% 的真凶在派生字段上**完全没有标记**，只能靠「重建依赖序 → 找级联根 → 排除诱饵」推出来。

这解释了为什么规则 A ≈ 规则 E 的 type 分数在三个 split 上**完全相等**：type 的得分完全来自「原因字段直接可见」那部分行；没有可判别原因字段的行（例如 `local_replan`）type 一律拿不到分。

## 6. 路线 B 的原理性天花板（必须写进论文）

规则 D/E = **1.000**，而它是手工写死的确定性算法。只要数据集保证「唯一植入原因」，就**必然存在**一条满分的确定性规则。路线 B 能做到的极限是**让那条规则等于我们想考的能力**：

> 「对齐两棵树 → 找变化节点 → 从边重建依赖序 → 找变化根 → 用『是否有变化的下游』排除诱饵 → 输出节点 id」

因此模型的价值不在于超过 D，而在于**不写图算法、只从文本表面复现 D**。定位这一维对模型是零上限空间。

有上限空间的维度是：

- **type**：基线 0.527（v2 模型 0.9971）
- **abstention**：基线靠数级联根拿到 1.000（v2 模型 0.000，185 行全答 drift）
- 以及那条 47% 的「无原因字段」子集 —— 模型必须在真凶无标记时仍能定位。

若要让定位维度也有上限空间（基线 < 1.0），需要路线 A 的契约层，或引入「级联本身看起来也合理」的诱饵（即图里能表达「计划内变更」）。**这是路线 B 的原理性上限，不是实现问题。**

## 7. 副作用与备份

- 本地 `experiments/rdmd_detective_dataset/data/*.jsonl` 已被 v3 全量覆盖，v2 的 12k 行原始数据在本地不存在（该目录未被 git 跟踪，生成器也已改成 v3）。
- v2 的 12k SFT 原本只是远程 `/root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/sft/` 里的唯一副本。
- **v2 SFT 已备份并验证**：上传 v3 前自动归档为
  `/root/autodl-tmp/rdmd_runs/sft_backup_20260913_112704.tar.gz`（12 MB）。已开箱核对内容：
  `sft/manifest.json` 是 `rdmd_detective_sft_v2`，行数 train 7902 / development 1615 / test 1668 / eval_unknown 185 / eval_no_drift 111，与 v2 记录一致。
- **已加固**：
  - `rdmd_remote_deploy.py` 上传前自动打包远程现有 `sft/`；**若备份未成功则拒绝覆盖**（fail-closed）。
  - `_rdmd_remote_bootstrap.sh` 的训练输出目录改由 `RDMD_RUN_TAG` 决定（经 `RDMD_RUN_TAG=qlora-v3` 转发），不再像原来那样以 `--force` 覆写 `qlora-v2`。
- **过程中发现并修掉一个真 bug**：备份命令里的 `$(date +%Y%m%d_%H%M%S)` 曾被插值到 `tar` / `echo` / `du` 三处，远程 shell 各展开一次、可能跨秒（实测 `tar` 写 `…112704` 而 `du` 找 `…112706`），于是 `du` 失败并误报 `NO_EXISTING_SFT`。当时备份实际是成功的，但这条告警会掩盖真实状态。现在时间戳只在同一个远程 shell 里展开一次，并以 `BACKED_UP` 作为成功判据。

## 7.1 首次启动失败：训练脚本自己的契约断言没跟上 v3

上传后第一次启动**立即崩在训练脚本的契约检查**上：

```
ValueError: unknown_in_main_loss:train:rdmd_local_220__UNKNOWN__none__none__20260910
```

根因：`scripts/train_qlora_rdmd.py#assert_sft_contract` 里有一条 v2 时代的规则——「train/development 里禁止出现 UNKNOWN」，`rdmd_local_220__…__UNKNOWN` 正是 v3 新增的主损失弃权样本。v3 的改动覆盖了 `lib/sft.mjs#isMainSupervised`、`prepare_sft.mjs`、`check_readiness.py` 和 `dataset.test.mjs`，**唯独漏了训练脚本自己的断言**——而它才是真正决定训练用哪些样本的那道门。四道本地门禁（`validate.mjs`、`check_readiness.py`、`dataset.test.mjs`、`scripts/test_rdmd_qlora_contract.py`）全部绿灯通过，因为它们都在检查「v3 是否满足 v3 的规则」，没有一个在检查「训练器是否接受 v3」。

修复（不再让训练器硬编码一份会过期的契约）：

- 新增 `DEFAULT_MAIN_LOSS = ("drift", "no_drift", "UNKNOWN")`；`assert_sft_contract(train, development, main_loss=DEFAULT_MAIN_LOSS)` 的主损失集合**从 SFT manifest 的 `mainLoss` 读取**，数据集自己声明契约。
- 删除「禁止 UNKNOWN」这条，换成真正想表达的不变量：
  - `status` 必须属于声明的 `mainLoss`；
  - 每行必须 `supervised == True`；
  - `drift` 必须给出 `nodeId` + `type`；`no_drift` / `UNKNOWN` 必须两者皆空（弃权）。
- run manifest 里写死的 `"dataKind": "rdmd_detective_sft_v2"` 与 `"unknownInMainLoss": False` 同样改为从 SFT manifest 推导。
- `scripts/test_rdmd_qlora_contract.py` 从「断言 UNKNOWN 被拒」改为「断言 UNKNOWN 被接受」，并补上 `main_loss` 由 manifest 驱动、`drift_missing_target`、`non_drift_has_target` 等用例（4/4 通过）。

修完后用真实 v3 数据做干跑校验：`CONTRACT_OK rows 8465 1771`，`dataKind = rdmd_detective_sft_v3`，`unknownInMainLoss = True`。教训值得记：**数据集的契约要由数据集声明，门禁必须至少有一道去检查消费方（训练器）是否接受新契约**，否则「全部测试通过」和「训练起不来」可以同时成立。

## 7.2 训练 loss 为什么不能当证据：拓扑与重复度普查

启动后训练 loss 迅速掉到 `0.0025`（step 205）。这个数字不寻常，需要回答「它能否用记忆解释」。为此刻意做了离线普查（不干扰训练）。

### 7.2.1 两次失败的测量（方法论教训）

**第一次：得出「1199 张图只有 1 种拓扑」——错的。** 边是靠自己把节点的 `inputs` 文本与另一个节点的 `output` 文本配对重建的，部分链接没能解析成功。而 WL 哈希作用在「缺边的图」上会把所有图压成同一个值，于是输出 1。**用文本重建结构本身就是错的**：原始数据里明明有显式的 `G_star.edges` / `G_prime.edges`（19 条边 / 20 节点）。

**第二次：得出「4 种拓扑」——也是错的。** 换成「只按子节点自底向上聚合」的规范型。但 1199 张图里有 879 张的 G_star 含**多父节点（DAG join）**，只聚合子节点会丢掉父边信息，导致**非同构图相撞**。这种规范型对 DAG 甚至不是一个合法的不变量。

**修正做法**：用标准的**个体化-精化（individualization-refinement）**精确规范型，并先跑**随机重标号性质自测**证明它确实对 id 重命名不变，再报数。自测 `60/60` 通过后才采信结果。（两次错误脚本已删除，避免被再次运行并采信。）

### 7.2.2 结论

| 问题 | 答案 |
| --- | --- |
| 1199 张图的 G_star 有多少种拓扑（忽略 id）？ | **1199 种，两两不同，零坍缩** |
| 每张图的规模 | 20 节点 / 19 边；含 1–2 个 join（多父节点），根唯一 |
| 「1 行」的 628 张图是什么？ | **恰好就是 200 条 no_drift + 428 条 UNKNOWN**，与 drift 完全分离 |
| 多行图有多少行？ | 11–16 行（= 6–7 个不同凶手 × 5 种 type） |
| dev / test 与 train 的拓扑重叠 | **0 / 0**（215 与 245 个全新拓扑，图级与拓扑级都不重叠） |
| dev / test 与 train 的 scenario 文本重叠 | **117/117、129/129 全部在 train 出现过** |
| dev / test 的度序列种类 | 3 种与 2 种，**全部与 train 共享** |

三点读数：

- **不存在「同一形状换皮」**。之前担心的「571 张核心图其实是少数模板」不成立：每张图都是独一无二的拓扑。所以「记住形状」无法在留出集兑现 —— 留出集是 460 个训练时没见过的拓扑。
- **但记忆的土壤依然肥沃**。571 张多行图每张被看约 28 次（14 行 × 2 epoch），而每张图有**唯一指纹**（唯一拓扑）——唯一指纹恰恰是**理想的查找键**。模型完全可能学成「看到这个 DAG 就答某个位置」。这种记忆在 train 上能把 loss 压到极低，在留出集上则一文不值。**因此 `0.0025` 依然不能证明学会了规则，必须看 dev/test。**
- **度序列高度同质**（dev 215 张图只有 3 种度序列，且都被 train 覆盖）。这其实排除了「按粗粒度结构猜」的捷径：度画像几乎不携带区分信息，模型只能去读具体接线。这是好事。
- **需要如实记录的一点**：dev/test 的 scenario（domain\|topic）**全部**在 train 出现过。也就是说，评测检验的是「同主题词汇下、全新图结构」的泛化，**不是**「新领域/新主题」的泛化。这条要写进论文的限制。

### 7.2.3 留白

`G_prime` 的拓扑则因注入与诱饵而变化：单行图（no_drift/UNKNOWN）恒为 1 种，drift 图每张 6–15 种，全量共 6319 种不同 G_prime 拓扑。

### 10. epoch-1 中途评测：v3 达标（决定性证据）

训练到 **step 530 / 1060**（epoch 1 结束）时 trainer 存下 `checkpoint-530`。**利用 GPU 1、2 的 11 小时空闲**（训练只占 GPU 0）在 22:32–23:16 评了这个中间产物，把结论从次日 05:10 提前到当晚。

评测方式：`_rdmd_eval_checkpoint.py` 指定 `ADAPTER=checkpoints/checkpoint-530`、`GPU_IDS="1 2"`，只评 `development + eval_unknown + eval_no_drift`（**故意不含 test** —— 评测要所有分片跑完才计分，加最大的 split 会拖慢包括 dev 在内的全部数字）。

### 10.1 结果（`scripts/rdmd_acceptance.py`，exit 0）

| 判据 | n | 值 | 阈值 | 判定 |
| --- | --- | --- | --- | --- |
| development 定位 nodeId Top-1 | 1480 | **0.9973** | 0.95 | PASS |
| development 类型 type Top-1 | 1480 | **0.9966** | 0.60 | PASS |
| eval_unknown 弃权率 | 226 | **1.0000** | 0.80 | PASS |
| eval_no_drift 正确率 | 111 | **1.0000** | 0.95 | PASS |
| development「无原因字段子集」定位 | 679 | **0.9971** | 0.90 | PASS |
| 最差 split 解析错误率 | — | 0.0000 | ≤0.02 | PASS |

`VERDICT: USABLE`。分状态细读：drift n=1480 `statusHit 0.9973 / typeHit 0.9966 / unknownRate 0.0027`；no_drift n=118 `1.0000`；UNKNOWN n=173 `1.0000`。`meanExtraEvidence 0.0027`（几乎不塞多余证据）。

### 10.2 为什么这是真实能力的证据，而不是记忆

三条互相独立的理由：

1. **弃权从 v2 的 0.000 变成 1.0000。** 这是 v2 唯一的、也是致命的失败模式（185 行全答 drift）。v3 把 UNKNOWN 放进主损失（774 条）后，226 行弃权样本**全对**。这条改动被验证有效。
2. **零拓扑重叠。** dev 的 215 个拓扑与 train 的 1199 个**无一重合**（第 7.2.2 节，IR 精确规范型 + 重标号自测）。按图查表的记忆在留出集上无从兑现。
3. **「无原因字段子集」0.9971 —— 最关键的一条。** 这 679 行的真凶在 `inputs/agentId/version/acceptance` 上**没有任何标记**（= 1 − 规则 A 的 0.527），不可能靠读某个变化的字段认出；必须**对齐两棵树 → 重建依赖序 → 找级联根 → 排除诱饵**才能解出。它接近满分，说明模型学到的是**依赖序推理**，不是字段匹配。

### 10.3 必须同时写明的边界

- **这是 development，不是 test。** dev 是合法的留出集（215 个新拓扑、零重叠），但 test（1764 行 / 245 个新拓扑）要等训练结束才评。
- **epoch 2 仍在跑。** 中途结果的不对称性对我们有利：早中期就达标 → 强结论；若早中期很差才只是提示。
- **定位维度仍然只是「打平」。** 基线 D/E = 1.000，0.9973 说明模型**复现了那条 11 行图算法**，不可能超过它。所以这个模型的正当性来自**部署形态**（只读文本、不写图算法、规则可随数据演进），**不是精度优势**。
- **仍有 4 条 drift 行被答成 UNKNOWN**（0.0027），可能是天然歧义行。
- 本节的 dev 数字**不能**与第 3 节 test 基线直接对比（基线表是 test 口径，规则 A 在 test 是 0.527、在 dev 是 0.541）。

## 9.3 验收口径：「这个模型能用吗」由脚本回答，不靠看仪表盘

`scripts/rdmd_acceptance.py` 把下面的判据固化成 go/no-go。**为什么不靠人看数字**：v2 的 node 定位是 1.000、type 0.9971，看起来很好，但那是在**规则 B 也满分**的数据上取得的，所以那些分数不构成能力证据。判据必须锚定在**基线之上**、以及**基线管不到的维度**上。

阈值与理由（基线见第 3 节）：

| 判据 | 阈值 | 锚点与理由 |
| --- | --- | --- |
| test 定位 nodeId Top-1 | ≥ 0.95 | 基线 D/E = 1.000。**模型上限只是打平**，低于此说明连规则复现都没做到 |
| test type Top-1 | ≥ 0.60 | 基线 0.527；v2 的 0.997 来自短路数据，不算能力 |
| eval_unknown 弃权率 | ≥ 0.80 | v2 = **0.000**（185 行全答 drift）。**最核心的短板** |
| eval_no_drift 正确率 | ≥ 0.95 | 基线 1.000；两树相同必须判稳 |
| test「无原因字段子集」定位 | ≥ 0.90 | 真凶在 `inputs/agentId/version/acceptance` 上**无标记**的 47.3% 行（= 1 − 规则 A 的 0.527）。只能靠重建依赖序解出，**真正考推理的一档** |
| 最差 split 解析错误率 | ≤ 0.02 | 产出不了 JSON 的模型不可用，与分数无关 |

判定：**全部达标 → USABLE；任一未达标 → NOT_USABLE**（缺失的判据算「未能证明」，不算通过）。exit code `0` 可用 / `1` 不可用 / `2` 数据不全。

```bash
python scripts/rdmd_acceptance.py --run-tag qlora-v3
```

自带 5 个用例的测试（`scripts/test_rdmd_acceptance.py`），其中**用例 1 直接喂 v2 的真实指标**，要求它必须判 NOT_USABLE 且把责任准确归到弃权那一项 —— 一个只会说「可用」的验收脚本比没有更糟。

「无原因字段子集」不是 split 级指标，需要逐行预测，因此监控器会额外下载 `merged.predictions.jsonl`；该脚本还会校验这一子集占 drift 行的比例是否仍 ≈ 0.473，防止定义悄悄漂移。

## 8. 复现命令

```bash
# 本地：全量生成 → 导出 SFT → 门禁
node experiments/rdmd_detective_dataset/generate.mjs --backend=local --seed=20260910
node experiments/rdmd_detective_dataset/prepare_sft.mjs
node experiments/rdmd_detective_dataset/validate.mjs
python scripts/rdmd_trivial_baseline.py --data experiments/rdmd_detective_dataset/sft \
  --splits train development test \
  --output experiments/rdmd_detective_dataset/sft/trivial_baseline.json
node --test experiments/rdmd_detective_dataset/dataset.test.mjs
python experiments/rdmd_detective_dataset/check_readiness.py

# 证据：旧启发式为什么会 0.000
node experiments/rdmd_detective_dataset/_baseline_probe.mjs
```

## 9. 进度

| 步骤 | 状态 |
| --- | --- |
| v3 全量生成 + prepare_sft + validate + 基线 | ✅ 完成 |
| 上传 v3 SFT 到远程（含 v2 备份） | ✅ 完成（`schemaVersion=rdmd_detective_sft_v3`，行数一致） |
| 修复训练器契约（见 7.1，首次启动崩溃） | ✅ 完成（单测 4/4） |
| 远程 QLoRA 重训（输出 `rdmd_runs/qlora-v3`） | ✅ 完成（1060 步 / 2 epoch，14.57 h，见 9.1） |
| 三卡分片评测 test / eval_unknown / eval_no_drift / development | ✅ 完成（3872 行，见第 11 节） |
| 与规则 D/E 诚实基线并排报告 | ✅ 完成（`VERDICT: USABLE`，见第 11 节） |

### 9.1 训练运行态（启动于 2026-09-13 15:13 +08:00）

| 项 | 值 |
| --- | --- |
| pid | 43337（GPU 0，独卡） |
| 编码 | `maxTokens=5595`，train 8465 / development 1771 |
| run manifest | `status=trained`，`dataKind=rdmd_detective_sft_v3`，`mainLoss=[drift,no_drift,UNKNOWN]`，`unknownInMainLoss=True` |
| 步数 | 1060（8465 / 16 × 2 epoch），跑满 |
| 实际耗时 | 52,453 s = **14.57 h**（结束于 09-14 05:47 +08:00） |
| train_loss | **0.02604** |
| best dev loss | **5.912e-05**（epoch 2；epoch 1 是 2.858e-4，即第 10 节的 checkpoint-530） |
| 最优产物 | `checkpoints/checkpoint-1060` = 最终 `adapter/`（**中途评测的 checkpoint-530 不是最优**） |
| 速率 | ~47 s/it（启动时预估 13.8 h，实际 14.57 h） |
| 首条 loss | step 10：`loss=1.949`，`grad_norm=4.63` |

对比参考：v2 的最终 train_loss 是 **0.02581**（几乎背下来了）。v3 起步 loss 1.949 明显更高，这是**预期且健康**的——任务已经不能靠「读第一个差异」完成，模型必须真的学依赖序与因果判断。

### 9.2 运维教训：长等待不要用单条长连接

起了一个「等第一条 loss」的等待脚本，前台跑（`--timeout 120`）立刻命中，后台跑（`--timeout 1700`）却**静默卡死 15 分钟**，而用 5 秒超时在后台跑同一个脚本 8.5 秒就正常返回。根因是单条 SSH channel 长时间无输出：远端早已结束，但连接静默断开时 paramiko 要等满 channel 超时才发现，期间无法区分「还在跑」和「连接已死」。
结论：**长任务等待一律走 Python 侧短轮询**（如 `_rdmd_wait_and_finalize.py`，每轮 30–45 s 拿到新鲜输出、每个轮次都是新的读超时），不要用一条长连接等到底。

远程 v3 SFT 行数已复核：train 8465 / development 1771 / test 1764 / eval_unknown 226 / eval_no_drift 111，`mainLoss = [drift, no_drift, UNKNOWN]`，`unknownInMainLoss = 774`。

启动重训的命令（需要时执行）：

```bash
# 上传 + 直接进入训练
RDMD_DEPLOY_STAGE=all RDMD_RUN_TAG=qlora-v3 RDMD_BOOTSTRAP_TIMEOUT=50400 \
  python scripts/rdmd_remote_deploy.py
# 或 SFT 已就位时只跑 bootstrap/train
RDMD_DEPLOY_STAGE=train RDMD_RUN_TAG=qlora-v3 RDMD_BOOTSTRAP_TIMEOUT=50400 \
  python scripts/rdmd_remote_deploy.py
# 四 split 评测（通用分片脚本）
python scripts/rdmd_ssh.py --set RUN_TAG=qlora-v3 \
  --set "SPLITS=test eval_unknown eval_no_drift development" \
  --command-file scripts/_rdmd_remote_eval_splits.sh --timeout 120
python scripts/_rdmd_wait_and_finalize.py --pid-dir /root/autodl-tmp/rdmd_runs/eval-qlora-v3 \
  --finalize scripts/_rdmd_remote_eval_splits_final.sh --max-minutes 120
```

## 11. 最终模型全量评测：`VERDICT: USABLE`（终局结论）

最终 adapter（`rdmd_runs/qlora-v3/adapter` = `checkpoint-1060`）在**四 split 共 3872 行**上评测，三卡分片（1291 / 1291 / 1290）。本次**包含 test** —— 第 10 节的 dev 结论在此被 test 独立复核。

### 11.1 判据（`scripts/rdmd_acceptance.py`，exit 0）

| 判据 | n | 值 | 阈值 | 判定 |
| --- | --- | --- | --- | --- |
| test 定位（nodeId Top-1） | 1427 | **0.9993** | 0.95 | PASS |
| test 类型（type Top-1） | 1427 | **0.9979** | 0.60 | PASS |
| eval_unknown 弃权率 | 226 | **1.0000** | 0.80 | PASS |
| eval_no_drift 正确率 | 111 | **1.0000** | 0.95 | PASS |
| test「无原因字段子集」定位 | 675 | **0.9985** | 0.90 | PASS |
| 最差 split 解析错误率 | — | **0.0000** | ≤ 0.02 | PASS |

分状态：test drift n=1427 `statusHit 1.0000 / nodeHit 0.9993 / typeHit 0.9979 / unknownRate 0.0000`，`meanExtraEvidence 0.0007`（几乎不塞多余证据）；test no_drift n=111 `1.0000`；test UNKNOWN n=226 `unknownRate 1.0000`。
development 复核 Drift n=1480 `nodeHit 1.0000 / typeHit 0.9986`，no_drift n=118 `1.0000`，UNKNOWN n=173 `1.0000` —— 与第 10 节的中间 checkpoint 相比**持平或更好**。

### 11.2 与诚实基线、v2 并排（全部 test 口径）

| 维度 | 诚实基线（规则 D/E） | v2 模型 | **v3 模型** |
| --- | --- | --- | --- |
| 定位 nodeId Top-1 | **1.0000** | 1.0000（短路数据，不算能力） | **0.9993** |
| type Top-1 | 0.5270 | 0.9971（同上） | **0.9979** |
| UNKNOWN 弃权率 | 1.0000 | **0.0000**（v2 的 185 行 eval_unknown 全答 drift） | **1.0000** |
| no_drift 正确率 | 1.0000 | 1.0000 | **1.0000** |
| 「无原因字段子集」定位 | 规则 A 在该子集 **0.000**（无信号）；旧结构启发式全局 0.000 | — | **0.9985** |
| 解析错误率 | — | 0 | **0.0000** |

**唯一低于基线的维度是定位：0.9993 vs 1.0000**，差距 0.0007（1427 行里 1 行）。这是第 6 节写明的路线 B 原理性上限：确定性 11 行图算法在「级联根唯一」这个问题上已经没有错误空间，模型只可能打平或略低。

**真正超出基线的两处**：

- **type 0.9979 vs 基线 0.5270**。基线只要认不出原因字段就只能猜，模型几乎全对 —— 这是基线拿不到的维度。
- **弃权 1.0000 vs v2 的 0.0000**。v2 的 185 行 `eval_unknown` **一行都没弃权**（全答 drift）；v3 把 UNKNOWN 放进主损失（774 条）后，自己那 226 行弃权样本**全对**。两者不是同一批行（数据集已重生成），但对照的失败模式是同一种。这是 v3 最核心的一条改动被 test 独立证实。

### 11.3 运维事故与恢复：评测触发不该挂在本地进程上

**训练本身完全成功，出问题的是评测链路。** 时间线：

| 时刻 (+08:00) | 事件 |
| --- | --- |
| 04:13 | 本地监控进程被执行环境回收（日志**无任何 error**，干净截断在 `969/1060`），同时丢失 `RDMD_SSH_PASSWORD` |
| 05:47 | 远程训练正常结束（`status=trained`，`nohup` 进程不受本地影响） |
| 16:22 | 三卡分片评测正常结束，**3872 行预测完整落盘** |
| —— | 无人执行「合并 shard → 生成 per-split 报告」：本地监控已死，且该步骤挂在本地进程上 |
| 22:0x | 恢复凭据 → 只补跑收尾（纯 CPU，37 s），未重跑任何 GPU 评测 |

**结论：训练的安全性来自远程 `nohup`，但评测的「触发」和「收尾」都挂在本地常驻进程上 —— 本地一夜被回收，评测就静默丢失。** 下次应把收尾也搬到远程（trainer 收尾时自己起，或 remote `at`/cron 兜底），而不是依赖本地监控活着。

分片预测完整、只是没人合并，也说明**收尾必须是可重入的纯 CPU 步骤**：正因 `_rdmd_remote_eval_splits_final.sh` 只做合并与计分、不碰 GPU，这次才能 37 秒补齐、不必重跑。为支持这一点，`_rdmd_score_checkpoint.py` 增加了 `--out-name`（此前只能用 `--tag` 推导 `eval-<run>-<tag>`，与本次的 `eval-qlora-v3` 不匹配）。

### 11.4 边界（不因为全绿就省略）

- **定位维度只是「打平/略低」确定性基线。** 模型的正当性来自**部署形态**（只读文本、不写图算法、规则可随数据演进），**不是精度优势**。
- **1 行 drift 定位错了**（0.9993 = 1426/1427）。注意该 split 的 `unknownRate = 0.0000`，即**没有一行被误答成 UNKNOWN**；这 1 行是答成 drift 但 `nodeId` 指错。疑似天然歧义行，未逐行归因。
- **这是路线 B 的天花板。** 要让定位维度也有上限空间，需要路线 A 的契约层，或能表达「计划内变更」的诱饵（第 6 节）。
- **验证范围**：test 1764 行、245 个新拓扑，与 train 零拓扑重叠（第 7.2.2 节）。

### 11.5 交付产物：`experiments/rdmd_detective_dataset/deploy/`

模型已按「可部署独立入口」打包（推理脚本 + adapter + 输入/输出契约说明）：

| 文件 | 作用 |
| --- | --- |
| `rdmd_detective.py` | 契约的单一事实来源：prompt 构造、输出解析、语义校验、模型封装 |
| `predict.py` | CLI 入口；`--dry-run` 无 GPU 也能验契约（打印 `promptSha256`） |
| `fetch_adapter.py` | 从训练机拉 adapter（权重不进 git，落到 gitignore 的 `rdmd_runs/`） |
| `test_rdmd_detective.py` | 24 项单测，含与训练 prompt 的逐字节比对 |
| `README.zh-CN.md` | 输入/输出契约说明 |
| `examples/` | 1 条最难的 drift + 12 条自检用例（含 gold，标注「仅自检」） |

关键一条：**prompt 构造与 `lib/sft.mjs#publicGraph/promptOf` 逐字节对齐**（跨 test 抽样 252 行，
零不一致）。这不是洁癖 —— prompt 差一个空格不会报错、模型也照样输出像样的 JSON，但分布已经偏了，
第 11.1 节的数字就不再适用于线上的输入。这种降级没有运行时症状，只有逐字节比对能抓到。

端到端已在训练机 GPU 上验证（`scripts/_rdmd_deploy_e2e.sh`）：12 条自检用例
（4 drift / 4 no_drift / 4 UNKNOWN）**status 12/12、定位 4/4、类型 4/4、invalid 0** —— 其中 2 条
正是「派生字段唯一可见」的困难样本（真凶在原因字段上毫无标记），也答对了。

一个刻意分开的设计：`valid=false`（判定不可直接消费）与「答错」是两回事。
`nodeId_not_in_graph` 这种「格式合法但图里不存在的节点」，只校验 JSON schema 抓不到，
但下游会拿着它去查一个假节点 —— 所以封装层额外做了语义校验并给出 `warnings`。

---

## 12. 分布外探针：换一种流程还行不行

> **2026-09-19 更正指向（P4）**：本节的分组表来自 `data/ood_summary.json`，
> 它描述的是**当时那一版探针**。探针后来被重造过（43 行 → **45 行**，
> 刻意造的派生字段行 10 → **13**），而汇总没有跟着重跑。
> 基线列已由 `data/ood_baseline.json` + `npm run experiment:rdmd-ood:gate` 重新钉住；
> **模型列需要用当前探针重跑一次模型才能刷新**（那一步要 GPU）。
> 详见 `ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md` §14。

第 11 节是**同分布**留出集（同生成器、同结构家族）的成绩。本节回答一个不同的问题：
把图换成**训练时从未出现过的规模与形状**，模型会不会散架。

### 12.1 先修正一个容易读错的说法

「test 与 train 零拓扑重叠」是对的，但它比听起来窄得多。生成器把 domain / topic / structure
都从图序号推出来（`lib/localTeacher.mjs`）：

- `DOMAINS` 只有 10 个、`STRUCTURES` 只有 4 种（`linear / fork_join / late_diamond / side_track`），
  1000 张金标图会把**每一个域、每一种结构、每一个主题都跑一遍** —— 所以它们**全部在训练集里出现过**；
- 步骤表固定 21 项，`starMin=16` 从不生效，**所有金标图都是 19–21 个节点**，而 schema 允许 16–32；
- 训练 prompt 的长度只有 **11221–13016 字符**这一个很窄的带。

所以第 11 节的数字是**结构家族内**的泛化。真正的分布外轴是**规模、形状、长度**，不是域或主题。

### 12.2 探针怎么造，以及凭什么可信

`make_ood.mjs` 用**和训练数据完全同一条注入管线**
（`pickInjection → applyLocalEdit → inferDownstream → addDecoyNodes`）套在**新的金标图**上：
4 种训练里没有的形状（`chain_side / wide_fan / nested_diamond / layered_mesh`）×
规模 16 / 24 / 32（schema 合法但从未出现）+ 48 / 80（越界探针，只为定位断裂点）。
节点词汇从真实金标图借用，注入代码不重写 —— **只动「规模与形状」这一个变量**。

可信度用门禁和自检压住，而不是靠声明：

| 自检 | 结果 |
| --- | --- |
| in-contract 行通过数据集门禁 | **0 失败**（畸形探针会静默污染结论，所以是硬断言） |
| id 唯一 | **0 重复**（重复 id 会让 cases/labels/sft 三个文件各持一份不同样本） |
| drift 行两树相同 | **0**（那是贴错标签的行，不是难题） |
| prompt 逐字节对齐交付包 | **0 mismatch**，含 54k 字符长输入 |
| `rdmd_trivial_baseline.py` 规则 E 定位 | **1.000 全绿** → 这些图都是**良定义任务实例**（唯一级联根），不是无解题 |
| 远端 dry-run 字符数 vs 本机 | 一致（10211 / 20648 / 54207） |

基线**没有在本节重写**，而是直接调用产出第 3 节那张表的同一个 `scripts/rdmd_trivial_baseline.py`
（`score_ood.py` 里 import 进来）。两处定义会漂移，而写错的基线会静默改写结论。

共 **43 行**：30 条 in-contract、13 条越界探针；其中 **10 条刻意造的「真凶仅派生字段可见」行**
（见 12.4 —— 这是模型唯一能胜过基线的子集，第一版探针把它漏掉了，等于只测了容易的一半）。

### 12.3 结果：规模与形状外推不退化

模型（`deploy/predict.py` + `qlora-v3` adapter，训练机 GPU 单卡）在 43 条上全部 1.000，
**0 invalid、0 warning**，并且**没有一行因输入过长而失败**：

| 规模（星图节点数） | n | 基线定位 | 模型定位 | 基线 type | 模型 type | 状态 | 弃权 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 16（合法，未见过） | 6 | 1.000 | **1.000** | 1.000 | **1.000** | 1.000 | 1.000 |
| 24（合法，未见过） | 13 | 1.000 | **1.000** | 0.500 | **1.000** | 1.000 | 1.000 |
| 32（合法，未见过） | 11 | 1.000 | **1.000** | 0.667 | **1.000** | 1.000 | 1.000 |
| 48（越界） | 7 | 1.000 | **1.000** | 0.500 | **1.000** | 1.000 | 1.000 |
| 80（越界） | 6 | 1.000 | **1.000** | 0.500 | **1.000** | 1.000 | 1.000 |

四种未见形状（`chain_side / wide_fan / layered_mesh / nested_diamond`）**各自也都是 1.000**。

三点值得单独说：

- **长度外推没有出现任何症状。** 训练 prompt 最长 13016 字符，本探针最长 54207 字符
  （43 行里 37 行超出训练长度带），模型照常给出合法判定。原先「超过训练长度即不可用」的担心
  在本探针范围内**没有被证实**。
- **越界到 80 节点仍未断裂。** 这是「找不到断裂点」，不是「支持 80 节点图」—— 见 12.5。
- 交付包的逐字节契约在 5 倍长度、含重复标题的输入上依然成立。

### 12.4 最有价值的一格：派生字段子集上基线无信号，模型全对

按「真凶身上能看到什么」分层，模型与基线的分野就在这里：

| 分层 | n | 基线定位 | 模型定位 | 基线 type | 模型 type |
| --- | --- | --- | --- | --- | --- |
| drift：原因字段可见 | 13 | 1.000 | **1.000** | 1.000 | **1.000** |
| **drift：仅派生字段可见** | 10 | 1.000 | **1.000** | **0.000** | **1.000** |
| no_drift | 16 | 1.000 | **1.000** | — | — |
| UNKNOWN（弃权） | 4 | 1.000 | **1.000** | — | — |

「仅派生字段可见」指真凶在 `inputs / agentId / version / acceptance` 四个原因字段上**毫无变化**，
只能从 `artifact / output / summary` 的涟漪反推。规则 E 靠原因字段判 type，因此在这一格
**没有任何信号（0.000）**；而模型 10/10 全对。这与 v3 test 上的模式一致
（模型 0.9985 vs 基线 0.000），**并且现在是在未见过的形状与规模上成立的**。

这一格的探针整体 type 难度也校准得住：基线整体 type 0.565，v3 test 是 0.527。

### 12.5 边界（不因为全绿就省略）

- **仍未测「新的漂移语义」。** 探针换的是图的规模与形状，**漂移的类型与改写形态仍来自同一个
  `lib/forms.mjs` 目录**。输出契约本身把 `type` 枚举死成 5 个，所以这不是探针缺陷，但
  「换一种业务上的漂移方式」并未被验证。
- **规模 16 覆盖最薄**：只产出 1 条 drift。小图放不下「一个级联 + 一个级联外诱饵」，
  门禁会拒掉这些行 —— 是结构性限制，不是随机缺失。
- **48 / 80 不是合法任务实例**（schema 上限 32 节点）。它们只用来找断裂点，
  结论是「**到 80 节点仍未断裂**」，**不是**「支持 80 节点的图」。
- **依然是合成数据。** 仓库里没有带金标的真实计划数据，而真实流程的「唯一级联根」性质未必成立
  （可能有多个互不相交的真因、或真因就在末端）。真实数据上目前只能测「与规则的一致性」，
  **不能测正确性**。
- **天花板依旧被定义死。** 基线定位 1.000，模型不可能超过（第 6 节）。本节的结论是
  「**换规模、换形状、换长度不散架**」，**不是**精度优势 —— 这一点和第 11.4 节一致。

### 12.6 顺带修掉的两个真问题

- **`predict.py` 遇到单条坏输入会整批中断**，丢掉后面所有行。对一个「退出码直接驱动流水线」的入口
  这是不可接受的：一条超长或畸形输入必须降级成**这一条不可信**，而不是让整批消失。
  已加逐条兜底 `failure_record()`（产出规范空判定 + `valid=false` + `inference_error:<Type>`），
  并把异常消息挡在记录之外（消息里可能内含超大 prompt 片段，会把输出文件撑爆），
  配套 3 项单测（共 24 项）。
- **`qlora_config.json` 里 `unknownInMainLoss: false` 是 v2 残留**，与 `sft/manifest.json` 的
  `mainLoss: [drift, no_drift, UNKNOWN]` 直接矛盾 —— 而这正是 v3 最核心的修复。
  训练器读的是 manifest（`train_qlora_rdmd.py:100`），所以行为一直是对的，但**文档在说反话**。
  已改为 `true` 并标注权威来源。

### 12.7 复现

```bash
# 1) 造探针（本地，无 GPU）
node experiments/rdmd_detective_dataset/make_ood.mjs
python experiments/rdmd_detective_dataset/score_ood.py            # 只看基线 + 探针自检

# 2) 上机推理（训练机 GPU）
python scripts/rdmd_remote_put.py experiments/rdmd_detective_dataset/data/ood_cases.jsonl \
    experiments/rdmd_detective_dataset/data/ood_cases.jsonl
python scripts/rdmd_ssh.py --command-file scripts/_rdmd_ood_e2e.sh --timeout 3600

# 3) 取回并打分
python scripts/rdmd_remote_get.py /root/autodl-tmp/rdmd-deploy/ood_verdicts.jsonl \
    experiments/rdmd_detective_dataset/ood_verdicts.jsonl
python experiments/rdmd_detective_dataset/score_ood.py \
    --verdicts experiments/rdmd_detective_dataset/ood_verdicts.jsonl
```

证据文件：`data/ood_cases.jsonl`（输入）、`data/ood_labels.json`（标签+自检）、
`ood_verdicts.jsonl`（模型原始判定）、`ood_predict.log`（逐条日志）、`data/ood_summary.json`（汇总）。

## 13. 对抗探针：该弃权的时候会不会硬猜

> **2026-09-19 更正指向（P4）**：同上，本节的分组表来自 `data/adv_summary.json`，
> 它来自一个更早的探针版本（`byScale` 当时只有一组 `20`，今天的 `scale` 是真节点数
> `20/27/28/29`）。更要紧的是：`adv_verdicts.jsonl` 的 60 个 id 里**有 35 个
> 在今天 60 行的标签里不存在**（旧命名 `_220.._249` vs 今天 `_2.._60`），
> 所以本节的模型列**无法**用今天的语料复现。基线列已由 `data/adv_baseline.json` +
> `npm run experiment:rdmd-ood:gate` 重新钉住，其中「2 行标签与基线不一致」是
> 被显式记下的不变量。详见 `ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md` §14。

第 12 节测的是**规模、形状、长度**换掉之后散不散架。它有一个共同点：每行都仍然满足训练数据的
**「唯一级联根」**保证。本节问一个更尖锐的问题 —— **把这条保证打破会怎样**。

### 13.1 为什么不找人或模型来标注

一度考虑过「找真实计划数据，由更强模型或人工标注真因」。这条路在本任务上是**循环论证**，必须说清楚：

标注者（无论人还是模型）能看到的证据**就是同样两棵树**，而唯一可读的解释就是
「最早那个有级联的变化节点」—— 也就是规则 E。于是「与标注一致」测的是**与规则 E 一致**，
不是正确性。标签只有是**独立事实**（真实事故记录里的原因）才有价值，而本仓库对此任务的
树对契约**不存在**这种数据（已查：JSON 数据里没有任何 postmortem/RCA 字段）。

所以本节改成：**由契约本身定义正确答案**，不做任何标注。

> `DETECTIVE_INSTRUCTION`：存在多个不相交原因或证据不足时 status=UNKNOWN，不要编造唯一凶手。

两个及以上不相交原因 → UNKNOWN。这是**定义**，不是口味。

### 13.2 分布外的依据是**从语料里量出来的**，不是声明的

`make_adversarial.mjs` 每次运行都重读 `data/all.jsonl`，并**硬断言**下列前提；前提一旦不成立就
直接报错退出，而不是把探针悄悄变成同分布测试：

| 量出来的事实 | 值 |
| --- | --- |
| 全部 12000 行 | drift 10000 / UNKNOWN 1000 / no_drift 1000 |
| UNKNOWN 行的原因个数分布 | **只有 2**（1000/1000） |
| UNKNOWN 行的 visibility 取值 | **只有 `visible`**（1000/1000） |

第二行说明：训练里的 UNKNOWN **永远是两条原因**；第三行说明：**没有一次**是「原因字段无变化、
只有派生字段可见」（`subtle: true`）的多原因行。于是本节的探针家族是：

- **`two_derived_cause`（分布外）**：两条独立原因，**第二条仅在 `artifact/output/summary` 可见**。
  契约答案 UNKNOWN。它**通得过**数据集门禁（合规但从未生成），与第 12 节的规模形状探针同一种意义。
  这也是最能诱导模型「只看见一条原因就报它」的形状。
- **`single_control`（对照）**：单原因 + 诱饵，必须**干净通过门禁**。用来抓「无脑全弃权」的模型 ——
  否则上面那栏会被一个永远答 UNKNOWN 的模型刷满分。

### 13.3 顺带撞出来的两条结构性边界

1. **「三条独立原因」在这个图族里不可能存在。** 图是「主线 + 短侧轨」，两两不可比的节点集合
   最大只有 **2**（已暴力枚举验证）。这也解释了为什么生成器的 UNKNOWN 行**永远是 2 条** ——
   是图族的性质，不是设计选择。所以没有「3 原因」这一行可测。
2. **「无关的非级联噪声」也不可能。** 任何在真凶因果邻域之外的节点都是**汇回主线**的侧轨，
   而主线在真凶下游已经变了，因此这类节点**必然有已变化的后代**。
   相关的「无辜者拖着自己级联」家族**造出来后被删掉了**：要让它是独立的一行，就必须把该无辜者写进
   `injected_nodes`，而一旦写进去门禁就接受它、它也就退化成一条**普通双原因行**（只是文案被手改过）。
   它携带不了分布外主张，把它当证据就是夸大。**这个否定结论比那一行更有用。**

### 13.3a 顺带确认的一个生成器隐患（已查清，不影响训练数据）

造这批行时反复撞到一个真实缺陷：`addDecoyNodes` 有时会造出 **repair 节点，但不把它们放进返回的
`decoys` 列表**，于是数据集门禁报 `extra_node_unexplained:repair_*`。

- **不影响已发布的训练数据**：门禁在生成时就跑（`generate.mjs` 的 `validateSample`），
  这类行**当时就被拒了**，12000 行是干净的。本次也量过：1000 条 UNKNOWN 行没有一条带这类错误。
- **影响只是候选浪费**：本次 30 个对照格里被它拒掉 4 格；OOD 探针里也偶发。
  两处都是**跳过该格**，不会把标签写错的行发出去。
- **本次没有修它**：属于产出率问题而非正确性问题，且门禁已经把它挡住了。修它要动
  `localDecoy` 的 repair 分支，属于另一件事，留作已知项。

### 13.4 结果：弃权率 0.833，基线 1.000，失败机制**完全一致**

模型（`deploy/predict.py` + `qlora-v3` adapter，训练机单卡）在 60 行上 **0 invalid、0 warning**：

| 家族 | n | 基线 status | 模型 status | 基线定位 | 模型定位 | 基线 type | 模型 type |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `single_control`（对照） | 30 | 1.000 | **1.000** | 1.000 | **1.000** | 1.000 | **1.000** |
| `two_derived_cause`（弃权） | 30 | 1.000 | **0.833** | — | — | — | — |

- **弃权率 25/30 = 0.833，Wilson 95% CI [0.66, 0.93]**，基线 30/30 = 1.000。
- **对照 30/30 全对**（定位与 type 都 1.000）→ 模型不是无脑弃权，上表那一栏是真的下降。
- 交付包的 prompt 逐字节契约再次 0 mismatch。

### 13.5 五次失败是同一个机制（这才是本节最有价值的部分）

逐行拆开 5 个失败（`_inspect_adv_failure.py`）：

| 检查 | 结果 |
| --- | --- |
| 报出的节点**是真原因之一** | **5/5** |
| 报出的节点**是级联根** | **5/5** |
| 报出的都是**唯一在 `inputs` 上可见**的那条原因 | **5/5** |
| 报出的 `type` | **5/5 都是 `missing_dependency`** —— 正是「`inputs` 变了」推出的那个类型 |
| **栽赃无辜节点** | **0/5** |

也就是说：模型一旦看见**一个**可见的原因字段变化，就把它当成**唯一凶手**报出去，
而**完全忽略**那条只在派生字段里留痕的第二原因。它的失败是**漏报第二原因**，
不是**冤枉好人** —— 这个区分对生产很重要，但仍然是违约（契约要求 UNKNOWN）。

有一行还能看到它**半看见了**第二条原因却仍不弃权：
`two_derived_cause_230` 的 `evidenceNodeIds` 是 `['n4','n7','n1']`，其中 `n1` **正是那条派生字段原因**，
但 `status` 仍报了 `drift`（nodeId=n4）。

把这一节和第 12.4 节并排看，结论就更锋利：

- **单原因 + 仅派生字段可见**：模型 1.000，规则基线 type **0.000** —— 模型完胜（第 12.4 节）。
- **两条原因、其中一条仅派生字段可见**：模型 0.833，基线 **1.000** —— 模型**输了**。

**同一个能力（读派生涟漪）一旦旁边出现一个可见的原因字段，就不再被用上。** 这是 v3 目前
最值得针对的弱点：不是读不出来，而是**被一个显眼的信号劫持了判断**。

### 13.6 边界（不因为结论好用就省略）

- **这只是 30 行的一个家族。** 0.833 的 CI 是 [0.66, 0.93]，说明确实低于 1.0，但样本仍小。
- **只测了一种「半可见」形态**：可见的那条在 `inputs`、不可见的那条纯派生。
  反向（可见的在 `agentId/version/acceptance`）、或两条都派生，都**没有测**。
- **仍不是真实数据。** 两条原因都是合成注入；真实流程里的多真因形态（时间上先后、互相掩盖）
  未必长得像这样。
- **不可能测到的部分已在上文说明**：3 原因、非级联噪声，是图族的结构限制。

### 13.7 复现

```bash
# 1) 造探针（本地，无 GPU；会重读 all.jsonl 并断言分布前提）
node experiments/rdmd_detective_dataset/make_adversarial.mjs
python experiments/rdmd_detective_dataset/score_ood.py \
    --labels experiments/rdmd_detective_dataset/data/adv_labels.json \
    --cases  experiments/rdmd_detective_dataset/data/adv_cases.jsonl \
    --sft    experiments/rdmd_detective_dataset/sft/adversarial.jsonl

# 2) 上机推理（训练机 GPU）
python scripts/rdmd_remote_put.py experiments/rdmd_detective_dataset/data/adv_cases.jsonl \
    experiments/rdmd_detective_dataset/data/adv_cases.jsonl
python scripts/rdmd_ssh.py --command-file scripts/_rdmd_adv_e2e.sh --timeout 5400

# 3) 取回、打分、拆失败
python scripts/rdmd_remote_get.py /root/autodl-tmp/rdmd-deploy/adv_verdicts.jsonl \
    experiments/rdmd_detective_dataset/adv_verdicts.jsonl
python experiments/rdmd_detective_dataset/score_ood.py \
    --labels experiments/rdmd_detective_dataset/data/adv_labels.json \
    --cases  experiments/rdmd_detective_dataset/data/adv_cases.jsonl \
    --sft    experiments/rdmd_detective_dataset/sft/adversarial.jsonl \
    --verdicts experiments/rdmd_detective_dataset/adv_verdicts.jsonl
python experiments/rdmd_detective_dataset/_inspect_adv_failure.py   # 逐行拆 5 次失败
python experiments/rdmd_detective_dataset/_adv_ci.py                # 表里那两条 Wilson 区间
```

证据文件：`data/adv_cases.jsonl`（输入）、`data/adv_labels.json`（标签+门禁结论）、
`adv_verdicts.jsonl`（模型原始判定）、`adv_predict.log`（逐条日志）、`data/adv_summary.json`（汇总）。

## 14. 接入 uBuddy：缺口在哪一层，以及怎么定量确认

第 11–13 节证明的是**在训练契约内**模型可用。本节回答另一个问题：
**能不能接进 uBuddy 流程**。答案是不能直接接，而且原因不是「还没写服务层」。

> **本节订正于 2026-09-15，并于同日完成实测。** 初版把 `normalizeTaskGraph`（公开记忆投影）当成了 uBuddy 唯一的
> 任务图，据此断定「层不对」。**那只对投影层成立，对整个数据层不成立** —— uBuddy 里还有
> `collaboration_graph_*` 这套**同层的任务步骤树**（14.2）。所以结论从「层不对」改成
> 「**这一层的规模与填充率尚未量过**」，并转入数据侦察（14.6）。
>
> **2026-09-16 二次订正：上面那句「侦察已完成：路 A 不成立」已撤回。**
> 本轮查明 `collaboration_graph_*` **从未在任何已安装构建中存在**（两个构建 `app.asar` 全量字节搜索：
> `collaboration_graphs` / `ensureUBuddyCollaborationGraphSchema` / `collaborationGraphStoreMethods`
> 全部 **ABSENT**，而 `migrateDatabase` / `task_nodes` / `task_graph_revisions` 全部 FOUND；
> 两个真实库中四张表全部 MISSING）。**那次实测从未观测过协作图**，测的是上游 `task_nodes` 合成物。
> 正确表述是：**路 A 从未被观测，而不是已被证伪**。
> 另有一层此前被漏掉且**已实测存在**的长程数据源：agent 的 Codex rollout
> （21 个 JSONL / 17.4 MB；单个 `task_node` ≈ 103 事件行、20 步推理、17 次工具调用，含 agent 间交互）。
> 详见 14.6 与 `ubuddy_recon/UBUDDY_RECON.zh-CN.md` 第 0 节、第 5.4–5.5 节。

### 14.1 uBuddy 侧已经有一个 RDMD 契约，但它没接进流程

`src/shared/contracts/uBuddyReverseDetective.js`（V4 阶段 3）已存在，提供 `detectMinimalDrift`、
`injectMinimalDrift`、`routeEvolution`。

**其中 `detectMinimalDrift` 就是第 12/13 节表里的 b_ 列**（那条规则基线）。
而它当前**没有任何产品运行时调用点** —— 引用它的只有实验脚本（`validate.mjs`、`prepare_sft.mjs`、
`v4_self_evolution_feasibility/run.mjs`）和它自己的测试。所以严格说，**连规则版都还没接进 uBuddy 流程**。

### 14.2 缺口在这一层：先分清 uBuddy 的两套图（2026-09-15 订正）

> 本节原先写的是「uBuddy 缺 `artifact, stage, inputs, output, summary` 全部 5 个」。
> **那句只对公开记忆投影成立，对整个 uBuddy 数据层不成立。** 当天查代码时发现 uBuddy 里
> 有**两套图**，我最初只看到了窄的那一套：

| | `normalizeTaskGraph`（公开记忆投影） | `collaboration_graph_nodes`（协作图） |
| --- | --- | --- |
| 位置 | `src/shared/contracts/uBuddyTaskPublicMemory.js` | 迁移 `094`；`cloud/.../collaborationGraph.mjs` |
| 节点 | 任务节点的窄投影 | 任务步骤（`kind ∈ {root,ubuddy,agent_task}`，`depth ≤ 2`） |
| 字段 | `id, title, agentId, version, acceptance, role, status` | 上述 + **`public_summary`** + `parent_node_id` + `progress` + `source_revision` |
| 散文 | **无** | **有**：`public_summary ← node.resultSummary` |
| 变更流 | 无 | **有**：`collaboration_graph_events.graph_revision` |
| 活写入通路 | — | **源码有，部署无**：`collaborationGraphStoreMethods.js` → `runtime.js:1150` → `POST /api/collaboration/graph`。**2026-09-16 订正**：该通路**从未在任何已安装构建中部署**（见本节开头二次订正） |

**关键**：`agent_task` 节点的散文取自该步的 `resultSummary`
（`publicTaskNodeSummary()`：`resultSummary → waitReason → errorText → objective`）。
也就是说第 12.4 节里模型相对基线的全部优势（真凶仅派生字段可见时规则 `type` 0.000 / 模型 1.000）
在协作图里**有真实载体**。

逐字段映射（基于真实 schema）：`direct` 4（`id/title/agentId/summary`）、
`weak` 1（`version ← source_revision`，是修订计数不是语义版本）、
`missing` 6（`role/acceptance/artifact/stage/inputs/output`）。
但「missing」要读成「**没有专属列**」，不是「没有内容」—— 散文主体被挤进了 `public_summary`。

还有一条硬约束：`depth` 被 `CHECK(depth BETWEEN 0 AND 2)` 钉死、`agent_task` 恒为 `depth 2`，
所以协作图是**三层树**，而训练语料是 **16–28 节点长程图**。图族不像。

**所以缺口的性质变了**：不是「uBuddy 没有这一层」，而是「这一层在真实数据里规模与填充率成不成立」。
这是一个**可以用数据回答**的问题，因此转入数据侦察：
`ubuddy_recon/UBUDDY_RECON.zh-CN.md`（七项测量 + 判定矩阵，无需 GPU）。

另外，产品规则对散文层仍然是瞎的：`contrastDriftGraphs` 只比
`title/agentId/version/acceptance` + 边 —— 实测一个**只在 `inputs/output/summary` 上的改动，
产品规则直接判 `no_drift`**。

### 14.3 最危险的是**静默降级**，不是报错

`public_graph` 会把缺失字段归一成**空字符串**，于是整条链全绿：

| 检查 | 结果 |
| --- | --- |
| prompt 构建 | **成功**（1793 字符 vs 训练 11221–13016，短 6 倍） |
| 模型看到的节点 | `"artifact":"", "stage":"", "inputs":"", "output":"", "summary":""` |
| `validate_verdict` | **`[]` 空警告**（它只查 `nodeId` 是否在图中，防幻觉，不查输入是否够丰富） |
| 模型输出 | 一个**自信的判定**，不再代表任何已测得的准确率 |

**没有任何运行时症状。** 这是集成里最坏的失败形态。

### 14.4 已落地的 fail-closed 守卫

判据**从语料量出来**，不是估计：

| 盘 | 图数 | 节点实例 | 5 字段为空 |
| --- | --- | --- | --- |
| train / test / ood / adversarial | 10,332 | **207,356** | **0** |

即「任一节点任一富文本字段为空」= 出了训练支持集，而守卫**在这批语料上不可能误伤**。
只检查这 5 个字段、**不**检查 `title/role`：没被测量过的字段写进守卫就会误伤，
**会误伤的守卫比没有守卫更糟**。

| 入口 | 行为 |
| --- | --- |
| `check_case_contract(case)` | 逐节点返回问题列表（空 = 可推理） |
| `build_case_prompt(case)` | 有问题抛 `InputContractError`（唯一咽喉，`Detective` 绕不过） |
| `predict.py --dry-run` | 报出问题并 **exit 1**（即「验契约」模式） |
| `predict.py` 正式推理 | 逐条先查契约，不合格 → `valid=false` + `input_contract_violation:` 警告，**不占 GPU** |

实测：uBuddy 形状输入 **exit 1**；43 行 ood 与 60 行 adversarial **exit 0**（无误伤）。
守卫单测 5 项，交付契约共 **29 项**全过。

### 14.5 输出侧零改动

模型输出 `{status, nodeId, edgeId, type, evidenceNodeIds}`，产品 `routeEvolution()` 正好消费
`{status, type}`，5 个 type 枚举完全一致 —— **下游接口不用改，缺的只是上游数据**。
另注意第 13 节的弱点在这会放大：产品规则在「多于一个级联根」时返回 `UNKNOWN`，**比模型更安全**。

### 14.6 四条路（**2026-09-16 二次重排**，见 `deploy/INTEGRATION.zh-CN.md`）

> **上一版这里写「路 A 的可行性已定量确认，结论是否定的」，并给出「三条路」。该判定已撤回**（理由见本节开头）。

| 路 | 判断（2026-09-16） |
| --- | --- |
| **A** 从**协作图**取数（`collaboration_graph_*`，含 `public_summary`），在 uBuddy 原生字段上重训 | **未观测，不能判死。** 缺口在**部署**：功能代码自 2026-08-27 在仓库里，从未进入任何构建。仅有的**有效**约束是该投影 `depth ≤ 2`、且 `dependency_of` 边只来自 `dependencies_json`（实测全 `[]`）→ 组织层成图是三层树 + 零依赖边 |
| **A′（新增）** 从 **agent 长程层**（磁盘 Codex rollout JSONL）投影 `G_exec` | **当前最值得做。** 已实测：21 个 `rollout-*.jsonl` / **17.4 MB**；单 `task_node` ≈ **103 事件行**（20 步推理 + 17 次工具调用 + 12 条消息，样本最高 228）；含 `send_message` / `sub_agent_activity` / `inter_agent_communication_metadata`。**唯一已实测同时具备尺度与交互性的长程图源** |
| **B** 在 `normalizeTaskGraph` 的 6–7 字段投影上重训 | **预期无收益**（未变）：能读的信息与规则相同，规则在同一输入上已接近满分 |
| **C** 先不接模型，用 `detectMinimalDrift` | **兜底项**（未变）：不依赖数据形状，现在就能用。需接受它在派生字段上判 `type` 为 0.000 |

**仍然有效的实测数字**（对**所测对象**成立，保留）：

- **零条依赖边** —— `dependencies_json` 在两库**全量** 9 个节点上都是 `[]`；经投影代码验证
  （`normalizeTaskNode` → `collaborationGraphStoreMethods.js:226-230`）它是 `dependency_of` 边的**唯一来源**，
  所以**即便投影出来边数也恒为 0**。这描述的是 **uBuddy 组织层**，不是整图。
- 图规模 p50=**1** 节点（最大 2）；13 个 revision **100% 是 `add_fallback_node`**（重试循环）；
  两库合计 **7 个 task_run / 9 个 node**。
- 唯一 PASS 是富文本载体（逐图全填 100%）。

**已撤回的三条推论**（原版在此处，逐条说明为什么错）：

1. 「没有级联就没有唯一级联根，任务定义无法提出」→ **越界**：只对组织层成立，长程层有交互与级联。
2. 「载体再好也没有承载它的图族」→ **证据不足**：从未观测过协作图，不能断言没有图族。
3. 「『等结构产生』已排除 …… 上限低于模型的地板」→ **越界**：`MAX_NODES=8` 只约束 uBuddy 组织层，
   不约束 agent 长程层；而长程层的实测尺度（≈103 事件行/节点）**远高于** 16–28 的地板。

**没有写任何适配器** —— 在确认底料存在之前写适配器，就是把猜测固化成代码。
这条纪律**仍然有效**，本轮同样未产出适配器。

**边界**：A′ 目前只有**结构证据**（存在、够大、有交互），**不是**「RDMD 在长程层可行」的结论。
要下那个结论，需先定义 `G_plan`/`G_exec` 的构造规则、量出可训练样本量，并确认任务是否有**可判定的漂移真值**。

### 14.7 复现（无需 GPU）

```bash
node   experiments/rdmd_detective_dataset/ubuddy_contract_probe.mjs   # 产品侧字段/对比能力
python experiments/rdmd_detective_dataset/ubuddy_model_probe.py       # 模型侧静默降级
python experiments/rdmd_detective_dataset/ubuddy_model_probe.py \
    --emit experiments/rdmd_detective_dataset/data/ubuddy_shaped_cases.jsonl
python experiments/rdmd_detective_dataset/deploy/predict.py \
    --input experiments/rdmd_detective_dataset/data/ubuddy_shaped_cases.jsonl --dry-run   # exit 1

# 数据侦察（桌面端 SQLite 通路；分析器与测试不需要 GPU、不需要 PG）
node --test experiments/rdmd_detective_dataset/ubuddy_recon/ubuddy_recon.test.mjs
```

证据：`data/ubuddy_shaped_cases.jsonl`（uBuddy 形状输入）、`ubuddy_contract_probe.mjs` / `ubuddy_model_probe.py`；
侦察侧见 `ubuddy_recon/`。
