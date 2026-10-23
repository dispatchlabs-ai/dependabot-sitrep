import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubError } from '../src/github.js';

function reply(body, { status = 200, headers = {}, code = status >= 400 ? 1 : 0 } = {}) {
  const head = Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n');
  return { stdout: `HTTP/2.0 ${status} Status\r\n${head ? `${head}\r\n` : ''}\r\n${body === undefined ? '' : JSON.stringify(body)}`, stderr: '', code };
}

function harness(responses, options = {}) {
  const calls = [];
  const client = new GitHubClient({ ...options, runner: async (args, input) => {
    calls.push({ args, input });
    assert.ok(responses.length, 'Unexpected gh call');
    const result = responses.shift();
    if (result instanceof Error) throw result;
    return result;
  } });
  return { client, calls };
}

function endpoint(call) { return call.args.find((value) => /^(?:user(?:\/|$)|repos\/|graphql$)/.test(value)); }
function method(call) { return call.args[call.args.indexOf('--method') + 1]; }
function repository(index, permissions = { pull: true }) {
  return { id: index, node_id: `R_${index}`, full_name: `acme/repo-${index}`, permissions };
}

test('viewer uses authenticated gh api with an argument array and pinned API headers', async () => {
  const { client, calls } = harness([reply({ login: 'octocat', html_url: 'https://github.com/octocat' })]);
  assert.deepEqual(await client.getViewer(), { login: 'octocat', url: 'https://github.com/octocat' });
  assert.equal(endpoint(calls[0]), 'user');
  assert.equal(method(calls[0]), 'GET');
  assert.ok(calls[0].args.includes('Accept: application/vnd.github+json'));
  assert.ok(calls[0].args.includes('X-GitHub-Api-Version: 2026-03-10'));
  assert.equal(calls[0].args[calls[0].args.indexOf('--hostname') + 1], 'github.com');
  assert.equal(calls[0].input, undefined);
});

test('lists every repository page, reports SSO omissions, and calls back once per page', async () => {
  const first = repository(1);
  const second = repository(2);
  const { client, calls } = harness([
    reply([first], { headers: { Link: '<https://api.github.com/user/repos?page=2&per_page=100>; rel="next"', 'X-GitHub-SSO': 'partial-results; organizations=123', 'X-RateLimit-Remaining': '4500', 'X-RateLimit-Limit': '5000' } }),
    reply([second], { headers: { 'X-RateLimit-Remaining': '99', 'X-RateLimit-Limit': '5000', 'X-RateLimit-Reset': '2000000000' } }),
  ]);
  const pages = [];
  const result = await client.listRepositories((page) => pages.push(page));
  assert.deepEqual(result.repositories, [first, second]);
  assert.deepEqual(pages, [[first], [second]]);
  assert.equal(calls.length, 2);
  assert.match(endpoint(calls[0]), /affiliation=owner,collaborator,organization_member/);
  assert.equal(endpoint(calls[1]), 'user/repos?page=2&per_page=100');
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings.join(' '), /SSO/);
  assert.deepEqual(result.rateLimit, { remaining: 99, limit: 5000, resetAt: '2033-05-18T03:33:20.000Z' });
});

test('alert pagination follows opaque cursor links and normalizes complete alert data', async () => {
  const raw = {
    number: 7, html_url: 'https://github.com/acme/app/security/dependabot/7', created_at: '2026-10-01T00:00:00Z',
    dependency: { package: { name: 'example', ecosystem: 'npm' }, manifest_path: 'package-lock.json' },
    security_vulnerability: { severity: 'critical', vulnerable_version_range: '< 2.0.0', first_patched_version: { identifier: '2.0.0' } },
    security_advisory: { summary: 'Example vulnerability', ghsa_id: 'GHSA-aaaa-bbbb-cccc' },
  };
  const { client, calls } = harness([
    reply([raw], { headers: { Link: '<https://api.github.com/repos/acme/app/dependabot/alerts?state=open&per_page=100&after=Y3Vyc29y%3D>; rel="next", <https://api.github.com/repos/acme/app/dependabot/alerts?before=x>; rel="prev"' } }),
    reply([{ ...raw, number: 8, security_vulnerability: { severity: 'high' } }]),
  ]);
  const alerts = await client.listAlerts('acme/app');
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts[0], {
    number: 7, url: raw.html_url, package: 'example', ecosystem: 'npm', severity: 'critical', summary: 'Example vulnerability',
    manifest: 'package-lock.json', vulnerableRange: '< 2.0.0', patchedVersion: '2.0.0',
    advisoryUrl: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', createdAt: raw.created_at,
  });
  assert.equal(alerts[1].patchedVersion, null);
  assert.equal(endpoint(calls[1]), 'repos/acme/app/dependabot/alerts?state=open&per_page=100&after=Y3Vyc29y%3D');
});

test('numeric canonical alert links paginate through the original owner/repository endpoint', async () => {
  for (const options of [{}, { hostname: 'github.acme.test' }]) {
    const apiRoot = options.hostname ? 'https://github.acme.test/api/v3' : 'https://api.github.com';
    const raw = { number: 1, dependency: { package: { name: 'example' } }, security_advisory: { severity: 'high' } };
    const { client, calls } = harness([
      reply([raw], { headers: { Link: `<${apiRoot}/repositories/1061727318/dependabot/alerts?state=open&per_page=100&after=opaque%3D>; rel="next"` } }),
      reply([{ ...raw, number: 2 }]),
    ], options);
    const alerts = await client.listAlerts('acme/app');
    assert.deepEqual(alerts.map((alert) => alert.number), [1, 2]);
    assert.equal(endpoint(calls[1]), 'repos/acme/app/dependabot/alerts?state=open&per_page=100&after=opaque%3D');
    assert.ok(calls.every((call) => endpoint(call).startsWith('repos/acme/app/dependabot/alerts?')));
  }
});

test('canonical alert pagination exceptions cannot change host or apply to repository inventory', async () => {
  const foreign = harness([reply([], { headers: { Link: '<https://evil.test/repositories/123/dependabot/alerts?after=x>; rel="next"' } })]);
  await assert.rejects(foreign.client.listAlerts('acme/app'), (error) => error.kind === 'protocol');
  assert.equal(foreign.calls.length, 1);
  const inventory = harness([reply([], { headers: { Link: '<https://api.github.com/repositories/123/dependabot/alerts?after=x>; rel="next"' } })]);
  await assert.rejects(inventory.client.listRepositories(), (error) => error.kind === 'protocol');
  assert.equal(inventory.calls.length, 1);
});

test('enablement is read in GraphQL batches and preserves fields unaffected by partial errors', async () => {
  const repos = [repository(1), repository(2, { admin: true }), repository(3), repository(4)];
  const { client, calls } = harness([reply({
    data: { nodes: [
      { id: 'R_1', hasVulnerabilityAlertsEnabled: true, viewerPermission: 'WRITE' },
      { id: 'R_2', hasVulnerabilityAlertsEnabled: false, viewerPermission: 'ADMIN' },
      null,
      { id: 'R_4', hasVulnerabilityAlertsEnabled: true, viewerPermission: null },
    ] },
    errors: [
      { type: 'FORBIDDEN', message: 'private server details', path: ['nodes', 2, 'hasVulnerabilityAlertsEnabled'] },
      { type: 'FORBIDDEN', path: ['nodes', 3, 'viewerPermission'] },
    ],
  }, { code: 1 })]);
  const statuses = await client.getEnablement(repos);
  assert.deepEqual(statuses.get('1'), { enabled: true, permission: 'WRITE', error: null });
  assert.deepEqual(statuses.get('2'), { enabled: false, permission: 'ADMIN', error: null });
  assert.equal(statuses.get('3').enabled, null);
  assert.match(statuses.get('3').error, /not make Dependabot settings available/);
  assert.equal(statuses.get('4').enabled, true);
  assert.equal(statuses.get('4').permission, 'READ');
  assert.ok(statuses.get('4').error);
  assert.equal(method(calls[0]), 'POST');
  assert.equal(endpoint(calls[0]), 'graphql');
  assert.ok(calls[0].args.includes('--input'));
  assert.deepEqual(JSON.parse(calls[0].input).variables.ids, ['R_1', 'R_2', 'R_3', 'R_4']);
  assert.doesNotMatch(JSON.stringify([...statuses]), /private server details/);
});

test('GraphQL enabled-field errors cannot turn into disabled, even with a returned false value', async () => {
  const { client } = harness([reply({ data: { nodes: [{ id: 'R_1', hasVulnerabilityAlertsEnabled: false, viewerPermission: 'ADMIN' }] }, errors: [{ path: ['nodes', 0, 'hasVulnerabilityAlertsEnabled'], type: 'FORBIDDEN' }] })]);
  assert.equal((await client.getEnablement([repository(1)])).get('1').enabled, null);
});

test('GraphQL missing data and top-level errors stay unknown without leaking error text', async () => {
  const { client } = harness([reply({ errors: [{ message: 'secret-token' }] }, { code: 1 })]);
  const status = (await client.getEnablement([repository(1)])).get('1');
  assert.equal(status.enabled, null);
  assert.doesNotMatch(status.error, /secret-token/);
});

test('GraphQL splits at forty node IDs and handles missing IDs without dropping repositories', async () => {
  const repos = Array.from({ length: 41 }, (_, index) => repository(index + 1));
  repos.push({ id: 42, full_name: 'acme/missing-node' });
  const { client, calls } = harness([
    reply({ data: { nodes: repos.slice(0, 40).map((repo) => ({ id: repo.node_id, hasVulnerabilityAlertsEnabled: false, viewerPermission: 'READ' })) } }),
    reply({ data: { nodes: [{ id: 'R_41', hasVulnerabilityAlertsEnabled: true, viewerPermission: 'ADMIN' }] } }),
  ]);
  const statuses = await client.getEnablement(repos);
  assert.equal(statuses.size, 42);
  assert.equal(JSON.parse(calls[0].input).variables.ids.length, 40);
  assert.equal(JSON.parse(calls[1].input).variables.ids.length, 1);
  assert.equal(statuses.get('41').enabled, true);
  assert.equal(statuses.get('42').enabled, null);
});

test('HTTP forbidden enablement returns an unknown status, not disabled', async () => {
  const { client } = harness([reply({ message: 'denied' }, { status: 403 })]);
  const status = (await client.getEnablement([repository(1)])).get('1');
  assert.equal(status.enabled, null);
  assert.match(status.error, /denied access/);
});

test('enabling only performs the exact vulnerability-alerts PUT and accepts 204', async () => {
  const { client, calls } = harness([reply(undefined, { status: 204 })]);
  assert.deepEqual(await client.enableAlerts('acme/app'), { enabled: true });
  assert.equal(method(calls[0]), 'PUT');
  assert.equal(endpoint(calls[0]), 'repos/acme/app/vulnerability-alerts');
  assert.equal(calls[0].input, undefined);
  assert.equal(calls.length, 1);
});

test('an unexpected success status does not falsely confirm enablement', async () => {
  const { client } = harness([reply({})]);
  await assert.rejects(client.enableAlerts('acme/app'), (error) => error.kind === 'protocol');
});

test('fresh repository reads preserve permissions for server-side admin checks', async () => {
  const raw = repository(1, { admin: true, push: true, pull: true });
  const { client, calls } = harness([reply(raw)]);
  assert.deepEqual(await client.getRepository('acme/repo-1'), raw);
  assert.equal(method(calls[0]), 'GET');
});

test('forbidden and not-found alerts throw separate errors instead of returning zero counts', async () => {
  for (const status of [403, 404]) {
    const { client } = harness([reply({ message: 'sensitive internals' }, { status })]);
    await assert.rejects(client.listAlerts('acme/app'), (error) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, status);
      assert.equal(error.kind, status === 403 ? 'restricted' : 'not_found');
      assert.doesNotMatch(error.message, /sensitive internals/);
      return true;
    });
  }
});

test('rate-limit errors use reset/retry headers and halt GraphQL scans', async () => {
  const { client } = harness([reply({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '2000000000' } })]);
  await assert.rejects(client.listRepositories(), (error) => error.kind === 'rate_limit' && error.retryAt === '2033-05-18T03:33:20.000Z');
  const graph = harness([reply({ data: { nodes: [] }, errors: [{ type: 'RATE_LIMITED' }] })]);
  await assert.rejects(graph.client.getEnablement([repository(1)]), (error) => error.kind === 'rate_limit');
  const throttled = harness([reply({}, { status: 429, headers: { 'Retry-After': '120' } })]);
  const before = Date.now();
  await assert.rejects(throttled.client.getViewer(), (error) => error.kind === 'rate_limit' && Date.parse(error.retryAt) >= before + 120_000);
});

test('secondary rate limits do not wait for the unrelated hourly reset when requests remain', async () => {
  const { client } = harness([reply({ message: 'You have exceeded a secondary rate limit.' }, {
    status: 403,
    headers: { 'X-RateLimit-Remaining': '4200', 'X-RateLimit-Reset': '2000000000' },
  })]);
  const before = Date.now();
  await assert.rejects(client.getViewer(), (error) => {
    assert.equal(error.kind, 'rate_limit');
    assert.ok(Date.parse(error.retryAt) >= before + 60_000);
    assert.ok(Date.parse(error.retryAt) <= Date.now() + 60_000);
    return true;
  });
});

test('missing gh and unauthenticated gh get friendly errors without raw stderr', async () => {
  const missing = harness([Object.assign(new Error('private path'), { code: 'ENOENT' })]);
  await assert.rejects(missing.client.getViewer(), (error) => error.kind === 'cli_missing' && !error.message.includes('private path'));
  const loggedOut = harness([{ stdout: '', stderr: 'gh auth login secret-token-value', code: 4 }]);
  await assert.rejects(loggedOut.client.getViewer(), (error) => error.kind === 'auth' && !error.message.includes('secret-token-value'));
  const expired = harness([reply({ message: 'Bad credentials' }, { status: 401 })]);
  await assert.rejects(expired.client.getViewer(), (error) => error.kind === 'auth');
});

test('unsafe repository names and hostnames are rejected before spawning gh', async () => {
  const { client, calls } = harness([]);
  for (const name of ['--help', 'acme/app;whoami', 'acme/$(whoami)', 'acme/../../user', 'acme/..', 'acme/app?evil=1', 'acme/app\n--hostname evil.test']) {
    await assert.rejects(client.listAlerts(name), (error) => error.kind === 'validation');
    await assert.rejects(client.enableAlerts(name), (error) => error.kind === 'validation');
    await assert.rejects(client.getRepository(name), (error) => error.kind === 'validation');
  }
  assert.equal(calls.length, 0);
  for (const hostname of ['https://github.com', '--help', 'github.com/path', 'github.com\n--method PUT', 'a..b', 'github.com:443']) {
    assert.throws(() => new GitHubClient({ hostname }), (error) => error.kind === 'validation');
  }
});

test('pagination cannot change host, protocol, repository, or endpoint', async () => {
  for (const link of [
    'https://evil.test/user/repos?page=2', 'http://api.github.com/user/repos?page=2',
    'https://api.github.com/repos/acme/app/vulnerability-alerts', 'https://user:password@api.github.com/user/repos?page=2',
  ]) {
    const { client, calls } = harness([reply([], { headers: { Link: `<${link}>; rel="next"` } })]);
    await assert.rejects(client.listRepositories(), (error) => error.kind === 'protocol');
    assert.equal(calls.length, 1);
  }
  const { client } = harness([reply([], { headers: { Link: '<https://api.github.com/repos/acme/other/dependabot/alerts?after=x>; rel="next"' } })]);
  await assert.rejects(client.listAlerts('acme/app'), (error) => error.kind === 'protocol');
});

test('enterprise pagination accepts only that host API prefix', async () => {
  const { client, calls } = harness([
    reply([], { headers: { Link: '<https://github.acme.test/api/v3/user/repos?page=2>; rel="next"' } }), reply([]),
  ], { hostname: 'github.acme.test' });
  await client.listRepositories();
  assert.equal(endpoint(calls[1]), 'user/repos?page=2');
  const cloud = harness([
    reply([], { headers: { Link: '<https://api.acme.ghe.com/user/repos?page=2>; rel="next"' } }), reply([]),
  ], { hostname: 'acme.ghe.com' });
  await cloud.client.listRepositories();
  assert.equal(cloud.calls.length, 2);
});

test('repeated pagination links are rejected instead of looping', async () => {
  const link = '<https://api.github.com/user/repos?page=2>; rel="next"';
  const { client, calls } = harness([reply([], { headers: { Link: link } }), reply([], { headers: { Link: link } })]);
  await assert.rejects(client.listRepositories(), (error) => error.kind === 'protocol');
  assert.equal(calls.length, 2);
});

test('empty enablement requires no gh requests and malformed API payloads fail explicitly', async () => {
  const { client, calls } = harness([]);
  assert.equal((await client.getEnablement([])).size, 0);
  assert.equal(calls.length, 0);
  const malformed = harness([reply({ repositories: [] })]);
  await assert.rejects(malformed.client.listRepositories(), (error) => error.kind === 'protocol');
});
