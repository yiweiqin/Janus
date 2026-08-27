# uBuddy-OrgBench v1

## Cross-task evolution loop

Engineering canary (no model/API, must remain `resultEligible=false`):

```powershell
npm run experiment:ubuddy:orgbench:evolution
```

Real two-round AppWorld run after Cloud credentials and participant IDs are configured:

```powershell
npm run experiment:ubuddy:orgbench:evolution -- --real-appworld --task-id 042a9fc_1
```

The runner creates an isolated evolution namespace for every method/seed, runs E0--E4, applies the evidence gate, passes adopted policy/Skill/Memory version IDs into Round 2, and writes rollback records. Missing official evaluator, profile snapshot, Cloud evidence, or credentials is recorded as `blocked`/`fallback`; it is never counted as a formal evolution result.

这是 Janus/uBuddy 的双层多 Agent 组织 benchmark 原型。

它不预设任务树或人员分工。每个 episode 只给 requester uBuddy 一个总问题、候选 uBuddy 的公开画像和可执行环境；任务拆解、邀请、跨人委派、内部 Agent 分配、状态图更新、返工和验收均由 uBuddy 运行时决定。

## 运行

在 `D:/Cli-anything/Janus`：

```powershell
npm run experiment:ubuddy:orgbench:doctor
npm run experiment:ubuddy:orgbench:prepare
npm run experiment:ubuddy:orgbench:canary
npm run experiment:ubuddy:orgbench:canary -- --live-model --method M3_ours
npm run experiment:ubuddy:orgbench:canary -- --real-appworld --method M3_ours --task-id 6f4b9a5_1
npm run experiment:ubuddy:orgbench:verify -- --run-dir <canary-run-dir>
npm run experiment:ubuddy:orgbench:report -- --run-dir <canary-run-dir>
```

`--real-appworld` 才会启动官方 AppWorld 环境、让内部 Agent 执行真实 `apis.*` 代码并调用官方 evaluator；必须先用 1 个任务、1 个 seed 验证，再扩大 pilot。可用环境变量控制预算：

```powershell
$env:UBUDDY_ORGBENCH_MAX_FIRST_LEVEL_TASKS = '5'
$env:UBUDDY_ORGBENCH_MAX_LEAVES_PER_UBUDDY = '4'
$env:UBUDDY_ORGBENCH_MAX_STEPS_PER_AGENT = '3'
$env:UBUDDY_ORGBENCH_MODEL_RETRIES = '3'
npm run experiment:ubuddy:orgbench:pilot -- --real-appworld --task-count 1
```

协议 canary 仍然只验证状态图和权限；没有 `official_evaluation.json` 的 run 不能进入论文成功率表。真实 AppWorld run 会生成 `official_evaluation.json`、`organization_evaluation.json`、`task_tree_events.jsonl`、`execution_events.jsonl`、`model_usage.jsonl`、`errors.jsonl`（若失败）和加密的 `hidden_truth.enc.json`。

当前真实单任务 M3 canary 已验证官方 evaluator 闭环：任务 `6f4b9a5_1` 在严格预算下得到 1/8 checkpoint（12.5%）。这只是链路/预算 canary，不是方法有效性结论；正式比较必须让 M0–M3 使用相同任务、seed、模型预算和故障。

如需把同一 episode 同步到真实 Janus Cloud，设置 `UBUDDY_ORGBENCH_JANUS_SYNC=1`、`UBUDDY_ORGBENCH_JANUS_BASE_URL`、`UBUDDY_ORGBENCH_JANUS_ACCESS_TOKEN` 和候选/recipient user ID；未设置时实验完全离线可运行。

## 角色边界

```text
requester uBuddy → recipient uBuddy → recipient 的内部 Agent
```

只有 uBuddy 可以创建、分配、重新分配和验收节点。内部 Agent 只能执行、报告进度、提交结果和报告阻塞。

## 外部 benchmark

- TheAgentCompany：主真实工作场景，适配器已准备；仓库未下载时 doctor 会明确标记 deferred。
- AppWorld：可控执行和官方 evaluator，复用 `experiments/ubuddy_appworld` 的任务 manifest。
- MARBLE：组织和动态 planner 参考，不把其 LLM judge 分数当成核心真值。
- Who&When：归因参考。
- SWE-bench Verified：第二阶段代码外部验证。
