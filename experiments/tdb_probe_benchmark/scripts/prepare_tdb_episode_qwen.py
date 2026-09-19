"""Prepare full authorized dual-agent episode records for QLoRA.

The transcript is preserved in the prompt (after upstream redaction); labels
remain separate and the model is forbidden from certifying projections.
"""
import argparse, hashlib, json
from pathlib import Path

def read(path): return [json.loads(x) for x in Path(path).read_text(encoding='utf-8').splitlines() if x.strip()]
def prompt(row):
    public = {k: row.get(k) for k in ('conversation','toolTrace','eventTrace','gPlan','gExec','tdbPlan','tdbActiveTrace','tdbExec','receiverScope','decisionQuery','privacyPolicy','hardContract')}
    return ('Analyze the authorized, redacted full dual-agent episode. Return JSON only. '
            'Infer dependency dimensions, propose the minimum sufficient disclosure and rank executable evolution steps. '
            'Use UNKNOWN/CONFLICT when evidence is insufficient. Never emit CERTIFIED or hidden/private fields. INPUT=' + json.dumps(public, ensure_ascii=False, sort_keys=True, separators=(',',':')))
def completion(row):
    d = row.get('dependencyGold', {})
    return {'dependency_posterior': d, 'disclosure_proposal': row.get('disclosureGold', {'status':'UNKNOWN'}), 'evolution_priority': row.get('evolutionGold', {'status':'UNKNOWN'})}
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--output',required=True); ap.add_argument('--require-consensus',action='store_true'); a=ap.parse_args(); rows=read(a.input); out=Path(a.output); out.mkdir(parents=True,exist_ok=False)
    if a.require_consensus:
      bad=[r.get('episodeId') for r in rows if not (r.get('consensus') or {}).get('agreement') and (r.get('split') in ('train','development'))]
      if bad: raise SystemExit(f'consensus_required:{len(bad)}')
    for split in ('train','development','calibration','test'):
        selected=[r for r in rows if r.get('split')==split]
        path=out/f'{split}.jsonl'; path.write_text(''.join(json.dumps({'id':r.get('episodeId') or r.get('taskInstanceId'),'familyId':r.get('taskFamilyId'),'split':split,'prompt':prompt(r),'completion':json.dumps(completion(r),ensure_ascii=False,sort_keys=True,separators=(',',':'))},ensure_ascii=False)+'\n' for r in selected),encoding='utf-8')
    manifest={'schemaVersion':'tdb-episode-qwen-data-v1','targets':['dependency_posterior','disclosure_proposal','evolution_priority'],'fullTranscript':True,'redactionRequiredUpstream':True,'testUsed':False,'calibrationUsedForTraining':False,'consensusRequired':a.require_consensus,'inputSha256':hashlib.sha256(Path(a.input).read_bytes()).hexdigest(),'counts':{s:sum(r.get('split')==s for r in rows) for s in ('train','development','calibration','test')}}
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8'); print(json.dumps(manifest))
if __name__=='__main__': main()
