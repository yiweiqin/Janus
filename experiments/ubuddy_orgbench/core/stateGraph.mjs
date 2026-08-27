import { makeEvent, nowIso, sha256 } from '../schema.mjs';

export class CollaborationStateGraph {
  constructor({ episodeId, method, addEvent }) {
    this.episodeId = episodeId;
    this.method = method;
    this.nodes = new Map();
    this.edges = [];
    this.events = [];
    this.history = [];
    this.addEvent = addEvent || ((event) => this.events.push(event));
  }

  node(id, data) {
    if (this.nodes.has(id)) return this.nodes.get(id);
    const value = { id, version: 1, status: 'pending', createdAt: nowIso(), updatedAt: nowIso(), ...data };
    this.nodes.set(id, value);
    this.history.push({ action: 'node_created', nodeId: id, version: value.version, status: value.status, occurredAt: value.createdAt });
    return value;
  }

  update(id, patch, actorId, actorLayer = 'requester_ubuddy') {
    const current = this.nodes.get(id);
    if (!current) throw new Error(`unknown_state_node:${id}`);
    const next = { ...current, ...patch, version: current.version + 1, updatedAt: nowIso() };
    this.nodes.set(id, next);
    this.history.push({ action: 'node_updated', nodeId: id, version: next.version, status: next.status, progress: next.progress ?? null, occurredAt: next.updatedAt });
    this.addEvent(makeEvent({ eventKind: patch.status === 'running' ? 'execution_started' : 'progress_published', episodeId: this.episodeId, actorId, actorLayer, sourceKind: 'state_node', sourceId: id, metadata: { version: next.version, status: next.status } }));
    return next;
  }

  edge(kind, from, to, metadata = {}) {
    const id = `${kind}_${sha256(`${this.episodeId}:${from}:${to}:${this.edges.length}`).slice(0, 10)}`;
    const edge = { id, kind, from, to, ...metadata, createdAt: nowIso() };
    this.edges.push(edge);
    return edge;
  }

  result(nodeId, actorId, actorLayer, summary, decision = 'pending') {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`unknown_state_node:${nodeId}`);
    const resultVersion = `${nodeId}:result:${node.version + 1}`;
    this.update(nodeId, { resultVersion, resultSummary: summary, resultDecision: decision, status: decision === 'adopted' ? 'done' : node.status }, actorId, actorLayer);
    this.addEvent(makeEvent({ eventKind: decision === 'superseded' ? 'handoff_superseded' : 'handoff_published', episodeId: this.episodeId, actorId, actorLayer, sourceKind: 'result_version', sourceId: resultVersion, metadata: { nodeId, decision } }));
    return resultVersion;
  }

  project(viewerId = 'all') {
    const nodes = [...this.nodes.values()].map(({ privateBody, ...node }) => node);
    return { graphVersion: 'ubuddy_global_collaboration_state_graph_v1', episodeId: this.episodeId, viewerId, nodes, edges: [...this.edges], stateItems: nodes.map((node) => ({ nodeId: node.id, owner: node.owner, status: node.status, progress: node.progress ?? null, parentNodeId: node.parentNodeId ?? null, visibility: node.visibility ?? 'all', updatedAt: node.updatedAt })), history: [...this.history] };
  }
}
