set +e
export PATH=/root/.nvm/versions/node/v22.23.2/bin:$PATH
F=/root/Janus/scripts/janus-cloud-start.sh

echo "=== 修前首 3 字节 ==="
od -An -tx1 -N3 "$F"

# 剥 BOM 并确保 LF
sed -i '1s/^\xEF\xBB\xBF//' "$F"
sed -i 's/\r$//' "$F"

echo "=== 修后首 3 字节 ==="
od -An -tx1 -N3 "$F"
echo "=== 首行 ==="
head -1 "$F"
chmod +x "$F"

echo "=== 直接以 shebang 执行（不靠 bash 显式调用） ==="
"$F" stop 2>&1
"$F" start 2>&1
echo "exit=$?"
echo "=== DONE ==="
