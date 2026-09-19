"""Generate a synthetic paired-uplift benchmark with continuous observable support.

This is a protocol/training diagnostic only. The evaluator is an explicit
finite generator and cannot support real-world claims.
"""
import argparse, hashlib, json, random
from pathlib import Path

ACTIONS = ['noop','replaceAgent','restoreHandoff','refreshVersion','restoreResource','refreshAndHandoff']


def clamp(x): return max(-1.0, min(1.0, x))


def digest(value): return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def gains(x, latent):
    c,l,f,r,k = x
    # Continuous deficits, nonlinear interaction and a misleading risk signal.
    dc, dl, df, dr = 1-c, 1-l, 1-f, 1-r
    interaction = max(0.0, dc*dl) + max(0.0, df*dr)
    return {
        'replaceAgent': clamp(.76*dc + .10*dl*dc - .06*k),
        'restoreHandoff': clamp(.73*dl + .14*dc*dl - .04*k),
        'refreshVersion': clamp(.70*df + .13*df*dr - .03*k),
        'restoreResource': clamp(.68*dr + .12*df*dr - .05*k),
        'refreshAndHandoff': clamp(.44*dc + .42*dl + .24*df + .18*dr + .18*interaction - .08*k),
    }


def make(args):
    rng = random.Random(args.seed)
    rows=[]
    train_end=int(args.families*.5); cal_end=int(args.families*.7)
    for family in range(args.families):
        split='train' if family < train_end else ('calibration' if family < cal_end else 'test')
        family_bias=[rng.uniform(-.18,.18) for _ in range(5)]
        for repeat in range(args.instances_per_family):
            raw=[rng.random() for _ in range(5)]
            x=[max(.02,min(.98,raw[i]+family_bias[i])) for i in range(5)]
            # k is a risk alarm with imperfect correlation to true repairability.
            latent={'familyBias':family_bias,'repeat':repeat}
            g=gains(x,latent)
            base=round(rng.uniform(0.05,0.25),6)
            noise={a: rng.uniform(-.015,.015) for a in g}
            utilities={'noop':base}
            for a in g: utilities[a]=round(max(0.0,min(1.0,base+g[a]+noise[a])),6)
            ident=f'diverse-{family:03d}-{repeat:03d}'
            snapshot=digest({'family':family,'repeat':repeat,'x':x})
            arms={}
            for action in ACTIONS:
                arms[action]={'action':action,'initialStateHash':snapshot,
                    'applicable':True,'evaluation':{'utility':utilities[action],
                    'evaluatorVersion':'synthetic-diverse-uplift-v1','outcome':'completed'}}
            rows.append({'id':ident,'familyId':f'diverse-family-{family:03d}','split':split,
                'features':dict(zip(['capability','logic','freshness','resource','risk'],x)),
                'arms':arms,'observableOnly':True})
    return rows


def main():
    p=argparse.ArgumentParser(); p.add_argument('--output',required=True); p.add_argument('--families',type=int,default=100); p.add_argument('--instances-per-family',type=int,default=12); p.add_argument('--seed',type=int,default=20260907); a=p.parse_args()
    if a.families < 40 or a.instances_per_family < 4: raise ValueError('dataset_too_small')
    rows=make(a); out=Path(a.output); out.parent.mkdir(parents=True,exist_ok=True); out.write_text(''.join(json.dumps(r,allow_nan=False)+'\n' for r in rows))
    print(json.dumps({'evidenceLevel':'SYNTHETIC_FINITE_WORLD_ONLY','generator':'synthetic-diverse-uplift-v1','rows':len(rows),'families':a.families,'instancesPerFamily':a.instances_per_family,'splits':{s:sum(r['split']==s for r in rows) for s in ['train','calibration','test']},'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'realGeneralizationClaimAllowed':False}))


if __name__=='__main__': main()
