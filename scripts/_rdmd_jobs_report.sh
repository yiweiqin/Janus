#!/usr/bin/env bash
# 只读：列出 RDMD 作业与关键出处，验收前后各跑一次做对照。
set -uo pipefail
[ -f /root/.config/janus/remote.env ] && { set -a; . /root/.config/janus/remote.env; set +a; }
echo "############ 作业队列 ############"
psql "$DATABASE_URL" -tAc "
SELECT rpad(left(id, 26), 28) || ' ' || rpad(status, 12) || ' by=' || rpad(coalesce(nullif(claimed_by,''),'-'), 16)
     || ' attempts=' || attempt_count || '/' || max_attempts
     || ' adapter=' || coalesce(nullif(left(adapter_sha256,12),''),'-')
     || ' err=' || coalesce(nullif(error_code,''),'-')
FROM public.cloud_rdmd_inference_jobs ORDER BY created_at;"
echo
echo "############ 判定内容 ############"
psql "$DATABASE_URL" -tAc "SELECT left(id,26) || ' -> ' || coalesce(verdict_json::text,'(null)') FROM public.cloud_rdmd_inference_jobs ORDER BY created_at;"
echo
echo "############ 计数 ############"
psql "$DATABASE_URL" -tAc "SELECT status || ': ' || count(*) FROM public.cloud_rdmd_inference_jobs GROUP BY status ORDER BY status;"
echo "--- API 进程 ---"
pgrep -af "cloud/src/index.mjs" | head -3 || echo "(未运行)"
