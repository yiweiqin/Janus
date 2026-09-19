"""Remote-only Qwen pair collection. Controlled tasks; actual inference and tools.

No model-generated text is executed. Tools operate only on locally constructed
fixtures. Label masks remain false: execution is evidence, not target gold.
"""
import argparse
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path

def stamp(): return datetime.now(timezone.utc).isoformat()
def digest(x): return hashlib.sha256(json.dumps(x,sort_keys=True,ensure_ascii=False).encode()).hexdigest()

FAMILIES = {
 'ledger_reconciliation': ('data_transfer','Reconcile the ledger total against the claimed balance.',
    {'entries':[120,-35,67,-12],'claimed':140}),
 'dependency_order': ('ordering','Find a valid task execution order respecting dependencies.',
    {'edges':[['design','build'],['build','test'],['test','release']],'proposed':['design','test','build','release']}),
 'deliverable_review': ('quality_review','Check whether each release requirement is satisfied.',
    {'required':['summary','tests','rollback'],'sections':{'summary':'Release overview','tests':'3 checks passed'}}),
 'authorized_projection': ('disclosure','Select only authorized fields sufficient to answer whether a result may be accepted.',
    {'fields':{'version':'v2','review':'passed','ownerNote':'unrelated internal note'},'allowed':['version','review'],'required':['version','review']}),
}

def evaluate(family, value):
    if family=='ledger_reconciliation':
        total=sum(value['entries']); return {'actualTotal':total,'claimed':value['claimed'],'valid':total==value['claimed']}
    if family=='dependency_order':
        order=value['proposed']; bad=[e for e in value['edges'] if e[0] not in order or e[1] not in order or order.index(e[0])>=order.index(e[1])]
        return {'valid':not bad,'violatedEdges':bad,'order':order}
    if family=='deliverable_review':
        missing=[k for k in value['required'] if not value['sections'].get(k)]
        return {'valid':not missing,'missingSections':missing}
    selected=[k for k in value['required'] if k in value['allowed']]
    return {'valid':set(selected)==set(value['required']),'selectedUnits':selected,
            'disclosureCost':len(selected),'excludedUnits':[k for k in value['fields'] if k not in value['allowed']]}

def repair(family, value):
    value=json.loads(json.dumps(value))
    if family=='ledger_reconciliation': value['claimed']=sum(value['entries'])
    elif family=='dependency_order':
        value['proposed']=['design','build','test','release']
        if any('document' in e for e in value['edges']): value['proposed'].append('document')
    elif family=='deliverable_review':
        for section in value['required']:
            value['sections'].setdefault(section, 'Controlled fixture revision for '+section)
    return value

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--model',required=True); ap.add_argument('--output',required=True)
    ap.add_argument('--variants',type=int,default=10); ap.add_argument('--max-new-tokens',type=int,default=512)
    ap.add_argument('--families',nargs='+',choices=list(FAMILIES),default=list(FAMILIES)); a=ap.parse_args()
    if __import__('sys').platform=='win32': raise SystemExit('remote_linux_only_no_local_model_loading')
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM
    out=Path(a.output); out.mkdir(parents=True,exist_ok=True)
    if (out/'episodes.jsonl').exists(): raise SystemExit('output_already_contains_episode_file')
    tok=AutoTokenizer.from_pretrained(a.model,local_files_only=True)
    model=AutoModelForCausalLM.from_pretrained(a.model,local_files_only=True,dtype=torch.bfloat16,device_map={'':0})
    model.eval(); model_id=Path(a.model).name
    with (out/'episodes.jsonl').open('w',encoding='utf8') as sink:
      for fi,(family,(relation,task,fixture)) in enumerate(FAMILIES.items()):
       if family not in a.families: continue
       for variant in range(a.variants):
        ident=f'executed-v4-{family}-{variant}'; pair=[f'{family}-coordinator',f'{family}-analyst']
        conversation=[]; tools=[]; events=[]; invocations=[]
        profiles={pair[0]:f'You coordinate {task} Check evidence, request corrections. Do not claim tool execution yourself.',
                  pair[1]:f'You analyze {task} Use the supplied tool evidence. Explain uncertainties. Do not fabricate outputs.'}
        def event(kind,payload):
            item={'id':f'{ident}-e{len(events)}','eventKind':kind,'occurredAt':stamp(),'payload':payload};events.append(item);return item['id']
        def call(actor,instruction):
            history=[{'role':'system','content':profiles[actor]},
              {'role':'user','content':json.dumps({'task':task,'artifact':value,'messages':conversation,'tools':tools,'instruction':instruction+' Reply in at most 120 words.'},ensure_ascii=False)}]
            input_ids=tok.apply_chat_template(history,tokenize=True,add_generation_prompt=True,enable_thinking=False,return_tensors='pt')
            if hasattr(input_ids,'keys'): input_ids=input_ids['input_ids']
            input_ids=input_ids.to(model.device); started=time.monotonic()
            with torch.inference_mode(): generated=model.generate(input_ids,max_new_tokens=a.max_new_tokens,do_sample=False,pad_token_id=tok.eos_token_id)
            answer_ids=generated[0,input_ids.shape[1]:]; content=tok.decode(answer_ids,skip_special_tokens=True)
            message={'id':f'{ident}-m{len(conversation)}','role':'assistant','actorUserId':actor,'content':content,'occurredAt':stamp()}
            conversation.append(message); invocations.append({'messageId':message['id'],'input':history,'inputHash':digest(history),
              'inputTokens':input_ids.shape[1],'outputTokens':len(answer_ids),'reachedTokenBudget':len(answer_ids)>=a.max_new_tokens,
              'output':content,'outputHash':digest(content),'elapsedSeconds':time.monotonic()-started})
        value=json.loads(json.dumps(fixture))
        if family=='ledger_reconciliation':
            value['entries'][0]+=variant*7; value['claimed'] += (variant % 3) - 1
        if family=='dependency_order':
            value['durations']={'design':2+variant,'build':5+variant*2,'test':3,'release':1}
            value['proposed'] = ['design','test','build','release'] if variant % 2 == 0 else ['design','build','test','release']
            if variant >= 3: value['edges'].append(['test','document'])
        if family=='deliverable_review':
            value['sections']['summary']=f'Release {variant+1}: validate {3+variant} required checks.'
            if variant % 2: value['sections'].pop('tests',None)
            if variant >= 3: value['required'].append('security')
        if family=='authorized_projection':
            value['fields']['costEstimate'] = 12 + variant
            if variant % 2: value['required'].append('costEstimate')
        event('task_created',{'family':family,'fixtureHash':digest(value)})
        call(pair[0],'Delegate the task and specify acceptance requirements.')
        call(pair[1],'Explain which input you need to inspect.')
        fixture_dir=out/ident;fixture_dir.mkdir();v1=fixture_dir/'v1.json';v1.write_text(json.dumps(value),encoding='utf8')
        # A declared missing-version fault invokes an actual file read and exception.
        try:
            (fixture_dir/'v0.json').read_text(encoding='utf8')
        except FileNotFoundError:
            error={'id':f'{ident}-t0','name':'read_artifact','arguments':{'version':'v0'},'result':{'error':'FileNotFoundError'},'occurredAt':stamp()}
            tools.append(error);event('execution_failed',{'toolRef':error['id'],'faultInjection':'missing_version'})
        event('execution_retried',{'fromVersion':'v0','toVersion':'v1'})
        loaded=json.loads(v1.read_text(encoding='utf8')); check1=evaluate(family,loaded)
        noop_file=fixture_dir/'noop.json'; noop_file.write_bytes(v1.read_bytes())
        noop_loaded=json.loads(noop_file.read_text(encoding='utf8')); noop_check=evaluate(family,noop_loaded)
        assert digest(noop_loaded)==digest(loaded) and noop_check==check1
        tools.append({'id':f'{ident}-t1','name':'validate_artifact','arguments':{'version':'v1','input':loaded},'result':check1,'occurredAt':stamp()})
        event('result_submitted',{'version':'v1','toolRef':f'{ident}-t1'})
        call(pair[1],'Report the tool result and propose the next concrete action.')
        call(pair[0],'Review the evidence. State whether revision is needed and why.')
        # Harness applies a fixed, declared intervention; never attribute it to the LLM.
        value2=repair(family,loaded);v2=fixture_dir/'v2.json';v2.write_text(json.dumps(value2),encoding='utf8')
        event('controlled_repair_applied',{'actor':'experiment_harness','fromVersion':'v1','toVersion':'v2'})
        check2=evaluate(family,json.loads(v2.read_text(encoding='utf8')))
        tools.append({'id':f'{ident}-t2','name':'validate_artifact','arguments':{'version':'v2','input':value2},'result':check2,'occurredAt':stamp()})
        call(pair[1],'Describe the current result using the new tool evidence; distinguish the harness repair from your proposal.')
        call(pair[0],'Give your final acceptance decision and remaining uncertainties.')
        event('episode_closed',{'evaluatorValid':check2['valid'],'humanReviewRequired':True})
        edges=[{'edgeId':ident+'-handoff','from':pair[1],'to':pair[0],'relationType':relation,'owner':pair[1]}]
        plan={'nodes':pair,'edges':edges,'expectedVersions':['v1'],'plannedOrder':['produce','review','accept']}
        exe={'nodes':pair,'edges':edges,'observedVersions':['v0','v1','v2'],'eventRefs':[e['id'] for e in events]}
        episode={'schemaVersion':'tdb-episode-contract-v1','episodeId':ident,'delegationId':ident,'taskInstanceId':ident,
          'taskFamilyId':family,'agentPair':pair,'conversation':conversation,'toolTrace':tools,'eventTrace':events,
          'gPlan':plan,'gExec':exe,'tdbPlan':{},'tdbActiveTrace':[],'tdbExec':{},
          'receiverScope':{'receiver':pair[0],'authorizedFor':'controlled_experiment'},'decisionQuery':task,
          'privacyPolicy':{'source':'self_authored_fixtures','trainingConsent':'experiment_scoped'},
          'hardContract':{'independentCheckerRequired':True},'dependencyGold':{},'disclosureGold':{},'evolutionGold':{},
          'labelMask':{'dependency':False,'disclosure':False,'evolution':False},'evaluatorVersion':'executed-fixture-v1',
          'traceHash':digest(events),'replayToken':'','split':['train','development','calibration','test'][fi],
          'sourceProvenance':{'kind':'controlled_model_execution','modelSnapshot':model_id,'modelCalls':len(invocations),
           'configHash':digest({'variants':a.variants,'maxNewTokens':a.max_new_tokens,'sampling':False,'thinking':False}),
           'sameBaseModelBothRoles':True,'agentProfiles':profiles,'faultPolicy':'missing_v0_then_fixed_harness_repair',
           'productionTraffic':False,'sourceCodeHash':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},
          'collectionAudit':{'invocations':invocations,'artifacts':{'v1':digest(loaded),'v2':digest(value2)},
            'pairedNoop':{'inputHash':digest(noop_loaded),'evaluation':noop_check,'resetVerified':True,'scope':'fixture_evaluator_only'},'intervention':{'inputHash':digest(value2),'evaluation':check2}}}
        sink.write(json.dumps(episode,ensure_ascii=False)+'\n');sink.flush()
        print(json.dumps({'episodeId':ident,'modelCalls':len(invocations),'tools':len(tools),'valid':check2['valid']}),flush=True)
    (out/'manifest.json').write_text(json.dumps({'kind':'controlled_model_execution','rows':len(a.families)*a.variants,
      'trainingAllowed':False,'reason':'human_labels_and_tdb_alignment_pending','modelSnapshot':model_id,
      'episodesSha256':hashlib.sha256((out/'episodes.jsonl').read_bytes()).hexdigest()},indent=2),encoding='utf8')
if __name__=='__main__': main()
