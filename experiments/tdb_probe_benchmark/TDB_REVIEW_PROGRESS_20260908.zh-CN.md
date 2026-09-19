
## 2026-09-09 论文最小证据包审计

已核对三 seed QLoRA v3 与结构化对照。1024-token 三 seed schemaValidRate 均为 1.0，hardViolationCount 均为 0；但 projection checker 条件充分率均值约 0.589，低于结构化 baseline 约 0.812–0.821，decision agreement 约 0.559，也未显示优于 baseline。因此论文应将“输出预算解决 JSON 截断”作为正面结果，将 projection 决策质量列为未达标与局限，不应继续盲目增加 epoch。论文汇总写入 `runs/paper-evidence-20260909/paper_results.json` 与 `paper_results.md`。当前证据仍为 `SYNTHETIC_FINITE_WORLD_ONLY`，testRead=false、calibrationRead=false。
