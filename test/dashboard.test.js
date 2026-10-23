import test from 'node:test';
import assert from 'node:assert/strict';
import { Dashboard } from '../src/dashboard.js';

const fixedTime = Date.parse('2026-10-23T15:00:00.000Z');
const rawRepo = (id, options = {}) => ({
  id, full_name: `example/repo-${id}`, name: `repo-${id}`, owner: { login: 'example' },
  html_url: `https://github.com/example/repo-${id}`, language: 'JavaScript', private: true,
  archived: false, permissions: { admin: true, pull: true }, enabled: true, ...options,
});
const alert = (severity = 'high', number = 1) => ({
  number, severity, package: 'example-package', ecosystem: 'npm', summary: 'Example advisory',
  url: `https://github.com/example/repo-1/security/dependabot/${number}`,
  advisoryUrl: 'https://github.com/advisories/GHSA-example',
  manifest: 'package-lock.json', vulnerableRange: '< 2.0.1', patchedVersion: '2.0.1', createdAt: '2026-10-20T00:00:00.000Z',
});
const err = (kind, text, status = 403) => Object.assign(new Error(text), { kind, status });

function fakeClient(repositories = [rawRepo(1)]) {
  return {
    hostname: 'github.com', login: 'octocat', repositories, writes: [], calls: [],
    async getViewer() { this.calls.push('viewer'); return { login: this.login, url: `https://github.com/${this.login}` }; },
    async listRepositories() { this.calls.push('repositories'); return { repositories: this.repositories, warnings: [] }; },
    async getEnablement(rows) {
      this.calls.push('enablement');
      return new Map(rows.map((row) => [String(row.id), { enabled: row.enabled ?? null, permission: row.permissions.admin ? 'ADMIN' : 'WRITE', error: null }]));
    },
    async listAlerts(fullName) { this.calls.push(`alerts:${fullName}`); return [alert()]; },
    async getRepository(fullName) { this.calls.push(`repository:${fullName}`); return this.repositories.find((row) => row.full_name === fullName); },
    async enableAlerts(fullName) {
      this.writes.push(fullName);
      this.repositories.find((row) => row.full_name === fullName).enabled = true;
    },
  };
}

async function scanned(client) {
  const dashboard = new Dashboard({ client, clock: () => fixedTime });
  await dashboard.initialize();
  await dashboard.startScan();
  await dashboard.waitForScan();
  return dashboard;
}

test('initialize authenticates without scanning; snapshots contain cloned allowlisted data', async () => {
  const client = fakeClient([rawRepo(1, { temp_clone_token: 'never-expose-me', unknown: 'hidden', html_url: 'javascript:alert(1)' })]);
  const dashboard = new Dashboard({ client });
  await dashboard.initialize();
  assert.deepEqual(client.calls, ['viewer']);
  await dashboard.startScan();
  await dashboard.waitForScan();
  const state = dashboard.snapshot();
  assert.equal(state.scan.status, 'complete');
  assert.equal(state.repositories[0].url, 'https://github.com/example/repo-1');
  assert.equal(state.repositories[0].temp_clone_token, undefined);
  assert.equal(state.repositories[0].unknown, undefined);
  assert.equal(JSON.stringify(state).includes('never-expose-me'), false);
  state.repositories[0].name = 'changed';
  assert.equal(dashboard.snapshot().repositories[0].name, 'repo-1');
});

test('disabled and unavailable alert counts remain unknown; empty successful alerts are known zero', async () => {
  const client = fakeClient([rawRepo(1, { enabled: false }), rawRepo(2), rawRepo(3, { enabled: null }), rawRepo(4, { enabled: null })]);
  client.listAlerts = async (fullName) => {
    if (fullName.endsWith('repo-2')) throw err('permission', 'Dependabot access denied.');
    if (fullName.endsWith('repo-4')) return [alert('critical')];
    return [];
  };
  const state = (await scanned(client)).snapshot();
  assert.equal(state.scan.processed, 4);
  assert.equal(state.repositories[0].scanState, 'disabled');
  assert.equal(state.repositories[0].counts, null);
  assert.equal(state.repositories[0].canEnable, true);
  assert.equal(state.repositories[1].scanState, 'unavailable');
  assert.equal(state.repositories[1].counts, null);
  assert.equal(state.repositories[2].counts.total, 0);
  assert.equal(state.repositories[2].alertsEnabled, null);
  assert.equal(state.repositories[3].alertsEnabled, true);
  assert.equal(state.repositories[3].counts.critical, 1);
});

test('owner types distinguish organizations from personal and outside-collaborator repositories', async () => {
  const client = fakeClient([
    rawRepo(1, { owner: { login: 'example', type: 'Organization' } }),
    rawRepo(2, { owner: { login: 'example', type: 'User' } }),
    rawRepo(3, { owner: { login: 'example', type: 'Unexpected' } }),
  ]);
  const state = (await scanned(client)).snapshot();
  assert.deepEqual(state.repositories.map((row) => row.ownerType), ['Organization', 'User', 'Unknown']);
});

test('scan returns promptly and refuses duplicate scans or enable operations while running', async () => {
  const client = fakeClient();
  let release;
  client.listRepositories = () => new Promise((resolve) => { release = resolve; });
  const dashboard = new Dashboard({ client });
  const state = await dashboard.startScan();
  assert.equal(state.scan.status, 'running');
  await assert.rejects(dashboard.startScan(), { kind: 'busy', status: 409 });
  await assert.rejects(dashboard.enableRepository('1'), { kind: 'busy', status: 409 });
  release({ repositories: [], warnings: [] });
  assert.equal((await dashboard.waitForScan()).scan.status, 'complete');
});

test('unavailable settings metadata still allows readable alerts without claiming empty repos are enabled', async () => {
  const client = fakeClient([rawRepo(1), rawRepo(2)]);
  client.getEnablement = async () => { throw err('permission', 'Repository settings are unavailable.'); };
  client.listAlerts = async (fullName) => fullName.endsWith('repo-1') ? [alert()] : [];
  const state = (await scanned(client)).snapshot();
  assert.equal(state.scan.status, 'complete');
  assert.equal(state.repositories[0].alertsEnabled, true);
  assert.equal(state.repositories[0].counts.total, 1);
  assert.equal(state.repositories[1].alertsEnabled, null);
  assert.equal(state.repositories[1].counts.total, 0);
  assert.equal(state.warnings.length, 1);
});

test('restricted and not-found alert responses remain unavailable, never zero', async () => {
  const client = fakeClient([rawRepo(1), rawRepo(2)]);
  client.listAlerts = async (fullName) => { throw err(fullName.endsWith('repo-1') ? 'restricted' : 'not_found', 'Alert details are unavailable.'); };
  const state = (await scanned(client)).snapshot();
  assert.equal(state.scan.status, 'complete');
  for (const row of state.repositories) {
    assert.equal(row.scanState, 'unavailable');
    assert.equal(row.counts, null);
  }
});

test('expired authentication or missing CLI aborts alert scans without repeating failed requests', async () => {
  for (const kind of ['auth', 'cli_missing']) {
    const client = fakeClient([rawRepo(1), rawRepo(2)]);
    let calls = 0;
    client.listAlerts = async () => { calls++; throw err(kind, 'Reconnect GitHub CLI.', 401); };
    const state = (await scanned(client)).snapshot();
    assert.equal(calls, 1);
    assert.equal(state.scan.status, 'error');
    assert.equal(state.session.connected, false);
    assert.deepEqual(state.repositories, []);
  }
});

test('enable actions stay disabled until the scan completes', async () => {
  const client = fakeClient([rawRepo(1, { enabled: false }), rawRepo(2)]);
  let release;
  client.listAlerts = () => new Promise((resolve) => { release = resolve; });
  const dashboard = new Dashboard({ client });
  await dashboard.startScan();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dashboard.snapshot().repositories[0].canEnable, false);
  release([]);
  assert.equal((await dashboard.waitForScan()).repositories[0].canEnable, true);
});

test('new identity removes prior data before discovering its repositories', async () => {
  const client = fakeClient();
  const dashboard = await scanned(client);
  assert.equal(dashboard.snapshot().repositories.length, 1);
  let release;
  client.login = 'different-user';
  client.listRepositories = () => new Promise((resolve) => { release = resolve; });
  await dashboard.startScan();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dashboard.snapshot().session.login, 'different-user');
  assert.deepEqual(dashboard.snapshot().repositories, []);
  release({ repositories: [], warnings: [] });
  await dashboard.waitForScan();
});

test('identity changes during a long scan clear mixed-account results before completion', async () => {
  const client = fakeClient();
  client.listAlerts = async () => { client.login = 'different-user'; return [alert()]; };
  const state = (await scanned(client)).snapshot();
  assert.equal(state.scan.status, 'error');
  assert.match(state.scan.error, /account changed during the scan/);
  assert.equal(state.session.login, 'different-user');
  assert.equal(state.session.connected, true);
  assert.equal(state.scan.total, 0);
  assert.deepEqual(state.repositories, []);
});

test('initialize authentication failure produces a useful state and redacts token-looking errors', async () => {
  const client = fakeClient();
  client.getViewer = async () => { throw err('auth', 'Run gh auth login. Token ghp_sensitivevalue failed.'); };
  const state = await new Dashboard({ client }).initialize();
  assert.equal(state.session.connected, false);
  assert.equal(state.scan.status, 'error');
  assert.match(state.scan.error, /gh auth login/);
  assert.equal(state.scan.error.includes('ghp_sensitivevalue'), false);
});

test('rate limit pauses without scanning remaining repos and blocks refresh until retry time', async () => {
  let now = fixedTime;
  const client = fakeClient([rawRepo(1), rawRepo(2)]);
  let calls = 0;
  client.listAlerts = async () => {
    calls++;
    throw Object.assign(err('rate_limit', 'GitHub rate limit reached.', 429), { retryAt: new Date(fixedTime + 60_000).toISOString() });
  };
  const dashboard = new Dashboard({ client, clock: () => now });
  await dashboard.startScan();
  const state = await dashboard.waitForScan();
  assert.equal(calls, 1);
  assert.equal(state.scan.status, 'paused');
  assert.equal(state.scan.processed, 0);
  assert.equal(state.scan.retryAt, '2026-10-23T15:01:00.000Z');
  assert.equal(state.repositories[0].counts, null);
  await assert.rejects(dashboard.startScan(), { kind: 'rate_limit', status: 429 });
  now += 60_001;
  client.listAlerts = async () => [];
  await dashboard.startScan();
  assert.equal((await dashboard.waitForScan()).scan.status, 'complete');
});

test('enable rejects unknown repositories and changed GitHub identity without writing', async () => {
  const client = fakeClient([rawRepo(1, { enabled: false })]);
  const dashboard = await scanned(client);
  await assert.rejects(dashboard.enableRepository('unknown'), { kind: 'validation', status: 404 });
  client.login = 'different-user';
  await assert.rejects(dashboard.enableRepository('1'), { kind: 'auth', status: 409 });
  assert.deepEqual(client.writes, []);
  assert.deepEqual(dashboard.snapshot().repositories, []);
  assert.equal(dashboard.snapshot().session.login, 'different-user');
});

test('enable revalidates admin permissions and archive state before writing', async () => {
  for (const change of [{ permissions: { admin: false, push: true } }, { archived: true }]) {
    const client = fakeClient([rawRepo(1, { enabled: false })]);
    const dashboard = await scanned(client);
    Object.assign(client.repositories[0], change);
    await assert.rejects(dashboard.enableRepository('1'), { kind: 'permission', status: 403 });
    assert.deepEqual(client.writes, []);
    assert.equal(dashboard.snapshot().repositories[0].canEnable, false);
  }
});

test('expired authentication at enable clears previous repository data without writing', async () => {
  const client = fakeClient([rawRepo(1, { enabled: false })]);
  const dashboard = await scanned(client);
  client.getViewer = async () => { throw err('auth', 'Run gh auth login.', 401); };
  await assert.rejects(dashboard.enableRepository('1'), { kind: 'auth', status: 401 });
  assert.deepEqual(client.writes, []);
  assert.equal(dashboard.snapshot().session.connected, false);
  assert.deepEqual(dashboard.snapshot().repositories, []);
});

test('GraphQL admin permission cannot substitute for missing fresh repository admin permission', async () => {
  const client = fakeClient([rawRepo(1, { enabled: false })]);
  const dashboard = await scanned(client);
  client.repositories[0].permissions = {};
  client.getEnablement = async (rows) => new Map(rows.map((row) => [String(row.id), { enabled: false, permission: 'ADMIN' }]));
  await assert.rejects(dashboard.enableRepository('1'), { kind: 'permission', status: 403 });
  assert.deepEqual(client.writes, []);
});

test('enable rejects a repository replaced at the same full name', async () => {
  const client = fakeClient([rawRepo(1, { enabled: false })]);
  const dashboard = await scanned(client);
  client.repositories[0].id = 999;
  await assert.rejects(dashboard.enableRepository('1'), { kind: 'validation', status: 409 });
  assert.deepEqual(client.writes, []);
});

test('enable verifies its write, loads alerts, and refuses duplicate concurrent writes or scans', async () => {
  const client = fakeClient([rawRepo(1, { enabled: false })]);
  const dashboard = await scanned(client);
  let release;
  const original = client.enableAlerts.bind(client);
  client.enableAlerts = async (fullName) => {
    await new Promise((resolve) => { release = resolve; });
    await original(fullName);
  };
  const pending = dashboard.enableRepository('1');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(dashboard.enableRepository('1'), { kind: 'busy', status: 409 });
  await assert.rejects(dashboard.startScan(), { kind: 'busy', status: 409 });
  release();
  const state = await pending;
  assert.deepEqual(client.writes, ['example/repo-1']);
  assert.equal(state.repositories[0].alertsEnabled, true);
  assert.equal(state.repositories[0].counts.high, 1);
  assert.equal(state.repositories[0].canEnable, false);
  assert.equal(client.calls.filter((call) => call === 'enablement').length, 3);
});

test('an unverified write is not presented as successful and alert read errors do not undo confirmed enablement', async () => {
  const client = fakeClient([rawRepo(1, { enabled: false })]);
  const dashboard = await scanned(client);
  client.enableAlerts = async (fullName) => { client.writes.push(fullName); };
  await assert.rejects(dashboard.enableRepository('1'), /did not confirm/);
  assert.equal(dashboard.snapshot().repositories[0].alertsEnabled, false);
  client.enableAlerts = async () => { client.repositories[0].enabled = true; };
  client.listAlerts = async () => { throw err('permission', 'Alert read denied.'); };
  const state = await dashboard.enableRepository('1');
  assert.equal(state.repositories[0].alertsEnabled, true);
  assert.equal(state.repositories[0].counts, null);
  assert.match(state.repositories[0].error, /Alerts are enabled/);
});

test('demo fixtures are isolated, cover diverse states, and enable without any GitHub client', async () => {
  const dashboard = new Dashboard({ demo: true, clock: () => fixedTime });
  const state = await dashboard.initialize();
  assert.equal(state.demo, true);
  assert.equal(state.repositories.length, 12);
  assert.equal(new Set(state.repositories.map((row) => row.owner)).size, 4);
  assert.ok(state.repositories.filter((row) => row.owner === 'alexchen').every((row) => row.ownerType === 'User'));
  assert.ok(state.repositories.filter((row) => row.owner !== 'alexchen').every((row) => row.ownerType === 'Organization'));
  assert.ok(state.repositories.some((row) => row.scanState === 'unavailable'));
  assert.ok(state.repositories.some((row) => row.archived));
  const repo = state.repositories.find((row) => row.canEnable);
  const enabled = await dashboard.enableRepository(repo.id);
  assert.equal(enabled.repositories.find((row) => row.id === repo.id).alertsEnabled, true);
  assert.equal(new Dashboard({ demo: true }).snapshot().repositories.find((row) => row.id === repo.id).alertsEnabled, false);
});
