import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRemoteExecution } from './remoteInitCore.mjs';
import { USERS, AGENT_FAMILIES, allAgentAliases, deterministicAgentId, passwordForUser, profileForUser } from './roster.mjs';

test('remote initializer refuses Windows and missing acknowledgement', () => {
  assert.throws(() => assertRemoteExecution({ platform: 'win32', env: { DATABASE_URL: 'x', JWT_SECRET: 'y' } }), /refuses to run on Windows/);
  assert.throws(() => assertRemoteExecution({ platform: 'linux', env: { DATABASE_URL: 'x', JWT_SECRET: 'y' } }), /REMOTE_INIT_ACK/);
});

test('roster is exactly six users and 36 internal agents', () => {
  assert.equal(USERS.length, 6);
  assert.equal(AGENT_FAMILIES.length, 6);
  assert.equal(allAgentAliases().length, 36);
  assert.equal(new Set(allAgentAliases().map((item) => deterministicAgentId(item.userId.at(-1), item.familyKey))).size, 36);
});

test('password derivation and profiles are deterministic and public-safe', () => {
  const password = passwordForUser({ userId: 'orgbench_user_a', seed: 'seed' });
  assert.equal(password, passwordForUser({ userId: 'orgbench_user_a', seed: 'seed' }));
  const profile = profileForUser(USERS[1], 'orgbench_ubuddy_b', 'a'.repeat(64));
  assert.equal(profile.visibility, 'friends');
  assert.equal(profile.publicationState, 'active');
  assert.equal(/password|token|cookie|file:\/\//i.test(JSON.stringify(profile)), false);
});
