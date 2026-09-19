"""Expand the independent finite-world evaluator into auditable reference episodes.

This is a controlled reference corpus, never presented as real Janus traffic.
Each row keeps public input, an offline gold pointer, a multi-turn transcript,
tool outcomes, event trace, and a deterministic per-dimension mapping.
"""
import argparse, hashlib, json
from pathlib import Path
DIMS=['data','logic','quality','freshness','review','capability','resource','risk','downstreamImpact','uncertainty']
REL=['data_transfer','review_handoff','versioned_result','resource_gate','plan_dependency']
def load(p): return [json.loads(x) for x in Path(p).read_text(encoding='utf8').splitlines() if x.strip()]
def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--public',required=True); ap.add_argument('--gold',required=True); ap.add_argument('--output',required=True); a=ap.parse_args(); out=Path(a.output); out.mkdir(parents=True,exist_ok=False)
 pub={x['id']:x for x in load(a.public)}; gold={x['id']:x for x in load(a.gold)}; rows=[]
 for idx,(ident,p) in enumerate(sorted(pub.items())):
  g=gold.get(ident,{}); family=p['familyId']; pair=[f'agent-{idx%11:02d}',f'agent-{(idx*3+1)%17:02d}']; rel=REL[idx%len(REL)]
  edge_gold={}
  for ei,e in enumerate(p.get('edges',[])):
   sg=(g.get('stateGold') or [{}])[ei%max(1,len(g.get('stateGold') or [{}]))]; base=float(sg.get('mean',0));
   vals={d:round(max(0,min(1,base*(((ei+1)*((j+3)%5+1)%7)/6)+((idx+j)%4)*.04)),3) for j,d in enumerate(DIMS)}
   edge_gold[e['edgeId']]={'dimensions':{d:{'mean':v,'interval':[v,v],'status':'SUPPORTED' if v>=.5 else 'FAILED','evidenceRefs':e.get('public',{}).get('evidenceRefs',[]),'sourceVersion':'tdb-controlled-evaluator-v1','label_mask':True} for d,v in vals.items()},'labelSource':'independent_controlled_evaluator_derived_reference'}
  t='2026-01-01T00:00:'; conv=[
   {'id':ident+'-m0','role':'requester','actorUserId':pair[0],'content':'State the task acceptance criteria and the evidence needed by the receiver.','occurredAt':t+'00Z'},
   {'id':ident+'-m1','role':'recipient','actorUserId':pair[1],'content':f'I will inspect relation {rel}, then return a versioned result.','occurredAt':t+'01Z'},
   {'id':ident+'-m2','role':'recipient','actorUserId':pair[1],'content':'I found the public dependency observations and checked the available result version.','occurredAt':t+'02Z'},
   {'id':ident+'-m3','role':'requester','actorUserId':pair[0],'content':'Report only the minimum fields required for the accept_result decision.','occurredAt':t+'03Z'},
   {'id':ident+'-m4','role':'recipient','actorUserId':pair[1],'content':'The result is submitted with evidence references; independent review is still required.','occurredAt':t+'04Z'},
   {'id':ident+'-m5','role':'requester','actorUserId':pair[0],'content':'Acknowledged. I will apply the receiver policy and wait on certification.','occurredAt':t+'05Z'}]
  tools=[{'toolCallId':ident+'-tc0','actorUserId':pair[1],'name':'read_dependency_snapshot','arguments':{'edgeId':p['edges'][0]['edgeId'] if p.get('edges') else ''},'result':{'evidenceRefs':p.get('observable',{}).get('evidenceRefs',[]),'status':'ok'}},{'toolCallId':ident+'-tc1','actorUserId':pair[1],'name':'submit_versioned_result','arguments':{'version':'v1'},'result':{'status':'pending_review'}}]
  events=[{'eventKind':k,'sourceKind':'synthetic_controlled_evaluator','occurredAt':t+f'{i:02d}Z'} for i,k in enumerate(['task_created','plan_published','dependency_inspected','tool_called','tool_returned','handoff_sent','result_submitted','review_pending'])]
  rows.append({'schemaVersion':'tdb-episode-contract-v1','taskFamilyId':family,'taskInstanceId':ident,'episodeId':ident,'agentPair':pair,'conversation':conv,'toolTrace':tools,'eventTrace':events,'gPlan':{'nodes':pair,'edges':[{'edgeId':e['edgeId'],'from':pair[0],'to':pair[1],'relationType':rel} for e in p.get('edges',[])]},'gExec':{'nodes':pair,'edges':[{'edgeId':e['edgeId'],'from':pair[0],'to':pair[1],'relationType':rel,'status':'observed'} for e in p.get('edges',[])]},'tdbPlan':{'dimensions':{d:.5 for d in DIMS}},'tdbActiveTrace':[{'timeIndex':i,'eventKind':events[i]['eventKind']} for i in range(len(events))],'tdbExec':{'dimensions':{d:next(iter(edge_gold.values()))['dimensions'][d]['mean'] if edge_gold else .5 for d in DIMS}},'receiverScope':{'role':'downstream_agent','allowedFields':['tdb','resultVersion','evidence']},'decisionQuery':'accept_result','privacyPolicy':{'allowedFields':['tdb','resultVersion','evidence'],'privateFieldsExcluded':True},'hardContract':{'independentCheckerRequired':True},'dependencyGold':edge_gold,'disclosureGold':{'status':'UNKNOWN' if (g.get('projectionGold') or {}).get('status')=='UNKNOWN' else 'REFERENCE','selectedUnits':(g.get('projectionGold') or {}).get('selectedUnits',[]),'decision':(g.get('projectionGold') or {}).get('decision','UNKNOWN'),'privacySafe':bool((g.get('projectionGold') or {}).get('privacySafe',True)),'disclosureCost':(g.get('projectionGold') or {}).get('disclosureCost'),'labelSource':'independent_projection_solver'},'evolutionGold':{'candidateEdgeId':max((p.get('arms') or {}),key=lambda k:float((g.get('utilityGold') or {}).get(k,0)),default='noop'),'causeSet':['edge'],'labelSource':'paired_noop_controlled_evaluator'},'evaluatorVersion':'tdb-controlled-evaluator-v1','sourceProvenance':{'kind':'synthetic_reference','publicId':ident,'goldId':ident,'hiddenWorldExcludedFromPrompt':True},'replayToken':hashlib.sha256((ident+'-replay-v2').encode()).hexdigest(),'traceHash':hashlib.sha256(json.dumps(events,sort_keys=True).encode()).hexdigest(),'labelMask':{'dependency':True,'disclosure':True,'evolution':True},'split':p.get('split','train')})
 (out/'episodes.jsonl').write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in rows),encoding='utf8'); (out/'manifest.json').write_text(json.dumps({'schemaVersion':'tdb-full-episode-reference-v2','rows':len(rows),'publicSha256':hashlib.sha256(Path(a.public).read_bytes()).hexdigest(),'goldSha256':hashlib.sha256(Path(a.gold).read_bytes()).hexdigest(),'evidenceLevel':'SYNTHETIC_FINITE_WORLD_REFERENCE','independentGoldNotModelInput':True},ensure_ascii=False,indent=2),encoding='utf8'); print(json.dumps({'rows':len(rows),'output':str(out.resolve())}))
if __name__=='__main__': main()
