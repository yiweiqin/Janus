#!/usr/bin/env bash
# 在 bjb1 上复刻 westb 的 Janus 云端环境。
# 依据 janus-cloud-start.sh 反推出的目标形态：
#   Node v22.23.2 (nvm 路径) + PostgreSQL 14 (cluster 14/main) + 仓库在 /root/Janus
set -uo pipefail

echo "###### 1. PostgreSQL 14 ######"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq postgresql-14 postgresql-client-14 2>&1 | tail -5

echo "###### 2. Node v22.23.2 (官方 tarball，不走 GitHub) ######"
NODE_VER=v22.23.2
NODE_DIR=/root/.nvm/versions/node/${NODE_VER}
if [ -x "${NODE_DIR}/bin/node" ]; then
  echo "node already present"
else
  mkdir -p /root/.nvm/versions/node
  cd /tmp
  URL="https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.xz"
  echo "downloading ${URL}"
  if curl -fsSL -m 300 -O "$URL"; then
    echo "download ok: $(ls -la node-${NODE_VER}-linux-x64.tar.xz)"
    tar -xJf "node-${NODE_VER}-linux-x64.tar.xz" -C /root/.nvm/versions/node/
    mv "/root/.nvm/versions/node/node-${NODE_VER}-linux-x64" "$NODE_DIR"
  else
    echo "[error] node download failed"
  fi
fi

echo "###### 3. 验证 ######"
export PATH="${NODE_DIR}/bin:$PATH"
echo "node: $(command -v node) -> $(node -v 2>&1)"
echo "npm:  $(command -v npm) -> $(npm -v 2>&1)"
pg_lsclusters 2>&1
pg_ctlcluster 14 main start 2>&1 | head -3
sleep 3
pg_isready 2>&1

echo "###### 4. 写 PATH 到 bashrc（幂等） ######"
grep -qF "${NODE_DIR}/bin" /root/.bashrc \
  || printf '\nexport PATH=%s/bin:$PATH\n' "$NODE_DIR" >> /root/.bashrc
echo "###### INSTALL DONE ######"
