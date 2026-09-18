#!/usr/bin/env bash
# 只读侦察：云 API 在盒子上是怎么跑起来的、代码从哪来、迁移到哪一版。
# P4 要把 rdmd 模块 + 迁移 097 送上云，动手前必须先知道这些，
# 否则会对着一个"其实是另一份代码"的进程白忙。
set -uo pipefail

echo "############ 1) 云 API 进程 ############"
ps -eo pid,ppid,etime,cmd | grep -iE "node|janus|cloud" | grep -v grep || echo "(无 node 进程)"

echo
echo "############ 2) 监听端口 ############"
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ":8787|:80|:443|:3000" || echo "(未发现 8787/80/443/3000)"

echo
echo "############ 3) 启动方式：systemd / pm2 / nohup / screen / tmux ############"
systemctl list-units --type=service --all 2>/dev/null | grep -iE "janus|cloud" || echo "(无 systemd unit)"
echo "--- pm2 ---"
(pm2 list 2>/dev/null || echo "(无 pm2)")
echo "--- screen ---"
(screen -ls 2>/dev/null || echo "(无 screen)")
echo "--- tmux ---"
(tmux ls 2>/dev/null || echo "(无 tmux)")
echo "--- /etc/rc.local ---"
(cat /etc/rc.local 2>/dev/null || echo "(无 rc.local)")

echo
echo "############ 4) /root/Janus 代码状态 ############"
if [ -d /root/Janus ]; then
  cd /root/Janus || exit 1
  echo "git 仓库: $(git rev-parse --is-inside-work-tree 2>/dev/null || echo no)"
  echo "HEAD: $(git rev-parse --short HEAD 2>/dev/null || echo '(非 git)')"
  echo "HEAD 时间: $(git log -1 --format=%ci 2>/dev/null || echo n/a)"
  echo "--- cloud/src/modules 有哪些 ---"
  ls -1 cloud/src/modules 2>/dev/null || echo "(无 cloud/src/modules)"
  echo "--- 是否已有 rdmd 模块（P4 的新代码）---"
  ls -la cloud/src/modules/rdmd 2>/dev/null || echo "(没有 rdmd 模块 → 云侧新代码未部署)"
  echo "--- 迁移目录尾部 ---"
  ls -1 cloud/database/migrations 2>/dev/null | tail -5 || echo "(无迁移目录)"
  echo "--- db.mjs 的 MIGRATION_HEAD ---"
  grep -n "CLOUD_DATABASE_MIGRATION_HEAD" cloud/src/db.mjs 2>/dev/null || echo "(无)"
  echo "--- 代码里有没有 BOM 的迁移（会造成 syntax error at or near ""）---"
  for f in cloud/database/migrations/*.sql; do
    head -c3 "$f" | od -An -tx1 | grep -q "ef bb bf" && echo "BOM: $f"
  done
  echo "(以上为空表示无 BOM)"
else
  echo "(没有 /root/Janus)"
fi

echo
echo "############ 5) cloud API 对外/对内可达性 ############"
echo "--- 本机 curl 8787 ---"
curl -s -m 5 -o /dev/null -w "http_code=%{http_code}\n" http://127.0.0.1:8787/ 2>/dev/null || echo "(curl 失败)"
echo "--- 健康检查端点 ---"
curl -s -m 5 http://127.0.0.1:8787/v1/health 2>/dev/null | head -c 400 || true
echo
curl -s -m 5 http://127.0.0.1:8787/health 2>/dev/null | head -c 400 || true
echo
echo "--- 本机 IP（供 GPU worker 出站用）---"
hostname -I 2>/dev/null || true

echo
echo "############ 6) 数据库迁移状态 ############"
if [ -f /root/.config/janus/remote.env ]; then
  echo "找到 /root/.config/janus/remote.env"
  set -a; . /root/.config/janus/remote.env; set +a
fi
echo "PGGSSENCMODE 无关；DATABASE_URL 是否设置: $([ -n "${DATABASE_URL:-}" ] && echo yes || echo no)"
PSQL=$(command -v psql || echo /usr/lib/postgresql/14/bin/psql)
echo "psql: $PSQL"
sudo -u postgres "$PSQL" -d janus -tAc \
  "SELECT filename FROM public.schema_migrations ORDER BY filename DESC LIMIT 5;" 2>/dev/null \
  || echo "(读 schema_migrations 失败)"
echo "--- rdmd 作业表在不在 ---"
sudo -u postgres "$PSQL" -d janus -tAc \
  "SELECT to_regclass('public.cloud_rdmd_inference_jobs');" 2>/dev/null || echo "(查询失败)"

echo
echo "############ 7) worker 需要的 python/环境 ############"
ls -la /root/autodl-tmp/rdmd-env/bin/python 2>/dev/null || echo "(无 rdmd-env)"
ls -la /root/autodl-tmp/rdmd-env/bin/pip 2>/dev/null || true
/root/autodl-tmp/rdmd-env/bin/python -c "import requests; print('requests', requests.__version__)" 2>/dev/null || echo "(rdmd-env 无 requests)"
python3 -c "import requests; print('sys requests', requests.__version__)" 2>/dev/null || echo "(系统 python 无 requests)"
echo "curl 版本: $(curl --version 2>/dev/null | head -1)"

echo
echo "############ 8) deploy/ 是否在盒子上（P4 worker 要 predict.py）############"
for d in /root/autodl-tmp/rdmd_work /root/rdmd_work /root/autodl-tmp; do
  [ -d "$d" ] && { echo "--- $d ---"; ls -1 "$d" 2>/dev/null | head -20; }
done
find / -maxdepth 4 -name "predict.py" -path "*deploy*" 2>/dev/null | head -5 || true
