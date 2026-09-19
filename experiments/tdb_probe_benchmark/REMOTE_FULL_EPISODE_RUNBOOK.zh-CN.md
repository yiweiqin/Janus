# 完整双 Agent episode 远端训练操作

## 本地生成与审计

将每个 `task/delegation/episode` 导出为 JSONL；每行必须符合 `tdb_episode_contract_v1.json`。`conversation` 必须包含授权后的完整消息序列，敏感字段在导出前脱敏。

```powershell
python experiments/tdb_probe_benchmark/scripts/score_tdb_episode.py `
  experiments/tdb_probe_benchmark/runs/episodes.raw.jsonl `
  experiments/tdb_probe_benchmark/runs/episodes.labeled.jsonl
node experiments/tdb_probe_benchmark/scripts/validate_tdb_episode.mjs `
  experiments/tdb_probe_benchmark/runs/episodes.labeled.jsonl
python experiments/tdb_probe_benchmark/scripts/prepare_tdb_episode_qwen.py `
  --input experiments/tdb_probe_benchmark/runs/episodes.labeled.jsonl `
  --output experiments/tdb_probe_benchmark/runs/tdb-episode-qwen-v1
```

`score_tdb_episode.py` 只计算确定性派生字段；真实披露 gold 和进化 gold 必须由独立 evaluator、solver 或双人标注写入，不能把启发式派生值当作真实金标签。

## 上传远端

使用已有 `prepare-upload.mjs` 生成不含凭据的源码归档；数据归档单独上传。远端目录约定：

```text
/root/tdb-migration/episode-v1/data
/root/tdb-migration/episode-v1/source
/root/tdb-migration/episode-v1/runs
```

上传后先检查哈希和磁盘空间，再执行：

```bash
python /root/tdb-migration/episode-v1/source/scripts/prepare_tdb_episode_qwen.py \
  --input /root/tdb-migration/episode-v1/data/episodes.labeled.jsonl \
  --output /root/tdb-migration/episode-v1/data/qwen
/root/autodl-tmp/tdb-venv-large/bin/python \
  /root/tdb-migration/episode-v1/source/scripts/train_qlora_tdb_multitask.py \
  --data /root/tdb-migration/episode-v1/data/qwen \
  --model /root/autodl-tmp/models/Qwen3-8B \
  --output /root/tdb-migration/episode-v1/runs/seed20260920 \
  --data-kind full_episode --prepare-only --seed 20260920
```

确认 `testRead=false`、`calibrationRead=false`、`dataKind=full_episode`、family split 无交集且敏感字段扫描通过后，去掉 `--prepare-only` 开始训练。每个 seed 单独目录保存 `run_manifest.json`、`trainer_state.json`、完整日志和 adapter。

## 评估与回传

生成预测后，分别运行依赖向量、披露 checker 和进化优先级 evaluator；最低报告字段为：

```text
dependency dimension MAE/Brier/ECE/UNKNOWN precision
disclosure decision agreement/exact units/cost/privacy leakage/hard violations
evolution priority top-k regret/steps-to-convergence/transfer gain/negative transfer/rollback
```

只回传 `metrics.json`、`target_metrics.json`、checker 结果、预测 JSONL、manifest 和哈希文件。远端结果回本地后，按 task family、Agent pair、relation type 聚合并生成 95% CI；没有独立 gold 的目标必须报告 UNKNOWN，不能写入长期 HDBP。
