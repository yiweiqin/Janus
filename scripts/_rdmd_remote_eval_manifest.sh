#!/bin/bash
# RDMD 评测的出处（provenance）：判的是哪份权重、读的是哪批标签、哪版 prompt 构造函数。
#
# 为什么单独成一个脚本：这份信息以前**根本不存在**。eval-qlora-v4 的产物里没有任何东西
# 能说出它判的是哪个 adapter —— 只能靠目录名反推，换个目录或原地重跑一次，结论就和权重
# 脱钩了。而 P3 已经栽过一回同源的事：v4 的 run_manifest.json 里写着 v3 的 dataKind。
#
# 所以「算出处」只允许有一处定义。起跑（SOURCE=launch）与事后回填（SOURCE=backfill）
# 都调这一个脚本；两份实现各自演化，就是这个任务要治的病本身。
#
# 用法（经 rdmd_ssh.py 或 _rdmd_train_then_eval.py 的 stream 管过去，盒上不留副本）：
#   python scripts/rdmd_ssh.py --set RUN_TAG=qlora-v4 --set "SPLITS=test development" \
#     --set ADAPTER=/root/autodl-tmp/rdmd_runs/qlora-v4/adapter \
#     --command-file scripts/_rdmd_remote_eval_manifest.sh
#
# 环境变量：
#   RUN_TAG  SPLITS  OUT  ADAPTER（默认 $RUN/$RUN_TAG/adapter）  SOURCE（launch|backfill）
#   可选 GPUS / MERGED_TOTAL —— 运行形态，只有起跑时知道；回填时省略而不是编一个
#
# 出口：0 正常；3 = 算不出权重身份。算不出就**不写** manifest，也绝不写占位符 ——
# 不可审计的出处等于没有出处，云侧 `normalizeProvenance` 拒收 'unknown' 是同一条道理。
set -uo pipefail
export PATH=/root/autodl-tmp/rdmd-env/bin:/root/miniconda3/bin:$PATH
export PYTHONUNBUFFERED=1
cd /root/autodl-tmp/Janus

RUN_TAG="${RUN_TAG:?set RUN_TAG (e.g. qlora-v4)}"
SPLITS="${SPLITS:?set SPLITS (space separated)}"
RUN=/root/autodl-tmp/rdmd_runs
ADAPTER="${ADAPTER:-$RUN/$RUN_TAG/adapter}"
OUT="${OUT:-$RUN/eval-$RUN_TAG}"
SOURCE="${SOURCE:-launch}"
export RUN_TAG SPLITS OUT ADAPTER SOURCE
mkdir -p "$OUT"

/root/autodl-tmp/rdmd-env/bin/python - <<'PY'
import hashlib, json, os
from datetime import datetime, timezone
from pathlib import Path


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


run_tag = os.environ['RUN_TAG']
splits = os.environ['SPLITS'].split()
out = Path(os.environ['OUT'])
adapter = Path(os.environ['ADAPTER'])
source = os.environ['SOURCE']
sft = Path('/root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/sft')

manifest = {'runTag': run_tag, 'source': source}

# 时间戳按来源取不同的键名，因为它们说的不是同一件事：launch 是"评测何时开始"，
# backfill 只能说是"这份出处何时补记"。用同一个键名会让回填谎报一个它并不知道的时刻。
if source == 'launch':
    manifest['startedAt'] = datetime.now(timezone.utc).isoformat()
else:
    manifest['recordedAt'] = datetime.now(timezone.utc).isoformat()

# 运行形态只有起跑时知道。回填时**省略**，不猜、不填 0。
if os.environ.get('GPUS'):
    try:
        manifest['shards'] = int(os.environ['GPUS'])
    except ValueError:
        print('MANIFEST_PARTIAL ignoring non-numeric GPUS', repr(os.environ['GPUS']))

# 权重身份：这份 manifest 存在的全部理由，算不出就整个失败。
try:
    weights = adapter / 'adapter_model.safetensors'
    config = json.loads((adapter / 'adapter_config.json').read_text(encoding='utf-8'))
    manifest['adapter'] = {
        'path': str(adapter),
        'sha256': sha256_file(weights),
        'bytes': weights.stat().st_size,
        'baseModel': config.get('base_model_name_or_path'),
    }
except (OSError, ValueError) as exc:
    print('MANIFEST_FAILED adapter:', repr(exc))
    raise SystemExit(3)

# 标签：逐 split 记 n 与 sha256，用来事后核对"评测时读的那批"与"本地这份"是否同一批。
observed = {}
for split in splits:
    path = sft / f'{split}.jsonl'
    if not path.is_file():
        print('MISSING_SPLIT', split)
        continue
    observed[split] = {
        'n': len([line for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]),
        'sha256': sha256_file(path),
    }

# 被评测的总行数是各 split 之和 —— 起跑的 sharding 就是把这个和按 GPU 切分，所以这里
# 自己数一遍即可，不必由调用方另传（少一个能对不上的地方）。
manifest['mergedTotal'] = sum(row['n'] for row in observed.values())

# 下面两块是尽力而为：缺了它们，manifest 仍能说明"判的是哪份权重"，只是说明不了
# "读的是哪批标签"，所以只降级、不中止。
try:
    sft_manifest = json.loads((sft / 'manifest.json').read_text(encoding='utf-8'))
    manifest['sft'] = {
        'schemaVersion': sft_manifest.get('schemaVersion'),
        'sourceVersion': sft_manifest.get('sourceVersion'),
        'generatedAt': sft_manifest.get('generatedAt'),
        'manifestSha256': sha256_file(sft / 'manifest.json'),
        'splits': observed,
    }
except (OSError, ValueError) as exc:
    print('MANIFEST_PARTIAL no usable sft/manifest.json:', repr(exc))
    manifest['sft'] = {'splits': observed}

# prompt 构造函数：题面形状会变（v4 的 step 层收窄就改了题面），所以它的版本要和权重一起记。
# 注意本脚本被**管过去**执行，cwd 是 /root/autodl-tmp/Janus，相对路径即盒子上的那份。
try:
    evaluator = Path('scripts/eval_rdmd_qlora.py')
    manifest['evaluator'] = {'path': str(evaluator), 'sha256': sha256_file(evaluator)}
except OSError as exc:
    print('MANIFEST_PARTIAL cannot hash the evaluator:', repr(exc))

(out / 'eval_manifest.json').write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
)
print('MANIFEST', out / 'eval_manifest.json', 'source=' + source)
PY
manifest_status=$?
if [ "$manifest_status" -ne 0 ]; then
  echo "ABORT manifest_status=$manifest_status"
  exit "$manifest_status"
fi

# 一次性凭据：起跑路径（_rdmd_remote_eval_splits.sh）要求它存在才会起 shard，
# 并在读到之后删掉。这样"忘了写出处就跑评测"会在烧掉 GPU 时间**之前**硬停，
# 而不是事后留下一份无法归属的判决书。删掉是为了让上次的残留骗不过这一次。
#
# 只有 launch 才落这个标记：回填不跑评测，留下标记反而会让之后某次"裸跑"评测
# 跳过它自己该写的出处。标记的含义是"这一轮起跑已经写过出处了"，回填不属于任何一轮起跑。
if [ "$SOURCE" = "launch" ]; then
  touch "$OUT/.eval_manifest.ready"
fi
