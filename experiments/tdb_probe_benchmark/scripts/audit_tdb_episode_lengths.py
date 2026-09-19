"""Remote-safe tokenizer/length audit; never loads model weights."""
import argparse, json
from pathlib import Path

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--data',required=True); ap.add_argument('--max-chars',type=int,default=120000); a=ap.parse_args()
    rows=[json.loads(x) for x in Path(a.data).read_text(encoding='utf-8').splitlines() if x.strip()]
    if rows and any('prompt' not in r or 'completion' not in r for r in rows):
        raise SystemExit('qwen_rows_require_prompt_and_completion')
    lengths=[]; oversized=[]
    for r in rows:
        n=len(str(r.get('prompt','')))+len(str(r.get('completion',''))); lengths.append(n)
        if n>a.max_chars: oversized.append({'id':r.get('id'),'chars':n})
    report={'schemaVersion':'tdb-length-audit-v1','rows':len(rows),'maxChars':max(lengths,default=0),'meanChars':sum(lengths)/len(lengths) if lengths else 0,'oversized':oversized,'modelWeightsLoaded':False,'status':'PASS' if not oversized else 'BLOCKED'}
    out=Path(a.data).with_name('length_audit.json'); out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8'); print(json.dumps(report,ensure_ascii=False)); raise SystemExit(0 if not oversized else 1)
if __name__=='__main__': main()
