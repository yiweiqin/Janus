"""Exact anonymous topology census via individualization-refinement (IR).

Two earlier attempts produced wrong answers and both mistakes are worth remembering:
  1. rebuilding edges from `inputs`/`output` text left some links unresolved, and a WL hash over the
     resulting edgeless graphs collapses to one value -> bogus "1 topology";
  2. aggregating only over children is not a valid invariant for a DAG with joins (879/1199 graphs
     have multi-parent nodes), so non-isomorphic graphs collided -> bogus "4 topologies".

This uses IR: colour refinement to a fixed point, then individualize the smallest non-singleton
colour class and recurse, keeping the lexicographically smallest adjacency encoding. That is a
complete canonical form for labelled graphs of this size. A random-relabelling self-test proves the
invariance empirically before any census number is reported.
"""
from __future__ import annotations

import json
import random
from collections import Counter, defaultdict
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data"


def adjacency(n: int, children: dict[int, list[int]]) -> str:
    edges = sorted((i, c) for i in range(n) for c in children.get(i, []))
    return f"n={n};" + ";".join(f"{a}>{b}" for a, b in edges)


def refine(colors: list[int], parents: list[list[int]], children: list[list[int]]) -> list[int]:
    while True:
        signatures = []
        for i in range(len(colors)):
            incoming = tuple(sorted(colors[j] for j in parents[i]))
            outgoing = tuple(sorted(colors[j] for j in children[i]))
            signatures.append((colors[i], incoming, outgoing))
        table: dict[tuple, int] = {}
        new_colors = []
        for signature in signatures:
            if signature not in table:
                table[signature] = len(table)
            new_colors.append(table[signature])
        if len(set(new_colors)) == len(set(colors)):
            return new_colors
        colors = new_colors


def canonical(colors: list[int], parents: list[list[int]], children: list[list[int]]) -> str:
    colors = refine(colors, parents, children)
    classes: dict[int, list[int]] = defaultdict(list)
    for node, color in enumerate(colors):
        classes[color].append(node)
    n = len(colors)
    if len(classes) == n:
        order = sorted(range(n), key=lambda node: colors[node])
        position = {node: rank for rank, node in enumerate(order)}
        relabelled = {i: [position[c] for c in children[i]] for i in range(n)}
        return adjacency(n, relabelled)
    target = min(color for color, members in classes.items() if len(members) > 1)
    best: str | None = None
    for node in classes[target]:
        branch = list(colors)
        branch[node] = max(colors) + 1
        candidate = canonical(branch, parents, children)
        if best is None or candidate < best:
            best = candidate
    assert best is not None
    return best


def as_arrays(graph: dict) -> tuple[int, list[list[int]], list[list[int]]]:
    ids = [node["id"] for node in graph["nodes"]]
    index = {node_id: i for i, node_id in enumerate(ids)}
    parents: list[list[int]] = [[] for _ in ids]
    children: list[list[int]] = [[] for _ in ids]
    for edge in graph.get("edges") or []:
        a, b = index[edge["from"]], index[edge["to"]]
        children[a].append(b)
        parents[b].append(a)
    return len(ids), parents, children


def shape_of(graph: dict) -> str:
    n, parents, children = as_arrays(graph)
    return canonical(list(range(n)), parents, children)


def relabel_test(seed: int = 7, samples: int = 60) -> None:
    """Permute node ids of random graphs; the canonical form must not change."""
    rng = random.Random(seed)
    graphs: list[dict] = []
    with (DATA / "train.jsonl").open(encoding="utf-8-sig") as handle:
        for line in handle:
            if not line.strip():
                continue
            graphs.append(json.loads(line)["G_star"])
            if len(graphs) >= 400:
                break
    checked = 0
    for graph in rng.sample(graphs, samples):
        base = shape_of(graph)
        ids = [node["id"] for node in graph["nodes"]]
        permuted = list(ids)
        rng.shuffle(permuted)
        mapping = dict(zip(ids, permuted))
        clone = {
            "nodes": [dict(node, id=mapping[node["id"]]) for node in graph["nodes"]],
            "edges": [dict(edge, **{"from": mapping[edge["from"]], "to": mapping[edge["to"]]}) for edge in graph["edges"]],
        }
        if shape_of(clone) != base:
            raise AssertionError(f"canonical form is not relabelling-invariant: {graph['graph_id']}")
        checked += 1
    print(f"self-test: {checked}/{samples} random relabellings produced identical canonical forms  OK")


def main() -> None:
    relabel_test()

    star_first: dict[str, dict] = {}
    star_consistent: Counter = Counter()
    star_shapes: dict[str, str] = {}
    prime_shapes: dict[str, set[str]] = defaultdict(set)
    joins: Counter = Counter()
    with (DATA / "train.jsonl").open(encoding="utf-8-sig") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            graph_id = row["graph_id"]
            if graph_id in star_first:
                star_consistent[json.dumps(row["G_star"], sort_keys=True) == json.dumps(star_first[graph_id], sort_keys=True)] += 1
            else:
                star_first[graph_id] = row["G_star"]
                star_shapes[graph_id] = shape_of(row["G_star"])
            prime_shapes[graph_id].add(shape_of(row["G_prime"]))
            _, parents, _ = as_arrays(row["G_star"])
            joins[sum(1 for p in parents if len(p) > 1)] += 1

    print()
    print("== sanity ==")
    print("graphs:", len(star_first))
    print("rows whose G_star matches the graph's first row:", dict(star_consistent))
    print("multi-parent nodes per row (0 = tree):", dict(sorted(joins.items())))

    print()
    print("== Q1 true count of G_star topologies, ids ignored ==")
    distinct = Counter(star_shapes.values())
    print("DISTINCT G_star TOPOLOGIES:", len(distinct))
    for shape, count in distinct.most_common(10):
        nodes = int(shape.split(";")[0].split("=")[1])
        edges = shape.split(";")[1:]
        print(f"  graphs {count:5d}  nodes {nodes}  edges {len(edges)}")

    print()
    print("== Q2 does the high-frequency core use fewer topologies? ==")
    with (DATA / "train.jsonl").open(encoding="utf-8-sig") as handle:
        row_counts: Counter = Counter(json.loads(line)["graph_id"] for line in handle if line.strip())
    for low, high, label in ((1, 1, "1 row"), (2, 5, "2-5 rows"), (6, 12, "6-12 rows"), (13, 99, "13+ rows")):
        ids = [g for g, c in row_counts.items() if low <= c <= high]
        shapes = {star_shapes[g] for g in ids}
        print(f"{label:10s} graphs {len(ids):5d}  rows {sum(row_counts[g] for g in ids):5d}  distinct topologies {len(shapes)}")

    print()
    print("== Q3 how many G_prime topologies per graph, and overall ==")
    per_graph = Counter(len(values) for values in prime_shapes.values())
    print("distinct G_prime topologies per graph:", dict(sorted(per_graph.items())))
    print("total distinct G_prime topologies:", len({v for values in prime_shapes.values() for v in values}))
    print("graphs whose G_prime never varies (pure no_drift/UNKNOWN):", per_graph.get(1, 0))

    print()
    print("== Q4 is the topology connected to how many culprits a graph has? ==")
    culprits: dict[str, set[str]] = defaultdict(set)
    with (DATA / "train.jsonl").open(encoding="utf-8-sig") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            if row["label"]["status"] == "drift":
                culprits[row["graph_id"]].add(row["label"]["injected_node"])
    by_shape: dict[str, Counter] = defaultdict(Counter)
    for graph_id, shape in star_shapes.items():
        by_shape[shape][len(culprits.get(graph_id, ()))] += 1
    for shape, counter in sorted(by_shape.items(), key=lambda kv: -sum(kv[1].values())):
        nodes = int(shape.split(";")[0].split("=")[1])
        print(f"  topology(nodes={nodes}) graphs={sum(counter.values()):5d}  culprit-count histogram {dict(sorted(counter.items()))}")


if __name__ == "__main__":
    main()
