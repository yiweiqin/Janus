# V4 自进化可行性实验

运行：

```powershell
npm run experiment:v4-feasibility
```

或：

```powershell
node --test src/shared/contracts/uBuddyTaskPublicMemory.test.js src/shared/contracts/uBuddyCapabilityDependencyBundle.test.js src/shared/contracts/uBuddyReverseDetective.test.js
node experiments/v4_self_evolution_feasibility/run.mjs
```

产物：`out/metrics.json`、`out/FEASIBILITY_REPORT.zh-CN.md`，并同步到 `docs/ubuddy-v4-feasibility-report.zh-CN.md`。

本实验验证契约可执行、合成标答可恢复、两个分数不会塌成一个总分。它不训练侦探模型，不接真实任务，也不证明生产自进化。
