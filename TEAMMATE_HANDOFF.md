# Janus uBuddy 研究原型交接说明

## 包含内容

- 完整 Janus `src` 源码；
- Cloud、Network 和部署配置；
- uBuddy 候选画像查询、选择快照、共享协作状态投影；
- 组织—个体双层过程归因与进化证据路由；
- A/B/C/D 可复现实验运行器、测试、实验结果与中文文档。

压缩包不包含 `node_modules`、构建产物、缓存、真实 `.env` 或 API 密钥。

## 本地安装

```powershell
npm ci
npm run experiment:ubuddy:doctor
```

## 已验证测试

```powershell
npm run experiment:ubuddy:test
npm run cloud:test:collaboration-research
npm run cloud:test
npm run cloud:test:evolution
```

其中 Evolution SQLite 测试固定使用 Node 22；仓库命令已经通过 `npx node@22` 处理。测试结果：实验 CLI 4/4、协作研究 1/1、Cloud API 28/28、Evolution 42/42。

## 运行实验

```powershell
npm run experiment:ubuddy:pilot
npm run experiment:ubuddy:analyze -- --run-dir experiments/runs/<run-id>
```

现有预实验结果位于 `experiments/runs/pilot-20260821`。这些结果属于受控合成任务和信息受限规则执行器，只用于验证机制与实验程序，不能直接声称真实大模型协作效果。

## 当前剩余环境条件

完整源码已恢复，但真实云端持久化仍需要 PostgreSQL：

- 配置 `DATABASE_URL`；
- 配置 `EVOLUTION_WORKER_DATABASE_URL`；
- 执行 `npm run cloud:migrate`；
- 启动 `npm run cloud:start` 和 `npm run cloud:evolution-worker`。

模型 Provider 从环境变量读取 `OPENAI_BASE_URL` 和 `CRS_OAI_KEY`。不要把真实密钥提交或发送到群聊。

## 重要文档

- `docs/ubuddy-collaboration-experiment-plan.zh-CN.md`
- `docs/ubuddy-experiment-runbook.zh-CN.md`
- `experiments/source-recovery/verification.md`
- `experiments/runs/pilot-20260821/report.md`
