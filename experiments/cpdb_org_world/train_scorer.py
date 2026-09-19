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
  - `test` 落在**没见过的 org** 上（数据集的 `splitBy: orgId`），所以这是泛化指标，
    不是同分布插值。
  - 契约里那两个手写打分器在**同一批 test 行**上算作对比基线，一并记录。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import time
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
    hidden = [layer.out_features for layer in model.trunk if isinstance(layer, nn.Linear)]
    # 把「哪些 key 是 Linear、按什么顺序、形状多大」显式写进产物。
    # 不写的话，推理侧只能靠 `trunk.0 / trunk.3 / trunk.6…` 这种下标规律去猜，
    # 而一旦 `Scorer` 里多插一个非参数层（比如换激活），那份猜测就会**静默**错位：
    # 权重照样加载、照样出分，只是分数悄悄不对。宁可把结构说清楚。
    layers = []
    width = spec["dimension"]
    for position, size in enumerate(hidden):
        layers.append({"index": position, "in": width, "out": size, "weightKey": f"trunk.{position * 3}.weight", "biasKey": f"trunk.{position * 3}.bias"})
        width = size
    heads = {
        axis: {"in": width, "out": len(SCALE), "weightKey": f"{axis}.weight", "biasKey": f"{axis}.bias"}
        for axis in AXES
    }
    weights = {
        "schema": "cpdb_scorer_weights/v1",
        "featureSpec": spec["featureSpec"],
        "dimension": spec["dimension"],
        "featureNames": spec["featureNames"],
        "vocab": spec["vocab"],
        "scale": SCALE,
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--matrix-dir", default="train_out")
    parser.add_argument("--out", default="artifacts/cpdb-scorer-v1")
    parser.add_argument("--seed", type=int, default=20260920)
    parser.add_argument("--ablate", action="store_true", help="额外跑一轮 feature-block 消融")
    args = parser.parse_args()

    matrix_dir = Path(args.matrix_dir)
    data = load_matrix(matrix_dir)
    spec = data["spec"]
    train_idx = split_indices(data["rows"], "train")
    dev_idx = split_indices(data["rows"], "development")
    test_idx = split_indices(data["rows"], "test")
    if not train_idx.size or not dev_idx.size or not test_idx.size:
        raise SystemExit(f"三个 split 必须都非空: {train_idx.size}/{dev_idx.size}/{test_idx.size}")

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
