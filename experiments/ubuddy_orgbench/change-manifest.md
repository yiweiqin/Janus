# uBuddy-OrgBench v1 change manifest

本轮相对已有 OrgBench 协议原型的实现变更：

1. `orgbench_experiment.mjs`
   - 新增 `--real-appworld`：启动官方 AppWorld bridge，执行真实 `apis.*` 代码并读取官方 evaluator。
   - 把 requester uBuddy、recipient uBuddy、内部 Agent 的模型决策串成真实双层 episode。
   - 保存官方评测、任务树事件、执行事件、模型 usage、选择快照、加密隐藏真值和错误 artifact。
   - 支持 `--task-count`、`--seeds`、`--methods`，批量运行逐 episode 增量落盘。
   - 增加执行预算上限和模型重试，区分基础设施失败与任务失败。
   - verifier 支持单 episode 与批量 episode，并从 JSONL 独立重算指标。

2. `core/modelPolicy.mjs`
   - 增加模型请求有限重试和 attempt 记录。

3. `core/janusClient.mjs`
   - 新增可选 Janus Cloud profile/candidate/selection/delegation/state-graph/attribution 同步客户端。
   - 默认关闭，未配置 token 时不会影响离线 benchmark。

4. `evaluators/metrics.mjs`
   - 增加官方 checkpoint rate、目标覆盖率、重复任务率、内部分配 regret、组织形成时间等指标。

5. `experiments/ubuddy_appworld/appworld_bridge.py`
   - 修复 Windows GBK 环境下 AppWorld Unicode 输出导致 JSONL bridge 崩溃的问题。

6. `README.md`
   - 明确真实 AppWorld 命令、预算变量、artifact、Janus 同步方式和论文结论边界。

## 已验证运行

- 核心单元测试：5 passed。
- 真实 AppWorld M3 canary：`experiments/runs/orgbench-appworld-canary-1787752579797`，官方 1/8 checkpoint，12.5%。
- 平衡 AppWorld canary：`experiments/runs/orgbench-appworld-pilot-1787754135156`，同任务/seed 的 M0–M3 各 1 episode，4/4 官方 evaluator artifact 完整，官方通过率均为 0%，这是极小预算链路测试，不是方法结论。
- 两个 run 的 `verification.json` 均通过，私有信息泄露检查为 0。

## 尚不能声称

本轮没有运行 TheAgentCompany 主 benchmark、正式规模 AppWorld、人工归因 gold、第二轮迁移或真实 Skill/Memory 采用回滚，因此不能声称组织协议优于基线、归因有效或联合进化有效。
# Evolution loop implementation (2026-08-27)

Implemented the cross-task evolution loop requested for the OrgBench prototype.

## Added

- `core/evolutionCoordinator.mjs`: baseline snapshots, event-derived attribution, organization playbook mining, individual Skill/Memory candidates, evidence gating, Cloud routing, polling, adoption and rollback.
- Cloud organization-evolution API module and additive PostgreSQL migrations `085`, `086`, and `095`.
- `JanusOrgBenchClient` and desktop `SocialClient` methods for organization traces, playbooks, health, personal versions, activation and rollback.

## Integrated

- `orgbench_experiment.mjs evolution` now runs two rounds for E0--E4 with isolated namespaces and writes per-method artifacts.
- Real AppWorld episodes carry round, namespace and active-version context and upload their event chain when Cloud sync is enabled.
- Cloud capability advertisement includes `ubuddy-organization-evolution-v1`.

## Verification

- `npm run experiment:ubuddy:orgbench:test` (9 passing)
- `npm run cloud:test:collaboration-research` (passing)
- `node --test cloud/test/auth-friends.test.mjs` (28 passing)
- PostgreSQL migration applied through `095_ubuddy_orgbench_evolution_head.sql`.

Offline canaries intentionally mark missing evaluator/Cloud evidence as blocked or fallback. They are engineering checks, not paper claims of evolution effectiveness.
