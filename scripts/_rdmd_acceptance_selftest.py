"""用「拿答案当预测」的 oracle 走一遍验收门，验证新增的三项在配对数据上真的算得出来。

为什么需要这个：`collect()` 的三项逐行指标（derived-only / step-layer / status-shortcut）
分子分母都来自 `sft/<split>.jsonl` 与 `merged.predictions.jsonl` 的交集。它们是否被正确接线，
在**没有 GPU** 的情况下也能验 —— 把 gold 当预测喂进去，期望值是可推导的：

    coverage      = 100%
    step_layer    = 1.0000（若 test 里有 step 真凶行）
    derived_only  = 1.0000
    status gap    = 1.0000 − 捷径 top1

顺便回答一个 P3 前必须知道的数量问题：**test split 里有多少行真凶落在 step 层**。
如果这个数很小（个位数），第 7 项就是在很小的样本上做的判断，必须如实标注。

这是本机开发工具（下划线前缀，不进产品路径）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import rdmd_acceptance as acc  # noqa: E402


def main() -> None:
    sft_dir = acc.DEFAULT_SFT
    data_dir = acc.DEFAULT_DATA
    rows = acc.read_jsonl(sft_dir / "test.jsonl")
    print(f"test.jsonl rows: {len(rows)}")

    kinds = acc.gold_kind_map(data_dir)

    # 每层真凶各有多少 —— 决定三项指标的分母够不够大。`(none)` 是 no_drift / UNKNOWN 行。
    by_kind: dict[str, int] = {}
    for row in rows:
        kind = kinds.get(row["id"], "(no drift gold)")
        by_kind[kind] = by_kind.get(kind, 0) + 1
    for kind, count in sorted(by_kind.items(), key=lambda kv: -kv[1]):
        print(f"  gold kind {kind:16s} {count:5d}")

    oracle_dir = ROOT / "experiments" / "rdmd_runs" / "_oracle-selftest"
    oracle_dir.mkdir(parents=True, exist_ok=True)
    merged = oracle_dir / "merged.predictions.jsonl"
    with merged.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps({
                "id": row["id"],
                "prediction": row["completion"],
            }, ensure_ascii=False) + "\n")
    print(f"\noracle predictions written: {len(rows)} -> {merged}")

    criteria, notes, _ = acc.collect(oracle_dir, sft_dir, "test", data_dir)
    print(f"\n{'criterion':32s} {'n':>6s} {'value':>9s}")
    print("-" * 52)
    for criterion in criteria:
        value = "n/a" if criterion.value is None else f"{criterion.value:.4f}"
        print(f"{criterion.label:32s} {criterion.n:6d} {value:>9s}")
    for note in notes:
        print("note:", note)

    lookup = {criterion.key: criterion for criterion in criteria}
    failures = []
    for key, expected in (("step_layer_node", 1.0), ("primary_derived_only", 1.0)):
        got = lookup[key].value
        if got is None or abs(got - expected) > 1e-9:
            failures.append(f"{key}={got} (expected {expected})")
    # 捷径的差距在 oracle 下必然 = 1 − top1，且必须严格大于 0（否则说明捷径就是答案）。
    shortcut = lookup["status_shortcut"]
    if shortcut.value is None or shortcut.value <= 0:
        failures.append(f"status_shortcut gap={shortcut.value} (expected > 0)")

    print()
    if failures:
        print("SELFTEST FAILED:")
        for item in failures:
            print("  -", item)
        raise SystemExit(1)
    print("SELFTEST OK: oracle passes step-layer / derived-only, and beats the status shortcut")


if __name__ == "__main__":
    main()
