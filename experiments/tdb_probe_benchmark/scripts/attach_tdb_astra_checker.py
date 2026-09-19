import argparse,json
from pathlib import Path
def main():
 ap=argparse.ArgumentParser(); ap.add_argument("--proposals",required=True); ap.add_argument("--checker",required=True); ap.add_argument("--output",required=True); a=ap.parse_args(); c={json.loads(x)["episodeId"]:json.loads(x) for x in Path(a.checker).read_text(encoding="utf8").splitlines() if x.strip()}; out=[]
 for z in Path(a.proposals).read_text(encoding="utf8").splitlines():
  if not z.strip(): continue
  r=json.loads(z); r["checker"]=c.get(r.get("episode",{}).get("episodeId"),{"checkerStatus":"FAIL","valid":False}); out.append(r)
 Path(a.output).write_text("".join(json.dumps(x,ensure_ascii=False)+"\n" for x in out),encoding="utf8"); print(json.dumps({"rows":len(out),"checkerPass":sum(x["checker"].get("valid") is True for x in out)}))
if __name__=="__main__": main()
