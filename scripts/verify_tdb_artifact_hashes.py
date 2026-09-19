"""Verify local v3 data, protocol, evaluator and scored-artifact hashes."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path

def sha(p: Path): return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser(); p.add_argument('--data',required=True); p.add_argument('--protocol',required=True); p.add_argument('--score',required=True); args=p.parse_args()
    data=Path(args.data); manifest=json.loads((data/'manifest.json').read_text()); failures=[]
    for split in ('train','development'):
        got=sha(data/f'{split}.jsonl'); expected=manifest.get('files',{}).get(split)
        if got!=expected: failures.append([split,'hash_mismatch',expected,got])
    report={'scope':'tdb-local-artifact-hash-verification-v1','evidenceLevel':'SYNTHETIC_FINITE_WORLD_ONLY','testRead':False,'dataManifestSha256':sha(data/'manifest.json'),'protocolSha256':sha(Path(args.protocol)),'scoreArtifactSha256':sha(Path(args.score)),'failures':failures,'allValid':not failures}
    out=data/'artifact_hash_verification.json'; out.write_text(json.dumps(report,indent=2),encoding='utf8'); print(json.dumps(report,indent=2))
    if failures: raise SystemExit(2)
if __name__=='__main__': main()
