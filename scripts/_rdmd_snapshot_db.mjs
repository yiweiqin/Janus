// 从活体 janus.db 做一份**一致快照**到临时路径，然后在这份副本上跑迁移。
//
// 为什么不直接复制文件：源库正在被实时写入（WAL），裸拷文件可能拿到撕裂的页。
// `VACUUM INTO` 走的是 SQLite 自己的读事务，产出一份自洽的库，而且顺带压实（去掉空闲页），
// 3.2 GB 的源库通常只落成几百 MB。
//
// 用法：node scripts/_rdmd_snapshot_db.mjs <src.db> <dst.db>
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('usage: node _rdmd_snapshot_db.mjs <src.db> <dst.db>');
  process.exit(2);
}
if (!existsSync(src)) {
  console.error(`[error] source not found: ${src}`);
  process.exit(2);
}
mkdirSync(dirname(dst), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(dst + suffix)) rmSync(dst + suffix);
}

const before = statSync(src).size;
const db = new DatabaseSync(src, { readOnly: true });
// VACUUM INTO 需要一个尚不存在的目标；路径用单引号包住，内部单引号翻倍转义。
db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
db.close();
const after = statSync(dst).size;
console.log(JSON.stringify({
  source: src, sourceBytes: before,
  snapshot: dst, snapshotBytes: after,
  ratio: Math.round((after / before) * 1000) / 1000,
}, null, 2));
