"""Machine-readable RDMD training readiness. GPU/model may be remote-only."""
from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EXP = ROOT / "experiments" / "rdmd_detective_dataset"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default=str(EXP))
    parser.add_argument("--model-dir", default="")
    args = parser.parse_args()
    root = Path(args.data_dir)
    sft = root / "sft"
    checks = {
        "node": shutil.which("node") is not None,
        "python": shutil.which("python") is not None or shutil.which("python3") is not None,
        "raw_splits": all((root / "data" / f"{name}.jsonl").is_file() for name in ("train", "development", "test")),
        "raw_validation": (root / "data" / "validation.json").is_file(),
        "sft_splits": all((sft / f"{name}.jsonl").is_file() for name in ("train", "development", "test", "eval_unknown", "eval_no_drift")),
        "sft_manifest": (sft / "manifest.json").is_file(),
        "sft_baseline": (sft / "baseline.json").is_file(),
        "sft_smoke": (sft / "smoke" / "train.jsonl").is_file() and (sft / "smoke" / "development.jsonl").is_file(),
        "scripts": {
            "prepare_sft": (root / "prepare_sft.mjs").is_file(),
            "train": (ROOT / "scripts" / "train_qlora_rdmd.py").is_file(),
            "eval": (ROOT / "scripts" / "eval_rdmd_qlora.py").is_file(),
            "completion": (ROOT / "scripts" / "tdb_completion.py").is_file(),
            "config": (root / "qlora_config.json").is_file(),
        },
        "python_packages": {
            name: importlib.util.find_spec(name) is not None
            for name in ("torch", "transformers", "datasets", "peft")
        },
    }

    failures = []
    warnings = []
    raw_val = {}
    if checks["raw_validation"]:
        raw_val = json.loads((root / "data" / "validation.json").read_text(encoding="utf-8-sig"))
        checks["raw_valid"] = bool(raw_val.get("pass"))
        if not checks["raw_valid"]:
            failures.append("raw_validation_failed")
    sft_man = {}
    if checks["sft_manifest"]:
        sft_man = json.loads((sft / "manifest.json").read_text(encoding="utf-8-sig"))
        checks["sft_ready"] = sft_man.get("status") == "READY_FOR_QLORA"
        checks["main_loss"] = sft_man.get("mainLoss") or []
        checks["unknown_in_main"] = "UNKNOWN" in checks["main_loss"]
        checks["unknown_in_main_loss"] = int(sft_man.get("unknownInMainLoss") or 0)
        if sft_man.get("rejected"):
            failures.append("sft_rejected_rows")
        if not checks["sft_ready"]:
            failures.append("sft_not_ready")
        # v3: abstention must be visible during training, otherwise the UNKNOWN branch is
        # unreachable (v2 trained drift/no_drift only and scored 0/185 on eval_unknown).
        if checks["unknown_in_main_loss"] < 1:
            failures.append("unknown_missing_from_main_loss")

    if checks["sft_splits"]:
        train_n = _count(sft / "train.jsonl")
        dev_n = _count(sft / "development.jsonl")
        checks["sft_counts"] = {
            "train": train_n,
            "development": dev_n,
            "test": _count(sft / "test.jsonl"),
            "eval_unknown": _count(sft / "eval_unknown.jsonl"),
            "eval_no_drift": _count(sft / "eval_no_drift.jsonl"),
        }
        if train_n < 100:
            failures.append("train_too_small")

    if checks["raw_validation"]:
        shortcut = (raw_val.get("shortcut") or {})
        checks["shortcut_baseline"] = shortcut
        if shortcut and shortcut.get("ok") is False:
            failures.append("lowest_id_shortcut_still_solves_task")

    # Regression guard: run the *trainer's own* contract over the real dataset.
    #
    # v3 shipped with every local gate green (validate.mjs, check_readiness, dataset.test.mjs,
    # test_rdmd_qlora_contract) and still crashed on launch, because the trainer had a hardcoded
    # "UNKNOWN is banned in the main loss" rule from v2 that no gate was exercising against the
    # actual data. This check consumes the dataset the same way training will, so a future dataset
    # change that the trainer does not accept fails here instead of 13 hours into a run.
    if checks["sft_splits"] and checks["sft_manifest"]:
        checks["trainer_contract"] = {"ok": False, "detail": ""}
        try:
            spec = importlib.util.spec_from_file_location("_rdmd_trainer", ROOT / "scripts" / "train_qlora_rdmd.py")
            trainer = importlib.util.module_from_spec(spec)
            sys.path.insert(0, str(ROOT / "scripts"))
            spec.loader.exec_module(trainer)
            main_loss = tuple(sft_man.get("mainLoss") or trainer.DEFAULT_MAIN_LOSS)
            trainer.assert_sft_contract(
                trainer.read_jsonl(sft / "train.jsonl"),
                trainer.read_jsonl(sft / "development.jsonl"),
                main_loss,
            )
            checks["trainer_contract"] = {"ok": True, "detail": f"mainLoss={list(main_loss)}"}
        except Exception as exc:  # noqa: BLE001 - any rejection is a readiness failure
            checks["trainer_contract"] = {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}
            failures.append(f"trainer_rejects_dataset:{type(exc).__name__}")

    for key, ok in checks["scripts"].items():
        if not ok:
            failures.append(f"script_missing:{key}")
    if not checks["node"]:
        failures.append("node")
    if not checks["raw_splits"]:
        failures.append("raw_splits")
    if not checks["sft_splits"]:
        failures.append("sft_splits")

    gpu = False
    try:
        import torch
        gpu = bool(torch.cuda.is_available())
        checks["gpu"] = {"available": gpu, "name": torch.cuda.get_device_name(0) if gpu else ""}
    except Exception:
        checks["gpu"] = {"available": False, "name": ""}
    missing_py = [name for name, ok in checks["python_packages"].items() if not ok]
    if missing_py:
        warnings.append(f"python_packages:{','.join(missing_py)}")
    if not gpu:
        warnings.append("gpu_missing_local")

    model_dir = Path(args.model_dir) if args.model_dir else None
    if model_dir:
        checks["model_dir"] = model_dir.is_dir()
        if not model_dir.is_dir():
            warnings.append("model_dir_missing")
    else:
        checks["model_dir"] = "remote_or_hf_id"

    data_ready = not failures
    env_ready = gpu and not missing_py
    status = "READY_TO_TRAIN" if data_ready and env_ready else ("DATA_READY" if data_ready else "BLOCKED")
    result = {
        "schemaVersion": "rdmd-readiness-v1",
        "status": status,
        "dataReady": data_ready,
        "envReady": env_ready,
        "checks": checks,
        "failures": failures,
        "warnings": warnings,
        "rawBaseline": raw_val.get("baseline"),
        "sftSplitCounts": sft_man.get("counts"),
        "recommendedMaxLength": (sft_man.get("tokenAudit") or {}).get("recommendedMaxLength"),
        "next": (
            "python scripts/train_qlora_rdmd.py --data experiments/rdmd_detective_dataset/sft --output experiments/rdmd_runs/qlora-v2 --model $RDMD_BASE_MODEL"
            if data_ready else
            "node experiments/rdmd_detective_dataset/prepare_sft.mjs"
        ),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if data_ready else 1)


def _count(path: Path) -> int:
    return sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip())


def _has_status(path: Path, status: str) -> bool:
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        if json.loads(line).get("status") == status:
            return True
    return False


if __name__ == "__main__":
    main()
