#!/usr/bin/env python3
"""JSONL bridge around the official AppWorld environment.

The bridge deliberately exposes only the task instruction, public metadata,
execution output and official evaluator report. Ground-truth solution files are
never returned to the Node runner or written to experiment artifacts.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import traceback
from typing import Any

# Windows terminals commonly default to GBK. The JSONL protocol must stay
# UTF-8 because AppWorld tool output can contain bullets and other Unicode.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def _quiet_import():
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        from appworld import AppWorld  # type: ignore
    return AppWorld


class Bridge:
    def __init__(self) -> None:
        self.world: Any = None
        self.task_id: str | None = None
        self.AppWorld = _quiet_import()

    def reset(self, task_id: str, experiment_name: str) -> dict[str, Any]:
        self.close()
        self.task_id = task_id
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.world = self.AppWorld(task_id=task_id, experiment_name=experiment_name)
        return {
            "taskId": task_id,
            "instruction": self.world.task.instruction,
            "datetime": str(getattr(self.world.task, "datetime", "")),
            "status": "ready",
        }

    def execute(self, code: str, role: str) -> dict[str, Any]:
        if self.world is None:
            raise RuntimeError("bridge_not_reset")
        output = self.world.execute(code)
        return {"taskId": self.task_id, "role": role, "output": output, "status": "executed"}

    def evaluate(self) -> dict[str, Any]:
        if self.world is None:
            raise RuntimeError("bridge_not_reset")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            tracker = self.world.evaluate(suppress_errors=True)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            report = tracker.report()
        return {
            "taskId": self.task_id,
            "success": bool(tracker.success),
            "passCount": tracker.pass_count,
            "failCount": tracker.fail_count,
            "totalCount": tracker.total_count,
            "passPercentage": tracker.pass_percentage,
            "report": report,
            "evaluatorVersion": "appworld-official",
        }

    def close(self) -> None:
        if self.world is not None:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.world.close()
        self.world = None
        self.task_id = None


def main() -> None:
    bridge = Bridge()
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        command = request.get("command")
        try:
            if command == "reset":
                result = bridge.reset(str(request["taskId"]), str(request.get("experimentName", "ubuddy-appworld")))
            elif command == "execute":
                result = bridge.execute(str(request["code"]), str(request.get("role", "requester")))
            elif command == "evaluate":
                result = bridge.evaluate()
            elif command == "close":
                bridge.close()
                result = {"status": "closed"}
            else:
                raise ValueError(f"unknown_command:{command}")
            print(json.dumps({"ok": True, "result": result}, ensure_ascii=False), flush=True)
        except Exception as exc:  # keep JSONL protocol alive for the next episode
            print(json.dumps({"ok": False, "error": str(exc), "traceback": traceback.format_exc(limit=3)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
