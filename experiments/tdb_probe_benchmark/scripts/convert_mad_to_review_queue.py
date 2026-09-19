"""Convert human-labelled MAD traces into a reviewable, non-gold queue."""
from __future__ import annotations
import argparse, json, hashlib
from pathlib import Path
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--output',required=True); a=ap.parse_args(); src=Path(a.input); files=sorted(src.glob('*_human.json')) if src.is_dir() else [src]; data=[]
    for f in files:
        try: data.append(json.loads(f.read_text(encoding='utf-8')))
        except Exception: continue
    out=Path(a.output); out.mkdir(parents=True,exist_ok=False); rows=[]
    for i,item in enumerate(data):
        trace=item.get('trajectory') or item.get('messages') or []
        conv=[]
        for j,m in enumerate(trace):
            content=m.get('content','') if isinstance(m,dict) else m; content='\n'.join(content) if isinstance(content,list) else str(content)
            conv.append({'id':f'mad-{i}-{j}','role':m.get('role','agent') if isinstance(m,dict) else 'agent','actorUserId':m.get('name','') if isinstance(m,dict) else '','content':content})
        eid='mad-'+hashlib.sha256(json.dumps(item,sort_keys=True,ensure_ascii=False).encode()).hexdigest()[:20]
        raw_family=str(item.get('instance_id',eid)).split('__',1)[0] or 'external'; rows.append({'schemaVersion':'tdb-episode-contract-v1','taskFamilyId':'mad-'+raw_family,'taskInstanceId':str(item.get('instance_id',eid)),'episodeId':eid,'agentPair':['external_agent_a','external_agent_b'],'conversation':conv,'toolTrace':[],'eventTrace':[],'gPlan':{},'gExec':{},'tdbPlan':{},'tdbActiveTrace':[],'tdbExec':{},'receiverScope':{'source':'external_corpus'},'decisionQuery':'accept_result','privacyPolicy':{'sourceRedaction':'required_before_training'},'hardContract':{'independentCheckerRequired':True},'dependencyGold':{},'disclosureGold':{},'evolutionGold':{},'labelMask':{'dependency':False,'disclosure':False,'evolution':False},'sourceProvenance':{'dataset':'MAD','recordIndex':i,'humanLabelsAvailable':bool(item.get('note'))}})
    source_hash=hashlib.sha256(''.join(f.read_bytes().hex() for f in files).encode()).hexdigest()
    (out/'episodes.raw.jsonl').write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in rows),encoding='utf-8'); (out/'manifest.json').write_text(json.dumps({'schemaVersion':'mad-to-tdb-review-v1','rows':len(rows),'sourceFiles':len(files),'sourceSha256':source_hash,'licenseStatus':'upstream license not found; review before any redistribution','goldPolicy':'external labels are review hints; Janus gold remains independent'},ensure_ascii=False,indent=2),encoding='utf-8'); print(json.dumps({'rows':len(rows),'sourceFiles':len(files),'output':str(out.resolve())}))
if __name__=='__main__': main()
