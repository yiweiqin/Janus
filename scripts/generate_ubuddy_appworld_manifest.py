#!/usr/bin/env python3
"""Create an auditable AppWorld task split for the uBuddy experiments."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


DEFAULT_IDS = [
    "6f4b9a5_1", "042a9fc_1", "652485c_1", "b9c5c9a_3",
    "f323bae_1", "f861c32_1", "d18139b_1", "90adc3f_1",
    "bde252e_1", "8ce6779_1", "32616b5_1", "986aa4e_1",
]


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="D:/Cli-anything/benchmarks/appworld-runtime")
    parser.add_argument("--output", default="D:/Cli-anything/Janus/experiments/ubuddy_appworld/appworld_tasks.manifest.json")
    args = parser.parse_args()
    root = Path(args.root)
    rows = []
    for task_id in DEFAULT_IDS:
        task_root = root / "data" / "tasks" / task_id
        specs = read_json(task_root / "specs.json")
        metadata = read_json(task_root / "ground_truth" / "metadata.json")
        row = {
            "taskId": task_id,
            "split": "test_normal",
            "instruction": specs["instruction"],
            "datetime": specs.get("datetime"),
            "difficulty": metadata.get("difficulty"),
            "numApps": metadata.get("num_apps"),
            "numApis": metadata.get("num_apis"),
            "numApiCalls": metadata.get("num_api_calls"),
            "numSolutionCodeLines": metadata.get("num_solution_code_lines"),
            "taskFamily": task_id.split("_")[0],
            "selectionReason": "difficulty>=3, numApps>=2, numApiCalls>=30, numApis>=8, fixed before model execution",
        }
        if not (row["difficulty"] >= 3 and row["numApps"] >= 2 and row["numApiCalls"] >= 30 and row["numApis"] >= 8):
            raise SystemExit(f"task does not satisfy selection rule: {task_id}")
        rows.append(row)
    output = {
        "benchmark": "uBuddy-AppWorld-Hybrid",
        "version": "v1",
        "baseBenchmark": "AppWorld",
        "basePaper": "AppWorld ACL 2024 Best Resource Paper",
        "marbleProtocolReference": "MultiAgentBench/MARBLE ACL 2025 Main",
        "attributionReference": "Who&When ICML 2025 Spotlight",
        "officialEvaluatorRequired": True,
        "approvalRequired": False,
        "selectionRule": {
            "split": "test_normal",
            "difficultyMin": 3,
            "numAppsMin": 2,
            "numApiCallsMin": 30,
            "numApisMin": 8,
            "modelResultBasedFiltering": False,
        },
        "taskCount": len(rows),
        "tasks": rows,
    }
    payload = json.dumps(output, ensure_ascii=False, indent=2).encode()
    output["manifestSha256"] = hashlib.sha256(payload).hexdigest()
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(out), "taskCount": len(rows), "manifestSha256": output["manifestSha256"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

