#!/usr/bin/env python3
import argparse,json
from pathlib import Path
from tdb_training_contract import FEATURES,digest,load_rows,paired_examples

def prepare(input_path,output_path):
    examples,audit=paired_examples(load_rows(input_path)); out=Path(output_path); out.parent.mkdir(parents=True,exist_ok=True)
    records=[]
    for row in examples:
        features=dict(zip(FEATURES,row['x']))
        gains={a:v for a,v in row['targets'].items() if v is not None}
        prompt="Using only the observable state, predict each supported repair action's incremental utility relative to noop. Return JSON with repair_expected_gain. No state, attribution, projection, or unique-root-cause gold is provided. STATE="+json.dumps({'features':features},sort_keys=True)+" CANDIDATE_ACTIONS="+json.dumps(list(gains))
        records.append({'id':row['id'],'familyId':row['familyId'],'split':'train','prompt':prompt,'completion':json.dumps({'repair_expected_gain':gains},allow_nan=False),'label_mask':{'state':False,'projection':False,'attribution':False,'uplift':{a:v is not None for a,v in row['targets'].items()}}})
    with out.open('x',encoding='utf-8') as f:
        for x in records: f.write(json.dumps(x,ensure_ascii=False,allow_nan=False)+'\n')
    audit.update({'source_sha256':digest(input_path),'output_sha256':digest(out),'target_contract':'paired_uplift_only_v2'})
    out.with_suffix(out.suffix+'.manifest.json').write_text(json.dumps(audit,indent=2),encoding='utf-8'); return audit
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input',required=True);p.add_argument('--output',required=True);a=p.parse_args();print(json.dumps(prepare(a.input,a.output)))
