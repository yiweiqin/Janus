"""Generate raw finite-world TDB catalogs without producing training labels.

The generator owns task structure, latent worlds and noisy public evidence.  A
separate Node reference evaluator derives state, interaction, uplift and
projection labels.  This artifact is synthetic protocol evidence only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path


STRUCTURES = (
    "and_bottleneck",
    "or_redundancy",
    "cascade",
    "shared_resource",
    "version_coupling",
    "double_fault",
)
EDGE_IDS = ("e0", "e1", "e2")
ACTIONS = ("noop", "repair_e0", "repair_e1", "repair_both")


def sha_bytes(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def noisy_signal(rng: random.Random, value: bool, reliability: float) -> int:
    return int(value if rng.random() < reliability else not value)


def world(rng: random.Random, world_id: str, structure: str) -> dict:
    edge_ok = [rng.random() < 0.62 for _ in EDGE_IDS]
    versions = [rng.randrange(0, 3) for _ in EDGE_IDS]
    capacity = rng.randrange(1, 4)
    demand = [rng.randrange(1, 3) for _ in EDGE_IDS]
    return {
        "id": world_id,
        "structure": structure,
        "edgeOk": dict(zip(EDGE_IDS, edge_ok)),
        "versions": dict(zip(EDGE_IDS, versions)),
        "capacity": capacity,
        "demand": dict(zip(EDGE_IDS, demand)),
    }


def public_observation(rng: random.Random, current: dict, family: int, instance: int) -> dict:
    reliability = 0.62 + 0.25 * rng.random()
    evidence = {}
    for edge_id in EDGE_IDS:
        missing = rng.random() < 0.14
        conflict = not missing and rng.random() < 0.10
        stale = not missing and rng.random() < 0.12
        primary = None if missing else noisy_signal(rng, current["edgeOk"][edge_id], reliability)
        secondary = None if missing else (1 - primary if conflict else primary)
        evidence[edge_id] = {
            "primary": primary,
            "secondary": secondary,
            "missing": missing,
            "conflict": conflict,
            "ageBucket": 3 if stale else rng.randrange(0, 3),
            "sourceVersion": f"source-v{current['versions'][edge_id]}",
            "evidenceRefs": [f"obs-{family:03d}-{instance:03d}-{edge_id}-a", f"obs-{family:03d}-{instance:03d}-{edge_id}-b"],
        }
    return {
        "evidence": evidence,
        "sourceReliability": reliability,
        "query": "select a safe task action with minimum regret",
        "receiver": {"role": "downstream_agent", "scope": "task_public"},
        "privacyPolicy": "hide_raw_edge_state_allow_status_units",
        "riskBudget": 0.25,
    }


def compatible_worlds(worlds: list[dict], observation: dict) -> list[str]:
    """Declare support only from non-missing, non-conflicting, non-stale evidence.

    This is a generator-side support relation, not a state or decision label.
    The independent evaluator decides what follows from this support set.
    """
    compatible = []
    for candidate in worlds:
        ok = True
        for edge_id, item in observation["evidence"].items():
            if item["missing"] or item["conflict"] or item["ageBucket"] >= 3:
                continue
            if int(candidate["edgeOk"][edge_id]) != item["primary"]:
                ok = False
                break
        if ok:
            compatible.append(candidate["id"])
    return compatible or [w["id"] for w in worlds]


def make_rows(args: argparse.Namespace) -> list[dict]:
    rng = random.Random(args.seed)
    rows = []
    for family in range(args.families):
        structure = STRUCTURES[family % len(STRUCTURES)]
        split = "train" if family < args.families * 0.5 else (
            "development" if family < args.families * 0.65 else (
                "calibration" if family < args.families * 0.8 else "test"
            )
        )
        agent_pair = f"pair-{family % 10:02d}"
        relation_type = f"relation-{family % 6:02d}"
        time_epoch = family % 4
        for instance in range(args.instances_per_family):
            worlds = [world(rng, f"w{i}", structure) for i in range(args.worlds_per_instance)]
            current = worlds[0]
            observation = public_observation(rng, current, family, instance)
            rows.append({
                "schemaVersion": "tdb-world-catalog-v2",
                "id": f"tdb2-{family:03d}-{instance:03d}",
                "taskFamilyId": f"tdb2-family-{family:03d}",
                "split": split,
                "groupMetadata": {
                    "agentPair": agent_pair,
                    "relationType": relation_type,
                    "timeEpoch": time_epoch,
                },
                "structure": {
                    "kind": structure,
                    "edgeIds": list(EDGE_IDS),
                    "actionCatalog": list(ACTIONS),
                },
                "publicObservation": observation,
                "worldCatalog": worlds,
                "currentWorldId": current["id"],
                "supportWorldIds": compatible_worlds(worlds, observation),
                "unitCatalog": [
                    {"id": f"{edge_id}.status", "edgeId": edge_id, "allowed": True, "cost": 1}
                    for edge_id in EDGE_IDS
                ],
                "utilitySemantics": "binary_task_success_without_cost",
                "actionCosts": {"noop": 0.0, "repair_e0": 0.1, "repair_e1": 0.1, "repair_both": 0.2},
                "evaluatorContract": "tdb-independent-reference-v2",
            })
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--families", type=int, default=120)
    parser.add_argument("--instances-per-family", type=int, default=10)
    parser.add_argument("--worlds-per-instance", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20260910)
    args = parser.parse_args()
    if args.families < 60 or args.instances_per_family < 4 or not 4 <= args.worlds_per_instance <= 64:
        raise ValueError("insufficient_catalog_size")

    root = Path(args.output)
    root.mkdir(parents=True, exist_ok=False)
    rows = make_rows(args)
    files = {}
    for split in ("train", "development", "calibration", "test"):
        path = root / ("test.frozen.jsonl" if split == "test" else f"{split}.jsonl")
        selected = [row for row in rows if row["split"] == split]
        path.write_text("".join(json.dumps(row, allow_nan=False) + "\n" for row in selected), encoding="utf-8")
        files[path.name] = {"rows": len(selected), "sha256": sha_bytes(path)}

    manifest = {
        "schemaVersion": "tdb-world-catalog-manifest-v2",
        "evidenceLevel": "SYNTHETIC_FINITE_WORLD_ONLY",
        "generatorDoesNotProduceLabels": True,
        "utilitySemantics": "binary_task_success_without_cost",
        "seed": args.seed,
        "families": args.families,
        "instancesPerFamily": args.instances_per_family,
        "worldsPerInstance": args.worlds_per_instance,
        "structures": list(STRUCTURES),
        "files": files,
        "testPolicy": "raw test catalog frozen; do not label, train, calibrate or inspect before model freeze",
        "generatorSha256": sha_bytes(Path(__file__)),
        "realGeneralizationClaimAllowed": False,
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (root / "access_registry.jsonl").write_text(json.dumps({
        "split": "test",
        "status": "generated_frozen_not_evaluated",
        "file": "test.frozen.jsonl",
        "sha256": files["test.frozen.jsonl"]["sha256"],
    }) + "\n", encoding="utf-8")
    print(json.dumps(manifest, allow_nan=False))


if __name__ == "__main__":
    main()
