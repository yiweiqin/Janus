#!/usr/bin/env bash
# 只读侦察 2：云 API 到底能不能在这台盒子上跑起来。
# 侦察 1 的结论是"没在跑、代码是 095 的旧快照、8787 空着"，
# 所以现在要回答：node 在不在、DB 怎么连、启动脚本是什么、这份代码是不是云侧的完整副本。
set -uo pipefail

echo "############ 1) node / npm ############"
for c in node nodejs npm npx; do
  printf "%-6s " "$c"; command -v $c >/dev/null 2>&1 && $c --version 2>&1 | head -1 || echo "(缺失)"
done
echo "--- 有没有别的 node（nvm/conda）---"
ls -d /root/.nvm/versions/node/* 2>/dev/null | head -5
find /root /usr/local -maxdepth 4 -name "node" -type f -perm -u+x 2>/dev/null | head -5

echo
echo "############ 2) remote.env 的键（值里可能有口令，只打印键名）############"
if [ -f /root/.config/janus/remote.env ]; then
  sed -E 's/=.*/=<redacted>/' /root/.config/janus/remote.env
else
  echo "(无 remote.env)"
fi

echo
echo "############ 3) PostgreSQL ############"
echo "--- 进程 ---"
ps -eo pid,cmd | grep -i postgres | grep -v grep | head -10 || echo "(无 postgres 进程)"
echo "--- 版本与监听 ---"
(ss -ltnp 2>/dev/null | grep 5432) || echo "(未监听 5432)"
ls -d /usr/lib/postgresql/* 2>/dev/null
echo "--- 用 DATABASE_URL 直连（这是系统真正用的路径）---"
if [ -f /root/.config/janus/remote.env ]; then
  set -a; . /root/.config/janus/remote.env; set +a
fi
if [ -n "${DATABASE_URL:-}" ]; then
  # 只显示 host/port/db 名，隐去口令
  echo "$DATABASE_URL" | sed -E 's#://([^:]+):[^@]*@#://\1:<redacted>@#'
  psql "$DATABASE_URL" -tAc "SELECT current_database(), version();" 2>&1 | head -3
  echo "--- schema_migrations 尾部 ---"
  psql "$DATABASE_URL" -tAc "SELECT filename FROM public.schema_migrations ORDER BY filename DESC LIMIT 5;" 2>&1 | head -6
  echo "--- rdmd 表 ---"
  psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.cloud_rdmd_inference_jobs');" 2>&1 | head -2
  echo "--- collaboration 相关表行数 ---"
  psql "$DATABASE_URL" -tAc "SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE relname LIKE 'collaboration%' OR relname LIKE 'cloud_task%' ORDER BY relname;" 2>&1 | head -20
else
  echo "(DATABASE_URL 未设置)"
fi

echo
echo "############ 4) /root/Janus 是不是云侧完整副本 ############"
cd /root/Janus 2>/dev/null || { echo "(无 /root/Janus)"; exit 0; }
echo "--- 顶层 ---"
ls -1 | head -25
echo "--- package.json 里的 cloud 相关脚本 ---"
if [ -f package.json ]; then
  python3 -c "
import json
d = json.load(open('package.json'))
print('version:', d.get('version'))
for k,v in d.get('scripts',{}).items():
    if 'cloud' in k or 'server' in k: print(' ', k, '=>', v)
" 2>&1 | head -25
else
  echo "(无 package.json)"
fi
echo "--- server.mjs 里怎么读端口/库 ---"
grep -nE "PORT|DATABASE_URL|listen\(" cloud/src/server.mjs 2>/dev/null | head -15
echo "--- node_modules 装了没 ---"
ls -d node_modules 2>/dev/null && ls node_modules | wc -l || echo "(无 node_modules)"

echo
echo "############ 5) 有没有日志/启动痕迹 ############"
ls -la /root/Janus/*.log /root/*.log /root/logs 2>/dev/null | head -20 || echo "(无日志文件)"
echo "--- bash history 里的 server.mjs 启动记录（看别人是怎么起的）---"
grep -nE "server\.mjs|cloud:start|npm run|node " /root/.bash_history 2>/dev/null | tail -20 || echo "(无 history)"

echo
echo "############ 6) GPU 与训练盘（确认 P3 环境未被影响）############"
nvidia-smi --query-gpu=index,name,memory.used,memory.total --format=csv,noheader 2>/dev/null || echo "(nvidia-smi 失败)"
echo "--- rdmd_runs 现有 run ---"
ls -1 /root/autodl-tmp/rdmd_runs 2>/dev/null | head -10
echo "--- 训练是否在跑 ---"
ps -eo pid,etime,cmd | grep -E "train_qlora|_rdmd" | grep -v grep | head -10 || echo "(无训练进程)"
