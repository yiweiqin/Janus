#!/usr/bin/env python3
import json, os, pathlib, getpass, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse
import paramiko
ROOT=pathlib.Path(__file__).resolve().parent; STATUS=ROOT/'tdb_status.json'; password=os.environ.get('TDB_SSH_PASSWORD') or getpass.getpass('输入新机 44930 SSH 密码（不会保存）: ')
def snapshot():
 c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
 try:
  c.connect('connect.bjb1.seetacloud.com',port=44930,username='root',password=password,timeout=12,auth_timeout=12)
  cmd="""python3 - <<'PY'
import json,subprocess,time,pathlib
o={'updatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'machine':'44930','gpus':[],'processes':[],'seeds':{}}
try:
 q=subprocess.check_output(['nvidia-smi','--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu','--format=csv,noheader,nounits'],text=True)
 for x in q.strip().splitlines():
  a=[v.strip() for v in x.split(',')];o['gpus'].append(dict(index=a[0],name=a[1],memory_used_mb=a[2],memory_total_mb=a[3],utilization=a[4],temperature=a[5]))
except Exception as e:o['gpuError']=str(e)
q=subprocess.check_output("ps -eo pid,etime,pcpu,pmem,args --no-headers | grep -E 'train_qlora|evaluate_tdb|score_tdb|check_tdb' | grep -v grep || true",shell=True,text=True);o['processes']=[x.strip() for x in q.splitlines() if x.strip()]
for s in ['20260914','20260915','20260916']:
 d=pathlib.Path('/root/tdb-migration')/('seed'+s);x={'name':'seed'+s,'machine':'44930','checkpoint':'checkpoint-114','training_process':'running' if o['processes'] else 'not observed','gpu':str(len(o['gpus']))+' GPUs'};m=d/'migration_checksums.json'
 if m.exists():z=json.loads(m.read_text());x.update(archive_files=len(z.get('files',[])),checksums_ok=all(v.get('readable') for v in z.get('files',[])))
 o['seeds'][s]=x
print(json.dumps(o))
PY"""
  _,out,_=c.exec_command(cmd,timeout=20);return json.loads(out.read().decode())
 except Exception as e:return {'updatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'machine':'44930','error':str(e),'seeds':{}}
 finally:c.close()
def poll():
 while True:
  STATUS.write_text(json.dumps(snapshot(),ensure_ascii=False,indent=2),encoding='utf8');time.sleep(10)
class H(SimpleHTTPRequestHandler):
 def do_GET(self):
  if urlparse(self.path).path=='/api/status':
   b=STATUS.read_bytes();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(b);return
  if self.path=='/':self.path='/tdb_progress_dashboard.html'
  super().do_GET()
 def log_message(self,*a):pass
if __name__=='__main__':
 STATUS.write_text(json.dumps(snapshot(),ensure_ascii=False,indent=2),encoding='utf8');threading.Thread(target=poll,daemon=True).start();print('http://127.0.0.1:8765/',flush=True);ThreadingHTTPServer(('127.0.0.1',8765),H).serve_forever()
