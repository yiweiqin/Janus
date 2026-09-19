#!/usr/bin/env python3
"""Local-only browser annotation queue for disclosure/evolution gold."""
import argparse, json, threading, uuid, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
HTML = Path(__file__).with_name('tdb_annotation.html').read_text(encoding='utf-8')
class App:
  def __init__(self, queue, proposals=None):
    self.path=Path(queue); self.lock=threading.Lock(); self.rows=[json.loads(x) for x in self.path.read_text(encoding='utf-8').splitlines() if x.strip()] if self.path.exists() else []
    if proposals and Path(proposals).exists():
      pm={json.loads(x).get("episode",{}).get("episodeId"):json.loads(x) for x in Path(proposals).read_text(encoding="utf-8").splitlines() if x.strip()}
      for row in self.rows:
        q=pm.get(row.get("episode",{}).get("episodeId"));
        if q: row["episode"]["modelProposal"]=q.get("modelProposal",{}); row["episode"]["checker"]=q.get("checker",{})
  def save(self): self.path.write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in self.rows),encoding='utf-8')
class Handler(BaseHTTPRequestHandler):
  app=None
  def send(self,status,body,typ='application/json'):
    raw=body.encode() if isinstance(body,str) else body; self.send_response(status); self.send_header('Content-Type',typ+'; charset=utf-8'); self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw)
  def do_GET(self):
    if self.path.startswith('/api/queue'):
      with self.app.lock:
        # Never expose one reviewer’s labels to another reviewer.
        rows=[]
        for row in self.app.rows:
          safe=dict(row); safe.pop('reviews',None); safe.pop('adjudication',None); c=row.get('consensus') or {}; safe['consensusStatus']=c.get('status'); safe.pop('consensus',None); safe['reviewCount']=len(row.get('reviews',[])); safe['status']=row.get('status','pending'); rows.append(safe)
        self.send(200,json.dumps({'rows':rows},ensure_ascii=False)); return
    if self.path in ('/','/index.html'): self.send(200,HTML,'text/html'); return
    self.send(404,'{}')
  def do_POST(self):
    if self.path not in ('/api/review','/api/adjudicate'): self.send(404,'{}'); return
    try: body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
    except Exception: self.send(400,json.dumps({'error':'invalid_json'})); return
    rid=str(body.get('episodeId','')); reviewer=str(body.get('reviewer','')).strip(); review=body.get('review') or {}
    if not rid or not reviewer or not isinstance(review,dict): self.send(400,json.dumps({'error':'episodeId_reviewer_review_required'})); return
    with self.app.lock:
      row=next((x for x in self.app.rows if str(x.get('episode',{}).get('episodeId'))==rid),None)
      if not row: self.send(404,json.dumps({'error':'episode_not_found'})); return
      if self.path == '/api/adjudicate':
        if row.get('consensus',{}).get('status') != 'needs_adjudication': self.send(409,json.dumps({'error':'not_pending_adjudication'})); return
        row['adjudication']={'reviewer':reviewer,'finalReview':review,'at':__import__('datetime').datetime.utcnow().isoformat()+'Z'}
        row['consensus']={'status':'adjudicated','agreement':False,'reviewers':row.get('consensus',{}).get('reviewers',[]),'adjudicator':reviewer}
        row['status']='adjudicated'; self.app.save(); self.send(200,json.dumps({'ok':True,'status':row['status']})); return
      reviews=row.setdefault('reviews',[])
      if any(x.get('reviewer') == reviewer for x in reviews): self.send(409,json.dumps({'error':'reviewer_already_submitted'})); return
      reviews.append({'reviewId':uuid.uuid4().hex,'reviewer':reviewer,'review':review})
      row['status']='reviewed' if len(reviews) >= 2 else 'awaiting_second_review'
      if len(reviews) >= 2:
        first, second = reviews[-2]['review'], reviews[-1]['review']
        row['consensus'] = {'status':'agreed' if first == second else 'needs_adjudication', 'agreement': first == second, 'reviewers':[reviews[-2]['reviewer'], reviews[-1]['reviewer']]}
      self.app.save(); self.send(200,json.dumps({'ok':True,'episodeId':rid,'status':row['status'],'reviewCount':len(reviews)},ensure_ascii=False))
  def log_message(self,*args): pass
def main():
  ap=argparse.ArgumentParser(); ap.add_argument('--queue',required=True); ap.add_argument('--proposals'); ap.add_argument('--host',default='127.0.0.1'); ap.add_argument('--port',type=int,default=8765); a=ap.parse_args(); Handler.app=App(a.queue,a.proposals); print(f'http://{a.host}:{a.port}/'); ThreadingHTTPServer((a.host,a.port),Handler).serve_forever()
if __name__=='__main__': main()
