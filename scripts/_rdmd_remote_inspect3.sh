export PATH=/root/miniconda3/bin:$PATH
echo PATH=$PATH
which python conda
python -V
conda env list
python -c 'import importlib.util as u; print({n: u.find_spec(n) is not None for n in ["torch","transformers","datasets","peft","bitsandbytes"]})'
python - <<'PY'
try:
    import torch
    print("torch", torch.__version__, torch.cuda.is_available(), torch.version.cuda)
    if torch.cuda.is_available():
        print(torch.cuda.get_device_name(0))
except Exception as e:
    print("no_torch", e)
PY
echo PUBDATA
ls /autodl-pub/data | head -40
find /autodl-pub/data -maxdepth 3 \( -iname '*qwen*' -o -iname '*Qwen*' \) | head -40
echo NET
curl -I -m 20 https://huggingface.co | head -8
curl -I -m 20 https://hf-mirror.com | head -8
