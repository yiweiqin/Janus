#!/bin/bash
F=/root/autodl-tmp/Janus/scripts/train_qlora_rdmd.py
echo "=== new markers present ==="
grep -n 'DEFAULT_MAIN_LOSS\|unknown_in_main =\|sft_meta.get("schemaVersion")' "$F"
echo "=== old blanket ban gone (expect 0) ==="
grep -c 'unknown_in_main_loss:' "$F" || true
echo "=== syntax check ==="
/root/autodl-tmp/rdmd-env/bin/python -c "import ast; ast.parse(open('$F', encoding='utf-8').read()); print('SYNTAX_OK')"
echo "=== local md5 vs remote md5 ==="
md5sum "$F"
echo "=== leftover empty run dir ==="
ls -la /root/autodl-tmp/rdmd_runs/qlora-v3 2>/dev/null || echo "no qlora-v3 dir"
