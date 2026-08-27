"""Real WebArena bridge smoke test against Shopping Admin task 111.

It intentionally submits a wrong response and asserts that the official
evaluator returns score 0. This validates browser/session/trace/evaluator
plumbing without producing a performance result.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYTHON = Path(r"D:\Cli-anything\benchmarks\webarena-verified\.venv\Scripts\python.exe")
BRIDGE = ROOT / "experiments" / "ubuddy_www" / "browsergym_bridge.py"
RUN_DIR = ROOT / "experiments" / "runs" / "webarena-real-bridge-smoke"


def main() -> int:
    requests = [
        {"requestId": "1", "command": "reset", "episodeId": "real-bridge-smoke-111", "officialTaskId": "111", "seed": 20260821, "benchmark": "ubuddy_webarena_verified_v1"},
        {"requestId": "2", "command": "create_session", "sessionId": "requester", "actorUbuddyId": "requester", "role": "requester"},
        {"requestId": "3", "command": "observe", "sessionId": "requester"},
        {"requestId": "4", "command": "act", "sessionId": "requester", "action": {"kind": "wait", "ms": 10}},
        {"requestId": "5", "command": "evaluate", "officialTaskId": "111", "agentResponse": {"task_type": "retrieve", "status": "SUCCESS", "retrieved_data": ["wrong"]}},
        {"requestId": "6", "command": "close"},
    ]
    env = {**os.environ, "UBUDDY_WWW_BRIDGE_MODE": "real", "UBUDDY_WWW_BENCHMARK": "webarena_verified", "UBUDDY_WWW_CHROMIUM_EXECUTABLE": os.getenv("UBUDDY_WWW_CHROMIUM_EXECUTABLE", r"C:\Program Files\Google\Chrome\Application\chrome.exe")}
    completed = subprocess.run([str(PYTHON), str(BRIDGE)], input="\n".join(json.dumps(item) for item in requests) + "\n", text=True, encoding="utf-8", errors="replace", capture_output=True, env=env, check=False)
    responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    evaluation = next((item.get("evaluation") for item in responses if item.get("requestId") == "5"), None)
    result = {"benchmark": "WebArena-Verified", "taskId": 111, "bridgeExitCode": completed.returncode, "resetOk": bool(responses and responses[0].get("ok")), "sessionOk": any(item.get("requestId") == "2" and item.get("ok") for item in responses), "observeOk": any(item.get("requestId") == "3" and item.get("ok") for item in responses), "wrongResponseOfficiallyRejected": bool(evaluation and evaluation.get("score") == 0.0 and evaluation.get("evaluatorVersion", "").startswith("webarena-verified:")), "evaluation": evaluation}
    result["allChecksPassed"] = all(result[key] for key in ["resetOk", "sessionOk", "observeOk", "wrongResponseOfficiallyRejected"])
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    (RUN_DIR / "real_bridge_smoke.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["allChecksPassed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
