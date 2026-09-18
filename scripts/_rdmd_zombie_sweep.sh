#!/usr/bin/env bash
# 在**真实 Postgres** 上验证"次数用尽的作业会被收成终态"。
#
# 为什么本机 pg-mem 的单测不够：那条测试证明的是**逻辑**（选行条件与收尾语句写对了），
# 而这里要证明的是**这台 Postgres 真的这么执行** —— 收尾语句里用到了
# `lease_expires_at <= now()`、`completed_at=now()`、`status IN (...)` 以及和
# `chk_cloud_rdmd_job_provenance` 约束的相互作用（终态必须 verdict_json IS NULL）。
# pg-mem 对这几个的解析与真实 PG 不是同一套实现，所以换到真机上再走一遍。
#
# 场景照抄真机上的失败形态：worker 领了活、反复答不出、租约过期、次数用尽。
# 修之前它会永远停在 claimed（选行条件 attempt_count < max_attempts 把它永久排除），
# 占着去重索引又不被任何人处理。修之后它必须变成 failed_terminal。
set -uo pipefail
NODE=/root/.nvm/versions/node/v22.23.2/bin/node
JANUS=/root/Janus
STATE=/root/autodl-tmp/rdmd_runs/rdmd_zombie_state.json
export STATE

[ -f /root/.config/janus/remote.env ] || { echo "缺 remote.env"; exit 1; }
set -a; . /root/.config/janus/remote.env; set +a
cd "$JANUS"

echo "############ 1) 造一条新作业 ############"
"$NODE" scripts/rdmd_cloud_e2e.mjs --stage submit --backend gpu_worker \
  --state "$STATE" --task-run "zombie_$(date +%s)" --case wrong_agent > /tmp/rdmd_zombie_submit.log 2>&1
JOB=$(grep -o '"jobId": *"[^"]*"' "$STATE" | head -1 | cut -d'"' -f4)
GRANT=$(grep -o '"grant": *"[^"]*"' "$STATE" | head -1 | cut -d'"' -f4)
[ -n "$JOB" ] || { echo "没拿到 jobId"; cat /tmp/rdmd_zombie_submit.log; exit 1; }
export JOB
echo "job=$JOB"

echo
echo "############ 2) 模拟"领了活、租约过期、次数用尽" ############"
psql "$DATABASE_URL" -tAc "UPDATE public.cloud_rdmd_inference_jobs
  SET status='claimed', claimed_by='worker-doomed',
      attempt_count=max_attempts, lease_expires_at=now() - interval '1 second'
  WHERE id='$JOB' RETURNING status||' | attempts='||attempt_count||'/'||max_attempts;"

echo
echo "############ 3) 再领一次（这就是触发收尾的那一步）############"
curl -s -m 20 -X POST "http://127.0.0.1:8787/api/rdmd/jobs/claim" \
  -H "Authorization: Bearer $GRANT" -H 'Content-Type: application/json' \
  -d '{"workerId":"zombie-probe","limit":4}' | "$NODE" -e '
let raw = ""; process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const body = JSON.parse(raw);
  const ids = (body.jobs || []).map((job) => job.jobId);
  console.log(`claim 返回 ${ids.length} 条：${JSON.stringify(ids)}`);
  if (ids.includes(process.env.JOB)) {
    console.error("FAIL：用尽次数的作业又被领走了");
    process.exit(1);
  }
  console.log("OK：用尽次数的作业没有被再领走");
});' 

echo
echo "############ 4) 作业行的终态 ############"
psql "$DATABASE_URL" -tAc "SELECT status||' | error_code='||error_code||' | lease='||coalesce(lease_expires_at::text,'NULL')
  ||' | completed_at='||coalesce(completed_at::text,'NULL')||' | verdict='||coalesce(verdict_json::text,'NULL')
  FROM public.cloud_rdmd_inference_jobs WHERE id='$JOB';"

STATUS=$(psql "$DATABASE_URL" -tAc "SELECT status FROM public.cloud_rdmd_inference_jobs WHERE id='$JOB';")
CODE=$(psql "$DATABASE_URL" -tAc "SELECT error_code FROM public.cloud_rdmd_inference_jobs WHERE id='$JOB';")
if [ "$STATUS" = "failed_terminal" ] && [ "$CODE" = "rdmd_attempts_exhausted" ]; then
  echo "OK：僵尸作业已收成 failed_terminal / rdmd_attempts_exhausted"
else
  echo "FAIL：期望 failed_terminal / rdmd_attempts_exhausted，实际 $STATUS / $CODE"
  exit 1
fi

echo
echo "############ 5) 同一个 task run 现在能重新入队（僵尸行不再占着去重索引）############"
TASK=$(psql "$DATABASE_URL" -tAc "SELECT task_run_id FROM public.cloud_rdmd_inference_jobs WHERE id='$JOB';")
"$NODE" scripts/rdmd_cloud_e2e.mjs --stage submit --backend gpu_worker \
  --state "$STATE" --task-run "$TASK" --case wrong_agent > /tmp/rdmd_zombie_resubmit.log 2>&1
grep -o '\[ok\] submit -> [a-z_]*' /tmp/rdmd_zombie_resubmit.log
psql "$DATABASE_URL" -tAc "SELECT status||' | '||id FROM public.cloud_rdmd_inference_jobs
  WHERE task_run_id='$TASK' ORDER BY created_at;"
NEW=$(psql "$DATABASE_URL" -tAc "SELECT status FROM public.cloud_rdmd_inference_jobs
  WHERE task_run_id='$TASK' ORDER BY created_at DESC LIMIT 1;")
[ "$NEW" = "queued" ] || { echo "FAIL：同一 task run 无法重新入队（僵尸行仍占着去重索引）"; exit 1; }

echo
echo "zombie_sweep_ok"
