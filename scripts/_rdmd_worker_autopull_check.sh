#!/usr/bin/env bash
# 验证**常驻 worker 会自动把队列里的活干完**（不是靠人工跑 --once）。
#
# 这是 P4 里唯一"没人看着也能工作"的证据。--once 能证明链路通，但证明不了这件事：
# 生产上没有人会每小时去手跑一次。
#
# 两版都栽在同一个坑里，值得写下来：
#   第一版：先 requeue 再等 PENDING==0。空队列上 PENDING 从一开始就是 0，循环立刻
#           break，最后照样打印"OK：常驻 worker 自己把队列清空了" —— 它什么都没证明，
#           只是把"没事可做"说成了"事情做完了"。
#   第二版：要求"开始时就真的有活"。方向对了，但在**活体常驻 worker** 面前会误报：
#           人从开发机提交作业、再跑这条检查，中间隔着几十秒，worker 早就把它干完了
#           （实测就是这么失败的）—— 事实是它工作得很好，检查却说"队列是空的"。
#
# 所以现在：检查**自己往队列里放一条真实作业**，记下它的 jobId，然后什么都不做，
# 只断言这条新作业自己走到了终态且出处齐全。新 jobId 让判定与"跑得快慢"无关：
# 它不可能在放进去之前就被处理过，所以我们不需要去抢那几十秒的时间窗。
#
# 可选断言：RDMD_EXPECT_ADAPTER=<64-hex>。给了就核对完成行的 adapter_sha256 ——
# 否则"自清队列"可能是任何一版权重干的，而这一轮的主题正是"别让出处悄悄过期"。
set -uo pipefail
NODE=/root/.nvm/versions/node/v22.23.2/bin/node
JANUS=/root/Janus
PIDFILE=/root/autodl-tmp/rdmd_runs/rdmd_worker_daemon.pid
LOG=/root/autodl-tmp/rdmd_runs/rdmd_worker_daemon.log
EXPECT_ADAPTER="${RDMD_EXPECT_ADAPTER:-}"
WAIT_SECONDS="${RDMD_AUTOPULL_WAIT:-300}"

[ -f /root/.config/janus/remote.env ] || { echo "缺 remote.env"; exit 1; }
set -a; . /root/.config/janus/remote.env; set +a

pending_count() {
  psql "$DATABASE_URL" -tAc "SELECT count(*) FROM public.cloud_rdmd_inference_jobs
    WHERE status IN ('queued','claimed');"
}
row_status() {
  psql "$DATABASE_URL" -tAc "SELECT status||' | adapter='||coalesce(nullif(left(adapter_sha256,16),''),'-')
    ||' | worker='||coalesce(nullif(worker_version,''),'-')
    ||' | err='||coalesce(nullif(error_code,''),'-')
    FROM public.cloud_rdmd_inference_jobs WHERE id='$1';"
}

echo "############ 0) 常驻进程在不在 ############"
WPID=$(cat "$PIDFILE" 2>/dev/null || echo '')
if kill -0 "$WPID" 2>/dev/null; then
  echo "OK：常驻进程在跑 pid=$WPID"
else
  echo "FAIL：常驻进程没在跑（先 _rdmd_worker_daemon_ctl.sh --set ACTION=start）"; exit 1
fi
# 进程在跑还不够：它喂的是哪版权重决定了下面那条 adapter 断言有没有意义，
# 所以先从日志里把它报出来的 sha 取出来（进程自己算的，不是从变量推的）。
RUNNING_SHA=$(grep -o 'adapter_sha256=[0-9a-f]*' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2)
echo "worker 日志里的 adapter_sha256=${RUNNING_SHA:0:16}…"

echo
echo "############ 1) 往队列里放一条真实作业（这条检查自己放，免得跟 worker 抢时间窗）############"
SUBMIT_OUT=$(cd "$JANUS" && "$NODE" scripts/rdmd_cloud_e2e.mjs --stage submit --backend gpu_worker 2>&1)
echo "$SUBMIT_OUT" | grep -E '^\[ok\] submit|^\[ok\] private|^\[ok\] 未知|^\[ok\] 白名单' || true
INJECTED=$(printf '%s' "$SUBMIT_OUT" | grep -o 'jobId=rdmdjob_[0-9a-f-]*' | head -1 | cut -d= -f2)
if [ -z "$INJECTED" ]; then
  echo "FAIL：没能从 harness 输出里取到 jobId —— submit 大概没成功："
  printf '%s\n' "$SUBMIT_OUT" | tail -20
  exit 1
fi
echo "注入的作业 jobId=$INJECTED"
echo "（从这里往下，除了等待不再对系统做任何事）"

echo
echo "############ 2) 什么都不做，等它自己处理（最多 ${WAIT_SECONDS} 秒）############"
DEADLINE=$(( $(date +%s) + WAIT_SECONDS ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  LEFT=$(pending_count)
  [ "$LEFT" = "0" ] && break
  sleep 5
done

echo
echo "############ 3) 结果 ############"
psql "$DATABASE_URL" -tAc "SELECT status||' | '||id||' | by='||coalesce(nullif(claimed_by,''),'-')
  ||' | attempts='||attempt_count||'/'||max_attempts
  ||' | adapter='||coalesce(nullif(left(adapter_sha256,16),''),'-')
  ||' | worker='||coalesce(nullif(worker_version,''),'-')
  FROM public.cloud_rdmd_inference_jobs ORDER BY created_at;"

echo
echo "--- 注入作业的终态与出处 ---"
echo "$INJECTED -> $(row_status "$INJECTED")"

STATUS=$(psql "$DATABASE_URL" -tAc "SELECT status FROM public.cloud_rdmd_inference_jobs WHERE id='$INJECTED';")
if [ "$STATUS" != "completed" ]; then
  echo "FAIL：注入的作业没有走到 completed（实际 '$STATUS'）"; tail -20 "$LOG"; exit 1
fi

WORKER_VERSION=$(psql "$DATABASE_URL" -tAc "SELECT coalesce(worker_version,'') FROM public.cloud_rdmd_inference_jobs WHERE id='$INJECTED';")
if [ -z "$WORKER_VERSION" ]; then
  echo "FAIL：completed 却没有 worker_version（不知道是谁干的）"; exit 1
fi

INJECTED_ADAPTER=$(psql "$DATABASE_URL" -tAc "SELECT coalesce(adapter_sha256,'') FROM public.cloud_rdmd_inference_jobs WHERE id='$INJECTED';")
if [ -n "$EXPECT_ADAPTER" ] && [ "$INJECTED_ADAPTER" != "$EXPECT_ADAPTER" ]; then
  echo "FAIL：自清用的不是期望的权重：期望 ${EXPECT_ADAPTER:0:16}…，实际 ${INJECTED_ADAPTER:0:16}…"
  exit 1
fi

if [ -n "$EXPECT_ADAPTER" ]; then
  echo "OK：注入作业由 ${WORKER_VERSION} 用期望权重判完（${INJECTED_ADAPTER:0:16}…）"
else
  echo "OK：注入作业由 ${WORKER_VERSION} 判完（adapter=${INJECTED_ADAPTER:0:16}…，未指定期望值故只记录）"
fi
echo "OK：无人值守自清队列 —— 放进去之后没有任何人再动手，它自己走到了终态"
echo "worker_autopull_ok"
