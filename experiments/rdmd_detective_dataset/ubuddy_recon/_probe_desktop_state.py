"""只读探针：桌面端库里与云同步 / 协作图 / 计划事件相关的真实状态。

为什么要有它：交接里有一条「核对 `cloud_sync_state.server_url` 是否指向 bjb1 那台云 API」。
能自己读出来的事实就不该让人去点界面 —— 读不出来时，脚本会明说「没这张表 / 没这一行」，
而不是印一个空表让人以为查过了。全程 `mode=ro`，不写任何东西。

**凭据一律打码**：这一行里有 device grant 与 token。探针的输出会被贴进文档与对话，
把整串贴出去等于把凭据抄进版本库。所以凡是键名命中 `token|grant|secret|key|cursor` 的，
只印「前 4 位 + 长度」。
"""
import json
import os
import re
import sqlite3
import sys

SENSITIVE = re.compile(r'token|grant|secret|key|password', re.I)


def mask(value):
    text = '' if value is None else str(value)
    if not text:
        return ''
    return '{}…({} 字节)'.format(text[:4], len(text))


def readable(name, value):
    if SENSITIVE.search(name):
        return mask(value)
    text = '' if value is None else str(value)
    return text if len(text) <= 120 else '{}…({} 字节)'.format(text[:120], len(text))


path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.expanduser('~'), '.janus-test', 'data', 'janus.db')
print('[desktop-state] db =', path, 'exists =', os.path.exists(path))
if not os.path.exists(path):
    print('[desktop-state] 未测到：这个路径没有库（不是「是空的」）')
    raise SystemExit(3)

con = sqlite3.connect('file:{}?mode=ro'.format(path.replace('\\', '/')), uri=True)
cur = con.cursor()


def tables(like):
    return [row[0] for row in cur.execute(
        "select name from sqlite_master where type='table' and name like ?", (like,))]


def rows(sql, params=()):
    try:
        return list(cur.execute(sql, params))
    except Exception as exc:
        return exc


def dump_rows(label, sql, params=()):
    print('--', label, '--')
    result = rows(sql, params)
    if isinstance(result, Exception):
        print('   ERR', type(result).__name__, result)
        return
    print('   (0 行)' if not result else '')
    for row in result:
        print('  ', row)


print()
print('== cloud_sync_state（逐列，凭据打码） ==')
result = rows('select * from cloud_sync_state')
if isinstance(result, Exception):
    print('   ERR', result)
else:
    columns = [row[1] for row in cur.execute('pragma table_info("cloud_sync_state")')]
    if not result:
        print('   (0 行) —— 桌面端还没连过任何云')
    for row in result:
        for name, value in zip(columns, row):
            print('   {:<32} {}'.format(name, readable(name, value)))
        print()

print('== 四层图 / 计划事件 ==')
print('   collaboration_graph_* 表:', tables('%collaboration_graph%') or '（一张都没有）')
dump_rows('collaboration_groups 条数', 'select count(*) from collaboration_groups')
dump_rows('task_nodes 里 dependencies_json 非空的行数',
          "select count(*) from task_nodes where coalesce(dependencies_json,'') not in ('', '[]', 'null', '{}')")
dump_rows('dependencies_json 的取值分布（前 8 种）',
          "select coalesce(dependencies_json,'(null)') as deps, count(*) from task_nodes group by deps order by 2 desc limit 8")
dump_rows('task_events 里 plan 事件（按活动类型）',
          "select coalesce(json_extract(payload_json,'$.activityType'),'(无)') as kind, count(*) "
          "from task_events where json_extract(payload_json,'$.plan') is not null group by kind order by 2 desc")
dump_rows('plan 事件的步骤数（前 8 条，含所属 task_run）',
          "select json_array_length(json_extract(payload_json,'$.plan')) as steps, "
          "json_extract(payload_json,'$.taskRunId') as taskRun, count(*) "
          "from task_events where json_extract(payload_json,'$.plan') is not null "
          "group by steps, taskRun order by 1 desc limit 8")
dump_rows('task_graph_revisions 条数', 'select count(*) from task_graph_revisions')
dump_rows('task_run 条数', 'select count(*) from task_runs')
