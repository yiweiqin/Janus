"""Wait for the trainer's mid-run dev evaluation and print it.

Trainer config uses eval_strategy="epoch", so the first honest held-out signal appears at the
checkpoint boundary (~step 530 of 1060). Training loss cannot separate "learned the rule" from
"memorised the 571 high-frequency graphs"; the first dev loss can, because dev shares zero
topologies with train.

Polls with a fresh short-lived command each cycle rather than holding one long channel open -- the
same lesson as V3_FULL_REPORT section 9.2.

Exit codes: 0 eval found, 1 trainer exited before evaluating, 2 timed out.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
from _rdmd_train_then_eval import Remote  # noqa: E402


def probe(run_dir: str) -> str:
    """Labelled one-shot probe so empty results cannot shift the parsing by a line."""
    return (
        f"RUN={run_dir}; LOG=$RUN.train.log; "
        f"pid=$(cat $RUN.pid 2>/dev/null); "
        f"if [ -n \"$pid\" ] && ps -p \"$pid\" >/dev/null 2>&1; then echo 'STATE=ALIVE'; else echo 'STATE=GONE'; fi; "
        f"echo \"EVALCOUNT=$(grep -ac 'eval_loss' $LOG 2>/dev/null)\"; "
        f"echo \"EVAL=$(grep -ao \\\"'eval_loss': [0-9.eE+-]*\\\" $LOG 2>/dev/null | tail -n 1)\"; "
        f"echo \"STEP=$(grep -ao '[0-9]*/1060' $LOG 2>/dev/null | tail -n 1)\""
    )


def fields(out: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in out.splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            result[key.strip()] = value.strip()
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-tag", default="qlora-v3")
    parser.add_argument("--interval", type=int, default=90)
    parser.add_argument("--max-minutes", type=float, default=75.0)
    args = parser.parse_args()

    remote = Remote()
    run_dir = f"/root/autodl-tmp/rdmd_runs/{args.run_tag}"
    deadline = time.time() + args.max_minutes * 60

    while True:
        _, out, _ = remote.run(probe(run_dir), timeout=60)
        info = fields(out)
        state = info.get("STATE", "GONE")
        count = info.get("EVALCOUNT", "0")
        eval_loss = info.get("EVAL", "")
        step = info.get("STEP", "")

        if count.isdigit() and int(count) > 0:
            print("EPOCH_EVAL_FOUND")
            print(" ", step, eval_loss)
            _, tail, _ = remote.run(f"grep -a \"'eval\\|Evaluation\" {run_dir}.train.log | tail -n 15", timeout=60)
            print("--- evaluation lines ---")
            print(tail.strip())
            return
        if state == "GONE":
            print("TRAINER_EXITED_WITHOUT_EVAL")
            _, tail, _ = remote.run(f"tail -c 2000 {run_dir}.train.log", timeout=60)
            print(tail)
            raise SystemExit(1)
        if time.time() > deadline:
            print("TIMEOUT_BEFORE_EPOCH_EVAL")
            raise SystemExit(2)
        print(f"[wait] {time.strftime('%H:%M:%S')} {state} {step} no dev eval yet", flush=True)
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
