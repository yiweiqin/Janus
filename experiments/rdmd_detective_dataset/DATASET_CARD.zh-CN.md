# RDMD 侦探数据集 v2

## 相对 v1 的差距

v1 的图只有 6–12 个节点，漂移是同一套后缀（`[stale]`、`[from:wrong_version]`）。那训练不出「长程归因 + 按任务实例化的最小漂移」。

v2 对齐目标：**规划树 vs 执行树，反向侦探找到引起差异的最小节点，再做准确归因后的最小改动**。

1. **长程**：`G_star` 16–28 步；注入点必须还能往后走至少 6 跳；**第 1–2 跳后代保持原样**，从第 3 跳起才出现可见后果。
2. **形态随任务变**：类型仍是五类（`missing_dependency | wrong_agent | wrong_version | wrong_acceptance | local_replan`），但形态按域实例化。例如同样是 `wrong_version`：研究任务是观察年窗口，开发任务是 API 钉死，运营任务是旧 chart。图里禁止出现类型名和统一后缀。

## 方法

1. 写出一条长程正确流程 `G_star`
2. 按该任务的形态目录，在早期节点施加一次已知小改动，**当场记下** `injected_node / injected_type / injected_form`
3. 推理远处节点如何变化，得到 `G_prime`（近处后代不改）
4. 模型只看见 `(G_star, G_prime)`，标签是第 2 步记下的 gold

本盘由本地因果教师生成（`local-tutorial-writer`）。LLM 后端仍可用（`--backend=llm`，默认 `gpt-5.5`），提示词已改成同样的长程 + 任务形态约束。

## 规模

| 子集 | 条数 | 标签 |
|---|---:|---|
| 单注入 | 10,000 | `drift` + node + type + form |
| 无漂移 | 1,000 | `no_drift` |
| 双注入 | 1,000 | `UNKNOWN`（不进主监督） |

切分按 `graph_id`：train 8545 / development 1787 / test 1668，**无 graph_id 跨切分泄漏**。主监督不要读 UNKNOWN 行。

test 上结构启发式 Top-1 = 53.8%（不是 trivial 满分）。10,000 条单注入的第一处可见后代后果平均 3.41 跳、最低 3 跳；形态目录共 100 种（10 个任务域 × 5 类 × 2 种写法）。

## 文件

- `data/train.jsonl` `data/development.jsonl` `data/test.jsonl`
- `sft/train.jsonl` `sft/development.jsonl` `sft/test.jsonl`（prompt/completion，训练用）
- `data/manifest.json` `data/validation.json` `sft/manifest.json`
- 形态目录：`lib/forms.mjs`
- 生成：`node experiments/rdmd_detective_dataset/generate.mjs --backend=local`
- 校验：`node experiments/rdmd_detective_dataset/validate.mjs`
- SFT：`node experiments/rdmd_detective_dataset/prepare_sft.mjs`

## 门禁

- `G_star` 16–32 节点 DAG
- 单注入样本 `hop_to_first_effect >= 3`，中间跳不变
- 变化只落在注入点及其后代（外加远处的 `repair_` 节点）
- 祖先不变
- 图中无类型名、无 `[stale]` / `[from:` / `injected_node`

seed = 20260910。

## 训练前置

SFT 已导出，主损失 7902 / 1615 条（无 UNKNOWN）。test 1668 条含 1372 单注入、111 无漂移、185 多因。prompt 估计长度 p95 ≈ 7600 tokens，训练 `maxLength=16384`。

SFT 导出：`npm run experiment:rdmd-sft`  
开训手册：[TRAINING_RUNBOOK.zh-CN.md](TRAINING_RUNBOOK.zh-CN.md)  
训练入口：`scripts/train_qlora_rdmd.py`（只读 train/development；UNKNOWN 不进主损失）  
门禁：`python experiments/rdmd_detective_dataset/check_readiness.py`

---

## v4：把契约与语料同时缩窄到「真实有来源的字段」（2026-09-17）

v3 的前提错了：语料里每个节点都填满 11 个内容字段，而产品侧的 `agent_step` 节点
**只有一行步骤文本**。模型训练时依赖的依据在生产上一个都不存在。v4 反过来做 ——
让契约与语料都按 `kind` 缩窄。完整推理见
[ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md](ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md) §8.1 / §8.2。

**契约（两侧字面同步：`src/shared/contracts/uBuddyPlanExec.js` ↔ `deploy/rdmd_detective.py`）**

| kind | plan 侧必需 | exec 侧必需 |
| --- | --- | --- |
| `root` / `ubuddy` | `title` | `title` |
| `agent_task` | `title` | `title` `summary` `output` |
| `agent_step` | `title` `status` | `title` `status` |

- 缺 `kind` 回退最严一档（`agent_task`），绝不静默放宽。
- `version` / `acceptance` 是归一化补的常量而非信号，永远不进必需集。
- `status` 是**第 12 个可见字段**，只对 step 层是信号。它在 `schema.json` 里的防泄漏方式
  从"任意位置禁止"收窄成"图顶层禁止"（`forbiddenGraphRootKeys`）—— 节点上的 `status`
  合法，`label.status` 那种整块标签并进图仍然会被拦。

**这一盘的实测（seed 20260910，`--backend=local`）**

| 项 | 值 |
| --- | --- |
| 条数 | drift 10,000 / no_drift 1,000 / UNKNOWN 1,000（`rejected=0`） |
| 切分 | train 8,590 / development 1,745 / test 1,665，按 `graph_id` 无泄漏 |
| 图族 | `flat_work_units` 6,025 / `layered_group` 5,975 |
| step 层漂移样本 | `wrong_agent` 257 / `wrong_version` 251 / `local_replan` 241 / `missing_dependency` 142 |
| `hop_to_first_effect` | 均值 3.27，最小 3（`minHopToFirstEffect` 未被削弱） |
| 形态数 | 180 |
| 捷径守卫 `lowestIdNodeTop1` | 0.215（阈值 0.35） |
| 捷径守卫 `statusOnlyTop1` | **0.187**（阈值 0.35），`statusOnlyFired` 0.089 —— 守卫真的会开火，不是空转 |
| `validate.pass` | `true`，`invalid=0`，`graphLeak=0` |
| SFT | `READY_FOR_QLORA`，`rejected=0`，train 8,590 / development 1,745 / test 1,665 |
| 本地测试 | JS 契约 12/12、cloud 7/7、语料 16/16、Python 36/36 |

**step 层只承载 4/5 种漂移**：`wrong_acceptance` 在 step 层没有来源（plan step 的载荷只有
`{step, status}`），所以它只在 `agent_task` 及以上出现。这不是遗漏，是显式记录的能力削减：
`STEP_TIER_MISSING_FORMS` 写出原因，`dataset.test.mjs` 写死期望集合 + 断言这个例外，
将来谁把它加回 step 层测试会立刻红。

**门槛与命令（顺序不能换）**

```powershell
node generate.mjs --backend=local        # 主盘
node make_ood.mjs                        # OOD 盘（含超长 prompt / 分布外组合）
node make_adversarial.mjs                # 对抗盘（无分支图、派生字段唯一可见）
node validate.mjs                        # 捷径守卫 + 长程 + 泄漏，pass 必须为 true
node prepare_sft.mjs                     # rejected 必须为 0
python check_readiness.py                # failures 必须为空（gpu_missing_local 是预期警告）
python deploy/make_examples.py           # 示例是派生产物，必须同步重生成
python -m unittest test_rdmd_detective   # 在 deploy/ 下跑；两侧契约互测在这里
```

**这一盘踩到的坑（已修，且已加回归）**：`gates.mjs` 的 `extra_node_unexplained` 只认
"真凶在 **star 图** 上的后代"，而注入新增的节点在 star 图里根本不存在 —— 于是**所有**
结构性 `local_replan` 样本都被判死（step 层 223/223 全灭），step 层一条都进不了语料，
只剩"标题里写一句『并入下一环』"这种可背诵的形态。现在新节点走**显式声明 + 结构判据**
（必须挂在某个真凶的下游）这条路。教训是：形态"能生成"与样本"能存活"是两件事，
中间隔着一整套门 —— 只测前者就会漏掉它。


