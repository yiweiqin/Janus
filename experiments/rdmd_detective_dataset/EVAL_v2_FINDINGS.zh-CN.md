# RDMD v2 训练与评测结果（含一个必须修的数据集缺陷）

日期：2026-09-13。远程 3×A800，Qwen3-8B + QLoRA r16 / nf4。

## 1. 训练

| 项 | 值 |
| --- | --- |
| 步数 | 988 / 988（2 epoch，batch 1 × grad accum 16） |
| train_loss | 0.02581 |
| 最终 eval_loss（development） | 2.822e-06 |
| train_runtime | 47163 s ≈ 13.1 h |
| adapter | `/root/autodl-tmp/rdmd_runs/qlora-v2/adapter` |

## 2. 全 split 评测

### 2.1 test split（1668 行）

| 分组 | n | status | nodeId Top-1 | type Top-1 | 输出 UNKNOWN |
| --- | --- | --- | --- | --- | --- |
| drift | 1372 | 1.000 | **1.000** | 0.9971 | 0 |
| no_drift | 111 | 1.000 | — | — | 0 |
| UNKNOWN | 185 | **0.000** | — | — | **0** |

### 2.2 其余 split（v2 adapter 补测，三卡分片，1911 行合并后分 split 计分）

| split | n | statusHit | nodeId Top-1 | type Top-1 | unknownRate | parseError |
| --- | --- | --- | --- | --- | --- | --- |
| development | 1615（drift 1497） | 1.000 | **1.000** | 0.9947 | 0.000 | 0 |
| eval_no_drift | 111（全 no_drift） | 1.000 | — | — | 0.000 | 0 |
| eval_unknown | 185（全 UNKNOWN） | **0.000** | — | — | **0.000** | 0 |

`eval_unknown` 的 185 行**全部**答成 drift，一行弃权都没有；`nodeId`/`type` 不计入该分组。

三点读数：

- `development` 与 `test` 完全一致（node 1.000 / type 0.9947 vs 0.9971），说明 v2 的「表面 diff 满分」不是 test 过拟合，而是整个任务的真实上限。
- `eval_no_drift` 1.000：模型对「两树完全相同」判得很稳。
- `eval_unknown` 0.000 且 `unknownRate 0`：**abstention 这一支从未被学到**。v2 的 `mainLoss` 只有 `[drift, no_drift]`（见 `sft/manifest.json`），UNKNOWN 全在 `evalOnly`，模型没有任何机会见到弃权样本，于是把「证据不足」一律折叠成「有漂移」。这正是 v3 把 UNKNOWN 放进主损失（774 条）的直接依据。
- 对比之下，同一批 UNKNOWN 上 v2 的**确定性基线** `detectMinimalDrift` 弃权正确率是 **0.654**（`sft/baseline.json` 的 `unknown.correct`）。也就是说「会弃权」这件事对一条图算法规则是可学的、甚至不难，但模型 0.000 —— 差别只在于训练时有没有见过弃权样本，而不是能力问题。

> 注：`eval_rdmd_qlora.py` 报告中回显的 `baseline` 字段读的是远程 v2 的 `sft/baseline.json`（n=1668，drift Top-1 0.5379 / type 0.5809），是 v2 的旧结构启发式数字，与本表的模型成绩无关。

解析失败率 0，额外 evidence 节点 0（所有 split）。


旧“结构启发式”基线（`sft/baseline.json`）是 drift Top-1 0.5379 / type 0.5809。

## 3. 关键发现：这个数据集可以被 3 行 diff 规则打满分

`scripts/rdmd_trivial_baseline.py` 只用 prompt 里的 `(G_star, G_prime)` 做字符串比较：

- **规则 A（原因字段）**：取 id 最小的、自身 `inputs/agentId/version/acceptance` 变化的节点。
- **规则 B（任意字段）**：取 id 最小的、任意字段变化的节点。

结果：

| split | drift 行 | 规则 A node Top-1 | 规则 B node Top-1 |
| --- | --- | --- | --- |
| train | 7131 | 0.5406 | **1.000** |
| development | 1497 | 0.5391 | **1.000** |
| test | 1372 | 0.5379 | **1.000** |

规则 B 在三个 split 上都是 **1.000**，没有任何一行例外。

### 根因

1. 节点 id（`n1…n28`）按拓扑序分配，所以“id 最小 = 依赖链最靠前”。
2. 生成器把漂移节点**自己的字段也改了**（`artifact` / `summary` / `output`，以及五类各自的原因字段），所以漂移节点本身就是两树**第一个可见差异节点**。
3. 下游只会级联出更多差异（每个漂移样本平均 8 个、最多 12 个变化节点），但它们 id 都更大。

因此“找最小漂移节点”退化成“diff 后取第一个变化节点”，完全不需要依赖结构推理。

### 旧的 53.8% 基线为什么会掩盖问题

`baseline.json` 用的是规则 A（只看原因字段），它衡量的是另一条规则；规则 A 只在 53.8% 的行上命中，因为另外 46% 的漂移节点在自身字段上只体现派生字段变化。于是看起来“任务很难（53.8%）”，实际上规则 B 已经有 100% 上限。

### 模型实际学到的是什么

- 两树不逐字节相同 → 找出第一个变化节点 + 按“哪个字段变了”编一个 type。
- 两树相同 → `no_drift`。
- 从不输出 `UNKNOWN`（185 行 UNKNOWN 全部答成 drift）。

也就是说：**node Top-1 = 1.000 是表面阅读能力，不是反向侦探能力**；UNKNOWN 0/185 说明“证据是否充分”这一维根本没被学到（UNKNOWN 也没进主损失）。

## 4. v3 必须同时满足的修正

1. **金标节点自身零变化**：漂移节点在 `G_star` 与 `G_prime` 之间必须逐字段相同，只能通过 ≥3 hop 的下游不一致暴露，逼模型回溯依赖链。
2. **加诱饵差异**：在不相关分支注入独立、非因果的表面差异，让规则 B（最早变化 / 最小 id）失效。
3. **type 不能由“哪个字段变了”反推**：type 必须来自下游不一致的形态（例如依赖链断裂方式），而不是直接读原因字段。
4. **UNKNOWN 进主损失**：抽一部分“表面看起来唯一、实则证据不足”的样本，让模型有机会学会弃权；否则永远 0/185。
5. **规则 B 作为数据集验收门禁**：新版本若规则 B node Top-1 超过随机水平（5 类下约 0.20～0.35 上限），直接判废，不允许进入训练。
6. 样本 `id` 里携带了 `status/type/nodeId`（如 `rdmd_local_290__drift__missing_dependency__n5__20261201`）。当前 prompt 不含 id，未泄漏；但任何后续拼 prompt 的路径都必须只走 SFT 导出器，禁止把 id 拼进输入。

## 5. 复现命令

本地：

```bash
python scripts/rdmd_trivial_baseline.py --output experiments/rdmd_detective_dataset/sft/trivial_baseline.json
```

远程（三卡分片，约 33 min；单卡约 100 min）：

```bash
python scripts/rdmd_ssh.py --command-file scripts/_rdmd_remote_eval_shard.sh --timeout 90
python scripts/rdmd_ssh.py --command-file scripts/_rdmd_remote_eval_shardstat.sh --timeout 60
python scripts/rdmd_ssh.py --command-file scripts/_rdmd_remote_eval_finalize.sh --timeout 180
```

## 6. 为什么规则 B 会满分：两个叠加的巧合

除了“漂移节点自身字段被改写”，还有第二个必要条件：

- `scripts/_rdmd_id_order_probe.py` 证明：v2 全部 1668 行、两棵树里，**节点 id 顺序始终是合法拓扑序**（`n1 < n2 < …`，边永远从小编号指向大编号）。`generateGoldenGraph` 就是按下标顺序生成节点、再按结构连边的。
- 于是「id 最小」= 「依赖链最靠前」= 「瀑布起点」。规则 B 其实等价于“取拓扑序最早的可见差异节点”，而这**恰好就是**金标。

两个巧合缺一不可：金标自身必须可见（巧合一），id 必须按拓扑序（巧合二）。v3 只要打破任意一个，规则 B 就会掉到随机水平。

## 7. v3 的两条路线（需要二选一）

### 路线 A：金标自身零变化（用户已选方向的严格版）

- 做法：漂移不再改写金标节点的任何字段；漂移改由**契约破坏**承载——每个节点的 `inputs` 声明它的上游提供者（"「X」的产出"），G_prime 里只改边：
  - `missing_dependency`：删掉金标的入边；
  - `wrong_agent` / `wrong_version` / `wrong_acceptance`：把入边改接到另一个节点，类型由“接到的节点在金标声明的提供者上哪个属性不同”决定（version > agent > acceptance 优先级）；
  - `local_replan`：在链上插入 `repair_*` 中转节点，使声明的提供者不再是直接上游。
- 前提改动：`generateGoldenGraph` 必须让 `inputs` 与真实边一致（现在是按下标硬写，fork_join 结构里本来就不一致）；金标图需要 version / acceptance 的少量多样性；下游 `far` 文案需要加门禁，禁止出现金标节点标题（会泄漏）。
- 后果：任务从“文本侦探”变成“结构一致性检查”。诚实基线（契约检查器）按构造就是 1.000——这一点必须在论文里说清楚：模型学到的是执行该检查，而不是发现了检查本身。

### 路线 B：打乱 id 顺序 + 诱饵（更便宜，保留侦探叙事）

- 做法：只改一件事——`id` 与拓扑序解耦（生成时按位置建边，最后做一次 id 重标定并同步重写 `inputs` / `artifact` 文本）。金标仍保留自身的可见变化，诱饵放在拓扑更晚、但 id 更小的位置。
- 效果：规则 B 掉到随机水平；诚实基线变成“**拓扑序最早的变化节点**”——这正是任务原本想考的推理（diff + 还原 DAG 序 + 判断哪处变化真正有下游后果）。
- 成本：小得多，不动 100 条文案、不动五类语义；仍然保留 v2 的“金标自身可见”这一让题目良定义的性质。
- 代价：不满足“金标零变化”。

两条路线都可以再加“诱饵 + UNKNOWN 进主损失”。建议先做路线 B 拿到一版干净的对照，再评估是否值得为路线 A 重写契约层。

## 8. 结论

v2 的训练管线（部署、分片评测、脚本）全部跑通，可以作为后续版本的脚手架复用。
但 **v2 的准确率数字不能作为论文证据**：在上限已经是 100% 的表面上拿到 100%，不构成自我演化的证据。下一步应先修生成器（v3），再重跑同一套训练与评测。
