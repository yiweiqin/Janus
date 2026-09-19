#!/usr/bin/env python3
import argparse, json, pathlib, hashlib
import numpy as np
from sklearn.feature_extraction.text import HashingVectorizer

ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--output',required=True); ap.add_argument('--dim',type=int,default=1024); a=ap.parse_args()
src=pathlib.Path(a.input); rows=[json.loads(x) for x in src.read_text(encoding='utf-8').splitlines() if x.strip()]
texts=[json.dumps({'features':r.get('features',{})},sort_keys=True,separators=(',',':')) for r in rows]
v=HashingVectorizer(n_features=a.dim,alternate_sign=False,norm='l2',lowercase=False,token_pattern=r'(?u)\b\w+\b')
emb=v.transform(texts).toarray().astype('float32')
out=pathlib.Path(a.output); out.mkdir(parents=True,exist_ok=True); np.save(out/'text_embeddings.npy',emb)
(out/'index.jsonl').write_text('\n'.join(json.dumps({'id':r['id'],'row':i}) for i,r in enumerate(rows))+'\n',encoding='utf-8')
manifest={'model':'sklearn-hashing-observable-v1','count':len(rows),'dim':a.dim,'input_sha256':hashlib.sha256(src.read_bytes()).hexdigest(),'text_contract':{'allowed':['features'],'forbidden':['condition','fault_type','ground_truth','oracle','password','token','private_memory','current_test_utility']}}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print(json.dumps(manifest))
