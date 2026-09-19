"""Acquire a provenance-pinned open multi-agent trace corpus.

MAD (mcemri/MAD) is released with the MAST paper and includes human-labelled
traces. We retain raw files, checksums and a transformation manifest; the
corpus is a pretraining/weak-supervision source, never a substitute for
Janus-specific disclosure or evolution gold.
"""
from __future__ import annotations
import argparse, hashlib, json, urllib.request, base64
from pathlib import Path

BASE='https://huggingface.co/datasets/mcemri/MAD/resolve/main/'
FILES=['MAD_human_labelled_dataset.json','MAD_full_dataset.json']
def fetch(url, dest):
    req=urllib.request.Request(url, headers={'User-Agent':'Janus-TDB-prep/1.0'})
    with urllib.request.urlopen(req, timeout=120) as r: data=r.read()
    dest.write_bytes(data); return hashlib.sha256(data).hexdigest(), len(data)
def github_human_traces(out, limit):
    api='https://api.github.com/repos/multi-agent-systems-failure-taxonomy/MAST'
    req=urllib.request.Request(api+'/commits/main',headers={'User-Agent':'Janus-TDB-prep/1.0'})
    commit=json.load(urllib.request.urlopen(req,timeout=20))['sha']
    tree=json.load(urllib.request.urlopen(urllib.request.Request(api+f'/git/trees/{commit}?recursive=1',headers={'User-Agent':'Janus-TDB-prep/1.0'}),timeout=30))['tree']
    files=[x for x in tree if x['path'].endswith('_human.json')][:limit]
    records=[]
    for item in files:
      try:
        d=json.load(urllib.request.urlopen(urllib.request.Request(api+'/contents/'+item['path']+'?ref='+commit,headers={'User-Agent':'Janus-TDB-prep/1.0'}),timeout=20))
        data=base64.b64decode(d['content']); target=out/Path(item['path']).name; target.write_bytes(data); records.append({'file':target.name,'sourcePath':item['path'],'commit':commit,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'status':'downloaded'})
      except Exception as exc: records.append({'file':item['path'],'commit':commit,'status':'unavailable','error':str(exc)})
    return commit,records
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--output',required=True); ap.add_argument('--human-only',action='store_true'); ap.add_argument('--source',choices=['github','huggingface'],default='github'); ap.add_argument('--limit',type=int,default=61); a=ap.parse_args(); out=Path(a.output); out.mkdir(parents=True,exist_ok=False)
    if a.source=='github': commit,records=github_human_traces(out,max(1,min(a.limit,200)))
    else:
      commit=''; records=[]
      for name in (FILES[:1] if a.human_only else FILES):
        try: sha,size=fetch(BASE+name,out/name); records.append({'file':name,'url':BASE+name,'sha256':sha,'bytes':size,'status':'downloaded'})
        except Exception as exc: records.append({'file':name,'url':BASE+name,'status':'unavailable','error':str(exc)})
    manifest={'schemaVersion':'open-mas-trace-source-v1','dataset':'MAD/MAST','paper':'Why Do Multi-Agent Systems Fail? (MAST), arXiv:2503.13657v2','source':'github' if a.source=='github' else 'huggingface','commit':commit,'licenseStatus':'upstream_license_not_found_in_repository; legal review required before redistribution','records':records,'humanAnnotatedAvailable':any(x.get('status')=='downloaded' for x in records),'janusGoldRequired':True}
    (out/'SOURCE_MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8'); print(json.dumps(manifest,ensure_ascii=False,indent=2))
if __name__=='__main__': main()
