#!/usr/bin/env bash
# 只读：部署后的 server.mjs 到底是不是本地那一份。用 sha256 对齐，不靠 grep 计数猜。
set -uo pipefail
T=/root/Janus/cloud
echo "--- server.mjs 里含 rdmd 的行 ---"
grep -n -i rdmd "$T/src/server.mjs" || echo "(没有)"
echo "--- 关键文件 sha256（与本地比对）---"
for f in src/server.mjs src/db.mjs src/modules/rdmd/index.mjs src/modules/rdmd/privacy.mjs src/modules/rdmd/backend.mjs src/modules/sync/deviceGrants.mjs src/modules/collaboration/collaborationGraph.mjs database/migrations/097_rdmd_inference_jobs.sql database/migrations/098_rdmd_inference_jobs_grants.sql; do
  if [ -f "$T/$f" ]; then printf "%s  " "$(sha256sum "$T/$f" | cut -c1-16)"; echo "$f"; else echo "MISSING                 $f"; fi
done
echo "--- 目录时间戳 ---"
stat -c '%y %n' "$T/src/server.mjs" "$T/src/db.mjs" 2>/dev/null
echo "--- 迁移目录尾部 ---"
ls -1 "$T/database/migrations" | tail -4
