#!/usr/bin/env python3
"""Emit the fixed, auditable WorkArena++ task manifest used by uBuddy-WWW.

This script imports the official WorkArena task registry but never instantiates a
task. Instantiation requires a gated ServiceNow instance, so instance-dependent
checks (oracle action count, dependency validation and evaluator parity) remain
explicitly marked as pending until the official instance is configured.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


SELECTION = {
    "minSubtasks": 3,
    "minOracleActions": 10,
    "minDependencyEdges": 1,
    "requiresIntermediateCheckpoint": True,
    "requiresDeterministicEvaluator": True,
}

SELECTION_PLAN = [
    ("planning_and_problem_solving", "WorkloadBalancingSmallTaskL2", "controlled"),
    ("planning_and_problem_solving", "WorkAssignmentSmallTaskL2", "controlled"),
    ("planning_and_problem_solving", "BasicFilterProblemsAndMarkDuplicatesSmallTaskL2", "controlled"),
    ("information_retrieval", "GetWarrantyExpirationDateTaskL2", "controlled"),
    ("information_retrieval", "FilterRequestedItemsAndOrderDeveloperLaptopTaskL2", "controlled"),
    ("information_retrieval", "DashboardRetrieveIncidentAndMinCreateIncidentTaskL2", "controlled"),
    ("data_driven_reasoning", "BasicExpenseManagementSmallTaskL2", "natural"),
    ("data_driven_reasoning", "FilterRandomExpensesAndFindTotalReturnSmallTaskL2", "natural"),
    ("data_driven_reasoning", "DashboardRetrieveCatalogAndMeanOrderDeveloperLaptopTaskL2", "natural"),
    ("sophisticated_memory", "NavigateAndCreateIncidentTaskL2", "natural"),
    ("sophisticated_memory", "OffBoardUserTaskL2", "natural"),
    ("contextual_understanding_infeasible_tasks", "InfeasibleNavigateAndCreateIncidentWithReasonTaskL2", "natural"),
]


def load_registry():
    # The source checkout is deliberately selected by environment variable so
    # the generated manifest records exactly which official source was used.
    source = Path(os.environ.get("WORKARENA_ROOT", "D:/Cli-anything/benchmarks/workarena"))
    import sys

    sys.path.insert(0, str(source / "src"))
    from browsergym.workarena import ALL_WORKARENA_TASKS  # type: ignore

    return {task.__name__: task for task in ALL_WORKARENA_TASKS}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="D:/Cli-anything/Janus/experiments/ubuddy_www/tasks.manifest.json")
    args = parser.parse_args()

    registry = load_registry()
    missing = [name for _, name, _ in SELECTION_PLAN if name not in registry]
    if missing:
        raise SystemExit(f"Selected task classes are not in the official registry: {missing}")

    tasks = []
    for category, class_name, condition in SELECTION_PLAN:
        task = registry[class_name]
        tasks.append(
            {
                "officialTaskId": task.get_task_id(),
                "category": category,
                "taskClass": class_name,
                "level": 2,
                "condition": condition,
                "status": "selected_official_class_pending_instance_parity",
                "runtimeChecks": {
                    "subtaskCount": None,
                    "oracleActionCount": None,
                    "dependencyEdgeCount": None,
                    "intermediateCheckpoint": None,
                    "deterministicEvaluator": None,
                },
            }
        )

    result = {
        "manifestVersion": "ubuddy_workarena_task_manifest_v1",
        "benchmark": "WorkArena++",
        "sourceRevision": "a772230",
        "sourceRoot": str(Path(os.environ.get("WORKARENA_ROOT", "D:/Cli-anything/benchmarks/workarena")).resolve()),
        "selectionRule": SELECTION,
        "selectionNote": "Class IDs are official; instance-dependent checks are filled only after gated ServiceNow access.",
        "tasks": tasks,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "taskCount": len(tasks), "missing": missing}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
