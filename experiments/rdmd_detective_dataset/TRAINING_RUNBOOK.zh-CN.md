# RDMD 反向侦探开训手册

数据盘和 SFT 已经按 v2 协议备好。这里只写**怎么开训**，不把这次准备工作当成已经训完。

## 训什么

输入只有 `(G_star, G_prime)`。主损失只有 `drift` + `no_drift`。`UNKNOWN` 只评测。第一版目标是定位：`status` + `nodeId` + `type`。

对照是结构启发式（test Top-1 约 53.8%）。训完后应明显高于它，且无漂移误报、多因拒答单独报表。

## 本地已完成的前置

```powershell
cd D:\Cli-anything\Janus
npm run experiment:rdmd-sft:test
npm run experiment:rdmd-sft
python experiments/rdmd_detective_dataset/check_readiness.py
```

应看到 `status: DATA_READY` 或 `READY_TO_TRAIN`。本机没有 GPU / 底座模型时，`DATA_READY` 就够把数据搬到训练机。

SFT 目录：`experiments/rdmd_detective_dataset/sft/`

| 文件 | 用途 |
|---|---|
| `train.jsonl` `development.jsonl` | 主监督，无 UNKNOWN |
| `test.jsonl` | 终评，训练脚本不得读取 |
| `eval_unknown.jsonl` | 仅 test 族的双注入拒答 |
| `eval_no_drift.jsonl` | 仅 test 族的无漂移对照 |
| `baseline.json` | 结构启发式对照 |
| `smoke/` | 24+8 条冒烟 |

## 训练机

沿用现有 QLoRA 栈（Qwen3-8B + nf4 + LoRA r16）。不要用旧 TDB 训练入口。

```bash
cd /workspace/Janus-current   # 或你的 Janus 根目录
python experiments/rdmd_detective_dataset/check_readiness.py --model-dir "$RDMD_BASE_MODEL"

python scripts/train_qlora_rdmd.py \
  --data experiments/rdmd_detective_dataset/sft \
  --model "$RDMD_BASE_MODEL" \
  --output experiments/rdmd_runs/qlora-v2 \
  --prepare-only

python scripts/train_qlora_rdmd.py \
  --data experiments/rdmd_detective_dataset/sft \
  --model "$RDMD_BASE_MODEL" \
  --output experiments/rdmd_runs/qlora-v2 \
  --force
```

冒烟（确认编码和一步训练能跑）：

```bash
python scripts/train_qlora_rdmd.py --smoke --data experiments/rdmd_detective_dataset/sft \
  --model "$RDMD_BASE_MODEL" --output experiments/rdmd_runs/qlora-smoke --epochs 1 --force
```

默认 `maxLength=16384`。`sft/token_audit.json` 若建议更大，用 `--max-length` 覆盖。

## 评测

```bash
python scripts/eval_rdmd_qlora.py \
  --data experiments/rdmd_detective_dataset/sft \
  --split test \
  --adapter experiments/rdmd_runs/qlora-v2/adapter \
  --model "$RDMD_BASE_MODEL" \
  --output experiments/rdmd_runs/qlora-v2/test_preds.jsonl
```

再看 `eval_unknown`、`eval_no_drift`。主文只报单注入定位；无漂移误报和多因拒答分表。

## 出处（provenance）：起跑必须先写出处

分片评测的入口是**两个**脚本，按顺序管到盒子上跑（不是起一个）：

1. `scripts/_rdmd_remote_eval_manifest.sh` —— 先把出处落盘：判的是哪份权重
   （`adapter_model.safetensors` 的 sha256 + 字节数）、读的是哪批标签（逐 split 的 n 与
   sha256）、哪一版 `eval_rdmd_qlora.py` 起着 prompt。**算不出权重身份就 exit 3，不写占位符。**
2. `scripts/_rdmd_remote_eval_splits.sh` —— 再按 GPU 切分并起 shard。

顺序不能反：第 2 个脚本会检查一次性标记 `$OUT/.eval_manifest.ready`，没有就**硬停**
（exit 4）。等三个小时跑完再发现判决书无法归属，代价是重跑；在起跑前停，代价是零。
标记读完即删，所以上一次的残留骗不过这一次。

用 `_rdmd_train_then_eval.py` 时它自己按顺序管这两个，不用手工拼。

**已经跑完、但没写出处的评测**用 `scripts/_rdmd_backfill_eval_manifest.py` 补一页纸：

```bash
python scripts/_rdmd_backfill_eval_manifest.py --run-tag qlora-v4
```

它调的是**起跑路径同一个脚本**（算出处只允许有一处定义），只把 `source` 标成 `backfill`。
**补记的证据力弱于 `launch`**：launch 是"我在读这批文件、正要评测它们"时记的，补记是
"事后去看磁盘上现在是什么"。两者都能证明标签没被改过，但只有 launch 能证明起跑那一刻
磁盘上是什么。所以不冒充 —— `source` 会一路带进 `acceptance.json` 并在打印时明说。

**一个会误报的坑**：`evaluator.sha256` 记的是评测机上那份，若它带 UTF-8 BOM，sha 会和
仓库里逻辑完全相同的那份不同。要判断"evaluator 有没有变"，先归一 BOM 与 CRLF 再比 sha。

验收门本身：`python scripts/rdmd_acceptance.py --eval-dir <eval 目录> --run-tag <tag>
--compare-tag <基线 tag> --data-dir experiments/rdmd_detective_dataset/data`。
不给 `--data-dir`，v4 新增的两项（step 层定位 / status 捷径）会算成"未测到"，
而"未测到即不可用"—— 于是会在"GPU 跑完了但门没测全"的状态下判 `NOT_USABLE`。

## 硬约束

- 训练进程只打开 `train.jsonl` 和 `development.jsonl`
- prompt 不含 `label` / `injected_*` / `changed_node_ids`
- 切分按 `graph_id`，禁止跨切分泄漏
- 不要把旧 `injectMinimalDrift` 240 条混进训练集
- 不要恢复 TDB 投影 / 最小披露训练

## 改了之后哪份代码真的会跑（踩过两次）

盒子上的东西不是「改了本地就改了」。按执行方式分两类，判断错了会得出完全相反的结论：

| 本地文件 | 怎么被执行 | 改完要做什么 |
| --- | --- | --- |
| `scripts/*.sh`（经 `rdmd_ssh.py --command-file`） | 本地内容经 `bash -s` **管道**过去 | 直接生效，无需部署 |
| `scripts/rdmd_cloud_e2e.mjs` | 在盒子上从 `/root/Janus/scripts/` **副本**跑 | 必须 `python scripts/rdmd_cloud_deploy.py` |
| `cloud/**` | 盒子上的 `/root/Janus/cloud/` 副本 | 必须 `rdmd_cloud_deploy.py`（改完还要重启 API） |
| `scripts/rdmd_gpu_worker.py`、`deploy/*.py`、`_rdmd_worker_daemon.sh` | 盒子上的 `/root/autodl-tmp/Janus/` 副本 | 必须 `python scripts/rdmd_worker_deploy.py` |
| 训练/评测用到的 `sft/*.jsonl` | 远端文件 | 走训练 bundle 上传 |

代价见过两次：一次是给 `rdmd_cloud_e2e.mjs` 加了断言、跑**负对照**（故意给错的期望值）时它
**通过了** —— 本该失败，因为盒子上跑的还是没有该断言的旧副本；一次是 `_rdmd_worker_daemon.sh`
改了却没部署，`start` 还是老行为。**判据不能是「我改了」，只能是「远端 hash 与本地一致」**
（两个部署脚本都会逐文件比对 sha256，`rdmd_cloud_deploy.py` 会报 `114/114 一致`）。

对应地，验收脚本必须**能被证伪**：新加的断言要先拿一个必然失败的输入试一次，
确认它真的会红，否则「加了断言」和「跑过了」可能是同一件事 —— 都什么也没发生。
