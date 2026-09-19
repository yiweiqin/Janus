import argparse, json, pathlib, numpy as np
from catboost import CatBoostRegressor

ACTIONS = ['replaceAgent','restoreHandoff','refreshVersion','restoreResource','refreshAndHandoff']
COST = {'replaceAgent':2,'restoreHandoff':1,'refreshVersion':1,'restoreResource':1,'refreshAndHandoff':2}
def load_rows(p):
    return [json.loads(x) for x in pathlib.Path(p).read_text().splitlines() if x.strip()]
def feat(r):
    f=r.get('features',{})
    return [float(f.get(k,0)) for k in ('capability','logic','freshness','resource','risk')]
ap=argparse.ArgumentParser(); ap.add_argument('--model',required=True); ap.add_argument('--test',required=True); ap.add_argument('--output',required=True); a=ap.parse_args()
models={x:CatBoostRegressor().load_model(str(pathlib.Path(a.model)/f'{x}.cbm')) for x in ACTIONS}
out=[]
for r in load_rows(a.test):
    pred={x:float(models[x].predict([feat(r)])[0]) for x in ACTIONS}
    best=max(ACTIONS,key=lambda x:pred[x]-.05*COST[x]); action='noop' if pred[best]-.05*COST[best] <= 0 else best
    actual={x:float(r['arms'][x]['evaluation']['utility']) for x in ['noop']+ACTIONS}
    out.append({'id':r['id'],'familyId':r['familyId'],'action':action,'actual_utility':actual[action],'noop_utility':actual['noop'],'regret':max(actual.values())-actual[action]})
o=pathlib.Path(a.output); o.mkdir(parents=True,exist_ok=True); (o/'predictions.jsonl').write_text('\n'.join(json.dumps(x) for x in out)+'\n')
m={'rows':len(out),'mean_utility':float(np.mean([x['actual_utility'] for x in out])),'noop_utility':float(np.mean([x['noop_utility'] for x in out])),'mean_regret':float(np.mean([x['regret'] for x in out]))}
(o/'metrics.json').write_text(json.dumps(m,indent=2)+'\n'); print(json.dumps(m))
