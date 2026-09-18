"""Inspect the single adversarial failure: was the named node a real cause or an innocent?"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


baseline = load("_tb", REPO / "scripts" / "rdmd_trivial_baseline.py")

labels = {row["id"]: row for row in json.loads(
    (HERE / "data" / "adv_labels.json").read_text(encoding="utf-8"))}
sft = {}
for line in (HERE / "sft" / "adversarial.jsonl").read_text(encoding="utf-8").splitlines():
    if line.strip():
        row = json.loads(line)
        sft[row["id"]] = row
verdicts = {}
for line in (HERE / "adv_verdicts.jsonl").read_text(encoding="utf-8").splitlines():
    if line.strip():
        row = json.loads(line)
        verdicts[row["id"]] = row

for row_id, label in labels.items():
    verdict = verdicts[row_id]["verdict"]
    if verdict["status"] == label["status"]:
        continue
    print(f"=== MISMATCH {row_id}")
    print("  gold status      :", label["status"], "cases:", label["injected_nodes"])
    print("  model verdict    :", verdict)
    tree = baseline.parse_input(sft[row_id]["prompt"])
    star, prime = tree["G_star"], tree["G_prime"]
    changed = baseline.changed_nodes(star, prime)
    order = baseline.topo_order(star, prime)
    descendants = baseline.descendant_closure(star, prime)
    ancestors = baseline.ancestor_closure(star, prime)
    changed_set = set(changed)
    roots = [n for n in order if n in changed_set and not (ancestors.get(n, set()) & changed_set)]
    cascading = [n for n in roots if descendants.get(n, set()) & changed_set]
    print("  changed nodes    :", sorted(changed, key=baseline.numeric_label))
    print("  cascading roots  :", cascading)
    print("  injected causes  :", label["injected_nodes"])
    for cause in label["injected_nodes"]:
        fields = baseline.cause_fields(star, prime, cause)
        print(f"    cause {cause}: changed cause fields={fields or 'NONE (derived-only)'} "
              f"descendants_changed={bool(descendants.get(cause, set()) & changed_set)}")
    named = verdict["nodeId"]
    print(f"  named {named!r}: is_a_cause={named in label['injected_nodes']} "
          f"is_cascading_root={named in cascading}")
    left = baseline.node_map(star).get(named, {})
    right = baseline.node_map(prime).get(named, {})
    diff = [f for f in baseline.NODE_FIELDS if left.get(f) != right.get(f)]
    print(f"    changed fields on {named}: {diff or 'NONE (node is untouched!)'}")
