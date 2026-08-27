/** Optional Janus Cloud synchronization for OrgBench runs.
 * The benchmark remains runnable offline; enabling sync makes the same episode
 * exercise the production profile/selection/delegation/projection APIs.
 */
export class JanusOrgBenchClient {
  constructor() {
    this.baseUrl = String(process.env.UBUDDY_ORGBENCH_JANUS_BASE_URL || process.env.JANUS_API_BASE_URL || '').replace(/\/$/, '');
    this.token = String(process.env.UBUDDY_ORGBENCH_JANUS_ACCESS_TOKEN || process.env.JANUS_ACCESS_TOKEN || '');
    this.evolutionToken = String(process.env.UBUDDY_ORGBENCH_EVOLUTION_GRANT || process.env.JANUS_EVOLUTION_GRANT || this.token);
    this.enabled = process.env.UBUDDY_ORGBENCH_JANUS_SYNC === '1' && Boolean(this.baseUrl && this.token);
    this.audit = [];
  }
  async request(route, { method = 'GET', body, evolution = false, token = '' } = {}) {
    if (!this.enabled) return { status: 'skipped', route, reason: 'janus_sync_disabled_or_missing_credentials' };
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    const record = { route, method, requestHash: hash(requestBody || ''), timestamp: new Date().toISOString(), status: 'started', runId: '' };
    this.audit.push(record);
    const response = await fetch(`${this.baseUrl}${route}`, { method, headers: { authorization: `Bearer ${token || (evolution ? this.evolutionToken : this.token)}`, accept: 'application/json', 'content-type': 'application/json' }, body: requestBody, signal: AbortSignal.timeout(15000) });
    const payload = await response.json().catch(() => ({}));
    Object.assign(record, { status: response.ok ? 'ok' : 'failed', responseHash: hash(JSON.stringify(payload)), runId: payload?.run?.id || payload?.id || '' });
    if (!response.ok) { const error = new Error(`janus_api_${response.status}:${route}`); error.audit = record; throw error; }
    return { status: 'ok', route, payload, audit: record };
  }
  queryCandidates({ userIds, requirement }) { return this.request('/api/collaboration/candidates/query', { method: 'POST', body: { userIds, requirement, socialCapability: 'ubuddy-capability-profile-v1' } }); }
  confirmSelection(body) { return this.request('/api/collaboration/selections/confirm', { method: 'POST', body: { ...body, socialCapability: 'ubuddy-capability-profile-v1' } }); }
  createDelegation(body) { return this.request('/api/delegations', { method: 'POST', body }); }
  stateGraph({ groupId, delegationId }) { const params = new URLSearchParams({ capability: 'agent-work-detail-projection-v1' }); if (groupId) params.set('groupId', groupId); if (delegationId) params.set('delegationId', delegationId); return this.request(`/api/collaboration/state-graph?${params}`); }
  attribution(delegationId) { return this.request(`/api/collaboration/attribution?capability=agent-work-detail-projection-v1&delegationId=${encodeURIComponent(delegationId)}`); }
  routeAttribution(delegationId, payload = {}) { return this.request(`/api/collaboration/attribution/${encodeURIComponent(delegationId)}/evolution-route`, { method: 'POST', body: { ...payload, socialCapability: 'agent-work-detail-projection-v1', minConfidence: 0.7 } }); }
  routeAttributionAs(delegationId, payload = {}, token = '') { return this.request(`/api/collaboration/attribution/${encodeURIComponent(delegationId)}/evolution-route`, { method: 'POST', body: { ...payload, socialCapability: 'agent-work-detail-projection-v1', minConfidence: 0.7 }, token }); }
  evolutionImpact(delegationId) { return this.request(`/api/collaboration/evolution-impact?capability=agent-work-detail-projection-v1&delegationId=${encodeURIComponent(delegationId)}`); }
  uploadOrganizationTrace(body) { return this.request('/api/evolution/organization/traces', { method: 'POST', body: { ...body, capability: 'ubuddy-organization-evolution-v1' } }); }
  createOrganizationPolicy(body) { return this.request('/api/evolution/organization/policies', { method: 'POST', body: { ...body, capability: 'ubuddy-organization-evolution-v1' } }); }
  organizationOverview(namespace = 'default') { return this.request(`/api/evolution/organization/overview?capability=ubuddy-organization-evolution-v1&evolutionNamespace=${encodeURIComponent(namespace)}`); }
  activateOrganizationPolicy(policyVersionId, body = {}) { return this.request(`/api/evolution/organization/policies/${encodeURIComponent(policyVersionId)}/activate`, { method: 'POST', body: { ...body, capability: 'ubuddy-organization-evolution-v1' } }); }
  disableOrganizationPolicy(body = {}) { return this.request('/api/evolution/organization/disable', { method: 'POST', body: { ...body, capability: 'ubuddy-organization-evolution-v1' } }); }
  personalRun(runId) { return this.request(`/v1/evolution/personal/runs/${encodeURIComponent(runId)}`, { evolution: true }); }
  personalVersions(agentInstanceId) { return this.request(`/v1/evolution/personal/versions?agentInstanceId=${encodeURIComponent(agentInstanceId)}`, { evolution: true }); }
  activatePersonalVersion(versionId, body = {}) { return this.request(`/v1/evolution/personal/versions/${encodeURIComponent(versionId)}/activate`, { method: 'POST', body, evolution: true }); }
  decidePersonalRun(runId, body = {}) { return this.request(`/v1/evolution/personal/runs/${encodeURIComponent(runId)}/decisions`, { method: 'POST', body, evolution: true }); }
  rollbackPersonal(body = {}) { return this.request('/v1/evolution/personal/rollback', { method: 'POST', body, evolution: true }); }
}

function hash(value) { return cryptoHash(String(value || '')); }
function cryptoHash(value) {
  let hashValue = 2166136261;
  for (let index = 0; index < value.length; index += 1) hashValue = Math.imul(hashValue ^ value.charCodeAt(index), 16777619);
  return (hashValue >>> 0).toString(16).padStart(8, '0');
}
