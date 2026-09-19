// Follow-ups on the two surprises:
//   1. task_nodes.dependencies_json is NOT all-empty here (7/13) -- what's in it, and
//      did it produce edges in the E2E case files?
//   2. task_events has no activity_type column -- what IS its schema, and where is
//      the plan/`turn.plan.updated` signal supposed to live?
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const db = new DatabaseSync(process.argv[2], { readOnly: true });

console.log('=== task_nodes: raw rows ===');
for (const r of db.prepare(`SELECT id, task_run_id, title, status, dependencies_json FROM task_nodes ORDER BY task_run_id, priority ASC, created_at ASC`).all()) {
  console.log(`  run=${String(r.task_run_id).slice(0, 18)} id=${String(r.id).slice(0, 14)} status=${String(r.status).padEnd(10)} deps=${JSON.stringify(r.dependencies_json)}`);
}

console.log('\n=== edges present in the E2E case files? ===');
const cases = fs.readFileSync('./_e2e_v2/real_cases.jsonl', 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
for (const c of cases) {
  console.log(`  ${c.id}: G_star nodes=${c.G_star.nodes.length} edges=${c.G_star.edges.length} | G_prime nodes=${c.G_prime.nodes.length} edges=${c.G_prime.edges.length}`);
}

console.log('\n=== task_events schema ===');
for (const c of db.prepare(`PRAGMA table_info(task_events)`).all()) {
  console.log(`  ${c.name.padEnd(24)} ${c.type}`);
}

console.log('\n=== task_events: sample rows ===');
const sample = db.prepare(`SELECT * FROM task_events LIMIT 3`).all();
for (const r of sample) {
  const trimmed = {};
  for (const [k, v] of Object.entries(r)) trimmed[k] = typeof v === 'string' && v.length > 160 ? `${v.slice(0, 160)}...` : v;
  console.log(' ', JSON.stringify(trimmed));
}

console.log('\n=== look for any plan-ish event text anywhere in task_events ===');
const textCols = db.prepare(`PRAGMA table_info(task_events)`).all().map((c) => c.name)
  .filter((n) => !/_id$|^id$|_at$/.test(n));
for (const col of textCols) {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM task_events WHERE ${col} LIKE '%plan%'`).get();
    if (r.n) console.log(`  ${col}: ${r.n} rows matching '%plan%'`);
  } catch { /* not a text column */ }
}
