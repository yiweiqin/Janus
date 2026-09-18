"""Cross-split topology overlap: the generalisation guarantee that actually matters.

graph_id overlap being zero is weak -- ids are assigned per graph, so it is almost tautological.
Since every graph turns out to have a unique topology, the meaningful question is whether any
held-out graph repeats a *train* topology (which would let a shape lookup table transfer) or merely
reuses the same wiring statistics. This measures both.
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path

from topology_census_exact import shape_of

DATA = Path(__file__).resolve().parent / "data"


def load(name: str) -> list[dict]:
    path = DATA / f"{name}.jsonl"
    if not path.is_file():
        return []
    rows = []
    with path.open(encoding="utf-8-sig") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def degrees(graph: dict) -> tuple:
    indeg: Counter = Counter()
    outdeg: Counter = Counter()
    for edge in graph.get("edges") or []:
        outdeg[edge["from"]] += 1
        indeg[edge["to"]] += 1
    ids = [node["id"] for node in graph["nodes"]]
    return (len(ids), tuple(sorted(outdeg.get(i, 0) for i in ids)), tuple(sorted(indeg.get(i, 0) for i in ids)))


def main() -> None:
    splits = {name: load(name) for name in ("train", "development", "test")}

    topo: dict[str, dict[str, str]] = {}
    degs: dict[str, dict[str, tuple]] = {}
    scenarios: dict[str, set[str]] = {}
    for name, rows in splits.items():
        topo[name] = {}
        degs[name] = {}
        clusters: dict[str, set[str]] = defaultdict(set)
        for row in rows:
            graph_id = row["graph_id"]
            if graph_id in topo[name]:
                continue
            topo[name][graph_id] = shape_of(row["G_star"])
            degs[name][graph_id] = degrees(row["G_star"])
            star = row["G_star"]
            clusters[graph_id].add(f"{star.get('domain')}|{star.get('topic')}")
        scenarios[name] = {v for values in clusters.values() for v in values}
        print(f"{name:12s} rows {len(rows):6d}  graphs {len(topo[name]):5d}  distinct topologies {len(set(topo[name].values())):5d}")

    print()
    print("== topology overlap with train ==")
    train_topo = set(topo["train"].values())
    train_ids = set(topo["train"])
    for name in ("development", "test"):
        ids = set(topo[name])
        shapes = set(topo[name].values())
        print(f"{name:12s} graph_id overlap {len(ids & train_ids):4d}   topology overlap {len(shapes & train_topo):4d}   "
              f"({len(shapes)} held-out topologies)")

    print()
    print("== near-duplicate check: shared degree sequence (necessary for isomorphism, far from sufficient) ==")
    train_degs = {degs["train"][g] for g in degs["train"]}
    for name in ("development", "test"):
        held = {degs[name][g] for g in degs[name]}
        print(f"{name:12s} distinct degree sequences {len(held):5d}  shared with train {len(held & train_degs):5d}")

    print()
    print("== scenario text ==")
    for name in ("train", "development", "test"):
        print(f"{name:12s} distinct domain|topic {len(scenarios[name]):4d}")
    print(f"scenario overlap train vs development: {len(scenarios['train'] & scenarios['development'])}")
    print(f"scenario overlap train vs test:        {len(scenarios['train'] & scenarios['test'])}")

    print()
    print("== rows per graph, per split (does the shape of the task transfer?) ==")
    for name, rows in splits.items():
        counter = Counter(row["graph_id"] for row in rows)
        histogram = Counter(counter.values())
        print(f"{name:12s} {dict(sorted(histogram.items()))}")


if __name__ == "__main__":
    main()
