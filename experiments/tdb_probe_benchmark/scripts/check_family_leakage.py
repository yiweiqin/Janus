#!/usr/bin/env python3
import argparse,json,pathlib
ap=argparse.ArgumentParser(); ap.add_argument('--train',required=True); ap.add_argument('--calibration',required=True); ap.add_argument('--test',required=True); a=ap.parse_args()
def fs(p):
    return {str(json.loads(x).get('familyId')) for x in pathlib.Path(p).read_text().splitlines() if x.strip()}
g={k:fs(getattr(a,k)) for k in ('train','calibration','test')}
for x,y in (('train','calibration'),('train','test'),('calibration','test')):
    if g[x]&g[y]: raise SystemExit(f'family_leakage:{x}:{y}:{sorted(g[x]&g[y])}')
print(json.dumps({k:len(v) for k,v in g.items()}))
