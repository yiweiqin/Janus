import argparse,json,pathlib,re
ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); a=ap.parse_args()
text=pathlib.Path(a.input).read_text(encoding='utf-8')
bad=re.compile(r'condition|fault_type|ground_truth|oracle|password|token|private_memory|current_test_utility')
hits=sorted(set(x.lower() for x in bad.findall(text)))
print(json.dumps({'input':a.input,'forbidden_hits':hits,'clean':not hits},ensure_ascii=False))
raise SystemExit(1 if hits else 0)
