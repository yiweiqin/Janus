# uBuddy-WWW 本地改动清单

基线标识：用户指定的 Janus 基线 `6f372d3`。当前 `D:\Cli-anything\Janus` 位于外层 CLI-Anything 工作树的忽略目录中，因此 Git 无法直接生成该子目录相对基线 diff；本文件列出可人工复核的全部 benchmark 改动。

## 新增

- `experiments/ubuddy_www/schema.mjs`：episode/event/artifact 契约、脱敏和 evaluator 归一化。
- `experiments/ubuddy_www/browsergym_bridge.py`：mock/real JSONL bridge、独立 BrowserContext、官方 WorkArena validate。
- `experiments/ubuddy_www/tasks.manifest.json`：12 个官方 WorkArena++ L2 task ID。
- `experiments/ubuddy_www/tasks.manifest.template.json`：任务清单模板。
- `experiments/ubuddy_www/README.md`：运行、证据等级和环境说明。
- `experiments/ubuddy_www/annotation_guide.md`、`annotation_schema.json`：96 条轨迹双人盲标协议。
- `scripts/ubuddy_www_experiment.mjs`：doctor/canary/main/evolution/external/verify/report runner。
- `scripts/ubuddy_www_experiment.test.mjs`：协议、运行门控和隐私测试。
- `scripts/enumerate_workarena_tasks.py`：从官方注册表生成固定 task manifest。
- `scripts/verify_workarena_manifest.py`：官方实例 oracle/evaluator parity 验证器。
- `experiments/ubuddy_www/webarena_verified_tasks.manifest.json`：从公开 812-task 数据集固定出的 12-task 长程 split，记录数据 SHA-256。
- `scripts/generate_webarena_verified_manifest.py`：不依赖模型结果的可审计任务选择器。
- `scripts/webarena_verified_evaluator.py`：调用官方 WebArena-Verified 确定性 evaluator 的 JSONL/CLI bridge。
- `scripts/webarena_verified_selftest.py`：官方 evaluator 一正一负 parity 自检。
- `experiments/ubuddy_www/browsergym_bridge.py`：新增 WebArena-Verified real mode；独立 BrowserContext、自动登录头、站点初始化、跨会话 trace 合并和官方 evaluator 输出。
- `scripts/webarena-sites-start.ps1`、`webarena-sites-init.ps1`、`webarena-sites-status.ps1`、`webarena-sites-stop.ps1`：Docker 站点生命周期脚本。
- `scripts/webarena_www_preflight.mjs`：正式 episode 前的 dataset/manifest/站点可达性门禁。
- `scripts/webarena_real_bridge_smoke.py`：Shopping Admin 真实浏览器链路冒烟，包含 trace 和官方错误拒绝检查。

## 修改

- `package.json`：新增 `experiment:ubuddy:www:*` 命令。

## 外部 benchmark

只读取 `D:\Cli-anything\benchmarks\browsergym`、`D:\Cli-anything\benchmarks\workarena` 和 `D:\Cli-anything\benchmarks\webarena-verified`；没有修改官方任务或 evaluator。

## 生成但不作为论文结果

- `experiments/runs/www-canary-*`：mock 协议 canary。
- `experiments/runs/www-main-mock-check-v2`：144 episode 协议编排验证。

上述 mock 产物不能作为 WebArena-Verified/WorkArena++ 成功率或联合进化有效性证据。

## 本次迁移结论

WebArena-Verified 数据和 evaluator 已在本地可用，不需要 gated benchmark 审核。Docker Desktop 已安装并启动，Shopping Admin 真实 bridge 冒烟已通过；Reddit/GitLab 镜像拉取受 Docker Hub 网络/授权 token EOF 影响，未把半成品容器当作就绪环境。重试 `npm run experiment:ubuddy:www:sites:start` 后，`preflight` 会自动确认三站点全部可达。

## uBuddy-AppWorld-Hybrid 新增适配（2026-08-26）

- `experiments/ubuddy_appworld/`：AppWorld 主 benchmark、bridge、任务 manifest、故障目录、实验计划、云端脚本和中文说明。
- `scripts/generate_ubuddy_appworld_manifest.py`：按 difficulty、应用数、API 数和参考调用数固定 12 个长程 test_normal 任务。
- `experiments/ubuddy_appworld/appworld_experiment.mjs`：doctor/prepare/manifest/canary/main/attribution/evolution/external/verify/report/package。
- `experiments/ubuddy_appworld/appworld_bridge.py`：调用官方 AppWorld reset/execute/evaluate，禁止返回 ground-truth 文件。
- `package.json`：新增 `experiment:ubuddy:appworld:*` 命令。
- `outputs/ubuddy-appworld-hybrid-package-v1.zip`：不含密钥、数据库和运行结果的云端代码包。

AppWorld 官方源码和 Git LFS bundle 已通过公开仓库获取并成功解包；运行数据已下载到 `D:\Cli-anything\benchmarks\appworld-runtime`。真实模型 canary 已能到达 AppWorld 官方 evaluator，当前任务得分为 0.125（刻意限制每个子任务最多一步，作为链路 canary，不是论文结果）。
