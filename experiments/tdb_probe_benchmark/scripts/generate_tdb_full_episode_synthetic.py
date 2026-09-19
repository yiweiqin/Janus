"""Create reproducible full-transcript TDB episodes from the independent
controlled evaluator. Hidden world fields never enter the model-visible input.
"""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path

DIMS=['data','logic','quality','freshness','review','capability','resource','risk','downstreamImpact','uncertainty']
def read(p): return [json.loads(x) for x in Path(p).read_text(encoding='utf-8').splitlines() if x.strip()]
def main():
  ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--output',required=True); a=ap.parse_args(); out=Path(a.output); out.mkdir(parents=True,exist_ok=False)
  rows=[]
  for src in read(a.input):
    ident=src['id']; family=src['familyId']; edge_gold={}
    for edge in src.get('edges',[]):
      g=edge.get('gold',{}); val=float(g.get('mean',0)); edge_gold[edge['edgeId']]={'dimensions':{d:{'mean':val,'interval':[val,val],'status':g.get('status','UNKNOWN'),'evidenceRefs':edge.get('public',{}).get('evidenceRefs',[]),'sourceVersion':'tdb-controlled-evaluator-v1','label_mask':True} for d in DIMS},'labelSource':'independent_controlled_evaluator'}
    proj=src.get('projectionGold',{})
    arms=src.get('arms',{}); noop=float(arms.get('noop',{}).get('evaluation',{}).get('utility',0)); gains={k:float(v.get('evaluation',{}).get('utility',0))-noop for k,v in arms.items() if k!='noop'}
    candidate=max(gains,key=gains.get) if gains else 'noop'; cost=float(arms.get(candidate,{}).get('cost',0))
    evolution={'candidateEdgeId':candidate,'causeSet':['edge'] if candidate!='noop' else [],'priorityScore':max(0.0,gains.get(candidate,0))/(cost+1e-6),'expectedLocalGain':gains.get(candidate,0),'expectedTransferGain':None,'negativeTransferRisk':None,'orderedSteps':[{'action':candidate,'reason':'paired evaluator gain'}] if candidate!='noop' else [],'labelSource':'paired_noop_controlled_evaluator'}
    conversation=[
      {'id':ident+'-m0','role':'requester','actorUserId':'agent-a','content':'Please produce the requested result and report evidence.', 'occurredAt':'2026-01-01T00:00:00Z'},
      {'id':ident+'-m1','role':'recipient','actorUserId':'agent-b','content':'I will inspect the dependency inputs and return a versioned result.', 'occurredAt':'2026-01-01T00:00:01Z'},
      {'id':ident+'-m2','role':'recipient','actorUserId':'agent-b','content':f'Result submitted for episode {ident}; downstream acceptance is pending review.', 'occurredAt':'2026-01-01T00:00:02Z'}]
    events=[{'eventKind':'task_created','sourceKind':'synthetic_controlled_evaluator','occurredAt':'2026-01-01T00:00:00Z'},{'eventKind':'execution_started','sourceKind':'synthetic_controlled_evaluator','occurredAt':'2026-01-01T00:00:01Z'},{'eventKind':'result_submitted','sourceKind':'synthetic_controlled_evaluator','occurredAt':'2026-01-01T00:00:02Z'}]
    rows.append({'schemaVersion':'tdb-episode-contract-v1','taskFamilyId':family,'taskInstanceId':ident,'episodeId':ident,'agentPair':['agent-a','agent-b'],'conversation':conversation,'toolTrace':[],'eventTrace':events,'gPlan':{'nodes':['agent-a','agent-b'],'edges':[{'edgeId':e['edgeId'],'from':'agent-a','to':'agent-b'} for e in src.get('edges',[])]},'gExec':{'nodes':['agent-a','agent-b'],'edges':[{'edgeId':e['edgeId'],'from':'agent-a','to':'agent-b','status':'observed'} for e in src.get('edges',[])]},'tdbPlan':{'dimensions':{d:0.5 for d in DIMS}},'tdbActiveTrace':[{'timeIndex':0,'eventKind':'execution_started'}], 'tdbExec':{'dimensions':{d:next(iter(edge_gold.values()))['dimensions'][d]['mean'] if edge_gold else 0.5 for d in DIMS}},'receiverScope':{'role':'downstream_agent','allowedFields':['tdb','resultVersion','evidence']},'decisionQuery':'accept_result','privacyPolicy':{'allowedFields':['tdb','resultVersion','evidence'],'privateFieldsExcluded':True},'hardContract':{'independentCheckerRequired':True},'dependencyGold':edge_gold,'disclosureGold':{'status':'UNKNOWN' if proj.get('status')=='UNKNOWN' else 'CERTIFIED_REFERENCE','selectedUnits':proj.get('selectedUnits',[]),'decision':proj.get('decision','UNKNOWN'),'privacySafe':bool(proj.get('privacySafe',True)),'disclosureCost':proj.get('disclosureCost'),'labelSource':'independent_projection_solver'},'evolutionGold':evolution,'evaluatorVersion':'tdb-controlled-evaluator-v1','replayToken':hashlib.sha256((ident+'-replay').encode()).hexdigest(),'traceHash':hashlib.sha256(json.dumps(events,sort_keys=True).encode()).hexdigest(),'labelMask':{'dependency':True,'disclosure':True,'evolution':True},'split':src.get('split','train')})
  (out/'episodes.jsonl').write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in rows),encoding='utf-8'); (out/'manifest.json').write_text(json.dumps({'schemaVersion':'tdb-full-episode-synthetic-v1','rows':len(rows),'sourceEvaluator':'tdb-controlled-evaluator-v1','hiddenWorldExcludedFromPrompt':True,'goldSeparatedAtQwenPreparation':True},ensure_ascii=False,indent=2),encoding='utf-8'); print(json.dumps({'rows':len(rows),'output':str(out.resolve())}))
if __name__=='__main__': main()
