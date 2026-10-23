import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

async function jsonBody(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16384) throw problem(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw problem(400, 'Send valid JSON.'); }
}

export function createAppServer({ dashboard, staticDirectory = publicDirectory } = {}) {
  const token = randomBytes(32).toString('base64url');
  const root = resolve(staticDirectory);
  const server = http.createServer(async (request, response) => {
    const address = server.address();
    const port = typeof address === 'object' ? address?.port : null;
    const validHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const host = request.headers.host;
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (!validHosts.has(host)) throw problem(403, 'This dashboard is available only through its local address.');
      const origin = `http://${host}`;
      if (request.headers.origin && request.headers.origin !== origin) throw problem(403, 'Cross-origin requests are not allowed.');
      const url = new URL(request.url, origin);
      const path = url.pathname;
      if (path.startsWith('/api/')) {
        if (request.method === 'GET' && path === '/api/state') return send(200, { ...dashboard.snapshot(), csrfToken: token });
        if (request.method !== 'POST') throw problem(405, 'Method not allowed.');
        if (request.headers.origin !== origin) throw problem(403, 'A same-origin request is required.');
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw problem(415, 'Send application/json.');
        const received = Buffer.from(String(request.headers['x-sitrep-token'] || ''));
        const expected = Buffer.from(token);
        if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw problem(403, 'Refresh the page before trying again.');
        const body = await jsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem(400, 'Send a JSON object.');
        if (path === '/api/scan') {
          await dashboard.startScan();
          return send(202, dashboard.snapshot());
        }
        const match = path.match(/^\/api\/repositories\/([a-zA-Z0-9_-]+)\/enable$/);
        if (match) {
          const repository = dashboard.snapshot().repositories.find(repo => String(repo.id) === match[1]);
          if (!repository) throw problem(404, 'Repository is not part of this scan.');
          if (body.confirm !== repository.fullName) throw problem(400, 'Confirm the exact repository before enabling alerts.');
          await dashboard.enableRepository(match[1]);
          return send(200, dashboard.snapshot());
        }
        throw problem(404, 'Unknown API route.');
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw problem(405, 'Method not allowed.');
      if (path === '/health') return send(200, { status: 'ok' });
      const relative = decodeURIComponent(path === '/' ? '/index.html' : path);
      if (relative.split('/').some(part => part.startsWith('.')) || relative.includes('\\') || relative.includes('\0')) throw problem(404, 'File not found.');
      const filename = resolve(root, `.${relative}`);
      if (!filename.startsWith(`${root}${sep}`) || !mimeTypes[extname(filename)]) throw problem(404, 'File not found.');
      let content;
      try { content = await readFile(filename); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'EISDIR') throw problem(404, 'File not found.'); throw error; }
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(filename)] });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      send(status, { error: status === 500 ? 'The local server could not complete the request.' : error.message, kind: error.kind || null, retryAt: error.retryAt || null });
    }
  });
  return server;
}
