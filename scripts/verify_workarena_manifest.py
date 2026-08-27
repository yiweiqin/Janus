#!/usr/bin/env python3
"""Verify the selected WorkArena++ classes against an official instance.

This is intentionally separate from the uBuddy runner. It runs the official
oracle and ``validate`` only, records action/subtask metadata, and updates no
benchmark task code. It must not be run without an approved ServiceNow
instance.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path


ACTIVE_TRACE = None


def install_action_counter():
    from playwright.sync_api import ElementHandle, Frame, Keyboard, Locator, Page

    for interface in (Page, Frame, Locator, Keyboard, ElementHandle):
        for action in ("click", "select_option", "set_checked", "fill", "press", "type", "down", "up"):
            original = getattr(interface, action, None)
            if original is None or getattr(original, "_ubuddy_wrapped", False):
                continue

            def wrapped(*args, __original=original, __action=action, **kwargs):
                if ACTIVE_TRACE is not None:
                    ACTIVE_TRACE.append({"action": __action, "occurredAt": time.time()})
                return __original(*args, **kwargs)

            wrapped._ubuddy_wrapped = True
            setattr(interface, action, wrapped)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default="D:/Cli-anything/Janus/experiments/ubuddy_www/tasks.manifest.json")
    parser.add_argument("--output", default="D:/Cli-anything/Janus/experiments/ubuddy_www/workarena_manifest_verification.json")
    parser.add_argument("--seed", type=int, default=20260821)
    args = parser.parse_args()

    explicit_instance = all(os.environ.get(name) for name in ("SNOW_INSTANCE_URL", "SNOW_INSTANCE_UNAME", "SNOW_INSTANCE_PWD"))
    custom_pool = bool(os.environ.get("SNOW_INSTANCE_POOL"))
    hf_access = bool(os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN"))
    if not (explicit_instance or custom_pool or hf_access):
        raise SystemExit("WorkArena instance access is required: use approved Hugging Face login/token, SNOW_INSTANCE_POOL, or explicit SNOW_INSTANCE_* credentials")

    source = Path(os.environ.get("WORKARENA_ROOT", "D:/Cli-anything/benchmarks/workarena"))
    sys.path.insert(0, str(source / "src"))
    install_action_counter()
    from browsergym.core.env import BrowserEnv  # type: ignore
    from browsergym.workarena import ALL_WORKARENA_TASKS  # type: ignore

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    task_map = {task.get_task_id(): task for task in ALL_WORKARENA_TASKS}
    executable = os.environ.get("UBUDDY_WWW_CHROMIUM_EXECUTABLE", "")
    launch = {"executable_path": executable} if executable else {}
    results = []
    for entry in manifest["tasks"]:
        task_id = entry["officialTaskId"]
        task_cls = task_map[task_id]
        env = BrowserEnv(task_entrypoint=task_cls, headless=True, pw_chromium_kwargs=launch)
        action_count = 0
        trace = []
        try:
            global ACTIVE_TRACE
            ACTIVE_TRACE = trace
            env.reset(seed=args.seed)
            subtask_count = len(env.task)
            oracle_rewards = []
            if hasattr(env.task, "subtasks"):
                for index in range(subtask_count):
                    env.task.cheat(env.page, env.chat.messages, index)
                    reward, done, message, info = env.task.validate(env.page, env.chat.messages)
                    oracle_rewards.append(float(reward))
            else:
                env.task.cheat(env.page, env.chat.messages)
                reward, done, message, info = env.task.validate(env.page, env.chat.messages)
                oracle_rewards.append(float(reward))
            action_count = len(trace)
            success = bool(oracle_rewards and oracle_rewards[-1] >= 1.0)
            checks = {
                "subtaskCount": subtask_count,
                "oracleActionCount": action_count,
                "dependencyEdgeCount": max(0, subtask_count - 1),
                "dependencyEvidence": "official_compositional_subtask_order",
                "intermediateCheckpoint": subtask_count >= 3,
                "deterministicEvaluator": success,
                "oracleRewards": oracle_rewards,
                "finalDone": bool(done),
                "evaluatorMessage": str(message),
            }
            status = "verified" if all((subtask_count >= 3, action_count >= 10, checks["dependencyEdgeCount"] >= 1, checks["intermediateCheckpoint"], success)) else "fails_selection_rule"
            results.append({"officialTaskId": task_id, "taskClass": task_cls.__name__, "status": status, "runtimeChecks": checks})
        except Exception as exc:
            results.append({"officialTaskId": task_id, "taskClass": task_cls.__name__, "status": "error", "error": {"type": type(exc).__name__, "message": str(exc)}})
        finally:
            ACTIVE_TRACE = None
            env.close()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = {"benchmark": "WorkArena++", "seed": args.seed, "sourceRevision": "a772230", "results": results, "allVerified": bool(results) and all(item["status"] == "verified" for item in results)}
    output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0 if payload["allVerified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
