"""Observable-support diagnostics, not a certificate of generalization.

The optional minimum is a compute-budget heuristic. Exact overlap is not by
itself family leakage and disjoint vectors do not establish real diversity.
"""
import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path

from tdb_training_contract import load_rows, paired_examples, feature_vector


def feature_key(raw):
    return json.dumps(feature_vector(raw), separators=(',', ':'))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--source', required=True)
    p.add_argument('--min-features', type=int, default=20,
                   help='optional project compute-budget screen, not a statistical minimum')
    p.add_argument('--min-feature-family-coverage', type=int, default=2)
    p.add_argument('--require-disjoint-dev', action='store_true')
    p.add_argument('--development')
    a = p.parse_args()
    if a.min_features < 1 or a.min_feature_family_coverage < 1:
        raise ValueError('thresholds_must_be_positive')
    raw = load_rows(a.source)
    train_raw = [r for r in raw if r.get('split') == 'train']
    rows, audit = paired_examples(train_raw)
    feature_families = defaultdict(set)
    feature_targets = defaultdict(set)
    for row in rows:
        key = json.dumps(row['x'], separators=(',', ':'))
        feature_families[key].add(row['familyId'])
        feature_targets[key].add(json.dumps(row['targets'], sort_keys=True, allow_nan=False))
    result = {
        'source_sha256': hashlib.sha256(Path(a.source).read_bytes()).hexdigest(),
        'scope': 'training observable support only; does not certify generalization',
        'source_mixed_splits': sorted({str(r.get('split')) for r in raw}),
        'training_contract_audit': audit,
        'rows': len(rows), 'families': len({r['familyId'] for r in rows}),
        'unique_observable_vectors': len(feature_families),
        'vectors_with_multiple_families': sum(len(v) >= a.min_feature_family_coverage for v in feature_families.values()),
        'target_variants_per_vector': {k: len(v) for k, v in feature_targets.items()},
        'feature_family_counts': {k: len(v) for k, v in feature_families.items()},
        'thresholds': {'min_features': a.min_features, 'min_feature_family_coverage': a.min_feature_family_coverage},
    }
    issues = []
    if result['unique_observable_vectors'] < a.min_features:
        issues.append('below_requested_compute_budget_support_threshold')
    if a.require_disjoint_dev:
        if not a.development: raise ValueError('development_required')
        dev = load_rows(a.development)
        train_keys = {feature_key(r) for r in train_raw}
        dev_keys = {feature_key(r) for r in dev}
        result['train_dev_vector_overlap'] = len(train_keys & dev_keys)
        if result['train_dev_vector_overlap']:
            issues.append('development_observable_vector_overlap')
    result['pass'] = not issues
    result['issues'] = issues
    print(json.dumps(result, indent=2, allow_nan=False))
    if issues: raise SystemExit(2)


if __name__ == '__main__': main()
