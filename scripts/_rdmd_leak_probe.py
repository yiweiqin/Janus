"""Ad-hoc: quantify the surface-diff shortcut on the v2 SFT splits."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SFT = ROOT / "experiments" / "rdmd_detective_dataset" / "sft"
DERIVED = {"artifact", "summary", "output"}
CAUSE = {"inputs", "agentId", "version", "acceptance"}


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def parse_input(prompt: str) -> dict:
    marker = prompt.index("INPUT=")
    payload = prompt[marker + len("INPUT="):].strip()
    match = re.search(r"\{.*\}", payload, re.S)
    return json.loads(match.group(0))


def node_index(node_id: str) -> int:
    digits = re.findall(r"\d+", node_id)
    return int(digits[0]) if digits else 10**6


def analyse(rows: list[dict]) -> dict:
    drift = [r for r in rows if r["status"] == "drift"]
    stats = {
        "n": len(rows),
        "drift": len(drift),
        "min_id_diff_hit": 0,
        "first_cause_field_hit": 0,
        "cause_field_in_gold": 0,
        "gold_has_cause_field": 0,
        "cascade_nodes_total": 0,
        "differing_total": 0,
        "type_from_cause_field_hit": 0,
        "gold_surface_diff_count": [],
        "edge_diff_rows": 0,
        "node_add_rows": 0,
    }
    for row in drift:
        gold = json.loads(row["completion"])
        gold_id = gold["nodeId"]
        tree = parse_input(row["prompt"])
        a = {n["id"]: n for n in tree["G_star"]["nodes"]}
        b = {n["id"]: n for n in tree["G_prime"]["nodes"]}
        differing = []
        cause_at = {}
        for nid in a:
            if nid not in b:
                continue
            keys = [k for k in set(a[nid]) | set(b[nid]) if a[nid].get(k) != b[nid].get(k)]
            if keys:
                differing.append(nid)
                cause_keys = [k for k in keys if k in CAUSE]
                if cause_keys:
                    cause_at[nid] = sorted(cause_keys)
        differing.sort(key=node_index)
        stats["differing_total"] += len(differing)
        stats["gold_surface_diff_count"].append(len(differing))
        if differing and differing[0] == gold_id:
            stats["min_id_diff_hit"] += 1
        if gold_id in cause_at:
            stats["gold_has_cause_field"] += 1
        cause_nodes = sorted(cause_at, key=node_index)
        if cause_nodes and cause_nodes[0] == gold_id:
            stats["first_cause_field_hit"] += 1
        for nid in differing:
            if nid not in cause_at:
                stats["cascade_nodes_total"] += 1
        if gold_id in cause_at:
            fields = cause_at[gold_id]
            mapping = {"inputs": "missing_dependency", "agentId": "wrong_agent", "version": "wrong_version", "acceptance": "wrong_acceptance"}
            predicted = {mapping[f] for f in fields if f in mapping}
            if predicted == {gold["type"]}:
                stats["type_from_cause_field_hit"] += 1
        if (tree["G_star"].get("edges") or []) != (tree["G_prime"].get("edges") or []):
            stats["edge_diff_rows"] += 1
        if len(b) != len(a):
            stats["node_add_rows"] += 1
    n = len(drift) or 1
    out = {k: v for k, v in stats.items() if k != "gold_surface_diff_count"}
    for key in ["min_id_diff_hit", "first_cause_field_hit", "gold_has_cause_field", "type_from_cause_field_hit"]:
        out[key + "_rate"] = stats[key] / n
    out["cascade_node_mean"] = stats["cascade_nodes_total"] / n
    out["differing_mean"] = stats["differing_total"] / n
    counts = sorted(stats["gold_surface_diff_count"])
    out["diff_count_median"] = counts[len(counts) // 2] if counts else 0
    return out


def main() -> None:
    for split in ["train", "development", "test"]:
        rows = read_jsonl(SFT / f"{split}.jsonl")
        print(split, json.dumps(analyse(rows), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
