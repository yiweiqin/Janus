"""Score the OOD probe: deterministic baseline (rules A-E) vs the trained model.

Run twice:
  1. without --verdicts -> baseline only (no GPU needed)
  2. with    --verdicts -> adds the model columns

The baseline is NOT re-implemented here: rules A-E are imported from
scripts/rdmd_trivial_baseline.py, which is the same code that produced the v3 baseline table. Two
copies of a baseline definition drift apart, and a mis-stated baseline silently rewrites the
conclusion.

Grouping by *scale* is the deployment-relevant cut ("how big a plan can I hand it?"); grouping by
*shape* answers "does an unfamiliar topology break it?". Both sides are measured on identical rows,
so "baseline holds but model drops" is the pattern that proves a generalisation gap, while "both
drop" means the probe got hard for the task definition.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
LABELS = HERE / "data" / "ood_labels.json"
CASES = HERE / "data" / "ood_cases.jsonl"
SFT = HERE / "sft" / "ood.jsonl"


def load_baseline_module():
    path = REPO / "scripts" / "rdmd_trivial_baseline.py"
    spec = importlib.util.spec_from_file_location("_rdmd_trivial_baseline", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def baseline_verdict(module, sft_row: dict) -> dict:
    """Rule E expressed in the same shape as a model verdict, so both can be scored identically."""
    result = module.evaluate_row(sft_row)
    if result.get("no_drift"):
        return {"status": "no_drift", "nodeId": "", "type": ""}
    rule_e = result.get("ruleE") or {}
    return {
        "status": rule_e.get("status", "UNKNOWN"),
        "nodeId": rule_e.get("nodeId", ""),
        "type": rule_e.get("type", ""),
    }


def check_prompt_contract(sft_path: Path, cases_path: Path) -> list[str]:
    """The byte-exact guarantee, extended to OOD inputs.

    The shipped `build_prompt` is verified against the training rows; OOD inputs are far longer and
    contain repeated titles, i.e. exactly the shapes that would expose a normalisation difference.
    If the delivered package reproduces these prompts byte-for-byte, a failure on them is a genuine
    model result rather than an input-plumbing artefact.
    """
    sys.path.insert(0, str(HERE / "deploy"))
    import rdmd_detective as rd

    prompts = {row["id"]: row["prompt"] for row in read_jsonl(sft_path)}
    mismatches = []
    for case in read_jsonl(cases_path):
        prompt = prompts.get(case["id"])
        if prompt is None:
            continue
        if rd.build_prompt(case["G_star"], case["G_prime"]) != prompt:
            mismatches.append(case["id"])
    return mismatches


def pct(hit: int, total: int) -> str:
    return "  -  " if not total else f"{hit / total:.3f}"


def group_stats(rows: list[dict], verdicts: dict[str, dict]) -> dict:
    stats = {
        "n": len(rows),
        "drift_n": 0,
        "base_node": 0, "model_node": 0,
        "base_type": 0, "model_type": 0,
        "base_status": 0, "model_status": 0,
        "abstain_n": 0, "base_abstain": 0, "model_abstain": 0,
        "invalid": 0, "errors": [],
    }
    for row in rows:
        status = row["status"]
        base = row["baseline"]

        if status == "drift":
            stats["drift_n"] += 1
            stats["base_node"] += 1 if base["status"] == "drift" and base["nodeId"] == row["injected_node"] else 0
            stats["base_type"] += 1 if base["type"] == row["injected_type"] and row["injected_type"] else 0
        elif status == "UNKNOWN":
            stats["abstain_n"] += 1
            stats["base_abstain"] += 1 if base["status"] == "UNKNOWN" else 0
        stats["base_status"] += 1 if base["status"] == status else 0

        if not verdicts:
            continue
        entry = verdicts.get(row["id"])
        if entry is None:
            stats["invalid"] += 1
            stats["errors"].append(f"{row['id']}:missing_verdict")
            continue
        verdict = entry.get("verdict") or {}
        if not entry.get("valid"):
            stats["invalid"] += 1
            stats["errors"].append(f"{row['id']}:{','.join(entry.get('warnings') or [])}")
        if verdict.get("status") == status:
            stats["model_status"] += 1
        if status == "drift" and verdict.get("status") == "drift":
            stats["model_node"] += 1 if verdict.get("nodeId") == row["injected_node"] else 0
            stats["model_type"] += 1 if verdict.get("type") == row["injected_type"] else 0
        if status == "UNKNOWN" and verdict.get("status") == "UNKNOWN":
            stats["model_abstain"] += 1
    return stats


def render(title: str, groups: dict[str, list[dict]], verdicts: dict[str, dict], order=None) -> None:
    print(f"\n== {title} ==")
    header = (f"{'group':<24}{'n':>4}{'b_node':>8}{'m_node':>8}{'b_type':>8}{'m_type':>8}"
              f"{'b_stat':>8}{'m_stat':>8}{'b_abs':>8}{'m_abs':>8}{'bad':>5}")
    print(header)
    print("-" * len(header))
    keys = order or sorted(groups, key=lambda key: (len(key), key))
    for key in keys:
        rows = groups.get(key)
        if not rows:
            continue
        stats = group_stats(rows, verdicts)
        print(f"{key:<24}{stats['n']:>4}"
              f"{pct(stats['base_node'], stats['drift_n']):>8}{pct(stats['model_node'], stats['drift_n']):>8}"
              f"{pct(stats['base_type'], stats['drift_n']):>8}{pct(stats['model_type'], stats['drift_n']):>8}"
              f"{pct(stats['base_status'], stats['n']):>8}{pct(stats['model_status'], stats['n']):>8}"
              f"{pct(stats['base_abstain'], stats['abstain_n']):>8}"
              f"{pct(stats['model_abstain'], stats['abstain_n']):>8}{stats['invalid']:>5}")
    all_rows = [row for rows in groups.values() for row in rows]
    stats = group_stats(all_rows, verdicts)
    print("-" * len(header))
    print(f"{'ALL':<24}{stats['n']:>4}"
          f"{pct(stats['base_node'], stats['drift_n']):>8}{pct(stats['model_node'], stats['drift_n']):>8}"
          f"{pct(stats['base_type'], stats['drift_n']):>8}{pct(stats['model_type'], stats['drift_n']):>8}"
          f"{pct(stats['base_status'], stats['n']):>8}{pct(stats['model_status'], stats['n']):>8}"
          f"{pct(stats['base_abstain'], stats['abstain_n']):>8}"
          f"{pct(stats['model_abstain'], stats['abstain_n']):>8}{stats['invalid']:>5}")
    print("b_ = rule E baseline (v3: node 1.000 / type 0.527) | m_ = model")
    print("node/type over drift rows only; abs = UNKNOWN abstention; bad = invalid verdicts")
    if stats["errors"]:
        for line in stats["errors"][:5]:
            print(f"  ! {line}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verdicts", default="", help="JSONL from predict.py")
    parser.add_argument("--json-out", default="", help="write the summary as JSON")
    # The adversarial probe uses the same baseline and the same scoring, so it reuses this script
    # rather than growing a second copy of rules A-E.
    parser.add_argument("--labels", default=str(LABELS))
    parser.add_argument("--cases", default=str(CASES))
    parser.add_argument("--sft", default=str(SFT))
    args = parser.parse_args()

    labels_path, cases_path, sft_path = Path(args.labels), Path(args.cases), Path(args.sft)

    baseline_module = load_baseline_module()
    labels = {row["id"]: row for row in json.loads(labels_path.read_text(encoding="utf-8"))}
    sft = {row["id"]: row for row in read_jsonl(sft_path)}

    rows = []
    for row_id, label in labels.items():
        sft_row = sft.get(row_id)
        if sft_row is None:
            print(f"[error] no sft row for {row_id}", file=sys.stderr)
            return 2
        rows.append({**label, "baseline": baseline_verdict(baseline_module, sft_row)})

    verdicts = {}
    if args.verdicts:
        for row in read_jsonl(Path(args.verdicts)):
            verdicts[row["id"]] = row
        print(f"loaded {len(verdicts)} verdicts")

    mismatches = check_prompt_contract(sft_path, cases_path)
    print(f"prompt byte-exact vs delivered package: "
          f"{'checked, 0 mismatches' if not mismatches else 'MISMATCH ' + str(mismatches[:3])}")

    has_contract_split = any("inContract" in row for row in rows)
    if has_contract_split:
        in_contract = [row for row in rows if row["inContract"]]
        print(f"rows: {len(rows)} total, {len(in_contract)} in-contract, "
              f"{len(rows) - len(in_contract)} out-of-contract")
    else:
        print(f"rows: {len(rows)} total")

    by_scale: dict[str, list[dict]] = {}
    by_kind: dict[str, list[dict]] = {}
    by_difficulty: dict[str, list[dict]] = {}
    for row in rows:
        by_scale.setdefault(str(row["scale"]), []).append(row)
        by_kind.setdefault(row["kind"], []).append(row)
        if row["status"] != "drift":
            difficulty = row["status"]
        elif row.get("derivedOnly"):
            difficulty = "drift: derived-only"
        else:
            difficulty = "drift: cause field"
        by_difficulty.setdefault(difficulty, []).append(row)

    render("by scale (nodes in G_star)", by_scale, verdicts)
    render("by kind", by_kind, verdicts)
    render("by difficulty (what is visible on the culprit)", by_difficulty, verdicts,
           order=["drift: cause field", "drift: derived-only", "no_drift", "UNKNOWN"])
    if has_contract_split:
        render("in-contract only (legal task instances)",
               {"in-contract": [row for row in rows if row["inContract"]]}, verdicts)
        render("out-of-contract probes (schema violation)",
               {"out": [row for row in rows if not row["inContract"]]}, verdicts)

    if args.json_out:
        Path(args.json_out).write_text(json.dumps({
            "byScale": {key: group_stats(value, verdicts) for key, value in by_scale.items()},
            "byKind": {key: group_stats(value, verdicts) for key, value in by_kind.items()},
            "byDifficulty": {key: group_stats(value, verdicts) for key, value in by_difficulty.items()},
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
