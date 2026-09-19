# TDB Probe 基准：当前代码事实（2026-09-09）

> **研究主张已切换（2026-09-10）。** 当前方案主线见 `Janus/docs/ubuddy-pain-points-innovations-v4-self-evolution.zh-CN.md`。本文只记录 TDB Probe 代码事实，不代表 V4 论文贡献。

本文档是代码事实入口。历史方法说明见 [`UBUDDY_TDB_MAINLINE_METHOD.zh-CN.md`](UBUDDY_TDB_MAINLINE_METHOD.zh-CN.md)。事实来源是同目录代码和根目录 `scripts/` 下的 TDB 训练脚本；历史分析、计划和评审文档统一放在 `docs/archive/`。

## 当前可执行能力

- `engine.mjs` / `runner.mjs`：`tdb-probe-benchmark-v1`，合成 invoice 任务，执行 `noop/A/B/AB`，支持 replay、hash manifest 和 family split。
- `scripts/generate_tdb_world_catalog_v2.py` + `scripts/evaluate_tdb_world_catalog_v2.mjs`：有限世界的 state、interaction、uplift、projection 离线评估。
- `scripts/train_tdb_multitask_v2.py`：结构化 baseline，训练 state posterior、bundle interaction、counterfactual uplift 和 projection proposal。
- `scripts/train_qlora_tdb_multitask.py`：四头 QLoRA 训练入口；当前仍是 synthetic finite-world 数据。
- `scripts/train_qlora_audited.py`：旧的 uplift-only 入口，只能用于历史 uplift 结果，不能代表四目标模型。

## 当前证据边界

当前证据等级是 `SYNTHETIC_FINITE_WORLD_ONLY` 或 `SYNTHETIC_EXECUTION_ONLY`。代码没有真实 held-out evaluator、真实 state/projection gold、方向加权训练头或方向层评估入口。因此不能声称真实任务泛化，也不能声称 directional scoring 已经实现。

## 规范文件

- `tdb_multitask_label_contract_v2.json`
- `tdb_training_protocol_v2.json`
- `tdb_preregistration_v1.json`
- `evaluator_contract.json`

## 待实现 / 待验证

- directional scoring layer：目前只有历史设计文档，尚无代码契约和训练入口；
- 真实 evaluator、真实 gold、双人标注和 transfer 评估；
- calibration/OOD/risk-coverage 的完整主结果；
- 独立 privacy checker 与真实 projection frontier。

## 常用检查

```powershell
node experiments/tdb_probe_benchmark/scripts/validate_tdb_training_protocol.mjs experiments/tdb_probe_benchmark/docs/current/tdb_training_protocol_v2.json
node experiments/tdb_probe_benchmark/scripts/validate_tdb_label_contract.mjs experiments/tdb_probe_benchmark/docs/current/tdb_multitask_label_contract_v2.json
python experiments/tdb_probe_benchmark/scripts/check_docs_code_alignment.py
```
