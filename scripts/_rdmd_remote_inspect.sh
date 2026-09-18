set -e
echo '===HOST==='
hostname
uname -a
echo '===GPU==='
nvidia-smi || true
echo '===DISK==='
df -h
echo '===ROOT==='
ls -la /root | head
echo '===AUTODL==='
ls -la /root/autodl-tmp 2>/dev/null | head -40 || true
ls -la /root/autodl-fs 2>/dev/null | head -20 || true
echo '===PY==='
which python python3 conda 2>/dev/null || true
python3 -V 2>/dev/null || true
python -V 2>/dev/null || true
echo '===TORCH==='
python3 - <<'PY' || true
import importlib.util as u
print({n: u.find_spec(n) is not None for n in ["torch","transformers","datasets","peft","bitsandbytes"]})
try:
    import torch
    print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else None)
except Exception as e:
    print('torch_error', e)
PY
echo '===MODELS==='
find /root /root/autodl-tmp /root/autodl-fs /root/.cache -maxdepth 5 \( -iname '*qwen*' -o -iname '*Qwen*' \) 2>/dev/null | head -50 || true
ls /root/.cache/huggingface/hub 2>/dev/null | head || true
echo '===TMUX==='
which tmux || true
nvidia-smi -L || true
