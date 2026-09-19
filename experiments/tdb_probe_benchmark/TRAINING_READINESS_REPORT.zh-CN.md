# TDB 训练前置准备状态

更新时间：2026-09-09

## 已完成

- 本地运行时可导出授权、脱敏后的双 Agent 完整 episode，包含会话、工具、事件、`G_plan/G_exec`、TDB 三态、权限和 replay/hash。
- JSONL 契约、敏感字段扫描、完整会话质量审计、family 切分、网页双人审核和仲裁接口已具备。
- 1,340 条旧合成 full-episode 数据已被质量审计拒绝（固定短对话/维度塌缩），不得训练。
- 49 条 MAD/MAST 外部轨迹可作为网页审核候选；它们不是 Janus gold，且上游许可仍需人工确认。
- 远端 `tdb-venv-large` 已验证：Python 3.10.8、torch 2.6.0+cu124、Transformers 5.16.1、datasets 5.0.1、peft 0.20.0、3×A800 80GB 空闲。模型权重只存在远端。

## 当前阻塞

真实 Janus episode 尚未导出（本地 PostgreSQL 当前不可连接），因此真实数据仍是前置阻塞。导出后，网页审核员需要确认依赖向量证据、最小披露字段/状态、最小执行步骤和证据质量；分歧由仲裁入口处理。外部数据许可也必须人工确认。

外部 MAD/MAST 数据目前所有记录共享同一 Agent-pair/关系组件，严格切分审计会拒绝它进入训练，直到有足够互不重叠的真实任务组件。

## 尚不能宣称完成的事项

真实 Janus PostgreSQL episode 尚未导出，因此还没有可用于监督 QLoRA 的 Janus gold。完成审核后再物化 consensus，并在远端生成 calibration/test 和执行 `prepare-only`。

## 操作命令

```powershell
# 导出真实 episode（本地不需要模型）
node experiments/tdb_probe_benchmark/scripts/export_tdb_episode.mjs <delegation-id> <episodes.jsonl>

# 生成审核队列
python experiments/tdb_probe_benchmark/scripts/prepare_tdb_training_prereqs.py --input <episodes.jsonl> --output <ready-dir>

# 启动网页
python experiments/tdb_probe_benchmark/scripts/tdb_annotation_server.py --queue <ready-dir>\human_review_queue.jsonl

# 审核完成后物化标签
python experiments/tdb_probe_benchmark/scripts/materialize_human_consensus.py --queue <ready-dir>\human_review_queue.jsonl --output <ready-dir>\episodes.consensus.jsonl

# 仅在远端执行 tokenizer/长度和训练前检查；不要在本地指定模型目录
python experiments/tdb_probe_benchmark/scripts/prepare_tdb_episode_qwen.py --input <ready-dir>\episodes.consensus.jsonl --output <qwen-dir> --require-consensus
```
