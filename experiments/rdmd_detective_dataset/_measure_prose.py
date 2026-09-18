"""Measure emptiness of the prose fields across the corpus, to set a guard that cannot misfire.

A guard is worse than no guard if it rejects legal inputs, so the threshold has to come from the
data. Two questions:
  1. Is any of the 5 prose fields EVER empty in a legal sample?
  2. What does a uBuddy-shaped graph look like by the same measure?
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIELDS = ["artifact", "stage", "inputs", "output", "summary"]


def rows(path: Path):
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            yield json.loads(line)


def graph_nodes(row: dict) -> list[dict]:
    prompt = row["prompt"]
    return json.loads(prompt.split("INPUT=")[1])["G_star"]["nodes"]


for name, path in [
    ("train", HERE / "sft" / "train.jsonl"),
    ("test", HERE / "sft" / "test.jsonl"),
    ("ood", HERE / "sft" / "ood.jsonl"),
    ("adversarial", HERE / "sft" / "adversarial.jsonl"),
]:
    if not path.is_file():
        print(f"{name}: (missing)")
        continue
    empty = Counter()
    total = Counter()
    per_graph_all_empty = Counter()
    graphs = 0
    for row in rows(path):
        graphs += 1
        nodes = graph_nodes(row)
        all_empty = {f: True for f in FIELDS}
        for node in nodes:
            for field in FIELDS:
                total[field] += 1
                if not str(node.get(field) or "").strip():
                    empty[field] += 1
                else:
                    all_empty[field] = False
        for field in FIELDS:
            if all_empty[field]:
                per_graph_all_empty[field] += 1
    print(f"\n=== {name}: {graphs} graphs ===")
    for field in FIELDS:
        rate = empty[field] / total[field] if total[field] else 0
        print(f"  {field:<9} empty nodes {empty[field]:>7}/{total[field]:<7} ({rate:.4f}) | "
              f"graphs where ALL nodes empty: {per_graph_all_empty[field]}")

print("\n=== a uBuddy-shaped graph under the same measure ===")
ubuddy = {f: "absent" for f in FIELDS}
print("  node keys:", sorted(["id", "title", "agentId", "version", "acceptance", "role", "status"]))
print("  => all 5 prose fields are absent, hence empty on every node of every graph.")
