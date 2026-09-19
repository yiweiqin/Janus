"""Fail-closed audit for the TDB world-catalog/evaluated public contract."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def load(path: Path) -> list[dict]: return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(); parser.add_argument("--catalog", required=True); parser.add_argument("--evaluated", required=True); parser.add_argument("--output", required=True); args = parser.parse_args()
    catalog, evaluated, out = Path(args.catalog), Path(args.evaluated), Path(args.output)
    public = load(evaluated / "public.jsonl"); gold = load(evaluated / "gold.offline.jsonl")
    failures = []
    by_split = {}
    for row in public: by_split.setdefault(row["split"], []).append(row)
    for split, rows in by_split.items():
        family = {row["taskFamilyId"] for row in rows}
        pair = {row["observable"].get("receiver", {}).get("role") for row in rows}
        if len({row["id"] for row in rows}) != len(rows): failures.append([split, "instance_duplicate"])
        if any("hidden_world" in row or "worldCatalog" in row or "utilityGold" in row for row in rows): failures.append([split, "hidden_field_in_public"])
        if any(set(row["structure"]["actionCatalog"]) != {"noop", "repair_e0", "repair_e1", "repair_both"} for row in rows): failures.append([split, "action_catalog"])
    ids = {row["id"] for row in public}
    if ids != {row["id"] for row in gold}: failures.append(["all", "public_gold_id_mismatch"])
    test_registry = json.loads((catalog / "access_registry.jsonl").read_text(encoding="utf-8").splitlines()[0])
    if test_registry["status"] != "generated_frozen_not_evaluated": failures.append(["test", "test_registry_status"])
    if test_registry["sha256"] != hashlib.sha256((catalog / "test.frozen.jsonl").read_bytes()).hexdigest(): failures.append(["test", "test_hash"])
    report = {
        "scope": "tdb-world-catalog-data-contract-audit-v2", "catalogManifestSha256": hashlib.sha256((catalog / "manifest.json").read_bytes()).hexdigest(),
        "evaluatedPublicSha256": hashlib.sha256((evaluated / "public.jsonl").read_bytes()).hexdigest(), "evaluatedGoldSha256": hashlib.sha256((evaluated / "gold.offline.jsonl").read_bytes()).hexdigest(),
        "counts": {split: len(rows) for split, rows in by_split.items()}, "testWasRead": False, "failures": failures, "allValid": not failures,
        "evidenceLevel": "SYNTHETIC_FINITE_WORLD_ONLY", "notes": ["agent-pair and relation-type transfer require additional leave-group-out runs", "test is registered and frozen but not evaluated in this audit"],
    }
    out.mkdir(parents=True, exist_ok=False); (out / "audit.json").write_text(json.dumps(report, indent=2), encoding="utf-8"); print(json.dumps(report, indent=2));
    if failures: raise SystemExit(2)


if __name__ == "__main__": main()
