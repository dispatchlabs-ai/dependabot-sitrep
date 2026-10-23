#!/usr/bin/env node
import { GitHubClient } from './src/github.js';
import { Dashboard } from './src/dashboard.js';
import { createAppServer } from './src/server.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Dependabot Sitrep\n\n  npm start                         Use your active gh login\n  npm run demo                      Explore fictional sample data\n  npm start -- --port 4318           Choose a local port\n  npm start -- --hostname github.com Choose a GitHub host\n\nRequires Node.js 22+ and an authenticated GitHub CLI (gh auth login).');
  process.exit(0);
}

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

try {
  const known = new Set(['--demo', '--port', '--hostname']);
  for (let index = 0; index < args.length; index++) {
    if (!known.has(args[index])) throw new Error(`Unknown option: ${args[index]}`);
    if (args[index] !== '--demo') index++;
  }
  const port = Number(option('--port', process.env.PORT || '4317'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
  const hostname = option('--hostname', process.env.GH_HOST || 'github.com');
  if (!/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(hostname)) throw new Error('Use a GitHub hostname, such as github.com.');
  const demo = args.includes('--demo');
  const dashboard = new Dashboard({ client: new GitHubClient({ hostname }), demo });
  const server = createAppServer({ dashboard });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Try npm start -- --port ${port + 1}.` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`\n  Dependabot Sitrep${demo ? ' · SAMPLE DATA' : ''}\n  http://127.0.0.1:${port}\n\n  ${demo ? 'Demo actions never change GitHub.' : `Using gh credentials for ${hostname}. Open the dashboard to scan.`}\n  Press Ctrl+C to stop.\n`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
  await dashboard.initialize();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
