"""Create the fixed, auditable uBuddy-WWW WebArena-Verified task manifest.

The selection is deliberately independent of model results.  It favours long,
multi-site workflows for the WWW study and keeps four deterministic retrieval
tasks as a non-mutation control.  The source dataset and its revision are
recorded in the output so a teammate can reproduce the exact split.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


DEFAULT_DATASET = Path(r"D:\Cli-anything\benchmarks\webarena-verified\assets\dataset\webarena-verified.json")
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "experiments" / "ubuddy_www" / "webarena_verified_tasks.manifest.json"

# 8 long cross-site mutation tasks + 4 deterministic retrieval controls.
SELECTED_TASK_IDS = [552, 553, 554, 555, 562, 563, 564, 565, 108, 109, 110, 111]


def evaluator_names(task: dict[str, Any]) -> list[str]:
    return [str(item.get("evaluator", "")) for item in task.get("eval", [])]


def task_type(task: dict[str, Any]) -> str:
    for item in task.get("eval", []):
        expected = item.get("expected", {})
        if item.get("evaluator") == "AgentResponseEvaluator":
            return str(expected.get("task_type", "unknown"))
    return "mutate" if "NetworkEventEvaluator" in evaluator_names(task) else "unknown"


def task_length_proxy(task: dict[str, Any]) -> dict[str, int | bool]:
    intent = str(task.get("intent", ""))
    sites = task.get("sites", [])
    return {
        "intentWordCount": len(intent.split()),
        "siteCount": len(sites),
        "evaluatorCount": len(task.get("eval", [])),
        "multiSite": len(sites) > 1,
        "longHorizonCandidate": len(sites) > 1 and len(intent.split()) >= 35,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    dataset_bytes = args.dataset.read_bytes()
    dataset = json.loads(dataset_bytes)
    by_id = {int(item["task_id"]): item for item in dataset}
    missing = [task_id for task_id in SELECTED_TASK_IDS if task_id not in by_id]
    if missing:
        raise SystemExit(f"selected task IDs missing from dataset: {missing}")

    tasks = []
    for task_id in SELECTED_TASK_IDS:
        source = by_id[task_id]
        length = task_length_proxy(source)
        tasks.append(
            {
                "taskId": task_id,
                "officialTaskId": task_id,
                "taskClass": f"WebArenaVerifiedTask:{task_id}",
                "category": "multi_site_mutation" if len(source.get("sites", [])) > 1 else "retrieval_control",
                "sites": source.get("sites", []),
                "intent": source.get("intent", ""),
                "intentTemplateId": source.get("intent_template_id"),
                "revision": source.get("revision"),
                "startUrls": source.get("start_urls", []),
                "taskType": task_type(source),
                "evaluators": evaluator_names(source),
                "lengthProxy": length,
                "runtimeTier": "small-sites" if set(source.get("sites", [])) <= {"gitlab", "reddit", "shopping_admin", "shopping"} else "data-sites",
                "condition": "controlled" if len(tasks) < 6 else "natural",
            }
        )

    manifest = {
        "manifestVersion": "ubuddy_webarena_verified_task_manifest_v1",
        "benchmark": "WebArena-Verified",
        "benchmarkVersion": "webarena_verified_local_dataset_v1",
        "datasetPath": str(args.dataset.resolve()),
        "datasetSha256": hashlib.sha256(dataset_bytes).hexdigest(),
        "datasetTaskCount": len(dataset),
        "officialEvaluatorRequired": True,
        "selectionRule": {
            "fixedTaskIds": SELECTED_TASK_IDS,
            "noModelResultBasedFiltering": True,
            "longHorizon": "multi-site intent with >=35 words and deterministic official evaluator",
            "multiSiteMutationCount": 8,
            "retrievalControlCount": 4,
            "excludedInitially": ["map", "wikipedia-only", "tasks requiring external data initialization"],
        },
        "executionNotes": {
            "realBrowserRequired": True,
            "evaluatorOnlyCanRunWithoutDocker": True,
            "dockerSites": sorted({site for task in tasks for site in task["sites"]}),
            "noGatedApproval": True,
        },
        "tasks": tasks,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output.resolve()), "taskCount": len(tasks), "datasetSha256": manifest["datasetSha256"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
