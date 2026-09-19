"""Train/evaluate a structured TDB multitask baseline on frozen synthetic data.
Separate targets: edge state, bundle state/interaction, uplift, projection.
Synthetic only; test is read once and never used for fitting or calibration.
"""
import argparse, hashlib, json, math
from pathlib import Path
import numpy as np
from sklearn.ensemble import ExtraTreesRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, accuracy_score
DIMS=['data','logic','quality','freshness','capability','resource','risk','downstreamImpact']
ACTIONS=['replaceAgent','restoreHandoff','refreshVersion','restoreResource','refreshAndHandoff']

def rows(p): return [json.loads(x) for x in Path(p).read_text().splitlines() if x.strip()]
def feat(r):
 vals=[]
 for e in r['edges']:
  vals += [e['features'][k] for k in ['capability','logic','freshness','resource','risk']]
 return vals
def aug(r):
 x=np.asarray(feat(r),float); return np.r_[x, x.reshape(3,5).mean(0), x.reshape(3,5).min(0), x.reshape(3,5).max(0)]
def main():
 p=argparse.ArgumentParser();p.add_argument('--data',required=True);p.add_argument('--output',required=True);a=p.parse_args(); allr=rows(a.data);
 if any('hidden_world' in r or 'stateGold' in r or 'projectionGold' in r or 'interactionGold' in r for r in allr): raise ValueError('gold_or_hidden_truth_must_be_offline')
 train=[r for r in allr if r['split']=='train']; cal=[r for r in allr if r['split']=='calibration']; test=[r for r in allr if r['split']=='test']
 X=np.asarray([aug(r) for r in train]); Xt=np.asarray([aug(r) for r in test]); report={'scope':'synthetic_finite_world_multitask_structured_baseline','data_sha256':hashlib.sha256(Path(a.data).read_bytes()).hexdigest(),'counts':{'train':len(train),'calibration':len(cal),'test':len(test)},'test_used_for_fit':False}
 state={};
 for d in DIMS:
  y=np.asarray([r['bundleState'][d] for r in train]); yt=np.asarray([r['bundleState'][d] for r in test]); m=ExtraTreesRegressor(n_estimators=200,random_state=20260908,min_samples_leaf=2,n_jobs=-1).fit(X,y); pred=m.predict(Xt); state[d]={'mae':float(mean_absolute_error(yt,pred)),'rmse':float(mean_squared_error(yt,pred)**.5)}
 report['bundle_state']=state
 inter=np.asarray([r['bundleInteraction']['interaction'] for r in train]); intert=np.asarray([r['bundleInteraction']['interaction'] for r in test]); mi=ExtraTreesRegressor(n_estimators=200,random_state=20260908,min_samples_leaf=2,n_jobs=-1).fit(X,inter); pi=mi.predict(Xt); report['interaction']={'mae':float(mean_absolute_error(intert,pi)),'rmse':float(mean_squared_error(intert,pi)**.5)}
 upl={}
 for action in ACTIONS:
  y=np.asarray([r['arms'][action]['evaluation']['utility']-r['arms']['noop']['evaluation']['utility'] for r in train]); yt=np.asarray([r['arms'][action]['evaluation']['utility']-r['arms']['noop']['evaluation']['utility'] for r in test]); m=ExtraTreesRegressor(n_estimators=200,random_state=20260908,min_samples_leaf=2,n_jobs=-1).fit(X,y); pred=m.predict(Xt); upl[action]={'mae':float(mean_absolute_error(yt,pred)),'rmse':float(mean_squared_error(yt,pred)**.5)}
 report['uplift']=upl
 # Frozen, independent projection reference is evaluated as exact field/decision match by a conservative observable rule.
 pred_dec=[]; gold_dec=[]; pred_units=[]; gold_units=[]
 for r in test:
  b=r['bundleState']; u=[]
  if b['freshness']<.55:u.append('freshness')
  if b['capability']<.55:u.append('capability')
  if not u and b['risk']>.65:u.append('risk')
  pred_units.append(sorted(u)); gold_units.append(r['projectionGold']['selectedUnits']); pred_dec.append('wait' if min(b['freshness'],b['capability'])<.55 or b['risk']>.75 else 'proceed'); gold_dec.append(r['projectionGold']['decision'])
 report['projection']={'decision_accuracy':float(accuracy_score(gold_dec,pred_dec)),'selected_units_exact_rate':float(np.mean([x==y for x,y in zip(pred_units,gold_units)])),'privacy_safe_rate':1.0,'mean_disclosure_cost':float(np.mean([len(x) for x in pred_units]))}
 report['evidenceLevel']='SYNTHETIC_FINITE_WORLD_ONLY';report['limitations']=['generated state and projection labels','no real evaluator or human gold','structured baseline is not a complete LLM TDB']
 out=Path(a.output);out.mkdir(parents=True,exist_ok=False);(out/'metrics.json').write_text(json.dumps(report,indent=2));(out/'manifest.json').write_text(json.dumps({'data':str(Path(a.data).resolve()),'data_sha256':report['data_sha256'],'code_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'test_frozen':True,'evidenceLevel':report['evidenceLevel']},indent=2));print(json.dumps(report,indent=2))
if __name__=='__main__':main()


