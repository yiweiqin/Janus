"""Finalise a checkpoint eval, pull the artefacts down, and print the acceptance verdict.

Kept separate from the launch so scoring can be re-run cheaply (it is pure CPU on already-generated
predictions) without touching the GPUs.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))
from _rdmd_train_then_eval import Remote  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-tag", default="qlora-v3")
    parser.add_argument("--tag", default="", help="suffix used for the remote/local eval dir, e.g. checkpoint-530")
    parser.add_argument("--out-name", default="", help="explicit remote+local eval dir name; overrides --tag")
    parser.add_argument("--splits", nargs="+", default=["development"])
    parser.add_argument("--shards", type=int, default=2)
    parser.add_argument("--primary-split", default="test")
    args = parser.parse_args()

    name = args.out_name or (f"eval-{args.run_tag}-{args.tag}" if args.tag else "")
    if not name:
        raise SystemExit("pass --tag or --out-name")
    out_dir = f"/root/autodl-tmp/rdmd_runs/{name}"
    local_dir = ROOT / "experiments" / "rdmd_runs" / name
    local_dir.mkdir(parents=True, exist_ok=True)

    remote = Remote()
    exports = {
        "RUN_TAG": args.run_tag,
        "SPLITS": '"' + " ".join(args.splits) + '"',
        "GPUS": str(args.shards),
        "OUT": out_dir,
    }
    code, out, err = remote.stream(remote.local_script("_rdmd_remote_eval_splits_final.sh", exports), timeout=1800)
    print(out, flush=True)
    if err.strip():
        print(err, file=sys.stderr, flush=True)
    (local_dir / "finalize_output.txt").write_text(out, encoding="utf-8")

    if "REPORTS_DONE" not in out:
        raise SystemExit("finalize did not complete")

    # eval_manifest.json 是起跑那一步（_rdmd_remote_eval_splits.sh）落下的出处。它是评测
    # 产物的一部分，所以要在 finalise 时一起拉回来：少了它 acceptance 只能记一句"出处未记录"。
    for name in ("merged.predictions.jsonl", "eval_manifest.json",
                 *(f"{split}.report.json" for split in args.splits)):
        try:
            text = remote.get(f"{out_dir}/{name}")
        except OSError as exc:
            print(f"[warn] could not fetch {name}: {exc}", flush=True)
            continue
        (local_dir / name).write_text(text, encoding="utf-8")
        print(f"[fetch] {name} ({len(text.splitlines())} lines)", flush=True)

    print("\n[gate] acceptance criteria", flush=True)
    gate = subprocess.run(
        [sys.executable, str(SCRIPTS / "rdmd_acceptance.py"), "--eval-dir", str(local_dir),
         "--primary-split", args.primary_split],
        capture_output=True, text=True, encoding="utf-8",
    )
    print(gate.stdout or "", flush=True)
    if gate.stderr:
        print(gate.stderr, file=sys.stderr, flush=True)
    print(f"[gate] exit={gate.returncode} (0=usable, 1=not usable, 2=not enough data)", flush=True)


if __name__ == "__main__":
    main()
