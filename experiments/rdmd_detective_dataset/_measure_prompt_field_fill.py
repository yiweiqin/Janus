"""量出 v3 语料上「prompt 里模型真正看到的字段」的填充率。

为什么必须先量：契约是 fail-closed 的判据，「必需字段」只能取那些**在训练语料上 100% 非空**
的字段。凭空把 title 加进必需集，就可能让一份合法的语料行被判成 out-of-distribution
（`test_legal_corpus_rows_are_never_rejected` 守的就是这条）。会误伤的守卫比没有守卫更糟。

量的对象是 `public_graph` 投影之后的节点，也就是 prompt 里的节点 —— 与 `check_case_contract`
的判据范围严格一致。

跑法：python experiments/rdmd_detective_dataset/_measure_prompt_field_fill.py
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
SFT = HERE / "sft"
STRIDE = 13  # 抽样步长；train.jsonl 有 200MB+，全量没必要

# 与 deploy/rdmd_detective.py#NODE_FIELDS 一致
FIELDS = ("id", "title", "role", "agentId", "version", "acceptance",
          "artifact", "stage", "inputs", "output", "summary")
EXTRA = ("kind", "status")


def payload_of(prompt: str) -> dict:
    return json.loads(prompt.split("INPUT=", 1)[1])


def main() -> int:
    splits = sys.argv[1:] or ["train", "development", "test", "ood", "adversarial"]
    for name in splits:
        path = SFT / f"{name}.jsonl"
        if not path.is_file():
            print(f"[skip] {name}: missing")
            continue
        nonempty = Counter()
        total = 0
        empty_title = 0
        extra_present = Counter()
        with path.open(encoding="utf-8") as handle:
            for index, line in enumerate(handle):
                if not line.strip() or index % STRIDE:
                    continue
                row = json.loads(line)
                payload = payload_of(row["prompt"])
                for graph in ("G_star", "G_prime"):
                    for node in payload[graph]["nodes"]:
                        total += 1
                        for field in FIELDS:
                            if node.get(field):
                                nonempty[field] += 1
                        if not node.get("title"):
                            empty_title += 1
                        for field in EXTRA:
                            if node.get(field):
                                extra_present[field] += 1
        print(f"\n=== {name}: {total} node instances (stride {STRIDE}) ===")
        for field in FIELDS:
            pct = 100.0 * nonempty[field] / max(total, 1)
            flag = "OK  " if nonempty[field] == total else "GAP "
            print(f"  {flag} {field:10s} {nonempty[field]:8d}/{total}  {pct:6.2f}%")
        print(f"  empty title on {empty_title} nodes")
        print(f"  kind present on {extra_present['kind']} nodes; status present on {extra_present['status']} nodes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
