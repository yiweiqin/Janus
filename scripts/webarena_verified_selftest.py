"""Official evaluator parity self-test: one expected pass and one expected fail."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BENCHMARK = Path(r"D:\Cli-anything\benchmarks\webarena-verified")
PYTHON = BENCHMARK / ".venv" / "Scripts" / "python.exe"
HAR = BENCHMARK / "tests" / "assets" / "network.har"


def run(response: dict) -> dict:
    request = {
        "taskId": 0,
        "agentResponse": response,
        "networkTraceFile": str(HAR),
    }
    completed = subprocess.run(
        [str(PYTHON), str(ROOT / "scripts" / "webarena_verified_evaluator.py")],
        input=json.dumps(request) + "\n",
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=True,
    )
    return json.loads(completed.stdout.strip().splitlines()[-1])


def main() -> int:
    passed = run({"task_type": "retrieve", "status": "SUCCESS", "retrieved_data": ["Quest Lumaflex™ Band"]})
    failed = run({"task_type": "retrieve", "status": "SUCCESS", "retrieved_data": ["wrong answer"]})
    result = {
        "benchmark": "WebArena-Verified",
        "taskId": 0,
        "expectedPass": passed["officialSuccess"] is True and passed["score"] == 1.0,
        "expectedFail": failed["officialSuccess"] is False and failed["score"] == 0.0,
        "passResult": passed,
        "failResult": failed,
    }
    result["allChecksPassed"] = result["expectedPass"] and result["expectedFail"]
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["allChecksPassed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
