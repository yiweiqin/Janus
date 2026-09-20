# V4 方案二：CPDB 打分器训练报告（v1-teacher / v2-aijudge）

> **⚠️ 这份报告是"训练过程"的记录，不是"效果"的结论。它的两个 0.87/0.86 都是同分布内的插值，
> 不是泛化 —— 那份 799 条的 test 里有 99.0% 落在训练见过的 `(facetL, facetR)` 上。
> 泛化口径、四条判据与最终裁决见 [`ubuddy-v4-cpdb-scorer-diagnosis.zh-CN.md`](./ubuddy-v4-cpdb-scorer-diagnosis.zh-CN.md)。
> 结论是：MLP 不被证实，**交付的是 36 格 family 表**；而这一轮真正的发现是
> **标签选择的分量远大于模型选择**。本文件里凡出现"测试集 0.87"的地方，请按上面那条读。**

> 配套代码：`experiments/cpdb_org_world/{lib/features.mjs, export_training_matrix.mjs, train_scorer.py, judge_with_local_llm.py, scorer.mjs}`
> 配套产物：`experiments/cpdb_org_world/artifacts/cpdb-scorer-{v1-teacher,v2-aijudge}/`；
> **交付产物**在 `artifacts/cpdb-scorer-v3-ship/`（表 + 模型 + manifest）
> 协议见 `docs/ubuddy-v4-cpdb-protocol.zh-CN.md`（依赖分与相似度必须分开，禁止合成总分）。

> 代码位置变更：特征与打分器前向**已搬到** `src/shared/contracts/uBuddyCapabilityPairFeatures.js`
> 与 `src/shared/contracts/uBuddyCapabilityDependencyScorer.js`（调用方是应用，而 `experiments/`
> 不进安装包）。本目录下的 `lib/features.mjs` / `scorer.mjs` 只剩一行 `export *` 转发，实现只有一份。

## 一句话结论

两个版本都训出来了、都能在 JS 侧逐条复现。**它们的意义完全不同**：

- `v1-teacher` 拿到测试集 **100% 同档**。这不是「学会了」，是**复述了一条确定性规则** —— 它的价值在于证明特征集足够还原规则，不能当成绩。
- `v2-aijudge` 拿到测试集 **依赖 87.0% / 相似 85.7% 同档**。**这个数后来被证实是插值，不是泛化**
  （99.0% 的 test pair 落在训练见过的 facet 对上；换成留出整个角色的 `facet` 折后，
  同样特征的 MLP 掉到 0.7332/0.7477，而一张 36 格的 family 表是 0.7657/0.7816）。
  仍然成立的结论只有一半：AI 判出来的打法与仓库里 shipped 的规则**确实不是一回事**；
  但**它并没有被画像"学出来"到此为止** —— 能被学出来的那部分，粗到一个 36 格的表就能吃掉。

顺带一个必须在报告里写明的边界：**这套标签是「一次判决」，不是「标准答案」**。同一模型换一种问法，
两轴一致性只有 qwk 0.242/0.382；只有把问法钉死，它才稳（qwk 0.924/0.910）。详见「标签的底子」。

## 一、两个版本只差标签

特征、模型、协议、随机种子、划分全部相同，唯一变量是**标签来源**。这样指标差才能只归因于标签。

| | v1-teacher | v2-aijudge |
|---|---|---|
| 标签文件 | `data/full/human_labels.jsonl` | `data/full/ai_labels_qwen3_8b_v1.jsonl` |
| 标注者 | `prelabel_v1/prelabel` | `ai_judge_qwen3_8b_majority_v1/ai_judge` |
| 来源 | 仓库既有的规则 teacher | 盒子上本地 Qwen3-8B 判分，1 次贪心 + 3 次采样多数表决 |

矩阵：8282 个 pair，92 维特征，train/dev/test = 6705/778/799。
两轴的档次都是 5 档（`0 / 0.25 / 0.5 / 0.75 / 1`），两个头各出 5 类、不合成。

## 二、特征集与泄漏闸

特征全部来自**服务期拿得到的东西**：一对 Agent 的画像（family / facet / produces / consumes /
capabilityTags 等）。按名字分 6 块（有 3 列重叠，故合计 95 > 92）：

| 块 | 列数 | 内容 |
|---|---:|---|
| `flags` | 6 | `same_owner` / `same_org` / `same_domain` / `same_family` / `same_topic` / `same_facet` |
| `family_onehot` | 12 | 两侧粗粒度角色 |
| `facet_onehot` | 48 | 两侧细粒度角色（24 个 facet × 2 侧） |
| `flow` | 8 | 产物流向比、产出/消费规模 |
| `set_similarity` | 18 | 能力集合的 jaccard / 包含关系 |
| `not_in_profile` | 3 | `same_org` / `same_domain` / `same_topic`（只存在于 Agent 记录，published profile 里没有） |

**`kind` 绝对不许进特征**：它的四个取值与分数分布高度相关（`hard_negative` 两轴都低、
`cross_owner_similar` 相似度高）。混进来离线指标会很好看，而服务期根本不知道 kind —— 上线即失效，
且离线看不出来。`features.test.mjs` 里有一道专门的闸：把答案字段贴到画像上再算一遍，特征必须一个数都不变。

## 三、测试集（799 条）

> **这一节的数字是同分布内的插值，不是泛化。** 那份 `test` 按 `orgId` 切，挡住了组织但没挡住角色：
> 其中 **99.0%** 的 pair 落在训练见过的 `(facetL, facetR)` 上，**79%** 的 Agent 在训练集里出现过。
> 表里的"模型 同档"因此应当读作"模型在见过的角色组合上插值插得多准"。
> 泛化口径（留出整个角色 / 整个职能）见诊断页第四节；结论是 MLP 不被证实，交付 36 格表。

模型 vs 两个基线。基线是「在同一批标签上，不用模型能拿到多少」：

| 版本 | 轴 | 模型 同档 | 模型 ±1 档 | 多数类 同档 | 手写契约 同档 | 契约 ±1 档 |
|---|---|---:|---:|---:|---:|---:|
| v1-teacher | 依赖 | **1.000** | 1.000 | 0.529 | 0.596 | 0.921 |
| v1-teacher | 相似 | **1.000** | 1.000 | 0.725 | 0.751 | 1.000 |
| v2-aijudge | 依赖 | **0.870** | 0.974 | 0.481 | **0.094** | 0.492 |
| v2-aijudge | 相似 | **0.857** | 0.999 | 0.598 | **0.135** | 0.810 |

两处值得盯着看：

1. **v1-teacher 的 1.000 是复述，不是泛化。** 目标是 `prelabel_v1` 这条确定性规则，而特征里
   恰好含有还原它所需的全部信息（尤其 family/facet），所以网络只是把规则重新表达了一遍。
   它的正确用途是当**特征充分性的金丝雀**：如果连规则都复述不出来，说明特征漏了东西，
   那就没有理由去训 AI 标签。
2. **手写契约预测 AI 标签只有 0.094 / 0.135。** 这个数字低到不像「精度不够」，像「两套政策」。
   主要来源在 `same_family` 这一类：teacher 规则把同族 pair 的依赖分**一律压成 0**
   （视作替代品，不是协作者），而 AI 判分面对同样的画像会给出 0.75 —— 它读的是画像描述，
   不是族标签。这是本报告最重要的一个结构差异。

   **这个结构差异后来在四种折上被重新量了一遍**（`diagnose_contract.mjs` → `contract-vs-folds.json`），
   因为是同分布内的数，所以两件事同时被看清了：

   | 标签 | 折 | 契约 依赖 同档 | 众数 | 契约 相似 同档 | 众数 |
   |---|---|---:|---:|---:|---:|
   | `prelabel_v1` | `facet` | 0.5686 | 0.5239 | 0.7460 | 0.6805 |
   | **`ai_judge_qwen3_8b_majority_v1`** | `facet` | **0.0796** | 0.4451 | **0.1400** | 0.6320 |

   契约在**它自己的标签**上略胜众数，在 **AI 标签上远低于众数** ——
   所以"0.094/0.135"不是"契约不准"，是"契约和 AI 判分判的不是同一件事"。
   这也是为什么诊断页的结论把重点放在**用哪套标签**，而不是用哪个模型。
   同一批 AI 标签、同一个折上，一张 36 格 family 表是 **0.7657 / 0.7816**。

### 逐类拆解（v2-aijudge）

| `kind` | n | 依赖 同档 | 相似 同档 | 手写契约 依赖 同档 |
|---|---:|---:|---:|---:|
| `cross_owner_complement` | 189 | 0.889 | 0.836 | 0.053 |
| `cross_owner_similar` | 200 | 0.880 | 0.965 | 0.045 |
| `hard_negative` | 210 | 0.848 | 0.776 | 0.143 |
| `within_owner_directed` | 200 | 0.865 | 0.855 | 0.130 |

模型没有任何一类塌掉；最弱的是 `hard_negative` 的相似度（0.776），也就是「看起来像、但其实不邻近」
的那些对 —— 这一类的判断本来就依赖语义而非画像字段。v1-teacher 在每一类上都是 1.000。

## 四、消融：每一块值多少

只跑「置零某块」是不够的 —— 特征块之间有冗余（`produces`/`consumes` 既在 `flow` 里，
也在 `set_similarity` 的 jaccard 里），于是置零任意单块都能被另一块顶上。所以两个方向都跑。

**v1-teacher（目标是规则）**

| 块 | 列 | 置零后 devLoss | 只留该块 devLoss | 只留该块 依赖同档 |
|---|---:|---:|---:|---:|
| `family_onehot` | 12 | 0.0000 | **0.0830** | **0.968** |
| `facet_onehot` | 48 | 0.0000 | 0.0869 | 0.967 |
| `flow` | 8 | 0.0000 | 0.1152 | 0.968 |
| `set_similarity` | 18 | 0.0000 | 0.2757 | 0.875 |
| `flags` | 6 | 0.0001 | 0.8738 | 0.598 |
| `not_in_profile` | 3 | 0.0000 | 1.6705 | 0.519 |

置零任何一块，devLoss 都还是 0、依然 100% 同档 —— **每条信息都被至少两块表达**。
「只留 `family_onehot`」就能到 96.8%，与「同族依赖分清零」这条规则的存在完全吻合。

**v2-aijudge（目标是 AI 判分）**

| 块 | 列 | 置零后 devLoss | 只留该块 devLoss | 只留该块 依赖/相似同档 |
|---|---:|---:|---:|---|
| `facet_onehot` | 48 | **0.9435** | **0.6598** | 0.847 / 0.875 |
| `set_similarity` | 18 | 0.6552 | 1.3441 | 0.693 / 0.766 |
| `family_onehot` | 12 | 0.6508 | 0.9374 | 0.811 / 0.823 |
| `flow` | 8 | 0.6580 | 1.0584 | 0.803 / 0.789 |
| `flags` | 6 | 0.6475 | 1.8872 | 0.500 / 0.585 |
| `not_in_profile` | 3 | 0.6463 | 2.0551 | 0.431 / 0.569 |

（全特征 devLoss = 0.6517。）

结论很干净：**`facet_onehot` 一块就承担了几乎全部信号** —— 只留它，devLoss 0.6598 对全特征 0.6517，
依赖/相似同档 0.847/0.875 对 0.892/0.900。反过来置零它最疼（0.9435）。
fine-grained 角色（facet）就是这套 AI 打分的**实际判据**；family / flow / set 都只是补充。
`not_in_profile` 那 3 列单用几乎没信息（0.431/0.569），但它们在 Agent 记录里有、published profile 里没有 ——
**这是部署面的好消息**：服务期只用画像，损失不大。

## 五、JS / Python 对账

训练在 Python，服务在 JS（规划路径跑在 Node/Electron 里）。两边任何一点不一致
（特征顺序、标准化、GELU 变体、矩阵转置）都会让分数悄悄变形，所以这里不做「应该一样」，而是逐条对齐：

```text
[parity] cpdb-scorer-v1-teacher: 1598 个轴全部同档，连续分最大偏差 4.96e-7
[parity] cpdb-scorer-v2-aijudge: 1598 个轴全部同档，连续分最大偏差 9.50e-7
```

`scorer.mjs` 全程 float32（`Math.fround`）。这一点是刻意的：用 float64 累加会比 torch **更准**，
而「更准」在这里是坏事 —— 它会让两边对不上，且对不上的原因看起来会像权重加载错了。
GELU 用 erf 精确版（torch 的 `nn.GELU()` 默认值），tanh 近似会差到 1e-3，足以让对账测试失去意义。

`weights.json` 是**自述**的：把 `layers` / `headLayers` 的 `weightKey`、形状、特征名、
vocab、标准化参数全部写进产物，而不是让 JS 侧靠 `trunk.0 / trunk.3 / trunk.6…` 的下标规律去猜。
一旦 `Scorer` 里多插一个非参数层（比如换激活），那份猜测就会**静默**错位：权重照样加载、照样出分，
只是分数悄悄不对。`scorer.test.mjs` 会先验证自述结构对得上，再验分数。

## 六、标签的底子（为什么只能叫「一次判决」）

在盒子上用本地 Qwen3-8B（A800）判分，做了两件一致性测量（`qwk` = 二次加权 kappa）：

| 测什么 | 怎么测 | 依赖 qwk | 相似 qwk | n |
|---|---|---:|---:|---:|
| 自一致性 | 同一问法（framing a），6 个随机种子两两相比 | **0.924** | **0.910** | 415 × 15 对 |
| 措辞敏感 | 两种问法（framing a vs b） | **0.242** | **0.382** | 8282 |

读法：**问法钉死的时候它很稳；换一种问法它就换一套答案。** 所以 `v2-aijudge` 学到的是
「在 framing a 这套措辞下，Qwen3-8B 的判分政策」，不是「依赖分/相似度的真值」。

多数表决（1 次贪心 + 3 次采样，四票全量 8282 条）压掉了采样噪声，但压不掉措辞带来的偏差：

| 票型 | 依赖 | 相似 |
|---|---:|---:|
| 4:0 全体一致 | 78.7% | 79.1% |
| 3:1 | 15.4% | 14.7% |
| 2:2（平票，取最接近中位数的档） | 5.9% | 5.9% |
| 2:1:1 | — | 0.4% |

**9.7% 的 pair 至少在一个轴上出现平票** —— 那批是标签真正不确定的地方，也是「换标签来源就重训」
这个约束的具体体量。这一点已经写进 `metrics.json` 的 `labelSource` 里。

另外两处标签空间的观察（影响怎么解读准确率）：

- 依赖轴**从不使用 0.25**（v2 的依赖直方图是 `0/0.5/0.75/1` 四档），相似轴几乎不用 1.0。
  所谓「5 档」在 v2 上实际是依赖 4 档、相似 5 档偏斜。
- 反过来，v1-teacher 的相似轴也只用 `0 / 0.25 / 0.75` 三档。

## 七、怎么用 / 还没做什么

**可以用的**：`scorer.mjs` 的 `scorePair(scorer, leftProfile, rightProfile)` 返回
`{ dependency: {probability, argmax, expected}, similarity: {...} }`。两个分数分开给、不合成，
与 `uBuddyCapabilityDependencyBundle.js` 的契约形状一致 —— 依赖分喂「规划选协作」，
相似度喂「失败后换人」。

**还没做的（不要当成已完成）**：

1. **没接进规划路径。** `selectCollaborators` / `selectReplacement` 目前仍走契约里的手写函数。
   适配层已经写好且测过（`src/shared/contracts/uBuddyCapabilityDependencyScorer.js`：
   `scoredDependencyScore` / `scoredSimilarityScore` / `scoredSelectCollaborators` /
   `scoredSelectReplacement`，形状与契约一致、可逐个替换），
   开关也加了（`ubuddy_capability_dependency_scorer_v1`，**默认关**）。
   但**没有把调用点改过去** —— 仓库里目前没有任何一处业务代码在调这组契约，
   所以"接进去"这一步现在等于"选一个调用点"，那是个产品决定，不是代码决定。
2. **没做人评。** 而且要说清楚到目前**一条人工标注都没有**：
   `data/full/human_labels.jsonl` 的 annotator 只有 `prelabel_v1/prelabel` 与
   `ai_judge_qwen3_8b_majority_v1`（`diagnose.test.mjs` 有断言在守这条，加了人工标注它会红）。
   文件名 `human_labels.jsonl` 指的是"人工标注的落点"，不是"里面是人工标注" —— 这里曾被误读过一次。
   规则与 AI 两套政策谁更对**没有证据**；而诊断页第六节表明，"该信哪套标签"是比"用哪个模型"更大的决定。
3. **没做在线回归。** 换掉打分函数会改规划选人结果，需要一次影子对照（同任务、新旧两份规划）才能动线上。
   开关默认关，正是为了这件事还没做。

**下一步最省事的一步**：拿 `same_family` 那批分歧 pair（AI 给 0.75、teacher 给 0）去问人。
这一小批就能把"该信哪套标签"这个卡点解开 —— 而它是目前唯一挡在路上的卡点
（模型侧已经查清：再大的模型也不会更好，因为标签的分辨率就停在 `(familyL, familyR)`）。
