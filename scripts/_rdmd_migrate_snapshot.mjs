// 在**副本**上跑一次真实迁移，把 collaboration_graph_* 表建出来。
//
// 为什么需要它：本机两个 janus.db 都没有跑过 `ubuddy_collaboration_graph_v1`
// （最后打开它们的构建早于这段代码），所以四层图的投影**在任何地方都没有一行数据**，
// 投影端到端的正确性从来没有被真实数据验证过。这个脚本在副本上补上那一步，
// 让 `readCollaborationGraphModelCase` 第一次有真实的行可读。
//
// 复刻 db.js#openDatabase 的最小路径（顺序不能变）：
//   schema(tables) -> migrateDatabase -> schema(indexes)
//
// 用法：node scripts/_rdmd_migrate_snapshot.mjs <db>
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node _rdmd_migrate_snapshot.mjs <db>');
  process.exit(2);
}

const { SQLITE_SCHEMA } = await import('../src/main/modules/persistence/infrastructure/sqliteSchema.js');
const { migrateDatabase } = await import('../src/main/modules/persistence/infrastructure/sqliteMigrations.js');

// db.js#splitSchemaIndexes 是私有的，这里逐字复刻（索引必须留到迁移之后再建，
// 否则新增列上的索引会因为列还不存在而失败）。
function splitSchemaIndexes(schema = '') {
  const indexes = [];
  const tables = String(schema || '').replace(/CREATE\s+(?:UNIQUE\s+)?INDEX[\s\S]*?;/gi, (statement) => {
    indexes.push(statement);
    return '';
  });
  return { tables, indexes: indexes.join('\n') };
}

const db = new DatabaseSync(path);
const before = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n;
const hadGraph = Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='collaboration_graphs'").get());

const layers = splitSchemaIndexes(SQLITE_SCHEMA);
db.exec('BEGIN IMMEDIATE');
try {
  db.exec(layers.tables);
  migrateDatabase(db);
  db.exec(layers.indexes);
  db.exec('COMMIT');
} catch (error) {
  try { db.exec('ROLLBACK'); } catch { /* 事务可能已自行中止 */ }
  throw error;
}

const after = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n;
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'collaboration_graph%' ORDER BY 1`)
  .all().map((row) => row.name);
const graphMigration = db.prepare("SELECT id FROM schema_migrations WHERE id LIKE '%collaboration_graph%'").all();

console.log(JSON.stringify({
  db: path, bytes: statSync(path).size,
  migrationsBefore: before, migrationsAfter: after,
  graphTablesPresentBefore: hadGraph,
  graphMigrationRows: graphMigration.map((row) => row.id),
  collaborationGraphTables: tables,
}, null, 2));
db.close();
