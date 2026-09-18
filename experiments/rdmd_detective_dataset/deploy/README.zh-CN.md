# RDMD 反向侦探 · 交付包

一个只读文本的「反向侦探」推理入口：喂进**规划树 `G_star`** 和**执行树 `G_prime`**，
输出一个 JSON 判定 —— 是哪个节点引起的漂移、属于哪种漂移、还是**证据不足应弃权**。

模型：**Qwen3-8B + LoRA adapter**（数据 `rdmd_detective_sft_v3`，1060 步 / 2 epoch，14.57 h）。
在留出集 test（1764 行 / 245 个与训练集**零拓扑重叠**的图）上的成绩见[第 7 节](#7-实测成绩与边界)。

```
experiments/rdmd_detective_dataset/deploy/
├── rdmd_detective.py       契约的单一事实来源：prompt 构造、输出解析、语义校验、模型封装
├── predict.py              独立推理入口（CLI）
├── fetch_adapter.py        从训练机拉取 adapter（权重不进 git）
├── make_examples.py        从真实 test 数据生成 examples/（记录示例的来源）
├── test_rdmd_detective.py  契约测试（含与训练 prompt 的逐字节比对）
└── examples/
    ├── example_input.json    1 条最难的 drift（派生字段唯一可见）
    ├── smoke_cases.jsonl     12 条自检输入（4 drift / 4 no_drift / 4 UNKNOWN）
    └── smoke_expected.jsonl  对应的 gold —— **仅用于自检，不要喂给模型**
```

---

## 1. 快速开始

```bash
pip install torch peft transformers paramiko

# 1) 拉 adapter（约 186 MB，默认落到 experiments/rdmd_runs/qlora-v3-adapter/）
export RDMD_SSH_PASSWORD=...
python experiments/rdmd_detective_dataset/deploy/fetch_adapter.py --run-tag qlora-v3

# 2) 没有 GPU？先验契约：只拼 prompt，不加载模型
python experiments/rdmd_detective_dataset/deploy/predict.py --input experiments/rdmd_detective_dataset/deploy/examples/example_input.json --dry-run

# 3) 真正推理
python experiments/rdmd_detective_dataset/deploy/predict.py \
    --input  experiments/rdmd_detective_dataset/deploy/examples/smoke_cases.jsonl \
    --output verdicts.jsonl \
    --adapter experiments/rdmd_runs/qlora-v3-adapter \
    --model  /path/to/Qwen3-8B
```

退出码：`0` = 全部判定通过语义校验；`1` = 存在 invalid 判定；`2` = 输入或环境错误。
（可以直接接进流水线：非 0 就不放行。）

也可以当库用：

```python
from rdmd_detective import Detective
detective = Detective("/path/to/Qwen3-8B", "/path/to/adapter")
result = detective.predict({"G_star": star, "G_prime": prime})
print(result["verdict"])     # {'status': ..., 'nodeId': ..., ...}
print(result["warnings"])    # [] 表示判定自洽且可追溯到图
```

---

## 2. 输入契约

一个 **case** 是一棵树对：

```json
{
  "id": "任意标识（可选，会原样回显）",
  "G_star":  { "domain": "...", "title": "...", "topic": "...", "nodes": [...], "edges": [...] },
  "G_prime": { "domain": "...", "title": "...", "topic": "...", "nodes": [...], "edges": [...] }
}
```

输入文件三种形态都支持：单个 case 的 `.json`、case 数组的 `.json`、每行一个 case 的 `.jsonl`
（也接受 `{"cases": [...]}` 包装；BOM 会被容忍）。

**节点字段**（其余字段会被丢弃，不会进入 prompt）：

| 字段 | 上限 | 缺省 |
| --- | --- | --- |
| `id` | 80 | **必填**，为空则整个节点被丢弃（兼容 `nodeId` 作为兜底键） |
| `title` | 240 | `""` |
| `role` | 80 | `""` |
| `agentId` | 160 | **`"agent"`** |
| `version` | 80 | **`"v1"`** |
| `acceptance` | 80 | **`"standard"`** |
| `artifact` | 240 | `""` |
| `stage` | 80 | `""` |
| `inputs` | 600 | `""` |
| `output` | 600 | `""` |
| `summary` | 800 | `""` |

**边字段**：`id`（160，缺省为 `"<from>-><to>"`）、`from`、`to`。
端点必须都是存在的节点 id，且 `from != to`，否则该边被丢弃。

**归一化**：所有文本会折叠连续空白为一个空格、去首尾空白、按上限截断（按 UTF-16 码元计）。
这些规则**不是可选的美化**，而是训练数据的一部分 —— 它们在 `lib/graph.mjs#normalizeRichGraph`
里，本包逐字节复刻。

> **不要重排或改写树。** 节点顺序、边顺序、字段取值都会影响 prompt，而模型只在这个分布上
> 校准过。输入应与生成时一致。

---

## 3. 输出契约

每个 case 产出一行 JSON：

```json
{
  "id": "...",
  "verdict": {
    "status": "drift",
    "nodeId": "n18",
    "edgeId": "n15->n18",
    "type": "missing_dependency",
    "evidenceNodeIds": ["n18"]
  },
  "raw": "<模型原始输出文本>",
  "valid": true,
  "warnings": []
}
```

`verdict` 就是训练时的 gold schema，**恒为这 5 个字段**：

| 字段 | 取值 |
| --- | --- |
| `status` | `drift` / `no_drift` / `UNKNOWN`。三者之外的取值一律归为 `UNKNOWN` |
| `nodeId` | 真凶节点 id。**只有 `drift` 允许非空** |
| `edgeId` | 相关边 id，形如 `n15->n18`。无常量约束，可为空 |
| `type` | `missing_dependency` / `wrong_agent` / `wrong_version` / `wrong_acceptance` / `local_replan`。**只有 `drift` 允许非空** |
| `evidenceNodeIds` | 定位证据节点。**非 `drift` 时也可能是非空**（见下） |

三种 `status` 的语义：

- **`drift`** —— 找到真凶。`nodeId` 与 `type` 必填，`evidenceNodeIds` 为 `[nodeId]`。
- **`no_drift`** —— 两棵树实质相同（无任何节点/边变化）。全字段为空。
- **`UNKNOWN`** —— **弃权**：证据不足，或存在多个互不相交的原因。`nodeId`/`type` 为空，
  但 `evidenceNodeIds` **可以非空**，装的是那些互不相交的候选节点（train 里 601 行如此）。
  这不是异常 —— 它明确告诉你「我怀疑这几个，但不敢替你选一个」。

**`warnings` / `valid`** 是这层封装额外给的、比 gold schema 更严的检查（`validate_verdict`）：

| 警告 | 含义 |
| --- | --- |
| `parse_error` | 输出无法解析成 JSON —— 模型这次没答出来 |
| `drift_without_nodeId` / `drift_without_type` | 判了漂移但没指认真凶 |
| `nodeId_not_in_graph:<id>` | **编造了一个图里不存在的节点** —— 下游会去查一个假节点 |
| `non_drift_has_nodeId:<id>` / `non_drift_has_type:<t>` | 弃权的同时又指认了凶手，语义自相矛盾 |
| `evidence_not_in_graph:<id>` | 证据里混进了不存在的节点 |

`valid=false` 不等于模型答错，而是**这条判定不可直接消费**。生产上建议：`parse_error`
按「服务不可用」处理（可重试），其余按「本次判定不可信」处理（降级或转人工），
不要静默地当作正确答案用下去。

---

## 4. prompt 契约（为什么不要自己拼）

prompt 的形状是模型的**训练分布**，不是一段随便的说明文字：

```
<DETECTIVE_INSTRUCTION>\nINPUT={"G_star":{...},"G_prime":{...}}
```

两个容易踩的坑，本包都已经处理：

1. `json.dumps` 默认插空格（`, ` / `: `），而 JS 的 `JSON.stringify` 不插。少一个
   `separators=(",", ":")`，prompt 会凭空多出几十 KB 空格。
2. `ensure_ascii` 默认会把中文转义成 `\uXXXX`，而 JS 不转义。

这两种偏差**都不会报错**，模型也照样输出像样的 JSON —— 但分布已经偏了，
[第 7 节](#7-实测成绩与边界)的数字不再适用于你的输入。这是最隐蔽的一类降级，
所以 `test_rdmd_detective.py` 拿**训练时实际存下的 prompt** 逐字节比对本包的构造结果
（跨 test 全文件抽样 252 行，零不一致）。

`--dry-run` 会打印每条的 `promptSha256`，可以用来核对不同实现是否一致。

---

## 5. 推理参数（改动会让成绩失效）

与评测脚本 `scripts/eval_rdmd_qlora.py` 完全一致：

| 项 | 值 | 为什么 |
| --- | --- | --- |
| 解码 | 贪心（`do_sample=False`） | 评测数字是贪心口径；换采样即换分布 |
| chat template | `enable_thinking=False` | Qwen3 的思考模式会插入额外 token |
| `max_new_tokens` | 160 | 输出只是一个短 JSON，160 足够；超出说明模型跑偏了 |
| dtype / device | `bfloat16` / `device_map={"": device}` | 单卡即可（adapter 只占 174 MB） |
| tokenizer | 从 **adapter 目录**加载 | adapter 目录自带 tokenizer 与 chat template |

---

## 6. 自检

```bash
python experiments/rdmd_detective_dataset/deploy/test_rdmd_detective.py -v
```

覆盖：指令与 JS 源逐字节一致、prompt 与真实 SFT 行逐字节一致、prompt 无 label 泄漏、
归一化行为（默认值/丢弃规则/截断/`\ufeff`）、解析容错、语义校验、输入格式、
单条失败不中断整批（`failure_record`），以及 `examples/` 未被手改。
需要本地有 `experiments/rdmd_detective_dataset/` 数据集；没有时相关用例会 skip 而不是假通过。

端到端自检（需要 GPU + 基座模型）：

```bash
python experiments/rdmd_detective_dataset/deploy/predict.py \
    --input experiments/rdmd_detective_dataset/deploy/examples/smoke_cases.jsonl \
    --output smoke_verdicts.jsonl --adapter <adapter> --model <Qwen3-8B>
# 再和 examples/smoke_expected.jsonl 对比
```

---

## 7. 实测成绩与边界

test split，1764 行 / 245 个新拓扑（与 train 零拓扑重叠）：

| 判据 | 值 | 参照 |
| --- | --- | --- |
| 定位 `nodeId` Top-1 | **0.9993** | 诚实基线（规则 D/E）**1.0000** |
| 类型 `type` Top-1 | **0.9979** | 基线 0.5270 |
| `UNKNOWN` 弃权率 | **1.0000** | 上一版模型 **0.0000** |
| `no_drift` 正确率 | **1.0000** | 基线 1.0000 |
| 「无原因字段子集」定位 | **0.9985** | 该子集上基线无信号（0.000） |
| 解析错误率 | **0.0000** | — |

**必须连同结论一起转述的边界**：

- **定位维度只是打平了确定性基线**（0.9993 vs 1.0000）。这套任务的 gold 本身就是那条
  11 行图算法定义的，**天花板被定义死了** —— 模型不可能超过它。
- 所以这个模型的价值在于**部署形态**：基线是写死的算法，规则一变就要改代码、重测、重上；
  模型只读文本，规则可随数据演进，且能输出「证据不足」而不是硬猜。
  **它不是精度优势方案。**
- 弃权率从 0.0000 到 1.0000 是本版最核心的修复：上一版把 `UNKNOWN` 排除在训练损失之外，
  结果 185 行 `eval_unknown` 全答成 `drift` —— 一个从不弃权的侦探在真实场景里是危险的。

数据与评测的完整记录见 `experiments/rdmd_detective_dataset/V3_FULL_REPORT.zh-CN.md`（第 11 节）。

### 7.1 分布外：换规模、换形状还行不行

上面是**同分布**留出集。「test 与 train 零拓扑重叠」这个说法比听起来窄：生成器的 10 个域、4 种
结构会被 1000 张金标图全部跑到，节点数被步骤表钉在 19–21（schema 允许 16–32），训练 prompt 只有
11221–13016 字符这一个窄带（详见报告第 12.1 节）。

因此另造了一个带金标的分布外探针（`make_ood.mjs`，43 行）：4 种未见过形状 × 规模 16/24/32
（合法但未出现）+ 48/80（越界探针）。结果：

| 分层 | n | 基线定位 | 模型定位 | 基线 type | 模型 type |
| --- | --- | --- | --- | --- | --- |
| drift：原因字段可见 | 13 | 1.000 | **1.000** | 1.000 | **1.000** |
| **drift：仅派生字段可见** | 10 | 1.000 | **1.000** | **0.000** | **1.000** |
| no_drift | 16 | 1.000 | **1.000** | — | — |
| UNKNOWN（弃权） | 4 | 1.000 | **1.000** | — | — |

- **换规模、换形状不散架**：16→80 节点、4 种未见形状、prompt 最长 54207 字符（5 倍于训练长度），
  模型全部 1.000，**0 invalid、0 warning**，没有一行因输入过长失败。
- **基线无信号的地方模型全对**：真凶仅派生字段可见时，规则 E 判 type 的准确率是 0.000，模型 10/10。
  这与 test 上的模式一致，并且现在是在未见形状/规模上成立的。
- 越界探针**不代表支持 80 节点的图**（schema 上限 32），只是「到 80 节点仍未找到断裂点」。

边界：探针换的是**规模与形状**，漂移的类型与改写形态仍来自同一个 `lib/forms.mjs`；
且依然是合成数据，真实流程是否满足「唯一级联根」未被验证。

### 7.1b 该弃权时会不会硬猜（读这一段再决定怎么用）

上面所有探针都满足训练数据的「**唯一级联根**」保证。把这条保证打破之后，模型会露出一个
**明确且可复现**的弱点，用它的时候需要知道：

| 家族 | n | 基线 status | 模型 status |
| --- | --- | --- | --- |
| 单原因（对照，必须对） | 30 | 1.000 | **1.000**（定位与 type 都 1.000） |
| **两条原因、其中一条仅派生字段可见** | 30 | **1.000** | **0.833**（Wilson 95% CI [0.66, 0.93]） |

**失败机制 5/5 完全一致**：模型看见**一个**可见的原因字段变化（`inputs`）后，就把它当成唯一凶手
报 `drift`，`type` 也固定给出 `missing_dependency`（正是「`inputs` 变了」推出的类型），
而**完全忽略**只在 `artifact/output/summary` 留痕的第二条原因。

- 它**没有**栽赃无辜节点（5/5 报出的都是真原因之一、都是级联根），失败形态是**漏报第二原因**；
- 但契约要求「多个不相交原因 → UNKNOWN」，所以这仍然是**违约**；
- 把它和 7.1 第 2 行并排看最清楚：**单原因 + 仅派生可见**时模型 1.000 而基线 type 0.000（完胜）；
  **两条原因、其中一条仅派生可见**时模型 0.833 而基线 1.000（**输了**）。
  同一个能力一旦旁边出现一个显眼的原因字段，就不再被用上。

**使用建议**：同一张图里若已知可能同时存在多个故障，不要把单条模型判定当成终局结论；
它是「最显眼的那条」，不是「唯一的那条」。契约里的 `UNKNOWN` 出口存在正是为此。

### 7.3 接入前必读：输入契约是 fail-closed 的

模型需要**富节点**：每个节点必须有 `artifact / stage / inputs / output / summary` 五个非空字段
（模型相对规则基线的全部优势都来自它们）。**缺字段会直接拒绝，不会静默降级。**

- `predict.py --dry-run` 遇到不合格输入会**报出问题并 exit 1**；
- 正式推理逐条先查契约，不合格产 `valid=false` + `warnings=["input_contract_violation:..."]`，
  **不占用 GPU**，也不会给你一个看起来正常的判定。

这不是保守，是防一个已实测的具体故障：`public_graph` 会把缺失字段归一成空字符串，于是 prompt
照常构建（只有 1793 字符 vs 训练的 11221–13016）、`validate_verdict` 照常返回空警告、模型照常
给出自信的答案 —— 只是那个答案不再代表任何已测得的准确率。

**要接到 uBuddy 上，先读 [`INTEGRATION.zh-CN.md`](INTEGRATION.zh-CN.md)** —— 那份文档给出
缺口在哪一层、三条可选路径，以及为什么「在窄契约上重训」预期没有收益。

注意 uBuddy 里有**两套图**：`normalizeTaskGraph` 是面向公开记忆的窄投影（无散文），
而 `collaboration_graph_*` 是**同层的任务步骤树**，其 `agent_task` 节点的 `public_summary`
取自该步的 `resultSummary` —— 也就是模型需要的那层散文。**这一层在真实数据里的规模与填充率
尚未量过**，正在由 [`../ubuddy_recon/UBUDDY_RECON.zh-CN.md`](../ubuddy_recon/UBUDDY_RECON.zh-CN.md)
实测（七项测量 + 判定矩阵，不需要 GPU）。**实测结论出来之前不要写适配器。**

### 7.2 一条坏输入不会拖垮整批

`predict.py` 逐条兜底：单条推理抛异常时产出规范空判定 +
`valid=false` + `warnings=["inference_error:<异常类型>"]`，**继续处理后面的 case**。
异常消息不会进记录（可能内含超大 prompt 片段）。这个入口的退出码是要驱动流水线的，
一条超长输入必须表现为「这一条不可信」，而不是整批消失。

---

## 8. 产物指纹

adapter 可核对（`fetch_adapter.py` 拉完后建议比对一次）：

| 项 | 值 |
| --- | --- |
| `adapter_model.safetensors` 大小 | 174,655,536 字节 |
| `adapter_model.safetensors` sha256 | `c5193c7cbcb6a980612d608ad0e7e71b7d21883debde1ee7def641c94e8b932d` |
| 目录合计 | 7 文件 / 177.5 MB |
| 张量 | 504 个（LoRA A/B） |
| LoRA | `r=16` / `lora_alpha=32` / `lora_dropout=0.05` |
| target_modules | `q_proj, k_proj, v_proj, o_proj, up_proj, down_proj, gate_proj` |
| `task_type` | `CAUSAL_LM` |
| 基座 | Qwen3-8B（`base_model_name_or_path` 记录的是训练机路径，本地需自行指向实际基座） |

```bash
sha256sum experiments/rdmd_runs/qlora-v3-adapter/adapter_model.safetensors
# 期望 c5193c7cbcb6a980612d608ad0e7e71b7d21883debde1ee7def641c94e8b932d
```

> **不要只比文件大小。** 174 MB 的二进制走网络，大小相同但内容损坏是可能的；sha256 才是完整性证明。
> adapter 目录自带 `tokenizer.json` + `chat_template.jinja`，所以只要基座模型在，不额外依赖别的 tokenizer 文件。
