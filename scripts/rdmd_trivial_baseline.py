"""Deterministic baselines for the RDMD detective task (v2 shortcut probe + v3 honest baseline).

Every rule below is computed from the SFT prompt only, i.e. from `(G_star, G_prime)`. It never
reads the label, so it is a fair reference for what a model can achieve without learning.

Rules:
  A  lowest-id node whose own inputs/agentId/version/acceptance changed   (v2 "structural heuristic")
  B  lowest-id changed node                                               (v2 shortcut; was 1.000)
  C  topologically earliest changed node
  D  topologically earliest changed node that has a changed descendant
  E  full honest baseline: use the set of changed nodes with a changed descendant; one -> drift
     with that node, two or more -> UNKNOWN, none -> no_drift. Reports localisation *and*
     abstention together.

Rule B being ~1.0 means the dataset has a positional shortcut. Rule D/E being ~1.0 is expected
for a synthetic dataset with a unique planted cause; the point is that D/E require reconstructing
the dependency order and reasoning about which edit actually cascades.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SFT = ROOT / "experiments" / "rdmd_detective_dataset" / "sft"
CAUSE_FIELDS = {"inputs", "agentId", "version", "acceptance"}
CAUSE_TO_TYPE = {
    "inputs": "missing_dependency",
    "agentId": "wrong_agent",
    "version": "wrong_version",
    "acceptance": "wrong_acceptance",
}
NODE_FIELDS = ["id", "title", "role", "agentId", "version", "acceptance", "artifact", "stage", "inputs", "output", "summary"]


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def parse_input(prompt: str) -> dict:
    marker = prompt.index("INPUT=")
    payload = prompt[marker + len("INPUT="):].strip()
    return json.loads(re.search(r"\{.*\}", payload, re.S).group(0))


def numeric_label(node_id: str) -> int:
    digits = re.findall(r"\d+", str(node_id or ""))
    return int("".join(digits)) if digits else 10**9


def node_map(graph: dict) -> dict[str, dict]:
    return {node["id"]: node for node in graph.get("nodes") or []}


def edge_pairs(graph: dict) -> set[tuple[str, str]]:
    return {(edge["from"], edge["to"]) for edge in graph.get("edges") or []}


def changed_nodes(star: dict, prime: dict) -> list[str]:
    left, right = node_map(star), node_map(prime)
    changed = []
    for node_id in set(left) | set(right):
        if node_id not in left or node_id not in right:
            changed.append(node_id)
            continue
        if any(left[node_id].get(field) != right[node_id].get(field) for field in NODE_FIELDS):
            changed.append(node_id)
    return changed


def cause_fields(star: dict, prime: dict, node_id: str) -> list[str]:
    left = node_map(star).get(node_id)
    right = node_map(prime).get(node_id)
    if left is None or right is None:
        return []
    return sorted(field for field in CAUSE_FIELDS if left.get(field) != right.get(field))


def descendant_closure(star: dict, prime: dict) -> dict[str, set[str]]:
    children: dict[str, set[str]] = {}
    for from_id, to_id in edge_pairs(star) | edge_pairs(prime):
        children.setdefault(from_id, set()).add(to_id)
    closure: dict[str, set[str]] = {}
    for node_id in set(node_map(star)) | set(node_map(prime)):
        seen: set[str] = set()
        stack = list(children.get(node_id, ()))
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            stack.extend(children.get(current, ()))
        closure[node_id] = seen
    return closure


def ancestor_closure(star: dict, prime: dict) -> dict[str, set[str]]:
    parents: dict[str, set[str]] = {}
    for from_id, to_id in edge_pairs(star) | edge_pairs(prime):
        parents.setdefault(to_id, set()).add(from_id)
    closure: dict[str, set[str]] = {}
    for node_id in set(node_map(star)) | set(node_map(prime)):
        seen: set[str] = set()
        stack = list(parents.get(node_id, ()))
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            stack.extend(parents.get(current, ()))
        closure[node_id] = seen
    return closure


def topo_order(star: dict, prime: dict) -> list[str]:
    nodes = list(set(node_map(star)) | set(node_map(prime)))
    edges = edge_pairs(star) | edge_pairs(prime)
    indeg = {node_id: 0 for node_id in nodes}
    children: dict[str, list[str]] = {}
    for from_id, to_id in edges:
        if from_id not in indeg or to_id not in indeg:
            continue
        indeg[to_id] += 1
        children.setdefault(from_id, []).append(to_id)
    ready = sorted((node_id for node_id in nodes if indeg[node_id] == 0), key=numeric_label)
    order: list[str] = []
    while ready:
        current = ready.pop(0)
        order.append(current)
        for child in sorted(children.get(current, []), key=numeric_label):
            indeg[child] -= 1
            if indeg[child] == 0:
                ready.append(child)
        ready.sort(key=numeric_label)
    order.extend(sorted((node_id for node_id in nodes if node_id not in set(order)), key=numeric_label))
    return order


def cascading_causes(star: dict, prime: dict) -> list[str]:
    changed = changed_nodes(star, prime)
    changed_set = set(changed)
    closure = descendant_closure(star, prime)
    return [
        node_id
        for node_id in topo_order(star, prime)
        if node_id in changed_set and closure.get(node_id, set()) & changed_set
    ]


def evaluate_row(row: dict) -> dict:
    tree = parse_input(row["prompt"])
    star, prime = tree["G_star"], tree["G_prime"]
    changed = changed_nodes(star, prime)
    if not changed:
        return {"no_drift": True}

    order = topo_order(star, prime)
    descendants = descendant_closure(star, prime)
    ancestors = ancestor_closure(star, prime)
    changed_set = set(changed)
    cause_like = [node_id for node_id in order if node_id in changed_set and cause_fields(star, prime, node_id)]

    # A cascade root is a changed node that no changed node feeds: the place the visible change
    # starts. Decoys are new leaves, so they are roots too but never cascade.
    roots = [node_id for node_id in order if node_id in changed_set and not (ancestors.get(node_id, set()) & changed_set)]
    cascade_roots = [node_id for node_id in roots if descendants.get(node_id, set()) & changed_set]

    rule_a = cause_like[0] if cause_like else ""
    rule_b = min(changed, key=numeric_label)
    rule_c = roots[0] if len(roots) == 1 else ""
    rule_d = cascade_roots[0] if len(cascade_roots) == 1 else ""

    if len(cascade_roots) == 1:
        root = cascade_roots[0]
        fields = cause_fields(star, prime, root)
        types = {CAUSE_TO_TYPE[field] for field in fields if field in CAUSE_TO_TYPE}
        rule_e = {"status": "drift", "nodeId": root, "type": types.pop() if len(types) == 1 else ""}
    else:
        rule_e = {"status": "UNKNOWN", "nodeId": "", "type": ""}

    return {
        "no_drift": False,
        "ruleA": rule_a,
        "ruleB": rule_b,
        "ruleC": rule_c,
        "ruleD": rule_d,
        "ruleE": rule_e,
        "causeCount": len(cascade_roots),
    }


def score(rows: list[dict]) -> dict:
    buckets = {
        "drift": {"n": 0, "A": 0, "B": 0, "C": 0, "D": 0, "E": 0, "Etype": 0},
        "no_drift": {"n": 0, "E": 0},
        "UNKNOWN": {"n": 0, "E": 0},
    }
    for row in rows:
        status = row["status"]
        gold = json.loads(row["completion"])
        result = evaluate_row(row)
        if status == "no_drift":
            buckets["no_drift"]["n"] += 1
            if result["no_drift"]:
                buckets["no_drift"]["E"] += 1
            continue
        if result["no_drift"]:
            continue
        if status == "drift":
            bucket = buckets["drift"]
            bucket["n"] += 1
            gold_node = gold["nodeId"]
            if result["ruleA"] == gold_node:
                bucket["A"] += 1
            if result["ruleB"] == gold_node:
                bucket["B"] += 1
            if result["ruleC"] == gold_node:
                bucket["C"] += 1
            if result["ruleD"] == gold_node:
                bucket["D"] += 1
            if result["ruleE"]["status"] == "drift" and result["ruleE"]["nodeId"] == gold_node:
                bucket["E"] += 1
                if result["ruleE"]["type"] == gold["type"]:
                    bucket["Etype"] += 1
        elif status == "UNKNOWN":
            bucket = buckets["UNKNOWN"]
            bucket["n"] += 1
            if result["ruleE"]["status"] == "UNKNOWN":
                bucket["E"] += 1

    out: dict[str, dict] = {}
    for name, bucket in buckets.items():
        n = bucket["n"] or 1
        if name == "drift":
            out[name] = {
                "n": bucket["n"],
                "ruleA_lowestIdCauseField_nodeTop1": bucket["A"] / n,
                "ruleB_lowestIdChanged_nodeTop1": bucket["B"] / n,
                "ruleC_changedRootUnique_nodeTop1": bucket["C"] / n,
                "ruleD_cascadeRoot_nodeTop1": bucket["D"] / n,
                "ruleE_full_baseline_nodeTop1": bucket["E"] / n,
                "ruleE_full_baseline_typeTop1": bucket["Etype"] / n,
            }
        elif name == "no_drift":
            out[name] = {"n": bucket["n"], "ruleE_identicalTrees_correct": bucket["E"] / n}
        else:
            out[name] = {"n": bucket["n"], "ruleE_multipleDisjointCauses_abstainRate": bucket["E"] / n}
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=str(SFT))
    parser.add_argument("--splits", nargs="*", default=["train", "development", "test"])
    parser.add_argument("--output", default="")
    args = parser.parse_args()
    data = Path(args.data)
    report = {"shots": {}}
    for split in args.splits:
        path = data / f"{split}.jsonl"
        if not path.is_file():
            continue
        report["shots"][split] = score(read_jsonl(path))
    text = json.dumps(report, ensure_ascii=False, indent=2)
    print(text)
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(text + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
