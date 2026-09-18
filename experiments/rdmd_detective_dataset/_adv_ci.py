"""Wilson intervals for the adversarial probe, so the report quotes an honest range."""
from __future__ import annotations

import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent


def wilson(hits: int, total: int, z: float = 1.96) -> tuple[float, float]:
    if not total:
        return (0.0, 0.0)
    p = hits / total
    denom = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denom
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denom
    return (centre - half, centre + half)


summary = json.loads((HERE / "data" / "adv_summary.json").read_text(encoding="utf-8"))
for group, stats in summary["byKind"].items():
    if stats["abstain_n"]:
        low, high = wilson(stats["model_abstain"], stats["abstain_n"])
        print(f"{group}: abstention {stats['model_abstain']}/{stats['abstain_n']} = "
              f"{stats['model_abstain'] / stats['abstain_n']:.3f} "
              f"[{low:.2f}, {high:.2f}]  baseline {stats['base_abstain']}/{stats['abstain_n']}")
    if stats["drift_n"]:
        low, high = wilson(stats["model_node"], stats["drift_n"])
        print(f"{group}: localisation {stats['model_node']}/{stats['drift_n']} = "
              f"{stats['model_node'] / stats['drift_n']:.3f} [{low:.2f}, {high:.2f}] "
              f"| type {stats['model_type']}/{stats['drift_n']} "
              f"| baseline {stats['base_node']}/{stats['drift_n']}")
print(f"invalid verdicts: {sum(s['invalid'] for s in summary['byKind'].values())}")
