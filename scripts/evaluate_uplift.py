#!/usr/bin/env python3
import argparse,json,pathlib,numpy as np
import lightgbm as lgb
ACTIONS=['replaceAgent','restoreHandoff','refreshVersion','restoreResource','refreshAndHandoff']; COST={'replaceAgent':2,'restoreHandoff':1,'refreshVersion':1,'restoreResource':1,'refreshAndHandoff':2}
def rows(p): return [json.loads(x) for x in pathlib.Path(p).read_text().splitlines() if x.strip()]
def feat(r):
 f=r.get('features',{}); return [float(f.get(k,0)) for k in ('capability','logic','freshness','resource','risk')]
ap=argparse.ArgumentParser(); ap.add_argument('--model',required=True); ap.add_argument('--test',required=True); ap.add_argument('--output',required=True); a=ap.parse_args(); models={x:lgb.Booster(model_file=str(pathlib.Path(a.model)/f'{x}.lgb')) for x in ACTIONS}; out=[]
for r in rows(a.test):
 pred={x:float(models[x].predict([feat(r)])[0]) for x in ACTIONS}; candidate=max(pred,key=lambda x:pred[x]-.05*COST[x]); abstain=pred[candidate]-.05*COST[candidate] <= 0; action='noop' if abstain else candidate; noop=float(r['arms']['noop']['evaluation']['utility']); actual={x:float(r['arms'][x]['evaluation']['utility']) for x in ['noop']+ACTIONS}; out.append({'id':r.get('id'),'familyId':r.get('familyId'),'action':action,'predicted_gain':0.0 if abstain else pred[action],'actual_utility':actual[action],'noop_utility':noop,'regret':max(actual.values())-actual[action],'abstain':abstain})
o=pathlib.Path(a.output);o.mkdir(parents=True,exist_ok=True);(o/'predictions.jsonl').write_text('\n'.join(json.dumps(x) for x in out)+'\n'); metrics={'rows':len(out),'mean_utility':float(np.mean([x['actual_utility'] for x in out])),'noop_utility':float(np.mean([x['noop_utility'] for x in out])),'mean_regret':float(np.mean([x['regret'] for x in out])),'abstain_rate':float(np.mean([x['abstain'] for x in out]))};(o/'metrics.json').write_text(json.dumps(metrics,indent=2)+'\n');print(json.dumps(metrics))
