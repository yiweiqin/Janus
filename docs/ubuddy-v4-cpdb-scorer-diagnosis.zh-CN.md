# V4 CPDB 打分器诊断结论（2026-09-20）

这份文件回答的是 `ubuddy-v4-cpdb-scorer-training.zh-CN.md` **没有能力回答**的问题：
那两个 0.87 / 0.86 是"学到了"，还是"背下来了"。

答案：**背下来了**。而且结论比这更硬 —— 在当前这批标签上，
连"背"都不需要神经网络：一张 36 格的表就够了。下面是判据、数、和因此改了哪些决定。

---

## 一、一句话结论

**MLP 不被证实，交付表。** 但这一轮真正的发现不在模型上，而在**标签**上：

1. 手写契约在诚实口径下对 AI 标签只有 **0.0796 / 0.1400**（依赖 / 相似），
   **低于"永远猜众数"**（0.4451 / 0.6320）；
2. 同一批标签、同一批折上，一张 36 格 family 表拿到 **0.7657 / 0.7816**。

也就是说：**"该信哪套标签"这个决定的分量，远大于"用哪个模型"。**
这不是一个调参结论，是一个必须先回答、且只能由人回答的问题。

---

## 二、事先写死的判据

判据在跑之前写死（`train_scorer.py` 的 `PRE_REGISTERED_CRITERIA`），
因为这类诊断最常见的失败方式不是算错，而是**看到数之后再决定什么算成功**。

`ship.test.mjs` 会逐字检查下面这三行确实出现在本页里 —— 判据一旦被"事后润色"，
测试会红。原文：

```text
MLP 同档率 − 查表同档率 < 2σ → 模型不被证实，交表/规则
MLP 掉到接近 majority_global → 能力描述里没有可迁移信号，方案二前提需重做
MLP 明显赢过查表且赢过 logreg → 确有可迁移信号，进入下一轮
```

对应到动作：

| # | 判据 | 触发后的动作 |
|---|---|---|
| 1 | MLP 同档率 − 最强查表同档率 < 2σ | 模型不被证实，交表/规则 |
| 2 | MLP 掉到接近 `majority_global` | 能力描述里没有可迁移信号，方案二前提需重做 |
| 3 | MLP 明显赢过查表**且**赢过 logreg | 确有可迁移信号，进入下一轮 |

**裁决对象**（`VERDICT_SUBJECT`）：`facet 折 × no_identity 特征 × similarity 轴`。
选它是因为它是唯一既扣掉身份恒等列、又留出整个角色的格子 ——
也就是唯一一个能回答"换一个没见过的人还能不能打"的格子。

---

## 三、为什么原来的 test 不算泛化

原来那份 799 条的 `test` 是按 `orgId` 切的。它挡住了**组织**，但没挡住**角色**：

| 泄漏面 | 占比 |
|---|---:|
| `test` 里的 pair 落在训练见过的 `(facetL, facetR)` 格子上 | **99.0%** |
| `test` 里的 Agent 在训练集里出现过 | **79%** |

所以 0.870 是**同分布内的插值**，不是泛化。更要紧的是：这个数**从来没有人断言过它不泄漏** ——
`lib/splits.mjs` 与 `splits.test.mjs` 是补这一课的，现在四种折都逐条断言了
`eval ∩ train = ∅`（把留出的组漏回训练集一条，这一折就又变成"见过的组"了）。

现在的四种折，各自回答一个不同的问题：

| 折 | 留出什么 | 回答的问题 |
|---|---|---|
| `org` | 整个组织 | 换一个组织还行不行（**对照组**：已知 99% 泄漏，用来验证诊断能抓到泄漏） |
| `facet_pair` | 某些 `(facetL, facetR)` 组合 | 换一对没见过的角色组合 |
| `facet` | 某些 `facet` 整体（两侧） | **换一个没见过的人** ← 裁决用这个 |
| `family` | 某些粗粒度职能整体 | 换一个没见过的**职能**（最难） |

---

## 四、结果：2×4 矩阵（AI 标签，5 个种子）

同档率（exact），`facet` 折（裁决格）：

| 特征集 | 列数 | 轴 | MLP | logreg | family 表 | facet 表 | 众数 |
|---|---:|---|---:|---:|---:|---:|---:|
| `full` | 92 | similarity | 0.7669 | 0.7048 | **0.7816** | 0.6113 | 0.6320 |
| `full` | 92 | dependency | 0.7156 | 0.7263 | **0.7657** | 0.6113 | 0.6320 |
| `no_identity` | 32 | similarity | 0.7477 | 0.7295 | **0.7816** | 0.6113 | 0.6320 |
| `no_identity` | 32 | dependency | 0.7332 | 0.7343 | **0.7657** | 0.6113 | 0.6320 |

`family` 折（换一个没见过的**职能**，最难）：

| 特征集 | 轴 | MLP | family 表 = 众数 |
|---|---|---:|---:|
| `full` | similarity | 0.5439 | **0.5899** |
| `no_identity` | similarity | 0.5544 | **0.5899** |
| `no_identity` | dependency | **0.5937** | 0.3833 |

三件事同时成立：

1. **表赢 MLP**（裁决格上 0.7816 vs 0.7669/0.7477）；
2. **`full` 并不比 `no_identity` 好** —— 拿掉身份恒等列几乎没有代价，这本身就是
   "模型没在用身份"的一个侧面证据（但注意：`full` 在 facet 折上**按构造**不可能靠恒等列取胜，
   因为那些列训练全程为 0）；
3. **换职能时 MLP 的相似度低于众数**（0.5544 < 0.5899）。

第 3 条最要紧。它不是说"模型没调好"，而是说：**标签里几乎没有超出 `(familyL, familyR)` 的分辨率。**
规则 teacher 和 AI 判分都在主要对两侧的粗粒度职能起反应。标签里没有的信息，
参数再多也变不出来 —— 这正是判据 1 触发、交付表的原因。

**判据 2 也实质触发了**：`family` 折上 MLP 的相似度 0.5544 **低于** `majority_global` 的 0.5899。
按事先写死的口径，"掉到接近众数"就该考虑"能力描述里没有可迁移信号"这个可能 ——
本该更重。这里之所以没有据此推翻方案二前提，是因为**同一批标签下换一个折，
MLP 仍能赢过表**（`no_identity` 的 dependency：0.5937 vs 0.3833）。
两条一起看，结论收敛成一句更准确的话：**信号是有的，但它既不是非线性的、也不比"职能对"更细。**

### 换成 teacher 标签会怎样（同一批折、同一批特征）

| 折 | 轴 | MLP | logreg | family 表 | 众数 |
|---|---|---:|---:|---:|---:|
| `facet` | similarity | **0.9973** | 0.9963 | 0.9683 | 0.6805 |
| `facet` | dependency | **1.0000** | 0.8925 | 0.9760 | 0.5239 |
| `family` | dependency | **0.6397** | 0.5343 | 0.4529 | 0.4529 |
| `family` | similarity | **0.9956** | 0.9956 | 0.7884 | 0.7884 |

这张表读起来和 AI 标签**完全不同**，而它恰好是同一批特征、同一批折：

- teacher 标签在**换职能**（`family` 折）时几乎不掉（相似度 0.9956）—— 因为
  teacher 的相似度规则**本身就是按族算的**，留出整族对它没有杀伤力；
- 而 AI 标签在同一格上是 0.5544，**低于众数**。

也就是说：**折的难度不是固定的，是标签决定的。** 这反过来印证了第六节那个结论 ——
"用哪个模型"这个问题，在回答"用哪套标签"之前没有意义。

---

## 五、裁决

```
# 标签 = ai_judge_qwen3_8b_majority_v1
outcome: ship_table          （两轴一致）
  dependency  → ship_table   最强基线 lookupFamilyPair 0.7657，MLP 落后 0.0325
  similarity  → ship_table   最强基线 lookupFamilyPair 0.7816，MLP 落后 0.0339

# 标签 = prelabel_v1（teacher 规则自己）
outcome: ship_linear
  dependency  → continue     最强基线 lookupFamilyPair 0.9760，MLP 领先 0.0240
  similarity  → ship_linear  MLP 0.9973 vs logreg 0.9963（差 0.0010，在噪声内）
```

**两个标签来源下，MLP 都不该交付** —— 只是理由不同：

- 在 **AI 标签**上，一张 36 格表就够了（MLP 输给它 0.03，还低于换职能时的众数）；
- 在 **teacher 标签**上，teacher 的规则几乎就是**线性的**（相似度那一轴 logreg 与 MLP 只差 0.001），
  所以该交付的是线性模型；而 teacher 标签下的 1.000 本来就是复述规则的复述。

**继续做 MLP 没有意义。** 但"交付表"不等于"这件事没做成" ——
表里的值仍然是**从标签学来的**，它不会带上 teacher 那条"同族一律压到 0"的悬崖。
方案二想要的那个改进（按能力画像给分、而不是按族标签硬编码）**成立**，
只是承载它的东西是表或线性模型，不是网络。

### 达标的交付物

| 位置 | 是什么 |
|---|---|
| `artifacts/cpdb-scorer-v3-ship/table.json` | 36 格 × 2 轴 的分布表，13 KB，**折上泛化** 0.7657/0.7816 |
| `artifacts/cpdb-scorer-v3-ship/model/` | 训练好的 MLP（`no_identity`，全量数据），作为可选项保留 |
| `artifacts/cpdb-scorer-v3-ship/manifest.json` | 绑定：矩阵输入 sha256 / 折指标 / 产物 sha256 / JS-Python 对账结果 |
| `exports/cpdb-training-set-v1/` | 完整训练集（矩阵、折、标签、说明），能重训、能换标签、能自己比 |
| `src/shared/contracts/uBuddyCapabilityDependencyScorer.js` | 接进契约的适配层（唯一一份前向/查表实现） |
| `src/shared/contracts/uBuddyCapabilityPairFeatures.js` | 特征定义（唯一一份，训练与推理共用） |

交付产物与训练集包**分两处**存放，与 `export/ai-judge-v1/` 同一条纪律：
`artifacts/` 里的东西进版本库（表 13 KB、manifest、模型权重 835 KB），
`exports/` 里的东西是**发出去的交付包**（6 MB 派生量）不进库，靠 manifest 里的逐文件
sha256 钉住 —— 那串哈希正是"你复现的就是我交付的"这句话的唯一凭证。
`ship.test.mjs` 在缺包时会跳过并说明重建命令，不会把"包不在"变成假失败。

为什么表更好，除了准：

- **指标是真正的折上泛化**。表不需要训练，所以可以逐折留出；
  而全量重训的 MLP 只能报拟合值（0.7866/0.8151，那是它在自己见过的行上的成绩）。
- **可手改**。某一格看着不对，直接改那个数，不必重训、不必重新对账。
- **几 KB**，进安装包没有负担。

表相对契约的**代价**也说清楚：未知 family 对会回落到 `prior`，
此时这些 pair 之间**并列**（排序退化为按 agentId）。
这是已量化的（`family` 折 0.5899 = 众数），不是意外。

---

## 六、这一轮真正的发现：标签落差

把同一份契约放在四种折上、两种标签上量（`diagnose_contract.mjs`，
产物 `contract-vs-folds.json`）：

| 标签 | 折 | 契约 依赖 同档 | 众数 | 契约 相似 同档 | 众数 |
|---|---|---:|---:|---:|---:|
| `prelabel_v1`（teacher 自己的标签） | `facet` | 0.5686 | 0.5239 | 0.7460 | 0.6805 |
| `prelabel_v1` | `family` | 0.5774 | 0.4529 | 0.6712 | 0.7884 |
| **`ai_judge_qwen3_8b_majority_v1`** | `facet` | **0.0796** | 0.4451 | **0.1400** | 0.6320 |
| **`ai_judge_qwen3_8b_majority_v1`** | `family` | **0.0901** | 0.3833 | **0.1550** | 0.5899 |

读法：

- 契约在**它自己的标签**上勉强能站住（略胜众数）；
- 契约在 **AI 标签**上**远低于众数**。这不是"精度不够"，这是**两套政策**：
  teacher 把同族 pair 的依赖分一律压成 0（视作替代品），而 AI 判分读画像描述，
  同一对给 0.75。两者不是同一个函数的不同精度，是**不同的判断**。

所以：

> 在"用哪套标签"这个问题没被回答之前，"用哪个模型"是一个无法评价的问题。

这一轮把这两件事分开了，也就把真正需要人做的那个决定**暴露出来**了：

1. **相信 teacher 规则** → 那本来就有规则了，不需要模型（`prelabel_v1` 上 MLP 是 1.000，
   那是复述）。方案二只需要保留 `updateDependencyScore` 的指数递减那部分。
2. **相信 AI 判分** → 那就得先解决 AI 判分的稳定性问题：它对**提问措辞**敏感，
   不同 framing 之间的 qwk 只有 0.2–0.3。多数投票压住了一部分噪声，
   但压不住"问法决定答案"这件事。
3. **人工标注** → 目前标签库里**一条人工标注都没有**
   （`human_labels.jsonl` 的 annotator 只有 `prelabel_v1/prelabel` 与
   `ai_judge_qwen3_8b_majority_v1`；`diagnose.test.mjs` 在守这条断言，加了人工标注它会红）。
   这是唯一能把上面两个选项分开的办法。

---

## 七、两个必须一起看的警告

### 1. 构造规则探针：特征编码了"这一对为什么被采进来"

用同一批特征做线性探针去预测 `kind`（四种采样类型）：

```
probeAccuracy = 0.9237        majorityRate = 0.2898（瞎猜的上界）
```

探针**明显**好于众数，说明能力画像里含有足够还原"这对是怎么被选进数据集的"的信息。
`kind` 本身没进特征（有泄漏闸守着），但特征与它高度统计相关。
后果是：**模型学到的可能有一部分是"这两条为什么被采进来"**，
而服务期不存在这个变量。这条警告对表和 MLP 同时有效 ——
换一批采样方式（不是换一批人）就会改变分数，所以采样的改变必须重出产物。

### 2. `family` 折上的 dependency：表塌了，MLP 没塌

`no_identity` 上 dependency 是 0.5937（MLP）vs 0.3833（表 = 众数）。
这是唯一一格 MLP **明显**赢过表的地方，方向合理：整族被留出时，
表在这个格子上没有任何样本可用，而 MLP 还能靠内容特征推。
但它不足以推翻裁决 —— 裁决格是 `facet`（更贴近"换一个人"这个真实场景），
而且这一格的 MLP 也还没赢过同类折上的众数（0.5899）。

**记下来，作为将来如果要做"跨职能迁移"时的起点。**

---

## 八、怎么复现

```bash
# 0) 训练矩阵（两种标签各一份）
node export_training_matrix.mjs --labels data/full/human_labels.jsonl --out train_out
node export_training_matrix.mjs --labels data/full/ai_labels_qwen3_8b_v1.jsonl --out train_out_ai

# 1) 诊断矩阵：4 种折 × 2 个特征集 × 5 个种子。**两种标签各跑一次**
python train_scorer.py --diagnose --matrix-dir train_out_ai \
  --diagnose-out artifacts/cpdb-scorer-diagnosis/diagnosis-aijudge.json
python train_scorer.py --diagnose --matrix-dir train_out \
  --diagnose-out artifacts/cpdb-scorer-diagnosis/diagnosis-teacher.json

# 2) 契约 vs 四种折（两种标签一起量）
node diagnose_contract.mjs

# 3) 交付产物 + 训练集打包（含 JS 侧重算折指标、JS/Python 逐条对账）
python train_scorer.py --fit-table --matrix-dir train_out_ai --out artifacts/cpdb-scorer-v3-ship
python train_scorer.py --fit-all --variant no_identity --matrix-dir train_out_ai --out artifacts/cpdb-scorer-v3-ship/model
node ship_bundle.mjs
```

**不要把两种标签的片段合并成一份。** `merge_diagnosis.mjs` 是用来把**同一批标签下、
按方案拆到不同进程**的片段拼回去的（4 方案 × 2 变体拆成 4 个进程时用它）。
teacher 与 aijudge 是**两批不同标签**，同 `(方案, 变体)` 的格子会在合并时撞键 ——
它会报错（`cpdb_merge_duplicate_cell`）而不是悄悄覆盖，但那是在提醒你：
这两份报告本来就不该合成一个结论。裁决只能从 `diagnosis-aijudge.json` 读
（它是决策相关的那一批，`defaultScorer` 也是按它定的）。

判据、折、清单都进了测试：`npm run experiment:cpdb-scorer:test`
（`splits.test.mjs` 断言折不相交，`diagnose.test.mjs` 断言产物出处，
`scorer.test.mjs` 断言 JS/Python 逐条一致，`ship.test.mjs` 断言交付包与训练集对得上）。
`ship_bundle.mjs` 还会用 **JS 侧**的表把 Python 算的折指标重算一遍，
不一致就直接失败 —— 这一条防的是"报告里的数字与线上用的表不是同一个函数"。
