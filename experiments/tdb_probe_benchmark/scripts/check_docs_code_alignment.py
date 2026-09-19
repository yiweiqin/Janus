from pathlib import Path
import re, json, sys

ROOT = Path(__file__).resolve().parents[1]
CURRENT = ROOT / 'docs' / 'current'
errors = []
engine = (ROOT / 'engine.mjs').read_text(encoding='utf-8')
readme = (CURRENT / 'README.zh-CN.md').read_text(encoding='utf-8')
if "tdb-probe-benchmark-v1" not in readme:
    errors.append('current README missing engine benchmark version')
if "export const VERSION = 'tdb-probe-benchmark-v1'" not in engine:
    errors.append('engine VERSION is not the documented v1 entry')
for name in ['tdb_multitask_label_contract_v2.json','tdb_training_protocol_v2.json','tdb_preregistration_v1.json','evaluator_contract.json']:
    if not (CURRENT / name).exists(): errors.append(f'missing current contract: {name}')
for name in ['TDB_METHOD_ALIGNMENT_DIRECTIONAL_SCORING_20260909.zh-CN.md','TDB_TRAINING_MATRIX_CURRENT_20260910.zh-CN.md']:
    if (ROOT / name).exists(): errors.append(f'legacy top-level document was not archived: {name}')
training = (Path(__file__).resolve().parents[3] / 'scripts' / 'train_tdb_multitask_v2.py').read_text(encoding='utf-8')
if 'directional_weight' in training or 'directional_scoring' in training:
    errors.append('README pending claim is stale: directional scoring code now exists; update current docs')
if errors:
    print(json.dumps({'ok': False, 'errors': errors}, ensure_ascii=False, indent=2)); sys.exit(1)
print(json.dumps({'ok': True, 'benchmarkVersion': 'tdb-probe-benchmark-v1', 'evidenceBoundary': 'SYNTHETIC_FINITE_WORLD_ONLY'}, ensure_ascii=False, indent=2))
