"""从真实 test split 生成示例输入（剥离 label）。

示例是**派生产物**，必须可复现：这个脚本记录它们从哪来、怎么挑的，避免有人手改
`examples/` 里的 json 之后，它就不再代表真实数据分布。

挑选规则（确定性，无随机）：
- `example_input.json` —— 1 条「派生字段唯一可见」的 drift（最难的一档：真凶在
  inputs/agentId/version/acceptance 上**没有**任何变化，只能靠重建依赖序解出）。
- `smoke_cases.jsonl` —— 12 条：4 drift（含 2 条派生字段唯一可见）+ 4 no_drift + 4 UNKNOWN。
- `smoke_expected.jsonl` —— 对应 gold，**仅用于自检，不要喂给模型**。

跑法：python experiments/rdmd_detective_dataset/deploy/make_examples.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent  # repo root
DATA = HERE.parent / "data"
OUT = HERE / "examples"

# 与 sft 侧「原因字段」定义一致：这四个字段上可见的变化 = 原因直接暴露。
CAUSE_FIELDS = ("inputs", "agentId", "version", "acceptance")


def cause_field_visible(star: dict, prime: dict, node_id: str) -> bool:
    """真凶是否在原因字段上露出了马脚。False = 派生字段唯一可见（最难的一档）。"""
    left = {node.get("id"): node for node in star.get("nodes", [])}
    right = {node.get("id"): node for node in prime.get("nodes", [])}
    a, b = left.get(node_id), right.get(node_id)
    if a is None or b is None:
        return True
    return any(a.get(field) != b.get(field) for field in CAUSE_FIELDS)


def to_case(sample: dict) -> dict:
    """只保留两棵树，丢掉 label 与所有内部字段。"""
    return {"id": sample["id"], "G_star": sample["G_star"], "G_prime": sample["G_prime"]}


def to_verdict(sample: dict) -> dict:
    label = sample.get("label") or {}
    status = label.get("status")
    if status == "drift":
        return {
            "status": "drift",
            "nodeId": label.get("injected_node") or "",
            "edgeId": label.get("injected_edge") or "",
            "type": label.get("injected_type") or "",
            "evidenceNodeIds": [label["injected_node"]] if label.get("injected_node") else [],
        }
    return {
        "status": status,
        "nodeId": "",
        "edgeId": "",
        "type": "",
        "evidenceNodeIds": list(label.get("injected_nodes") or []),
    }


def main() -> int:
    samples = []
    with (DATA / "test.jsonl").open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                samples.append(json.loads(line))

    derived_only = [s for s in samples if (s.get("label") or {}).get("status") == "drift"
                    and not cause_field_visible(s["G_star"], s["G_prime"],
                                                (s.get("label") or {}).get("injected_node"))]
    cause_visible = [s for s in samples if (s.get("label") or {}).get("status") == "drift"
                     and cause_field_visible(s["G_star"], s["G_prime"],
                                             (s.get("label") or {}).get("injected_node"))]
    no_drift = [s for s in samples if (s.get("label") or {}).get("status") == "no_drift"]
    unknown = [s for s in samples if (s.get("label") or {}).get("status") == "UNKNOWN"]

    for name, bucket, need in (("drift(derived-only)", derived_only, 2),
                               ("drift(cause-visible)", cause_visible, 2),
                               ("no_drift", no_drift, 4),
                               ("UNKNOWN", unknown, 4)):
        if len(bucket) < need:
            print(f"[error] test split lacks {name}: {len(bucket)} < {need}", file=sys.stderr)
            return 1

    picks = derived_only[:2] + cause_visible[:2] + no_drift[:4] + unknown[:4]
    OUT.mkdir(parents=True, exist_ok=True)
    smoke_out = OUT / "smoke_cases.jsonl"
    expected_out = OUT / "smoke_expected.jsonl"
    smoke_out.write_text("".join(json.dumps(to_case(s), ensure_ascii=False) + "\n" for s in picks),
                         encoding="utf-8")
    expected_out.write_text(
        "".join(json.dumps({"id": s["id"], **to_verdict(s)}, ensure_ascii=False) + "\n" for s in picks),
        encoding="utf-8")

    hero = derived_only[0]
    (OUT / "example_input.json").write_text(
        json.dumps(to_case(hero), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    counts = {}
    for sample in picks:
        status = (sample.get("label") or {}).get("status")
        counts[status] = counts.get(status, 0) + 1
    print(json.dumps({
        "example_input": str((OUT / "example_input.json").name),
        "example_id": hero["id"],
        "example_gold_node": (hero.get("label") or {}).get("injected_node"),
        "smoke_cases": len(picks),
        "smoke_status_counts": counts,
        "derived_only_available": len(derived_only),
        "no_label_in_cases": True,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
