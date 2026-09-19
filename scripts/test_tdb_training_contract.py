import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from tdb_training_contract import ACTIONS, paired_examples
from tdb_completion import encode_completion
from prepare_qwen_decision_data import prepare


def row():
    return {'id': 'instance-1', 'familyId': 'family-1', 'split': 'train',
            'features': dict(capability=1, logic=1, freshness=1, resource=1, risk=.1),
            'arms': {a: {'action': a, 'initialStateHash': 'snapshot-1',
                         'evaluation': {'utility': .2 if a == 'noop' else .7,
                                        'evaluatorVersion': 'test-v1'}} for a in ['noop'] + ACTIONS}}


class TokenizerFixture:
    pad_token_id = 0
    def apply_chat_template(self, messages, tokenize, add_generation_prompt, enable_thinking):
        assert tokenize and not enable_thinking
        prefix = [1, 2, 3]
        return prefix if add_generation_prompt else prefix + [7, 8, 9]


class ContractTests(unittest.TestCase):
    def test_gain_is_paired_continuous_difference(self):
        records, audit = paired_examples([row()])
        self.assertAlmostEqual(records[0]['targets']['replaceAgent'], .5)
        self.assertEqual(audit['evidence_level'], 'unverified')

    def test_missing_and_nontrain_split_rejected(self):
        for split in [None, '', 'test', 'calibration']:
            item = row(); item['split'] = split
            with self.subTest(split=split), self.assertRaisesRegex(ValueError, 'split_violation'):
                paired_examples([item])

    def test_invalid_noop_excludes_entire_episode(self):
        item = row(); item['arms']['noop']['evaluation']['outcome'] = 'infrastructure_invalid'
        with self.assertRaisesRegex(ValueError, 'no_valid_rows'): paired_examples([item])

    def test_reset_mismatch_excludes_episode_but_keeps_audit(self):
        bad = row(); bad['id'] = 'bad'; bad['arms']['replaceAgent']['initialStateHash'] = 'other'
        records, audit = paired_examples([row(), bad])
        self.assertEqual(len(records), 1)
        self.assertEqual(audit['exclusions']['episode:reset_mismatch'], 1)

    def test_na_and_nested_invalid_do_not_drop_other_valid_actions(self):
        item = row()
        item['arms']['restoreHandoff']['applicable'] = False
        item['arms']['restoreHandoff']['evaluation']['utility'] = None
        item['arms']['refreshVersion']['evaluation']['outcome'] = 'infrastructure_invalid'
        records, audit = paired_examples([item])
        self.assertIsNone(records[0]['targets']['restoreHandoff'])
        self.assertIsNone(records[0]['targets']['refreshVersion'])
        self.assertEqual(audit['per_action_rows']['replaceAgent'], 1)

    def test_missing_arm_hash_and_evaluator_are_errors(self):
        for mutation in ['arm', 'hash', 'evaluator']:
            item = row()
            if mutation == 'arm': del item['arms']['restoreHandoff']
            if mutation == 'hash': del item['arms']['restoreHandoff']['initialStateHash']
            if mutation == 'evaluator': del item['arms']['restoreHandoff']['evaluation']['evaluatorVersion']
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): paired_examples([item])

    def test_nonfinite_utilities_features_and_unallowed_fields(self):
        for value in [float('nan'), float('inf'), None, True]:
            item = row(); item['arms']['replaceAgent']['evaluation']['utility'] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'nonfinite'): paired_examples([item])
        item = row(); item['features']['ground_truth'] = 1
        with self.assertRaisesRegex(ValueError, 'feature_schema'): paired_examples([item])
        item = row(); del item['features']['risk']
        with self.assertRaisesRegex(ValueError, 'feature_schema'): paired_examples([item])

    def test_identity_and_evaluator_mismatch(self):
        with self.assertRaisesRegex(ValueError, 'duplicate_instance'): paired_examples([row(), row()])
        item = row(); item['taskFamilyId'] = 'other'
        with self.assertRaisesRegex(ValueError, 'conflicting_identity'): paired_examples([item])
        item = row(); item['arms']['replaceAgent']['evaluation']['evaluatorVersion'] = 'other'
        with self.assertRaisesRegex(ValueError, 'evaluator_version_mismatch'): paired_examples([item])

    def test_prompt_and_padding_are_masked_but_answer_end_token_remains(self):
        enc = encode_completion(TokenizerFixture(), 'question', '{"gain":1}', 8)
        self.assertEqual(enc['labels'], [-100, -100, -100, 7, 8, 9, -100, -100])
        self.assertEqual(enc['attention_mask'], [1, 1, 1, 1, 1, 1, 0, 0])

    def test_truncation_invalid_json_and_template_mismatch_rejected(self):
        with self.assertRaisesRegex(ValueError, 'truncated'): encode_completion(TokenizerFixture(), 'x', '{}', 5)
        for text in ['{"gain":NaN}', '{', '[]']:
            with self.assertRaises(ValueError): encode_completion(TokenizerFixture(), 'x', text, 8)
        class WrongPrefix(TokenizerFixture):
            def apply_chat_template(self, *args, **kw): return [1, 2] if kw['add_generation_prompt'] else [9, 8, 7]
        with self.assertRaisesRegex(ValueError, 'prefix_mismatch'): encode_completion(WrongPrefix(), 'x', '{}', 8)

    def test_transformers_mapping_return_preserves_answer_mask(self):
        from collections import UserDict
        class MappingTokenizer(TokenizerFixture):
            def apply_chat_template(self, *args, **kw):
                values = super().apply_chat_template(*args, **kw)
                return UserDict(input_ids=values, attention_mask=[1] * len(values))
        enc = encode_completion(MappingTokenizer(), 'question', '{"gain":1}', 8)
        self.assertEqual(enc['labels'], [-100, -100, -100, 7, 8, 9, -100, -100])

    def test_preparation_does_not_fabricate_state_gold_or_copy_hidden_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, dst = Path(tmp)/'train.jsonl', Path(tmp)/'sft.jsonl'
            item = row(); item['condition'] = 'SECRET_CANARY'; item['arms']['restoreHandoff']['applicable'] = False
            src.write_text(json.dumps(item)+'\n', encoding='utf-8')
            prepare(src, dst)
            data = json.loads(dst.read_text(encoding='utf-8'))
            self.assertNotIn('SECRET_CANARY', data['prompt'])
            self.assertEqual(set(json.loads(data['completion'])), {'repair_expected_gain'})
            self.assertNotIn('restoreHandoff', json.loads(data['completion'])['repair_expected_gain'])
            self.assertFalse(data['label_mask']['state'])
            with self.assertRaises(FileExistsError): prepare(src, dst)

    def test_all_training_entrypoints_reject_test_before_output_creation(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp)/'test.jsonl'; item = row(); item['split'] = 'test'
            src.write_text(json.dumps(item)+'\n', encoding='utf-8')
            for model in ['lightgbm', 'catboost', 'mlp']:
                output = Path(tmp)/model
                result = subprocess.run([sys.executable, str(root/'scripts'/f'train_uplift_{model}.py'),
                                         '--train', str(src), '--output', str(output)],
                                        cwd=root, capture_output=True, text=True, timeout=15)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('training_split_violation', result.stderr)
                self.assertFalse(output.exists())


if __name__ == '__main__': unittest.main()
