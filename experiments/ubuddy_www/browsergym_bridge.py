#!/usr/bin/env python3
"""JSONL bridge for the uBuddy-WWW experiment.

The bridge is deliberately small: the Node runner owns the episode protocol and
Janus writes, while this process owns BrowserGym/Playwright sessions.  Without
an approved ServiceNow instance it runs in deterministic mock mode, which is
useful for validating event/artifact contracts but is never a benchmark score.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any


def sha(value: Any) -> str:
    raw = value if isinstance(value, str) else json.dumps(value, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@dataclass
class Session:
    session_id: str
    actor_id: str
    role: str
    mock: bool = True
    page_url: str = "about:blank"
    actions: list[dict[str, Any]] = field(default_factory=list)
    context: Any = None
    page: Any = None
    owns_context: bool = True


class Bridge:
    def __init__(self) -> None:
        self.episode: dict[str, Any] = {}
        self.sessions: dict[str, Session] = {}
        self.mock = os.getenv("UBUDDY_WWW_BRIDGE_MODE", "mock") != "real"
        self._playwright = None
        self._browser = None
        self._env = None
        self._task_class = None
        self._webarena_task = None
        self._webarena_config = None
        self._webarena_evaluator = None
        self._trace_path: str | None = None
        self._final_response: Any = None
        self._last_observation: dict[str, Any] | None = None

    def reply(self, request_id: str, ok: bool = True, **payload: Any) -> None:
        response = {"requestId": request_id, "ok": ok, **payload}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    def handle(self, request: dict[str, Any]) -> None:
        request_id = str(request.get("requestId", ""))
        command = str(request.get("command", ""))
        try:
            result = getattr(self, f"cmd_{command}")(**request)
            self.reply(request_id, **result)
        except Exception as exc:  # bridge errors are returned, not hidden in stderr
            self.reply(request_id, False, error={"type": type(exc).__name__, "message": str(exc)})

    def cmd_reset(self, **request: Any) -> dict[str, Any]:
        self.cmd_close(**request)
        self.episode = {
            "episodeId": str(request.get("episodeId", "")),
            "officialTaskId": str(request.get("officialTaskId", "")),
            "seed": int(request.get("seed", 0)),
            "artifactDir": str(request.get("artifactDir", "")),
        }
        if not self.mock:
            benchmark = str(request.get("benchmark") or os.getenv("UBUDDY_WWW_BENCHMARK", "workarena")).lower()
            if "webarena" in benchmark:
                self._reset_webarena()
            else:
                self._reset_workarena()
        return {
            "episode": self.episode,
            "mode": "mock" if self.mock else "real",
            "officialTask": self._official_task_metadata(),
        }

    def cmd_create_session(self, **request: Any) -> dict[str, Any]:
        actor_id = str(request.get("actorUbuddyId", ""))
        if not actor_id:
            raise ValueError("actorUbuddyId is required")
        session_id = str(request.get("sessionId") or f"session:{actor_id}")
        session = Session(session_id=session_id, actor_id=actor_id, role=str(request.get("role", "recipient")), mock=self.mock)
        if not self.mock:
            if self._webarena_task is not None:
                session.context = self._browser.new_context(extra_http_headers=self._webarena_headers())
                session.page = session.context.new_page()
                self._webarena_open_start(session.page)
            else:
                if not self._env:
                    raise RuntimeError("reset must create the WorkArena environment before sessions")
                if not self.sessions and session.role == "requester":
                    session.context = self._env.context
                    session.page = self._env.page
                    session.owns_context = False
                else:
                    session.context = self._env.browser.new_context()
                    session.page = session.context.new_page()
                    self._login_shared_task_session(session.page)
        self.sessions[session_id] = session
        return {"session": {"sessionId": session_id, "actorUbuddyId": actor_id, "role": session.role, "isolated": True}}

    def cmd_observe(self, **request: Any) -> dict[str, Any]:
        session = self._session(request)
        if self.mock:
            observation = {"url": session.page_url, "stateHash": sha([self.episode, session.actor_id, len(session.actions)])[:16], "text": "mock observation"}
        else:
            text = (session.page.locator("body").inner_text() or "")[:12000]
            elements = session.page.locator("a,button,input,textarea,select,[role=button],[role=link]").evaluate_all(
                """els => els.slice(0, 200).map((el, index) => ({
                  index,
                  tag: el.tagName.toLowerCase(),
                  role: el.getAttribute('role') || '',
                  text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 200),
                  selector: el.id ? `#${CSS.escape(el.id)}` : (el.getAttribute('name') ? `${el.tagName.toLowerCase()}[name="${CSS.escape(el.getAttribute('name'))}"]` : ''),
                  disabled: !!el.disabled
                })).filter(x => x.selector)"""
            )
            observation = {"url": session.page.url, "stateHash": sha(session.page.url + (session.page.content() or ""))[:16], "text": text, "interactiveElements": elements}
        return {"observation": observation}

    def cmd_act(self, **request: Any) -> dict[str, Any]:
        session = self._session(request)
        action = dict(request.get("action") or {})
        kind = str(action.get("kind", action.get("type", "")))
        if not kind:
            raise ValueError("action.kind is required")
        if self.mock:
            if action.get("url"):
                session.page_url = str(action["url"])
        else:
            self._apply_action(session, action)
        if action.get("answer") is not None:
            self._final_response = action.get("answer")
        record = {"kind": kind, "target": str(action.get("target", "")), "url": session.page_url, "stepIndex": len(session.actions) + 1, "occurredAt": time.time()}
        session.actions.append(record)
        return {"action": record, "observation": self.cmd_observe(sessionId=session.session_id, requestId="") ["observation"]}

    def cmd_checkpoint(self, **request: Any) -> dict[str, Any]:
        session = self._session(request)
        observation = self.cmd_observe(sessionId=session.session_id, requestId="")["observation"]
        return {"checkpoint": {"sessionId": session.session_id, "actionCount": len(session.actions), **observation}}

    def cmd_evaluate(self, **request: Any) -> dict[str, Any]:
        if self.mock:
            return {"evaluation": {"officialSuccess": False, "reward": 0, "evaluatorVersion": "mock:not-a-score", "reason": "service_now_instance_unavailable"}}
        if self._webarena_task is not None:
            return self._evaluate_webarena(request)
        if not self._env or not self._env.task:
            raise RuntimeError("WorkArena environment has not been reset")
        requester = next((item for item in self.sessions.values() if item.role == "requester"), None)
        page = requester.page if requester else self._env.page
        reward, done, message, info = self._env.task.validate(
            page=page,
            chat_messages=self._env.chat.messages,
        )
        return {
            "evaluation": {
                "officialSuccess": float(reward) >= 1.0,
                "reward": float(reward),
                "done": bool(done),
                "message": message if isinstance(message, str) else str(message),
                "info": info if isinstance(info, dict) else {"value": str(info)},
                "evaluatorVersion": "workarena.validate:v0.5.3",
            }
        }

    def cmd_close(self, **_request: Any) -> dict[str, Any]:
        for session in self.sessions.values():
            if session.context is not None and session.owns_context:
                session.context.close()
        self.sessions.clear()
        if self._env is not None:
            self._env.close()
        self._env = None
        self._task_class = None
        self._webarena_task = None
        self._webarena_config = None
        self._webarena_evaluator = None
        self._trace_path = None
        self._final_response = None
        if self._playwright is not None:
            self._playwright.stop()
        self._playwright = None
        self._browser = None
        return {"closed": True}

    def _session(self, request: dict[str, Any]) -> Session:
        session_id = str(request.get("sessionId", ""))
        if session_id not in self.sessions:
            raise KeyError(f"unknown session: {session_id}")
        return self.sessions[session_id]

    def _start_browser(self) -> None:
        from playwright.sync_api import sync_playwright

        self._playwright = sync_playwright().start()
        launch: dict[str, Any] = {"headless": os.getenv("UBUDDY_WWW_HEADLESS", "1") != "0"}
        executable = os.getenv("UBUDDY_WWW_CHROMIUM_EXECUTABLE", "")
        if executable:
            launch["executable_path"] = executable
        self._browser = self._playwright.chromium.launch(**launch)

    def _webarena_root(self) -> str:
        return os.getenv("WEBARENA_VERIFIED_ROOT", r"D:\Cli-anything\benchmarks\webarena-verified")

    def _webarena_urls(self) -> dict[str, str]:
        return {
            "gitlab": os.getenv("WEBARENA_GITLAB_URL", "http://127.0.0.1:8023"),
            "reddit": os.getenv("WEBARENA_REDDIT_URL", "http://127.0.0.1:9999"),
            "shopping_admin": os.getenv("WEBARENA_SHOPPING_ADMIN_URL", "http://127.0.0.1:7780/admin"),
            "shopping": os.getenv("WEBARENA_SHOPPING_URL", "http://127.0.0.1:7770"),
            "wikipedia": os.getenv("WEBARENA_WIKIPEDIA_URL", "http://127.0.0.1:8888"),
            "map": os.getenv("WEBARENA_MAP_URL", "http://127.0.0.1:3030"),
        }

    def _reset_webarena(self) -> None:
        from webarena_verified.api import WebArenaVerified
        from webarena_verified.types.config import EnvironmentConfig, WebArenaVerifiedConfig

        source = self._webarena_root()
        dataset = os.path.join(source, "assets", "dataset", "webarena-verified.json")
        self._webarena_task = WebArenaVerified(config=WebArenaVerifiedConfig(test_data_file=dataset)).get_task(int(self.episode["officialTaskId"]))
        urls = self._webarena_urls()
        environments = {site: EnvironmentConfig(urls=[urls[site.value]]) for site in self._webarena_task.sites}
        self._webarena_config = WebArenaVerifiedConfig(test_data_file=dataset, environments=environments)
        self._webarena_evaluator = WebArenaVerified(config=self._webarena_config)
        self._initialize_webarena_sites()
        self._start_browser()
        self._trace_path = os.path.join(tempfile.gettempdir(), f"ubuddy-www-{self.episode['episodeId'].replace(':', '-')}.zip")

    def _webarena_headers(self) -> dict[str, str]:
        return {
            "X-M2-Admin-Auto-Login": os.getenv("WEBARENA_SHOPPING_ADMIN_CREDENTIALS", "admin:admin1234"),
            "X-Postmill-Auto-Login": os.getenv("WEBARENA_REDDIT_CREDENTIALS", "MarvelsGrantMan136:test1234"),
        }

    def _initialize_webarena_sites(self) -> None:
        controls = {
            "shopping_admin": os.getenv("WEBARENA_SHOPPING_ADMIN_CONTROL_URL", "http://127.0.0.1:7781"),
            "reddit": os.getenv("WEBARENA_REDDIT_CONTROL_URL", "http://127.0.0.1:9998"),
            "gitlab": os.getenv("WEBARENA_GITLAB_CONTROL_URL", "http://127.0.0.1:8024"),
        }
        for site in self._webarena_task.sites:
            base = controls.get(site.value)
            if not base:
                continue
            request = urllib.request.Request(f"{base}/init", method="POST", headers={"Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=600) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if not payload.get("success"):
                raise RuntimeError(f"failed to initialize WebArena site {site.value}: {payload.get('message', '')}")

    def _webarena_open_start(self, page: Any) -> None:
        if not self._webarena_task:
            return
        self._browser_context_start_trace(page.context)
        for index, start_url in enumerate(self._webarena_task.start_urls):
            target = page if index == 0 else page.context.new_page()
            target.goto(self._render_url(start_url))

    def _render_url(self, template: str) -> str:
        value = str(template)
        for site, url in self._webarena_urls().items():
            value = value.replace(f"__{site.upper()}__", url)
        return value

    def _browser_context_start_trace(self, context: Any) -> None:
        try:
            context.tracing.start(snapshots=True, screenshots=False)
        except Exception:
            pass

    def _evaluate_webarena(self, request: dict[str, Any]) -> dict[str, Any]:
        requester = next((item for item in self.sessions.values() if item.role == "requester"), None)
        if requester is None or requester.context is None:
            raise RuntimeError("requester WebArena session is required before evaluation")
        from webarena_verified.types.tracing import NetworkTrace

        traces = []
        trace_errors = []
        for index, session in enumerate(self.sessions.values()):
            if session.context is None:
                continue
            artifact_dir = self.episode.get("artifactDir") or tempfile.gettempdir()
            os.makedirs(artifact_dir, exist_ok=True)
            trace_path = os.path.join(artifact_dir, f"session-{index}.zip")
            try:
                session.context.tracing.stop(path=trace_path)
                traces.append(NetworkTrace.from_content(Path(trace_path)))
            except Exception as exc:
                trace_errors.append(f"{type(exc).__name__}: {exc}")
                continue
        if not traces:
            raise RuntimeError(f"no Playwright network trace was captured; errors={trace_errors}")
        combined_events = tuple(event for trace in traces for event in trace.events)
        combined_trace = NetworkTrace.model_construct(is_playwright=True, src_file=traces[0].src_file, events=combined_events)
        response = request.get("agentResponse") or self._final_response or {"task_type": self._webarena_task.expected_action, "status": "SUCCESS"}
        artifact_dir = self.episode.get("artifactDir")
        if artifact_dir:
            Path(artifact_dir, "agent_response.json").write_text(json.dumps(response, ensure_ascii=False, indent=2), encoding="utf-8")
        result = self._webarena_evaluator.evaluate_task(task_id=int(self._webarena_task.task_id), agent_response=response, network_trace=combined_trace)
        payload = result.model_dump(mode="json")
        return {"evaluation": {"officialSuccess": result.score == 1.0, "reward": result.score, "score": result.score, "status": str(result.status), "evaluatorVersion": f"webarena-verified:{payload.get('webarena_verified_version')}", "raw": payload}}

    def _reset_workarena(self) -> None:
        from browsergym.core.env import BrowserEnv
        from browsergym.workarena import ALL_WORKARENA_TASKS

        task_id = self.episode["officialTaskId"]
        task_map = {task.get_task_id(): task for task in ALL_WORKARENA_TASKS}
        if task_id not in task_map:
            raise ValueError(f"unknown official WorkArena task ID: {task_id}")
        self._task_class = task_map[task_id]
        launch_kwargs: dict[str, Any] = {}
        executable = os.getenv("UBUDDY_WWW_CHROMIUM_EXECUTABLE", "")
        if executable:
            launch_kwargs["executable_path"] = executable
        self._env = BrowserEnv(
            task_entrypoint=self._task_class,
            headless=os.getenv("UBUDDY_WWW_HEADLESS", "1") != "0",
            pw_chromium_kwargs=launch_kwargs,
        )
        self._last_observation, _ = self._env.reset(seed=self.episode["seed"])

    def _login_shared_task_session(self, page: Any) -> None:
        from browsergym.workarena.utils import url_login

        # reset() creates a task-scoped ServiceNow user. Every isolated browser
        # context logs in as that user, so cookies/history remain private while
        # all roles operate on the same task/database state.
        url_login(self._env.task.instance, page)
        page.goto(self._env.task.start_url)

    def _official_task_metadata(self) -> dict[str, Any] | None:
        if self.mock:
            return None
        if self._webarena_task is not None:
            return {
                "officialTaskId": self._webarena_task.task_id,
                "taskClass": "WebArenaVerifiedTask",
                "seed": self.episode["seed"],
                "sites": [site.value for site in self._webarena_task.sites],
                "goal": self._webarena_task.intent,
                "evaluator": "webarena-verified.deterministic",
            }
        if not self._env:
            return None
        return {
            "officialTaskId": self._task_class.get_task_id(),
            "taskClass": self._task_class.__name__,
            "seed": self.episode["seed"],
            "subtaskCount": len(self._env.task),
            "goal": self._last_observation.get("goal", "") if self._last_observation else "",
            "evaluator": "task.validate",
        }

    @staticmethod
    def _apply_action(session: Session, action: dict[str, Any]) -> None:
        kind = str(action.get("kind", action.get("type", "")))
        target = str(action.get("target", ""))
        if kind == "goto":
            session.page.goto(str(action.get("url", target)))
        elif kind == "click":
            session.page.locator(target).click()
        elif kind == "type":
            session.page.locator(target).fill(str(action.get("value", "")))
        elif kind == "select":
            session.page.locator(target).select_option(str(action.get("value", "")))
        elif kind == "submit":
            session.page.locator(target).click()
        elif kind == "wait":
            session.page.wait_for_timeout(int(action.get("ms", 500)))
        elif kind == "press":
            session.page.locator(target).press(str(action.get("value", "Enter")))
        elif kind == "scroll":
            session.page.mouse.wheel(0, int(action.get("value", 700)))
        elif kind == "done":
            return
        else:
            raise ValueError(f"unsupported browser action: {kind}")


def main() -> int:
    bridge = Bridge()
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            bridge.handle(json.loads(line))
        except json.JSONDecodeError as exc:
            bridge.reply("", False, error={"type": "JSONDecodeError", "message": str(exc)})
    bridge.cmd_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
