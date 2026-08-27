# uBuddy-WWW 长程 Web 协作 Benchmark

本目录是 Janus 与公开 WebArena-Verified/BrowserGym 的独立适配层。它不修改官方任务定义或 evaluator。
WorkArena++ 仍作为 legacy 适配保留，但不再是默认 benchmark；WebArena-Verified 的任务、数据和确定性 evaluator 已下载到 `D:\Cli-anything\benchmarks\webarena-verified`，不需要 Hugging Face gated approval。

## 证据等级

运行产物必须标注以下等级，禁止混用：

1. `protocolOnly=true`：只证明 JSONL 协议、事件和 artifact 链路；不是 benchmark 分数。
2. `webarena-verified.evaluator:*`：来自 WebArena-Verified 官方确定性 evaluator 的 task reward。
3. Janus API artifact：来自真实 Cloud API 的画像、选择快照、状态图和归因。
4. 第二轮迁移：只有官方 evaluator 显示迁移任务改善，才能声称联合进化有效。

## 环境

项目使用专用虚拟环境 `D:\Cli-anything\Janus\.venv_www`，已固定 `playwright==1.44.0`、本地 BrowserGym Core 和 WorkArena 0.5.3。若 Playwright Chromium 下载失败，可设置：

```powershell
$env:UBUDDY_WWW_CHROMIUM_EXECUTABLE='C:\Program Files\Google\Chrome\Application\chrome.exe'
```

旧版 WorkArena 运行首先需要在 Hugging Face 申请官方 gated 实例池：

```text
https://huggingface.co/datasets/ServiceNow/WorkArena-Instances
```

填写表单、接受条款并等待审核。获批后在本机执行：

```powershell
D:\Cli-anything\Janus\.venv_www\Scripts\hf.exe auth login
```

登录成功后 WorkArena 会从官方实例池自动取实例。仅在团队自行提供固定实例时才需要手动设置：

```powershell
$env:SNOW_INSTANCE_URL='https://...'
$env:SNOW_INSTANCE_UNAME='...'
$env:SNOW_INSTANCE_PWD='...'
$env:UBUDDY_WWW_BRIDGE_MODE='real'
```

连接 Janus Cloud 时需要：

```powershell
$env:UBUDDY_WWW_JANUS_BASE_URL='http://127.0.0.1:8787'
$env:UBUDDY_WWW_JANUS_ACCESS_TOKEN='...'
$env:UBUDDY_WWW_CANDIDATE_USER_IDS='recipient-user-id-a,recipient-user-id-b'
```

模型调用默认关闭。正式运行时显式开启：

```powershell
$env:UBUDDY_WWW_ENABLE_MODEL='1'
$env:UBUDDY_WWW_MODEL='gpt-5.4-mini'
```

密钥只读取 `CRS_OAI_KEY` 和 `OPENAI_BASE_URL`，产物只保存 usage 和响应哈希，不保存密钥或模型原文。

## WebArena-Verified 执行顺序

无需审核即可先运行：

```powershell
npm run experiment:ubuddy:www:webarena:doctor
npm run experiment:ubuddy:www:webarena:manifest
npm run experiment:ubuddy:www:webarena:canary
```

`doctor` 和 `canary` 的 evaluator-only 检查不等于真实浏览器成功。真实长程执行还需要 Docker 启动 shopping/shopping_admin/reddit/gitlab 等公开网站容器。

## 下一轮正式实验启动

在 Windows 安装并启动 Docker Desktop 后，按顺序执行：

```powershell
npm run experiment:ubuddy:www:sites:start
npm run experiment:ubuddy:www:sites:init
npm run experiment:ubuddy:www:sites:status
npm run experiment:ubuddy:www:preflight
```

正式实验读取 `CRS_OAI_KEY`、`OPENAI_BASE_URL`，并显式开启模型：

```powershell
$env:UBUDDY_WWW_ENABLE_MODEL='1'
$env:UBUDDY_WWW_MODEL='gpt-5.4-mini'
npm run experiment:ubuddy:www:main -- --real
```

`--real` 会启用 WebArena-Verified 真实 BrowserContext、站点自动登录头、Playwright trace 和官方 evaluator。若 `preflight` 失败，正式主实验会被视为未就绪，不应启动。

## Legacy WorkArena 执行顺序

```powershell
npm run experiment:ubuddy:www:tasks
npm run experiment:ubuddy:www:doctor
npm run experiment:ubuddy:www:parity
npm run experiment:ubuddy:www:canary
npm run experiment:ubuddy:www:main
npm run experiment:ubuddy:www:evolution
npm run experiment:ubuddy:www:verify -- --run-dir <run-dir>
npm run experiment:ubuddy:www:report -- --run-dir <run-dir>
```

`parity` 会在官方实例上运行 oracle，检查子任务数、动作数和 `validate()`。`main` 默认拒绝 mock；只有显式 `--allow-mock` 才能运行协议检查。

## 当前会话隔离实现

真实 bridge 由一个 BrowserGym `BrowserEnv` 创建官方任务和 requester 会话。其他 uBuddy 使用同一浏览器进程中的独立 `BrowserContext`，使用任务创建的 ServiceNow 用户重新登录，因此 cookie、页面历史和浏览器存储相互隔离，但数据库任务状态共享。独立身份账户扩展仍需官方实例权限模型验证。

## 原始数据

每次运行写到 `experiments/runs/<run-id>/`。`episodes.jsonl` 是独立 verifier 的输入；`official_evaluations.jsonl` 保存 evaluator 输出；`events.jsonl` 保存脱敏里程碑；完整浏览器 trace 后续由 real runner 写入 `browser_traces/`。
