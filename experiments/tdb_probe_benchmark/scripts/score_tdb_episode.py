"""Build deterministic disclosure and evolution targets from an episode JSONL."""
import argparse, hashlib, json
from pathlib import Path
DIMENSIONS = ['data','logic','quality','freshness','review','capability','resource','risk','downstreamImpact','uncertainty']
CAUSES = ['node','edge','handoff','version','resource','disclosure','organization']
def clamp(x):
    try: return max(0.0, min(1.0, float(x)))
    except (TypeError, ValueError): return 0.0
def score(row):
    plan = row.get('tdbPlan') or {}; exe = row.get('tdbExec') or {}
    ps, es = plan.get('dimensions', plan.get('state', {})), exe.get('dimensions', exe.get('state', {}))
    delta = {k: clamp(es.get(k, 0)) - clamp(ps.get(k, 0)) for k in DIMENSIONS}
    supplied_evolution = row.get('evolutionGold') if isinstance(row.get('evolutionGold'), dict) else {}
    has_evolution_gold = bool(supplied_evolution.get('labelSource') or supplied_evolution.get('independentEvaluator') or supplied_evolution.get('causeSet'))
    factors = {'impact': clamp(es.get('downstreamImpact', 0)), 'uncertainty': clamp(es.get('uncertainty', 0)), 'risk': clamp(es.get('risk', 0)), 'coupling': clamp(row.get('gExec', {}).get('coupling', 0.5)), 'repairability': clamp(supplied_evolution.get('repairability', 0.5)), 'cost': max(float(supplied_evolution.get('cost', 1.0)), 1e-6)}
    priority = factors['impact']*factors['uncertainty']*factors['risk']*factors['coupling']*factors['repairability']/factors['cost'] if has_evolution_gold else None
    disclosure = row.get('disclosureGold') or {}
    row['dependencyGold'] = {'dimensions': {k: {'mean': clamp(es.get(k, 0)), 'status': 'SUPPORTED' if k in es else 'UNKNOWN'} for k in DIMENSIONS}, 'deltaTdb': delta}
    if has_evolution_gold:
        row['evolutionGold'] = {**supplied_evolution, 'priorityScore': priority, 'factors': factors, 'causeSet': [c for c in supplied_evolution.get('causeSet', []) if c in CAUSES]}
    row['disclosureGold'] = {**disclosure, 'disclosureScore': (1.0/(1.0+float(disclosure['disclosureCost'])) if disclosure.get('disclosureCost') is not None else None)}
    row['labelMask'] = {**row.get('labelMask', {}), 'dependency': bool(es), 'disclosure': bool(disclosure), 'evolution': has_evolution_gold}
    return row
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('input'); ap.add_argument('output'); a=ap.parse_args(); rows=[json.loads(x) for x in Path(a.input).read_text(encoding='utf-8').splitlines() if x.strip()]; out=''.join(json.dumps(score(r), ensure_ascii=False, separators=(',',':'))+'\n' for r in rows); Path(a.output).write_text(out, encoding='utf-8'); print(json.dumps({'rows':len(rows),'sha256':hashlib.sha256(out.encode()).hexdigest()}))
if __name__=='__main__': main()
