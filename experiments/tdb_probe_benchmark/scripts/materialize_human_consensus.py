"""Materialize only agreed/adjudicated web reviews into trainable labels."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--queue',required=True); ap.add_argument('--output',required=True); a=ap.parse_args(); rows=[]; blocked=[]
    for line in Path(a.queue).read_text(encoding='utf-8').splitlines():
        if not line.strip(): continue
        q=json.loads(line); e=q.get('episode',{}); reviews=q.get('reviews',[]); consensus=q.get('consensus',{}); checker=e.get('checker') or {}
        if checker.get('valid') is False or checker.get('checkerStatus') == 'FAIL': blocked.append(e.get('episodeId')); continue
        if q.get('status') not in ('reviewed','adjudicated') or (q.get('status') == 'reviewed' and not consensus.get('agreement')):
            blocked.append(e.get('episodeId')); continue
        review=(q.get('adjudication') or {}).get('finalReview') if q.get('status') == 'adjudicated' else reviews[-1].get('review',{}); review=review or {}; disclosure=review.get('disclosure',{}); evolution=review.get('evolution',{})
        # Web review is a human adjudication layer, not an independent solver.
        # Never manufacture a dependency vector or CERTIFIED projection from a
        # categorical review alone; preserve provenance and keep masks honest.
        e['humanReview']={'disclosure':disclosure,'evolution':evolution,'evidenceQuality':review.get('evidenceQuality','missing'),'labelSource':'two_reviewer_consensus'}
        dep_review=review.get('dependency') or {}
        if isinstance(dep_review.get('dimensions'),dict) and dep_review.get('dimensions'):
            e['dependencyGold']={'candidateEdgeId':dep_review.get('candidateEdgeId',''),'dimensions':dep_review['dimensions'],'labelSource':'two_reviewer_consensus'}
        if disclosure.get('status') in ('sufficient','insufficient'):
            e['disclosureGold']={**(e.get('disclosureGold') or {}),'status':'HUMAN_REVIEWED_REFERENCE','selectedUnits':disclosure.get('selectedUnits',[]),'decision':disclosure.get('decision','UNKNOWN'),'labelSource':'two_reviewer_consensus'}
        if evolution.get('priority') in ('high','medium','low'):
            e['evolutionGold']={**(e.get('evolutionGold') or {}),'priority':evolution['priority'],'orderedSteps':evolution.get('orderedSteps',[]),'labelSource':'two_reviewer_consensus'}
        has_dependency=bool((e.get('dependencyGold') or {}).get('dimensions')) and all(isinstance(v,dict) and v.get('label_mask') is True for v in (e.get('dependencyGold') or {}).get('dimensions',{}).values())
        has_disclosure=bool((e.get('disclosureGold') or {}).get('selectedUnits')) and disclosure.get('status') in ('sufficient','insufficient')
        has_evolution=bool(evolution.get('orderedSteps')) and evolution.get('priority') in ('high','medium','low')
        e['labelMask']={**(e.get('labelMask') or {}),'dependency':has_dependency,'disclosure':has_disclosure,'evolution':has_evolution}
        if not any((has_dependency,has_disclosure,has_evolution)): blocked.append(e.get('episodeId')); continue
        rows.append(e)
    out=Path(a.output); out.parent.mkdir(parents=True,exist_ok=True); out.write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in rows),encoding='utf-8'); report={'schemaVersion':'tdb-human-consensus-v1','rows':len(rows),'blockedRows':len(blocked),'blockedEpisodeIds':blocked,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'readyForQwen':not blocked}
    (out.parent/'consensus_manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8'); print(json.dumps(report,ensure_ascii=False,indent=2)); raise SystemExit(0 if not blocked else 2)
if __name__=='__main__': main()
