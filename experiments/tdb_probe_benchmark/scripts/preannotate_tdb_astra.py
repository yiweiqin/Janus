"""Remote-only gpt-6-astra TDB pre-annotation. Never emits gold/certificates."""
import argparse, hashlib, json, os, re, sys, urllib.request
from pathlib import Path
DIMS=['data','logic','quality','freshness','review','capability','resource','risk','downstreamImpact','uncertainty']
FORBIDDEN=re.compile(r'password|access_token|refresh_token|api_token|secret|private_prompt|private_memory|hidden_state|ground_truth|oracle_action|post_action_utility|test_outcome',re.I)
def scrub(v):
    if isinstance(v,dict): return {str(k):scrub(x) for k,x in v.items() if not FORBIDDEN.search(str(k))}
    if isinstance(v,list): return [scrub(x) for x in v]
    return v
def fallback(e,reason):
    edge=((e.get('gPlan') or {}).get('edges') or [{}])[0].get('edgeId','')
    dims={k:{'value':None,'status':'UNKNOWN','evidenceRefs':[]} for k in DIMS}
    return {'episodeId':e.get('episodeId'),'status':'UNKNOWN','confidence':0.0,
      'dependencyProposal':{'candidateEdgeId':edge,'dimensions':dims,'scope':'episode','version':'unknown','evidenceRefs':[]},
      'disclosureProposal':{'status':'UNKNOWN','selectedUnits':[],'decision':'UNKNOWN','disclosureCost':None,'decisionAgreement':None,'privacySafe':None,'worldAmbiguity':None,'nextAction':'ABSTAIN','abstainReason':reason,'evidenceRefs':[]},
      'evolutionProposal':{'candidateEdgeId':edge,'causeSet':[],'priorityScore':None,'priorityLevel':'UNKNOWN','orderedSteps':[],'expectedLocalGain':None,'expectedTransferGain':None,'negativeTransferRisk':None,'rollbackCondition':{},'requiredValidationTasks':[],'factors':{k:None for k in ['impact','uncertainty','risk','coupling','repairability','cost']},'confidence':0.0,'evidenceRefs':[]},'warnings':[reason],'abstainReason':reason}
def normalize(d,e):
    base=fallback(e,'字段缺失，需人工确认')
    if not isinstance(d,dict): return base
    base.update({k:v for k,v in d.items() if k in ('status','confidence','dependencyProposal','disclosureProposal','evolutionProposal','warnings','abstainReason')})
    base['episodeId']=e.get('episodeId'); base['status']=base['status'] if base['status'] in ('PROPOSED','UNKNOWN','CONFLICT') else 'PROPOSED'; base['confidence']=float(base.get('confidence') or 0)
    base['draftKind']='ASTRA_PROPOSAL'; base['model']='gpt-6-astra'; base['modelHash']=hashlib.sha256(b'gpt-6-astra').hexdigest()
    return scrub(base)
def main():
    if sys.platform=='win32' or os.environ.get('TDB_REMOTE_RUNTIME')!='1': raise SystemExit('remote_only_required')
    ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--output',required=True); ap.add_argument('--endpoint',default='https://codexpro.wwxb1123.xyz/v1'); ap.add_argument('--model',default='gpt-6-astra'); a=ap.parse_args(); key=os.environ.get('CRS_OAI_KEY')
    if not key: raise SystemExit('CRS_OAI_KEY_missing')
    rows=[json.loads(x) for x in Path(a.input).read_text(encoding='utf8').splitlines() if x.strip()]; out=[]
    for e in rows:
      public={k:e.get(k) for k in ('episodeId','conversation','toolTrace','eventTrace','gPlan','gExec','tdbPlan','tdbActiveTrace','tdbExec','receiverScope','decisionQuery','privacyPolicy','hardContract','replayToken','traceHash','snapshotHash')}
      instruction='Return strict JSON only with keys episodeId,status,confidence,dependencyProposal,disclosureProposal,evolutionProposal,warnings,abstainReason. dependencyProposal must contain candidateEdgeId,dimensions with exactly these keys '+','.join(DIMS)+'; each dimension has value,status,evidenceRefs. disclosureProposal must contain status,selectedUnits,decision,disclosureCost,decisionAgreement,privacySafe,worldAmbiguity,nextAction,abstainReason,evidenceRefs. evolutionProposal must contain candidateEdgeId,causeSet,priorityScore,priorityLevel,orderedSteps,expectedLocalGain,expectedTransferGain,negativeTransferRisk,rollbackCondition,requiredValidationTasks,factors,confidence,evidenceRefs. This is a draft, never certification. Cite only IDs in INPUT. Use UNKNOWN or CONFLICT when uncertain. Do not use task family or hidden labels. INPUT='+json.dumps(scrub(public),ensure_ascii=False,sort_keys=True)
      try:
        body=json.dumps({'model':a.model,'temperature':0,'messages':[{'role':'system','content':'You are a TDB evidence reviewer. JSON only.'},{'role':'user','content':instruction}]}).encode(); req=urllib.request.Request(a.endpoint.rstrip('/')+'/chat/completions',body,{'Authorization':'Bearer '+key,'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=180) as resp: raw=json.loads(resp.read())['choices'][0]['message']['content']
        match=re.search(r'\{.*\}',raw,re.S); draft=normalize(json.loads(match.group()) if match else {},e)
        draft['rawModelOutput']=scrub(raw)
      except Exception as ex: draft=fallback(e,'Astra 调用失败：'+type(ex).__name__); draft['rawModelOutput']=''
      out.append({'episode':e,'modelProposal':draft,'checker':{'status':'PENDING'},'reviewTargets':['dependency','disclosure','evolution'],'status':'pending','reviews':[]})
    p=Path(a.output); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in out),encoding='utf8'); print(json.dumps({'rows':len(out),'model':a.model,'kind':'ASTRA_PROPOSAL','trainingAllowed':False}))
if __name__=='__main__': main()
