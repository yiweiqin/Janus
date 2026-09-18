#!/usr/bin/env bash
# 让 GPU 盒上的 worker 真领一次活、真跑 predict.py、真回传判定。
#
# 分两步，是为了把"契约对不对"与"模型跑不跑得动"分开：
#   1) 用**云侧落库的那份 case** 跑 predict.py --dry-run —— 只走契约校验，不加载模型。
#      P4 的验收之一是"判定 reason 不再是 input_contract_violation"，这一步直接回答它，
#      而且只要几秒；放到 GPU 之后才知道就要等几分钟。
#   2) 真跑 worker：领活 → 加载 Qwen3-8B + 指定 adapter → 生成 → 回传。
#
# **adapter 必须显式指定**（RDMD_ADAPTER），没有默认值。这里刻意不给兜底：以前它钉在
# qlora-v3 上，于是"该测哪版权重"由一行常量替人决定 —— 而 v4 训完之后，这条路必须能
# 立刻拿去验 v4，而不是等人先发现常量过期。未设就列出盒上现有的 adapter 然后退出。
set -uo pipefail

NODE=/root/.nvm/versions/node/v22.23.2/bin/node
PY=/root/autodl-tmp/rdmd-env/bin/python
JANUS_TRAIN=/root/autodl-tmp/Janus
DEPLOY="$JANUS_TRAIN/experiments/rdmd_detective_dataset/deploy"
STATE=/root/autodl-tmp/rdmd_runs/rdmd_e2e_state.json
BASE=/root/autodl-tmp/models/Qwen3-8B
RUNS=/root/autodl-tmp/rdmd_runs
# 训练已结束，卡都空闲；但仍不替调用方决定用哪张，默认值只是"没指定时最安全的那张"。
DEVICE="${RDMD_DEVICE:-cuda:0}"

if [ -z "${RDMD_ADAPTER:-}" ]; then
  echo "缺 RDMD_ADAPTER：要测哪版权重必须显式说。盒上现有的："
  ls -d "$RUNS"/qlora-*/adapter 2>/dev/null || echo "  （没有找到 qlora-*/adapter）"
  echo "例如：--set RDMD_ADAPTER=$RUNS/qlora-v4/adapter"
  exit 1
fi
ADAPTER="$RDMD_ADAPTER"
[ -f "$ADAPTER/adapter_config.json" ] || { echo "ADAPTER 不存在或不完整：$ADAPTER"; exit 1; }

# adapter 身份是这次验收要证明的东西之一，所以先把它算出来并打在最上面。
# 判定行里也会记同一个 sha（worker 自己算），两处对不上就说明跑的不是我以为的那份。
ADAPTER_SHA=$("$PY" -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$ADAPTER/adapter_model.safetensors" 2>/dev/null \
  || sha256sum "$ADAPTER/adapter_model.safetensors" | cut -d' ' -f1)

[ -f /root/.config/janus/remote.env ] || { echo "缺 remote.env"; exit 1; }
set -a; . /root/.config/janus/remote.env; set +a
[ -f "$STATE" ] || { echo "缺 state（先跑 _rdmd_cloud_e2e.sh submit gpu_worker）"; exit 1; }

JOB_ID=$(grep -o '"jobId": *"[^"]*"' "$STATE" | head -1 | cut -d'"' -f4)
GRANT=$(grep -o '"grant": *"[^"]*"' "$STATE" | head -1 | cut -d'"' -f4)
[ -n "$JOB_ID" ] || { echo "state 里没有 jobId"; exit 1; }
[ -n "$GRANT" ] || { echo "state 里没有 grant"; exit 1; }
# worker id 带上卡号：同一张作业表里能一眼分辨这次是哪个 device 跑的。
WORKER_ID="gpu-e2e-${DEVICE//:/}"
echo "job=$JOB_ID grant=${GRANT:0:12}… adapter=$ADAPTER"
echo "adapter_sha256=$ADAPTER_SHA device=$DEVICE worker_id=$WORKER_ID"

echo
echo "############ 1) 契约预检：用云侧落库的 case 跑 predict.py --dry-run ############"
CASE_FILE=/tmp/rdmd_case_$JOB_ID.json
# 从库里取**过滤后**的载荷 —— 不是本地构造的，就是 worker 真正会拿到的那份。
psql "$DATABASE_URL" -tAc "SELECT case_json FROM public.cloud_rdmd_inference_jobs WHERE id='$JOB_ID'" > "$CASE_FILE"
head -c 300 "$CASE_FILE"; echo
"$PY" "$DEPLOY/predict.py" --input "$CASE_FILE" --model "$BASE" --adapter "$ADAPTER" --dry-run 2>&1 | tail -20
DRY_RC=${PIPESTATUS[0]}
echo "dry_run_exit=$DRY_RC"

echo
echo "############ 2) 真跑 worker（--once）############"
RDMD_DEVICE_GRANT="$GRANT" \
RDMD_ADAPTER="$ADAPTER" \
RDMD_BASE_MODEL="$BASE" \
RDMD_DEVICE="$DEVICE" \
RDMD_CLOUD_API="http://127.0.0.1:8787" \
RDMD_WORKER_ID="$WORKER_ID" \
"$PY" "$JANUS_TRAIN/scripts/rdmd_gpu_worker.py" --once
WORKER_RC=$?
echo "worker_exit=$WORKER_RC"

echo
echo "############ 3) 回读作业行 ############"
psql "$DATABASE_URL" -tAc "SELECT status||' | '||error_code||' | adapter='||left(adapter_sha256,16)||' | base='||base_model_id||' | contract='||contract_version||' | rule='||rule_version||' | worker='||worker_version FROM public.cloud_rdmd_inference_jobs WHERE id='$JOB_ID';"
echo "--- verdict_json ---"
psql "$DATABASE_URL" -tAc "SELECT verdict_json FROM public.cloud_rdmd_inference_jobs WHERE id='$JOB_ID';"
echo "--- grant 里的 scope（确认只有 rdmd:infer，没有读用户数据的权力）---"
psql "$DATABASE_URL" -tAc "SELECT scopes_json FROM public.cloud_sync_grants WHERE user_id=(SELECT owner_user_id FROM public.cloud_rdmd_inference_jobs WHERE id='$JOB_ID');"
