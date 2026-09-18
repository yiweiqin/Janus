#!/usr/bin/env bash
# 在盒子上跑 P4 验收 harness（真实云 API + 真实 Postgres，无 mock）。
#
# 参数走环境变量而不是 $1/$2：这个脚本是被 rdmd_ssh.py 以 `bash -s` 流进去执行的，
# 命令行上没有位置参数可传。用 --set STAGE=... --set BACKEND=... 传进来。
#   STAGE   : submit | claim | verify | all
#   BACKEND : null | gpu_worker（只影响 verify 阶段的期望）
set -uo pipefail
STAGE="${STAGE:-all}"
BACKEND="${BACKEND:-null}"

NODE=/root/.nvm/versions/node/v22.23.2/bin/node
JANUS=/root/Janus
[ -f /root/.config/janus/remote.env ] || { echo "缺 remote.env"; exit 1; }
set -a; . /root/.config/janus/remote.env; set +a
cd "$JANUS"

# TASK_RUN / STATE 透传，用于"两个作业"的场景：
# 断言租约与出处校验的那条路径会**占住**一个作业（claim 之后 15 分钟不可再领），
# 所以它必须用一个独立作业，否则真 worker 就没活可领了。见 _rdmd_run_worker_once.sh。
EXTRA=()
[ -n "${TASK_RUN:-}" ] && EXTRA+=(--task-run "$TASK_RUN")
[ -n "${STATE:-}" ] && EXTRA+=(--state "$STATE")
[ -n "${CASE:-}" ] && EXTRA+=(--case "$CASE")
# EXPECT=drift|abstain：verify 阶段对**模型该不该答得出来**的期望。
#   drift   —— case 是单字段变异，答案无歧义，断言 nodeId/type 与 gold 全中。
#   abstain —— case 是结构性缺失（同时像 local_replan 与 missing_dependency），
#              断言它弃权、且弃权也是终态（带 reason 与 unusable_claim 痕迹）。
[ -n "${EXPECT:-}" ] && EXTRA+=(--expect "$EXPECT")
# EXPECT_ADAPTER=<64-hex>：断言判定的出处就是这份权重。没有它，"跑了哪版权重"只能靠人去
# 日志里认 sha —— 而常驻 worker 曾经钉在 qlora-v3 上时，判定照样 completed、出处照样齐全、
# 形状照样合法，**只有 sha 不一样**。所以这条必须能机器核对。
[ -n "${EXPECT_ADAPTER:-}" ] && EXTRA+=(--expect-adapter "$EXPECT_ADAPTER")

echo "=== e2e stage=$STAGE backend=$BACKEND ${STATE:+state=$STATE} ${CASE:+case=$CASE} ${EXPECT:+expect=$EXPECT} ==="
"$NODE" scripts/rdmd_cloud_e2e.mjs --stage "$STAGE" --backend "$BACKEND" "${EXTRA[@]}"
echo "=== e2e_exit=$? ==="
