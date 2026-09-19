"""Prepare all non-human TDB training prerequisites from episode JSONL.

Human review is represented as a browser queue; no labels are invented when
an independent evaluator is absent.
"""
from __future__ import annotations
import argparse, hashlib, json, re
from pathlib import Path

REQUIRED = ['taskFamilyId','taskInstanceId','episodeId','agentPair','conversation','toolTrace','eventTrace','gPlan','gExec','tdbPlan','tdbActiveTrace','tdbExec','receiverScope','decisionQuery','privacyPolicy','hardContract','labelMask']
SENSITIVE = re.compile(r'(password|access_token|refresh_token|api_token|secret|private_prompt|private_memory|hidden_state|fault_type|ground_truth|oracle_action|post_action_utility|test_outcome)', re.I)
def read(p): return [json.loads(x) for x in Path(p).read_text(encoding='utf-8').splitlines() if x.strip()]
def walk(v, path=''):
    found=[]
    if isinstance(v, dict):
        for k,x in v.items():
            if SENSITIVE.search(str(k)): found.append(f'{path}.{k}')
            found += walk(x, f'{path}.{k}')
    elif isinstance(v,list):
        for i,x in enumerate(v): found += walk(x, f'{path}[{i}]')
    return found
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--output',required=True); ap.add_argument('--require-pair-disjoint',action='store_true'); a=ap.parse_args(); out=Path(a.output); out.mkdir(parents=True,exist_ok=False)
    rows=read(a.input); errors=[]; queue=[]; clean=[]
    for i,row in enumerate(rows):
        missing=[k for k in REQUIRED if k not in row]; sensitive=walk(row,f'row[{i}]')
        if missing or sensitive: errors.append({'episodeId':row.get('episodeId'), 'missing':missing, 'sensitive':sensitive}); continue
        row['_sourceSha256']=hashlib.sha256(json.dumps(row,ensure_ascii=False,sort_keys=True).encode()).hexdigest(); clean.append(row)
        mask=row.get('labelMask') or {}
        checker=row.get('checker') or {}
        if checker.get('valid') is False or checker.get('checkerStatus') == 'FAIL': errors.append({'episodeId':row.get('episodeId'),'reason':'checker_failed'})
        missing_labels=[k for k in ('dependency','disclosure','evolution') if mask.get(k) is not True]
        if missing_labels: queue.append({'episode':row,'reviewTargets':missing_labels,'status':'pending','reviews':[]})
    synthetic_reference=any(str(r.get('sourceProvenance',{}).get('kind','')).startswith('synthetic') for r in clean)
    # Group by family, agent pair and relation types so variants cannot cross splits.
    def relation_key(r):
        edges=(r.get('gPlan') or {}).get('edges') or []
        rel=sorted(str(e.get('relationType') or e.get('type') or 'unknown') for e in edges if isinstance(e,dict))
        return '|'.join(rel) or 'unknown'
    # Primary split is by task family; pair/relation overlap is measured and
    # optionally made a hard gate when the corpus has enough pairs.
    families=sorted({str(r['taskFamilyId']) for r in clean})
    supplied_splits={str(r.get('split')) for r in clean if r.get('split')}
    valid_supplied=supplied_splits <= {'train','development','calibration','test'} and len(supplied_splits)>0
    family_split={f:('train' if i < len(families)*.7 else 'development' if i < len(families)*.85 else 'calibration') for i,f in enumerate(families)}
    for r in clean:
        if not valid_supplied or not r.get('split'): r['split']=family_split[str(r['taskFamilyId'])]
    # If upstream has frozen train/calibration/test but no development, carve
    # development by whole family from train only; calibration and test remain untouched.
    if valid_supplied and 'development' not in supplied_splits and 'train' in supplied_splits:
        train_families=sorted({str(r['taskFamilyId']) for r in clean if r['split']=='train'})
        cut=max(1, int(len(train_families)*.15)) if len(train_families)>=3 else 0
        development_families=set(train_families[-cut:]) if cut else set()
        for r in clean:
            if r['split']=='train' and str(r['taskFamilyId']) in development_families: r['split']='development'
    if supplied_splits and not valid_supplied: errors.append({'dataset':'split','reason':'invalid_supplied_split','values':sorted(supplied_splits)})
    pair_splits={}
    for r in clean:
        pair='|'.join(sorted(map(str,r.get('agentPair') or []))); pair_splits.setdefault(pair,set()).add(r['split'])
    relation_splits={}
    for r in clean: relation_splits.setdefault(relation_key(r),set()).add(r['split'])
    pair_overlap={k:sorted(v) for k,v in pair_splits.items() if len(v)>1}; relation_overlap={k:sorted(v) for k,v in relation_splits.items() if len(v)>1}
    family_splits={}
    for r in clean: family_splits.setdefault(str(r['taskFamilyId']),set()).add(r['split'])
    family_overlap={k:sorted(v) for k,v in family_splits.items() if len(v)>1}
    if family_overlap: errors.append({'dataset':'split','reason':'family_leakage','families':family_overlap})
    family_split={k:next(iter(v)) for k,v in family_splits.items() if len(v)==1}
    kinds=sorted({r.get('sourceProvenance',{}).get('kind','unknown') for r in clean})
    evidence_level=('SYNTHETIC_REFERENCE_ONLY' if synthetic_reference else 'CONTROLLED_MODEL_EXECUTION' if kinds==['controlled_model_execution'] else 'REAL_AUTHORIZED_EPISODE' if kinds==['real_authorized_episode'] else 'MIXED_OR_UNVERIFIED_PROVENANCE')
    if a.require_pair_disjoint and pair_overlap: errors.append({'dataset':'split','reason':'agent_pair_overlap','pairs':pair_overlap})
    for name,data in [('episodes.cleaned.jsonl',clean),('human_review_queue.jsonl',queue)]: (out/name).write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in data),encoding='utf-8')
    split_counts={s:sum(1 for r in clean if r['split']==s) for s in ('train','development','calibration','test')}
    if len(families)<3 or any(split_counts[s]==0 for s in ('train','development','calibration')): errors.append({'dataset':'split','reason':'insufficient_family_splits','familyCount':len(families),'splitCounts':split_counts})
    split_manifest={'schemaVersion':'tdb-split-manifest-v3','grouping':'supplied_split_frozen' if valid_supplied else 'taskFamilyId_primary_with_pair_relation_overlap_audit','familySplit':family_split,'familyLeakage':bool(family_overlap),'splitCounts':split_counts,'agentPairOverlap':pair_overlap,'relationTypeOverlap':relation_overlap,'pairDisjointRequired':a.require_pair_disjoint,'testFrozen':bool(valid_supplied and 'test' in supplied_splits),'inputSha256':hashlib.sha256(Path(a.input).read_bytes()).hexdigest()}
    split_manifest['sha256']=hashlib.sha256(json.dumps(split_manifest,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    (out/'split_manifest.json').write_text(json.dumps(split_manifest,indent=2,ensure_ascii=False),encoding='utf-8')
    (out/'readiness_manifest.json').write_text(json.dumps({'schemaVersion':'tdb-training-readiness-v1','inputSha256':hashlib.sha256(Path(a.input).read_bytes()).hexdigest(),'rows':len(rows),'cleanRows':len(clean),'invalidRows':len(errors),'families':len(families),'splitCounts':split_counts,'pairOverlapCount':len(pair_overlap),'relationOverlapCount':len(relation_overlap),'splitManifestSha256':split_manifest['sha256'],'humanReviewRows':len(queue),'humanReviewTargets':sorted({t for q in queue for t in q['reviewTargets']}),'testRead':False,'calibrationRead':False,'sensitiveFieldScanPassed':not errors,'evidenceLevel':evidence_level,'sourceKinds':kinds,'familyLeakage':bool(family_overlap),'trainingEligibility':'CONTROLLED_BASELINE_ONLY' if synthetic_reference else ('SUPERVISED_AFTER_CONSENSUS' if not queue else 'HUMAN_REVIEW_REQUIRED'),'status':'READY_FOR_HUMAN_REVIEW' if clean and not errors else 'BLOCKED_INPUT_AUDIT','errors':errors},indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps({'status':'READY_FOR_HUMAN_REVIEW' if clean and not errors else 'BLOCKED_INPUT_AUDIT','rows':len(rows),'cleanRows':len(clean),'humanReviewRows':len(queue),'output':str(out.resolve())},ensure_ascii=False))
    if errors: raise SystemExit(1)
if __name__=='__main__': main()
