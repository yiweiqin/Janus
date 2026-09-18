# RDMD v3（路线 B）smoke 报告

日期：2026-09-13。生成器改动 + 200 行 smoke 的诚实基线数字。

> 本文是 smoke 阶段的历史记录。全量 12000 行的权威结果见 `V3_FULL_REPORT.zh-CN.md`。

## 1. v3 相对 v2 改了什么

| 改动 | 位置 | 目的 |
| --- | --- | --- |
| **打散 id 与拓扑序**：节点 id 随机重标定，节点数组与边数组也随机排序 | `lib/obfuscate.mjs`、`generateGoldenGraph` | v2 里「id 最小 = 依赖链最靠前」，导致「取最小 id 的差异节点」= 金标（1.000）。现在渲染顺序不再含因果信息，依赖顺序必须从边重建 |
| **诱饵（innocent twin）**：给 G_prime 挂 1–2 个新叶子节点，带自己的 agentId/artifact/summary，但不接任何下游 | `addDecoyNodes` | 把「哪个字段变了」「id 最小」「拓扑最早」这些规则全部打掉；只有「这次变化是否真的产生了下游后果」能排除诱饵 |
| **验收门禁**：`id/array 顺序是拓扑序`、`诱饵有下游后果`、`诱饵落在金标分支内`、`drift 样本必须有诱饵`、`未被解释的新节点` | `lib/gates.mjs` | 防止回退到 v2 的退化形态 |
| **UNKNOWN 进主损失** | `lib/sft.mjs#isMainSupervised`、`prepare_sft.mjs` | v2 只训 drift/no_drift，模型 185 行 UNKNOWN 全答 drift（0.000） |
| **最短路口门禁**：规则 B（最小 id 差异）> 0.35 直接判废 | `validate.mjs`、`check_readiness.py` | 把短路做成硬门禁，而不是事后发现 |

## 2. smoke 配置

```bash
node experiments/rdmd_detective_dataset/generate.mjs --backend=local \
  --drift=140 --no-drift=20 --unknown=40 --golden=60 --seed=20260913
node experiments/rdmd_detective_dataset/prepare_sft.mjs
node experiments/rdmd_detective_dataset/validate.mjs --drift=140 --no-drift=20 --unknown=40
python scripts/rdmd_trivial_baseline.py --data experiments/rdmd_detective_dataset/sft --splits train development test
```

- 200 行，`invalid 0`、`graphLeak 0`、首次效果最小跳数 3、用到 30 个 form。
- 划分：train 167 / development 24 / test 9（smoke 图池小，test 只有 9 行；全量会回到 8:1:1）。

## 3. 诚实基线（train 140 条 drift）

所有规则只读 prompt 里的两棵树，不读 label。

| 规则 | 定义 | Top-1 |
| --- | --- | --- |
| A | 最小 id 且自身 `inputs/agentId/version/acceptance` 变化的节点 | 0.714 |
| **B** | 最小 id 的变化节点（**v2 的满分短路**） | **0.079** |
| C | 唯一的「变化根」：变化节点且没有变化的上游 | 0.000 |
| **D** | 「级联根」：变化节点、无变化上游、且至少有一个变化的下游 | **1.000** |
| E | 完整基线：级联根唯一 → drift，≥2 个 → UNKNOWN | 定位 1.000 / abstain 1.000 |

type Top-1（规则 E）只有 0.714，因为 `local_replan` 之类没有可判别的原因字段。

## 4. 怎么读这组数字

**有效**：v2 的满分短路已经死了（B: 1.000 → 0.079）。而且 C = 0.000 —— 只找「变化根」是不够的，因为诱饵也是变化根，必须再看它有没有产生下游后果。所以现在答对必须做完这一串动作：对齐两棵树 → 找变化节点 → 从边重建依赖序 → 找变化根 → 用「是否有变化的下游」排除诱饵 → 输出节点 id。

**要说清楚的天花板**：规则 D/E 是 1.000，而它是**手工写死的确定性算法**。只要数据集保证「唯一植入原因」，就必然存在一条满分的确定性规则；路线 B 能做到的极限就是「让那条规则等于我们想考的能力」。所以模型的价值不在超过 D，而在于**不写图算法、只从文本表面复现 D**。

**仍有提升空间的维度**：type（基线 0.714，v2 模型 0.997）和 abstention（基线 1.000 靠数级联根，v2 模型 0.000）。定位这一维对模型是零上限空间。

如果希望定位维度也有上限空间（基线 < 1.0），就需要路线 A 的契约层，或引入「级联本身看起来也合理」的诱饵——那需要图里能表达「计划内变更」，也就是契约层。**这是路线 B 的原理性上限，不是实现问题。**

## 5. 验收状态

`python experiments/rdmd_detective_dataset/check_readiness.py` → `DATA_READY`，failures 为空：

- `main_loss = [drift, no_drift, UNKNOWN]`，`unknownInMainLoss = 31`
- `shortcut_baseline = {n: 140, lowestIdNodeTop1: 0.0786, limit: 0.35, ok: true}`

## 6. 待确认后执行的全量步骤

1. `node generate.mjs --backend=local`（默认 targets 10000/1000/1000，seed 20260910）
2. `node prepare_sft.mjs` + `validate.mjs` + `rdmd_trivial_baseline.py`
3. `python scripts/rdmd_remote_deploy.py`（stage=upload）把新 sft 推到远程
4. 远程重跑 QLoRA（约 13 h）→ 三卡分片评测 test / eval_unknown / eval_no_drift / development
5. 与规则 D/E 诚实基线并排报告

## 7. 需要记录的副作用

- 本地 `experiments/rdmd_detective_dataset/data/*.jsonl` 被这次 200 行 smoke 覆盖，v2 的 12k 行原始数据在本地已不存在（该目录整个未被 git 跟踪；生成器代码也已改成 v3，无法原样复现）。
- **v2 的 SFT（12k 行）仍完整保存在远程** `/root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/sft/`，v2 的评测结论与 adapter 都不受影响。
