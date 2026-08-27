# uBuddy 协作实验运行手册

## 当前可运行范围

本地运行器把论文实验拆成四层：A 架构数据通路、B 状态辅助决策、C 双层过程归因、D 下一轮联合进化。默认运行是确定性的合成预实验，不调用大模型，也不声称证明真实任务表现提升。

当前仓库已经恢复根目录 `src/shared`，本机 PostgreSQL 17、Cloud API 和 Evolution Worker 也已可用。现在可以运行真实数据库冒烟实验，验证候选画像、选择快照、共享状态图、过程归因、进化证据和隐私过滤的数据链路。

这仍不等于论文规模实验已经完成：真实模型协作、Skill/Memory 的实际生成与采用、负迁移回滚，以及 B/C/D 的统计显著性实验仍需单独执行。

## 命令

```powershell
cd D:\Cli-anything\Janus
npm run experiment:ubuddy:doctor
npm run experiment:ubuddy:pilot
npm run experiment:ubuddy:postgres-smoke
npm run experiment:ubuddy:live-main
npm run experiment:ubuddy:verify-live -- experiments/runs/live-main-<timestamp>
npm run experiment:ubuddy:analyze -- --run-dir experiments/runs/<run-id>
npm run experiment:ubuddy:paper
```

默认 `pilot` 生成 30 个 A 样本、144 个 B episode、256 份 C 归因输出，以及 D 的 24 个共享第一轮和 120 个第二轮条件样本。输出位于 `experiments/runs/<timestamp>/`。

`postgres-smoke` 不调用大模型，使用真实 PostgreSQL 和 Cloud API 创建一个最小协作场景。它会验证：预发布能力画像查询、委派时画像版本冻结、画像升级后的历史快照保持、失败重试与需求修订事件、`superseded`/`adopted` 结果版本、共享图与双层归因、私有工作区过滤，以及进化证据路由。输出位于 `experiments/runs/postgres-smoke-<timestamp>/`。

`live-main` 是首轮真实模型主实验，运行前会检查 PostgreSQL、Cloud API、Evolution Worker、模型可用性、真实数据库冒烟和关键回归测试。通过后执行 B2/B3 共 24 次、C2/C3 共 64 次、D0-D4 共 20 次，总计 108 次真实模型调用。输出位于 `experiments/runs/live-main-<timestamp>/`。

`verify-live` 不调用模型，独立读取 `B/C/D-cases.jsonl` 和 `*-live-results.jsonl`，重新计算每个字段的正确性，并检查聚合指标是否与 `metrics.json` 一致。`prompts.jsonl` 保存完整提示，`prompt-audit.json` 校验提示哈希，`scored-cases.csv` 可直接用 Excel 审计。

## 16 次模型校准

模型校准必须显式启用，并提供当前供应商的人民币计价参数，费用计算才可能被硬门控：

```powershell
$env:UBUDDY_INPUT_CNY_PER_MTOK = "<每百万输入 token 价格>"
$env:UBUDDY_OUTPUT_CNY_PER_MTOK = "<每百万输出 token 价格>"
npm run experiment:ubuddy:pilot -- --live-model --max-cost-yuan 100
```

运行器只读取 `OPENAI_BASE_URL`、`CRS_OAI_KEY` 和上述价格变量，不把密钥写入工件。未设置价格时，模型校准会以 `pricing_not_configured` 阻断，不会调用 API。

如果实验负责人明确要求不计算费用，可以显式跳过价格门控。调用次数仍固定为最多 16 次，并在实验产物中记录 `costTracking: disabled_by_user`：

```powershell
npm run experiment:ubuddy:pilot -- --live-model --ignore-cost
```

## 输出解释

- `config.json`：实验版本、模型、随机种子、代码提交和费用上限。
- `A-architecture.jsonl`：30 个数据与安全不变量样本。
- `B-state-decision.jsonl`：四种信息条件下的候选选择与协调结果。
- `C-attribution.jsonl`：金标准原因、预测原因、证据引用与阻断决策。
- `D-joint-evolution.jsonl`：五种更新策略的第二轮迁移表现。
- `metrics.json`、`summary.json`：可独立重算的聚合结果。
- `report.md`：自动生成的中文结果摘要和结论边界。
- `change-manifest.md`：实验工具相对研究基线的改动说明。
- `source-manifest.json`：实际参与实验的代码文件、字节数和 SHA-256；当 Janus 目录不是独立 Git checkout 时用它审计版本。
- `prototype-regression.json`：真实 pg-mem 协作模块回归是否通过，不是合成模拟结果。

合成结果只用于验证实验程序、指标方向和方差。论文结论必须在 PostgreSQL、完整云端服务和真实模型/参与者条件下复现。

## Node 版本说明

Evolution 的 SQLite 迁移测试固定使用 Node 22。Node 24 自带 SQLite 3.51 默认禁止迁移代码使用的 `PRAGMA writable_schema`，会出现 `table sqlite_master may not be modified`；同一套 42 个 Evolution 测试在 Node 22.23.2 下全部通过。
