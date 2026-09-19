"""Completion-only chat encoding; never silently truncate supervised JSON."""
import json
from collections.abc import Mapping


def encode_completion(tokenizer, prompt, completion, max_length):
    target = json.loads(completion, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f'nonfinite_json:{value}')))
    if not isinstance(target, dict):
        raise ValueError('completion_must_be_json_object')
    messages = [{'role': 'user', 'content': prompt}]
    def ids(value):
        if isinstance(value, Mapping): value = value['input_ids']
        # transformers BatchEncoding and some tokenizers return a one-item batch.
        if hasattr(value, 'tolist'): value = value.tolist()
        if value and isinstance(value[0], list):
            if len(value) != 1: raise ValueError('single_conversation_required')
            value = value[0]
        return list(value)
    prefix = ids(tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True, enable_thinking=False))
    full = ids(tokenizer.apply_chat_template(messages + [{'role': 'assistant', 'content': completion}], tokenize=True, add_generation_prompt=False, enable_thinking=False))
    if len(full) < len(prefix) or full[:len(prefix)] != prefix:
        raise ValueError('chat_template_prefix_mismatch')
    answer_start = len(prefix)
    if len(full) > max_length: raise ValueError('completion_would_be_truncated')
    if len(full) <= answer_start: raise ValueError('no_supervised_tokens')
    if tokenizer.pad_token_id is None: raise ValueError('pad_token_required')
    padding = max_length - len(full)
    return {'input_ids': full + [tokenizer.pad_token_id] * padding,
            'attention_mask': [1] * len(full) + [0] * padding,
            'labels': [-100] * answer_start + full[answer_start:] + [-100] * padding}
