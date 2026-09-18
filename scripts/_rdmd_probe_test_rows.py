"""Ad-hoc: inspect test rows and test whether a trivial diff rule solves the task."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEST = ROOT / "experiments" / "rdmd_detective_dataset" / "sft" / "test.jsonl"


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    rows = read_jsonl(TEST)
    print("rows", len(rows))
    print("keys", sorted(rows[0].keys()))
    print("---PROMPT SAMPLE---")
    print(rows[0]["prompt"][:3000])
    print("---COMPLETION SAMPLE---")
    print(rows[0]["completion"])
    print("---PROMPT LENGTH chars---")
    lengths = sorted(len(r["prompt"]) for r in rows)
    print("min", lengths[0], "median", lengths[len(lengths) // 2], "max", lengths[-1])
    node_ids = re.findall(r"^node_id", rows[0]["prompt"], re.M)
    print("node_id lines in sample", len(node_ids))


if __name__ == "__main__":
    main()
