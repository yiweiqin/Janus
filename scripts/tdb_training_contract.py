"""Input validation for the legacy five-feature paired-uplift baselines.

This validates supplied records, not the truth of their evaluator or replay claims.
It does not certify real-world evidence, state labels or projection sufficiency.
"""
import hashlib
import json
import math
from collections import Counter
from pathlib import Path

ACTIONS = ['replaceAgent', 'restoreHandoff', 'refreshVersion', 'restoreResource', 'refreshAndHandoff']
FEATURES = ['capability', 'logic', 'freshness', 'resource', 'risk']
INVALID = {'infrastructure_invalid', 'evaluator_invalid', 'reset_mismatch', 'replay_invalid'}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_rows(path):
    path = Path(path)
    if path.suffix == '.parquet':
        import pandas as pd
        return pd.read_parquet(path).to_dict('records')
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


def identity(row, legacy, canonical):
    values = [row[k] for k in (legacy, canonical) if k in row]
    if not values or any(not isinstance(v, str) or not v.strip() for v in values):
        raise ValueError(f'missing_identity:{canonical}')
    if len(set(values)) != 1:
        raise ValueError(f'conflicting_identity:{canonical}')
    return values[0]


def finite(value, field):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f'nonfinite_or_missing:{field}')
    return float(value)


def feature_vector(row):
    features = row.get('features')
    if not isinstance(features, dict) or set(features) != set(FEATURES):
        raise ValueError('feature_schema_mismatch:five_observables_required')
    return [finite(features[k], k) for k in FEATURES]


def invalid_reason(record):
    for container in (record, record.get('evaluation', {})):
        if not isinstance(container, dict):
            raise ValueError('malformed_evaluation')
        for key in ('outcome', 'status'):
            if container.get(key) in INVALID:
                return container[key]
        for key in ('reset_mismatch', 'evaluator_invalid'):
            if container.get(key) is True:
                return key
        for key in ('valid', 'resetOk', 'replayOk'):
            if container.get(key) is False:
                return f'{key}=false'
    return None


def paired_examples(rows, expected_split='train'):
    if not rows:
        raise ValueError('empty_dataset')
    seen, result, exclusions = set(), [], Counter()
    versions = set()
    for row in rows:
        ident = identity(row, 'id', 'taskInstanceId')
        family = identity(row, 'familyId', 'taskFamilyId')
        if ident in seen:
            raise ValueError(f'duplicate_instance:{ident}')
        seen.add(ident)
        if row.get('split') != expected_split:
            raise ValueError(f'training_split_violation:{ident}:{row.get("split")}')
        x = feature_vector(row)
        arms = row.get('arms', {})
        if not isinstance(arms, dict) or set(arms) != set(['noop'] + ACTIONS):
            raise ValueError(f'incomplete_action_set:{ident}')
        if any(not isinstance(arm, dict) for arm in arms.values()):
            raise ValueError('malformed_arm')
        for name, arm in arms.items():
            if arm.get('action', name) != name:
                raise ValueError('action_identity_mismatch')
            if 'applicable' in arm and not isinstance(arm['applicable'], bool):
                raise ValueError('applicability_must_be_boolean')
        reason = invalid_reason(row) or invalid_reason(arms['noop'])
        if arms['noop'].get('applicable') is False:
            reason = 'noop_not_applicable'
        if reason:
            exclusions[f'episode:{reason}'] += 1
            continue
        hashes = [arm.get('initialStateHash') for arm in arms.values()]
        if any(not isinstance(h, str) or not h.strip() for h in hashes):
            raise ValueError(f'missing_snapshot_hash:{ident}')
        if len(set(hashes)) != 1:
            exclusions['episode:reset_mismatch'] += 1
            continue
        evaluators = []
        for name, arm in arms.items():
            if arm.get('applicable') is False or invalid_reason(arm):
                continue
            ev = arm.get('evaluation', {})
            version = ev.get('evaluatorVersion')
            if not isinstance(version, str) or not version.strip():
                raise ValueError(f'missing_evaluator_version:{ident}:{name}')
            finite(ev.get('utility'), f'{ident}:{name}:utility')
            evaluators.append(version)
        if len(set(evaluators)) != 1:
            raise ValueError('paired_evaluator_version_mismatch')
        versions.update(evaluators)
        base = finite(arms['noop']['evaluation'].get('utility'), 'noop.utility')
        targets = {}
        for action in ACTIONS:
            arm = arms[action]
            reason = 'not_applicable' if arm.get('applicable') is False else invalid_reason(arm)
            if reason:
                targets[action] = None
                exclusions[f'arm:{action}:{reason}'] += 1
            else:
                targets[action] = finite(arm['evaluation'].get('utility'), action) - base
        if all(v is None for v in targets.values()):
            exclusions['episode:no_valid_target'] += 1
            continue
        result.append({'id': ident, 'familyId': family, 'x': x, 'targets': targets})
    if not result:
        raise ValueError('no_valid_rows')
    if len(versions) != 1:
        raise ValueError('dataset_evaluator_version_mismatch')
    audit = {
        'source_rows': len(rows), 'accepted_rows': len(result),
        'family_count': len({r['familyId'] for r in result}),
        'per_action_rows': {a: sum(r['targets'][a] is not None for r in result) for a in ACTIONS},
        'exclusions': dict(exclusions), 'evaluator_versions': sorted(versions),
        'scope': 'five_feature_paired_uplift_only',
        'evidence_level': 'synthetic_only' if versions == {'invoice-exact-cents-v1'} else 'unverified',
        'replay_independently_verified': False,
    }
    return result, audit
