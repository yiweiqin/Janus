"""Bounded JSONL inference worker; parent owns lifetime. No benchmark gold."""
import argparse
import json
import sys
import time


def main():
    p = argparse.ArgumentParser(); p.add_argument('--model', required=True)
    a = p.parse_args()
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    torch.set_num_threads(4)
    tok = AutoTokenizer.from_pretrained(a.model, local_files_only=True)
    q = BitsAndBytesConfig(load_in_4bit=True,bnb_4bit_quant_type='nf4',
        bnb_4bit_compute_dtype=torch.bfloat16,bnb_4bit_use_double_quant=True)
    model = AutoModelForCausalLM.from_pretrained(a.model,local_files_only=True,
        quantization_config=q,dtype=torch.bfloat16,device_map={'':0}).eval()
    print(json.dumps({'ready':True}),flush=True)
    for line in sys.stdin:
        r = json.loads(line)
        if r.get('stop'): break
        text = tok.apply_chat_template(r['messages'], tokenize=False,
            add_generation_prompt=True,enable_thinking=False)
        x = tok(text,add_special_tokens=False,return_tensors='pt').to(model.device)
        if x['input_ids'].shape[1] > 16000: raise ValueError('context_budget_exceeded')
        start = time.monotonic()
        with torch.inference_mode():
            result = model.generate(**x,do_sample=False,max_new_tokens=512,
                pad_token_id=tok.eos_token_id)
        gen = result[0,x['input_ids'].shape[1]:]
        print(json.dumps({'text':tok.decode(gen,skip_special_tokens=True),
            'input_tokens':x['input_ids'].shape[1],'output_tokens':len(gen),
            'elapsed_seconds':time.monotonic()-start}),flush=True)


if __name__ == '__main__': main()
