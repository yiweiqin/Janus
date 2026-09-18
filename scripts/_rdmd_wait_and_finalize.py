"""Wait for a remote RDMD sharded eval to finish, then run its finalize script and print reports.

Usage:
  python scripts/_rdmd_wait_and_finalize.py --pid-dir /root/autodl-tmp/rdmd_runs/v2extra \
      --finalize scripts/_rdmd_remote_eval_v2extrafinal.sh [--max-minutes 60]

The remote eval writes one pid file per GPU shard; this polls until none of those pids are alive,
then streams the finalize script over stdin and prints its last output lines.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rdmd_ssh import connect, run  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid-dir", required=True, help="remote dir holding shard*.pid")
    parser.add_argument("--finalize", required=True, help="local path to the finalize script")
    parser.add_argument("--max-minutes", type=int, default=60)
    parser.add_argument("--interval", type=int, default=30)
    args = parser.parse_args()

    password = os.environ.get("RDMD_SSH_PASSWORD") or os.environ.get("SSH_PASSWORD")
    if not password:
        raise SystemExit("RDMD_SSH_PASSWORD is required")

    client = connect(
        os.environ.get("RDMD_SSH_HOST", "connect.bjb1.seetacloud.com"),
        int(os.environ.get("RDMD_SSH_PORT", "53957")),
        os.environ.get("RDMD_SSH_USER", "root"),
        password,
    )
    try:
        deadline = time.time() + args.max_minutes * 60
        check = (
            f"alive=0; for f in {args.pid_dir}/shard*.pid; do "
            f"[ -e \"$f\" ] || continue; p=$(cat \"$f\"); "
            f"if kill -0 \"$p\" 2>/dev/null; then alive=$((alive+1)); fi; done; "
            f"echo -n \"$alive\"; echo -n ' '; "
            f"grep -ah '^\\[eval\\]' {args.pid_dir}/shard*.log 2>/dev/null | tail -n 3 | tr '\\n' ';'"
        )
        while True:
            code, out, err = run(client, check, timeout=60)
            alive = (out.strip().split(" ")[0] or "0") if out.strip() else "0"
            print(f"[wait] {time.strftime('%H:%M:%S')} alive={alive} {out.strip()}", flush=True)
            if alive == "0":
                break
            if time.time() > deadline:
                print("[wait] TIMEOUT", flush=True)
                raise SystemExit(3)
            time.sleep(args.interval)

        script = Path(args.finalize).read_text(encoding="utf-8-sig")
        stdin, stdout, stderr = client.exec_command("bash -s", timeout=1800)
        stdin.write(script)
        stdin.channel.shutdown_write()
        console = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        code = stdout.channel.recv_exit_status()
        print(console)
        if err:
            print(err, file=sys.stderr)
        print(f"[finalize] exit={code}")
        raise SystemExit(code)
    finally:
        client.close()


if __name__ == "__main__":
    main()
