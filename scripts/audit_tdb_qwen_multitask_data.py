"""Fail-closed audit for Qwen TDB train/development completion data."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


TARGETS = {"state_posterior", "bundle_interaction", "counterfactual_uplift", "projection_proposal"}
PROJECTION_STATUSES = {"PROPOSED", "UNKNOWN", "CONFLICT"}
FORBIDDEN_PROMPT_FIELDS = {"hidden_world", "worldCatalog", "utilityGold", "statePosterior", "costGold", "currentWorldId"}


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    data, output = Path(args.data), Path(args.output)
    manifest = json.loads((data / "manifest.json").read_text(encoding="utf-8"))
    failures: list[list[str]] = []
    rows_by_split = {split: read_jsonl(data / f"{split}.jsonl") for split in ("train", "development")}

    families: dict[str, set[str]] = {}
    projection_counts: dict[str, int] = {}
    for split, rows in rows_by_split.items():
        families[split] = {row["familyId"] for row in rows}
        if any(row.get("split") != split for row in rows): failures.append([split, "split_mismatch"])
        if len({row["id"] for row in rows}) != len(rows): failures.append([split, "duplicate_id"])
        for row in rows:
            prompt = row.get("prompt", "")
            for field in FORBIDDEN_PROMPT_FIELDS:
                if field in prompt: failures.append([row["id"], f"forbidden_prompt_field:{field}"])
            try: completion = json.loads(row["completion"])
            except (KeyError, TypeError, json.JSONDecodeError):
                failures.append([row.get("id", "unknown"), "invalid_completion_json"]); continue
            if set(completion) != TARGETS: failures.append([row["id"], "target_schema"]); continue
            status = completion["projection_proposal"].get("status")
            projection_counts[status] = projection_counts.get(status, 0) + 1
            if status not in PROJECTION_STATUSES: failures.append([row["id"], f"projection_status:{status}"])
            if completion["projection_proposal"].get("label_mask") is not True: failures.append([row["id"], "projection_label_mask"])
            if completion["bundle_interaction"].get("label_mask") is not True: failures.append([row["id"], "interaction_label_mask"])
            for edge, state in completion["state_posterior"].items():
                if "label_mask" not in state: failures.append([row["id"], f"state_label_mask:{edge}"])

    if families["train"] & families["development"]: failures.append(["all", "family_leakage"])
    if manifest.get("testUsed") is not False: failures.append(["manifest", "test_used"])
    if manifest.get("calibrationUsedForTraining") is not False: failures.append(["manifest", "calibration_used"])
    for split, rows in rows_by_split.items():
        if manifest.get("counts", {}).get(split) != len(rows): failures.append([split, "manifest_count"])
        if manifest.get("files", {}).get(split) != digest(data / f"{split}.jsonl"): failures.append([split, "manifest_hash"])

    report = {
        "scope": "tdb-qwen-multitask-data-audit-v1",
        "dataManifestSha256": digest(data / "manifest.json"),
        "counts": {split: len(rows) for split, rows in rows_by_split.items()},
        "familyCounts": {split: len(items) for split, items in families.items()},
        "projectionStatusCounts": projection_counts,
        "modelCertificationTargetCount": projection_counts.get("CERTIFIED", 0),
        "testRead": False,
        "calibrationUsedForTraining": False,
        "failures": failures,
        "allValid": not failures,
        "evidenceLevel": "SYNTHETIC_FINITE_WORLD_ONLY",
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    if failures: raise SystemExit(2)


if __name__ == "__main__": main()
