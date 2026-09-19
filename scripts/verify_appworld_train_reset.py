"""Verify repeated fresh initializations on official TRAIN tasks only.

Hashes and evaluator counts are exported; solution text and evaluator reports
are not. This is environment validation, not model or intervention evaluation.
"""
import argparse
import contextlib
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path
import time


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', required=True)
    p.add_argument('--output', required=True)
    a = p.parse_args()
    root, out = Path(a.root), Path(a.output)
    ids_path = root / 'data/datasets/train.txt'
    ids = ids_path.read_text().splitlines()
    selected, seen = [], set()
    for task in ids:
        family = task.rsplit('_', 1)[0]
        if family not in seen:
            selected.append(task); seen.add(family)
        if len(selected) == 3: break
    if len(selected) != 3: raise ValueError('three_train_families_required')
    out.mkdir(parents=True, exist_ok=False)
    from appworld.common.path_store import path_store
    path_store.update_root(str(root))
    from appworld import AppWorld
    rows = []
    for task in selected:
        repeats = []
        for repeat in range(2):
            start = time.monotonic()
            w = None
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                try:
                    w = AppWorld(task_id=task, experiment_name=out.name + f'-r{repeat}',
                        random_seed=20260907, timeout_seconds=30)
                    w.save_state('initial')
                    snap = Path(w.output_checkpoints_directory) / 'initial'
                    hashes = {str(f.relative_to(snap)):sha(f) for f in sorted(snap.rglob('*')) if f.is_file()}
                    if not hashes: raise ValueError('empty_initial_snapshot')
                    ev = w.evaluate(suppress_errors=True)
                    repeats.append({'snapshot_files':hashes,
                        'official_success':bool(ev.success), 'pass_count':ev.pass_count,
                        'fail_count':ev.fail_count,'total_count':ev.total_count,
                        'utility_success':float(bool(ev.success)),
                        'elapsed_seconds':time.monotonic()-start})
                finally:
                    if w is not None: w.close()
        same = repeats[0]['snapshot_files'] == repeats[1]['snapshot_files']
        same_eval = all(repeats[0][k] == repeats[1][k] for k in
            ['official_success','pass_count','fail_count','total_count'])
        row = {'task_id':task,'split':'train','family':task.rsplit('_',1)[0],
            'initial_snapshot_hash_match':same,'noop_evaluator_repeat_match':same_eval,
            'repeats':repeats}
        rows.append(row)
        with (out/'reset_checks.jsonl').open('a') as f: f.write(json.dumps(row)+'\n')
        print(json.dumps({'task':task,'snapshot_match':same,'evaluation_match':same_eval}),flush=True)
    report = {'evidence_level':'OFFICIAL_BENCHMARK_ENVIRONMENT_VALIDATION',
        'appworld_version':importlib.metadata.version('appworld'),
        'train_ids_sha256':sha(ids_path),'script_sha256':sha(Path(__file__)),
        'tasks':selected,'checks_sha256':sha(out/'reset_checks.jsonl'),
        'fresh_initialization_repeat_verified':all(r['initial_snapshot_hash_match'] and
            r['noop_evaluator_repeat_match'] for r in rows),
        'post_mutation_reset_verified':False,'model_evaluated':False,
        'limitations':['official simulated apps, not production user tasks',
            'no intervention outcomes; no training labels',
            'snapshot comparison covers saved initial checkpoint files only']}
    (out/'manifest.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report),flush=True)
    if not report['fresh_initialization_repeat_verified']: raise SystemExit(2)


if __name__ == '__main__': main()
