// 探针：确认「uBuddy <-> uBuddy 协调」在真实数据里到底留下了什么可读信号。
//
// 为什么需要它：群任务图现在只有 root -> ubuddy 的放射边，缺 uBuddy<->uBuddy 的协调边。
// 补边之前必须先确认信号存在且可读，否则就是凭空造边。本脚本只读。
//
// 用法：node _probe_coordination_signals.mjs <janus.db>
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.argv[2];
if (!DB_PATH) {
  console.error('usage: node _probe_coordination_signals.mjs <janus.db>');
  process.exit(2);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const q = (sql, params = []) => { try { return db.prepare(sql).all(...params); } catch { return []; } };

const coordinationEventTypes = q(`SELECT event_type, COUNT(*) AS n FROM task_events
  WHERE event_type LIKE '%coordination%' OR event_type LIKE '%peer%' OR event_type LIKE '%delegation%'
  GROUP BY event_type ORDER BY n DESC`);

const samples = q(`SELECT event_type, task_run_id, task_node_id, summary, payload_json, created_at
  FROM task_events
  WHERE event_type LIKE '%coordination%' OR event_type LIKE '%peer%'
  ORDER BY created_at LIMIT 12`).map((row) => ({
  type: row.event_type,
  taskRunId: row.task_run_id,
  taskNodeId: row.task_node_id,
  summary: String(row.summary || '').slice(0, 200),
  payload: String(row.payload_json || '').slice(0, 800),
  at: row.created_at,
}));

// uBuddy 之间的协调是否真的落地了。
// createDelegationRuntimeApi 用 socialRelay.sendCollaborationMessage(groupId, ...) 发
// metadata.type='ubuddy_peer_coordination' 的消息 —— 落点可能是 social_messages，
// 也可能是 chat_group_messages / collaboration_group_messages，所以每张表都要查。
const MESSAGE_TABLES = [
  'social_messages', 'chat_group_messages', 'collaboration_group_messages',
  'agent_delegation_workspace_messages', 'messages',
];
const messageScan = MESSAGE_TABLES.map((table) => {
  const total = q(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? 0;
  const coordination = q(`SELECT COUNT(*) AS n FROM ${table} WHERE metadata_json LIKE '%ubuddy_peer_coordination%'`)[0]?.n ?? 0;
  return { table, total, peerCoordinationMessages: coordination };
});

const peerSamples = [];
for (const table of MESSAGE_TABLES) {
  const rows = q(`SELECT * FROM ${table} WHERE metadata_json LIKE '%ubuddy_peer_coordination%' LIMIT 5`);
  for (const row of rows) {
    let metadata = null;
    try { metadata = JSON.parse(row.metadata_json || '{}'); } catch { metadata = { __parse_error: true }; }
    peerSamples.push({
      table,
      id: row.id,
      senderUserId: row.sender_user_id || row.senderUserId || '',
      recipientUserId: row.recipient_user_id || row.recipientUserId || '',
      type: metadata?.type || '',
      taskId: metadata?.taskId || '',
      targetOwnerUserId: metadata?.targetOwnerUserId || '',
      coordinationReason: metadata?.coordinationReason || '',
      threadId: metadata?.threadId || '',
      at: row.created_at || row.createdAt || '',
    });
  }
}

// uBuddy 之间的协调是否也走「消息」通道（createDelegationRuntimeApi 的 ubuddy_peer_coordination）
const messageTables = q(`SELECT name FROM sqlite_master WHERE type='table' AND (
  name LIKE '%message%' OR name LIKE '%social%' OR name LIKE '%conversation%') ORDER BY name`);

const delegations = q(`SELECT COUNT(*) AS total, SUM(CASE WHEN metadata_json LIKE '%groupId%' THEN 1 ELSE 0 END) AS withGroup
  FROM agent_delegations`);

console.log(JSON.stringify({
  db: DB_PATH,
  coordinationEventTypes,
  coordinationSamples: samples,
  peerCoordination: { scannedTables: messageScan, sampleCount: peerSamples.length, samples: peerSamples },
  candidateMessageTables: messageTables.map((row) => row.name),
  delegations: delegations[0] || {},
}, null, 2));
db.close();
