"""Prepare completion-only Qwen supervision for the four TDB heads.

Only public input is placed in prompts. Offline gold supplies masked targets;
the model proposes certificates and actions, while independent checkers retain
final authority. Calibration and frozen test rows are intentionally excluded.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


EDGES = ["e0", "e1", "e2"]
ACTIONS = ["repair_e0", "repair_e1", "repair_both"]


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def prompt(row: dict) -> str:
    public = {
        "observable": row["observable"],
        "structure": row["structure"],
        "unitCatalog": row["unitCatalog"],
        "actionCatalog": row["actionCatalog"],
    }
    return (
        "Estimate the dependency bundle from public evidence only. Return JSON only. "
        "You may propose state statuses, posterior intervals, interaction value, "
        "counterfactual uplift relative to noop, and a decision-sufficient projection. "
        "Use PROPOSED when you supply a projection candidate; only the independent checker may certify it. "
        "Do not output passwords, private state, hidden worlds, or certification claims. "
        "If evidence is missing or conflicting, use UNKNOWN or CONFLICT. PUBLIC_INPUT="
        + json.dumps(public, sort_keys=True, separators=(",", ":"))
    )


def completion(public: dict, gold: dict) -> dict:
    state = {}
    for edge in EDGES:
        target = gold["statePosterior"][edge]
        state[edge] = {
            key: target[key]
            for key in ("status", "posteriorMean", "interval", "uncertainty", "evidenceRefs", "sourceVersion", "label_mask")
            if key in target
        }
    uplift = {}
    for action in ACTIONS:
        uplift[action] = {
            "expected_gain": gold["utilityGold"][action] - gold["utilityGold"]["noop"],
            "applicable": gold["arms"][action]["applicable"],
            "cost": gold["costGold"][action],
        }
    projection = gold["projection"]
    proposal_status = "PROPOSED" if projection["status"] == "CERTIFIED" else projection["status"]
    return {
        "state_posterior": state,
        "bundle_interaction": {
            "structure": gold["bundleInteraction"]["structure"],
            "interactionValue": gold["bundleInteraction"]["interactionValue"],
            "label_mask": gold["bundleInteraction"]["label_mask"],
        },
        "counterfactual_uplift": uplift,
        "projection_proposal": {
            "status": proposal_status,
            "selectedUnits": projection["selectedUnits"],
            "decision": projection["decision"],
            "disclosureCost": projection["disclosureCost"],
            "label_mask": projection["label_mask"],
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--public", required=True)
    parser.add_argument("--gold", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    public_path, gold_path, out = Path(args.public), Path(args.gold), Path(args.output)
    public = read_jsonl(public_path)
    gold_by_id = {row["id"]: row for row in read_jsonl(gold_path)}
    if set(row["id"] for row in public) != set(gold_by_id): raise ValueError("public_gold_id_mismatch")
    if any("hidden_world" in row or "worldCatalog" in row for row in public): raise ValueError("hidden_field_in_public")
    out.mkdir(parents=True, exist_ok=False)
    counts = {}
    hashes = {}
    for split in ("train", "development"):
        rows = []
        for row in public:
            if row["split"] != split: continue
            target = completion(row, gold_by_id[row["id"]])
            rows.append({"id": row["id"], "familyId": row["taskFamilyId"], "split": split, "prompt": prompt(row), "completion": json.dumps(target, ensure_ascii=False, allow_nan=False, sort_keys=True)})
        path = out / f"{split}.jsonl"
        path.write_text("".join(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n" for row in rows), encoding="utf-8")
        counts[split] = len(rows); hashes[split] = hashlib.sha256(path.read_bytes()).hexdigest()
    manifest = {
        "schemaVersion": "tdb-multitask-qwen-data-v2",
        "evidenceLevel": "SYNTHETIC_FINITE_WORLD_ONLY",
        "targets": ["state_posterior", "bundle_interaction", "counterfactual_uplift", "projection_proposal"],
        "stateGoldHiddenFieldsExcluded": True,
        "testUsed": False,
        "calibrationUsedForTraining": False,
        "publicSha256": hashlib.sha256(public_path.read_bytes()).hexdigest(),
        "goldSha256": hashlib.sha256(gold_path.read_bytes()).hexdigest(),
        "files": hashes,
        "counts": counts,
        "projectionStatusVocabulary": ["PROPOSED", "UNKNOWN", "CONFLICT"],
        "projectionCertification": "model never emits CERTIFIED; independent checker is authoritative",
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__": main()
