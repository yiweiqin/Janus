"""Audited synthetic uplift SFT from base weights; development families only.

No held-out test data are read. The task is uplift-only; state/projection heads
require independent labelled data and are not certified by this experiment.
"""
import argparse
import hashlib
import json
import math
import os
import random
import time
from pathlib import Path
from tdb_training_contract import FEATURES, ACTIONS, load_rows, paired_examples, digest
from tdb_completion import encode_completion


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2, allow_nan=False), encoding='utf-8')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--source', required=True)
    p.add_argument('--model', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--epochs', type=int, default=3)
    p.add_argument('--seed', type=int, default=20260907)
    p.add_argument('--prepare-only', action='store_true')
    p.add_argument('--require-diverse-observations', action='store_true')
    a = p.parse_args()
    out = Path(a.output); out.mkdir(parents=True, exist_ok=False)
    import torch
    from transformers import AutoTokenizer, set_seed
    set_seed(a.seed); torch.set_num_threads(4)
    # Caller must provide an explicitly exported train-only file. Mixed files fail closed.
    source = load_rows(a.source)
    rows, audit = paired_examples(source)
    unique_observable_vectors = len({tuple(r['x']) for r in rows})
    if a.require_diverse_observations and unique_observable_vectors < 20:
        raise ValueError(f'too_few_observable_vectors:{unique_observable_vectors}<20')
    families = sorted({r['familyId'] for r in rows}); random.Random(a.seed).shuffle(families)
    dev_families = set(families[:max(1, len(families)//5)])
    if len(families) < 5: raise ValueError('too_few_training_families')
    tok = AutoTokenizer.from_pretrained(a.model, local_files_only=True)
    if not isinstance(tok.chat_template, str) or not tok.chat_template.strip():
        raise ValueError('explicit_chat_template_required')
    if tok.pad_token_id is None: tok.pad_token = tok.eos_token
    records = {'train': [], 'development': []}
    for r in rows:
        features = dict(zip(FEATURES, r['x']))
        gains = {k: v for k, v in r['targets'].items() if v is not None}
        if set(gains) != set(ACTIONS):
            raise ValueError('partial_targets_require_a_separate_masked_action_training_design')
        prompt = ('Predict incremental task utility relative to noop for each candidate repair. '
                  'Return only JSON with repair_expected_gain. Do not claim state or root-cause gold. '
                  'STATE=' + json.dumps({'features': features}, sort_keys=True) +
                  ' CANDIDATE_ACTIONS=' + json.dumps(list(gains)))
        split = 'development' if r['familyId'] in dev_families else 'train'
        records[split].append({'id': r['id'], 'familyId': r['familyId'], 'prompt': prompt,
                              'completion': json.dumps({'repair_expected_gain': gains})})
    encoded, max_len, supervised = {}, 0, []
    for split, data in records.items():
        encoded[split] = []
        for r in data:
            item = encode_completion(tok, r['prompt'], r['completion'], 1024)
            length = sum(item['attention_mask']); max_len = max(max_len, length)
            supervised.append(sum(x != -100 for x in item['labels']))
            # Dynamic batch padding preserves explicit answer-only masks.
            encoded[split].append({k: v[:length] for k, v in item.items()})
        with (out/f'{split}.jsonl').open('x', encoding='utf-8') as f:
            for r in data: f.write(json.dumps(r, allow_nan=False)+'\n')
    manifest = {'evidence_level': 'SYNTHETIC_EXECUTION_ONLY', 'training_target': 'uplift_only',
                'model': a.model, 'seed': a.seed, 'epochs': a.epochs, 'source_sha256': digest(a.source),
                'audit': audit, 'train_families': sorted(set(families)-dev_families),
                'development_families': sorted(dev_families), 'test_used_for_selection': False,
                'split_semantics': 'development drawn only from original train families',
                'rows': {k: len(v) for k,v in records.items()}, 'max_tokens': max_len,
                'minimum_supervised_tokens': min(supervised), 'chat_template_sha256': hashlib.sha256(tok.chat_template.encode()).hexdigest(),
                'code_sha256': {f: digest(Path(__file__).parent/f) for f in ['train_qlora_audited.py','tdb_completion.py','tdb_training_contract.py']},
                'data_sha256': {s: digest(out/f'{s}.jsonl') for s in records},
                'status': 'prepared', 'base_initialization': True,
                'unique_observable_vectors': unique_observable_vectors,
                'target_semantics': 'evaluator utility difference; no policy cost deducted here',
                'uncertainty_trained': False, 'cost_model_trained': False,
                'environment': {'torch': torch.__version__, 'cuda': torch.version.cuda}}
    write_json(out/'run_manifest.json', manifest)
    print(json.dumps(manifest), flush=True)
    if a.prepare_only: return
    from datasets import Dataset
    from transformers import AutoModelForCausalLM, BitsAndBytesConfig, TrainingArguments, Trainer, DataCollatorForSeq2Seq
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4',
                              bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    model = AutoModelForCausalLM.from_pretrained(a.model, quantization_config=quant,
                 dtype=torch.bfloat16, device_map={'': 0}, local_files_only=True)
    model = prepare_model_for_kbit_training(model)
    model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=.05,
                target_modules=['q_proj','k_proj','v_proj','o_proj','gate_proj','up_proj','down_proj'], task_type='CAUSAL_LM'))
    model.config.use_cache = False
    training = TrainingArguments(output_dir=str(out/'checkpoints'), num_train_epochs=a.epochs,
        per_device_train_batch_size=2, per_device_eval_batch_size=2, gradient_accumulation_steps=8,
        learning_rate=2e-4, bf16=True, gradient_checkpointing=True,
        lr_scheduler_type='cosine', warmup_steps=math.ceil(.03 * math.ceil(len(records['train']) / 16) * a.epochs),
        logging_steps=5, eval_strategy='epoch', save_strategy='epoch',
        load_best_model_at_end=True, metric_for_best_model='eval_loss', greater_is_better=False,
        save_total_limit=2, report_to='none', seed=a.seed, data_seed=a.seed, dataloader_num_workers=0)
    trainer = Trainer(model=model, args=training, train_dataset=Dataset.from_list(encoded['train']),
        eval_dataset=Dataset.from_list(encoded['development']),
        data_collator=DataCollatorForSeq2Seq(tok, padding=True, label_pad_token_id=-100, pad_to_multiple_of=8))
    started = time.time(); manifest['status']='training'; write_json(out/'run_manifest.json', manifest)
    result = trainer.train()
    trainer.save_model(str(out/'adapter')); tok.save_pretrained(out/'adapter')
    trainer.state.save_to_json(str(out/'trainer_state.json'))
    manifest.update(status='trained', elapsed_seconds=time.time()-started,
        metrics=result.metrics, best_checkpoint=trainer.state.best_model_checkpoint,
        best_development_loss=trainer.state.best_metric,
        peak_gpu_bytes=torch.cuda.max_memory_allocated(),
        adapter_sha256={f.name: digest(f) for f in (out/'adapter').iterdir() if f.is_file()})
    write_json(out/'run_manifest.json', manifest)
    print(json.dumps({'status':'trained','steps':trainer.state.global_step,'best_development_loss':trainer.state.best_metric}),flush=True)


if __name__ == '__main__': main()
