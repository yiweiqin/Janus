"""Score RDMD detective predictions against SFT gold. Never used as training input."""
from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SFT = ROOT / "experiments" / "rdmd_detective_dataset" / "sft"
TYPES = {"missing_dependency", "wrong_agent", "wrong_version", "wrong_acceptance", "local_replan"}


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def parse_completion(text: str) -> dict:
    raw = str(text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?", "", raw).strip()
        raw = raw.split("```", 1)[0].strip()
    match = re.search(r"\{.*\}", raw, re.S)
    if not match:
        return {"status": "UNKNOWN", "nodeId": "", "edgeId": "", "type": "", "evidenceNodeIds": [], "parseError": True}
    try:
        value = json.loads(match.group(0))
    except json.JSONDecodeError:
        return {"status": "UNKNOWN", "nodeId": "", "edgeId": "", "type": "", "evidenceNodeIds": [], "parseError": True}
    status = value.get("status") if value.get("status") in {"drift", "no_drift", "UNKNOWN"} else "UNKNOWN"
    type_name = value.get("type") if value.get("type") in TYPES else ""
    evidence = value.get("evidenceNodeIds") if isinstance(value.get("evidenceNodeIds"), list) else []
    return {
        "status": status,
        "nodeId": str(value.get("nodeId") or ""),
        "edgeId": str(value.get("edgeId") or ""),
        "type": type_name if status == "drift" else "",
        "evidenceNodeIds": [str(item) for item in evidence],
        "parseError": False,
    }


def score_rows(rows: list[dict], preds: dict[str, dict] | None = None) -> dict:
    groups = defaultdict(lambda: {"n": 0, "statusHit": 0, "nodeHit": 0, "typeHit": 0, "unknown": 0, "parseError": 0, "extraEvidence": 0})
    for row in rows:
        gold = parse_completion(row["completion"])
        pred = preds[row["id"]] if preds and row["id"] in preds else parse_completion(row.get("prediction") or "")
        if preds is None and "prediction" not in row:
            continue
        bucket = groups[gold["status"]]
        bucket["n"] += 1
        if pred.get("parseError"):
            bucket["parseError"] += 1
        if pred["status"] == gold["status"]:
            bucket["statusHit"] += 1
        if pred["status"] == "UNKNOWN":
            bucket["unknown"] += 1
        if gold["status"] == "drift":
            if pred["status"] == "drift" and pred["nodeId"] == gold["nodeId"]:
                bucket["nodeHit"] += 1
            if pred["type"] == gold["type"] and gold["type"]:
                bucket["typeHit"] += 1
            extra = [item for item in pred["evidenceNodeIds"] if item and item != gold["nodeId"]]
            bucket["extraEvidence"] += len(extra)
    report = {}
    for status, bucket in groups.items():
        n = bucket["n"] or 1
        report[status] = {
            "n": bucket["n"],
            "statusHit": bucket["statusHit"] / n if bucket["n"] else 0,
            "nodeHit": bucket["nodeHit"] / n if bucket["n"] else 0,
            "typeHit": bucket["typeHit"] / n if bucket["n"] else 0,
            "unknownRate": bucket["unknown"] / n if bucket["n"] else 0,
            "parseErrorRate": bucket["parseError"] / n if bucket["n"] else 0,
            "meanExtraEvidence": bucket["extraEvidence"] / n if bucket["n"] else 0,
        }
    return report


def load_predictions(path: Path) -> dict[str, dict]:
    preds = {}
    for row in read_jsonl(path):
        text = row.get("prediction") or row.get("completion") or row.get("output") or ""
        preds[row["id"]] = parse_completion(text)
    return preds


def generate_predictions(rows: list[dict], model: str, adapter: str, max_new_tokens: int = 160) -> list[dict]:
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(adapter or model, trust_remote_code=True)
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token
    base = AutoModelForCausalLM.from_pretrained(model, dtype=torch.bfloat16, device_map={"": 0}, trust_remote_code=True)
    model_obj = PeftModel.from_pretrained(base, adapter) if adapter else base
    model_obj.eval()
    out_rows = []
    for index, row in enumerate(rows, start=1):
        messages = [{"role": "user", "content": row["prompt"]}]
        encoded = tok.apply_chat_template(messages, tokenize=True, add_generation_prompt=True, enable_thinking=False, return_tensors="pt")
        if hasattr(encoded, "keys"):
            prompt_ids = encoded["input_ids"]
            attention_mask = encoded.get("attention_mask")
        else:
            prompt_ids = encoded
            attention_mask = None
        prompt_ids = prompt_ids.to(model_obj.device)
        gen_kwargs = {"max_new_tokens": max_new_tokens, "do_sample": False}
        if attention_mask is not None:
            gen_kwargs["attention_mask"] = attention_mask.to(model_obj.device)
        with torch.no_grad():
            gen = model_obj.generate(prompt_ids, **gen_kwargs)
        text = tok.decode(gen[0][prompt_ids.shape[-1]:], skip_special_tokens=True)
        if index % 100 == 0:
            print(f"[eval] {index}/{len(rows)}", flush=True)
        out_rows.append({"id": row["id"], "graph_id": row.get("graph_id"), "status": row.get("status"), "prediction": text, "gold": row["completion"]})
    return out_rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=str(DEFAULT_SFT))
    parser.add_argument("--split", default="test", choices=["test", "eval_unknown", "eval_no_drift", "development"])
    parser.add_argument("--predictions")
    parser.add_argument("--model", default="")
    parser.add_argument("--adapter", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--baseline", default=str(DEFAULT_SFT / "baseline.json"))
    args = parser.parse_args()

    data = Path(args.data)
    rows = read_jsonl(data / f"{args.split}.jsonl")
    preds = load_predictions(Path(args.predictions)) if args.predictions else None
    generated = None
    if preds is None and args.adapter:
        generated = generate_predictions(rows, args.model, args.adapter)
        preds = {row["id"]: parse_completion(row["prediction"]) for row in generated}
        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in generated), encoding="utf-8")
    if preds is None:
        report = {
            "status": "WAITING_FOR_PREDICTIONS",
            "split": args.split,
            "n": len(rows),
            "note": "pass --predictions jsonl or --adapter after training",
        }
    else:
        scored = score_rows(rows, preds)
        report = {"status": "scored", "split": args.split, "n": len(rows), "metrics": scored}
        baseline_path = Path(args.baseline)
        if baseline_path.is_file():
            report["baseline"] = json.loads(baseline_path.read_text(encoding="utf-8"))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.output and preds is not None and generated is None:
        Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
