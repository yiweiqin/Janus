#!/usr/bin/env bash
# 在盒子上跑完模拟任务群的整条闭环：起 API → 起 worker → 生成 → 写库+提交 → 回收。
#
# 这个脚本**在盒子上跑**（由本机 `scripts/sim_remote_run.py` 通过 SSH 送进去）。
# 用法（盒子上）：
#   SIM_MODE=offline RDMD_ADAPTER=/root/autodl-tmp/rdmd_runs/qlora-v4/adapter \
#     bash run_remote.sh
#
# ---------------------------------------------------------------------------
# 关于"幂等可重跑"的准确含义
# ---------------------------------------------------------------------------
#
# **重跑会新增作业行**，这不是 bug。`cloud_rdmd_inference_jobs` 的 upsert 只对
# "同一 task run 未终结的作业"去重（见 `rdmd/index.mjs` 的 `upsertOpenJob`），
# 而每次重跑都会产生新的 case 快照。所以：
#   - `out/` 每次重跑都整个重建 —— 拉回来的报告永远是这一次的，不会和上一次混;
#   - `collaboration_graph_*` 按 `graph_id` 先删后插（`store.writeGraph`）—— 不会重复;
#   - 作业行会累积。要清就用 `scripts/rdmd_cloud_e2e.mjs --stage reset`。
# 也就是说：**管线可重跑、结论可复现（种子固定），但库里会多出历史作业**。
# 把这条写在文件头上，是因为"重跑"在别处通常意味着"不留痕"，这里不是。
#
# ---------------------------------------------------------------------------
# 零人工
# ---------------------------------------------------------------------------
#
# 不需要人做任何一步：模型密钥只在需要 LLM 模式时经 env 注入（不落盘），
# 起停全是脚本。唯一要求是盒子上已有可用的 adapter（因为 `_rdmd_worker_daemon.sh`
# 自己就拒绝给 adapter 设默认值 —— 那个默认值会让 v4 静默退化成 v3）。
set -uo pipefail

NODE="${NODE_BIN:-/root/.nvm/versions/node/v22.23.2/bin/node}"
SIM_RUN_DIR="${SIM_RUN_DIR:-/root/autodl-tmp/sim_run}"
SIM_ROOT="${SIM_ROOT:-$SIM_RUN_DIR/Janus}"
REMOTE_ENV="${REMOTE_ENV:-/root/.config/janus/remote.env}"
RDMD_API="${RDMD_API:-http://127.0.0.1:8787}"
SIM_MODE="${SIM_MODE:-offline}"
SIM_LIMIT="${SIM_LIMIT:-0}"
SIM_SUBMIT_DRY="${SIM_SUBMIT_DRY:-0}"
SIM_SKIP_WORKER="${SIM_SKIP_WORKER:-0}"
# 采集用的 access token 活多久。**必须覆盖整批排空的时间**，因为 collect 是逐条轮询到终态：
# 实测吞吐约 4.5 条/分钟（单卡、v4 adapter），1300 条就要 ~4.8 小时，而 token 原来只有 1 小时
# —— 后果不是报错，而是后半批全部 401、报告里堆成 notTerminal，看起来像模型不行。
# 所以默认给 6 小时，并**按批次规模**给一个下限（见 step 7 的 TTL 计算），
# 宁可多签一会儿（它只活在盒子的环境变量里、不落盘、随那一次 SSH 会话结束即弃）。
SIM_TOKEN_TTL="${SIM_TOKEN_TTL:-21600}"
OUT="$SIM_ROOT/experiments/sim_task_group/out"
REPORT_TAR="$SIM_RUN_DIR/sim_out.tar.gz"

step()  { echo; echo "############ $* ############"; }
fail()  { echo "FAIL: $*" >&2; exit 1; }

# 起停脚本在两个根下各有一份（cloud API 在 /root/Janus，训练 bundle 在
# /root/autodl-tmp/Janus）。不猜哪一个"应该"在，两个都看。
#
# 用 `-f` 而不是 `-x`：这两个脚本在盒子上是 **644** —— 它们是被 SFTP/paramiko 传上去的，
# 那条路不保留可执行位（实测 `_rdmd_worker_daemon.sh` mode=644）。要求可执行位会让
# "脚本明明在那儿"变成 "找不到脚本"。反正所有调用点都是 `bash "$script"`，不需要 x 位。
resolve_script() {
  local name="$1"
  for root in /root/autodl-tmp/Janus /root/Janus; do
    if [ -f "$root/scripts/$name" ]; then echo "$root/scripts/$name"; return 0; fi
  done
  return 1
}

step "0. 前置检查"
[ -x "$NODE" ] || fail "node 不可执行：$NODE"
[ -d "$SIM_ROOT" ] || fail "SIM_ROOT 不存在：$SIM_ROOT（先在本机跑 scripts/sim_remote_run.py）"
[ -f "$REMOTE_ENV" ] || fail "缺 $REMOTE_ENV（DATABASE_URL / JWT_SECRET 在里面）"
set -a; . "$REMOTE_ENV"; set +a
[ -n "${DATABASE_URL:-}" ] || fail "remote.env 里没有 DATABASE_URL"
echo "node        = $("$NODE" -e 'console.log(process.version)')"
echo "SIM_ROOT    = $SIM_ROOT"
echo "SIM_MODE    = $SIM_MODE  SIM_LIMIT=$SIM_LIMIT  SIM_SUBMIT_DRY=$SIM_SUBMIT_DRY"
echo "RDMD_API    = $RDMD_API"
cd "$SIM_ROOT" || fail "cd $SIM_ROOT 失败"

# bundle 不带 node_modules（3.6 GB 的仓库本地都不全量传），由运行环境提供。
# 所以这里**先验一遍裸包能不能解析** —— 否则失败会推迟到 submit 阶段，
# 症状是一个 ERR_MODULE_NOT_FOUND，看起来像代码坏了。
step "1. 裸包可解析性（bundle 不带 node_modules）"
for pkg in pg; do
  if ! "$NODE" -e "await import('$pkg')" 2>/dev/null; then
    fail "裸包 '$pkg' 解析不了。stage 根需要能走到的 node_modules：\
$SIM_ROOT/node_modules -> /root/Janus/node_modules 这样的软链。"
  fi
  echo "ok  $pkg"
done

step "2. 起云 API（幂等：先停后起，确保后端就是我们要的那个）"
if [ "$SIM_SKIP_WORKER" = "1" ]; then
  # 走 null 后端：P4 要的"null 后端下全链路通且恒定 record_only"就是给这种自检用的。
  # 链路能通、作业能终结，只是判定恒为 UNKNOWN。
  export RDMD_BACKEND=null
  echo "SIM_SKIP_WORKER=1 → RDMD_BACKEND=null（作业会终结为 unavailable/UNKNOWN）"
else
  export RDMD_BACKEND="${RDMD_BACKEND:-gpu_worker}"
fi
echo "目标后端 RDMD_BACKEND=$RDMD_BACKEND"

# 从 RDMD_API 反推 host/port，别另开一个硬编码 —— 否则"探的"和"起的"可能不是一个端口。
API_HOST="${RDMD_API#*://}"; API_HOST="${API_HOST%%:*}"
API_PORT="${RDMD_API##*:}"; API_PORT="${API_PORT%%/*}"

CLOUD_START="$(resolve_script _rdmd_cloud_start.sh || true)"
if [ -n "${CLOUD_START:-}" ]; then
  # 盒子上的正式脚本优先：这样"我们在盒子上怎么起 API"只有一份实现。
  echo "用盒子上的 $CLOUD_START"
  CLOUD_LOG="$SIM_RUN_DIR/cloud_start.log"
  if ! bash "$CLOUD_START" > "$CLOUD_LOG" 2>&1; then
    tail -40 "$CLOUD_LOG"
    fail "起云 API 失败（$CLOUD_LOG）"
  fi
  grep -E '^started pid=|^up after|^NODE_ENV=' "$CLOUD_LOG" || tail -20 "$CLOUD_LOG"
else
  # 这台盒子的 `/root/Janus` 是旧快照，没有 `_rdmd_cloud_start.sh`（实测 2026-09-19）。
  # 就地复刻它的配方。两个必须照抄的选择：
  #   NODE_ENV=production —— index.mjs 只在非 production 跑 migrate()，而那个 pool 用的是
  #     api 角色（不是表 owner），会 `must be owner of table`。迁移由 migrator 角色单独跑。
  #   127.0.0.1 —— 容器内网，worker 与 API 同机。
  echo "盒子上没有 _rdmd_cloud_start.sh → 用内置配方（镜像 scripts/_rdmd_cloud_start.sh）"
  # **只在"云部署那两份"里挑**，绝不能落到 $SIM_ROOT：bundle 的 cloud/src/db.mjs 要迁移
  # 098，而盒子的库只到 097，用它起 API 会直接不 ready。
  CLOUD_ROOT=""
  for root in /root/Janus /root/autodl-tmp/Janus; do
    if [ -f "$root/cloud/src/index.mjs" ]; then CLOUD_ROOT="$root"; break; fi
  done
  [ -n "$CLOUD_ROOT" ] || fail "两个根下都没有 cloud/src/index.mjs"
  CLOUD_LOG="$SIM_RUN_DIR/cloud_api.log"
  CLOUD_PID="$SIM_RUN_DIR/cloud_api.pid"
  if [ -f "$CLOUD_PID" ] && kill -0 "$(cat "$CLOUD_PID")" 2>/dev/null; then
    kill "$(cat "$CLOUD_PID")" 2>/dev/null || true
    sleep 2
  fi
  pkill -f 'cloud/src/index.mjs' 2>/dev/null || true
  sleep 1
  echo "cloud root = $CLOUD_ROOT"
  (
    cd "$CLOUD_ROOT" || exit 1
    NODE_ENV=production HOST="$API_HOST" PORT="$API_PORT" \
      RDMD_CLOUD_ENABLED=true RDMD_CLOUD_BACKEND="$RDMD_BACKEND" \
      setsid nohup "$NODE" cloud/src/index.mjs >> "$CLOUD_LOG" 2>&1 &
    echo $! > "$CLOUD_PID"
  )
  echo "started pid=$(cat "$CLOUD_PID" 2>/dev/null) log=$CLOUD_LOG"
  for _ in $(seq 1 20); do
    sleep 1
    if curl -s -m 3 -o /dev/null "$RDMD_API/healthz" 2>/dev/null; then break; fi
    if ! kill -0 "$(cat "$CLOUD_PID")" 2>/dev/null; then
      tail -30 "$CLOUD_LOG"
      fail "云 API 起完就退了（上面是日志尾部）"
    fi
  done
fi

step "3. 云 API 就绪 + rdmd 路由存在"
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$RDMD_API/healthz")
echo "/healthz -> $code"
[ "$code" = "200" ] || fail "/healthz 不是 200"

# **不要拿 /readyz 的 200 当门槛**：它把 S3（JANUS_S3_*）是否配置也算进 ready
# （cloud/src/server.mjs:317 的 `ready = database.ready && ... && storageConfigured`），
# 这台上没配 S3，所以 /readyz 恒 503 —— 而 rdmd 链路只关心 database 那一项。
# 用 503 当门槛会把一台完全能跑的机器判死；反过来只断言 200 又会漏掉真正的库问题。
READYZ_JSON="$(curl -s -m 10 "$RDMD_API/readyz")" "$NODE" --input-type=module -e '
const r = JSON.parse(process.env.READYZ_JSON || "{}");
const db = r.database || {};
const problems = [];
if (db.ready !== true) problems.push(`database.ready=${db.ready}`);
if ((db.missingMigrations || []).length) problems.push(`missingMigrations=${db.missingMigrations.join(",")}`);
if (problems.length) { console.error(`FAIL ${problems.join(" ")}`); process.exit(1); }
const other = [];
if (r.objectStorage && r.objectStorage.configured === false) other.push("objectStorage(S3) 未配置");
if (r.ok !== true) other.push("readyz 整体 not_ready");
console.log(`ok  database.ready=true  migrationHead=${db.migrationHead}`);
if (other.length) console.log(`注意：不影响 rdmd 链路 —— ${other.join(" / ")}`);
' || fail "/readyz 的数据库就绪项没过（上面那行 FAIL 就是原因）"

# **404 与 401 的区别是这一整条链路的关键判据**：路由是无条件注册的，
# 所以未认证应当得 401/403；得到 404 说明跑的是旧 bundle，而不是"没权限"。
route_code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -d '{}' "$RDMD_API/api/rdmd/jobs")
echo "POST /api/rdmd/jobs -> $route_code"
case "$route_code" in
  401|403) echo "ok  路由在（未认证被拒）" ;;
  404) fail "404 = 盒子上的 bundle 没有 rdmd 路由，部署落后。先跑 scripts/rdmd_cloud_deploy.py" ;;
  *) fail "预期 401/403，得到 $route_code" ;;
esac

if [ "$SIM_SKIP_WORKER" != "1" ]; then
  step "4. 起 GPU worker（adapter 无默认值，必须显式给）"
  WORKER_CTL="$(resolve_script _rdmd_worker_daemon.sh || true)"
  # 把"找过哪儿"写进报错里 —— 否则下一个人还是得 ssh 上去 ls 一遍才知道该看哪。
  [ -n "$WORKER_CTL" ] || fail "找不到 _rdmd_worker_daemon.sh（找过 /root/autodl-tmp/Janus/scripts 与 /root/Janus/scripts）"
  [ -n "${RDMD_ADAPTER:-}" ] || fail "RDMD_ADAPTER 没给（daemon 自己也拒绝兜底）"
  [ -f "$RDMD_ADAPTER/adapter_config.json" ] || fail "RDMD_ADAPTER=$RDMD_ADAPTER 不像 adapter 目录"
  echo "worker ctl = $WORKER_CTL"
  echo "RDMD_ADAPTER = $RDMD_ADAPTER"

  # 要的那版权重的 sha —— 用与 daemon 相同的算法，好直接比。
  adapter_sha() {
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$1/adapter_model.safetensors" | cut -d' ' -f1
    else
      /root/autodl-tmp/rdmd-env/bin/python -c \
        "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" \
        "$1/adapter_model.safetensors"
    fi
  }
  WANT_SHA="$(adapter_sha "$RDMD_ADAPTER" 2>/dev/null | cut -c1-16)"
  [ -n "$WANT_SHA" ] || fail "算不出 $RDMD_ADAPTER/adapter_model.safetensors 的 sha"

  # 从 status 里读**进程实际在跑**的那份 sha（daemon 从 worker 日志里取，
  # 不是从变量里推）。status 在进程没跑时不会打印 adapter(running)=。
  running_sha() {
    bash "$WORKER_CTL" status 2>&1 | grep -o 'adapter(running)=[0-9a-f]*' | tail -1 | cut -d= -f2
  }

  # 「现在跑的到底是不是那版代码/那版权重」——两个都要比，因为它们会**各自**过期：
  #   - 权重换了而进程没换 → 判定出处悄悄变成旧 adapter（daemon 里的注释写过这条）；
  #   - 源码换了而进程没换 → 旧协议回传，被云侧 400 拒收（本轮实测烧掉一整轮）。
  # 后者更隐蔽：`start` 见 pidfile 活着就报"已在运行"并 exit 0，而磁盘上的文件
  # 早就换了；adapter 的 sha 完全一致，所以只比 adapter 的话一条告警都不会响。
  #
  # 先解析"将要跑的那份源码"（根的顺序与 `_rdmd_worker_daemon.sh` 的 JANUS_TRAIN 一致），
  # 因为下面的重启判据要用它的 sha。
  WORKER_PY=""
  for root in /root/autodl-tmp/Janus /root/Janus; do
    if [ -f "$root/scripts/rdmd_gpu_worker.py" ]; then WORKER_PY="$root/scripts/rdmd_gpu_worker.py"; break; fi
  done
  [ -n "$WORKER_PY" ] || fail "找不到 rdmd_gpu_worker.py（找过 /root/autodl-tmp/Janus 与 /root/Janus）"
  WANT_SRC_SHA="$(sha256sum "$WORKER_PY" | cut -c1-16)"

  # 进程自报的源码 sha（worker 启动行里的 worker_source_sha256=，由进程自己算）。
  running_src() {
    bash "$WORKER_CTL" status 2>&1 | grep -o 'worker_src(running)=[0-9a-f]*' | tail -1 | cut -d= -f2
  }

  RUN_SHA="$(running_sha)"
  RUN_SRC="$(running_src)"
  RESTART_REASON=""
  if [ -n "$RUN_SHA" ] && [ "$RUN_SHA" != "$WANT_SHA" ]; then
    # **这条不是多余的**：`_rdmd_worker_daemon.sh start` 见到 pidfile 活着就
    # `已在运行` 然后 exit 0 —— 也就是说，想要 v4 而常驻进程喂着 v3 时，
    # start 会成功返回，输出里一点看不出来。判定照样 completed、出处照样齐全，
    # 只有 sha 不一样。所以这里必须先停掉再起。
    RESTART_REASON="权重不对（running=$RUN_SHA want=$WANT_SHA）"
  elif [ -n "$RUN_SHA" ] && [ -z "$RUN_SRC" ]; then
    # 在跑的进程连"我加载的是哪份源码"都不上报 → 它一定早于自报机制那一版，
    # 也就是**旧代码**。没有证据说它新，就按旧的处理（这里宁可多重启一次）。
    RESTART_REASON="在跑的进程早于「源码自报版本」那一版，无法确认它是不是新代码"
  elif [ -n "$RUN_SHA" ] && [ "$RUN_SRC" != "$WANT_SRC_SHA" ]; then
    RESTART_REASON="worker 源码换过了但进程还是旧的（running=$RUN_SRC want=$WANT_SRC_SHA）"
  fi
  if [ -n "$RESTART_REASON" ]; then
    echo "worker 需要重启：$RESTART_REASON"
    bash "$WORKER_CTL" stop || true
    sleep 3
    RUN_SHA=""
  fi
  if [ -z "$RUN_SHA" ]; then
    RDMD_ADAPTER="$RDMD_ADAPTER" bash "$WORKER_CTL" start || fail "起 worker 失败（RDMD_ADAPTER=$RDMD_ADAPTER）"
  else
    echo "worker 已在跑，且权重与源码都正是要的那份（$RUN_SHA / $RUN_SRC）"
  fi

  echo "--- worker 状态 ---"
  bash "$WORKER_CTL" status || true
  FINAL_SHA="$(running_sha)"
  # 起完再验一遍"跑的到底是不是那版"。上面那次 start 的输出只说明**意图**。
  [ "$FINAL_SHA" = "$WANT_SHA" ] \
    || fail "worker 跑的不是要的那版权重（want=$WANT_SHA got=${FINAL_SHA:-unknown}）"
  FINAL_SRC="$(running_src)"
  [ "$FINAL_SRC" = "$WANT_SRC_SHA" ] \
    || fail "worker 在跑的不是磁盘上那份源码（want=$WANT_SRC_SHA got=${FINAL_SRC:-unknown}）—— 重推过 worker 但没重启，或启的根本是另一个根下的副本"
  echo "ok  worker 权重 = ${WANT_SHA}…，源码 = ${WANT_SRC_SHA}…（都与要的一致）"

  step "4.5 worker↔云的协议版本（回传必须带 workerId）"
  # 这一条是**血换来的**：云侧 `recordVerdict` 现在要求回传带 `workerId`
  # （没有它，任何一个 `rdmd:infer` grant 都能终结别人的在飞作业）。但 worker 是
  # **另一份部署** —— 只改云、不重推 worker，症状不是启动失败，而是：
  #   每条作业被 400 `rdmd_worker_id_required` 拒收 → 领活→重试 → `rdmd_attempts_exhausted`
  # 于是报告里只有一堆弃权/失败，看起来像"模型不行"，而真正的原因在两份部署的版本差。
  # 实测就是这样烧掉了一整轮（14 条 failed_terminal，全部 attempts_exhausted）。
  #
  # 所以判据不是"worker 在不在跑"（那已经验过了，含源码 sha 一致性），而是
  # **将要跑的那份源码**会不会自报身份 —— sha 一致只说明"跑的就是磁盘上这份"，
  # 不说明"磁盘上这份是对的版本"。
  # 只看 `/verdict` 那条 POST 之后 25 行内有没有 `workerId`：够近，但不会被文件里
  # 别处的 workerId（领活那次也带）误判成通过。
  if ! awk 'index($0,"/verdict"){n=NR} n && NR<=n+25 && index($0,"workerId"){found=1} END{exit(found?0:1)}' "$WORKER_PY"; then
    fail "盒子上的 worker 回传判定时不带 workerId（$WORKER_PY）—— 云侧会以 rdmd_worker_id_required 400 拒收每一条，作业重试到 attempts exhausted，而报告只会显示弃权/失败。先在本机跑 scripts/rdmd_worker_deploy.py（它推 worker 与 deploy/ 两处），再重启 daemon。"
  fi
  echo "ok  worker 回传协议带 workerId（$WORKER_PY）"

  # 客户端要用的 device grant：worker 从 $CRED 读，collect 也要发同一个头。
  # 只从凭据文件里取，不从库里凑（库里只存 token_hash）。
  if [ -f /root/.config/janus/rdmd_worker.env ]; then
    # shellcheck disable=SC1091
    set -a; . /root/.config/janus/rdmd_worker.env; set +a
    echo "device grant = ${RDMD_DEVICE_GRANT:0:12}…"
  fi
else
  step "4. 跳过 worker（SIM_SKIP_WORKER=1）"
fi

# 每次重跑整个重建 out/：拉回去的报告永远是"这一次"的，不会和上一次混。
step "5. 生成模拟任务群（$SIM_MODE）"
rm -rf "$OUT"
mkdir -p "$OUT"
GEN_ARGS=(--mode "$SIM_MODE" --out "$OUT")
[ "$SIM_LIMIT" != "0" ] && GEN_ARGS+=(--limit "$SIM_LIMIT")
"$NODE" experiments/sim_task_group/simulate.mjs "${GEN_ARGS[@]}" || fail "生成失败"
[ -s "$OUT/generated.jsonl" ] || fail "generated.jsonl 是空的"
echo "cases = $(wc -l < "$OUT/generated.jsonl")"

step "6. 写库 + 提交到 /api/rdmd/jobs"
if [ "$SIM_SUBMIT_DRY" = "1" ]; then
  # 干跑：只做本地审计与批次规划，不写库不提交。用来验证载荷形状。
  "$NODE" experiments/sim_task_group/submit.mjs --dry-run --json || fail "submit 干跑失败"
  echo "（干跑，未写库未提交 → 后面没有作业可回收，collect 会全记 not_submitted）"
else
  RDMD_API="$RDMD_API" "$NODE" experiments/sim_task_group/submit.mjs --json || fail "提交失败"
fi

step "6.5 TPM 原始层申请链（申请→AI 预审→Owner 终审→读→撤回）"
# 为什么插在这里：上一步刚把 `collaboration_graph_*` 写好，而这条链要拿它当**基础层**，
# 并且要交叉校验"申请窗口里的每个节点都真在图里"。跑到最后再验就不是同一份图了。
#
# 这一步**会 fail 掉整条 run**：它不做"记录观测"，只做"断言不变式"——
# 原始层在授权前可见、授权后只给申请窗口、撤回后立刻关上、AI 拒了不产生授权行。
# 任何一条不成立，继续跑出来的报告都不可信，所以宁可在这里断掉。
if [ "$SIM_SUBMIT_DRY" = "1" ]; then
  echo "（干跑，未写库 → 跳过 TPM 链路）"
else
  "$NODE" experiments/sim_task_group/tpm.mjs --out "$OUT/tpm_report.json" || fail "TPM 申请链的不变式没过（上面那行就是原因）"
  "$NODE" --input-type=module -e "
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync('$OUT/tpm_report.json', 'utf8'));
console.log(JSON.stringify({
  cases: r.cases,
  graphsWrittenByTpm: r.graphsWrittenByTpm,
  observations: r.observations.map((o) => ({
    taskId: o.taskId, stateReset: o.stateReset, window: o.window, graphCrossLink: o.graphCrossLink,
    statuses: o.db.requestStatuses, audits: o.db.auditRowsByResultCode, memory: o.memory,
  })),
}, null, 2));
" || fail "读不出 tpm_report.json"
fi

step "7. 回收判定并算指标"
# `GET /api/rdmd/jobs/:id` 要的是 **access token**（`rdmd/index.mjs:90` 读
# `req.auth.user.id`），不是 device grant —— 所以这里现场签一个。
# owner id 从 submit.mjs 里 import，免得"提交的人"和"读的人"哪天悄悄变成两个。
# token 只走变量，不落盘、不进 out/（out/ 是要打包拉回本机的）。
SIM_TOKEN="$("$NODE" --input-type=module -e "
import { signAccessToken } from './cloud/src/security.mjs';
import { SIM_OWNER_USER_ID } from './experiments/sim_task_group/submit.mjs';
process.stdout.write(signAccessToken({
  userId: SIM_OWNER_USER_ID, secret: process.env.JWT_SECRET, expiresInSeconds: ${SIM_TOKEN_TTL},
}));
" 2>/dev/null)" || true
[ -n "${SIM_TOKEN:-}" ] || fail "签不出 access token —— JWT_SECRET 在环境里吗（它来自 remote.env）"
echo "token 已签（owner=user_sim_task_group，TTL=${SIM_TOKEN_TTL}s）"

"$NODE" experiments/sim_task_group/collect.mjs --json --out "$OUT" --token "$SIM_TOKEN" \
  > "$OUT/collect_stdout.json" \
  || echo "（collect 返回非零；作业可能停在 queued —— 没起 worker 时这是预期的，下面照实看报告）"
"$NODE" --input-type=module -e "
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync('$OUT/collect_report.json', 'utf8'));
console.log(JSON.stringify({
  expected: r.expected, scored: r.scored, notTerminal: r.notTerminal,
  model: r.model, baseline: r.baseline, baselineDiagnostics: r.baselineDiagnostics,
  byTier: r.byTier, byVisibility: r.byVisibility,
  actions: r.actions && r.actions.model && r.actions.model.actions,
  shadow: r.shadow, caveats: r.caveats,
}, null, 2));
" || fail "读不出 collect_report.json"

# 7.1 「这一批里到底有没有作业被判过」—— 结果侧的同一道闸。
#
# 上面 4.5 验的是**源码**（将要在跑的那份会不会自报身份），这里验的是**结果**：
# 在飞作业被 400 拒收、worker 没起来、grant 过期，最后都长成同一个样子 ——
# 报告能生成、指标栏全是 0 或 null、退出码却是 0。一份"跑过了"的报告最危险的地方
# 就在这里：它看起来像模型不行，而不像管线断了。所以终态作业为 0 时直接失败。
if [ "$SIM_SUBMIT_DRY" != "1" ] && [ "$SIM_SKIP_WORKER" != "1" ]; then
  "$NODE" --input-type=module -e "
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync('$OUT/collect_report.json', 'utf8'));
if ((r.authRejected || 0) > 0) {
  console.error('[run_remote] ' + r.authRejected + '/' + r.scored + ' 条轮询被 401/403 拒了'
    + ' —— 采集用的 access token 在排空中途过期了（TTL=${SIM_TOKEN_TTL}s）。');
  console.error('[run_remote] 这不是作业或模型的问题：作业仍在库里被 worker 处理完，'
    + '用更长的 SIM_TOKEN_TTL 重跑 collect 即可，不需要重新提交。');
  process.exit(1);
}
const terminal = (r.scored || 0) - (r.notTerminal || 0);
if ((r.expected || 0) > 0 && terminal === 0) {
  console.error('[run_remote] 这一批 ' + r.expected + ' 条作业**没有一条**到终态'
    + '（scored=' + r.scored + ' notTerminal=' + r.notTerminal + '）。');
  console.error('[run_remote] 最常见的原因是 worker 回传被云侧 400 拒收'
    + '（先看 step 4.5 的协议版本），其次才是 worker 没起来 / grant 过期。');
  process.exit(1);
}
console.log('[run_remote] 终态作业 ' + terminal + '/' + r.expected
  + '（未终态 ' + r.notTerminal + '，其中鉴权被拒 0）');
" || fail "采集端的鉴权或终态闸没过 —— 这一轮的报告不可信（见上面两行）"
fi

step "8. 打包回收"
tar -czf "$REPORT_TAR" -C "$SIM_ROOT/experiments/sim_task_group" out || fail "打包失败"
echo "report_tar_bytes=$(stat -c%s "$REPORT_TAR" 2>/dev/null || stat -f%z "$REPORT_TAR")"

echo
echo "############ 完成 ############"
echo "SIM_DONE=1"
echo "SIM_REPORT_TAR=$REPORT_TAR"
