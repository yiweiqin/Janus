set -euo pipefail
export PATH=/root/miniconda3/bin:$PATH
export HF_HOME=/root/autodl-tmp/hf
export TRANSFORMERS_CACHE=/root/autodl-tmp/hf
export HF_ENDPOINT=https://hf-mirror.com
export PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
export PIP_DISABLE_PIP_VERSION_CHECK=1
export PYTHONUNBUFFERED=1
mkdir -p /root/autodl-tmp/rdmd_runs /root/autodl-tmp/models /root/autodl-tmp/hf
cd /root/autodl-tmp

if [ ! -x /root/autodl-tmp/rdmd-env/bin/python ]; then
  echo "[bootstrap] creating conda env"
  conda create -p /root/autodl-tmp/rdmd-env python=3.10 -y
fi
# shellcheck disable=SC1091
source /root/miniconda3/etc/profile.d/conda.sh
conda activate /root/autodl-tmp/rdmd-env

python - <<'PY'
import importlib.util
print("torch", importlib.util.find_spec("torch") is not None)
PY

if ! python -c "import torch, transformers, datasets, peft, bitsandbytes" 2>/dev/null; then
  echo "[bootstrap] installing torch+qlora stack"
  python -m pip install -U pip setuptools wheel
  python -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
  python -m pip install transformers datasets peft accelerate bitsandbytes huggingface_hub
fi

python - <<'PY'
import torch
print("torch", torch.__version__, "cuda", torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else None)
import transformers, peft, datasets, bitsandbytes
print("transformers", transformers.__version__, "peft", peft.__version__)
PY

MODEL_DIR=/root/autodl-tmp/models/Qwen3-8B
if [ ! -f "$MODEL_DIR/config.json" ]; then
  echo "[bootstrap] downloading Qwen/Qwen3-8B via hf-mirror"
  python - <<'PY'
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="Qwen/Qwen3-8B",
    local_dir="/root/autodl-tmp/models/Qwen3-8B",
    local_dir_use_symlinks=False,
)
print("model_ready")
PY
fi

ls -lh /root/autodl-tmp/models/Qwen3-8B | head
test -f /root/autodl-tmp/Janus/experiments/rdmd_detective_dataset/sft/train.jsonl
test -f /root/autodl-tmp/Janus/scripts/train_qlora_rdmd.py

# v3: run tag selects the output dir so a new dataset never clobbers the previous adapter.
RUN_TAG="${RDMD_RUN_TAG:-qlora-v2}"
LOG=/root/autodl-tmp/rdmd_runs/$RUN_TAG.train.log
mkdir -p /root/autodl-tmp/rdmd_runs
if pgrep -f train_qlora_rdmd.py >/dev/null 2>&1; then
  echo "[train] already running"
  pgrep -af train_qlora_rdmd.py || true
  exit 0
fi

echo "[train] starting QLoRA on GPU 0 (run_tag=$RUN_TAG)"
cd /root/autodl-tmp/Janus
nohup env CUDA_VISIBLE_DEVICES=0 HF_HOME=/root/autodl-tmp/hf HF_ENDPOINT=https://hf-mirror.com \
  /root/autodl-tmp/rdmd-env/bin/python scripts/train_qlora_rdmd.py \
  --data experiments/rdmd_detective_dataset/sft \
  --model /root/autodl-tmp/models/Qwen3-8B \
  --output /root/autodl-tmp/rdmd_runs/$RUN_TAG \
  --force \
  > "$LOG" 2>&1 &
echo $! > /root/autodl-tmp/rdmd_runs/$RUN_TAG.pid
sleep 5
echo "[train] pid=$(cat /root/autodl-tmp/rdmd_runs/$RUN_TAG.pid)"
head -n 40 "$LOG" || true
nvidia-smi
echo "[train] launched"
