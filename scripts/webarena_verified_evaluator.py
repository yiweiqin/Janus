"""JSONL/CLI bridge for the public WebArena-Verified deterministic evaluator.

This bridge never starts Docker and never claims browser success.  It is useful
for validating the official dataset/evaluator path before the website containers
are available.  Real episodes must provide a browser-produced HAR or Playwright
trace and are scored by the same official library.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path(r"D:\Cli-anything\benchmarks\webarena-verified")
SOURCE = Path(os.environ.get("WEBARENA_VERIFIED_ROOT", str(DEFAULT_SOURCE))).resolve()
sys.path.insert(0, str(SOURCE / "src"))


def evaluator(dataset: Path | None = None):
    from webarena_verified.api import WebArenaVerified
    from webarena_verified.types.config import WebArenaVerifiedConfig

    kwargs = {}
    if dataset:
        kwargs["test_data_file"] = dataset.resolve()
    return WebArenaVerified(config=WebArenaVerifiedConfig(**kwargs))


def normalize(result: Any, *, task_id: int) -> dict[str, Any]:
    payload = result.model_dump(mode="json") if hasattr(result, "model_dump") else dict(result)
    return {
        "officialSuccess": payload.get("status") == "success" and float(payload.get("score", 0)) == 1.0,
        "score": float(payload.get("score", 0)),
        "status": str(payload.get("status", "error")),
        "taskId": task_id,
        "evaluatorVersion": f"webarena-verified:{payload.get('webarena_verified_version', 'local')}",
        "evaluatorChecksum": payload.get("webarena_verified_evaluator_checksum"),
        "dataChecksum": payload.get("webarena_verified_data_checksum"),
        "raw": payload,
    }


def run_one(request: dict[str, Any]) -> dict[str, Any]:
    dataset = Path(request["dataset"]).resolve() if request.get("dataset") else None
    wa = evaluator(dataset)
    task_id = int(request["taskId"])
    agent_response = request.get("agentResponse")
    if request.get("agentResponseFile"):
        agent_response = Path(request["agentResponseFile"]).resolve()
    trace: Any = request.get("networkTrace", [])
    if request.get("networkTraceFile"):
        trace = Path(request["networkTraceFile"]).resolve()
    result = wa.evaluate_task(task_id=task_id, agent_response=agent_response, network_trace=trace)
    return normalize(result, task_id=task_id)


def metadata(request: dict[str, Any]) -> dict[str, Any]:
    wa = evaluator(Path(request["dataset"]) if request.get("dataset") else None)
    task = wa.get_task(int(request["taskId"]))
    return {
        "taskId": task.task_id,
        "sites": [str(site) for site in task.sites],
        "intent": task.intent,
        "intentTemplateId": task.intent_template_id,
        "revision": task.revision,
        "evaluators": [item.evaluator for item in task.eval],
        "startUrls": task.start_urls,
        "benchmark": "WebArena-Verified",
        "officialEvaluatorRequired": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task-id", type=int)
    parser.add_argument("--agent-response")
    parser.add_argument("--agent-response-file")
    parser.add_argument("--network-trace-file")
    parser.add_argument("--dataset", type=Path)
    parser.add_argument("--metadata", action="store_true")
    args = parser.parse_args()
    if args.metadata:
        if args.task_id is None:
            raise SystemExit("--metadata requires --task-id")
        print(json.dumps(metadata({"taskId": args.task_id, "dataset": str(args.dataset) if args.dataset else None}), ensure_ascii=False))
        return 0
    if args.task_id is None:
        for line in sys.stdin:
            if line.strip():
                try:
                    print(json.dumps(run_one(json.loads(line)), ensure_ascii=False), flush=True)
                except Exception as exc:
                    print(json.dumps({"status": "error", "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False), flush=True)
        return 0
    agent_response: Any = None
    if args.agent_response:
        agent_response = json.loads(args.agent_response)
    request = {"taskId": args.task_id, "agentResponse": agent_response, "agentResponseFile": args.agent_response_file, "networkTraceFile": args.network_trace_file, "dataset": str(args.dataset) if args.dataset else None}
    print(json.dumps(run_one(request), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
