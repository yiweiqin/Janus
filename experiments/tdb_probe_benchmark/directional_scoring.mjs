import { createHash } from 'node:crypto';

export const DEPENDENCY_DIMENSIONS = ['data','logic','quality','freshness','review','capability','resource','risk','downstreamImpact','uncertainty'];
export const EVOLUTION_CAUSES = ['node','edge','handoff','version','resource','disclosure','organization'];
const clamp = (x) => Math.max(0, Math.min(1, Number.isFinite(Number(x)) ? Number(x) : 0));
const vector = (x = {}) => Object.fromEntries(DEPENDENCY_DIMENSIONS.map(k => [k, clamp(x[k]?.mean ?? x[k]) ]));
export function directionalScore(input = {}) {
  const weights = input.weights || Object.fromEntries(DEPENDENCY_DIMENSIONS.map(k => [k, 1 / DEPENDENCY_DIMENSIONS.length]));
  const total = DEPENDENCY_DIMENSIONS.reduce((s,k) => s + Math.max(0, Number(weights[k] || 0)), 0) || 1;
  const normalized = Object.fromEntries(DEPENDENCY_DIMENSIONS.map(k => [k, Math.max(0, Number(weights[k] || 0)) / total]));
  const values = vector(input.state || input.dependency || {});
  const contributions = Object.fromEntries(DEPENDENCY_DIMENSIONS.map(k => [k, normalized[k] * values[k]]));
  const score = Object.values(contributions).reduce((a,b) => a+b, 0);
  return { version: 'directional-score-v1', direction: String(input.direction || 'accept_result'), weights: normalized, values, contributions, score, uncertainty: clamp(input.uncertainty ?? values.uncertainty), support: input.support ?? 'observed' };
}
export function evolutionPriority(input = {}) {
  const x = input.factors || input;
  const impact = clamp(x.impact), uncertainty = clamp(x.uncertainty), risk = clamp(x.risk), coupling = clamp(x.coupling), repairability = clamp(x.repairability);
  const cost = Math.max(Number(x.cost || 0), 0.000001);
  return { version: 'evolution-priority-v1', factors: { impact, uncertainty, risk, coupling, repairability, cost }, priorityScore: impact * uncertainty * risk * coupling * repairability / cost, candidateEdgeId: String(input.candidateEdgeId || x.candidateEdgeId || ''), causeSet: Array.isArray(input.causeSet) ? input.causeSet.filter(c => EVOLUTION_CAUSES.includes(c)) : [] };
}
export function hashEpisode(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
