"""How many times does the trainer see each graph, and can memorisation explain a low loss?

A very low training loss is only alarming if the same graph recurs many times -- then the model can
learn a per-graph answer table instead of a causal rule. This quantifies the repetition so the
question is settled with numbers rather than vibes, and checks that held-out splits share no graph
with train (so any dev/test score is genuinely on unseen graphs).
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

SFT = Path(__file__).resolve().parent / "sft"


def load(name: str) -> list[dict]:
    path = SFT / f"{name}.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    splits = {name: load(name) for name in ("train", "development", "test", "eval_unknown", "eval_no_drift")}
    train = splits["train"]
    epochs = 2

    train_graphs = Counter(row["graph_id"] for row in train)
    print("== graph multiplicity in train ==")
    print(f"rows                 {len(train)}")
    print(f"distinct graphs      {len(train_graphs)}")
    counts = sorted(train_graphs.values())
    print(f"rows per graph       min {counts[0]}  median {counts[len(counts)//2]}  max {counts[-1]}")
    print(f"mean rows per graph  {len(train)/len(train_graphs):.1f}")
    print(f"exposures per graph over {epochs} epochs: median {counts[len(counts)//2]*epochs}")
    for threshold in (4, 8, 16, 32):
        graphs = sum(1 for value in counts if value * epochs >= threshold)
        rows = sum(value for value in counts if value * epochs >= threshold) * epochs
        print(f"  graphs seen >= {threshold:2d}x: {graphs:5d}  covering {rows:6d} row-epochs")

    print()
    print("== graph-level overlap (must be 0 for held-out splits) ==")
    train_ids = set(train_graphs)
    for name, rows in splits.items():
        if name == "train" or not rows:
            continue
        ids = {row["graph_id"] for row in rows}
        print(f"{name:14s} rows {len(rows):5d}  distinct graphs {len(ids):5d}  overlap_with_train {len(ids & train_ids)}")

    print()
    print("== answer diversity per graph (can a fixed answer per graph work?) ==")
    by_graph: dict[str, set[tuple[str, str]]] = {}
    for row in train:
        gold = json.loads(row["completion"])
        by_graph.setdefault(row["graph_id"], set()).add((gold["status"], gold["nodeId"]))
    answers = Counter(len(values) for values in by_graph.values())
    print("distinct (status,nodeId) answers per graph:", dict(sorted(answers.items())))
    single = sum(1 for values in by_graph.values() if len(values) == 1)
    print(f"graphs with exactly one answer: {single}/{len(by_graph)} = {single/len(by_graph):.3f}")
    print("-> a per-graph lookup table is only possible for the single-answer graphs above")
    print(f"-> ceiling of a pure per-graph memoriser on train: {single/len(by_graph):.3f}")

    print()
    print("== status balance in train ==")
    status = Counter(row["status"] for row in train)
    total = sum(status.values())
    for key, value in status.most_common():
        print(f"  {key:9s} {value:5d}  {value/total:.4f}")


if __name__ == "__main__":
    main()
