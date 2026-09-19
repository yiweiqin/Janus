"""Audited QLoRA training for four TDB proposal heads on frozen train/dev data."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import socket
import traceback
import time
from pathlib import Path

from tdb_completion import encode_completion


def digest(path: Path) -> str: return hashlib.sha256(path.read_bytes()).hexdigest()
def write_json(path: Path, value: dict) -> None: path.write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")
def read(path: Path) -> list[dict]: return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--seed", type=int, default=20260910)
    parser.add_argument("--purpose", default="independent_seed_replication")
    parser.add_argument("--data-kind", choices=["synthetic_multitask", "full_episode"], default="synthetic_multitask")
    parser.add_argument("--log-path", default=None)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    data = Path(args.data); out = Path(args.output); out.mkdir(parents=True, exist_ok=False)
    train = read(data / "train.jsonl"); development = read(data / "development.jsonl")
    if not train or not development: raise ValueError("train_and_development_required")
    if set(row["familyId"] for row in train) & set(row["familyId"] for row in development): raise ValueError("family_leakage")
    projection_statuses = set()
    if args.data_kind == "synthetic_multitask":
        projection_statuses = {
            json.loads(row["completion"])["projection_proposal"]["status"]
            for row in [*train, *development]
        }
        if not projection_statuses <= {"PROPOSED", "UNKNOWN", "CONFLICT"}:
            raise ValueError(f"model_certification_target_forbidden:{sorted(projection_statuses)}")
    data_manifest = data / "manifest.json"
    if not data_manifest.is_file(): raise ValueError("data_manifest_required")

    import torch
    from transformers import AutoTokenizer, set_seed
    set_seed(args.seed); torch.set_num_threads(4)
    tok = AutoTokenizer.from_pretrained(args.model, local_files_only=True)
    if not isinstance(tok.chat_template, str) or not tok.chat_template.strip(): raise ValueError("explicit_chat_template_required")
    if tok.pad_token_id is None: tok.pad_token = tok.eos_token
    encoded = {}; supervised = []; max_len = 0
    for split, rows in (("train", train), ("development", development)):
        encoded[split] = []
        for row in rows:
            item = encode_completion(tok, row["prompt"], row["completion"], 2048)
            length = sum(item["attention_mask"]); max_len = max(max_len, length)
            supervised.append(sum(label != -100 for label in item["labels"]))
            encoded[split].append({key: value[:length] for key, value in item.items()})
        (out / f"{split}.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    config = {
        "epochs": args.epochs,
        "perDeviceTrainBatchSize": 2,
        "perDeviceEvalBatchSize": 2,
        "gradientAccumulationSteps": 8,
        "learningRate": 1e-4,
        "precision": "bf16",
        "quantization": "nf4-double-quant",
        "lora": {"r": 16, "alpha": 32, "dropout": 0.05},
        "scheduler": "cosine",
        "maxLength": 2048,
    }
    manifest = {
        "schemaVersion": "tdb-multitask-qlora-run-v2", "evidenceLevel": ("REAL_AUTHORIZED_EPISODE" if args.data_kind == "full_episode" else "SYNTHETIC_FINITE_WORLD_ONLY"),
        "trainingTargets": (["dependency_posterior", "disclosure_proposal", "evolution_priority"] if args.data_kind == "full_episode" else ["state_posterior", "bundle_interaction", "counterfactual_uplift", "projection_proposal"]),
        "dataKind": args.data_kind,
        "model": args.model, "seed": args.seed, "epochs": args.epochs,
        "purpose": args.purpose, "pid": os.getpid(), "hostname": socket.gethostname(),
        "outputDir": str(out.resolve()), "logPath": str(Path(args.log_path).resolve()) if args.log_path else None,
        "gpu": {"index": 0, "name": torch.cuda.get_device_name(0), "totalBytes": torch.cuda.get_device_properties(0).total_memory},
        "dataSha256": {"train": digest(data / "train.jsonl"), "development": digest(data / "development.jsonl")},
        "dataManifestSha256": digest(data_manifest), "projectionStatusVocabulary": sorted(projection_statuses),
        "modelMayCertifyProjection": False,
        "codeSha256": {"train": digest(Path(__file__)), "completion": digest(Path(__file__).with_name("tdb_completion.py"))},
        "config": config,
        "configSha256": hashlib.sha256(json.dumps(config, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
        "testRead": False, "calibrationRead": False, "familyLeakage": False,
        "rows": {"train": len(train), "development": len(development)}, "maxTokens": max_len,
        "minimumSupervisedTokens": min(supervised), "chatTemplateSha256": hashlib.sha256(tok.chat_template.encode()).hexdigest(),
        "status": "prepared", "projectionCertification": "independent_checker_only",
        "environment": {"torch": torch.__version__, "cuda": torch.version.cuda},
    }
    write_json(out / "run_manifest.json", manifest)
    if args.prepare_only:
        print(json.dumps(manifest)); return

    from datasets import Dataset
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from transformers import AutoModelForCausalLM, BitsAndBytesConfig, DataCollatorForSeq2Seq, Trainer, TrainingArguments
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    model = AutoModelForCausalLM.from_pretrained(args.model, quantization_config=quant, dtype=torch.bfloat16, device_map={"": 0}, local_files_only=True)
    model = prepare_model_for_kbit_training(model)
    model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"], task_type="CAUSAL_LM"))
    model.config.use_cache = False
    training = TrainingArguments(output_dir=str(out / "checkpoints"), num_train_epochs=args.epochs, per_device_train_batch_size=2, per_device_eval_batch_size=2, gradient_accumulation_steps=8, learning_rate=1e-4, bf16=True, gradient_checkpointing=True, lr_scheduler_type="cosine", warmup_steps=max(1, math.ceil(0.03 * len(train) / 16 * args.epochs)), logging_steps=5, eval_strategy="epoch", save_strategy="epoch", load_best_model_at_end=True, metric_for_best_model="eval_loss", greater_is_better=False, save_total_limit=2, report_to="none", seed=args.seed, data_seed=args.seed, dataloader_num_workers=0)
    trainer = Trainer(model=model, args=training, train_dataset=Dataset.from_list(encoded["train"]), eval_dataset=Dataset.from_list(encoded["development"]), data_collator=DataCollatorForSeq2Seq(tok, padding=True, label_pad_token_id=-100, pad_to_multiple_of=8))
    started = time.time(); manifest["status"] = "training"; write_json(out / "run_manifest.json", manifest)
    try:
        result = trainer.train()
        trainer.save_model(str(out / "adapter")); tok.save_pretrained(out / "adapter"); trainer.state.save_to_json(str(out / "trainer_state.json"))
        manifest.update(status="trained", elapsedSeconds=time.time() - started, globalStep=trainer.state.global_step, metrics=result.metrics, bestCheckpoint=trainer.state.best_model_checkpoint, bestDevelopmentLoss=trainer.state.best_metric, peakGpuBytes=torch.cuda.max_memory_allocated(), adapterSha256={item.name: digest(item) for item in (out / "adapter").iterdir() if item.is_file()})
        write_json(out / "run_manifest.json", manifest); print(json.dumps({"status": "trained", "bestDevelopmentLoss": trainer.state.best_metric, "steps": trainer.state.global_step}))
    except BaseException as exc:
        manifest.update(status="failed", elapsedSeconds=time.time() - started, peakGpuBytes=torch.cuda.max_memory_allocated(), failure={"type": type(exc).__name__, "message": str(exc), "traceback": traceback.format_exc()[-12000:]})
        write_json(out / "run_manifest.json", manifest)
        raise


if __name__ == "__main__": main()
