echo '===SHELL==='
echo PATH="$PATH"
echo '===WHICH==='
type python python3 conda pip pip3 bash 2>/dev/null || true
ls -la /root/miniconda3/bin 2>/dev/null | head || true
ls -la /opt/conda/bin 2>/dev/null | head || true
ls -la /root/autodl-tmp | head -50
df -h /root /root/autodl-tmp /autodl-tmp /tmp /usr/bin 2>/dev/null || true
echo '===FIND PY==='
find /root /opt /usr -name 'python3' -o -name 'conda' 2>/dev/null | head -40
echo '===PUB QWEN==='
ls /autodl-pub 2>/dev/null | head
find /autodl-pub -maxdepth 3 -iname '*qwen*' 2>/dev/null | head -40
echo '===NVIDIA CUDA==='
ls /usr/local/cuda*/version.json 2>/dev/null || true
nvcc --version 2>/dev/null || true
echo '===APT==='
cat /etc/os-release | head
