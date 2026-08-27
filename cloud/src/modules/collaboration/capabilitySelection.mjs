import crypto from 'node:crypto';

const SELECTION_SNAPSHOT_VERSION = 'ubuddy_capability_selection_snapshot_v1';
const CANDIDATE_QUERY_VERSION = 'ubuddy_collaboration_candidate_query_v1';

export function createCapabilitySelectionToken(snapshot = {}, secret = '') {
  const payload = Buffer.from(JSON.stringify(snapshot), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', String(secret || ''))
    .update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyCapabilitySelectionToken(token = '', secret = '') {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature || !secret) return null;
  const expected = crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return value?.version === SELECTION_SNAPSHOT_VERSION ? value : null;
  } catch {
    return null;
  }
}

export async function queryCollaborationCandidates(pool, {
  viewerUserId = '', userIds = [], requirement = {}, apiError = defaultApiError,
} = {}) {
  const cleanUserIds = unique(userIds).filter((userId) => userId !== viewerUserId);
  if (!cleanUserIds.length) throw apiError('collaboration_candidate_ids_required', 'At least one candidate userId is required.', 400);
  if (cleanUserIds.length > 100) throw apiError('collaboration_candidate_query_too_large', 'At most 100 candidates can be queried.', 400);
  const normalizedRequirement = normalizeRequirement(requirement);
  const profiles = await visibleCapabilityProfiles(pool, { viewerUserId, userIds: cleanUserIds });
  const candidates = [];
  for (const profile of profiles) {
    const match = matchProfile(profile.profile, normalizedRequirement);
    const experienceSupport = await collaborationExperienceSupport(pool, profile.ownerUserId);
    const baseScore = match.score;
    const evolvedScore = clamp(baseScore + experienceSupport.scoreAdjustment, 0, 1);
    candidates.push({
      ownerUserId: profile.ownerUserId,
      accessScope: profile.accessScope,
      profileRevision: profile.profileRevision,
      contentHash: profile.contentHash,
      stateRevision: profile.stateRevision,
      publishedAt: profile.publishedAt,
      profile: profile.profile,
      match,
      experienceSupport,
      ranking: {
        baseScore,
        evolvedScore,
        evolutionApplied: experienceSupport.evidenceCount > 0,
      },
    });
  }
  candidates.sort((left, right) => right.ranking.evolvedScore - left.ranking.evolvedScore
    || right.ranking.baseScore - left.ranking.baseScore
    || left.ownerUserId.localeCompare(right.ownerUserId));
  const unavailableUserIds = cleanUserIds.filter((userId) => !profiles.some((item) => item.ownerUserId === userId));
  const queryBasis = {
    viewerUserId,
    userIds: cleanUserIds,
    requirement: normalizedRequirement,
    profileRefs: candidates.map((item) => `${item.ownerUserId}:${item.profileRevision}:${item.contentHash}`),
  };
  return {
    queryVersion: CANDIDATE_QUERY_VERSION,
    queryId: `capquery_${stableHash(queryBasis).slice(0, 24)}`,
    viewerUserId,
    requirement: normalizedRequirement,
    candidates,
    unavailableUserIds,
  };
}

export async function captureCapabilitySelectionSnapshot(pool, {
  viewerUserId = '', recipientUserId = '', selection = {}, apiError = defaultApiError,
} = {}) {
  if (!viewerUserId || !recipientUserId) throw apiError('capability_selection_participants_required', 'Selection participants are required.', 400);
  const requestedRevision = nonNegativeInteger(selection.profileRevision);
  const requestedContentHash = String(selection.contentHash || '').trim();
  const recipientRow = await profileRow(pool, recipientUserId, requestedRevision);
  if (!recipientRow) throw apiError('capability_selection_profile_not_found', 'The selected uBuddy capability profile is unavailable.', 409);
  if (recipientRow.publication_state !== 'active') {
    throw apiError('capability_selection_profile_changed', 'The selected uBuddy capability profile is no longer active.', 409, {
      requestedProfileRevision: requestedRevision,
      currentProfileRevision: Number((await profileRow(pool, recipientUserId, 0))?.profile_revision || 0),
    });
  }
  const accessScope = await capabilityAccessScope(pool, {
    viewerUserId, ownerUserId: recipientUserId, visibility: recipientRow.visibility,
  });
  if (!accessScope) throw apiError('capability_selection_profile_not_visible', 'The selected uBuddy capability profile is not visible to the requester.', 403);
  if (requestedContentHash && requestedContentHash !== recipientRow.content_hash) {
    throw apiError('capability_selection_profile_changed', 'The selected uBuddy capability profile changed before delegation creation.', 409, {
      requestedProfileRevision: requestedRevision,
      currentProfileRevision: Number(recipientRow.profile_revision || 0),
    });
  }
  const requesterRow = await profileRow(pool, viewerUserId, 0);
  const selectedAt = new Date().toISOString();
  return {
    version: SELECTION_SNAPSHOT_VERSION,
    selectedAt,
    selectedByUserId: viewerUserId,
    selectionMode: selection.queryId ? 'candidate_query' : 'active_profile_snapshot',
    queryId: String(selection.queryId || '').trim().slice(0, 200),
    selectionReason: String(selection.selectionReason || '').trim().slice(0, 1000),
    requirement: normalizeRequirement(selection.requirement),
    consideredCandidateUserIds: unique(selection.consideredCandidateUserIds).slice(0, 100),
    recipientProfile: immutableProfileSummary(recipientRow, accessScope),
    requesterProfile: requesterRow ? immutableProfileSummary(requesterRow, 'owner') : null,
  };
}

export function capabilitySelectionSnapshotFromDelegation(delegation = {}) {
  const value = jsonObject(delegation.metadata_json).capabilitySelectionSnapshot;
  return value?.version === SELECTION_SNAPSHOT_VERSION ? value : null;
}

export async function visibleCapabilityProfiles(pool, { viewerUserId = '', userIds = [] } = {}) {
  const result = [];
  for (const ownerUserId of unique(userIds)) {
    const row = await profileRow(pool, ownerUserId, 0);
    if (!row) continue;
    const accessScope = await capabilityAccessScope(pool, { viewerUserId, ownerUserId, visibility: row.visibility });
    if (!accessScope) continue;
    result.push(profilePayload(row, accessScope));
  }
  return result;
}

async function profileRow(pool, ownerUserId = '', profileRevision = 0) {
  if (profileRevision > 0) {
    return one(pool, `SELECT * FROM social_ubuddy_capability_profiles
      WHERE owner_user_id=$1 AND profile_revision=$2 ORDER BY created_at DESC LIMIT 1`, [ownerUserId, profileRevision]);
  }
  return one(pool, `SELECT * FROM social_ubuddy_capability_profiles
    WHERE owner_user_id=$1 AND publication_state='active' ORDER BY profile_revision DESC LIMIT 1`, [ownerUserId]);
}

async function capabilityAccessScope(pool, { viewerUserId = '', ownerUserId = '', visibility = 'friends' } = {}) {
  if (!viewerUserId || !ownerUserId) return '';
  if (viewerUserId === ownerUserId) return 'owner';
  const blocked = await one(pool, `SELECT 1 FROM user_blocks
    WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1`, [viewerUserId, ownerUserId]);
  if (blocked) return '';
  const [userA, userB] = orderedUserPair(viewerUserId, ownerUserId);
  const friendship = await one(pool, "SELECT 1 FROM friendships WHERE user_a_id=$1 AND user_b_id=$2 AND status='accepted' LIMIT 1", [userA, userB]);
  if (friendship) return 'friends';
  if (visibility !== 'organization') return '';
  const organization = await one(pool, `SELECT 1 FROM contact_organization_members viewer
    JOIN contact_organization_members owner ON owner.organization_id=viewer.organization_id
    WHERE viewer.user_id=$1 AND owner.user_id=$2 LIMIT 1`, [viewerUserId, ownerUserId]);
  return organization ? 'organization' : '';
}

async function collaborationExperienceSupport(pool, ownerUserId = '') {
  try {
    const row = await one(pool, `SELECT
        COALESCE(SUM(CASE WHEN d.status IN ('result_accepted','closed','completed') THEN 1 ELSE 0 END),0)::int AS positive_count,
        COALESCE(SUM(CASE WHEN d.status IN ('failed','blocked','declined','rejected') THEN 1 ELSE 0 END),0)::int AS negative_count,
        COUNT(e.evidence_id)::int AS evidence_count
      FROM cloud_evolution_evidence e
      LEFT JOIN agent_delegations d ON d.id=e.delegation_id
      WHERE e.owner_user_id=$1 AND e.validation_status='validated'`, [ownerUserId]);
    const positiveCount = Number(row?.positive_count || 0);
    const negativeCount = Number(row?.negative_count || 0);
    const evidenceCount = Number(row?.evidence_count || 0);
    return {
      evidenceCount,
      positiveCount,
      negativeCount,
      scoreAdjustment: clamp((positiveCount - negativeCount) * 0.04, -0.16, 0.16),
      confidence: evidenceCount ? clamp(evidenceCount / 5, 0.2, 0.9) : 0,
    };
  } catch (error) {
    if (!/cloud_evolution_evidence|agent_delegations/i.test(String(error?.message || ''))) throw error;
    return { evidenceCount: 0, positiveCount: 0, negativeCount: 0, scoreAdjustment: 0, confidence: 0 };
  }
}

function matchProfile(profile = {}, requirement = {}) {
  const dimensions = [
    ['capabilityTags', 0.4],
    ['supportedTaskTypes', 0.3],
    ['deliverableTypes', 0.2],
    ['preferredTasks', 0.1],
  ];
  let weightedMatched = 0;
  let weightedRequested = 0;
  const matched = {};
  const missing = {};
  for (const [key, weight] of dimensions) {
    const requested = normalizeTerms(requirement[key]);
    const offered = normalizeTerms(profile[key]);
    if (!requested.length) continue;
    const found = requested.filter((term) => offered.some((value) => termMatch(term, value)));
    matched[key] = found;
    missing[key] = requested.filter((term) => !found.includes(term));
    weightedMatched += weight * (found.length / requested.length);
    weightedRequested += weight;
  }
  const unsupported = normalizeTerms(profile.unsupportedTasks);
  const requestText = [requirement.description, ...Object.values(requirement).flatMap((value) => Array.isArray(value) ? value : [])].join(' ').toLowerCase();
  const conflicts = unsupported.filter((term) => requestText.includes(term.toLowerCase()));
  const score = weightedRequested ? clamp(weightedMatched / weightedRequested - conflicts.length * 0.2, 0, 1) : 0.5;
  return { score, matched, missing, conflicts };
}

function normalizeRequirement(value = {}) {
  const source = jsonObject(value);
  return {
    description: String(source.description || '').trim().slice(0, 2000),
    capabilityTags: normalizeTerms(source.capabilityTags),
    supportedTaskTypes: normalizeTerms(source.supportedTaskTypes),
    deliverableTypes: normalizeTerms(source.deliverableTypes),
    preferredTasks: normalizeTerms(source.preferredTasks),
  };
}

function immutableProfileSummary(row = {}, accessScope = '') {
  const profile = jsonObject(row.profile_json);
  return {
    ownerUserId: row.owner_user_id || '',
    uBuddyAgentInstanceId: row.ubuddy_agent_instance_id || profile.uBuddyAgentInstanceId || '',
    profileRevision: Number(row.profile_revision || 0),
    profileVersion: row.profile_version || profile.version || '',
    stateRevision: Number(row.state_revision || 0),
    contentHash: row.content_hash || '',
    visibility: row.visibility || '',
    accessScope,
    publishedAt: toIso(row.published_at),
    capabilitySummary: {
      introduction: String(profile.introduction || '').slice(0, 1000),
      supportedTaskTypes: normalizeTerms(profile.supportedTaskTypes),
      deliverableTypes: normalizeTerms(profile.deliverableTypes),
      capabilityTags: normalizeTerms(profile.capabilityTags),
      preferredTasks: normalizeTerms(profile.preferredTasks),
      unsupportedTasks: normalizeTerms(profile.unsupportedTasks),
      collaborationModes: normalizeTerms(profile.collaborationModes),
      availability: profile.availability || null,
      evidenceSummary: String(profile.evidenceSummary || '').slice(0, 1000),
    },
  };
}

function profilePayload(row = {}, accessScope = '') {
  return {
    ownerUserId: row.owner_user_id || '',
    accessScope,
    contentHash: row.content_hash || '',
    stateRevision: Number(row.state_revision || 0),
    profileRevision: Number(row.profile_revision || 0),
    visibility: row.visibility || '',
    publishedAt: toIso(row.published_at),
    profile: jsonObject(row.profile_json),
  };
}

function normalizeTerms(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function termMatch(left = '', right = '') {
  const a = String(left).toLowerCase();
  const b = String(right).toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function orderedUserPair(left = '', right = '') {
  return left < right ? [left, right] : [right, left];
}

function unique(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function nonNegativeInteger(value = 0) {
  const number = Math.floor(Number(value || 0));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value || 0)));
}

function jsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toIso(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

async function one(pool, sql, params = []) {
  return (await pool.query(sql, params)).rows[0] || null;
}

function defaultApiError(code, message, status = 400, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}
