# -*- coding: utf-8 -*-
"""把 P4 一节追加进受追踪文档；按文件里第一条 markdown 标题做幂等键。"""
import io
import re
import sys

PATH = 'experiments/rdmd_detective_dataset/ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md'

CONTENT = u"""
## 14. P4 评测硬化：把 OOD/对抗接成门，第一次跑就红了（2026-09-19）

§12–13 那些数字（"基线 node 1.000 / type 0.527"等等）的唯一落脚点是
`data/ood_summary.json` 与 `data/adv_summary.json`。它们**只被手工命令写过一次**，
之后没有任何东西核对过 —— `score_ood.py` 甚至不在任何 npm 脚本里。
这一节把它接成门，然后报告门第一次跑出来的东西。

### 14.1 门怎么设计的（以及为什么它能不带 GPU）

| 决定 | 理由 |
| --- | --- |
| 只比**基线列**（`base_*`），不比 `model_*` | 模型列需要那份权重和一台 GPU。放进本地的门只会让门被跳过，或者更糟 —— 被伪造。 |
| 整数**逐位相等**，不给容差 | 基线是纯函数（rules A–E）。计数没有浮点误差可言，给容差只是让门更容易放过漂移。 |
| 参考文件由 `--write-reference` 从一次真实跑导出，并**钉住语料的 sha256** | "参考描述的是哪批字节"不再靠上下文暗示。换一批语料，哈希先对不上，比数字毫无意义。 |
| 与标签**不一致的行**作为不变量钉进参考 | 比分组计数更本质：分组计数只是它的外在表现。多一行、少一行都要报。 |
| 语料不提交，但**必须先造出来** | 探针是**种子确定性**的：实测 `node make_ood.mjs` / `make_adversarial.mjs` 重跑与原地那份**逐字节相同**。所以"可复跑"是真的，不是"语料不在就跳过"。 |

### 14.2 第一次跑：23 处（ood）+ 20 处（adv）不一致

两处**不同**的病因，而且都不是"规则改错了" —— 这恰恰说明这个门早就该有。

**（a）OOD：语料被重造过，汇总是旧的。**

| | 今天的语料/标签 | `data/ood_summary.json` |
| --- | --- | --- |
| 总行数 | **45** | 43 |
| `layered_mesh` | **15** | 14 |
| `nested_diamond` | **10** | 9 |
| derived-only 行 | **13** | 10 |

`make_ood.mjs` 自己的断言输出今天也写着 `derivedOnlyDriftRows: 13` ——
也就是说 **V3 报告 §12.2 的"共 43 行 / 其中 10 条刻意造的派生字段行"描述的不是今天的探针**。
基线与标签**零分歧**（45 行里 0 行不一致），所以规则本身没问题，纯粹是汇总没跟上。

**（b）对抗：汇总来自一个更早的探针（连 `scale` 都还不是真值），且有 2 行真分歧。**

- `adv_summary.json` 的 `byScale` **只有一组 `20`（n=60）**；今天的探针 `scale` 取值是
  `20 / 27 / 28 / 29`。一个把 scale 写死成常数的版本，不是今天的探针。
- 今天有 **2 行**标签与基线不一致（已作为不变量钉进参考）：

  | 行 | 标签 | 基线 | 含义 |
  | --- | --- | --- | --- |
  | `..._two_derived_cause_23_...` | `UNKNOWN` | `drift` | 它的两个原因在依赖闭包上不再"互不相干"，级联根唯一 |
  | `..._single_control_31_...` | `drift` | `UNKNOWN` | 它不再有唯一的级联根，"单因控制"这个前提没被满足 |

  这两行正是对抗探针**刻意要造**的那种形状（结构代理 ≠ 构造出来的真值），所以它们是
  **探针的难度**，不是缺陷 —— 但它们此前从未被写下来过，谁也不知道有 2 行。

### 14.3 落了什么

- `data/ood_baseline.json`、`data/adv_baseline.json`（受版本控制）：基线参考，
  内含三个语料文件的 sha256 + 逐组计数 + 与标签不一致的行清单。
- `score_ood.py --gate / --write-reference / --selfcheck`。
- `scripts/rdmd_ood_gate.mjs` + 两个 npm 门：
  `experiment:rdmd-ood:gate`、`experiment:rdmd-ood:gate:selfcheck`。
- 门的负对照**分两步**，缺一不可：先证"当前这一跑真的过"（否则"扰动后失败"毫无信息量 ——
  一个恒失败的门当然会失败），再扰动一个计数证"它真的会红，且指出被改的那一处"。
  只做第二步的门可能是永远报错，只做第一步的门可能是永远通过。

实测（本机，无 GPU）：

```
ood   gate       PASS   45 行 / 4 个 kind 组逐位一致，0 行与标签不一致
adv   gate       PASS   60 行 / 2 个 kind 组逐位一致，2 行与标签不一致（与参考记下的完全一致）
ood   selfcheck  PASS   扰动 byScale/16.n 6 -> 7 之后报出 1 处差异并指到该处
adv   selfcheck  PASS   扰动 byScale/20.n 17 -> 18 之后报出 1 处差异并指到该处
```

### 14.4 验收门本身的负对照：从"会静默失效"改成"干净 clone 也能跑"

`scripts/test_rdmd_acceptance.py` 本来就有 8 个 case、本来就在测"门必须会说 NO"。
它的问题不是逻辑，是**依赖**：它读 `sft/test.jsonl`（37MB，被 gitignore，由 `generate.mjs` 派生）。
干净 clone 上的后果不是"少测一点"，而是 `write_predictions` 直接 `FileNotFoundError`
—— 一套从不运行的测试等于没有测试。

改法是**自足夹具**：图、SFT 行、原始 case 现场造，只依赖被测试的那份代码。
夹具不是"跑一遍把输出抄下来"，而是按构造满足每项判据的前提：

| 判据 | 夹具怎么保证它有意义 |
| --- | --- |
| `primary_derived_only` | 10 行 drift 里 5 行只改 `artifact`/`output`（比值 0.5，落在 §6 的 0.473±0.05 内，不会触发假警报） |
| `step_layer_node` | 真凶 `n2` 的 `kind` 是 `agent_step`，10 行都算得进分母 |
| `status_shortcut` | 让**下游** `n3` 的状态最坏（`cancelled`）而真凶是 `n2` → 捷径**指错**（top1 = 0），差是 1.0 而不是恒为 0 |
| 覆盖度守卫 | 预测 = gold，覆盖 100% |

新增 case 5b：**语料缺失必须表现为"未测到"**，不能变成"通过"，也不能被读成"模型不行"。

实测：把 `sft/test.jsonl` 与 `data/{train,development,test}.jsonl` 全部挪走后，
`experiment:rdmd-acceptance:test` 仍然 `ALL ACCEPTANCE TESTS PASSED`。

`scripts/_rdmd_acceptance_selftest.py` 是**另一个**用途（量真语料上那三项到底是多少，
并回答"test split 里有几行真凶在 step 层" —— 实测 **142/1665**，派生字段子集 **676/1427，比值 0.474**），
所以它必须要有真语料。它以前在语料缺失时报 `step_layer_node=None (expected 1.0)`
—— 把"没测到"说成了"接线错了"。现在显式 **exit 3 + 一句人话**。

### 14.5 门钉住了什么、**没有**修什么

**钉住了**：基线在这个语料上怎么算、和哪些标签不一致。这三样任何一项变了，门就红。

**没有修，而且不该由这一轮偷偷"修"**：

`*_summary.json` 里的 `model_*` 列，以及 `*_verdicts.jsonl`，说的都是**旧语料**。
对抗那侧尤其明显：`adv_verdicts.jsonl` 的 60 个 id 里**有 35 个在今天 60 行的标签里根本不存在**
（旧命名 `_220.._249` vs 今天 `_2.._60`），而 `ood_verdicts.jsonl` 的 43 个 id 里
有 2 个已不存在、另有 4 个新行没有判定。也就是说 §12–13 表里的模型列**无法**用今天的语料复现。

要刷新它们只有一条路：**在当前探针上重跑一次模型**（要 GPU 与那份权重）。
在此之前，那些模型列的正确读法是"某一版旧探针上的数字"，而不是"今天这个探针上的数字"。
把这件事写在门里而不是悄悄重算，是因为重算需要一个不在本机上的东西 ——
而"用手边的数字凑一个看起来完整的表"正是这个门存在的理由。
"""


def main():
    text = io.open(PATH, encoding='utf-8').read()
    headings = re.findall(r'^## .+$', CONTENT, flags=re.M)
    marker = headings[0] if headings else CONTENT.strip()[:60]
    if marker and marker in text:
        print('already present, skip:', marker)
        return 0
    io.open(PATH, 'w', encoding='utf-8', newline='\n').write(text.rstrip('\n') + '\n' + CONTENT)
    print('appended; new length =', len(io.open(PATH, encoding='utf-8').read()))
    return 0


if __name__ == '__main__':
    sys.exit(main())
