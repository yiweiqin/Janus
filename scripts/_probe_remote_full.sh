set +e
echo "=== whoami / host / kernel ==="
hostname; id; uname -a; date

echo "=== df -h ==="
df -h 2>/dev/null | head -20

echo "=== / ==="
ls -la / 2>/dev/null

echo "=== /root ==="
ls -la /root 2>/dev/null

echo "=== /root/autodl-tmp ==="
ls -la /root/autodl-tmp 2>/dev/null

echo "=== other mounts ==="
for d in /data /workspace /mnt /srv /opt /home /var/lib; do echo "--- $d ---"; ls -la "$d" 2>/dev/null | head -15; done

echo "=== find *janus* (depth<=5) ==="
find / -maxdepth 5 -iname '*janus*' -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null | head -60

echo "=== find databases ==="
find / -maxdepth 7 \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null | head -40

echo "=== find collaboration_graph / 094 migration ==="
find / -maxdepth 9 -iname 'collaboration_graph*' -not -path '/proc/*' 2>/dev/null | head -20
find / -maxdepth 9 -name '094_ubuddy_collaboration_graph.sql' -not -path '/proc/*' 2>/dev/null | head -20

echo "=== find Janus package.json / repo roots ==="
find / -maxdepth 6 -name 'package.json' -not -path '/proc/*' -not -path '*/node_modules/*' 2>/dev/null | head -30

echo "=== postgres binaries ==="
which psql pg_ctl initdb postgres pg_isready pg_ctlcluster 2>/dev/null
ls -d /usr/lib/postgresql/* 2>/dev/null
ls -la /var/lib/postgresql 2>/dev/null
ls -la /etc/postgresql 2>/dev/null
find / -maxdepth 6 -name 'PG_VERSION' -not -path '/proc/*' 2>/dev/null | head

echo "=== docker ==="
which docker docker-compose 2>/dev/null
docker ps 2>&1 | head -10

echo "=== listening ports ==="
ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || head -20 /proc/net/tcp

echo "=== processes ==="
ps aux 2>/dev/null | head -30

echo "=== local port probe ==="
for p in 22 5432 5433 3000 8080 8766; do (echo > /dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 && echo "port $p OPEN" || echo "port $p closed"; done
