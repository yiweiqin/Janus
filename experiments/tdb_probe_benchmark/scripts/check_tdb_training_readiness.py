"""Machine-readable pre-training readiness check; human labels are the only allowed blocker."""
from __future__ import annotations
import argparse, importlib.util, json, shutil
from pathlib import Path

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--data-dir', required=True); ap.add_argument('--model-dir'); ap.add_argument('--source-dir'); ap.add_argument('--phase', choices=['pre-human','post-human'], default='pre-human'); args=ap.parse_args()
    checks={'node':shutil.which('node') is not None,'git':shutil.which('git') is not None,
      'training_scripts':all(Path(x).is_file() for x in ['scripts/train_qlora_tdb_multitask.py','experiments/tdb_probe_benchmark/scripts/prepare_tdb_episode_qwen.py','experiments/tdb_probe_benchmark/scripts/validate_tdb_episode.mjs']),
      'annotation_ui':all(Path(x).is_file() for x in ['experiments/tdb_probe_benchmark/scripts/tdb_annotation_server.py','experiments/tdb_probe_benchmark/scripts/tdb_annotation.html']),
      'python_packages':{m:importlib.util.find_spec(m) is not None for m in ('torch','transformers','datasets','peft')}}
    d=Path(args.data_dir); checks.update(data_dir=d.is_dir(),manifest=any((d/f).is_file() for f in ('manifest.json','readiness_manifest.json')))
    episode_file=d/'episodes.cleaned.jsonl'
    if episode_file.is_file():
      try:
        rows=[json.loads(x) for x in episode_file.read_text(encoding='utf-8').splitlines() if x.strip()]
        real=[r for r in rows if str(r.get('sourceProvenance',{}).get('kind','')).startswith('real')]
        checks['dataset_quality']={'rows':bool(rows),'conversation':all(len(r.get('conversation',[]))>=4 for r in real),'toolTrace':all(len(r.get('toolTrace',[]))>0 for r in real),'families':len({str(r.get('taskFamilyId')) for r in rows})>=3}
      except Exception: checks['dataset_quality']=False
    else: checks['dataset_quality']=False
    if args.phase == 'post-human': checks['qwen_splits']=all((d/f'{s}.jsonl').is_file() for s in ('train','development','calibration','test'))
    else: checks['review_queue']=(d/'human_review_queue.jsonl').is_file() or (d/'episodes.cleaned.jsonl').is_file()
    if args.source_dir:
      source=Path(args.source_dir)/'SOURCE_MANIFEST.json'; checks['source_manifest']=source.is_file()
      if source.is_file():
        sm=json.loads(source.read_text(encoding='utf-8')); checks['source_download_complete']=all(x.get('status')=='downloaded' for x in sm.get('records',[])); checks['license_review']=sm.get('licenseStatus','').endswith('approved')
    checks['model_dir'] = (Path(args.model_dir).is_dir() if args.model_dir else 'remote_only_not_required_locally')
    checks['remote_runtime_note']='run this checker inside the remote tdb-venv-large for authoritative GPU/package readiness'
    failures=[]; human_blockers=[]
    for k,v in checks.items():
        if k in ('remote_runtime_note','model_dir','license_review'): continue
        if k in ('source_download_complete','license_review'):
            if v is False: human_blockers.append(k)
        else:
            failures += ([f'{k}:{n}' for n,ok in v.items() if not ok] if isinstance(v,dict) else ([] if v else [k]))
    result={'schemaVersion':'tdb-readiness-v1','checks':checks,'failures':failures,'humanBlockers':human_blockers,'humanReviewOnly':not failures,'status':'READY_FOR_HUMAN_REVIEW' if not failures else 'BLOCKED'}
    print(json.dumps(result,ensure_ascii=False,indent=2)); raise SystemExit(0 if not failures else 1)
if __name__=='__main__': main()
