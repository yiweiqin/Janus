import { cloneRichGraph, normalizeRichGraph } from './graph.mjs';
import { makeRng } from './rng.mjs';

/**
 * v3 positional de-correlation.
 *
 * In v2 the node ids were assigned in topological order (n1..nN) and the node array was
 * also rendered in that order, so "lowest id" / "first node in the array" was equivalent to
 * "earliest node on the dependency chain". A three line diff that picks the lowest id then
 * solved the task at 100% Top-1 (see EVAL_v2_FINDINGS.zh-CN.md).
 *
 * This module relabels every node with a shuffled id and shuffles the node/edge arrays, so
 * positional cues carry no causal information; the dependency order has to be reconstructed
 * from the edges.
 */
export function obfuscateGraph(graph, seed = 1) {
  const rng = makeRng(seed);
  const source = cloneRichGraph(graph);
  const labels = rng.shuffle(source.nodes.map((node, index) => `n${index + 1}`));
  const remap = new Map();
  const nodes = source.nodes.map((node, index) => {
    const nextId = labels[index];
    remap.set(node.id, nextId);
    return { ...node, id: nextId };
  });
  const edges = source.edges.map((edge) => {
    const from = remap.get(edge.from) || edge.from;
    const to = remap.get(edge.to) || edge.to;
    return { id: `${from}->${to}`, from, to };
  });
  return normalizeRichGraph({
    ...source,
    nodes: rng.shuffle(nodes),
    edges: rng.shuffle(edges),
  });
}

/**
 * v3 difficulty guard: is the rendered order a valid topological order?
 *
 * Returns true when the id order (or, separately, the array order) already ranks every
 * edge's source before its target. Accepted v3 samples must not do this in either tree,
 * otherwise a positional shortcut is possible again.
 */
export function renderedOrderIsTopological(graph) {
  const normalized = normalizeRichGraph(graph);
  const idOrder = [...normalized.nodes]
    .sort((left, right) => numericLabel(left.id) - numericLabel(right.id))
    .map((node) => node.id);
  const byId = Object.fromEntries(idOrder.map((nodeId, index) => [nodeId, index]));
  const byArray = Object.fromEntries(normalized.nodes.map((node, index) => [node.id, index]));
  const isTopological = (table) => normalized.edges.every((edge) => (table[edge.from] ?? -1) < (table[edge.to] ?? -1));
  return { byId: isTopological(byId), byArray: isTopological(byArray) };
}

export function numericLabel(nodeId) {
  const digits = String(nodeId || '').match(/\d+/g);
  return digits ? Number(digits.join('')) : Number.MAX_SAFE_INTEGER;
}
