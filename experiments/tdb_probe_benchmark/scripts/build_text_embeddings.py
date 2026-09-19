#!/usr/bin/env python3
import argparse,json,pathlib,numpy as np
from sentence_transformers import SentenceTransformer
ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--output',required=True); ap.add_argument('--model',default='BAAI/bge-m3'); ap.add_argument('--batch-size',type=int,default=64); ap.add_argument('--normalize',action='store_true'); a=ap.parse_args()
rows=[json.loads(x) for x in pathlib.Path(a.input).read_text().splitlines() if x.strip()]; ids=[]; texts=[]
for r in rows:
    # Only pre-intervention observable state is allowed; condition is a hidden
    # fault label in the Probe generator and must never enter embeddings.
    ids.append(str(r.get('id'))); texts.append(json.dumps({'features':r.get('features',{})},ensure_ascii=False))
import torch
m=SentenceTransformer(a.model,device='cuda' if torch.cuda.is_available() else 'cpu'); emb=m.encode(texts,batch_size=a.batch_size,normalize_embeddings=a.normalize,show_progress_bar=True,convert_to_numpy=True)
o=pathlib.Path(a.output); o.mkdir(parents=True,exist_ok=True); np.save(o/'text_embeddings.npy',emb.astype('float32')); (o/'index.jsonl').write_text('\n'.join(json.dumps({'id':i,'row':n}) for n,i in enumerate(ids))+'\n'); (o/'manifest.json').write_text(json.dumps({'model':a.model,'count':len(ids),'dim':int(emb.shape[1])})+'\n')
