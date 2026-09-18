"""为**已经跑完**的 RDMD 评测补一份出处（eval_manifest.json）。

为什么需要它：v4 评测跑在出处机制落地之前。它的产物里没有任何东西能说出判的是哪个
adapter —— 而这一轮 P3 要修的病，正是"adapter 是真的、出处是假的"（第一次起训把 v3 的
dataKind 写进了 v4 的 run_manifest）。重跑 50 分钟买不到任何新信息：权重和标签都还在
盒子上，缺的只是把它们跟结论绑在一起的那一页纸。

所以这个工具**只补一页纸**，不改任何评测产物、不占 GPU。它调的是起跑路径同一个
`_rdmd_remote_eval_manifest.sh`，只是把 `source` 标成 `backfill` —— 算出处只允许有一处
定义，两份实现各自演化就是这个任务要治的病本身。

诚实性：回填的出处**证据力弱于 launch**。launch 是"我在读这批文件、正要评测它们"时记的，
回填是"事后我去看现在磁盘上是什么"记的。两者能证明的东西不同，所以不冒充 ——
`source=backfill` 会一路带进 `acceptance.json`，打印时明说。

用法：
  python scripts/_rdmd_backfill_eval_manifest.py --run-tag qlora-v4
    # 之后重跑验收门，让它带上出处：
  python scripts/rdmd_acceptance.py --eval-dir experiments/rdmd_runs/eval-qlora-v4 \
    --run-tag qlora-v4 --compare-tag qlora-v3 \
    --data-dir experiments/rdmd_detective_dataset/data
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))
from _rdmd_train_then_eval import Remote  # noqa: E402


def splits_from_local(eval_dir: Path) -> list[str]:
    """按本地已有的 report 反推这次评测跑了哪些 split。

    比让人手打一遍可靠：`*.report.json` 就是评测真实产出的东西，而手打的清单会和
    实际跑过的悄悄分叉 —— 那又是一种"出处说的是另一回事"。
    """
    return sorted(path.name[: -len(".report.json")] for path in eval_dir.glob("*.report.json"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-tag", default="qlora-v4")
    parser.add_argument("--out-name", default="", help="远端/本地评测目录名；默认 eval-<run-tag>")
    parser.add_argument("--splits", nargs="+", default=[], help="默认按本地 report 反推")
    args = parser.parse_args()

    name = args.out_name or f"eval-{args.run_tag}"
    remote_dir = f"/root/autodl-tmp/rdmd_runs/{name}"
    run_dir = f"/root/autodl-tmp/rdmd_runs/{args.run_tag}"
    local_dir = ROOT / "experiments" / "rdmd_runs" / name
    if not local_dir.is_dir():
        raise SystemExit(f"本地没有评测产物：{local_dir}")

    splits = args.splits or splits_from_local(local_dir)
    if not splits:
        raise SystemExit(f"{local_dir} 里没有 *.report.json，无法反推 split 清单；用 --splits 指定")

    print(f"[backfill] {name}: splits={splits}", flush=True)
    remote = Remote()
    exports = {
        "RUN_TAG": args.run_tag,
        "SPLITS": f'"{" ".join(splits)}"',
        "OUT": remote_dir,
        "ADAPTER": f"{run_dir}/adapter",
        # 起跑路径用 launch；这里刻意用 backfill，好让读的人知道这页纸是事后补的。
        "SOURCE": "backfill",
    }
    # 不传 GPUS：运行形态是起跑时的事实，回填时已经无从查证，省略而不是编一个。
    code, out, err = remote.stream(remote.local_script("_rdmd_remote_eval_manifest.sh", exports), timeout=600)
    print(out.strip(), flush=True)
    if err.strip():
        print(err.strip(), file=sys.stderr, flush=True)
    if code != 0:
        raise SystemExit(f"backfill_failed:{code}")

    try:
        text = remote.get(f"{remote_dir}/eval_manifest.json")
    except OSError as exc:
        raise SystemExit(f"回填没写成：{exc}")
    (local_dir / "eval_manifest.json").write_text(text, encoding="utf-8")
    manifest = json.loads(text)

    adapter = manifest.get("adapter") or {}
    print("\n[backfill] 补上的出处：")
    print(f"  adapter sha256 = {adapter.get('sha256')}")
    print(f"  adapter bytes  = {adapter.get('bytes')}")
    print(f"  base model     = {adapter.get('baseModel')}")
    print(f"  sft            = {(manifest.get('sft') or {}).get('schemaVersion')}"
          f" / {(manifest.get('sft') or {}).get('sourceVersion')}")
    print(f"  mergedTotal    = {manifest.get('mergedTotal')}")
    print(f"  source         = {manifest.get('source')}")

    # 交叉核对：manifest 说被评测了 N 行，本地那份 merged.predictions.jsonl 就该正好有 N 行。
    # 对不上说明补的出处和真正被打分的那批行不是一回事 —— 那比没有出处更糟，所以直接报出来。
    merged = local_dir / "merged.predictions.jsonl"
    if merged.is_file() and manifest.get("mergedTotal") is not None:
        rows = len([line for line in merged.read_text(encoding="utf-8").splitlines() if line.strip()])
        if rows != manifest["mergedTotal"]:
            print(f"\n[backfill] 不一致：merged.predictions.jsonl 有 {rows} 行，"
                  f"而出处说被评测 {manifest['mergedTotal']} 行 —— 这页纸对不上的那道题，需要人来看",
                  file=sys.stderr)
            raise SystemExit(5)
        print(f"  交叉核对       = merged.predictions.jsonl 的 {rows} 行与出处一致")

    print(f"\n[backfill] 写入 {local_dir / 'eval_manifest.json'}", flush=True)
    print("[backfill] 下一步：重跑 rdmd_acceptance.py --eval-dir "
          f"{local_dir} --compare-tag qlora-v3 --data-dir experiments/rdmd_detective_dataset/data", flush=True)


if __name__ == "__main__":
    main()
