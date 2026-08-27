# uBuddy-AppWorld 混合 Benchmark

这是 Janus/uBuddy 的主实验套件，保留既有两项创新点不变：

1. 建群前每个 uBuddy 独立发布能力画像，requester 查询候选、选择 recipient，并冻结画像版本；
2. 协作完成后，从完整轨迹中生成组织层/个体层归因，并通过证据门控进入下一轮策略或能力演化。

## Benchmark 构成

```text
AppWorld（ACL 2024 Best Resource）
    提供长程、多应用、确定性任务和官方 evaluator
MARBLE / MultiAgentBench（ACL 2025 Main）
    提供多 Agent 协作拓扑与里程碑指标的协议参考
Who&When（ICML 2025 Spotlight）
    提供失败责任人/关键步骤归因数据和评估方式
WebArena-Verified
    作为真实 Web 外部验证，不作为主任务来源
```

本目录中的 benchmark 是“基于公开 benchmark 的可复现实验套件”，不是声称重新发布 AppWorld 或 MARBLE 的官方数据。

## 直接运行前提

- AppWorld 官方源码：`D:/Cli-anything/benchmarks/appworld-official`
- AppWorld 运行数据：`D:/Cli-anything/benchmarks/appworld-runtime`
- AppWorld Python：`D:/Cli-anything/benchmarks/appworld-official/.venv313/Scripts/python.exe`
- Janus Node.js：Node 24+
- 模型：`CRS_OAI_KEY`、`OPENAI_BASE_URL`
- 不需要 WorkArena/ServiceNow 审核；不需要启动 WebArena Docker 才能先做主实验。

## 命令

在 Janus 根目录运行：

```powershell
npm run experiment:ubuddy:appworld:doctor
npm run experiment:ubuddy:appworld:prepare
npm run experiment:ubuddy:appworld:manifest
npm run experiment:ubuddy:appworld:canary
npm run experiment:ubuddy:appworld:main
npm run experiment:ubuddy:appworld:attribution
npm run experiment:ubuddy:appworld:evolution
npm run experiment:ubuddy:appworld:external
npm run experiment:ubuddy:appworld:verify
npm run experiment:ubuddy:appworld:report
npm run experiment:ubuddy:appworld:package
```

默认 `canary` 是协议/数据链路验证；需要真实 AppWorld evaluator 时设置：

```powershell
$env:UBUDDY_APPWORLD_ENABLE_REAL='1'
```

## 主任务选择规则

从 AppWorld `test_normal` 固定选择任务，不根据模型结果筛题：

- difficulty >= 3；
- 至少 2 个 App；
- 至少 30 个官方 solution API calls；
- 至少 8 个不同 API；
- 至少 2 个可独立分工的子目标；
- 每个任务只记录 task ID、instruction、官方 metadata，不复制 private ground truth 到实验 artifact。

固定清单：`appworld_tasks.manifest.json`。

## 一个 episode 的生命周期

```text
reset AppWorld task
→ requester 查询建群前能力画像
→ 选择 recipient 并冻结 profile snapshot
→ 生成 3–5 个子任务和依赖边
→ recipient 通过各自 AppWorld facade 执行
→ 写入共享状态、失败、重试和结果版本
→ 官方 AppWorld evaluator 验收
→ 双层过程归因
→ 证据门控和进化候选
→ 在同族迁移任务上验证下一轮效果
```

## 方法组

- `M0_single_agent`：一个 Agent 独立完成任务；
- `M1_static_profile`：多 Agent + 无版本静态画像；
- `M2_generic_shared`：多 Agent + 普通共享消息，无快照/结果版本/归因门控；
- `M3_ours`：版本化画像、选择快照、共享状态、结果版本、双层归因和证据门控。

## 证据级别

1. `protocolOnly=true`：只证明编排和 artifact 契约；
2. `appworld.evaluator:*`：官方 AppWorld 任务结果；
3. `attribution.gold`：Who&When 风格责任归因；
4. `transfer.official`：第二轮迁移任务改善，才可声称联合进化有效。
