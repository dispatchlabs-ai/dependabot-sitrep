import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOwnerScope, scopeRepositories } from '../public/owner-scope.js';
import { createDemoSnapshot } from '../src/demo.js';

const snapshot = createDemoSnapshot(() => Date.parse('2026-10-26T12:00:00.000Z'));
const { repositories, session } = snapshot;

test('selected organizations share one scope for repository and alert totals', () => {
  const selected = scopeRepositories(repositories, ['northstar-labs', 'orbit-engineering'], session.login);
  assert.equal(selected.length, 7);
  assert.deepEqual([...new Set(selected.map(repo => repo.owner))], ['northstar-labs', 'orbit-engineering']);
  assert.equal(selected.filter(repo => repo.alertsEnabled === true).length, 5);
  assert.equal(selected.filter(repo => repo.alertsEnabled === false).length, 2);
  assert.equal(selected.filter(repo => repo.counts !== null).length, 4);
  assert.equal(selected.reduce((sum, repo) => sum + (repo.counts?.total || 0), 0), 10);
  assert.deepEqual(['critical', 'high', 'medium', 'low'].map(severity => selected.reduce((sum, repo) => sum + (repo.counts?.[severity] || 0), 0)), [1, 4, 4, 1]);
});

test('an empty selection shows none while all owners includes every discovered repository', () => {
  assert.deepEqual(scopeRepositories(repositories, [], session.login), []);
  assert.equal(scopeRepositories(repositories, 'all', session.login).length, 12);
  assert.deepEqual(normalizeOwnerScope([]), []);
});

test('all organizations excludes personal and outside-collaborator user repositories', () => {
  const rows = [...repositories, { owner: 'outside-user', ownerType: 'User' }, { owner: 'unknown-owner', ownerType: 'Unknown' }];
  const selected = scopeRepositories(rows, 'organizations', session.login);
  assert.equal(selected.length, 10);
  assert.ok(selected.every(repo => repo.ownerType === 'Organization'));
});

test('personal scope uses the signed-in account rather than all user-owned repositories', () => {
  const rows = [...repositories, { owner: 'outside-user', ownerType: 'User' }];
  assert.deepEqual(scopeRepositories(rows, 'personal', session.login).map(repo => repo.fullName), ['alexchen/weekend-project', 'alexchen/dotfiles']);
  assert.deepEqual(scopeRepositories(rows, 'personal', null), []);
  assert.deepEqual(scopeRepositories(rows, 'personal', ''), []);
  assert.deepEqual(scopeRepositories(rows, ['outside-user'], session.login), [{ owner: 'outside-user', ownerType: 'User' }]);
});

test('unavailable selected owners remain selected during empty or changed discovery snapshots', () => {
  const scope = ['not-currently-visible'];
  assert.deepEqual(normalizeOwnerScope(scope), scope);
  assert.deepEqual(scopeRepositories([], scope, session.login), []);
  assert.deepEqual(scopeRepositories(repositories, scope, session.login), []);
  assert.deepEqual(scope, ['not-currently-visible']);
});

test('malformed saved scope falls back to all owners', () => {
  for (const value of [undefined, null, true, 7, {}, 'northstar-labs', ['northstar-labs', null], [''], ['  ']]) {
    assert.equal(normalizeOwnerScope(value), 'all');
    assert.equal(scopeRepositories(repositories, value, session.login).length, 12);
  }
});

test('normalizing and filtering deduplicate owners without mutating the stored selection or repository list', () => {
  const scope = Object.freeze(['northstar-labs', ' northstar-labs ', 'orbit-engineering']);
  const rows = Object.freeze([...repositories]);
  assert.deepEqual(normalizeOwnerScope(scope), ['northstar-labs', 'orbit-engineering']);
  const selected = scopeRepositories(rows, scope, session.login);
  selected.pop();
  assert.equal(rows.length, 12);
  assert.deepEqual(scope, ['northstar-labs', ' northstar-labs ', 'orbit-engineering']);
});
