"""Development-only audit for a trained TDB QLoRA adapter.

Reports schema validity and target metrics. Any projection certificate remains a
proposal until the independent checker validates it; this script never marks a
model certified from confidence or self-consistency.
"""
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


def read(path: Path) -> list[dict]: return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
def finite(value): return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate(obj: dict, gold: dict) -> tuple[bool, str | None]:
    if not isinstance(obj, dict) or set(obj) != {"state_posterior", "bundle_interaction", "counterfactual_uplift", "projection_proposal"}: return False, "top_level_schema"
    if not isinstance(obj["state_posterior"], dict) or set(obj["state_posterior"]) != {"e0", "e1", "e2"}: return False, "state_schema"
    for edge in ["e0", "e1", "e2"]:
        state = obj["state_posterior"][edge]
        if not isinstance(state, dict) or state.get("status") not in {"SUPPORTED", "FAILED", "STALE", "UNKNOWN", "CONFLICT"}: return False, "state_status"
        if state.get("posteriorMean") is not None and not finite(state["posteriorMean"]): return False, "state_mean"
        interval = state.get("interval")
        if interval is not None and (not isinstance(interval, list) or len(interval) != 2 or not all(finite(v) for v in interval)): return False, "state_interval"
    interaction = obj["bundle_interaction"]
    if not isinstance(interaction, dict) or not isinstance(interaction.get("interactionValue"), (int, float)): return False, "interaction_schema"
    uplift = obj["counterfactual_uplift"]
    if not isinstance(uplift, dict) or set(uplift) != {"repair_e0", "repair_e1", "repair_both"}: return False, "uplift_schema"
    for item in uplift.values():
        if not isinstance(item, dict) or not finite(item.get("expected_gain")) or not isinstance(item.get("applicable"), bool) or not finite(item.get("cost")): return False, "uplift_schema"
    projection = obj["projection_proposal"]
    if not isinstance(projection, dict) or projection.get("status") not in {"PROPOSED", "UNKNOWN", "CONFLICT"}: return False, "projection_status"
    if not isinstance(projection.get("selectedUnits"), list) or not isinstance(projection.get("decision"), str): return False, "projection_schema"
    return True, None


def main() -> None:
    parser = argparse.ArgumentParser(); parser.add_argument("--run", required=True); parser.add_argument("--output", required=True); parser.add_argument("--max-new-tokens", type=int, default=1024); args = parser.parse_args()
    run, out = Path(args.run), Path(args.output)
    manifest = json.loads((run / "run_manifest.json").read_text(encoding="utf-8"))
    if manifest.get("status") != "trained": raise ValueError("training_not_complete")
    development = read(run / "development.jsonl")
    if not development: raise ValueError("development_missing")
    out.mkdir(parents=True, exist_ok=False)
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    tok = AutoTokenizer.from_pretrained(run / "adapter", local_files_only=True)
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    base = AutoModelForCausalLM.from_pretrained(manifest["model"], quantization_config=quant, dtype=torch.bfloat16, device_map={"": 0}, local_files_only=True)
    model = PeftModel.from_pretrained(base, run / "adapter").eval(); model.config.use_cache = True
    predictions = []; invalid = 0; started = time.monotonic()
    path = out / "predictions.jsonl"
    eval_manifest_path = out / "eval_manifest.json"
    eval_manifest = {
        "schemaVersion": "tdb-qwen-evaluation-v2", "status": "running", "pid": os.getpid(),
        "hostname": socket.gethostname(), "run": str(run.resolve()), "output": str(out.resolve()),
        "runManifestSha256": hashlib.sha256((run / "run_manifest.json").read_bytes()).hexdigest(),
        "developmentRows": len(development), "processedRows": 0, "invalidRows": 0, "maxNewTokens": args.max_new_tokens,
        "testRead": False, "calibrationRead": False,
    }
    eval_manifest_path.write_text(json.dumps(eval_manifest, indent=2), encoding="utf-8")
    try:
        with path.open("w", encoding="utf-8") as prediction_file:
            for row in development:
                rendered = tok.apply_chat_template([{"role": "user", "content": row["prompt"]}], tokenize=False, add_generation_prompt=True, enable_thinking=False)
                inputs = tok(rendered, return_tensors="pt", add_special_tokens=False).to(model.device)
                with torch.inference_mode(): seq = model.generate(**inputs, max_new_tokens=args.max_new_tokens, do_sample=False, pad_token_id=tok.pad_token_id, eos_token_id=tok.eos_token_id)
                generated = seq[0, inputs["input_ids"].shape[1]:]
                text = tok.decode(generated, skip_special_tokens=True)
                valid = False; reason = None; obj = None
                try:
                    obj = json.loads(text); valid, reason = validate(obj, json.loads(row["completion"]))
                except (ValueError, TypeError, json.JSONDecodeError): reason = "invalid_json"
                if not valid: invalid += 1
                result_row = {"id": row["id"], "familyId": row["familyId"], "output": text, "valid": valid, "reason": reason}
                predictions.append(result_row)
                prediction_file.write(json.dumps(result_row, ensure_ascii=False) + "\n"); prediction_file.flush()
                eval_manifest.update(processedRows=len(predictions), invalidRows=invalid, elapsedSeconds=time.monotonic() - started)
                eval_manifest_path.write_text(json.dumps(eval_manifest, indent=2), encoding="utf-8")
        eval_manifest.update(status="completed", elapsedSeconds=time.monotonic() - started)
    except BaseException as exc:
        eval_manifest.update(status="failed", elapsedSeconds=time.monotonic() - started, failure={"type": type(exc).__name__, "message": str(exc), "traceback": traceback.format_exc()[-12000:]})
        eval_manifest_path.write_text(json.dumps(eval_manifest, indent=2), encoding="utf-8")
        raise
    eval_manifest_path.write_text(json.dumps(eval_manifest, indent=2), encoding="utf-8")
    report = {"scope": "synthetic_development_only_tdb_multitask_qwen", "evidenceLevel": "SYNTHETIC_FINITE_WORLD_ONLY", "rows": len(development), "schemaValidRate": 1 - invalid / len(development), "invalidRows": invalid, "testUsed": False, "calibrationUsed": False, "elapsedSeconds": time.monotonic() - started, "predictionSha256": hashlib.sha256(path.read_bytes()).hexdigest(), "runManifestSha256": hashlib.sha256((run / "run_manifest.json").read_bytes()).hexdigest(), "projectionCertification": "not established by this script", "modelCertificationClaimCount": 0}
    (out / "metrics.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__": main()
