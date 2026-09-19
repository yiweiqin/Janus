"""Controlled synthetic TDB data: labels come from an independent finite evaluator.
Hidden world fields never enter observable inputs. Evidence level is synthetic only.
"""
import argparse, hashlib, json, random
from pathlib import Path
ACTIONS=['noop','A','B','AB']
def digest(x): return hashlib.sha256(json.dumps(x,sort_keys=True).encode()).hexdigest()
def utility(world, action):
  # Independent evaluator: success requires (edge0 AND edge1) OR edge2.
  repaired=set({'A': [0], 'B': [1], 'AB':[0,1], 'noop':[]}[action])
  ok=[bool(v) or i in repaired for i,v in enumerate(world['edge_ok'])]
  success=(ok[0] and ok[1]) or ok[2]
  # Utility is task success only; costs are recorded separately.
  return float(success)
def projection_reference(worlds, obs):
  compatible=[w for w in worlds if w['public_obs']==obs]
  decisions={('proceed' if utility(w,'noop') else 'wait') for w in compatible}
  if len(decisions)!=1: return {'status':'UNKNOWN','selectedUnits':[],'decision':'UNKNOWN','privacySafe':True,'disclosureCost':0}
  return {'status':'CERTIFIED','selectedUnits':['task_success_observed'],'decision':next(iter(decisions)),'privacySafe':True,'disclosureCost':1}
def main():
 p=argparse.ArgumentParser();p.add_argument('--output',required=True);p.add_argument('--families',type=int,default=100);p.add_argument('--instances',type=int,default=12);p.add_argument('--seed',type=int,default=20260909);a=p.parse_args(); rng=random.Random(a.seed); rows=[]
 for f in range(a.families):
  split='train' if f<a.families*.5 else ('calibration' if f<a.families*.7 else 'test'); bias=rng.random()
  for j in range(a.instances):
   worlds=[]
   for wid in range(4):
    edge_ok=[rng.random()<.65 for _ in range(3)]; public_obs=int(sum(edge_ok[:2])>=1) # intentionally ambiguous observation
    worlds.append({'id':f'w{wid}','edge_ok':edge_ok,'public_obs':public_obs})
   world=worlds[0]; obs=world['public_obs']; utilities={a2:utility(world,a2) for a2 in ACTIONS}; costs={'noop':0.,'A':.1,'B':.1,'AB':.2}
   snap=digest({'f':f,'j':j,'world':world,'obs':obs})
   arms={a2:{'action':a2,'initialStateHash':snap,'applicable':True,'evaluation':{'utility':utilities[a2],'evaluatorVersion':'tdb-controlled-evaluator-v1','outcome':'completed'},'cost':costs[a2]} for a2 in ACTIONS}
   edges=[]
   for i,ok in enumerate(world['edge_ok']): edges.append({'edgeId':f'e{i}','public':{'available':public_obs,'evidenceRefs':[f'obs-{f}-{j}']},'gold':{'status':'SUPPORTED' if ok else 'FAILED','mean':float(ok),'interval':[float(ok),float(ok)],'label_mask':True}})
   interaction=utilities['AB']-utilities['A']-utilities['B']+utilities['noop']
   rows.append({'id':f'tdbc-{f:03d}-{j:03d}','familyId':f'tdbc-family-{f:03d}','split':split,'observable':{'public_obs':obs,'evidenceRefs':[f'obs-{f}-{j}']},'edges':edges,'arms':arms,'interactionGold':{'A':'A','B':'B','AB':'AB','value':interaction,'label_mask':True,'source':'paired_combination_evaluator'},'projectionGold':projection_reference(worlds,obs),'hidden_world':world})
 out=Path(a.output);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(''.join(json.dumps(r,allow_nan=False)+'\n' for r in rows)); print(json.dumps({'evidenceLevel':'SYNTHETIC_FINITE_WORLD_ONLY','generator':'tdb-controlled-evaluator-v1','rows':len(rows),'families':a.families,'splits':{s:sum(x['split']==s for x in rows) for s in ['train','calibration','test']},'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'testFrozen':True,'hiddenFieldsExcludedFromInput':True}))
if __name__=='__main__':main()
