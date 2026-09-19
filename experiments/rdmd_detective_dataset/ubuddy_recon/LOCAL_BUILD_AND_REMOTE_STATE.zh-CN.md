# 本地构建尝试与远程盒子状态（2026-09-19）

本轮起因：交接文档判断「真正缺的只有一个含 RDMD 的桌面安装包」。本文件记录该判断的验证结果、
远程盒子的实测状态，以及两条需要修正的既有结论。

**结论先行**：安装包**能构建成功、且经验证确实含 RDMD**；但**产出的应用启动不起来**，根因未定位到最后一层。
远程盒子一切健在，且**它的云 API 其实带有 `/api/rdmd` 路由**（与 `123.207.22.235` 不同），
但只绑定 `127.0.0.1`，外部不可达。

---

## 一、本地构建：构建通过，运行失败

### 1.1 通过的部分（可复现）

| 步骤 | 结果 |
| --- | --- |
| `npm run pack:win:test`（`--dir`） | 通过 |
| `npm run verify:win:test` | 通过 |

`verify_packaged_app.mjs` 的输出（关键字段）：

```json
{
  "status": "verified",
  "packageName": "janus-test",
  "productName": "Janus Test",
  "version": "1.0.0",
  "sourceCommit": "467d93f44ebe1d1295a8101a376eeac0177601aa",
  "platform": "win32",
  "channel": "test",
  "cloudServerUrl": "http://123.207.22.235",
  "javascriptFilesChecked": 436,
  "runtimeDependenciesChecked": 95,
  "codexVersion": "0.145.0",
  "pythonExecutable": "resources\\python\\python.exe"
}
```

这回答了一个此前只能在本地静态猜测的问题：`build.files` 虽只显式列出 `@openai/codex`，
但 electron-builder 的**生产依赖自动收集确实生效**（`runtimeDependenciesChecked: 95`），
`verify_packaged_app.mjs` 递归遍历 `package.json` 全部 `dependencies` 的要求能被满足。

### 1.2 决定性验证：包里确实有 RDMD

对 `resources/app.asar`（17,104,978 字节）做原始字节搜索，并与**已装官方客户端**对照：

| 关键字 | 我们的构建 | 已装官方客户端 |
| --- | --- | --- |
| `/api/rdmd` | **4** | 0 |
| `rdmdInfer` | **13** | 0 |
| `ensureUBuddyCollaborationGraphSchema` | **4** | 0 |
| `collaboration_graph_nodes` | **43** | — |
| `collaboration_graph_edges` | **15** | — |
| `planExecDrift` | **107** | 0 |
| `ubuddy_plan_exec_drift` | **5** | — |
| `RDMD_CLOUD_URL` | **1** | — |

即：**「已装客户端没有 RDMD」这个诊断是对的，本次构建补上了它。**

### 1.3 失败的部分：应用起不来

`test-artifacts/windows/win-unpacked/Janus Test.exe`（808.6 MB）双击后：

- 进程存活、主线程可响应，但**主窗口从未创建**（只有 Electron 隐藏辅助窗口
  `Chrome_WidgetWin_0` / `Base_PowerMessageWindow`，没有 `Chrome_WidgetWin_1`）
- **任何数据目录都没被创建**：`JANUS_HOME` 指定的目录不存在，日志目录不存在
- 通过 Node inspector（`--inspect=9229`）实测进程内部状态：

```json
{
  "isPackaged": true,
  "userData": "C:\\Users\\zhang\\AppData\\Roaming\\Janus Test",
  "appName": "Janus Test",
  "activeResources": "",
  "activeHandles": ""
}
```

**环境变量确实传进去了**（独立小实验：`Start-Process cmd` 能读到 shell 变量；inspector 也确认
`process.env.JANUS_HOME = D:\Cli-anything\rdmd-desktop\home`），**但 `main.js` 主体从未执行**——
证据是 `process.listenerCount('unhandledRejection') === 0`，而该监听在 `main.js` 第 170 行才注册。

用 `Debugger.scriptParsed` 列出全部已解析脚本：239 个之中只有 **1 个**来自 `app.asar`——
`node_modules/electron-updater/out/main.js`。**`src/main/main.js` 从未被解析**。

**因此根因锁定在 ESM 模块图加载阶段**：某个被 `main.js` import 的模块在求值期间挂住
（空 `activeHandles` + 主线程可响应 + 无任何目录副作用 = 典型的循环依赖死锁或永不 resolve 的顶层等待）。
**未定位到具体是哪个模块。** 这一步需要逐模块二分（或给 `--inspect-brk` 加断点走一遍），本轮到此为止。

### 1.4 为了能构建，必须修的 5 处（已修 3 处）

1. **`assets/auth-defaults.json` 的 `serverUrl` 为空** —— `build_windows_test.mjs` 的
   `publicPackagedCloudUrl()` 会对空串执行 `new URL('')` 抛错，**在下载 Electron 之前就死**。
   已填 `http://123.207.22.235`（未提交）。注意该文件是 git 跟踪的。
2. **`.gitignore` 缺 `/build-runtime/` 与 `/test-artifacts/`** —— 上游有、fork 没有。
   不补的话 `git status` 会多出约 1 GB 未跟踪内容。已补（未提交）。
3. **`scripts/prepare_trial_provider_bundle.mjs` 的守卫被上游「开源构建」改坏** ——
   上游做过一次全局文本替换，把 `'official'` 也换成了 `'open-source'`，于是第 32 行的守卫
   `if (distributionMode === 'open-source')` 恒真，community 模式也会走进内部凭证校验，
   而该校验第一行就是「没凭证就抛」。**表现是：不设任何环境变量也必抛
   `Internal embedded packages require a gateway Key and Base URL.`** 这不是配置问题。
   已把守卫还原为 `if (apiKey && baseUrl)`（未提交）。
4. **漏了第 10 个文件** —— 交接清单只列了 9 个路径，但 `package.json` 的 `test:trial-provider`
   还指向 `scripts/trial_provider_bundle_smoke.mjs`，fork 里同样缺失。
5. **版本号倒挂** —— fork `package.json` 是 `1.0.0`，已装官方 Janus Test 是 `1.1.191`。
   `dist:win:test` 不带 `--version` 会产出 1.0.0 去覆盖 1.1.191。未处理（本轮不需要安装包）。

### 1.5 复用官方包 Python 运行时：验证成立

交接文档这个取巧办法**逐字节成立**，可直接跳过本机 python/pip 与下轮子。
官方包的 `janus-runtime.json` 与上游 `prepare_windows_python_runtime.mjs` 的常量完全一致：

- `schemaVersion: 1`、`pythonVersion: "3.12.10"`
- `pythonArchiveSha256: 4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3`
- `packages` 列表 `JSON.stringify` 逐字相等

且 `assertRuntimeFiles()` 要求的 11 个文件全部存在。钩子会 `exit 0` 直接跳过下载。

### 1.6 工作树与产物

- 已暂存（10 个，均取自 `upstream/main`）：`scripts/{build_windows_test,prepare_trial_provider_bundle,prepare_windows_python_runtime,sign_desktop_update,trial_provider_bundle_smoke,verify_packaged_app,verify_windows_authenticode,verify_windows_python_runtime,windows_authenticode_gate_smoke}.mjs`、`scripts/lib/trialProviderDevEnv.mjs`
- 已修改未暂存（本轮所致，3 个）：`.gitignore`、`assets/auth-defaults.json`、`scripts/prepare_trial_provider_bundle.mjs`
- 未跟踪但在 `.gitignore` 保护下：`build-runtime/`（98.6 MB）、`test-artifacts/`（808.6 MB）
- 仓库外：`D:\Cli-anything\rdmd-desktop\`（启动器、探针脚本、日志、截图）
- **既有 17 个 orgbench 改动 + 381 个未跟踪文件本轮一行未碰**

---

## 二、远程盒子状态（实测）

端点：`connect.bjb1.seetacloud.com:48096`，`root`，主机名 `autodl-container-0zv0wuxn4h-b9dfbe0f`。

| 项 | 实测值 |
| --- | --- |
| 存活 | 是，`up 204 days`，load 5.21 / 7.16 / 10.75 |
| GPU | 3 × **A800-SXM4-80GB，全部空闲**（0 MiB used、0% util）→ 训练已结束 |
| 内存 | 总 1007 GB，用 59 GB |
| 磁盘 | `/` 30G 用 4.1G（余 26G）；`/autodl-pub/data` 10T 用 4.4T（余 5.7T） |
| Postgres | 14 / main / **online**，库 `janus` |
| 云 API | `/root/Janus`，`node cloud/src/index.mjs`，pid 10496，自 09-17 起 |
| 云 API 绑定 | **`HOST=127.0.0.1`、`PORT=8787`**（仅回环） |
| 云 API 开关 | `RDMD_CLOUD_ENABLED=true`、`RDMD_BACKEND=gpu_worker`、`RDMD_CLOUD_BACKEND=gpu_worker` |
| GPU worker | `/root/autodl-tmp/Janus/scripts/rdmd_gpu_worker.py`，pid 66760，自 00:38 起 |

### 2.1 云 API 实测响应

```text
http://127.0.0.1:8787/healthz               -> 200  {"ok":true,"status":"ok","version":"1.0.0"}
http://127.0.0.1:8787/api/rdmd/jobs/__probe__  -> 401
```

**`401` 而不是 `404`，说明 `/api/rdmd` 路由在这个部署上存在。**（对比 `123.207.22.235` 上同一路径返回 404。）

### 2.2 任务队列

```text
status          | count
----------------+-------
completed       |     4
failed_terminal |     1
```

**无 pending、无僵尸任务**（此前修过的僵尸任务问题没有复发）。
worker 日志显示它**已经用 v4 适配器跑过**：

```text
[rdmd-worker] worker=gpu-autodl-container-...-b9dfbe0f api=http://127.0.0.1:8787 adapter_sha256=82855e1ea12723b7...
[rdmd-worker] [ok] job rdmdjob_b1bb0cf5-... -> drift n_step
```

### 2.3 v4 适配器与评测清单

- 适配器：`/root/autodl-tmp/rdmd_runs/qlora-v4/adapter`，**sha256 `82855e1ea12723b71ebe1672b8e76e5f84005db5680c50cf56e4677490fbdd34`**，174,655,536 字节，基座 `/root/autodl-tmp/models/Qwen3-8B`
- 清单 `eval-qlora-v4/eval_manifest.json` **已存在**（`source: "backfill"`，2026-09-18T11:34:36Z）：
  `mergedTotal 3663`；SFT 切分 development 1745 / eval_no_drift 111 / eval_unknown 142 / test 1665；
  含 `manifestSha256`、各切分 `sha256`、`evaluator.sha256`
- 底座模型 `/root/autodl-tmp/models/Qwen3-8B`（5 个 safetensors 分片）
- 历史运行目录：`qlora-v2`、`qlora-v3`、`qlora-v4`、`eval-qlora-v3`、`eval-qlora-v3-checkpoint-530`、`eval-qlora-v4`

### 2.4 协作图表：云端也是空的

```text
collaboration_graphs        0
collaboration_graph_nodes   0
collaboration_graph_edges   0
collaboration_graph_events  0
```

表**存在**（迁移已跑），但**行数为 0**。与桌面端「表都不存在」是两个不同的问题。

---

## 三、两条需要修正的既有结论

### 3.1 「云是唯一通路」——方向对，但当前不可达

原来的推理是：生产环境下 `local_spawn` 必然 `model_script_missing`（脚本在 `experiments/` 下不进包），
所以只能走云。这个推理仍然成立。但实际状况是：

- `123.207.22.235`（发布+同步服务器）**没有 RDMD**（404），也不能去改它的部署
- 盒子的云 API **有 RDMD**（401），但**只监听 `127.0.0.1`**，桌面端无法直连
- 桌面端 `RDMD_CLOUD_URL` 只参与「可用性判断」，真正的提交目标来自 `state.server_url`
  （`cloudSyncClient.js:435`）

**因此要让桌面端真正拿到判定，必须二选一：**
1. 把盒子的云 API 暴露出去（改 `HOST=0.0.0.0` + 端口映射/隧道），并让桌面 `server_url` 指向它；或
2. 把 RDMD 模块部署到 `123.207.22.235`（需要那台的管理权）。

### 3.2 「装完包就闭环」——不成立，且包本身跑不起来

即使忽略 3.1，本轮构建出的应用也无法启动（见 1.3）。所以「先跑真实群任务拿到输入侧数据」
这条路的**前提条件尚未满足**，卡在应用启动而非配置。

---

## 四、未动 / 未决

- **`~/.janus-test/data/janus.db` 逐字节未变**：SHA256 `43844EBD1A5B9C71876471766667233C84543CAE8070EA1018F03F618025D04F`，
  508,911,616 字节，LastWrite `2026-09-19 15:13:58`（与动手前一致）。官方 stable `~/.janus` 同样未动。
- **`dist:win:test` 未产出安装包**：被打断后已清掉 1 GB 暂存目录，`win-unpacked` 保持完好。
- **`D:\Cli-anything\Janus` 磁盘**：`/` 之外的临时占用已清；`%LOCALAPPDATA%\Temp` 下仍有约 4.83 GB
  此前留下的 `janus_*.db` / `rdmd_snap` 快照，未清理。
- **本轮未提交任何东西**。10 个上游脚本已暂存但未提交；3 个修改未暂存。

---

## 五、下一步的可选项（供决策）

| 选项 | 内容 | 依赖 |
| --- | --- | --- |
| A | 定位应用启动死锁（逐模块二分 / `--inspect-brk`），让 `win-unpacked` 能跑 | 纯本地，无需远程 |
| B | 打通云侧：暴露盒子的 `8787` 并改桌面 `server_url`，或把 RDMD 部署到发布服务器 | 需要端口/隧道权限或服务器管理权 |
| C | 不碰桌面端，直接在盒子上用真实数据驱动 RDMD（云 DB 里协作图表为 0，需先造数据） | 纯远程 |
| D | 先给盒子做异地备份（v4 适配器、worker、实验云 DB 是唯一一份） | 纯远程，成本低 |

**风险提示（沿自交接文档）**：该盒子是 v4 适配器、worker 与实验云 DB 的唯一一份，旧训练盒已释放。
**不要释放实例**，建议尽早做异地备份。
