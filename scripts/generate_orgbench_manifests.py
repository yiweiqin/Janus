#!/usr/bin/env python3
"""Generate auditable OrgBench manifests without using model outcomes for selection."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def appworld_rows(root: Path) -> tuple[list[dict], list[dict]]:
    dataset_file = root / "data" / "datasets" / "test_normal.txt"
    rows = []
    boundary = []
    for task_id in dataset_file.read_text(encoding="utf-8").splitlines():
        task_root = root / "data" / "tasks" / task_id
        specs_path = task_root / "specs.json"
        metadata_path = task_root / "ground_truth" / "metadata.json"
        if not specs_path.exists() or not metadata_path.exists():
            continue
        specs = read_json(specs_path)
        metadata = read_json(metadata_path)
        if metadata.get("difficulty", 0) < 3 or metadata.get("num_apps", 0) < 2:
            continue
        strict = metadata.get("num_api_calls", 0) >= 30 and metadata.get("num_apis", 0) >= 8
        boundary_ok = metadata.get("num_api_calls", 0) >= 25 and metadata.get("num_apis", 0) >= 7
        if not strict and not boundary_ok:
            continue
        instruction = specs["instruction"]
        lower = instruction.lower()
        if any(word in lower for word in ("message", "phone", "comment", "reply")):
            category = "communication"
        elif any(word in lower for word in ("csv", "export", "spreadsheet", "report", "json")):
            category = "data_transform"
        elif any(word in lower for word in ("update", "delete", "create", "send", "approve", "reassign")):
            category = "state_mutation"
        elif any(word in lower for word in ("find", "read", "look", "information")):
            category = "retrieval"
        else:
            category = "mixed"
        row = {
            "taskId": task_id,
            "split": "test_normal",
            "instruction": instruction,
            "datetime": specs.get("datetime"),
            "difficulty": metadata.get("difficulty"),
            "numApps": metadata.get("num_apps"),
            "numApis": metadata.get("num_apis"),
            "numApiCalls": metadata.get("num_api_calls"),
            "taskFamily": task_id.rsplit("_", 1)[0],
            "category": category,
            "selectionTier": "strict" if strict else "boundary",
            "selectionReason": "difficulty>=3, num_apps>=2, num_api_calls>=30, num_apis>=8" if strict else "boundary supplement: difficulty>=3, num_apps>=2, num_api_calls>=25, num_apis>=7",
        }
        (rows if strict else boundary).append(row)
    rows.sort(key=lambda row: row["taskId"])
    by_category = {}
    for row in rows:
        by_category.setdefault(row["category"], []).append(row)
    selected = []
    for category in ("communication", "data_transform", "state_mutation", "retrieval", "mixed"):
        selected.extend(by_category.get(category, [])[:8])
    if len(selected) < 40:
        already = {row["taskId"] for row in selected}
        selected.extend(row for row in rows if row["taskId"] not in already)  # deterministic backfill
    boundary.sort(key=lambda row: row["taskId"])
    return selected[:40], boundary[:3]


def the_agent_company_manifest() -> dict:
    # These are public task image names from the official 175-task release.
    # Checkpoint counts are filled by the local audit step once the repository/images are present.
    groups = {
        "pm": ["pm-ask-for-issue-and-create-in-gitlab-image", "pm-assign-issues-image", "pm-update-gitlab-issue-from-plane-status-image", "pm-update-plane-issue-from-gitlab-status-image"],
        "data_research": ["ds-answer-spreadsheet-questions-image", "ds-calculate-spreadsheet-stats-image", "ds-merge-multiple-sheets-image", "ds-organise-report-sus-data-image"],
        "sde": ["sde-check-and-run-unit-test-image", "sde-find-answer-in-codebase-1-image", "sde-fix-factual-mistake-image", "sde-write-a-unit-test-for-append_file-function-image"],
        "hr_admin": ["hr-collect-feedbacks-image", "hr-create-career-ladder-image", "hr-organize-talent-info-image", "admin-read-survey-and-summarise-image"],
        "finance": ["finance-budget-variance-image", "finance-expense-validation-image", "finance-invoice-matching-image", "finance-revenue-reconciliation-image"],
        "qa_ops": ["qa-escalate-emergency-image", "qa-update-issue-status-according-to-colleagues-image", "admin-make-spreadsheet-image", "pm-update-project-milestones-image"],
    }
    tasks = [{"taskId": task_id, "roleFamily": family, "officialImage": f"ghcr.io/theagentcompany/{task_id}:1.0.0", "checkpointAuditRequired": True} for family, task_ids in groups.items() for task_id in task_ids]
    return {"benchmark": "TheAgentCompany", "version": "1.0.0", "approvalRequired": False, "taskCount": len(tasks), "tasks": tasks, "selectionRule": "six role families x four public tasks; retain only tasks with >=3 checkpoints and >=1 deterministic checkpoint after local audit"}


def write_manifest(payload: dict, output: Path) -> None:
    canonical = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    payload["manifestSha256"] = hashlib.sha256(canonical).hexdigest()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    janus_root = Path(os.environ.get("JANUS_ROOT", Path(__file__).resolve().parents[1]))
    benchmark_root = Path(os.environ.get("BENCHMARK_ROOT", janus_root / "benchmarks"))
    parser = argparse.ArgumentParser()
    parser.add_argument("--appworld-root", default=os.environ.get("APPWORLD_ROOT", benchmark_root / "appworld-runtime"))
    parser.add_argument("--output-dir", default=os.environ.get("ORGBENCH_ROOT", janus_root / "experiments" / "ubuddy_orgbench"))
    args = parser.parse_args()
    output_dir = Path(args.output_dir)
    app_rows, boundary_rows = appworld_rows(Path(args.appworld_root))
    write_manifest({"benchmark": "ubuddy_orgbench_v2", "name": "uBuddy-AppWorld Hybrid Benchmark", "version": "v2", "baseBenchmark": "AppWorld", "officialEvaluatorRequired": True, "approvalRequired": False, "strictTaskCount": len(app_rows), "boundaryTaskCount": len(boundary_rows), "taskCount": len(app_rows) + len(boundary_rows), "tasks": app_rows, "boundarySupplement": boundary_rows, "selectionRule": {"split": "test_normal", "difficultyMin": 3, "numAppsMin": 2, "numApiCallsMin": 30, "numApisMin": 8, "modelResultBasedFiltering": False, "boundaryTasksExcludedFromStrictMainTable": True}}, output_dir / "appworld_orgbench_tasks.manifest.json")
    write_manifest(the_agent_company_manifest(), output_dir / "theagentcompany_tasks.manifest.json")
    print(json.dumps({"appworldStrictTaskCount": len(app_rows), "appworldBoundaryTaskCount": len(boundary_rows), "theAgentCompanyTaskCount": 24, "outputDir": str(output_dir)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
