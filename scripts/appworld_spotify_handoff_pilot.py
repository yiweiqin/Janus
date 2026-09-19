"""Executed handoff-repair pilot on one official training task.

Fixed public-API producer/consumer, injected handoff loss, independent evaluator.
Not natural-failure evidence, not model evaluation, not sufficient for training.
"""
import argparse
import contextlib
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path
import random
import time

TASK = '692c77d_1'
PRODUCER = '''
me = apis.supervisor.show_profile()
accounts = apis.supervisor.show_account_passwords()
password = next(x['password'] for x in accounts if x['account_name'] == 'spotify')
token = apis.spotify.login(username=me['email'], password=password)['access_token']
playlists = []
for page in range(100):
    chunk = apis.spotify.show_liked_playlists(access_token=token, page_index=page, page_limit=20)
    assert isinstance(chunk, list)
    playlists.extend(chunk)
    if len(chunk) < 20: break
else: raise RuntimeError('pagination_limit')
song_ids = sorted({s for p in playlists for s in p['song_ids']})
handoff = []
for song_id in song_ids:
    reviews = apis.spotify.show_song_reviews(song_id=song_id, user_email=me['email'], page_limit=20)
    assert isinstance(reviews, list) and len(reviews) <= 1
    review = reviews[0] if reviews else None
    handoff.append({'song_id':song_id,'review_id':review['song_review_id'] if review else None,
                    'old_rating':review['rating'] if review else None})
print({'playlists':len(playlists), 'units':len(handoff), 'need_update':sum(x['old_rating'] != 5 for x in handoff)})
'''
CONSUMER = '''
updated = 0
for item in received:
    if item['old_rating'] == 5: continue
    if item['review_id'] is None:
        result = apis.spotify.review_song(song_id=item['song_id'], rating=5, access_token=token)
    else:
        result = apis.spotify.update_song_review(review_id=item['review_id'], rating=5, access_token=token)
    assert isinstance(result, dict) and 'message' in result
    updated += 1
apis.supervisor.complete_task()
print({'updated':updated})
'''


def digest(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def snapshot(w,name):
    w.save_state(name)
    p=Path(w.output_checkpoints_directory)/name
    files={str(f.relative_to(p)):digest(f) for f in sorted(p.rglob('*')) if f.is_file()}
    if not files: raise ValueError('empty_checkpoint')
    return files


def main():
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--output',required=True)
    p.add_argument('--interpretation',choices=['liked_playlists','liked_songs_in_library'],default='liked_playlists')
    a=p.parse_args();root=Path(a.root);out=Path(a.output)
    ids=(root/'data/datasets/train.txt').read_text().splitlines()
    if TASK not in ids: raise ValueError('not_official_train')
    out.mkdir(parents=True,exist_ok=False)
    order=[(c,a) for c in ['complete','drop_first_needed'] for a in ['noop','restoreHandoff']]
    random.Random(20260907).shuffle(order)
    config={'task':TASK,'split':'train','order':order,'seed':20260907,
        'source':'official AppWorld simulated applications','intervention':'restore producer handoff before fixed consumer',
        'interpretation_frozen':a.interpretation,
        'development_revision':'alternative interpretation chosen after pilot-001 aggregate failure; no gold content read',
        'utility':'official binary task success','negative_control':'complete handoff',
        'missing_unit_selection':'first sorted song requiring a change according to authorized live API',
        'script_sha256':digest(__file__),'appworld_version':importlib.metadata.version('appworld'),
        'exploratory':True,'repeats_per_arm':1}
    (out/'prerun.json').write_text(json.dumps(config,indent=2))
    from appworld.common.path_store import path_store
    path_store.update_root(str(root))
    from appworld import AppWorld
    rows=[]
    for condition,action in order:
        w=None;start=time.clock_gettime(time.CLOCK_MONOTONIC)
        row={'condition':condition,'action':action,'status':'infrastructure_invalid',
            'experiment':out.name+'-'+condition+'-'+action}
        try:
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                w=AppWorld(task_id=TASK,experiment_name=row['experiment'],load_ground_truth=False,
                    random_seed=20260907,timeout_seconds=60,max_api_calls_per_interaction=2000)
            row['initial_checkpoint']=snapshot(w,'initial')
            producer=PRODUCER
            if a.interpretation=='liked_songs_in_library':
                producer=producer.replace('apis.spotify.show_liked_playlists(', 'apis.spotify.show_playlist_library(')
                producer=producer.replace('handoff = []', '''liked_ids = set()
for page in range(100):
    chunk = apis.spotify.show_liked_songs(access_token=token, page_index=page, page_limit=20)
    assert isinstance(chunk,list)
    liked_ids.update(x['song_id'] for x in chunk)
    if len(chunk) < 20: break
else: raise RuntimeError('pagination_limit')
song_ids = sorted(set(song_ids) & liked_ids)
handoff = []''')
            producer_result=w.execute(producer)
            row['producer_result']=producer_result
            if 'Execution failed' in producer_result: raise RuntimeError('producer_failed')
            selection="received = [dict(x) for x in handoff]\n"
            if condition=='drop_first_needed':
                selection += "drop = next((x['song_id'] for x in handoff if x['old_rating'] != 5), None)\nassert drop is not None\nreceived = [x for x in received if x['song_id'] != drop]\n"
            selection += "print({'expected_units':len(handoff),'received_units':len(received)})"
            row['observable_handoff']=w.execute(selection)
            if 'Execution failed' in row['observable_handoff']: raise RuntimeError('handoff_setup_invalid')
            if action=='restoreHandoff':
                result=w.execute("received = [dict(x) for x in handoff]")
                if 'Execution failed' in result: raise RuntimeError('repair_failed')
            row['consumer_result']=w.execute(CONSUMER)
            row['consumer_execution_ok']='Execution failed' not in row['consumer_result']
            row['final_checkpoint']=snapshot(w,'final')
            row['status']='executed'
        except Exception as e:row.update(error=type(e).__name__+':'+str(e))
        finally:
            if w is not None:w.close()
        row['seconds']=time.clock_gettime(time.CLOCK_MONOTONIC)-start
        rows.append(row)
        with (out/'execution.jsonl').open('a') as f:f.write(json.dumps(row)+'\n')
        print(json.dumps({'condition':condition,'action':action,'status':row['status']}),flush=True)
    frozen=digest(out/'execution.jsonl')
    from appworld.evaluator import evaluate_task
    for r in rows:
        if r['status']!='executed':continue
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            ev=evaluate_task(task_id=TASK,experiment_name=r['experiment'],suppress_errors=True)
        r['evaluation']={'utility':float(ev.success),'passed':ev.pass_count,'failed':ev.fail_count,'total':ev.total_count}
    (out/'evaluated.json').write_text(json.dumps(rows,indent=2))
    report={'scope':'ONE_TRAIN_FAMILY_EXECUTED_INJECTED_HANDOFF_PILOT',
        'execution_sha256':frozen,'evaluated_sha256':digest(out/'evaluated.json'),
        'training_eligible':False,'model_trained':False,'results':[
            {k:r.get(k) for k in ['condition','action','status','evaluation']} for r in rows],
        'limitations':['one task; one repeat; injected loss; deterministic executor',
            'checkpoint hashes cover deltas, not full live database state',
            'no held-out performance or real production-task evidence']}
    (out/'manifest.json').write_text(json.dumps(report,indent=2));print(json.dumps(report),flush=True)


if __name__=='__main__':main()
