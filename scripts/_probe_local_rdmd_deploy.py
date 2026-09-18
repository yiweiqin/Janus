import importlib.util
import shutil
from pathlib import Path

print("ssh", shutil.which("ssh"))
print("scp", shutil.which("scp"))
print("rsync", shutil.which("rsync"))
print("plink", shutil.which("plink"))
print("sshpass", shutil.which("sshpass"))
print("paramiko", importlib.util.find_spec("paramiko") is not None)
p = Path("experiments/rdmd_detective_dataset/sft")
print("sft_exists", p.exists())
if p.exists():
    for name in [
        "train.jsonl",
        "development.jsonl",
        "test.jsonl",
        "eval_unknown.jsonl",
        "eval_no_drift.jsonl",
        "manifest.json",
    ]:
        fp = p / name
        print(name, fp.stat().st_size if fp.exists() else "missing")
