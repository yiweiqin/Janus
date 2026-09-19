"""Re-score structured policy predictions with task utility and net utility separately."""
from __future__ import annotations
import argparse, json, hashlib
from pathlib import Path
import numpy as np

def read(path: Path): return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]

def main():
    p=argparse.ArgumentParser(); p.add_argument('--public',required=True); p.add_argument('--predictions',required=True); p.add_argument('--output',required=True); args=p.parse_args()
    public={r['id']:r for r in read(Path(args.public))}; predictions=read(Path(args.predictions)); rows=[]
    for pred in predictions:
        row=public[pred['id']]; costs={a['action']:float(a['cost']) for a in row['actionCatalog']}; selected=pred['selectedAction']
        uplift={k:float(v) for k,v in pred['goldUplift'].items()}; uplift['noop']=0.0
        net={a:u-costs.get(a,0.0) for a,u in uplift.items()}
        best_u=max(uplift.values()); best_net=max(net.values())
        realized_u=uplift[selected]; realized_net=net[selected]
        rows.append({'id':pred['id'],'selectedAction':selected,'goldUplift':uplift,'costs':costs,'goldNetUtility':net,'taskUtilityRegret':best_u-realized_u,'netUtilityRegret':best_net-realized_net,'selectedNetUtility':realized_net})
    report={'scope':'structured_policy_independent_rescore_v1','evidenceLevel':'SYNTHETIC_FINITE_WORLD_ONLY','testRead':False,'rows':len(rows),'taskUtility':{'meanRegret':float(np.mean([r['taskUtilityRegret'] for r in rows])),'optimalRate':float(np.mean([r['taskUtilityRegret']==0 for r in rows]))},'netUtility':{'meanRegret':float(np.mean([r['netUtilityRegret'] for r in rows])),'optimalRate':float(np.mean([r['netUtilityRegret']==0 for r in rows]))},'publicSha256':hashlib.sha256(Path(args.public).read_bytes()).hexdigest()}
    out=Path(args.output); out.parent.mkdir(parents=True,exist_ok=True); out.write_text(json.dumps({'report':report,'rows':rows},indent=2),encoding='utf-8'); print(json.dumps(report,indent=2))
if __name__=='__main__': main()
