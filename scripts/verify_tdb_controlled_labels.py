"""Independent verifier for controlled TDB labels; does not call generator functions."""
import argparse, hashlib, json
from pathlib import Path
A=['noop','A','B','AB']
def ev(w,a):
 repair={'noop':set(),'A':{0},'B':{1},'AB':{0,1}}[a]; ok=[bool(v) or i in repair for i,v in enumerate(w['edge_ok'])]; return float((ok[0] and ok[1]) or ok[2])
def main():
 p=argparse.ArgumentParser();p.add_argument('--data',required=True);p.add_argument('--output',required=True);a=p.parse_args(); rs=[json.loads(x) for x in Path(a.data).read_text().splitlines() if x.strip()]; failures=[]; valid=0
 for r in rs:
  if 'hidden_world' not in r: failures.append([r.get('id'),'missing_offline_world']);continue
  w=r['hidden_world']; u={k:ev(w,k) for k in A}; arms=r['arms'];
  if any(abs(float(arms[k]['evaluation']['utility'])-u[k])>1e-9 for k in A): failures.append([r['id'],'utility_mismatch']);continue
  expected=u['AB']-u['A']-u['B']+u['noop']
  if abs(float(r['interactionGold']['value'])-expected)>1e-9: failures.append([r['id'],'interaction_mismatch']);continue
  hashes={arms[k]['initialStateHash'] for k in A}; versions={arms[k]['evaluation']['evaluatorVersion'] for k in A}
  if len(hashes)!=1 or len(versions)!=1: failures.append([r['id'],'pair_contract']);continue
  # Only public fields are allowed to reach a model. Hidden world is offline label material.
  if set(r['observable'])-{'public_obs','evidenceRefs'}: failures.append([r['id'],'observable_forbidden_field']);continue
  valid+=1
 report={'scope':'independent_controlled_label_verification','data_sha256':hashlib.sha256(Path(a.data).read_bytes()).hexdigest(),'rows':len(rs),'valid_rows':valid,'failures':failures,'all_valid':not failures,'hidden_world_offline_only':True,'evidenceLevel':'SYNTHETIC_FINITE_WORLD_ONLY'}
 out=Path(a.output);out.mkdir(parents=True,exist_ok=False);(out/'verification.json').write_text(json.dumps(report,indent=2));(out/'manifest.json').write_text(json.dumps({'data_sha256':report['data_sha256'],'verifier_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'scope':report['scope']},indent=2));print(json.dumps(report,indent=2));raise SystemExit(0 if not failures else 2)
if __name__=='__main__':main()
