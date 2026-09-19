"""Watch RDMD training to completion, then run the 4-split eval and collect the reports.

Why this exists as a Python-side poller rather than one long SSH command: a single long-lived
channel that produces no output cannot distinguish "still working" from "connection silently
dead" -- a real hang we hit for 15 minutes while waiting on this very run (see
V3_FULL_REPORT.zh-CN.md section 9.2). Here every poll is its own short command with its own read
timeout, and the client reconnects if a poll fails.

Flow:
  1. poll the trainer pid until it exits;
  2. require run_manifest.json status == "trained" (otherwise dump the log tail and stop);
  3. launch the sharded evaluator over every split;
  4. poll the shard pids until they exit;
  5. merge + score per split, print a consolidated report, save reports locally.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
from _rdmd_ssh_target import connect as _connect_ssh  # noqa: E402
from rdmd_ssh import run  # noqa: E402

ROOT = SCRIPTS.parent


class Remote:
    """SSH helper that reconnects on failure so a 14h watch survives a dropped connection."""

    def __init__(self) -> None:
        self.client = None
        self.connect()

    def connect(self) -> None:
        try:
            if self.client is not None:
                self.client.close()
        except Exception:
            pass
        # 端点解析只有一处实现，缺 host/port 就 fail closed。
        self.client = _connect_ssh()

    def run(self, command: str, timeout: int = 60, retries: int = 3) -> tuple[int, str, str]:
        last: Exception | None = None
        for attempt in range(retries):
            try:
                return run(self.client, command, timeout=timeout)
            except Exception as exc:  # noqa: BLE001 - any transport error is retryable
                last = exc
                print(f"[warn] ssh poll failed ({type(exc).__name__}), reconnecting", flush=True)
                time.sleep(5)
                try:
                    self.connect()
                except Exception as exc2:  # noqa: BLE001
                    last = exc2
                    time.sleep(10)
        raise SystemExit(f"ssh_unreachable: {last}")

    def stream(self, script: str, timeout: int = 1800) -> tuple[int, str, str]:
        stdin, stdout, stderr = self.client.exec_command("bash -s", timeout=timeout)
        stdin.write(script)
        stdin.channel.shutdown_write()
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        return stdout.channel.recv_exit_status(), out, err

    def local_script(self, name: str, exports: dict[str, str]) -> str:
        body = (SCRIPTS / name).read_text(encoding="utf-8-sig")
        prefix = "".join(f"export {key}={value}\n" for key, value in exports.items())
        return prefix + body

    def get(self, remote_path: str) -> str:
        sftp = self.client.open_sftp()
        try:
            with sftp.open(remote_path, "rb") as handle:
                return handle.read().decode("utf-8", errors="replace")
        finally:
            sftp.close()


def train_probe(run_dir: str) -> str:
    """One-shot remote probe: is the trainer alive, and what step / loss is it on?"""
    return (
        f"RUN={run_dir}; "
        f"pid=$(cat $RUN.pid 2>/dev/null); "
        f"if [ -n \"$pid\" ] && ps -p \"$pid\" >/dev/null 2>&1; then echo ALIVE; else echo GONE; fi; "
        f"grep -ao '[0-9]\\+/[0-9]\\+ \\[' $RUN.train.log 2>/dev/null | tail -n 1; "
        f"grep -ao \"'loss': '[^']*'\" $RUN.train.log 2>/dev/null | tail -n 1"
    )


def eval_probe(out_dir: str, shards: int) -> str:
    """One-shot remote probe: how many eval shards are still running, and their progress."""
    return (
        f"OUT={out_dir}; alive=0; "
        f"for gpu in $(seq 0 {shards - 1}); do "
        f"p=$(cat $OUT/shard$gpu.pid 2>/dev/null); "
        f"if [ -n \"$p\" ] && ps -p \"$p\" >/dev/null 2>&1; then alive=$((alive+1)); fi; done; "
        f"echo $alive; "
        f"grep -ah '^\\[eval\\]' $OUT/shard*.log 2>/dev/null | tail -n 3 | tr '\\n' ' '"
    )


def wait_for_training(remote: Remote, run_tag: str, interval: int, max_hours: float) -> str:
    run_dir = f"/root/autodl-tmp/rdmd_runs/{run_tag}"
    probe = train_probe(run_dir)
    deadline = time.time() + max_hours * 3600
    while True:
        _, out, _ = remote.run(probe, timeout=60)
        lines = [line for line in out.splitlines() if line.strip()]
        alive = lines[0].strip() if lines else "GONE"
        step = lines[1].strip() if len(lines) > 1 else ""
        loss = lines[2].strip() if len(lines) > 2 else ""
        print(f"[train] {time.strftime('%H:%M:%S')} {alive} {step} {loss}", flush=True)
        if alive == "GONE":
            return run_dir
        if time.time() > deadline:
            raise SystemExit("training_watch_timeout")
        time.sleep(interval)


def wait_for_eval(remote: Remote, out_dir: str, shards: int, interval: int, max_hours: float) -> None:
    probe = eval_probe(out_dir, shards)
    deadline = time.time() + max_hours * 3600
    while True:
        _, out, _ = remote.run(probe, timeout=60)
        lines = [line for line in out.splitlines() if line.strip()]
        alive = lines[0].strip() if lines else "0"
        progress = lines[1].strip() if len(lines) > 1 else ""
        print(f"[eval]  {time.strftime('%H:%M:%S')} alive={alive} {progress}", flush=True)
        if alive == "0":
            return
        if time.time() > deadline:
            raise SystemExit("eval_watch_timeout")
        time.sleep(interval)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-tag", default="qlora-v3")
    parser.add_argument("--compare-tag", default="",
                        help="对照基线（默认 qlora-v3 若存在）。P3 的结论形式是"
                             "「v4 相对 v3 变了什么」，不是孤立的达标与否。")
    parser.add_argument("--splits", default="test eval_unknown eval_no_drift development")
    parser.add_argument("--shards", type=int, default=3)
    parser.add_argument("--interval", type=int, default=120)
    parser.add_argument("--max-train-hours", type=float, default=20.0)
    parser.add_argument("--max-eval-hours", type=float, default=4.0)
    args = parser.parse_args()

    if not args.compare_tag and args.run_tag != "qlora-v3":
        reference = ROOT / "experiments" / "rdmd_runs" / "eval-qlora-v3" / "acceptance.json"
        if reference.is_file():
            args.compare_tag = "qlora-v3"
        else:
            print(f"[warn] no v3 acceptance at {reference}; the v3↔v4 table will be empty", flush=True)

    remote = Remote()
    print(f"[watch] run_tag={args.run_tag} splits={args.splits}", flush=True)

    run_dir = wait_for_training(remote, args.run_tag, args.interval, args.max_train_hours)
    print("[train] process exited; checking run_manifest.json", flush=True)
    _, out, _ = remote.run(f"cat {run_dir}/run_manifest.json 2>/dev/null", timeout=60)
    try:
        manifest = json.loads(out)
    except json.JSONDecodeError:
        raise SystemExit(f"no_readable_run_manifest at {run_dir}")
    print(json.dumps({k: manifest.get(k) for k in ("status", "dataKind", "mainLoss", "rows", "globalStep", "bestDevelopmentLoss", "elapsedSeconds")}, ensure_ascii=False, indent=2), flush=True)
    if manifest.get("status") != "trained":
        _, tail, _ = remote.run(f"tail -c 3000 {run_dir}.train.log", timeout=60)
        print("[train] FAILED, log tail:\n" + tail, flush=True)
        raise SystemExit(f"training_not_trained:{manifest.get('status')}")

    out_dir = f"/root/autodl-tmp/rdmd_runs/eval-{args.run_tag}"
    # ADAPTER 显式传，让 manifest 记的和 shard 实际加载的是同一个路径 —— 否则两个脚本
    # 各自用默认值拼路径，一旦调用方换了 adapter，出处记的和跑的就不是一回事。
    exports = {
        "RUN_TAG": args.run_tag,
        "SPLITS": f'"{args.splits}"',
        "GPUS": str(args.shards),
        "OUT": out_dir,
        "ADAPTER": f"{run_dir}/adapter",
        "SOURCE": "launch",
    }
    # 先写出处，再起 shard。顺序不能反：_rdmd_remote_eval_splits.sh 会检查那份一次性
    # 标记，没有就硬停 —— 宁可在烧 GPU 之前停，也不要跑完留下无法归属的判决书。
    print(f"[eval]  writing provenance, then launching sharded eval into {out_dir}", flush=True)
    script = remote.local_script("_rdmd_remote_eval_manifest.sh", exports) + "\n" \
        + remote.local_script("_rdmd_remote_eval_splits.sh", exports)
    code, out, err = remote.stream(script, timeout=900)
    print(out.strip(), flush=True)
    if err.strip():
        print(err.strip(), flush=True)
    if code != 0:
        raise SystemExit(f"eval_launch_failed:{code}")

    wait_for_eval(remote, out_dir, args.shards, args.interval, args.max_eval_hours)

    print("[eval]  merging and scoring per split", flush=True)
    code, out, err = remote.stream(remote.local_script("_rdmd_remote_eval_splits_final.sh", exports), timeout=1800)
    print(out, flush=True)
    if err.strip():
        print(err, file=sys.stderr, flush=True)
    if code != 0:
        raise SystemExit(f"eval_finalize_failed:{code}")

    local_dir = ROOT / "experiments" / "rdmd_runs" / f"eval-{args.run_tag}"
    local_dir.mkdir(parents=True, exist_ok=True)
    (local_dir / "finalize_output.txt").write_text(out, encoding="utf-8")

    # Per-row predictions are needed by rdmd_acceptance.py to score the "culprit has no changed cause
    # field" subset, which no split-level metric captures. Fetch them before the reports.
    try:
        preds = remote.get(f"{out_dir}/merged.predictions.jsonl")
        (local_dir / "merged.predictions.jsonl").write_text(preds, encoding="utf-8")
        print(f"[eval]  fetched merged.predictions.jsonl ({len(preds.splitlines())} rows)", flush=True)
    except OSError as exc:
        print(f"[warn] could not fetch merged.predictions.jsonl: {exc}", flush=True)

    # 评测自己写的出处（哪份权重 / 哪批标签 / 哪版 prompt 构造函数）。不取回来，
    # `acceptance.json` 就只是一句"可用"，而说不出判的是谁 —— 那正是 P3 要修的病。
    try:
        eval_manifest = remote.get(f"{out_dir}/eval_manifest.json")
        (local_dir / "eval_manifest.json").write_text(eval_manifest, encoding="utf-8")
        print("[eval]  fetched eval_manifest.json (the verdict can now name its own inputs)", flush=True)
    except OSError as exc:
        print(f"[warn] could not fetch eval_manifest.json: {exc}", flush=True)

    summary: dict[str, dict] = {}
    for split in args.splits.split():
        try:
            text = remote.get(f"{out_dir}/{split}.report.json")
        except OSError as exc:
            print(f"[warn] could not fetch {split} report: {exc}", flush=True)
            continue
        (local_dir / f"{split}.report.json").write_text(text, encoding="utf-8")
        summary[split] = json.loads(text).get("metrics", {})
    (local_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("[eval]  SUMMARY " + json.dumps(summary, ensure_ascii=False), flush=True)

    print("[gate]  running acceptance criteria", flush=True)
    # --data-dir 是 v4 新增两项（step 层定位 / status 捷径）的必需输入：prompt 里**没有** `kind`，
    # 所以"这一行考的是哪一层"只能回原始 case 里查。不给它，这两项会算成"未测到"，
    # 而按验收门的语义"未测到即不可用" —— 于是 v4 会在"GPU 跑完了但门没测全"的状态下判 NOT_USABLE。
    # --compare-tag 让 v4 与 v3 的对照表同一次跑出来：P3 要的从来不是"v4 达标了"，
    # 而是"拿 step 层的能力换来分布一致，代价具体是多少"。
    gate = subprocess.run(
        [sys.executable, str(SCRIPTS / "rdmd_acceptance.py"), "--eval-dir", str(local_dir),
         "--run-tag", str(args.run_tag), "--data-dir", str(ROOT / "experiments" / "rdmd_detective_dataset" / "data"),
         "--compare-tag", str(args.compare_tag)],
        capture_output=True, text=True, encoding="utf-8",
    )
    print(gate.stdout or "", flush=True)
    if gate.stderr:
        print(gate.stderr, file=sys.stderr, flush=True)
    print(f"[gate]  exit={gate.returncode} (0=usable, 1=not usable, 2=not enough data)", flush=True)
    print(f"[done]  reports saved to {local_dir}", flush=True)


if __name__ == "__main__":
    main()
