"""Generate an independent finite-world TDB multitask benchmark.
This is synthetic protocol evidence, not real-world evidence.
"""
import argparse, hashlib, json, random
from pathlib import Path
ACTIONS=['noop','replaceAgent','restoreHandoff','refreshVersion','restoreResource','refreshAndHandoff']
DIMS=['data','logic','quality','freshness','capability','resource','risk','downstreamImpact']
def sha(x): return hashlib.sha256(json.dumps(x,sort_keys=True).encode()).hexdigest()
def clamp(x): return max(-1.,min(1.,x))
def make(a):
 r=random.Random(a.seed); rows=[]
 for f in range(a.families):
  split='train' if f<a.families*.5 else ('calibration' if f<a.families*.7 else 'test')
  fb=[r.uniform(-.2,.2) for _ in range(5)]
  for j in range(a.instances):
   edges=[]
   for e in range(3):
    x=[max(.02,min(.98,r.random()+fb[k])) for k in range(5)]
    data,logic,quality,fresh,cap=x
    resource=max(.02,min(.98,r.random()+fb[0])); risk=max(.02,min(.98,r.random()+fb[1]))
    edges.append({'edgeId':f'e{e}','features':{'capability':cap,'logic':logic,'freshness':fresh,'resource':resource,'risk':risk},'state':{'data':data,'logic':logic,'quality':quality,'freshness':fresh,'capability':cap,'resource':resource,'risk':risk,'downstreamImpact':.4+.2*e}})
   # Independent bundle reference: e0/e1 are AND bottleneck; e2 is an OR alternative.
   s=[e['state'] for e in edges]; bundle={d:(min(s[0][d],s[1][d]) if d in ['data','logic','quality','freshness','capability','resource'] else max(s[0][d],s[2][d])) for d in s[0]}
   bundle['risk']=min(1.,.6*s[0]['risk']+.3*s[1]['risk']+.1*s[2]['risk']); bundle['downstreamImpact']=1.0
   dc,dl,df,dr=1-bundle['capability'],1-bundle['logic'],1-bundle['freshness'],1-bundle['resource']
   inter=max(0.,dc*dl)+max(0.,df*dr)
   gains={'replaceAgent':.76*dc+.1*dc*dl,'restoreHandoff':.73*dl+.14*dc*dl,'refreshVersion':.7*df+.13*df*dr,'restoreResource':.68*dr+.12*df*dr,'refreshAndHandoff':.44*dc+.42*dl+.24*df+.18*dr+.18*inter}
   base=.1+.2*r.random(); noise={k:r.uniform(-.01,.01) for k in gains}; utilities={'noop':base}
   for k,v in gains.items(): utilities[k]=max(0.,min(1.,base+v+noise[k]))
   # Independent finite-world projection reference: minimal fields needed to distinguish proceed/wait.
   fields=['freshness','capability','risk']; selected=[]
   if bundle['freshness']<.55: selected.append('freshness')
   if bundle['capability']<.55: selected.append('capability')
   if not selected and bundle['risk']>.65: selected.append('risk')
   decision='wait' if min(bundle['freshness'],bundle['capability'])<.55 or bundle['risk']>.75 else 'proceed'
   ident=f'tdb-{f:03d}-{j:03d}'; snap=sha({'f':f,'j':j,'edges':edges})
   arms={k:{'action':k,'initialStateHash':snap,'applicable':True,'evaluation':{'utility':(utilities[k]),'evaluatorVersion':'tdb-multitask-finite-v1','outcome':'completed'}} for k in ACTIONS}
   rows.append({'id':ident,'familyId':f'tdb-family-{f:03d}','split':split,'edges':edges,'bundleState':bundle,'bundleInteraction':{'and_edges':['e0','e1'],'or_edges':['e2'],'interaction':inter},'arms':arms,'stateGold':edges,'projectionGold':{'selectedUnits':sorted(selected),'decision':decision,'privacySafe':True,'disclosureCost':len(selected)},'observableOnly':True})
 return rows
def main():
 p=argparse.ArgumentParser();p.add_argument('--output',required=True);p.add_argument('--families',type=int,default=100);p.add_argument('--instances',type=int,default=12);p.add_argument('--seed',type=int,default=20260908);a=p.parse_args()
 if a.families<60: raise ValueError('families_too_small')
 rows=make(a); out=Path(a.output);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(''.join(json.dumps(x,allow_nan=False)+'\n' for x in rows));print(json.dumps({'evidenceLevel':'SYNTHETIC_FINITE_WORLD_ONLY','rows':len(rows),'families':a.families,'splits':{s:sum(x['split']==s for x in rows) for s in ['train','calibration','test']},'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'realGeneralizationClaimAllowed':False}))
if __name__=='__main__': main()
