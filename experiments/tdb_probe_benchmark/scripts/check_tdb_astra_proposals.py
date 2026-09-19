import argparse,json,re
from pathlib import Path
F=re.compile(r"password|access_token|refresh_token|api_token|secret|private_prompt|private_memory|hidden_state|ground_truth|oracle_action|post_action_utility|test_outcome",re.I); S={"SUPPORTED","UNKNOWN","CONFLICT","STALE"}; D={"data","logic","quality","freshness","review","capability","resource","risk","downstreamImpact","uncertainty"}
def walk(v,p=""):
 o=[]
 if isinstance(v,dict):
  for k,x in v.items(): o += [p+"."+str(k)] if F.search(str(k)) else []; o += walk(x,p+"."+str(k))
 elif isinstance(v,list):
  for i,x in enumerate(v): o += walk(x,f"{p}[{i}]")
 return o
def main():
 ap=argparse.ArgumentParser(); ap.add_argument("--input",required=True); ap.add_argument("--output",required=True); a=ap.parse_args(); out=[]
 for z in Path(a.input).read_text(encoding="utf8").splitlines():
  if not z.strip(): continue
  r=json.loads(z); e=r.get("episode",{}); d=r.get("modelProposal") or {}; refs={x.get("id") for x in e.get("conversation",[])+e.get("toolTrace",[])+e.get("eventTrace",[])}; er=walk(r)
  if d.get("status") not in ("PROPOSED","UNKNOWN","CONFLICT"): er.append("status_invalid")
  dep=d.get('dependencyProposal') or {}; dims=dep.get('dimensions') or {}; missing=[x for x in D if x not in dims]; er += ['missing_dimension:'+x for x in missing]
  if not isinstance(d.get('disclosureProposal'),dict): er.append('disclosure_proposal_missing')
  if not isinstance(d.get('evolutionProposal'),dict): er.append('evolution_proposal_missing')
  for sec in ("dependencyProposal","disclosureProposal","evolutionProposal"):
   for ref in (d.get(sec) or {}).get("evidenceRefs",[]):
    if ref not in refs: er.append("unknown_evidence_ref:"+sec)
  if "CERTIFIED" in json.dumps(d,ensure_ascii=False): er.append("proposal_certification_claim")
  out.append({"episodeId":e.get("episodeId"),"valid":not er,"errors":er,"checkerStatus":"PASS" if not er else "FAIL","certified":False})
 Path(a.output).write_text("".join(json.dumps(x,ensure_ascii=False)+"\n" for x in out),encoding="utf8"); print(json.dumps({"rows":len(out),"valid":sum(x["valid"] for x in out),"certified":0}))
if __name__=="__main__": main()
