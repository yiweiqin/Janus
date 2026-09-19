"""Synthetic leave-one-structure-out transfer evaluation; never reads frozen test."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import numpy as np
from sklearn.ensemble import ExtraTreesClassifier, ExtraTreesRegressor
from sklearn.metrics import accuracy_score, mean_absolute_error

STRUCTURES=['and_bottleneck','or_redundancy','cascade','shared_resource','version_coupling','double_fault']
EDGES=['e0','e1','e2']; ACTIONS=['repair_e0','repair_e1','repair_both']
def read(p): return [json.loads(x) for x in Path(p).read_text(encoding='utf8').splitlines() if x.strip()]
def feat(r):
 o=r['observable']; vals=[]
 for e in EDGES:
  x=o['evidence'][e]; vals += [-1.0 if x['primary'] is None else float(x['primary']),-1.0 if x['secondary'] is None else float(x['secondary']),float(x['missing']),float(x['conflict']),float(x['ageBucket'])]
 vals += [float(r['structure']['kind']==s) for s in STRUCTURES]; vals.append(float(o['riskBudget'])); return vals
def reg(x,y): return ExtraTreesRegressor(n_estimators=240,random_state=20260916,min_samples_leaf=2,n_jobs=-1).fit(x,y)
def main():
 p=argparse.ArgumentParser(); p.add_argument('--public',required=True); p.add_argument('--gold',required=True); p.add_argument('--output',required=True); a=p.parse_args(); pub=read(a.public); gold={r['id']:r for r in read(a.gold)}
 train=[r for r in pub if r['split']=='train']; dev=[r for r in pub if r['split']=='development']; out={}
 for held in STRUCTURES:
  tr=[r for r in train if r['structure']['kind']!=held]; te=[r for r in dev if r['structure']['kind']==held]
  if not tr or not te: out[held]={'rows':len(te),'status':'insufficient_support'}; continue
  x=np.asarray([feat(r) for r in tr]); xt=np.asarray([feat(r) for r in te]); metrics={'rows':len(te),'trainRows':len(tr)}
  state=[]
  for e in EDGES:
   y=[gold[r['id']]['statePosterior'][e]['status'] for r in tr]; yt=[gold[r['id']]['statePosterior'][e]['status'] for r in te]
   classes=sorted(set(y)); model=ExtraTreesClassifier(n_estimators=240,random_state=20260916,min_samples_leaf=2,n_jobs=-1).fit(x,y); state.append(float(accuracy_score(yt,model.predict(xt))))
  metrics['stateStatusAccuracyMean']=float(np.mean(state)); iy=np.asarray([gold[r['id']]['bundleInteraction']['interactionValue'] for r in tr]); it=np.asarray([gold[r['id']]['bundleInteraction']['interactionValue'] for r in te]); metrics['interactionMae']=float(mean_absolute_error(it,reg(x,iy).predict(xt)))
  um=[]
  for act in ACTIONS:
   y=np.asarray([gold[r['id']]['utilityGold'][act]-gold[r['id']]['utilityGold']['noop'] for r in tr]); yt=np.asarray([gold[r['id']]['utilityGold'][act]-gold[r['id']]['utilityGold']['noop'] for r in te]); um.append(mean_absolute_error(yt,reg(x,y).predict(xt)))
  metrics['upliftMaeMean']=float(np.mean(um)); out[held]=metrics
 report={'scope':'synthetic_leave_one_structure_out','evidenceLevel':'SYNTHETIC_FINITE_WORLD_ONLY','publicSha256':hashlib.sha256(Path(a.public).read_bytes()).hexdigest(),'goldSha256':hashlib.sha256(Path(a.gold).read_bytes()).hexdigest(),'testRead':False,'heldOutStructureResults':out,'limitations':['structure is available in public schema and one-hot feature is zero for held-out class','not a real relation-type or agent-pair transfer test']}
 Path(a.output).write_text(json.dumps(report,indent=2),encoding='utf8'); print(json.dumps(report,indent=2))
if __name__=='__main__': main()
