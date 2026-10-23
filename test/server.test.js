import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createAppServer } from '../src/server.js';

async function fixture(t) {
  const calls = [];
  const dashboard = {
    snapshot: () => ({ repositories: [{ id: '123', fullName: 'example/api' }], demo: true }),
    startScan: async () => calls.push('scan'),
    enableRepository: async id => calls.push(`enable:${id}`)
  };
  const server = createAppServer({ dashboard });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const state = await fetch(`${origin}/api/state`).then(response => response.json());
  return { origin, calls, token: state.csrfToken };
}

test('local API rejects foreign hosts, cross-origin reads, and missing write proof', async t => {
  const { origin, calls, token } = await fixture(t);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    http.get(`${origin}/api/state`, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await fetch(`${origin}/api/state`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  for (const headers of [
    { 'content-type': 'application/json', 'x-sitrep-token': token },
    { Origin: origin, 'content-type': 'application/json' },
    { Origin: origin, 'content-type': 'text/plain', 'x-sitrep-token': token }
  ]) {
    assert.ok([403, 415].includes((await fetch(`${origin}/api/scan`, { method: 'POST', headers, body: '{}' })).status));
  }
  assert.deepEqual(calls, []);
});

test('only a known, explicitly confirmed repository can be enabled', async t => {
  const { origin, calls, token } = await fixture(t);
  const headers = { Origin: origin, 'content-type': 'application/json', 'x-sitrep-token': token };
  assert.equal((await fetch(`${origin}/api/repositories/456/enable`, { method: 'POST', headers, body: JSON.stringify({ confirm: 'example/api' }) })).status, 404);
  assert.equal((await fetch(`${origin}/api/repositories/123/enable`, { method: 'POST', headers, body: JSON.stringify({ confirm: 'example/other' }) })).status, 400);
  assert.deepEqual(calls, []);
  const response = await fetch(`${origin}/api/repositories/123/enable`, { method: 'POST', headers, body: JSON.stringify({ confirm: 'example/api' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['enable:123']);
});

test('scan returns accepted, static assets have security headers, and source files stay private', async t => {
  const { origin, calls, token } = await fixture(t);
  const response = await fetch(`${origin}/api/scan`, { method: 'POST', headers: { Origin: origin, 'content-type': 'application/json', 'x-sitrep-token': token }, body: '{}' });
  assert.equal(response.status, 202);
  assert.deepEqual(calls, ['scan']);
  const health = await fetch(`${origin}/health`);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.match(health.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${origin}/%2e%2e%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${origin}/server.js`)).status, 404);
});
