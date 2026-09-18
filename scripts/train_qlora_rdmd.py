"""QLoRA trainer for the RDMD reverse-detective. Reads only train/development SFT rows."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import socket
import time
import traceback
from pathlib import Path

from tdb_completion import encode_completion

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "experiments" / "rdmd_detective_dataset" / "qlora_config.json"
DEFAULT_SFT = ROOT / "experiments" / "rdmd_detective_dataset" / "sft"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


# Statuses trained in the main loss. v2 kept UNKNOWN eval-only, which is exactly why its
# abstention branch was never learned (0/185 on eval_unknown); v3 puts UNKNOWN in the main loss.
# The set is taken from the SFT manifest's `mainLoss` when available, so the dataset declares its
# own contract instead of the trainer hardcoding one that silently goes stale.
DEFAULT_MAIN_LOSS = ("drift", "no_drift", "UNKNOWN")


def assert_sft_contract(train: list[dict], development: list[dict], main_loss=DEFAULT_MAIN_LOSS) -> None:
    if not train or not development:
        raise ValueError("train_and_development_required")
    if {row["graph_id"] for row in train} & {row["graph_id"] for row in development}:
        raise ValueError("graph_id_split_leak")
    allowed = tuple(main_loss)
    for split, rows in (("train", train), ("development", development)):
        for row in rows:
            status = row.get("status")
            if status not in allowed:
                raise ValueError(f"status_not_in_main_loss:{split}:{status}:{row.get('id')}")
            if row.get("supervised") is not True:
                raise ValueError(f"row_not_supervised:{split}:{row.get('id')}")
            prompt = row.get("prompt") or ""
            completion = row.get("completion") or ""
            if "INPUT=" not in prompt:
                raise ValueError(f"prompt_missing_input:{row.get('id')}")
            if completion and completion in prompt:
                raise ValueError(f"prompt_contains_completion:{row.get('id')}")
            gold = json.loads(completion)
            if set(gold) != {"status", "nodeId", "edgeId", "type", "evidenceNodeIds"}:
                raise ValueError(f"completion_schema:{row.get('id')}")
            if gold["status"] not in allowed:
                raise ValueError(f"completion_status_not_in_main_loss:{row.get('id')}")
            # A drift answer must name a culprit; no_drift / UNKNOWN must abstain. This replaces the
            # old "UNKNOWN is banned" rule with the invariant that was actually meant.
            if gold["status"] == "drift":
                if not gold["nodeId"] or not gold["type"]:
                    raise ValueError(f"drift_missing_target:{row.get('id')}")
            elif gold["nodeId"] or gold["type"]:
                raise ValueError(f"non_drift_has_target:{row.get('id')}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=str(DEFAULT_SFT))
    parser.add_argument("--model", default="")
    parser.add_argument("--output", required=True)
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--epochs", type=int, default=0)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--max-length", type=int, default=0)
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--skip-tokenize", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--log-path", default=None)
    args = parser.parse_args()

    cfg = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    data = Path(args.data) / "smoke" if args.smoke else Path(args.data)
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=args.force)

    train_path = data / "train.jsonl"
    dev_path = data / "development.jsonl"
    train = read_jsonl(train_path)
    development = read_jsonl(dev_path)
    sft_manifest = Path(args.data) / "manifest.json"
    sft_meta = json.loads(sft_manifest.read_text(encoding="utf-8-sig")) if sft_manifest.is_file() else {}
    main_loss = tuple(sft_meta.get("mainLoss") or DEFAULT_MAIN_LOSS)
    unknown_in_main = "UNKNOWN" in main_loss
    assert_sft_contract(train, development, main_loss)

    epochs = args.epochs or int(cfg.get("epochs", 2))
    seed = args.seed or int(cfg.get("seed", 20260910))
    max_length = args.max_length or int(cfg.get("maxLength", 16384))
    model_id = args.model or cfg.get("baseModel") or os.environ.get("RDMD_BASE_MODEL") or "Qwen/Qwen3-8B"
    local_only = Path(model_id).is_dir()

    manifest = {
        "schemaVersion": "rdmd-qlora-run-v1",
        "task": "reverse_detective_minimal_drift",
        "dataKind": sft_meta.get("schemaVersion") or "unknown_sft_schema",
        "mainLoss": list(main_loss),
        "model": model_id,
        "seed": seed,
        "epochs": epochs,
        "smoke": bool(args.smoke),
        "pid": os.getpid(),
        "hostname": socket.gethostname(),
        "outputDir": str(out.resolve()),
        "logPath": str(Path(args.log_path).resolve()) if args.log_path else None,
        "testRead": False,
        "unknownInMainLoss": unknown_in_main,
        "assistantOnlyLoss": True,
        "graphLeakage": False,
        "rows": {"train": len(train), "development": len(development)},
        "dataSha256": {"train": digest(train_path), "development": digest(dev_path)},
        "sftManifestSha256": digest(sft_manifest) if sft_manifest.is_file() else "",
        "config": cfg,
        "maxLength": max_length,
        "status": "prepared",
    }

    if args.skip_tokenize or (args.prepare_only and not _transformers_available()):
        manifest["tokenization"] = "skipped"
        write_json(out / "run_manifest.json", manifest)
        print(json.dumps({"status": "prepared", "tokenization": "skipped", "rows": manifest["rows"]}, ensure_ascii=False))
        return

    import torch
    from transformers import AutoTokenizer, set_seed

    set_seed(seed)
    torch.set_num_threads(4)
    print(f"loading_tokenizer {model_id}", flush=True)
    tok = AutoTokenizer.from_pretrained(model_id, local_files_only=local_only, trust_remote_code=True)
    if not isinstance(getattr(tok, "chat_template", None), str) or not str(tok.chat_template).strip():
        raise ValueError("explicit_chat_template_required")
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token

    encoded = {}
    supervised = []
    max_len = 0
    for split, rows in (("train", train), ("development", development)):
        encoded[split] = []
        for index, row in enumerate(rows):
            if index % 200 == 0:
                print(f"encode {split} {index}/{len(rows)}", flush=True)
            item = encode_completion(tok, row["prompt"], row["completion"], max_length)
            length = int(sum(item["attention_mask"]))
            max_len = max(max_len, length)
            supervised.append(sum(label != -100 for label in item["labels"]))
            encoded[split].append({key: value[:length] for key, value in item.items()})
    manifest.update(
        maxTokens=max_len,
        minimumSupervisedTokens=min(supervised) if supervised else 0,
        chatTemplateSha256=hashlib.sha256(tok.chat_template.encode()).hexdigest(),
        gpu=_gpu_info(torch),
        environment={"torch": torch.__version__, "cuda": getattr(torch.version, "cuda", None)},
        tokenization="encoded",
    )
    write_json(out / "run_manifest.json", manifest)
    print(f"encoded maxTokens={max_len} train={len(encoded['train'])} development={len(encoded['development'])}", flush=True)
    if args.prepare_only:
        print(json.dumps({"status": "prepared", "maxTokens": max_len, "rows": manifest["rows"]}, ensure_ascii=False))
        return

    from datasets import Dataset
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from transformers import AutoModelForCausalLM, BitsAndBytesConfig, DataCollatorForSeq2Seq, Trainer, TrainingArguments

    lora = cfg.get("lora") or {}
    quant = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        quantization_config=quant,
        dtype=torch.bfloat16,
        device_map={"": 0},
        local_files_only=local_only,
        trust_remote_code=True,
    )
    model = prepare_model_for_kbit_training(model)
    model = get_peft_model(
        model,
        LoraConfig(
            r=int(lora.get("r", 16)),
            lora_alpha=int(lora.get("alpha", 32)),
            lora_dropout=float(lora.get("dropout", 0.05)),
            target_modules=list(lora.get("targetModules") or ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]),
            task_type="CAUSAL_LM",
        ),
    )
    model.config.use_cache = False
    effective = max(1, int(cfg.get("perDeviceTrainBatchSize", 1)) * int(cfg.get("gradientAccumulationSteps", 16)))
    warmup = max(1, math.ceil(0.03 * len(train) / effective * epochs))
    training = TrainingArguments(
        output_dir=str(out / "checkpoints"),
        num_train_epochs=epochs,
        per_device_train_batch_size=int(cfg.get("perDeviceTrainBatchSize", 1)),
        per_device_eval_batch_size=int(cfg.get("perDeviceEvalBatchSize", 1)),
        gradient_accumulation_steps=int(cfg.get("gradientAccumulationSteps", 16)),
        learning_rate=float(cfg.get("learningRate", 1e-4)),
        bf16=True,
        gradient_checkpointing=True,
        lr_scheduler_type="cosine",
        warmup_steps=warmup,
        logging_steps=10,
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        save_total_limit=2,
        report_to="none",
        seed=seed,
        data_seed=seed,
        dataloader_num_workers=0,
    )
    trainer = Trainer(
        model=model,
        args=training,
        train_dataset=Dataset.from_list(encoded["train"]),
        eval_dataset=Dataset.from_list(encoded["development"]),
        data_collator=DataCollatorForSeq2Seq(tok, padding=True, label_pad_token_id=-100, pad_to_multiple_of=8),
    )
    started = time.time()
    manifest["status"] = "training"
    write_json(out / "run_manifest.json", manifest)
    try:
        result = trainer.train()
        trainer.save_model(str(out / "adapter"))
        tok.save_pretrained(out / "adapter")
        trainer.state.save_to_json(str(out / "trainer_state.json"))
        manifest.update(
            status="trained",
            elapsedSeconds=time.time() - started,
            globalStep=trainer.state.global_step,
            metrics=result.metrics,
            bestCheckpoint=trainer.state.best_model_checkpoint,
            bestDevelopmentLoss=trainer.state.best_metric,
            peakGpuBytes=torch.cuda.max_memory_allocated() if torch.cuda.is_available() else 0,
            adapterSha256={item.name: digest(item) for item in (out / "adapter").iterdir() if item.is_file()},
        )
        write_json(out / "run_manifest.json", manifest)
        print(json.dumps({"status": "trained", "bestDevelopmentLoss": trainer.state.best_metric, "steps": trainer.state.global_step}, ensure_ascii=False))
    except BaseException as exc:
        manifest.update(
            status="failed",
            elapsedSeconds=time.time() - started,
            failure={"type": type(exc).__name__, "message": str(exc), "traceback": traceback.format_exc()[-12000:]},
        )
        write_json(out / "run_manifest.json", manifest)
        raise


def _gpu_info(torch_mod) -> dict:
    if not torch_mod.cuda.is_available():
        return {"available": False}
    return {
        "available": True,
        "index": 0,
        "name": torch_mod.cuda.get_device_name(0),
        "totalBytes": torch_mod.cuda.get_device_properties(0).total_memory,
    }


def _transformers_available() -> bool:
    import importlib.util
    return importlib.util.find_spec("transformers") is not None


if __name__ == "__main__":
    main()
