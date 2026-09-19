#!/usr/bin/env python3
import argparse, json, pathlib, random
ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--output',required=True); ap.add_argument('--seed',type=int,default=20260906); ap.add_argument('--ratios',default='0.5,0.2,0.3'); a=ap.parse_args()
rows=[json.loads(x) for x in pathlib.Path(a.input).read_text().splitlines() if x.strip()]
families=sorted({str(r.get('familyId')) for r in rows}); random.Random(a.seed).shuffle(families); q=[float(x) for x in a.ratios.split(',')]; n=len(families); c1=int(n*q[0]); c2=int(n*(q[0]+q[1]))
groups={'train':set(families[:c1]),'calibration':set(families[c1:c2]),'test':set(families[c2:])}; out=pathlib.Path(a.output); out.mkdir(parents=True,exist_ok=True)
for name,fs in groups.items():
    with (out/f'{name}.jsonl').open('w') as f:
        for row in rows:
            if str(row.get('familyId')) in fs: f.write(json.dumps(row,separators=(',',':'))+'\n')
(out/'split_manifest.json').write_text(json.dumps({'seed':a.seed,'ratios':q,'families':{k:sorted(v) for k,v in groups.items()}},indent=2)+'\n')
