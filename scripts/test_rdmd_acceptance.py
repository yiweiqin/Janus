"""Tests for rdmd_acceptance.py, including a negative control built from v2's real numbers.

The point of these tests is that the gate must be able to say NO. A verdict tool that only ever
prints USABLE is worse than nothing, so the v2 case (which is genuinely unusable) is a required test:
abstention was 0.000 there, and the gate must fail on exactly that.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
SFT = ROOT / "experiments" / "rdmd_detective_dataset" / "sft"


def write_reports(eval_dir: Path, *, node: float, type_hit: float, abstain: float, no_drift: float,
                  parse_error: float = 0.0) -> None:
    def report(split: str, metrics: dict) -> None:
        (eval_dir / f"{split}.report.json").write_text(
            json.dumps({"status": "scored", "split": split, "n": 0, "metrics": metrics}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    report("test", {
        "drift": {"n": 1427, "statusHit": 1.0, "nodeHit": node, "typeHit": type_hit, "unknownRate": 0.0, "parseErrorRate": parse_error},
        "no_drift": {"n": 111, "statusHit": 1.0, "unknownRate": 0.0, "parseErrorRate": parse_error},
        "UNKNOWN": {"n": 226, "statusHit": 0.0, "unknownRate": 0.0, "parseErrorRate": parse_error},
    })
    report("eval_unknown", {"UNKNOWN": {"n": 226, "statusHit": abstain, "nodeHit": 0.0, "typeHit": 0.0,
                                        "unknownRate": abstain, "parseErrorRate": parse_error}})
    report("eval_no_drift", {"no_drift": {"n": 111, "statusHit": no_drift, "unknownRate": 1 - no_drift,
                                          "parseErrorRate": parse_error}})


def write_predictions(eval_dir: Path, drop_fraction: float = 0.0) -> None:
    """Use gold completions as predictions: a perfect model, optionally degraded on a prefix."""
    rows = [json.loads(line) for line in (SFT / "test.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    drift = [row for row in rows if json.loads(row["completion"])["status"] == "drift"]
    cut = int(len(drift) * drop_fraction)
    broken = {row["id"] for row in drift[:cut]}
    out = []
    for row in rows:
        gold = json.loads(row["completion"])
        if row["id"] in broken:
            payload = dict(gold, nodeId="n_wrong", type="wrong_agent")
            out.append({"id": row["id"], "prediction": json.dumps(payload, ensure_ascii=False)})
        else:
            out.append({"id": row["id"], "prediction": json.dumps(gold, ensure_ascii=False)})
    (eval_dir / "merged.predictions.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in out), encoding="utf-8")


def run(eval_dir: Path) -> tuple[int, str]:
    result = subprocess.run(
        [sys.executable, str(SCRIPTS / "rdmd_acceptance.py"), "--eval-dir", str(eval_dir)],
        capture_output=True, text=True, encoding="utf-8",
    )
    return result.returncode, (result.stdout or "") + (result.stderr or "")


def read_acceptance(eval_dir: Path) -> dict:
    return json.loads((eval_dir / "acceptance.json").read_text(encoding="utf-8-sig"))


def write_manifest(eval_dir: Path, *, split: str = "test", hash_matches: bool = True) -> None:
    """造一份发布时该有的 eval_manifest.json。

    `hash_matches=False` 模拟"评测读的标签和本地这份不是同一批" —— 也就是"出处对不上"。
    """
    source = SFT / f"{split}.jsonl"
    # split 不存在时给个占位哈希：case 8 要的正是"本地没有这个文件"这条路径。
    real = hashlib.sha256(source.read_bytes()).hexdigest() if source.is_file() else "c" * 64
    (eval_dir / "eval_manifest.json").write_text(json.dumps({
        "runTag": "qlora-v4",
        "source": "launch",
        "adapter": {"path": "/box/adapter", "sha256": "a" * 64, "bytes": 12345,
                    "baseModel": "/root/autodl-tmp/models/Qwen3-8B"},
        "sft": {"schemaVersion": "rdmd_detective_sft_v4", "sourceVersion": "rdmd_detective_dataset_v4",
                "splits": {split: {"n": 1665, "sha256": real if hash_matches else "0" * 64}}},
        "evaluator": {"path": "scripts/eval_rdmd_qlora.py", "sha256": "b" * 64},
    }, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    failures: list[str] = []

    # 1. v2's real metrics: perfect localisation on shortcuted data, zero abstention, nothing else wrong.
    with tempfile.TemporaryDirectory() as tmp:
        eval_dir = Path(tmp)
        write_reports(eval_dir, node=1.0, type_hit=0.9971, abstain=0.0, no_drift=1.0)
        write_predictions(eval_dir)
        code, text = run(eval_dir)
        print("== case 1: v2 numbers ==")
        print(text)
        if code != 1 or "NOT_USABLE" not in text or "UNKNOWN 弃权率" not in text:
            failures.append("v2 case should be NOT_USABLE and blame abstention")

    # 2. a healthy model: everything at or above threshold.
    with tempfile.TemporaryDirectory() as tmp:
        eval_dir = Path(tmp)
        write_reports(eval_dir, node=0.97, type_hit=0.65, abstain=0.88, no_drift=1.0)
        write_predictions(eval_dir)
        code, text = run(eval_dir)
        print("== case 2: healthy model ==")
        print(text)
        if code != 0 or "USABLE" not in text:
            failures.append("healthy model should be USABLE")
        if "may have drifted" in text:
            failures.append("derived-only subset definition should match the published baseline")
        if read_acceptance(eval_dir).get("provenance") is not None:
            failures.append("a run with no manifest must record provenance as null, not fabricate one")
        if "eval_manifest.json 缺失" not in text:
            failures.append("a missing manifest must be stated in the notes")

    # 3. good aggregate localisation but the reasoning subset fails: the gate must catch it.
    with tempfile.TemporaryDirectory() as tmp:
        eval_dir = Path(tmp)
        write_reports(eval_dir, node=0.97, type_hit=0.65, abstain=0.88, no_drift=1.0)
        write_predictions(eval_dir, drop_fraction=0.30)
        code, text = run(eval_dir)
        print("== case 3: reasoning subset degraded ==")
        print(text)
        if code != 1 or "test 无原因字段子集定位" not in text:
            failures.append("degraded derived-only subset should be caught")

    # 4. parse errors make a model unusable even with good scores.
    with tempfile.TemporaryDirectory() as tmp:
        eval_dir = Path(tmp)
        write_reports(eval_dir, node=0.97, type_hit=0.65, abstain=0.88, no_drift=1.0, parse_error=0.10)
        write_predictions(eval_dir)
        code, text = run(eval_dir)
        print("== case 4: parse errors ==")
        print(text)
        if code != 1 or "解析错误率" not in text:
            failures.append("parse error guard should fail the verdict")

    # 5. no data yet must not be reported as usable.
    with tempfile.TemporaryDirectory() as tmp:
        code, text = run(Path(tmp))
        print("== case 5: no reports ==")
        print(text)
        if code != 2 or "NOT_ENOUGH_DATA" not in text:
            failures.append("missing reports should exit 2 with NOT_ENOUGH_DATA")

    # 6. provenance 对得上：结论要能说出自己判的是哪份权重、哪批标签。
    with tempfile.TemporaryDirectory() as tmp:
        eval_dir = Path(tmp)
        write_reports(eval_dir, node=0.97, type_hit=0.65, abstain=0.88, no_drift=1.0)
        write_predictions(eval_dir)
        write_manifest(eval_dir)
        code, text = run(eval_dir)
        print("== case 6: provenance 一致 ==")
        print(text)
        payload = read_acceptance(eval_dir)
        provenance = payload.get("provenance") or {}
        if code != 0 or "USABLE" not in text:
            failures.append("recording provenance must not disturb a healthy verdict")
        if provenance.get("source") != "launch" or not (provenance.get("adapter") or {}).get("sha256"):
            failures.append("acceptance.json must carry the adapter identity")
        if (provenance.get("labelIntegrity") or {}).get("test", {}).get("match") is not True:
            failures.append("a matching label hash should be recorded as match=true")
        if provenance.get("labelIntegrityOk") is not True:
            failures.append("labelIntegrityOk should be true when every split matches")

    # 7. provenance 对不上：要吵，但**不能**翻判定 —— 那道门是覆盖度守卫的活。
    #    在这里加门会引入一类新的假失败：本地重新生成过语料就会亮红，哪怕内容一字不差。
    with tempfile.TemporaryDirectory() as tmp:
        eval_dir = Path(tmp)
        write_reports(eval_dir, node=0.97, type_hit=0.65, abstain=0.88, no_drift=1.0)
        write_predictions(eval_dir)
        write_manifest(eval_dir, hash_matches=False)
        code, text = run(eval_dir)
        print("== case 7: provenance 不一致 ==")
        print(text)
        provenance = read_acceptance(eval_dir).get("provenance") or {}
        if code != 0 or "USABLE" not in text:
            failures.append("a label mismatch must be reported, not silently turned into a verdict flip")
        if provenance.get("labelIntegrityOk") is not False:
            failures.append("labelIntegrityOk should be false on a confirmed mismatch")
        if "标签哈希对不上" not in text:
            failures.append("a confirmed label mismatch must be loud")

    # 8. 本地没有这个 split 的文件 = 无从核对，不是不一致。两者混报会把"没查"说成"查出错"。
    with tempfile.TemporaryDirectory() as tmp:
        eval_dir = Path(tmp)
        write_reports(eval_dir, node=0.97, type_hit=0.65, abstain=0.88, no_drift=1.0)
        write_predictions(eval_dir)
        write_manifest(eval_dir, split="a_split_we_do_not_have")
        code, text = run(eval_dir)
        print("== case 8: 无从核对 ==")
        print(text)
        provenance = read_acceptance(eval_dir).get("provenance") or {}
        row = (provenance.get("labelIntegrity") or {}).get("a_split_we_do_not_have", {})
        if row.get("match") is not None:
            failures.append("a split we cannot see locally must be unverifiable, not a mismatch")
        if provenance.get("labelIntegrityOk") is not True:
            failures.append("unverifiable is not the same as mismatched")
        if "标签哈希对不上" in text:
            failures.append("unverifiable must not print the mismatch warning")

    print()
    if failures:
        for failure in failures:
            print("FAIL:", failure)
        raise SystemExit(1)
    print("ALL ACCEPTANCE TESTS PASSED")


if __name__ == "__main__":
    main()
