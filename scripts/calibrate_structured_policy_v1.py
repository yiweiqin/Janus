"""Train on train, select cost multiplier on calibration, evaluate development."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import numpy as np
from sklearn.ensemble import ExtraTreesRegressor

STRUCTURES=['and_bottleneck','or_redundancy','cascade','shared_resource','version_coupling','double_fault']; EDGES=['e0','e1','e2']; ACTIONS=['repair_e0','repair_e1','repair_both']
def read(p): return [json.loads(x) for x in Path(p).read_text(encoding='utf8').splitlines() if x.strip()]
def feat(r):
 o=r['observable']; v=[]
 for e in EDGES:
  x=o['evidence'][e]; v += [-1 if x['primary'] is None else x['primary'],-1 if x['secondary'] is None else x['secondary'],int(x['missing']),int(x['conflict']),x['ageBucket']]
 v += [int(r['structure']['kind']==s) for s in STRUCTURES]; v.append(o['riskBudget']); return v
def policy(models, rows, gold, lam):
 out=[]
 for r in rows:
  x=np.asarray(feat(r)).reshape(1,-1); pred={a:float(models[a].predict(x)[0]) for a in ACTIONS}; costs={z['action']:z['cost'] for z in r['actionCatalog']}; sel=max(['noop',*ACTIONS],key=lambda a:pred.get(a,0)-lam*costs.get(a,0)); gu={a:gold[r['id']]['utilityGold'][a]-gold[r['id']]['utilityGold']['noop'] for a in ACTIONS}; net={'noop':0.0,**{a:gu[a]-costs[a] for a in ACTIONS}}; out.append({'id':r['id'],'selectedAction':sel,'taskRegret':max(0,*gu.values())-(0 if sel=='noop' else gu[sel]),'netRegret':max(net.values())-net[sel]})
 return out
def main():
 p=argparse.ArgumentParser(); p.add_argument('--public',required=True); p.add_argument('--gold',required=True); p.add_argument('--output',required=True); a=p.parse_args(); rows=read(a.public); gold={r['id']:r for r in read(a.gold)}; tr=[r for r in rows if r['split']=='train']; cal=[r for r in rows if r['split']=='calibration']; dev=[r for r in rows if r['split']=='development']; x=np.asarray([feat(r) for r in tr]); models={}
 for act in ACTIONS: models[act]=ExtraTreesRegressor(n_estimators=240,random_state=20260917,min_samples_leaf=2,n_jobs=-1).fit(x,[gold[r['id']]['utilityGold'][act]-gold[r['id']]['utilityGold']['noop'] for r in tr])
 choices=[]
 for lam in [0.0,0.25,0.5,0.75,1.0,1.5,2.0]:
  q=policy(models,cal,gold,lam); choices.append({'lambda':lam,'meanNetRegret':float(np.mean([z['netRegret'] for z in q])),'meanTaskRegret':float(np.mean([z['taskRegret'] for z in q]))})
 selected=min(choices,key=lambda z:z['meanNetRegret']); dq=policy(models,dev,gold,selected['lambda']); report={'scope':'structured_policy_calibration_v1','evidenceLevel':'SYNTHETIC_FINITE_WORLD_ONLY','testRead':False,'trainRows':len(tr),'calibrationRows':len(cal),'developmentRows':len(dev),'candidates':choices,'selected':selected,'development':{'meanNetRegret':float(np.mean([z['netRegret'] for z in dq])),'netOptimalRate':float(np.mean([z['netRegret']==0 for z in dq])),'meanTaskRegret':float(np.mean([z['taskRegret'] for z in dq]))},'publicSha256':hashlib.sha256(Path(a.public).read_bytes()).hexdigest(),'goldSha256':hashlib.sha256(Path(a.gold).read_bytes()).hexdigest()}; Path(a.output).write_text(json.dumps(report,indent=2),encoding='utf8'); print(json.dumps(report,indent=2))
if __name__=='__main__': main()
