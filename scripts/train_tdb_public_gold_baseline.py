"""Train/evaluate public-input structured baselines against offline gold.
No hidden truth, utility, or gold field is read as a model feature.
"""
import argparse,hashlib,json
from pathlib import Path
import numpy as np
from sklearn.ensemble import ExtraTreesRegressor
from sklearn.metrics import mean_absolute_error,mean_squared_error,accuracy_score
A=['A','B','AB']
def load(p): return [json.loads(x) for x in Path(p).read_text().splitlines() if x.strip()]
def x(r): return [float(r['observable']['public_obs'])]
def main():
 p=argparse.ArgumentParser();p.add_argument('--public',required=True);p.add_argument('--gold',required=True);p.add_argument('--output',required=True);a=p.parse_args(); pub=load(a.public); gold=load(a.gold); gm={r['id']:r for r in gold};
 if set(r['id'] for r in pub)!=set(gm): raise ValueError('public_gold_id_mismatch')
 if any('hidden_world' in r or 'stateGold' in r or 'utilityGold' in r for r in pub): raise ValueError('gold_or_hidden_truth_in_public')
 train=[r for r in pub if r['split']=='train']; test=[r for r in pub if r['split']=='test']; X=np.asarray([x(r) for r in train]); Xt=np.asarray([x(r) for r in test]);
 out={'scope':'synthetic_public_input_offline_gold_baseline','public_sha256':hashlib.sha256(Path(a.public).read_bytes()).hexdigest(),'gold_sha256':hashlib.sha256(Path(a.gold).read_bytes()).hexdigest(),'test_used_for_fit':False,'counts':{'train':len(train),'test':len(test)}}
 # State posterior regression: each edge availability is independently supervised offline.
 state={}
 for i in range(3):
  y=np.asarray([gm[r['id']]['stateGold'][i]['mean'] for r in train]); yt=np.asarray([gm[r['id']]['stateGold'][i]['mean'] for r in test]); m=ExtraTreesRegressor(n_estimators=100,random_state=11,min_samples_leaf=3).fit(X,y); pr=m.predict(Xt); state[f'e{i}']={'mae':float(mean_absolute_error(yt,pr)),'rmse':float(mean_squared_error(yt,pr)**.5)}
 out['state_posterior']=state
 uplift={}
 for act in A:
  y=np.asarray([gm[r['id']]['utilityGold'][act]-gm[r['id']]['utilityGold']['noop'] for r in train]); yt=np.asarray([gm[r['id']]['utilityGold'][act]-gm[r['id']]['utilityGold']['noop'] for r in test]); m=ExtraTreesRegressor(n_estimators=100,random_state=12,min_samples_leaf=3).fit(X,y); pr=m.predict(Xt); uplift[act]={'mae':float(mean_absolute_error(yt,pr)),'rmse':float(mean_squared_error(yt,pr)**.5)}
 out['uplift']=uplift
 # Conservative projection baseline: public observation alone cannot identify hidden worlds; always UNKNOWN.
 proj=[gm[r['id']]['projectionGold'] for r in test]; out['projection']={'status_counts':{s:sum(p['status']==s for p in proj) for s in ['CERTIFIED','UNKNOWN','CONFLICT']},'unknown_rate':float(sum(p['status']=='UNKNOWN' for p in proj)/len(proj)),'model_action':'UNKNOWN','decision_agreement':None,'independent_checker':'not signed by model'}
 out['evidenceLevel']='SYNTHETIC_FINITE_WORLD_ONLY';out['limitations']=['one-bit public observation is deliberately underinformative','projection model is abstain baseline, not trained projection policy','synthetic evaluator and gold']
 o=Path(a.output);o.mkdir(parents=True,exist_ok=False);(o/'metrics.json').write_text(json.dumps(out,indent=2));(o/'manifest.json').write_text(json.dumps({'public_sha256':out['public_sha256'],'gold_sha256':out['gold_sha256'],'code_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'test_frozen':True,'evidenceLevel':out['evidenceLevel']},indent=2));print(json.dumps(out,indent=2))
if __name__=='__main__':main()
