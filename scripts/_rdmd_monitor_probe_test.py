"""Ad-hoc: exercise the train-then-eval monitor's probe strings against the live remote.

The probes are imported from the monitor itself so this test cannot drift from production code.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _rdmd_train_then_eval import Remote, eval_probe, train_probe  # noqa: E402

remote = Remote()

run_dir = "/root/autodl-tmp/rdmd_runs/qlora-v3"
code, out, err = remote.run(train_probe(run_dir), timeout=60)
print("== train probe ==")
print("exit", code)
print(out.rstrip())
print("lines", [line for line in out.splitlines() if line.strip()])

out_dir = "/root/autodl-tmp/rdmd_runs/eval-qlora-v3"
code2, out2, err2 = remote.run(eval_probe(out_dir, 3), timeout=60)
print("== eval probe ==")
print("exit", code2, "out", repr(out2))

# Confirm the streamed eval launcher picks up the export prefix (dry check of the composed script).
script = remote.local_script("_rdmd_remote_eval_splits.sh", {"RUN_TAG": "qlora-v3", "SPLITS": '"test eval_unknown eval_no_drift development"', "GPUS": "3"})
print("== composed script head ==")
for line in script.splitlines()[:4]:
    print(repr(line))
assert 'export RUN_TAG=qlora-v3' in script
assert 'export SPLITS="test eval_unknown eval_no_drift development"' in script
print("COMPOSED_OK")
