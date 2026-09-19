"""Reject shortcut synthetic episodes before any training run."""
from __future__ import annotations
import argparse, json
from pathlib import Path
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--output',required=True); a=ap.parse_args(); rows=[json.loads(x) for x in Path(a.input).read_text(encoding='utf-8').splitlines() if x.strip()]; failures=[]
    for i,r in enumerate(rows):
      conv=r.get('conversation',[]); dims=[]
      for edge in (r.get('dependencyGold') or {}).values() if isinstance(r.get('dependencyGold'),dict) else []:
        ds=edge.get('dimensions',{}) if isinstance(edge,dict) else {}; dims += [json.dumps(v,sort_keys=True) for v in ds.values()]
      if len(conv)<4: failures.append([i,'conversation_too_short'])
      if str(r.get('sourceProvenance',{}).get('kind','')).startswith('real') and len(r.get('toolTrace',[])) == 0: failures.append([i,'real_episode_tool_trace_missing'])
      if str(r.get('sourceProvenance',{}).get('kind','')).startswith('real') and len(r.get('eventTrace',[])) < 4: failures.append([i,'real_episode_event_trace_too_short'])
      if dims and len(set(dims)) <= 1: failures.append([i,'dependency_dimensions_collapsed'])
      if not r.get('sourceProvenance') and str(r.get('evidenceLevel','')).startswith('SYNTHETIC'): failures.append([i,'synthetic_provenance_missing'])
    synthetic=any(str(r.get('sourceProvenance',{}).get('kind','')).startswith('synthetic') for r in rows)
    report={'schemaVersion':'tdb-dataset-quality-v1','rows':len(rows),'failures':failures,'valid':not failures,'trainingAllowed':not failures and not synthetic,'baselineOnly':synthetic,'policy':'invalid data is retained for audit; synthetic reference data may only enter controlled baseline runs'}; Path(a.output).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8'); print(json.dumps(report,ensure_ascii=False,indent=2)); raise SystemExit(0 if not failures else 1)
if __name__=='__main__': main()
