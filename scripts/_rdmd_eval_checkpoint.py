"""Score an intermediate training checkpoint on the idle GPUs, without disturbing the live run.

Why this exists: the trainer only computes token-level `eval_loss` during training, which cannot tell
a confident wrong answer from a right one. The decisive numbers (node accuracy, type accuracy,
abstention) are only produced by the eval script. Waiting for training to finish costs hours that are
sitting idle, because training pins GPU 0 while GPUs 1..N stay empty.

Restricting splits matters: the eval only scores a split after every shard finishes, so including the
biggest split delays even the fastest signal. Pass only what is needed for an early read.

Usage:
  python scripts/_rdmd_eval_checkpoint.py --run-tag qlora-v3 --checkpoint checkpoint-530 \
    --gpu-ids 1 2 --splits development eval_unknown eval_no_drift
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
from _rdmd_train_then_eval import Remote  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-tag", default="qlora-v3")
    parser.add_argument("--checkpoint", default="", help="directory name under <run>/checkpoints")
    parser.add_argument("--adapter", default="", help="explicit adapter dir; overrides --checkpoint "
                                                      "(used for the final <run>/adapter after training)")
    parser.add_argument("--gpu-ids", nargs="+", default=["1", "2"])
    parser.add_argument("--splits", nargs="+", default=["development", "eval_unknown", "eval_no_drift"])
    parser.add_argument("--out", default="")
    parser.add_argument("--out-name", default="", help="remote+local dir name; default eval-<run>-<tag>")
    parser.add_argument("--interval", type=int, default=120)
    parser.add_argument("--max-hours", type=float, default=6.0)
    args = parser.parse_args()

    run_dir = f"/root/autodl-tmp/rdmd_runs/{args.run_tag}"
    if args.adapter:
        adapter = args.adapter
        tag = args.out_name or "adapter"
    elif args.checkpoint:
        adapter = f"{run_dir}/checkpoints/{args.checkpoint}"
        tag = args.out_name or args.checkpoint
    else:
        raise SystemExit("pass --checkpoint or --adapter")
    out_dir = args.out or f"/root/autodl-tmp/rdmd_runs/{args.out_name or f'eval-{args.run_tag}-{tag}'}"
    local_name = args.out_name or f"eval-{args.run_tag}-{tag}"
    gpus = len(args.gpu_ids)

    remote = Remote()
    code, out, err = remote.run(f"test -f {adapter}/adapter_config.json && echo ADAPTER_OK || echo ADAPTER_MISSING", timeout=60)
    print(f"adapter check: {out.strip()}", flush=True)
    if "ADAPTER_OK" not in out:
        raise SystemExit(f"no adapter at {adapter}")

    exports = {
        "RUN_TAG": args.run_tag,
        "SPLITS": '"' + " ".join(args.splits) + '"',
        "GPUS": str(gpus),
        "GPU_IDS": '"' + " ".join(args.gpu_ids) + '"',
        "ADAPTER": adapter,
        "OUT": out_dir,
    }
    print(f"[launch] adapter={adapter}", flush=True)
    print(f"[launch] gpus={args.gpu_ids} splits={args.splits} out={out_dir}", flush=True)
    code, out, err = remote.stream(remote.local_script("_rdmd_remote_eval_splits.sh", exports), timeout=900)
    print(out.strip(), flush=True)
    if err.strip():
        print(err.strip(), flush=True)
    if code != 0:
        raise SystemExit(f"launch_failed:{code}")
    if "LAUNCHED" not in out:
        raise SystemExit("launch did not report LAUNCHED")

    deadline = time.time() + args.max_hours * 3600
    while True:
        probe = (
            f"OUT={out_dir}; alive=0; "
            f"for i in $(seq 0 {gpus - 1}); do "
            f"p=$(cat $OUT/shard$i.pid 2>/dev/null); "
            f"if [ -n \"$p\" ] && ps -p \"$p\" >/dev/null 2>&1; then alive=$((alive+1)); fi; done; "
            f"echo \"ALIVE=$alive\"; "
            f"echo \"PROGRESS=$(grep -ah '^\\[eval\\]' $OUT/shard*.log 2>/dev/null | tail -n 2 | tr '\\n' ' ')\""
        )
        _, out, _ = remote.run(probe, timeout=60)
        info = {}
        for line in out.splitlines():
            if "=" in line:
                key, _, value = line.partition("=")
                info[key.strip()] = value.strip()
        print(f"[eval]  {time.strftime('%H:%M:%S')} alive={info.get('ALIVE')} {info.get('PROGRESS','')}", flush=True)
        if info.get("ALIVE") == "0":
            break
        if time.time() > deadline:
            raise SystemExit("checkpoint_eval_timeout")
        time.sleep(args.interval)

    print("[score] merging and scoring", flush=True)
    exports_final = {**exports, "SPLITS": '"' + " ".join(args.splits) + '"'}
    code, out, err = remote.stream(remote.local_script("_rdmd_remote_eval_splits_final.sh", exports_final), timeout=1800)
    print(out, flush=True)
    if err.strip():
        print(err, file=sys.stderr, flush=True)

    local_dir = SCRIPTS.parent / "experiments" / "rdmd_runs" / local_name
    local_dir.mkdir(parents=True, exist_ok=True)
    (local_dir / "finalize_output.txt").write_text(out, encoding="utf-8")
    try:
        preds = remote.get(f"{out_dir}/merged.predictions.jsonl")
        (local_dir / "merged.predictions.jsonl").write_text(preds, encoding="utf-8")
    except OSError as exc:
        print(f"[warn] no merged predictions: {exc}", flush=True)
    for split in args.splits:
        try:
            text = remote.get(f"{out_dir}/{split}.report.json")
        except OSError:
            continue
        (local_dir / f"{split}.report.json").write_text(text, encoding="utf-8")
    print(f"[done]  reports in {local_dir}", flush=True)


if __name__ == "__main__":
    main()
