// Make a consistent single-file snapshot of a live SQLite DB, WAL included.
// VACUUM INTO reads the source and writes a fresh, checkpointed copy, so we don't have
// to worry about copying .db/.db-wal/.db-shm in the right order.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const [, , source, dest] = process.argv;
if (!source || !dest) {
  console.error('usage: node _snapshot_db.mjs <source.db> <dest.db>');
  process.exit(2);
}

if (fs.existsSync(dest)) {
  fs.rmSync(dest);
  console.log('removed existing dest');
}
fs.mkdirSync(path.dirname(dest), { recursive: true });

const db = new DatabaseSync(source, { readOnly: true });
const started = Date.now();
db.exec(`VACUUM INTO '${dest.replace(/\\/g, '/').replace(/'/g, "''")}'`);
db.close();

const size = fs.statSync(dest).size;
console.log(`snapshot ok: ${dest} (${(size / 1e6).toFixed(1)} MB) in ${Date.now() - started}ms`);
