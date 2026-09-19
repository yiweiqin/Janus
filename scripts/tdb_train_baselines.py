"""Shared entry point for five-feature uplift baselines (not multi-head models)."""
import argparse
import importlib.metadata
import json
import time
from pathlib import Path
from tdb_training_contract import ACTIONS, FEATURES, digest, load_rows, paired_examples


def train(kind, args):
    if args.calibration:
        raise ValueError('calibration_not_used_for_fitting:use_separate_frozen_calibration_stage')
    examples, audit = paired_examples(load_rows(args.train))
    if any(count == 0 for count in audit['per_action_rows'].values()):
        raise ValueError('action_without_training_support')
    if min(args.epochs, args.iterations, args.n_estimators, args.threads) < 1:
        raise ValueError('positive_iterations_and_threads_required')
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    final_loss = None
    if kind == 'mlp':
        import torch
        from torch import nn
        torch.set_num_threads(args.threads)
        torch.manual_seed(args.seed)
        x = torch.tensor([r['x'] for r in examples], dtype=torch.float32)
        mask = torch.tensor([[r['targets'][a] is not None for a in ACTIONS] for r in examples])
        # Placeholder zeros carry NO gradient: the elementwise loss is masked.
        y = torch.tensor([[r['targets'][a] if r['targets'][a] is not None else 0 for a in ACTIONS]
                          for r in examples], dtype=torch.float32)
        model = nn.Sequential(nn.Linear(5, 64), nn.GELU(), nn.Dropout(.1),
                              nn.Linear(64, 32), nn.GELU(), nn.Linear(32, len(ACTIONS)))
        optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
        for _ in range(args.epochs):
            optimizer.zero_grad()
            loss = (nn.functional.huber_loss(model(x), y, reduction='none') * mask).sum() / mask.sum()
            if not torch.isfinite(loss): raise ValueError('nonfinite_training_loss')
            loss.backward()
            optimizer.step()
        final_loss = float(loss.detach())
        torch.save(model.state_dict(), output / 'model.pt')
        library = 'torch'
    else:
        library = kind
        if kind == 'lightgbm':
            from lightgbm import LGBMRegressor
        else:
            from catboost import CatBoostRegressor
        for action in ACTIONS:
            selected = [r for r in examples if r['targets'][action] is not None]
            x, y = [r['x'] for r in selected], [r['targets'][action] for r in selected]
            if kind == 'lightgbm':
                model = LGBMRegressor(n_estimators=args.n_estimators, learning_rate=args.learning_rate,
                                      num_leaves=args.num_leaves, min_child_samples=args.min_child_samples,
                                      random_state=args.seed, n_jobs=args.threads, verbosity=-1)
                model.fit(x, y)
                model.booster_.save_model(str(output / f'{action}.lgb'))
            else:
                model = CatBoostRegressor(iterations=args.iterations, depth=args.depth,
                                          learning_rate=args.learning_rate, random_seed=args.seed,
                                          thread_count=args.threads, verbose=False, allow_writing_files=False)
                model.fit(x, y)
                model.save_model(str(output / f'{action}.cbm'))
    manifest = {'version': f'{kind}-paired-uplift-v2', **audit, 'seed': args.seed,
                'features': FEATURES, 'actions': ACTIONS, 'source_sha256': digest(args.train),
                'hyperparameters': {k: v for k, v in vars(args).items() if k not in ('train', 'output')},
                'final_loss': final_loss, 'elapsed_seconds': time.monotonic() - started,
                'library': {library: importlib.metadata.version(library)},
                'calibrated': False, 'has_embedding_input': False,
                'model_files': {p.name: digest(p) for p in output.iterdir() if p.is_file()}}
    (output / 'training_manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return manifest


def main(kind):
    parser = argparse.ArgumentParser()
    parser.add_argument('--train', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--calibration')
    parser.add_argument('--seed', '--random-seed', dest='seed', type=int, default=20260906)
    parser.add_argument('--threads', type=int, default=1)
    parser.add_argument('--epochs', type=int, default=50)
    parser.add_argument('--lr', type=float, default=1e-3)
    parser.add_argument('--iterations', type=int, default=800)
    parser.add_argument('--n-estimators', type=int, default=500)
    parser.add_argument('--learning-rate', type=float, default=.03 if kind == 'lightgbm' else .04)
    parser.add_argument('--num-leaves', type=int, default=31)
    parser.add_argument('--min-child-samples', type=int, default=30)
    parser.add_argument('--depth', type=int, default=8)
    print(json.dumps(train(kind, parser.parse_args())))
