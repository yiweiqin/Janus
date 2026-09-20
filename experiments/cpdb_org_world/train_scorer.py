"""CPDB（能力画像依赖集束）打分器的训练脚本。

## 这件事在做什么

方案二要的是两个分数：`dependency`（规划时谁适合喂谁）与 `similarity`（执行不佳时谁适合
顶替谁，以最小能力改动）。现在这两个分数是**手写的**（`lib/pairs.mjs` 的 `teacher*` 与
契约里的 `dependencyScore` / `similarityScore`），常数靠人调。本脚本把它换成**学出来的**：
输入是 `lib/features.mjs` 产出的定长特征（训练/推理同一份代码），输出是两个 5 档分类头。

## 关于标签，必须说清楚

这一版训练的标签来自 `data/full/human_labels.jsonl`，`annotatorId = prelabel_v1`，
也就是**由规则 teacher 生成的 AI 标注**，不是人工金标。因此本模型的正确读法是
「把规则蒸馏成一个可微、可继续训练的模型」，而不是「模型发现了规则之外的东西」。
它的价值在于：
  - 训练/评估/导出/JS 推理这条链路被完整跑通一次，换标签只要重跑一条命令；
  - 它是后续任何人标/AI 判分版本必须先超过的**基线**；
  - 规则里那些手调常数（0.62 / 0.28 / 0.22 / …）被换成了学出来的权重，
    并且能被 feature-block 消融量化。

## 协议

  - 超参在 `development` 上选（每个候选只喂 train），选出后**用 train+development 重训**
    作为交付权重；两者在 `test` 上的指标都如实记录。
  - 契约里那两个手写打分器在**同一批 test 行**上算作对比基线，一并记录。

## 关于 `test` 这个"泛化"指标，必须说清楚

数据集是 `splitBy: orgId` 切的，所以 `test` 落在**没见过的 org** 上。第一版报告里
把它写成了"泛化指标"，**这是错的**。实测：`test` 有 791/799（99.0%）落在训练时已经见过的
`(leftFacet, rightFacet)` 格子上，79.2% 的 test agent 也在训练集里出现过。
按 org 切只挡住了"组织"，没挡住"角色"。

更直白的对账：533 格的 facet 对众数查表在 test 上拿到依赖 86.0% / 相似 85.9%，
而 92 维 MLP 是 87.0% / 85.7%（相似度那轴查表还更高）。也就是说这个 `test` 分数
**分不清"模型学到了能力语义"和"模型记住了角色对"**。

上面的 `mlp` 分数与 `sweep` 仍然是有效的**蒸馏指标**（模型复现 teacher 程度），
但不能当作泛化证据。要看泛化，走 `--diagnose`：它跑 4 种留出方案 × 2 种特征变体，
与查表/线性基线同批同折比较。判据与结论见
`docs/ubuddy-v4-cpdb-scorer-diagnosis.zh-CN.md`。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import time
from collections import Counter
from pathlib import Path

import numpy as np
import torch
from torch import nn

SCALE = [0.0, 0.25, 0.5, 0.75, 1.0]
AXES = ("dependency", "similarity")


# --------------------------------------------------------------------------------------
# 数据
# --------------------------------------------------------------------------------------

def read_jsonl(path: Path) -> list[dict]:
    with path.open("r", encoding="utf8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def load_matrix(matrix_dir: Path) -> dict:
    spec = json.loads((matrix_dir / "matrix.json").read_text(encoding="utf8"))
    rows, dim = spec["rows"], spec["dimension"]
    x = np.fromfile(matrix_dir / "X.f32", dtype="<f4")
    if x.size != rows * dim:
        raise SystemExit(f"X size mismatch: {x.size} != {rows}*{dim}")
    data = {
        "spec": spec,
        "x": x.reshape(rows, dim).astype(np.float32),
        "rows": read_jsonl(matrix_dir / "rows.jsonl"),
        "baselines": {row["id"]: row for row in read_jsonl(matrix_dir / "baselines.jsonl")},
        "y": {
            "dependency": np.fromfile(matrix_dir / "y_dependency.i8", dtype="<i1").astype(np.int64),
            "similarity": np.fromfile(matrix_dir / "y_similarity.i8", dtype="<i1").astype(np.int64),
        },
    }
    for axis in AXES:
        if data["y"][axis].size != rows:
            raise SystemExit(f"y_{axis} size mismatch: {data['y'][axis].size} != {rows}")
    return data


def split_indices(rows: list[dict], name: str) -> np.ndarray:
    return np.array([row["index"] for row in rows if row["split"] == name], dtype=np.int64)


# --------------------------------------------------------------------------------------
# 模型
# --------------------------------------------------------------------------------------

class Scorer(nn.Module):
    """两个独立的 5 档分类头共用一个躯干。

    为什么是「两个头」而不是「一个头出两个数」：`schema.json` 的 `forbidden` 里
    明确禁止合成总分（`combinedScore`），两个轴必须分开打。两个头共用躯干只是省参数，
    不构成合成 —— 两个头的输出永远不会被加起来。
    """

    def __init__(self, dim: int, hidden: list[int], dropout: float = 0.1):
        super().__init__()
        layers: list[nn.Module] = []
        width = dim
        for size in hidden:
            layers += [nn.Linear(width, size), nn.GELU(), nn.Dropout(dropout)]
            width = size
        self.trunk = nn.Sequential(*layers) if layers else nn.Identity()
        self.dependency = nn.Linear(width, len(SCALE))
        self.similarity = nn.Linear(width, len(SCALE))

    def forward(self, x: torch.Tensor) -> dict[str, torch.Tensor]:
        z = self.trunk(x)
        return {"dependency": self.dependency(z), "similarity": self.similarity(z)}


class Standardizer:
    """按 train 的均值/方差标准化，并把这两个统计量一起存进权重文件。

    标准化参数是模型的一部分：推理侧少了它，分数会整体偏掉，而且是静默偏掉。
    """

    def __init__(self, mean: np.ndarray, std: np.ndarray):
        self.mean = mean.astype(np.float32)
        self.std = std.astype(np.float32)

    @classmethod
    def fit(cls, x: np.ndarray) -> "Standardizer":
        mean = x.mean(axis=0)
        std = x.std(axis=0)
        std[std < 1e-6] = 1.0
        return cls(mean, std)

    def transform(self, x: np.ndarray) -> np.ndarray:
        return (x - self.mean) / self.std


# --------------------------------------------------------------------------------------
# 评估
# --------------------------------------------------------------------------------------

def softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    exponent = np.exp(shifted)
    return exponent / exponent.sum(axis=1, keepdims=True)


def axis_metrics(logits: np.ndarray, labels: np.ndarray) -> dict:
    if labels.size == 0:
        return {"n": 0}
    probabilities = softmax(logits)
    argmax = probabilities.argmax(axis=1)
    expected = probabilities @ np.array(SCALE)
    truth = np.array(SCALE)[labels]
    steps = np.abs(argmax - labels)
    return {
        "n": int(labels.size),
        # 顺序量：判错一档和判错四档是完全不同的事，所以两个都报。
        "exact": round(float((steps == 0).mean()), 4),
        "within_one_step": round(float((steps <= 1).mean()), 4),
        # 用期望值算 MAE 而不是 argmax：线上要的是连续分，档位只是标注契约。
        "mae_expected": round(float(np.abs(expected - truth).mean()), 4),
        "mae_argmax": round(float(np.abs(np.array(SCALE)[argmax] - truth).mean()), 4),
        "mean_step_error": round(float(steps.mean()), 4),
        "predicted_class_counts": {
            str(index): int(count)
            for index, count in enumerate(np.bincount(argmax, minlength=len(SCALE)))
        },
    }


def contract_baseline_metrics(data: dict, indices: np.ndarray, axis: str) -> dict:
    """契约里那个手写打分器，在同一批行上的成绩。

    它是**连续**分，而标签在 5 档标尺上。两种比法都有意义，所以都给：
      - `quantized_exact`：先把基线四舍五入到最近的档，再看命中率（与模型同口径）；
      - `mae_continuous`：直接拿连续分与档位真值比（基线的原生口径）。
    只报后者会让基线看起来更好，只报前者则抹掉了基线的连续优势。
    """
    field = "contractDependency" if axis == "dependency" else "contractSimilarity"
    order = {int(row["index"]): row["id"] for row in data["rows"]}
    scores = np.array([data["baselines"][order[int(i)]][field] for i in indices], dtype=np.float64)
    labels = data["y"][axis][indices]
    truth = np.array(SCALE)[labels]
    steps = np.array(SCALE)
    quantized = steps[np.abs(scores[:, None] - steps[None, :]).argmin(axis=1)]
    return {
        "n": int(labels.size),
        "quantized_exact": round(float((quantized == truth).mean()), 4),
        "quantized_within_one_step": round(float((np.abs(quantized - truth) <= 0.25 + 1e-9).mean()), 4),
        "mae_continuous": round(float(np.abs(scores - truth).mean()), 4),
    }


def majority_baseline_metrics(labels_train: np.ndarray, labels_eval: np.ndarray) -> dict:
    majority = int(np.bincount(labels_train, minlength=len(SCALE)).argmax())
    truth = np.array(SCALE)[labels_eval]
    return {
        "n": int(labels_eval.size),
        "majority_class": SCALE[majority],
        "exact": round(float((labels_eval == majority).mean()), 4),
        "mae_argmax": round(float(np.abs(np.array(SCALE)[majority] - truth).mean()), 4),
    }


# --------------------------------------------------------------------------------------
# 训练
# --------------------------------------------------------------------------------------

def train_one(config: dict, data: dict, train_idx: np.ndarray, dev_idx: np.ndarray, seed: int = 20260920) -> dict:
    torch.manual_seed(seed)
    np.random.seed(seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    scaler = Standardizer.fit(data["x"][train_idx])
    x_train = torch.from_numpy(scaler.transform(data["x"][train_idx])).to(device)
    x_dev = torch.from_numpy(scaler.transform(data["x"][dev_idx])).to(device)
    y_train = {axis: torch.from_numpy(data["y"][axis][train_idx]).to(device) for axis in AXES}
    y_dev = {axis: torch.from_numpy(data["y"][axis][dev_idx]).to(device) for axis in AXES}

    model = Scorer(data["x"].shape[1], config["hidden"], config.get("dropout", 0.1)).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=config["lr"], weight_decay=config.get("weight_decay", 0.0))
    criterion = nn.CrossEntropyLoss(label_smoothing=config.get("label_smoothing", 0.0))

    best = {"dev_loss": math.inf, "epoch": -1, "state": None}
    patience = config.get("patience", 40)
    stale = 0
    epochs_run = 0
    for epoch in range(config.get("epochs", 400)):
        epochs_run = epoch + 1
        model.train()
        optimizer.zero_grad(set_to_none=True)
        out = model(x_train)
        loss = sum(criterion(out[axis], y_train[axis]) for axis in AXES)
        loss.backward()
        optimizer.step()

        model.eval()
        with torch.no_grad():
            dev_out = model(x_dev)
            dev_loss = float(sum(criterion(dev_out[axis], y_dev[axis]) for axis in AXES).item())
        if dev_loss < best["dev_loss"] - 1e-6:
            best = {
                "dev_loss": dev_loss,
                "epoch": epoch,
                "state": {k: v.detach().cpu().clone() for k, v in model.state_dict().items()},
            }
            stale = 0
        else:
            stale += 1
            if stale >= patience:
                break

    model.load_state_dict(best["state"])
    model.eval()
    with torch.no_grad():
        dev_logits = {axis: model(x_dev)[axis].cpu().numpy() for axis in AXES}
    return {
        "model": model,
        "scaler": scaler,
        "dev_loss": best["dev_loss"],
        "best_epoch": best["epoch"],
        "epochs_run": epochs_run,
        "dev_metrics": {axis: axis_metrics(dev_logits[axis], data["y"][axis][dev_idx]) for axis in AXES},
    }


def predict(model: Scorer, scaler: Standardizer, x: np.ndarray) -> dict[str, np.ndarray]:
    device = next(model.parameters()).device
    model.eval()
    with torch.no_grad():
        logits = model(torch.from_numpy(scaler.transform(x)).to(device))
    return {axis: logits[axis].cpu().numpy() for axis in AXES}


# --------------------------------------------------------------------------------------
# 特征块消融
# --------------------------------------------------------------------------------------

def feature_groups(names: list[str]) -> dict[str, np.ndarray]:
    """按名字把列分块，供消融使用。分块依据见报告里的「每一块值多少」。"""
    flow = {
        "dep_ratio_lr", "dep_ratio_rl", "dep_hit_lr", "dep_hit_rl",
        "produces_l", "consumes_l", "produces_r", "consumes_r",
    }
    groups = {
        "flags": [i for i, n in enumerate(names) if n.startswith("same_")],
        "family_onehot": [i for i, n in enumerate(names) if n.startswith("family_")],
        "facet_onehot": [i for i, n in enumerate(names) if n.startswith("facet_")],
        "flow": [i for i, n in enumerate(names) if n in flow],
        "set_similarity": [i for i, n in enumerate(names) if n.startswith(("jaccard_", "contain_"))],
        # `same_org` / `same_domain` / `same_topic` 只存在于 Agent 记录，published profile 里没有。
        # 单独拎出来，是为了回答「只拿画像能不能达到同样效果」这个部署问题。
        "not_in_profile": [i for i, n in enumerate(names) if n in {"same_org", "same_domain", "same_topic"}],
    }
    return {name: np.array(cols, dtype=np.int64) for name, cols in groups.items()}


def zero_groups(x: np.ndarray, cols: np.ndarray) -> np.ndarray:
    copy = x.copy()
    copy[:, cols] = 0.0
    return copy


# --------------------------------------------------------------------------------------
# 落盘
# --------------------------------------------------------------------------------------

def state_dict_to_json(state: dict) -> dict:
    out = {}
    for key, value in state.items():
        out[key] = [round(float(item), 8) for item in value.reshape(-1).tolist()]
    return out


def save_artifact(out_dir: Path, model: Scorer, scaler: Standardizer, spec: dict, metrics: dict, predictions: list[dict]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    # 这一份权重用的是哪组列。取值优先级：显式传给 spec 的 → 从矩阵的 `variants` 里按变体名取
    # → 全量（旧路径）。中间那一层是给 `main()` 用的，它手上是完整的矩阵规格。
    variant = spec.get("variant", "full")
    columns = spec.get("columns")
    if columns is None:
        columns = (spec.get("variants") or {}).get(variant, {}).get("columns")
    if columns is None:
        columns = list(range(spec["dimension"]))
    columns = [int(item) for item in columns]
    # `width` 是这一份权重实际吃的列数。`layers` 的第一层必须等于它，
    # 否则 JS 侧会在加载时炸 —— 那时候已经是部署阶段了，所以这里先自检。
    hidden = [layer.out_features for layer in model.trunk if isinstance(layer, nn.Linear)]
    # 把「哪些 key 是 Linear、按什么顺序、形状多大」显式写进产物。
    # 不写的话，推理侧只能靠 `trunk.0 / trunk.3 / trunk.6…` 这种下标规律去猜，
    # 而一旦 `Scorer` 里多插一个非参数层（比如换激活），那份猜测就会**静默**错位：
    # 权重照样加载、照样出分，只是分数悄悄不对。宁可把结构说清楚。
    layers = []
    width = len(columns)
    for position, size in enumerate(hidden):
        layers.append({"index": position, "in": width, "out": size, "weightKey": f"trunk.{position * 3}.weight", "biasKey": f"trunk.{position * 3}.bias"})
        width = size
    if hidden and layers[0]["in"] != len(columns):
        raise SystemExit(f"第一层宽度 {layers[0]['in']} 与变体列数 {len(columns)} 不一致")
    if scaler.mean.size != len(columns):
        raise SystemExit(f"标准化参数宽度 {scaler.mean.size} 与变体列数 {len(columns)} 不一致")
    heads = {
        axis: {"in": width, "out": len(SCALE), "weightKey": f"{axis}.weight", "biasKey": f"{axis}.bias"}
        for axis in AXES
    }
    weights = {
        "schema": "cpdb_scorer_weights/v1",
        "featureSpec": spec["featureSpec"],
        "dimension": spec["dimension"],
        "featureNames": spec["featureNames"],
        # 训练时用的是哪一组列。**必须落盘**：`no_identity` 与 `full` 的维度不同，
        # 而 JS 侧加载时要按同一组列裁，否则 `mean/std` 会与别的列对齐 ——
        # 结果仍然是一个合法向量，分数静默错掉。
        "variant": spec.get("variant", "full"),
        "columns": spec["columns"],
        "vocab": spec["vocab"],
        "scale": SCALE,
        "provenance": spec.get("provenance"),
        "standardizer": {
            "mean": [round(float(v), 8) for v in scaler.mean.tolist()],
            "std": [round(float(v), 8) for v in scaler.std.tolist()],
        },
        "architecture": {"activation": "gelu", "hidden": hidden, "heads": list(AXES), "classes": len(SCALE)},
        "layers": layers,
        "headLayers": heads,
        "stateDict": state_dict_to_json(model.state_dict()),
        "note": "stateDict 每个张量按 reshape(-1) 展平存成一行；JS 推理侧按 `layers` / `headLayers` 给出的 weightKey 与行优先顺序重建，不靠下标猜结构。",
    }
    (out_dir / "weights.json").write_text(json.dumps(weights, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    (out_dir / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    with (out_dir / "predictions.jsonl").open("w", encoding="utf8") as handle:
        for row in predictions:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


# --------------------------------------------------------------------------------------
# 诊断：这个模型到底在做什么
# --------------------------------------------------------------------------------------
#
# 这一节回答的问题与 `main()` 完全不同。`main()` 问的是「模型多像 teacher」，
# 这一节问的是「把角色留出之后，它还剩下多少」。前者是蒸馏指标，后者才关系到
# V4 方案二成不成立。
#
# 2 × 4 矩阵：4 种留出方案（`lib/splits.mjs`）× 2 种特征变体（`features.mjs`）。
# 变体那一维不是修饰：`facet_onehot` 是 facet 的**恒等编码**，留出某个 facet 时
# 那些列训练全程为 0，`full` 特征集**按构造就不可能泛化**。所以「留出 facet 后掉分了」
# 这一个观察，分不开下面两种解释：
#
#   (a) 模型只在记角色，没学到能力语义；
#   (b) 特征里根本没给模型可迁移的东西（只给了角色名）。
#
# `no_identity` 去掉全部角色恒等列，只留 flags + flow + set_similarity。它回答的正是
# 方案二的原始命题：**光靠能力描述本身，有没有可迁移的信号**。
#
# 五个同台竞争者（同一批折、同一批标签）：
#
#   majority_global   全局众数档 —— 「有没有任何信号」的下界
#   lookup_facet_pair 533 格众数查表 —— 上一轮与 MLP 打平的那个
#   lookup_family_pair 36 格查表 —— 契约的 6-role 粒度就是这个东西
#   logreg            线性模型（= 现有 `hidden: []` 那一档，即多分类 logistic 回归）
#   mlp               现有架构
#
# `logreg` 不是另写的一份实现：`Scorer` 在 `hidden=[]` 时躯干是 `Identity`，
# 两个头各是一个 Linear + softmax + 交叉熵，**这就是多分类 logistic 回归**，
# 直接复用 `train_one` 才能保证它与 MLP 的差别只有「有没有隐藏层」这一个变量。

# 判据在跑之前就写死。这类诊断最常见的失败方式不是算错，而是**看到数之后**
# 挑一个能支持自己期望的口径，所以口径与阈值都作为常量钉在这里，
# 并原样写进 `diagnosis.json` 的 `verdict.criteria` —— 谁改口径就得改这段文字。
PRE_REGISTERED_CRITERIA = [
    "MLP 同档率 − 查表同档率 < 2σ → 模型不被证实，交表/规则",
    "MLP 掉到接近 majority_global → 能力描述里没有可迁移信号，方案二前提需重做",
    "MLP 明显赢过查表且赢过 logreg → 确有可迁移信号，进入下一轮",
]
VERDICT_SUBJECT = "facet 折 × no_identity 特征 × similarity 轴"


def load_folds(matrix_dir: Path) -> dict:
    """`folds.jsonl` → `{id, positions, schemes, lookupKeys}`。

    折文件与矩阵分开存（见 `export_training_matrix.mjs`），因为折是**评估口径**，
    不是数据。换一种留出方式不该需要重导 X/y。
    """
    rows = read_jsonl(matrix_dir / "folds.jsonl")
    if not rows:
        raise SystemExit("folds.jsonl 是空的：请用新版 export_training_matrix.mjs 重新导出")
    position_of = {row["id"]: at for at, row in enumerate(read_jsonl(matrix_dir / "rows.jsonl"))}
    missing = [row["id"] for row in rows if row["id"] not in position_of]
    if missing:
        raise SystemExit(f"folds.jsonl 里有 {len(missing)} 个 id 不在 rows.jsonl 里: {missing[:3]}")
    return {
        "rows": rows,
        "positionOf": position_of,
        "positions": np.array([position_of[row["id"]] for row in rows], dtype=np.int64),
    }


def diagnose_fold_indices(fold_rows: list, scheme: str, fold: int, count: int) -> tuple[np.ndarray, np.ndarray]:
    """第 `fold` 折的 train / eval 下标。

    `train` 是 `eval` 的**补集** —— 这不是优化，是定义。被留出的组只要漏进 train 一条，
    这一折就又变成「见过的组」了。`splits.test.mjs` 在 JS 侧对同一件事逐条断言。
    """
    evaluation = np.zeros(count, dtype=bool)
    for at, row in enumerate(fold_rows):
        if fold in (row.get(scheme) or []):
            evaluation[at] = True
    return np.flatnonzero(~evaluation), np.flatnonzero(evaluation)


def lookup_metrics(train_keys: np.ndarray, train_labels: np.ndarray, eval_keys: np.ndarray, eval_labels: np.ndarray) -> dict:
    """众数查表。键在 train 里没见过时回落到全局众数，并如实报出回落了多少条。

    报 `unseen` 很关键：`facet_pair` 折下它是 0（格子被整体留出，模型和查表都没见过），
    而 `org` 折下它接近 0 但格子大量重合 —— 两个"接近"的含义完全不同，
    不把数字摊开就容易读串。
    """
    table: dict[str, np.ndarray] = {}
    for key, label in zip(train_keys, train_labels):
        counts = table.setdefault(key, np.zeros(len(SCALE), dtype=np.int64))
        counts[label] += 1
    fallback = int(np.bincount(train_labels, minlength=len(SCALE)).argmax())
    predicted = np.empty(eval_labels.size, dtype=np.int64)
    unseen = 0
    for at, key in enumerate(eval_keys):
        counts = table.get(key)
        if counts is None:
            unseen += 1
            predicted[at] = fallback
        else:
            predicted[at] = int(counts.argmax())
    truth = np.array(SCALE)[eval_labels]
    steps = np.abs(predicted - eval_labels)
    return {
        "n": int(eval_labels.size),
        "tableCells": len(table),
        "unseen": unseen,
        "unseenRate": round(unseen / max(1, eval_labels.size), 4),
        "exact": round(float((steps == 0).mean()), 4),
        "within_one_step": round(float((steps <= 1).mean()), 4),
        "mae_argmax": round(float(np.abs(np.array(SCALE)[predicted] - truth).mean()), 4),
    }


def calibration_table(expected: np.ndarray, labels: np.ndarray, bins: int = 5) -> list[dict]:
    """连续分的可靠性：把 `expected` 分箱，比「平均预测值」与「实际档位均值」。

    为什么要标定而不只看同档率：线上用的是连续分。一个同档率很高但 `expected` 整体
    偏低的模型，在「按分数排优先级」的用法里会系统性排错，而同档率看不出来。
    """
    truth = np.array(SCALE)[labels]
    edges = np.linspace(0.0, 1.0, bins + 1)
    out = []
    for at in range(bins):
        low, high = edges[at], edges[at + 1]
        inside = (expected >= low) & (expected < high if at < bins - 1 else expected <= high)
        if not inside.any():
            out.append({"bin": [round(low, 3), round(high, 3)], "n": 0})
            continue
        out.append({
            "bin": [round(low, 3), round(high, 3)],
            "n": int(inside.sum()),
            "meanExpected": round(float(expected[inside].mean()), 4),
            "meanActual": round(float(truth[inside].mean()), 4),
            "gap": round(float(expected[inside].mean() - truth[inside].mean()), 4),
        })
    overall = float(np.abs(expected - truth).mean()) if expected.size else 0.0
    return {"bins": out, "maeExpected": round(overall, 4)}


def kind_probe_summary(kinds: list) -> dict:
    """探针的「下界」：不看特征、只猜众数能有多准。

    要预测的是 pair 的 `kind`（四类采样类型）。`kind` 是数据集**构造规则**的产物
    （`hard_negative` 是「不同 family 且不同 org」专门造出来的），服务期根本不知道它。
    如果同一批特征能把 `kind` 轻易分出来，说明特征里编码了构造规则 ——
    那么「模型学到了任务规律」这个说法就要打折扣，它可能只是学会了「这两条为什么被采进来」。
    """
    counts = Counter(kinds)
    top = counts.most_common(1)[0]
    return {
        "classes": {name: int(count) for name, count in sorted(counts.items())},
        "majorityClass": top[0],
        "majorityRate": round(top[1] / max(1, len(kinds)), 4),
        "note": "majorityRate 是「不看特征瞎猜」的上界；线性探针的准确率若接近它，说明特征没编码 kind。",
    }


def run_diagnose(args) -> None:
    matrix_dir = Path(args.matrix_dir)
    data = load_matrix(matrix_dir)
    spec = data["spec"]
    folds = load_folds(matrix_dir)
    count = spec["rows"]
    if folds["rows"].__len__() != count:
        raise SystemExit(f"folds.jsonl 有 {len(folds['rows'])} 行，矩阵有 {count} 行")

    variants = spec.get("variants") or {}
    if not variants:
        raise SystemExit("matrix.json 里没有 variants：请用新版 export_training_matrix.mjs 重新导出")

    seeds = [int(seed) for seed in args.seeds.split(",") if seed.strip()]
    mlp_config = {"name": "mlp-diagnose", "hidden": [256, 128], "dropout": 0.1, "lr": 2e-3, "weight_decay": 1e-4}
    logreg_config = {"name": "logreg", "hidden": [], "dropout": 0.0, "lr": 3e-3, "weight_decay": 0.0}
    for config in (mlp_config, logreg_config):
        config["epochs"] = args.epochs
        config["patience"] = args.patience

    lookup_sites = [("facet_pair", "facet"), ("family_pair", "family")]
    site_keys = {
        name: np.array([row["lookupKeys"][key] for row in folds["rows"]], dtype=object)
        for name, key in lookup_sites
    }
    kinds = [row["kind"] for row in data["rows"]]
    kind_labels = sorted(set(kinds))
    kind_target = np.array([kind_labels.index(kind) for kind in kinds], dtype=np.int64)

    report = {
        "schema": "cpdb_scorer_diagnosis/v1",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "environment": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "device": "cuda" if torch.cuda.is_available() else "cpu",
            "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        },
        "matrix": {
            "rows": count,
            "featureSpec": spec["featureSpec"],
            "labelSource": spec["labelSource"],
            "inputs": spec["inputs"],
            "outputs": spec["outputs"],
        },
        "seeds": seeds,
        "configs": {"mlp": mlp_config, "logreg": logreg_config},
        "note": "mlp/logreg 每个格子跑 len(seeds) 个种子，报 mean±std（std 是**跨种子**的，因此也是判据里那个 2σ 的来源）。",
        "cells": [],
        "kindProbe": {},
    }

    # 特征探针：同一批特征能不能预测 kind。跑在 full 变体上（列最多，最有「作弊」能力）。
    #
    # 这里必须**真的把探针训到 kind 上**。第一版写成了「拿 dependency 头的输出和 kind 比」，
    # 于是得到一个 4 类问题上 5% 的准确率（比瞎猜的 29% 还差）—— 那不是「特征没编码 kind」的
    # 证据，那是探针压根没训。一个错误方向的探针会给出一个看起来像结论的数，所以要盯住
    # 「它是不是比 majorityRate 好」来判断探针本身是否有效，而不是直接读那个数。
    full_columns = np.array(variants["full"]["columns"], dtype=np.int64)
    probe = kind_probe_summary(kinds)
    train_probe, eval_probe = split_indices(data["rows"], "train"), split_indices(data["rows"], "test")
    kind_column = np.array([kind_labels.index(kinds[int(i)]) for i in range(count)], dtype=np.int64)
    if len(kind_labels) >= 2:
        probe_data = {
            **data,
            "x": data["x"][:, full_columns],
            # 两个头都喂 kind：`train_one` 是一个两头的模型，这里只借其中一个头当多分类器。
            "y": {"dependency": kind_column, "similarity": kind_column},
        }
        probe_run = train_one({**logreg_config, "epochs": max(120, args.epochs), "patience": args.patience},
                              probe_data, train_probe, eval_probe, seed=seeds[0])
        probe_pred = predict(probe_run["model"], probe_run["scaler"],
                             probe_data["x"][eval_probe])["dependency"].argmax(axis=1)
        probe["probeAccuracy"] = round(float((probe_pred == kind_column[eval_probe]).mean()), 4)
        probe["probeN"] = int(eval_probe.size)
        probe["probeUsable"] = bool(probe["probeAccuracy"] > probe["majorityRate"] + 0.05)
        probe["reading"] = (
            "探针有效（明显好于众数），特征编码了数据集构造规则；模型学到的可能部分是「这两条为什么被采进来」。"
            if probe["probeUsable"] else
            "探针与众数相当或更差：特征里没有 kind 的可分信息，这一条不构成对模型的质疑。"
        )
    else:
        probe["probeUsable"] = False
        probe["reading"] = "kind 只有一个取值，探针无意义。"
    report["kindProbe"] = probe

    # 折方案的名单以 `matrix.json` 为准（JS 侧 `lib/splits.mjs` 是唯一来源），
    # 不在 Python 里再抄一份常量 —— 抄一份就会有一次忘了同步。
    schemes = pick(spec["folds"].keys(), args.diagnose_schemes, "方案")
    variant_names = pick(variants.keys(), args.diagnose_variants, "特征变体")
    report["selected"] = {"schemes": schemes, "variants": variant_names}
    for scheme in schemes:
        scheme_folds = spec["folds"][scheme]
        for variant in variant_names:
            columns = np.array(variants[variant]["columns"], dtype=np.int64)
            x = data["x"][:, columns]
            cell = {
                "scheme": scheme,
                "variant": variant,
                "width": int(columns.size),
                "foldCount": int(scheme_folds["k"]),
                "folds": [],
            }
            for fold in range(scheme_folds["k"]):
                train_idx, eval_idx = diagnose_fold_indices(folds["rows"], scheme, fold, count)
                if not train_idx.size or not eval_idx.size:
                    raise SystemExit(f"{scheme} 第 {fold} 折: train={train_idx.size} eval={eval_idx.size}")
                entry = {"fold": fold, "trainN": int(train_idx.size), "evalN": int(eval_idx.size)}

                # 不训练的三个基线。
                entry["majorityGlobal"] = {
                    axis: majority_baseline_metrics(data["y"][axis][train_idx], data["y"][axis][eval_idx])
                    for axis in AXES
                }
                entry["lookupFacetPair"] = {
                    axis: lookup_metrics(site_keys["facet_pair"][train_idx], data["y"][axis][train_idx],
                                         site_keys["facet_pair"][eval_idx], data["y"][axis][eval_idx])
                    for axis in AXES
                }
                entry["lookupFamilyPair"] = {
                    axis: lookup_metrics(site_keys["family_pair"][train_idx], data["y"][axis][train_idx],
                                         site_keys["family_pair"][eval_idx], data["y"][axis][eval_idx])
                    for axis in AXES
                }

                # 要训练的：MLP 与 logreg，各跑 len(seeds) 个种子。
                for name, config in (("mlp", mlp_config), ("logreg", logreg_config)):
                    runs = []
                    for seed in seeds:
                        run = train_one(config, {**data, "x": x}, train_idx, eval_idx, seed=seed)
                        logits = predict(run["model"], run["scaler"], x[eval_idx])
                        runs.append({
                            axis: axis_metrics(logits[axis], data["y"][axis][eval_idx])
                            for axis in AXES
                        })
                    entry[name] = {axis: aggregate_runs([run[axis] for run in runs]) for axis in AXES}
                cell["folds"].append(entry)
                print(
                    f"[diagnose] {scheme:<11} {variant:<12} fold={fold} n={entry['evalN']:<5} "
                    f"mlp.exact={entry['mlp']['similarity']['exact']['mean']:.4f}"
                    f"±{entry['mlp']['similarity']['exact']['std']:.4f} "
                    f"lookupFacet={entry['lookupFacetPair']['similarity']['exact']:.4f} "
                    f"lookupFamily={entry['lookupFamilyPair']['similarity']['exact']:.4f}",
                    flush=True,
                )

            cell["summary"] = {
                "mlp": {axis: summarise_metric(cell["folds"], "mlp", axis, "exact") for axis in AXES},
                "logreg": {axis: summarise_metric(cell["folds"], "logreg", axis, "exact") for axis in AXES},
                "majorityGlobal": {axis: summarise_metric(cell["folds"], "majorityGlobal", axis, "exact") for axis in AXES},
                "lookupFacetPair": {axis: summarise_metric(cell["folds"], "lookupFacetPair", axis, "exact") for axis in AXES},
                "lookupFamilyPair": {axis: summarise_metric(cell["folds"], "lookupFamilyPair", axis, "exact") for axis in AXES},
                "mlpMae": {axis: summarise_metric(cell["folds"], "mlp", axis, "mae_argmax") for axis in AXES},
                "majorityMae": {axis: summarise_metric(cell["folds"], "majorityGlobal", axis, "mae_argmax") for axis in AXES},
            }
            report["cells"].append(cell)

    # 标定：主判据那一格（facet × no_identity）的相似度轴，把各折的 `expected` 池起来看。
    # 只跑了部分格子时跳过标定与判据 —— 判据的锚点是写死的（facet × no_identity），
    # 缺了它就算不出结论，此时宁可明确地说"没算"，也不要换一个口径凑一个数出来。
    subject = next(
        (item for item in report["cells"] if item["scheme"] == "facet" and item["variant"] == "no_identity"),
        None,
    )
    if subject is None:
        report["calibration"] = {}
        report["verdict"] = {
            "outcome": "not_computed",
            "reading": "本次只跑了部分格子，缺少判据锚点（facet 折 × no_identity 变体），因此没有结论。",
            "criteria": PRE_REGISTERED_CRITERIA,
            "subject": "facet 折 × no_identity 特征 × similarity 轴",
        }
    else:
        report["calibration"] = calibration_for(report, data, folds, variants, mlp_config, seeds, "facet", "no_identity")
        report["verdict"] = build_verdict(report, args)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"out": str(out_path), "verdict": report["verdict"]}, ensure_ascii=False, indent=2))


def calibration_for(report, data, folds, variants, config, seeds, scheme, variant) -> dict:
    """重新训一遍主判据那一格，只为拿到每折的 `expected` 序列用于标定。

    重训而不是从 `report` 里捞：`report` 只存了聚合指标（mean/std），
    标定要的是逐条的 `expected`。多跑几次训练的代价远小于把逐条预测塞进诊断报告。
    """
    columns = np.array(variants[variant]["columns"], dtype=np.int64)
    x = data["x"][:, columns]
    expected = {axis: [] for axis in AXES}
    labels = {axis: [] for axis in AXES}
    # `folds` 里没有 k，直接从 report 的主格拿折数。
    cell = next(
        item for item in report["cells"] if item["scheme"] == scheme and item["variant"] == variant
    )
    for fold in range(cell["foldCount"]):
        train_idx, eval_idx = diagnose_fold_indices(folds["rows"], scheme, fold, data["spec"]["rows"])
        run = train_one(config, {**data, "x": x}, train_idx, eval_idx, seed=seeds[0])
        logits = predict(run["model"], run["scaler"], x[eval_idx])
        for axis in AXES:
            probabilities = softmax(logits[axis])
            expected[axis].extend((probabilities @ np.array(SCALE)).tolist())
            labels[axis].extend(data["y"][axis][eval_idx].tolist())
    return {
        axis: calibration_table(np.array(expected[axis]), np.array(labels[axis]))
        for axis in AXES
    }


def aggregate_runs(runs: list[dict]) -> dict:
    """把同格不同种子的指标聚成 mean±std。

    `std` 是**跨种子**的，因此它同时是判据里那个 `2σ` 的来源 —— 判据问的是
    「MLP 与查表的差距，比模型自己换种子抖动的幅度更大吗」。
    """
    out = {}
    for key, value in runs[0].items():
        if isinstance(value, (int, float)):
            values = [float(run[key]) for run in runs]
            out[key] = {"mean": round(float(np.mean(values)), 4), "std": round(float(np.std(values)), 4)}
        else:
            out[key] = value
    return out


def summarise_metric(fold_entries: list[dict], model: str, axis: str, metric: str) -> dict:
    """跨折取平均。每个折自己的种子噪声先聚成 mean，再对折求均值与**折间**标准差。

    两个标准差要分开看：种子 std 小说明训练稳定，折间 std 大说明"留出哪一组"影响很大 ——
    后者才是泛化的真实不确定性，判据用的是它。
    """
    per_fold = []
    seed_stds = []
    for entry in fold_entries:
        node = entry[model][axis][metric]
        if isinstance(node, dict):
            per_fold.append(node["mean"])
            seed_stds.append(node["std"])
        else:
            per_fold.append(float(node))
    return {
        "mean": round(float(np.mean(per_fold)), 4),
        "stdAcrossFolds": round(float(np.std(per_fold)), 4),
        "meanSeedStd": round(float(np.mean(seed_stds)), 4) if seed_stds else 0.0,
        "perFold": [round(float(value), 4) for value in per_fold],
    }


def pick(available, requested: str, what: str) -> list[str]:
    """把 `--diagnose-schemes/--diagnose-variants` 的逗号串解成名单，并校验名字都存在。

    校验是为了防错字：写成 `--diagnose-schemes facet_pair` 却拼成 `facetpair` 时，
    安静地跑 0 个格子会让报告里出现一份「看起来跑过了」的空结论。
    """
    names = list(available)
    wanted = [item.strip() for item in str(requested or "").split(",") if item.strip()]
    if not wanted:
        return names
    unknown = [item for item in wanted if item not in names]
    if unknown:
        raise SystemExit(f"未知的{what}：{unknown}；可选：{names}")
    return wanted


def axis_verdict(cell: dict, axis: str) -> dict:
    """一个轴上把三条判据算出来。

    比较对象是**最强的那个查表器**，不是一个固定的格子数。原因是一条实测：`facet` 折下
    `lookupFacetPair` 的 `unseen` 是 1.0（格子被整体留出，查表全回落成众数），
    于是它退化成了 `majorityGlobal`。拿一个退化到众数的基线去比，"MLP 赢过查表 0.32"
    就变成了一句空话。真正该问的是「它有没有赢过你能建出来的最好的表」，
    所以这里取 `majority ⊔ lookupFacetPair ⊔ lookupFamilyPair` 的最大者，
    并把是谁赢的一起记下来。
    """
    mlp = cell["summary"]["mlp"][axis]
    logreg = cell["summary"]["logreg"][axis]
    majority = cell["summary"]["majorityGlobal"][axis]
    facet_table = cell["summary"]["lookupFacetPair"][axis]
    family_table = cell["summary"]["lookupFamilyPair"][axis]

    tables = {
        "majorityGlobal": majority["mean"],
        "lookupFacetPair": facet_table["mean"],
        "lookupFamilyPair": family_table["mean"],
    }
    best_table_name = max(tables, key=lambda name: tables[name])
    best_table = tables[best_table_name]

    # σ 取「跨种子 std」与「跨折 std」中较大的那个：前者是训练噪声，后者是"留出哪一组"
    # 带来的不确定性。只取前者会低估总不确定性，让判据过于宽松。
    sigma = max(mlp["meanSeedStd"], mlp["stdAcrossFolds"])
    threshold = 2 * sigma

    gap_table = mlp["mean"] - best_table
    gap_logreg = mlp["mean"] - logreg["mean"]
    gap_majority = mlp["mean"] - majority["mean"]

    near_majority = gap_majority < threshold
    beats_table = gap_table > threshold
    beats_logreg = gap_logreg > threshold

    if near_majority:
        outcome = "reframe"
        reading = ("该轴上 MLP 掉到接近 majority_global：**能力描述里没有可迁移信号**。"
                   "这不是调参能修的，方案二在这条轴上的前提需要重做。")
    elif not beats_table:
        outcome = "ship_table"
        reading = ("该轴上 MLP 与最强的表查器差距小于噪声：**模型不被证实**，"
                   "交付表/规则，不要交付这个模型。")
    elif not beats_logreg:
        outcome = "ship_linear"
        reading = ("该轴上 MLP 赢过所有查表器，但与 logreg（同一批特征上的线性模型）差距小于噪声："
                   "**信号是真的，但它是线性的**。该交付的是线性模型或规则，而不是 MLP —— "
                   "同样效果下参数少一个量级、可解释、可手改。")
    else:
        outcome = "continue"
        reading = ("该轴上 MLP 同时明显赢过最强查表器与 logreg：**确有可迁移的非线性信号**，"
                   "进入下一轮（接契约 + 端到端效用 A/B）。")

    return {
        "axis": axis,
        "outcome": outcome,
        "reading": reading,
        "numbers": {
            "mlp": mlp,
            "logreg": logreg,
            "majorityGlobal": majority,
            "lookupFacetPair": facet_table,
            "lookupFamilyPair": family_table,
            "bestTable": {"name": best_table_name, "mean": best_table},
            "gapVsBestTable": round(float(gap_table), 4),
            "gapVsLogreg": round(float(gap_logreg), 4),
            "gapVsMajority": round(float(gap_majority), 4),
            "sigmaUsed": round(float(sigma), 4),
            "threshold2Sigma": round(float(threshold), 4),
        },
        "flags": {
            "beatsBestTableBeyondNoise": bool(beats_table),
            "beatsLogregBeyondNoise": bool(beats_logreg),
            "nearMajority": bool(near_majority),
        },
    }


def build_verdict(report: dict, args) -> dict:
    """把**事先写死的三条判据**算出来，两条轴各算一遍。

    判据在跑之前就写死，是因为这类诊断最常见的失败方式不是算错，而是**看到数之后**
    挑一个能支持自己期望的口径。所以口径钉在「`facet` 折 × `no_identity` 变体」上，
    并且把三条判据的原文一起写进结论，谁改口径就得改这段文字。

    但**主判据只钉在 similarity 轴**，而 dependency 轴也照样算 —— 实测这两条轴的结论
    可能相反（similarity 线性可解、dependency 需要非线性），只报被钉死的那一条会是选择性汇报。
    """
    subject = next(
        item for item in report["cells"] if item["scheme"] == "facet" and item["variant"] == "no_identity"
    )
    axes = {axis: axis_verdict(subject, axis) for axis in AXES}
    primary = axes["similarity"]
    return {
        "criteria": PRE_REGISTERED_CRITERIA,
        "subject": VERDICT_SUBJECT,
        "primaryAxis": "similarity",
        "primaryReason": "契约里 similarity 承担「执行不佳时换谁、以最小能力改动归因」，是方案二的核心用法。",
        "byAxis": axes,
        "outcome": primary["outcome"],
        "reading": primary["reading"],
        "crossAxisNote": (
            "两条轴的结论不一致时，不要取平均或只报一条。"
            "dependency 与 similarity 是两个独立契约字段，各自按自己的结论落地。"
        ),
        "agreement": axes["dependency"]["outcome"] == axes["similarity"]["outcome"],
    }


def run_fit_all(args, data: dict, spec: dict, matrix_dir: Path) -> None:
    """训一份**交付权重**：用全部行，并在产物里写清它的泛化估计来自哪里。

    为什么交付权重要用全部数据，而不是沿用 `train+development`：
    折与 `test` 的存在意义是**估计泛化**，不是"给交付模型留几行不看"。留出的那一份
    如果永远不参与训练，交付出去的模型就少用了那部分数据 —— 在一个只有 8k 行的任务上
    这不是可忽略的差别。所以超参一确定，就该用全量重训一次。

    但这样一来，**这份产物自己的指标不再能当泛化用**：在它自己见过的行上算准确率，
    只会得到一个好看而没有信息量的数。所以：
      - 这里只报**拟合**指标（train fit），并明确标注它是什么；
      - 泛化估计由诊断轮的折指标给出（`diagnosis.json`），两者在 manifest 里绑在一起。
    把这两件事混在一份 metrics.json 里报，就是第一版报告最严重的问题的翻版 ——
    把一个"复述得好不好"的数读成"学到没学到"。
    """
    started = time.time()
    all_idx = np.arange(spec["rows"], dtype=np.int64)
    config = {
        "name": "ship",
        "hidden": [256, 128],
        "dropout": 0.1,
        "lr": 2e-3,
        "weight_decay": 1e-4,
        "epochs": max(200, args.epochs),
        "patience": 400,
    }
    # 用同一批数据做早期停止的监视集是不干净的（会偏乐观）。交付权重不需要监视集：
    # 轮数是超参，已经在诊断/扫参阶段定过，这里就按固定轮数训满。
    run = train_one(config, data, all_idx, all_idx, seed=args.seed)
    train_logits = predict(run["model"], run["scaler"], data["x"][all_idx])
    metrics = {
        "schema": "cpdb_scorer_metrics/v1",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kind": "ship_fit_all",
        "warning": "本文件的指标是**拟合**指标（模型见过每一行），不能当泛化用。"
                   "泛化估计见同目录 manifest.json 指向的诊断报告。",
        "environment": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "numpy": np.__version__,
            "device": "cuda" if torch.cuda.is_available() else "cpu",
            "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
            "seed": args.seed,
        },
        "matrix": {
            "dir": str(matrix_dir),
            "featureSpec": spec["featureSpec"],
            "variant": spec.get("variant", "full"),
            "columns": len(spec.get("columns") or []),
            "rows": spec["rows"],
            "dimension": spec["dimension"],
            "labelSource": spec["labelSource"],
            "splits": spec["splits"],
            "kinds": spec["kinds"],
            "labelHistogram": spec["labelHistogram"],
            "inputs": spec["inputs"],
            "outputs": spec["outputs"],
        },
        "config": config,
        "trainedOn": "all rows",
        "fitMetrics": {axis: axis_metrics(train_logits[axis], data["y"][axis][all_idx]) for axis in AXES},
        "wallSeconds": 0,
    }
    spec = {
        **spec,
        "provenance": {
            "matrixDir": str(matrix_dir).replace("\\", "/"),
            "labelSource": spec["labelSource"],
            "inputs": spec["inputs"],
            "outputs": spec["outputs"],
            "trainedOn": "all rows",
            "variant": spec.get("variant", "full"),
        },
    }
    predictions = []
    step = np.array(SCALE)
    for position, index in enumerate(all_idx):
        row = data["rows"][int(index)]
        entry = {"id": row["id"], "split": row["split"], "kind": row["kind"]}
        for axis in AXES:
            probabilities = softmax(train_logits[axis][position][None, :])[0]
            entry[axis] = {
                "label": SCALE[int(data["y"][axis][index])],
                "expected": round(float(probabilities @ step), 6),
                "argmax": SCALE[int(probabilities.argmax())],
                "probabilities": [round(float(p), 6) for p in probabilities],
            }
        predictions.append(entry)
    metrics["wallSeconds"] = round(time.time() - started, 1)
    save_artifact(Path(args.out), run["model"], run["scaler"], spec, metrics, predictions)
    print(json.dumps({
        "out": args.out,
        "kind": "ship_fit_all",
        "variant": spec.get("variant", "full"),
        "columns": len(spec.get("columns") or []),
        "fit": metrics["fitMetrics"],
        "gpu": metrics["environment"]["gpu"],
        "wallSeconds": metrics["wallSeconds"],
    }, ensure_ascii=False, indent=2))
    digest = hashlib.sha256((Path(args.out) / "weights.json").read_bytes()).hexdigest()
    print(f"[artifact] weights.json sha256={digest}")


def run_fit_table(args, data: dict, spec: dict, matrix_dir: Path) -> None:
    """训一份**交付用的表**：按 `(familyL, familyR)` 把标签压成分布，写 `table.json`。

    为什么交付的是表而不是 MLP：诊断轮把它放在同一批折、同一批标签上比过了 ——
    `facet` 折（换一个没见过的角色）上，36 格 family 表拿到相似度 0.7816，
    而 92 维 MLP 是 0.7669 / 32 维 MLP 是 0.7477（AI 标签）。**表赢，而且在更少的信息上赢。**
    再联系 `family` 折（换一个粗粒度职能）：MLP 的相似度 0.5544 反而**低于**全局众数 0.5899。

    这个结果的含义不是"模型调得不好"，而是：**这批标签本身几乎就是 `(familyL, familyR)` 的函数**。
    规则 teacher 与 AI 判分都主要对两侧的粗粒度职能起反应，那么再多参数也变不出标签里没有的分辨率。

    表相比模型的三个实际好处，都是在"标签分辨率就到这里"的前提下才成立的：
      - 体积：36 格 × 2 轴 的概率分布，几 KB，进安装包没有负担；
      - 可解释/可手改：某一格看着不对，直接改那个数，不必重训；
      - **指标是可折估计的**：表不需要训练，所以可以逐折留出、如实报泛化；
        而全量重训的 MLP 只能报拟合值（这点差别很重要，见 `run_fit_all` 的注释）。

    表仍然**不是**规则：格里的值是**从标签学来的**（这里就是 AI 判分），
    所以它不会带上 teacher 那条"同族一律压到 0"的悬崖。这正是方案二想要的那一点改进。

    未知格子的回落策略也一并落盘：默认回落到**全局分布**（不是回落到某个众数档），
    这样连续分的期望值是稳的 —— 回落到一个档位会让"未知"与"确定"看起来一样自信。
    """
    started = time.time()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # 键用 `familyL>familyR`。**有向**：依赖分是"左喂右"，方向必须保留。
    # 相似度是对称的，但有向键在一份文件里同时服务两轴，比按轴存两种键更不容易出错
    # （代价是相似度那一轴把 A>B 与 B>A 当成两个格子，样本各少一半；下面的 folds 估计
    #  会把这件事的代价如实量出来）。
    # 逐行取 family 对键。**有向**：依赖分是"左喂右"，方向必须保留。
    # 相似度其实是对称的，但一份文件同时服务两轴时，有向键比按轴存两种键更不容易出错
    # （代价是相似度那轴把 A>B 与 B>A 当两个格子、每格样本减半；下面的逐折估计会把这个代价量出来）。
    fold_rows = read_jsonl(matrix_dir / "folds.jsonl")
    if len(fold_rows) != spec["rows"]:
        raise SystemExit(f"folds.jsonl 行数 {len(fold_rows)} 与矩阵 {spec['rows']} 不一致")
    keys = []
    for row in fold_rows:
        key = row.get("lookupKeys", {}).get("family")
        if not key:
            raise SystemExit(f"folds.jsonl 缺少 lookupKeys.family: {row.get('id')}")
        keys.append(key)
    labels = {axis: data["y"][axis] for axis in AXES}
    total_rows = len(keys)

    def dist(axis: str, indices) -> np.ndarray:
        """一组行上的类别分布，归一化成概率。

        空组返回**均匀分布**而不是零向量：零向量会让期望值算成 0，看起来像一个很自信的
        "两轴都为 0"的判断，而不是"这里没有信息"。
        """
        counts = np.zeros(len(SCALE), dtype=np.float64)
        for at in indices:
            counts[int(labels[axis][at])] += 1
        total = counts.sum()
        return (counts / total) if total else np.full(len(SCALE), 1.0 / len(SCALE))

    by_key = {}
    for at, key in enumerate(keys):
        by_key.setdefault(key, []).append(at)
    table_cells = {
        key: {axis: [round(float(p), 6) for p in dist(axis, indices)] for axis in AXES}
        for key, indices in by_key.items()
    }
    prior = {axis: [round(float(p), 6) for p in dist(axis, range(total_rows))] for axis in AXES}

    # 逐折评估：表不需要训练，所以这里报的是**真正的折上泛化**，不是拟合值。
    fold_report = {}
    for scheme in spec["folds"]:
        k = spec["folds"][scheme]["k"]
        per_fold = {axis: [] for axis in AXES}
        for fold in range(k):
            evaluation = [at for at, row in enumerate(fold_rows) if fold in (row.get(scheme) or [])]
            if not evaluation:
                continue
            evaluation_set = set(evaluation)
            training = [at for at in range(total_rows) if at not in evaluation_set]
            if not training:
                continue
            by_key_train = {}
            for at in training:
                by_key_train.setdefault(keys[at], []).append(at)
            for axis in AXES:
                train_cells = {key: dist(axis, indices) for key, indices in by_key_train.items()}
                train_prior = dist(axis, training)
                hit = 0
                for at in evaluation:
                    # 没见过的家族对回落到 prior：这是**服务期也会发生**的情况
                    # （新职能、跨职能的人），所以必须算进指标里，而不是跳过。
                    probs = train_cells.get(keys[at], train_prior)
                    if int(probs.argmax()) == int(labels[axis][at]):
                        hit += 1
                per_fold[axis].append(round(hit / len(evaluation), 4))
        fold_report[scheme] = {
            axis: {
                "mean": round(float(np.mean(per_fold[axis])), 4) if per_fold[axis] else None,
                "stdAcrossFolds": round(float(np.std(per_fold[axis])), 4) if per_fold[axis] else None,
                "perFold": per_fold[axis],
            }
            for axis in AXES
        }

    table = {
        "schema": "cpdb_scorer_table/v1",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "keyKind": "family_pair",
        "keyFormat": "familyL>familyR（有向）",
        "featureSpec": spec["featureSpec"],
        "scale": SCALE,
        "cells": table_cells,
        "prior": prior,
        "unseenFallback": "prior",
        "foldMetrics": fold_report,
        "labelSource": spec["labelSource"],
        "provenance": {
            "matrixDir": str(matrix_dir).replace("\\", "/"),
            "inputs": spec["inputs"],
            "outputs": spec["outputs"],
            "rows": spec["rows"],
        },
        "note": "格里的值是从标签学来的类别分布，不是手写规则。未知 family 对回落到 prior（全局分布），"
                "因为回落到一个众数档会让「未知」与「确定」看起来一样自信。",
    }
    (out_dir / "table.json").write_text(json.dumps(table, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    metrics = {
        "schema": "cpdb_scorer_metrics/v1",
        "kind": "ship_table",
        "generatedAt": table["generatedAt"],
        "environment": {"python": platform.python_version(), "numpy": np.__version__, "seed": args.seed},
        "matrix": {
            "dir": str(matrix_dir),
            "rows": spec["rows"],
            "labelSource": spec["labelSource"],
            "inputs": spec["inputs"],
            "outputs": spec["outputs"],
        },
        "cellCount": len(table_cells),
        "foldMetrics": fold_report,
        "warning": "这份产物的指标是**折上泛化**（表不需要训练，所以可以逐折留出），"
                   "与 MLP 的拟合指标不是同一个口径，不要直接比数字。",
        "wallSeconds": round(time.time() - started, 1),
    }
    (out_dir / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({
        "out": args.out,
        "kind": "ship_table",
        "cellCount": len(table_cells),
        "foldMetrics": fold_report,
        "wallSeconds": metrics["wallSeconds"],
    }, ensure_ascii=False, indent=2))
    digest = hashlib.sha256((out_dir / "table.json").read_bytes()).hexdigest()
    print(f"[artifact] table.json sha256={digest}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--matrix-dir", default="train_out")
    parser.add_argument("--out", default="artifacts/cpdb-scorer-v1")
    parser.add_argument("--seed", type=int, default=20260920)
    parser.add_argument("--ablate", action="store_true", help="额外跑一轮 feature-block 消融")
    parser.add_argument("--diagnose", action="store_true",
                        help="跑诊断轮：4 种留出方案 × 2 种特征变体 × 5 个同台竞争者（见文件头「诊断」一节）")
    parser.add_argument("--seeds", default="20260920,1,2,3,4",
                        help="诊断轮的种子列表；判据里的 2σ 就来自这几个种子")
    parser.add_argument("--diagnose-out", default="artifacts/cpdb-scorer-diagnosis/diagnosis.json")
    parser.add_argument("--diagnose-epochs", type=int, default=200)
    parser.add_argument("--diagnose-patience", type=int, default=25)
    # 允许只跑一部分格子。用途有两个：本地冒烟（只跑 facet 一列）、
    # 以及把不同方案分到不同进程/GPU 上并行（三台 A800 就是这个用法）。
    parser.add_argument("--diagnose-schemes", default="",
                        help="逗号分隔，留空表示 matrix.json 里的全部方案")
    parser.add_argument("--diagnose-variants", default="",
                        help="逗号分隔，留空表示 matrix.json 里的全部变体")
    # 交付用：`--variant` 选特征组（`full` / `no_identity` / `content_only`），
    # `--fit-all` 用全部数据训一份交付权重（折只用于评估，不参与交付训练）。
    parser.add_argument("--variant", default="full", help="特征变体名，见 matrix.json 的 variants")
    parser.add_argument("--epochs", type=int, default=300,
                        help="仅用于 --fit-all（交付权重按固定轮数训满，不用监视集）")
    parser.add_argument("--fit-all", action="store_true",
                        help="在全部行上训一份交付权重；泛化估计取自诊断轮的报告，不取自这里的指标")
    parser.add_argument("--fit-table", action="store_true",
                        help="交付表：按 (familyL,familyR) 把标签压成分布写 table.json（诊断判定 MLP 不被证实时的交付物）")
    parser.add_argument("--allow-leaky-splits", action="store_true",
                        help="跳过 train/development/test 非空检查（旧矩阵里三者都可能为空时用）")
    args = parser.parse_args()

    if args.diagnose:
        args.epochs = args.diagnose_epochs
        args.patience = args.diagnose_patience
        args.out = args.diagnose_out
        run_diagnose(args)
        return

    matrix_dir = Path(args.matrix_dir)
    data = load_matrix(matrix_dir)
    spec = data["spec"]
    if args.variant != "full" or (spec.get("variants") or {}).get(args.variant):
        variant_spec = (spec.get("variants") or {}).get(args.variant)
        if not variant_spec:
            raise SystemExit(f"matrix.json 里没有特征变体 {args.variant}；可选：{list((spec.get('variants') or {}).keys())}")
        columns = [int(item) for item in variant_spec["columns"]]
        data = {**data, "x": data["x"][:, columns]}
        spec = {**spec, "variant": args.variant, "columns": columns}
        print(f"[variant] {args.variant}: {len(columns)} 列（全量 {spec['dimension']}）", flush=True)
    if args.fit_table:
        run_fit_table(args, data, spec, matrix_dir)
        return

    train_idx = split_indices(data["rows"], "train")
    dev_idx = split_indices(data["rows"], "development")
    test_idx = split_indices(data["rows"], "test")
    if not args.allow_leaky_splits and (not train_idx.size or not dev_idx.size or not test_idx.size):
        raise SystemExit(f"三个 split 必须都非空: {train_idx.size}/{dev_idx.size}/{test_idx.size}")

    if args.fit_all:
        run_fit_all(args, data, spec, matrix_dir)
        return

    started = time.time()
    # 候选跨了三档容量（线性 → 小 MLP → 大 MLP）。如果容量对结果几乎没影响，
    # 说明这个任务由特征的可分性决定而不是参数量决定 —— 那本身是个结论。
    candidates = [
        {"name": "linear", "hidden": [], "dropout": 0.0, "lr": 3e-3, "weight_decay": 0.0},
        {"name": "mlp-s", "hidden": [128, 64], "dropout": 0.1, "lr": 3e-3, "weight_decay": 0.0},
        {"name": "mlp-m", "hidden": [256, 128], "dropout": 0.1, "lr": 2e-3, "weight_decay": 1e-4},
        {"name": "mlp-l", "hidden": [512, 256], "dropout": 0.2, "lr": 1.5e-3, "weight_decay": 1e-4},
        {"name": "mlp-xl", "hidden": [1024, 512], "dropout": 0.3, "lr": 1e-3, "weight_decay": 1e-4},
        {"name": "mlp-m-fast", "hidden": [256, 128], "dropout": 0.3, "lr": 3e-3, "weight_decay": 0.0},
        {"name": "mlp-m-smooth", "hidden": [256, 128], "dropout": 0.1, "lr": 2e-3, "weight_decay": 1e-4, "label_smoothing": 0.05},
    ]

    results = []
    for config in candidates:
        run = train_one(config, data, train_idx, dev_idx, seed=args.seed)
        results.append((config, run))
        dev_mae = {axis: run["dev_metrics"][axis]["mae_expected"] for axis in AXES}
        print(
            f"[sweep] {config['name']:<14} dev_loss={run['dev_loss']:.4f} epoch={run['best_epoch']:<4} "
            f"mae={dev_mae['dependency']:.4f}/{dev_mae['similarity']:.4f}",
            flush=True,
        )

    # 选型判据用 dev_loss（两轴 CE 之和）而不是 MAE：两轴都是顺序量，
    # CE 对「自信地判错」罚得更重，作为选型判据更稳。
    best_config, best_run = min(results, key=lambda item: item[1]["dev_loss"])
    print(f"[sweep] 选中 {best_config['name']}", flush=True)

    # 交付权重用 train+development 重训：超参已在 dev 上定下来，
    # 把 dev 也喂进去是标准做法（dev 从「选择集」变成「被选择后的训练集」）。
    refit_idx = np.concatenate([train_idx, dev_idx])
    refit = train_one(
        {**best_config, "patience": 400, "epochs": max(200, best_run["epochs_run"] * 3)},
        data, refit_idx, dev_idx, seed=args.seed,
    )
    print(f"[refit] dev_loss={refit['dev_loss']:.4f} epoch={refit['best_epoch']}", flush=True)

    shipped = refit
    test_logits = predict(shipped["model"], shipped["scaler"], data["x"][test_idx])
    dev_logits = predict(shipped["model"], shipped["scaler"], data["x"][dev_idx])
    train_logits = predict(shipped["model"], shipped["scaler"], data["x"][train_idx])

    metrics = {
        "schema": "cpdb_scorer_metrics/v1",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "environment": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "numpy": np.__version__,
            "device": "cuda" if torch.cuda.is_available() else "cpu",
            "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
            "seed": args.seed,
        },
        "matrix": {
            "featureSpec": spec["featureSpec"],
            "rows": spec["rows"],
            "dimension": spec["dimension"],
            "labelSource": spec["labelSource"],
            "splits": spec["splits"],
            "kinds": spec["kinds"],
            "labelHistogram": spec["labelHistogram"],
            "inputs": spec["inputs"],
            "outputs": spec["outputs"],
        },
        "selectedConfig": best_config,
        "sweep": [
            {
                "config": config,
                "devLoss": run["dev_loss"],
                "bestEpoch": run["best_epoch"],
                "epochsRun": run["epochs_run"],
                "devMetrics": run["dev_metrics"],
            }
            for config, run in results
        ],
        "shipped": {
            "trainedOn": "train+development",
            "protocol": "超参在 development 上选（候选只喂 train），选出后用 train+development 重训。",
            "trainMetrics": {axis: axis_metrics(train_logits[axis], data["y"][axis][train_idx]) for axis in AXES},
            "devMetrics": {axis: axis_metrics(dev_logits[axis], data["y"][axis][dev_idx]) for axis in AXES},
            "testMetrics": {axis: axis_metrics(test_logits[axis], data["y"][axis][test_idx]) for axis in AXES},
        },
        "baselinesOnTest": {
            "majority": {axis: majority_baseline_metrics(data["y"][axis][train_idx], data["y"][axis][test_idx]) for axis in AXES},
            "contractHandWritten": {axis: contract_baseline_metrics(data, test_idx, axis) for axis in AXES},
        },
        "testByKind": {},
        "ablation": {},
        "wallSeconds": 0,
    }

    # 分类型看 test：四类采样的分数分布差别很大，只看总体会掩盖某一类上的失效。
    position_of = {int(index): position for position, index in enumerate(test_idx)}
    for kind in sorted({data["rows"][int(i)]["kind"] for i in test_idx}):
        subset = np.array([int(i) for i in test_idx if data["rows"][int(i)]["kind"] == kind], dtype=np.int64)
        positions = [position_of[int(i)] for i in subset]
        metrics["testByKind"][kind] = {
            "n": int(subset.size),
            "model": {axis: axis_metrics(test_logits[axis][positions], data["y"][axis][subset]) for axis in AXES},
            "contract": {axis: contract_baseline_metrics(data, subset, axis) for axis in AXES},
        }

    if args.ablate:
        groups = feature_groups(spec["featureNames"])
        all_columns = set(range(spec["dimension"]))
        for name, cols in groups.items():
            # 两个方向都要跑。只跑「置零该块」是不够的：特征块之间**有冗余**
            # （produces/consumes 既在 flow 里，也在 set_similarity 的 jaccard 里），
            # 于是置零任意单块都能被另一块顶上，六个块全是 delta≈0 —— 那个结果
            # 长得像「每块都不重要」，其实是「任意一块都被重复表达了两遍」。
            # 「只留该块」才回答得了「这一块够不够」。
            zeroed = train_one({**best_config, "patience": 60}, {**data, "x": zero_groups(data["x"], cols)}, train_idx, dev_idx, seed=args.seed)
            keep = np.array(sorted(all_columns - set(cols.tolist())), dtype=np.int64)
            kept = train_one({**best_config, "patience": 60}, {**data, "x": zero_groups(data["x"], keep)}, train_idx, dev_idx, seed=args.seed)
            metrics["ablation"][name] = {
                "columns": int(cols.size),
                "zeroedOut": {
                    "devLoss": zeroed["dev_loss"],
                    "devMetrics": zeroed["dev_metrics"],
                    "deltaDevLossVsFull": round(zeroed["dev_loss"] - best_run["dev_loss"], 6),
                },
                "keptOnly": {
                    "devLoss": kept["dev_loss"],
                    "devMetrics": kept["dev_metrics"],
                    "deltaDevLossVsFull": round(kept["dev_loss"] - best_run["dev_loss"], 6),
                },
            }
            print(
                f"[ablate] {name:<16}({cols.size:>3} 列) 置零={zeroed['dev_loss']:.4f} "
                f"只留={kept['dev_loss']:.4f}",
                flush=True,
            )

    predictions = []
    step = np.array(SCALE)
    for position, index in enumerate(test_idx):
        row = data["rows"][int(index)]
        entry = {"id": row["id"], "split": row["split"], "kind": row["kind"]}
        for axis in AXES:
            probabilities = softmax(test_logits[axis][position][None, :])[0]
            entry[axis] = {
                "label": SCALE[int(data["y"][axis][index])],
                "expected": round(float(probabilities @ step), 6),
                "argmax": SCALE[int(probabilities.argmax())],
                "probabilities": [round(float(p), 6) for p in probabilities],
            }
        predictions.append(entry)

    metrics["wallSeconds"] = round(time.time() - started, 1)
    save_artifact(Path(args.out), shipped["model"], shipped["scaler"], spec, metrics, predictions)

    print(json.dumps({
        "out": args.out,
        "selected": best_config["name"],
        "test": metrics["shipped"]["testMetrics"],
        "contractOnTest": metrics["baselinesOnTest"]["contractHandWritten"],
        "majorityOnTest": metrics["baselinesOnTest"]["majority"],
        "gpu": metrics["environment"]["gpu"],
        "wallSeconds": metrics["wallSeconds"],
    }, ensure_ascii=False, indent=2))
    digest = hashlib.sha256((Path(args.out) / "weights.json").read_bytes()).hexdigest()
    print(f"[artifact] weights.json sha256={digest}")


if __name__ == "__main__":
    main()
