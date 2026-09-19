"""Split controlled episodes into model-visible public input and offline labels."""
import argparse,hashlib,json
from pathlib import Path
def main():
 p=argparse.ArgumentParser();p.add_argument('--input',required=True);p.add_argument('--output',required=True);a=p.parse_args(); out=Path(a.output);out.mkdir(parents=True,exist_ok=False); pub=[];gold=[]
 for line in Path(a.input).read_text().splitlines():
  if not line.strip():continue
  r=json.loads(line); ident=r['id']; pub_arms={k:{'action':v['action'],'applicable':v['applicable'],'cost':v.get('cost',0.)} for k,v in r['arms'].items()}
  pub.append({'id':ident,'familyId':r['familyId'],'split':r['split'],'observable':r['observable'],'edges':[{'edgeId':e['edgeId'],'public':e['public']} for e in r['edges']],'arms':pub_arms})
  gold.append({'id':ident,'familyId':r['familyId'],'split':r['split'],'stateGold':[e['gold'] for e in r['edges']],'interactionGold':r['interactionGold'],'projectionGold':r['projectionGold'],'utilityGold':{k:v['evaluation']['utility'] for k,v in r['arms'].items()},'evaluatorVersions':{k:v['evaluation']['evaluatorVersion'] for k,v in r['arms'].items()},'hidden_world':r['hidden_world']})
 (out/'public.jsonl').write_text(''.join(json.dumps(x,allow_nan=False)+'\n' for x in pub));(out/'gold.offline.jsonl').write_text(''.join(json.dumps(x,allow_nan=False)+'\n' for x in gold)); manifest={'scope':'public_inputs_plus_offline_gold','public_sha256':hashlib.sha256((out/'public.jsonl').read_bytes()).hexdigest(),'gold_sha256':hashlib.sha256((out/'gold.offline.jsonl').read_bytes()).hexdigest(),'hidden_truth_never_model_input':True,'utility_labels_never_model_input':True,'evidenceLevel':'SYNTHETIC_FINITE_WORLD_ONLY'};(out/'manifest.json').write_text(json.dumps(manifest,indent=2));print(json.dumps(manifest))
if __name__=='__main__':main()
