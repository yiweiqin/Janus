#!/usr/bin/env bash
# 在 GPU 盒上给 RDMD worker 签发凭据（device grant + rdmd:infer）。
#
# 为什么单独一步、且必须是"签发"而不是"读取"：`cloud_sync_grants` 只存 token_hash，
# 明文只在签发那一刻存在。见 scripts/_rdmd_worker_provision.mjs 顶部注释。
#
# 幂等：重复跑会复用已有密钥对、并发一张新 token（旧 token 立即失效，因为
# `issueToken` 是 ON CONFLICT(user_id,device_id) DO UPDATE token_hash）。
set -uo pipefail
NODE=/root/.nvm/versions/node/v22.23.2/bin/node
JANUS=/root/Janus

[ -f /root/.config/janus/remote.env ] || { echo "缺 remote.env"; exit 1; }
set -a; . /root/.config/janus/remote.env; set +a
cd "$JANUS"

echo "=== 签发 worker 凭据（user=${RDMD_WORKER_USER:-svc_rdmd_inference_worker} device=${RDMD_WORKER_DEVICE:-gpu-$(hostname)}）==="
[ -f scripts/_rdmd_worker_provision.mjs ] && SCRIPT=scripts/_rdmd_worker_provision.mjs || SCRIPT=scripts/rdmd_worker_provision.mjs
"$NODE" "$SCRIPT"
RC=$?
echo "=== provision_exit=$RC ==="
exit $RC
