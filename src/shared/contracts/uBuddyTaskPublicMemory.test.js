import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRawAccessPipeline,
  inspectElevationItems,
  normalizeTaskPublicMemory,
  projectTaskPublicMemory,
  reviewRawAccessByAi,
} from './uBuddyTaskPublicMemory.js';

function memory() {
  const inspected = inspectElevationItems([
    { id: 'raw-ok', title: '数据里程碑', content: '数据收集完成，采用 market_data_v2', nodeId: 'n1' },
    { id: 'raw-secret', title: '密钥', content: 'api_key=sk-abcdefghijklmnopqrst', nodeId: 'n2' },
  ]);
  return normalizeTaskPublicMemory({
    taskId: 'task-report',
    ownerUserId: 'alice',
    participantUserIds: ['alice', 'bob'],
    foundation: {
      plan: { nodes: [{ id: 'n1', title: '收集数据', agentId: 'agent-a' }], edges: [] },
      exec: { nodes: [{ id: 'n1', title: '收集数据', agentId: 'agent-a', status: 'completed' }], edges: [] },
    },
    elevation: inspected.accepted,
    raw: [
      { id: 'raw-ok', title: '对话全文', content: 'Bob 与用户的完整私聊……', nodeId: 'n1' },
      { id: 'raw-secret', title: '密钥', content: 'api_key=sk-abcdefghijklmnopqrst', nodeId: 'n2' },
    ],
  });
}

test('inspect drops secret raw items from elevation', () => {
  const inspected = inspectElevationItems([
    { id: 'ok', title: '进度', content: '来源验证已完成' },
    { id: 'bad', title: '凭证', content: 'password=hunter2' },
  ]);
  assert.equal(inspected.accepted.length, 1);
  assert.equal(inspected.rejected.length, 1);
  assert.equal(inspected.accepted[0].sourceRawId, 'ok');
});

test('participants see foundation and elevation but not raw', () => {
  const view = projectTaskPublicMemory(memory(), { userId: 'bob', taskId: 'task-report' });
  assert.deepEqual(view.layers, ['foundation', 'elevation']);
  assert.equal(view.foundation.plan.nodes[0].id, 'n1');
  assert.equal(view.raw.length, 0);
  assert.ok(view.denied.includes('raw_requires_grant'));
});

test('other-task viewers see nothing without a grant', () => {
  const view = projectTaskPublicMemory(memory(), { userId: 'carol', taskId: 'other-task' });
  assert.equal(view.foundation, null);
  assert.deepEqual(view.layers, []);
});

test('AI rejects over-wide raw requests; owner grant unlocks excerpt', () => {
  const tpm = memory();
  const wide = reviewRawAccessByAi({
    sourceTaskId: 'other-task', targetTaskId: 'task-report', requesterUserId: 'carol',
    purpose: '需要全部原始上下文', nodeIds: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'], excerptOnly: false,
  }, tpm);
  assert.equal(wide.decision, 'reject');

  const pipeline = applyRawAccessPipeline({
    sourceTaskId: 'other-task', targetTaskId: 'task-report', requesterUserId: 'carol',
    purpose: '核对数据里程碑版本', nodeIds: ['raw-ok'], excerptOnly: true,
  }, tpm, { ownerDecision: 'approve', actorUserId: 'alice' });
  assert.equal(pipeline.ai.decision, 'pass');
  assert.equal(pipeline.owner.decision, 'approve');
  assert.ok(pipeline.projection.layers.includes('raw'));
  assert.equal(pipeline.projection.raw.length, 1);
  assert.ok(pipeline.projection.raw[0].content.length <= 280);
});
