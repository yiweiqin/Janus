"""Ad-hoc: is node-id order always a topological order in v2?"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SFT = ROOT / "experiments" / "rdmd_detective_dataset" / "sft"


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def parse_input(prompt: str) -> dict:
    marker = prompt.index("INPUT=")
    payload = prompt[marker + len("INPUT="):].strip()
    return json.loads(re.search(r"\{.*\}", payload, re.S).group(0))


def idx(node_id: str) -> int:
    digits = re.findall(r"\d+", node_id)
    return int(digits[0]) if digits else 10**6


def main() -> None:
    rows = read_jsonl(SFT / "test.jsonl")
    violations = 0
    shuffled = 0
    for row in rows:
        tree = parse_input(row["prompt"])
        for graph in (tree["G_star"], tree["G_prime"]):
            ids = [n["id"] for n in graph["nodes"]]
            ranks = {nid: i for i, nid in enumerate(sorted(ids, key=idx))}
            for edge in graph["edges"]:
                if ranks.get(edge["from"], -1) >= ranks.get(edge["to"], -1):
                    violations += 1
        if not violations:
            pass
    print("edges_violating_id_topological_order", violations)
    print("rows_checked", len(rows))
    print("note: 0 means node id order is always a valid topological order")


if __name__ == "__main__":
    main()
