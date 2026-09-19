# 远程运行手册（正式数据只在远程机产生）

本机只做代码审查、schema 检查和单元测试；不要在 Windows 本机运行 AppWorld、大模型或正式 benchmark。

## 远程 Ubuntu

```bash
git clone <repo> Janus && cd Janus
npm ci
bash experiments/ubuddy_orgbench/appworld_setup_remote.sh
source .orgbench_env
export UBUDDY_ORGBENCH_REMOTE=1
export UBUDDY_ORGBENCH_OUTPUT_ROOT=/data/janus-runs/orgbench
export APPWORLD_ROOT=/data/benchmarks/appworld-runtime
export APPWORLD_PYTHON=/data/benchmarks/appworld-official/.venv/bin/python
export CRS_OAI_KEY='...'
export OPENAI_BASE_URL='...'
mkdir -p "$UBUDDY_ORGBENCH_OUTPUT_ROOT"
npm run experiment:ubuddy:orgbench:remote-doctor
npm run experiment:ubuddy:orgbench:remote-run -- experiments/ubuddy_orgbench/benchmark.config.example.json
npm run experiment:ubuddy:orgbench:verify -- --run-dir "$UBUDDY_ORGBENCH_OUTPUT_ROOT/main"
npm run experiment:ubuddy:orgbench:report -- --run-dir "$UBUDDY_ORGBENCH_OUTPUT_ROOT/main"
```

`appworld_setup_remote.sh` 会安装官方 AppWorld、下载数据并生成 v2 任务 manifest。MARBLE、Who&When 和 TheAgentCompany 都是可选外部参考，缺失时不应阻塞 AppWorld 主实验。

正式运行前先执行 1 个任务、1 个 seed 的远程 canary，再运行 pilot，最后锁定 test。输出目录支持逐 episode 落盘和断点续跑；密钥只从环境变量读取，不进入 artifact。
