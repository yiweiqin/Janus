set +e
echo "=== apt-get update ==="
apt-get update -qq 2>&1 | tail -8

echo "=== apt: nodejs / npm 可装版本 ==="
apt-cache policy nodejs 2>/dev/null | head -5
apt-cache policy npm 2>/dev/null | head -5

echo "=== apt: postgresql 可装版本 ==="
apt-cache policy postgresql 2>/dev/null | head -5
apt-cache policy postgresql-14 2>/dev/null | head -5

echo "=== 网络多点测试 ==="
for u in https://registry.npmjs.org https://registry.npmmirror.com https://pypi.org/simple http://archive.ubuntu.com/ubuntu/ https://github.com https://nodejs.org; do
  printf '%s -> ' "$u"
  curl -sS -m 12 -o /dev/null -w '%{http_code}' "$u" 2>&1
  echo
done

echo "=== 已装的 node/python 痕迹 ==="
ls /root/miniconda3/bin/ 2>/dev/null | grep -iE '^(python|node|npm)' | head
ls /root/autodl-tmp/rdmd-env/bin/ 2>/dev/null | grep -iE '^(python|node|npm|pip)' | head
command -v node npm python3 python 2>/dev/null

echo "=== apt 源 ==="
cat /etc/apt/sources.list 2>/dev/null | grep -v '^#' | grep -v '^$' | head -6
ls /etc/apt/sources.list.d/ 2>/dev/null | head

echo "=== 内存/CPU ==="
free -h 2>/dev/null | head -3
nproc 2>/dev/null

echo "=== 是否已有 npm 缓存/离线包 ==="
ls /root/.npm 2>/dev/null | head -5
echo "=== DONE ==="
