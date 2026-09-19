import argparse,json,pathlib,numpy as np,torch
from torch import nn
A=['replaceAgent','restoreHandoff','refreshVersion','restoreResource','refreshAndHandoff']; C={'replaceAgent':2,'restoreHandoff':1,'refreshVersion':1,'restoreResource':1,'refreshAndHandoff':2}
def rows(p): return [json.loads(x) for x in pathlib.Path(p).read_text().splitlines() if x.strip()]
def f(r): return [float(r.get('features',{}).get(k,0)) for k in ('capability','logic','freshness','resource','risk')]
ap=argparse.ArgumentParser();ap.add_argument('--model',required=True);ap.add_argument('--test',required=True);ap.add_argument('--output',required=True);a=ap.parse_args()
m=nn.Sequential(nn.Linear(5,64),nn.GELU(),nn.Dropout(.1),nn.Linear(64,32),nn.GELU(),nn.Linear(32,5));m.load_state_dict(torch.load(pathlib.Path(a.model)/'model.pt',map_location='cpu'));m.eval();out=[]
for r in rows(a.test):
 p=dict(zip(A,m(torch.tensor([f(r)],dtype=torch.float32))[0].detach().numpy().tolist())); best=max(A,key=lambda x:p[x]-.05*C[x]); act='noop' if p[best]-.05*C[best]<=0 else best;u={x:float(r['arms'][x]['evaluation']['utility']) for x in ['noop']+A};out.append({'action':act,'actual_utility':u[act],'noop_utility':u['noop'],'regret':max(u.values())-u[act]})
o=pathlib.Path(a.output);o.mkdir(parents=True,exist_ok=True);mtr={'rows':len(out),'mean_utility':float(np.mean([x['actual_utility'] for x in out])),'noop_utility':float(np.mean([x['noop_utility'] for x in out])),'mean_regret':float(np.mean([x['regret'] for x in out]))};(o/'metrics.json').write_text(json.dumps(mtr,indent=2));print(json.dumps(mtr))
