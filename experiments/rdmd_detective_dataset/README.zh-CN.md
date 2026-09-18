# 反向侦探训练集

```powershell
npm run experiment:rdmd-dataset:test
npm run experiment:rdmd-dataset
npm run experiment:rdmd-dataset:validate
npm run experiment:rdmd-sft
npm run experiment:rdmd-readiness
```

- `--smoke --backend=local`：20 条冒烟
- `--backend=llm`：用 `OPENAI_BASE_URL` + `CRS_OAI_KEY` 走两步 LLM（默认模型 `gpt-5.5`）；可先 `node experiments/rdmd_detective_dataset/ping_llm.mjs`
- 主盘当前是 local 因果教师，协议与 LLM 路径相同：长程图、按任务实例化形态、先记 gold，再从第 3 跳起推演后代
- 开训：先 `npm run experiment:rdmd-sft`，再看 [TRAINING_RUNBOOK.zh-CN.md](TRAINING_RUNBOOK.zh-CN.md)

详见 [DATASET_CARD.zh-CN.md](DATASET_CARD.zh-CN.md)。
