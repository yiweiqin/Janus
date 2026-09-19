#!/usr/bin/env bash
# RDMD GPU worker 常驻进程的启停（在 GPU 盒上跑）。
#
# 用法：/root/autodl-tmp/Janus/scripts/_rdmd_worker_daemon.sh {start|stop|status|log}
#
# 为什么要有一个专门的启停脚本，而不是直接 nohup 一行：
#   - worker 的凭据是 **device grant**（`dgr_...`），而 `cloud_sync_grants` 里只存
#     `token_hash` —— 明文 token **只在签发那一刻可见**，不可能从库里读出来。
#     所以凭据来自 `_rdmd_worker_provision.mjs` 签发的那个 0600 文件（见该脚本注释）。
#     本脚本只**读**它，不自己去库里凑一个（第一版就是想从库里 SELECT token，
#     那列根本不存在）。
#   - 同一条设备上只允许有一个 worker（两个 worker 用同一个 grant 会互相抢租约，
#     日志会误导人以为"作业被重复处理"）。
#   - `--once` 模式是给部署验证用的；生产的形态是常驻轮询，空队列是常态。
#
# start 必须显式带 RDMD_ADAPTER（无默认值，见下方注释）：
#   RDMD_ADAPTER=/root/autodl-tmp/rdmd_runs/qlora-v4/adapter \
#   RDMD_DEVICE=cuda:0 bash $0 start
# status 会同时打印「现在跑的」与「上次起的」adapter sha，便于发现两者不一致。
set -uo pipefail
PY=/root/autodl-tmp/rdmd-env/bin/python
JANUS_TRAIN=/root/autodl-tmp/Janus
LOG=/root/autodl-tmp/rdmd_runs/rdmd_worker_daemon.log
PIDFILE=/root/autodl-tmp/rdmd_runs/rdmd_worker_daemon.pid
CRED=/root/.config/janus/rdmd_worker.env
BASE="${RDMD_BASE_MODEL:-/root/autodl-tmp/models/Qwen3-8B}"
# 训练已结束、三张卡都空闲，所以默认给 cuda:0。默认值在这里是可以接受的：
# 选错卡只是选错**算力**，不会让判定悄悄变成"另一版权重产的"——而 adapter 会，见下。
DEVICE="${RDMD_DEVICE:-cuda:0}"

# adapter **没有默认值**，这是刻意的。
# 这份脚本曾经写着 `ADAPTER="${RDMD_ADAPTER:-…/qlora-v3/adapter}"`，于是"生产在喂哪版权重"
# 由一行常量替人决定：v4 训完之后，常驻进程仍会一声不响地喂 v3，而 start 只打印
# `started pid=… device=…`，从输出里完全看不出来。判定照样 completed、出处照样齐全、
# 形状照样合法 —— **只有 sha 不一样**，而没人会去比对没人在看的 sha。
# 出处悄悄过期正是本轮在治的病，所以宁可不启动。
#
# 校验只发生在 start：status/log/stop 正是在"我不确定现在跑的是什么"时才要用的，
# 它们若也要求先给 adapter，就等于在最需要答案的时候把人挡在门外。
if [ -n "${RDMD_ADAPTER:-}" ]; then
  ADAPTER="$RDMD_ADAPTER"
else
  ADAPTER=""
fi

[ -f /root/.config/janus/remote.env ] || { echo "缺 remote.env"; exit 1; }
set -a; . /root/.config/janus/remote.env; set +a

# adapter 身份。v4 的 sha 是 82855e1e…、v3 是 c5193c7c…；起进程前先把它打出来，
# 这样"这次起的是哪版权重"在日志里有据可查，而不是只能靠推论。
adapter_sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$ADAPTER/adapter_model.safetensors" | cut -d' ' -f1
  else
    "$PY" -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" \
      "$ADAPTER/adapter_model.safetensors"
  fi
}

case "${1:-status}" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "已在运行 pid=$(cat "$PIDFILE")"; exit 0
    fi
    # 只有 start 需要 adapter（理由见上方注释）。缺了就报错退出，并列出盒上现有的，
    # 让人不必先 ssh 上去 ls 一遍才知道合法取值是什么。
    if [ -z "$ADAPTER" ]; then
      echo "FAIL：必须显式给 RDMD_ADAPTER（这份脚本不再兜底）。盒上现有的 adapter："
      ls -d /root/autodl-tmp/rdmd_runs/qlora-*/adapter 2>/dev/null | sed 's/^/  /' \
        || echo "  （没找到 qlora-*/adapter）"
      echo "例：RDMD_ADAPTER=/root/autodl-tmp/rdmd_runs/qlora-v4/adapter bash $0 start"
      exit 1
    fi
    [ -f "$ADAPTER/adapter_config.json" ] || {
      echo "FAIL：$ADAPTER 不像 adapter 目录（缺 adapter_config.json）"; exit 1; }
    # 凭据来自 provision，不来自库。缺了就明说怎么办，不要自己编一个。
    [ -f "$CRED" ] || { echo "FAIL：缺 $CRED —— 先跑 _rdmd_worker_provision.sh"; exit 1; }
    # shellcheck disable=SC1090
    set -a; . "$CRED"; set +a
    [ -n "${RDMD_DEVICE_GRANT:-}" ] || { echo "FAIL：$CRED 里没有 RDMD_DEVICE_GRANT"; exit 1; }
    SHA=$(adapter_sha)
    # worker id 的**实际生效值**：凭据文件里通常已经钉了一个（provision 签发时写的），
    # 那是对的 —— 它把"哪份 device grant"与"哪个 worker 身份"配成对，不该被设备名覆盖。
    # 但那就意味着这里必须先把生效值算出来再打印：否则 banner 写着 gpu-daemon-cuda0、
    # 而落库的 claimed_by 是另一个名字，又是一次"输出比事实更确定"。
    WORKER_ID="${RDMD_WORKER_ID:-gpu-daemon-${DEVICE//:/}}"
    echo "adapter=$ADAPTER"
    echo "adapter_sha256=${SHA:0:16}…  ($([ "$SHA" = "$(cat "$LOG.adapter_sha" 2>/dev/null)" ] && echo 与上次相同 || echo 与上次不同))"
    echo "base=$BASE device=$DEVICE worker_id=$WORKER_ID"
    # 把这次起用的 adapter 记下来，供 status 对照"现在跑的"与"上次起的"是否一致。
    echo "$SHA" > "$LOG.adapter_sha"
    RDMD_ADAPTER="$ADAPTER" RDMD_BASE_MODEL="$BASE" RDMD_DEVICE="$DEVICE" \
    RDMD_CLOUD_API="http://127.0.0.1:8787" \
    RDMD_WORKER_ID="$WORKER_ID" \
    nohup "$PY" "$JANUS_TRAIN/scripts/rdmd_gpu_worker.py" >> "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    sleep 3
    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "started pid=$(cat "$PIDFILE") device=$DEVICE worker_id=$WORKER_ID adapter_sha256=${SHA:0:16}… log=$LOG"
      tail -3 "$LOG"
    else
      echo "FAIL：起不来"; tail -20 "$LOG"; exit 1
    fi
    ;;
  stop)
    [ -f "$PIDFILE" ] || { echo "没有 pidfile"; exit 0; }
    PID=$(cat "$PIDFILE")
    kill "$PID" 2>/dev/null && echo "已停 pid=$PID" || echo "进程不在"
    rm -f "$PIDFILE"
    ;;
  status)
    ALIVE=no
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      ALIVE=yes
      echo "running pid=$(cat "$PIDFILE") device=$DEVICE"
    else
      # pidfile 不可信（手工 kill 过），所以再用一次进程名兜底。
      if pgrep -f 'rdmd_gpu_worker.py' >/dev/null 2>&1; then
        ALIVE=yes
        pgrep -af 'rdmd_gpu_worker.py'
      else
        echo "not running"
      fi
    fi
    # 「现在跑的到底是哪版权重」——从 worker 自己的日志里取，而不是从变量里推。
    # 变量只说明**这次启动意图**是什么；日志里那行才是进程真正加载并算过 sha 的那份。
    # 标签必须随进程状态变：没在跑的时候还写 "running"，正是这一轮反复在治的
    # 「输出比事实更确定」。
    RUNNING_SHA=$(grep -o 'adapter_sha256=[0-9a-f]*' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2)
    STARTED_SHA=$(cat "$LOG.adapter_sha" 2>/dev/null || echo '')
    # 只比前 16 位：worker 自己只把 sha 的前 16 位写进日志（见 rdmd_gpu_worker.py 的
    # `adapter_sha256={adapter_sha[:16]}`），而落盘文件里是完整的 64 位。直接比整串
    # 会永远"不一致"—— 第一版就是这样，每跑一次都在喊一个不存在的告警，
    # 而一个总是响的告警等于没有告警。
    RUNNING_SHORT="${RUNNING_SHA:0:16}"
    STARTED_SHORT="${STARTED_SHA:0:16}"
    if [ -n "$RUNNING_SHORT" ]; then
      if [ "$ALIVE" = yes ]; then
        echo "adapter(running)=${RUNNING_SHORT}…"
      else
        echo "adapter(日志里最后一份，进程已停)=${RUNNING_SHORT}…"
      fi
    else
      echo "adapter=未知（日志里没有 adapter_sha256，这个 worker 还没成功起过）"
    fi
    if [ -n "$STARTED_SHORT" ]; then
      echo "adapter(last start)=${STARTED_SHORT}…"
      [ "$RUNNING_SHORT" = "$STARTED_SHORT" ] || echo "  注意：两者不一致 —— 日志里有别的 adapter 的痕迹"
    fi
    # 同一套纪律用在**源码**上：进程加载的那份 worker 源码，与磁盘上现在这份是不是同一份。
    # 「重推了 worker、忘了重启」时，adapter 的 sha 完全一致（权重没换），只有这里会说话。
    RUNNING_SRC=$(grep -o 'worker_source_sha256=[0-9a-f]*' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2)
    if [ -n "$RUNNING_SRC" ]; then
      if [ "$ALIVE" = yes ]; then
        echo "worker_src(running)=${RUNNING_SRC}…"
      else
        echo "worker_src(日志里最后一份，进程已停)=${RUNNING_SRC}…"
      fi
    else
      echo "worker_src=未知（这个 worker 起得比这行日志还早，重启一次即可上报）"
    fi
    psql "$DATABASE_URL" -tAc "SELECT 'queue: '||count(*) FILTER (WHERE status='queued')||' queued, '
      ||count(*) FILTER (WHERE status='claimed')||' claimed, '
      ||count(*) FILTER (WHERE status='completed')||' completed'
      FROM public.cloud_rdmd_inference_jobs;"
    ;;
  log) tail -30 "$LOG" ;;
  *) sed -n '2,16p' "$0" ;;
esac
