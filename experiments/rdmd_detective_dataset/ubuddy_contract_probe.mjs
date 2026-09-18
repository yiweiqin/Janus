/**
 * Does a real uBuddy task graph satisfy the trained model's input contract?
 *
 * Run: node experiments/rdmd_detective_dataset/ubuddy_contract_probe.mjs
 *
 * This is the product-side half of the integration check (no GPU, no model): what fields survive
 * `normalizeDriftGraph`, what `contrastDriftGraphs` can and cannot see, and what the model's own SFT
 * prompt contract actually requires. The model-side half is `ubuddy_model_probe.py`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contrastDriftGraphs, detectMinimalDrift, normalizeDriftGraph,
} from '../../src/shared/contracts/uBuddyReverseDetective.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Exactly the shape produced by normalizeTaskGraph in uBuddyTaskPublicMemory.js, which is what the
// live uBuddy flow builds (see the node() helper in experiments/v4_self_evolution_feasibility/run.mjs).
const ubuddyNode = (id) => ({
  id, title: id, agentId: `agent_${id}`, version: 'v1', acceptance: 'standard', role: id,
  status: 'completed',
});

const plan = {
  nodes: [ubuddyNode('intake'), ubuddyNode('research'), ubuddyNode('write')],
  edges: [
    { id: 'intake->research', from: 'intake', to: 'research' },
    { id: 'research->write', from: 'research', to: 'write' },
  ],
};

console.log('=== 1. fields a uBuddy node carries vs what the product contract keeps ===');
console.log('   uBuddy  :', Object.keys(plan.nodes[0]).sort().join(', '));
const normalized = normalizeDriftGraph(plan);
console.log('   kept    :', Object.keys(normalized.nodes[0]).sort().join(', '));
console.log('   dropped :', Object.keys(plan.nodes[0])
  .filter((key) => !(key in normalized.nodes[0])).join(', '));

console.log('\n=== 2. what the trained model needs (from the SFT prompt contract) ===');
const sft = readFileSync(join(HERE, 'sft', 'ood.jsonl'), 'utf8')
  .split('\n').find((line) => line.trim());
const promptNode = JSON.parse(JSON.parse(sft).prompt.split('INPUT=')[1]).G_star.nodes[0];
const modelKeys = Object.keys(promptNode).sort();
console.log('   model   :', modelKeys.join(', '));
console.log('   uBuddy is MISSING:',
  modelKeys.filter((key) => !(key in plan.nodes[0])).join(', '));

console.log('\n=== 3. is a prose-only drift visible to the product rule? ===');
const proseDrift = {
  nodes: plan.nodes.map((node) => (node.id === 'research'
    // The exact kind of change the model was built to read.
    ? { ...node, inputs: '换了输入来源', output: '结论改口径', summary: '复核后重写' }
    : node)),
  edges: plan.edges.map((edge) => ({ ...edge })),
};
const contrast = contrastDriftGraphs(plan, proseDrift);
console.log('   involvedNodeIds:', JSON.stringify(contrast.involvedNodeIds));
console.log('   detectMinimalDrift ->', JSON.stringify(detectMinimalDrift(plan, proseDrift).status));
console.log('   => the product rule is BLIND to this change; the trained model is not.');

console.log('\n=== 4. and a classic agent swap (what the product rule DOES see) ===');
const agentDrift = {
  nodes: plan.nodes.map((node) => (node.id === 'research' ? { ...node, agentId: 'agent_other' } : node)),
  edges: plan.edges.map((edge) => ({ ...edge })),
};
const verdict = detectMinimalDrift(plan, agentDrift);
console.log('   detectMinimalDrift ->',
  JSON.stringify({ status: verdict.status, nodeId: verdict.nodeId, type: verdict.type }));
console.log('   routeEvolution consumes {status,type} -> compatible with the model output shape.');
