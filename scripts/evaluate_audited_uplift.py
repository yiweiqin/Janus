"""Development-only base/adapter generation audit; never a held-out result."""
import argparse
from collections import Counter
from contextlib import nullcontext
import hashlib
import json
import math
from pathlib import Path
import time


def read(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--run', required=True)
    p.add_argument('--output', required=True)
    a = p.parse_args()
    run, out = Path(a.run), Path(a.output)
    manifest = json.loads((run / 'run_manifest.json').read_text())
    if manifest['status'] != 'trained': raise ValueError('training_not_complete')
    train, dev = read(run / 'train.jsonl'), read(run / 'development.jsonl')
    if set(r['familyId'] for r in train) & set(r['familyId'] for r in dev):
        raise ValueError('family_overlap')
    out.mkdir(parents=True, exist_ok=False)
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
    from peft import PeftModel
    torch.set_num_threads(4)
    tok = AutoTokenizer.from_pretrained(run / 'adapter', local_files_only=True)
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4',
        bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    base = AutoModelForCausalLM.from_pretrained(manifest['model'], quantization_config=quant,
        dtype=torch.bfloat16, device_map={'': 0}, local_files_only=True)
    model = PeftModel.from_pretrained(base, run / 'adapter').eval()
    model.config.use_cache = True
    unique = {}
    for row in dev:
        key = row['prompt']
        if key in unique and unique[key]['completion'] != row['completion']:
            raise ValueError('ambiguous_repeated_prompt_labels')
        unique[key] = row
    counts = Counter(r['prompt'] for r in dev)
    predictions, metrics = [], {}
    for name in ('base', 'adapter'):
        start = time.monotonic()
        errors, success, regret = [], 0, []
        invalid, tokens = 0, 0
        with (model.disable_adapter() if name == 'base' else nullcontext()):
            for prompt, row in unique.items():
                rendered = tok.apply_chat_template([{'role':'user','content':prompt}],
                    tokenize=False, add_generation_prompt=True, enable_thinking=False)
                inputs = tok(rendered, return_tensors='pt', add_special_tokens=False).to(model.device)
                with torch.inference_mode():
                    seq = model.generate(**inputs, max_new_tokens=160, do_sample=False,
                        pad_token_id=tok.pad_token_id, eos_token_id=tok.eos_token_id)
                generated = seq[0, inputs['input_ids'].shape[1]:]
                text = tok.decode(generated, skip_special_tokens=True)
                tokens += len(generated)
                gold = json.loads(row['completion'])['repair_expected_gain']
                weight = counts[prompt]
                valid, gain, reason = False, None, None
                try:
                    obj = json.loads(text)
                    assert isinstance(obj, dict) and set(obj) == {'repair_expected_gain'}
                    gain = obj['repair_expected_gain']
                    assert isinstance(gain, dict) and set(gain) == set(gold)
                    assert all(isinstance(v,(int,float)) and not isinstance(v,bool)
                        and math.isfinite(v) for v in gain.values())
                    valid = True
                except (ValueError, AssertionError, TypeError): reason = 'invalid_json_or_schema'
                # Invalid output falls back to noop; cost-free diagnostic only.
                action = max({'noop':0.0, **gain}, key={'noop':0.0, **gain}.get) if valid else 'noop'
                realized = 0.0 if action == 'noop' else gold[action]
                best = max(0.0, *gold.values())
                regret.extend([best - realized] * weight)
                success += int(realized == best) * weight
                if valid:
                    errors.extend([gain[k]-gold[k] for k in gold] * weight)
                else: invalid += weight
                predictions.append({'model':name,'development_id':row['id'],
                    'multiplicity':weight,'output':text,'valid':valid,'reason':reason,
                    'selected_action':action,'regret':best-realized})
        metrics[name] = {'rows':len(dev),'unique_prompts':len(unique),
            'schema_valid_rate':1-invalid/len(dev),'invalid_rows':invalid,
            'conditional_valid_mae':sum(abs(x) for x in errors)/len(errors) if errors else None,
            'conditional_valid_rmse':math.sqrt(sum(x*x for x in errors)/len(errors)) if errors else None,
            'mean_regret_with_invalid_noop_fallback':sum(regret)/len(regret),
            'optimal_action_rate':success/len(dev),'generated_tokens_unique_prompts':tokens,
            'elapsed_seconds':time.monotonic()-start}
    predpath = out/'predictions.jsonl'
    predpath.write_text(''.join(json.dumps(r,allow_nan=False)+'\n' for r in predictions))
    report = {'scope':'synthetic_development_only_selected_checkpoint_not_unbiased_test',
        'cost_accounting':'not included; utility-only diagnostic',
        'metrics':metrics,'train_unique_prompts':len({r['prompt'] for r in train}),
        'dev_unique_prompts':len(unique),
        'dev_prompts_also_in_train':len(set(unique) & {r['prompt'] for r in train}),
        'prediction_sha256':hashlib.sha256(predpath.read_bytes()).hexdigest(),
        'run_manifest_sha256':hashlib.sha256((run/'run_manifest.json').read_bytes()).hexdigest(),
        'test_used':False,'no_confidence_or_unknown_claim':True}
    (out/'metrics.json').write_text(json.dumps(report,indent=2,allow_nan=False))
    print(json.dumps(report),flush=True)


if __name__ == '__main__': main()
