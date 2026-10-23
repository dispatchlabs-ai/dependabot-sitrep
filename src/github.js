import { execFile } from 'node:child_process';

const API_VERSION = '2026-03-10';
const ENABLEMENT_QUERY = `query RepositoryEnablement($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Repository { id hasVulnerabilityAlertsEnabled viewerPermission }
  }
}`;

export class GitHubError extends Error {
  constructor(message, { status = null, kind = 'github', retryAt = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.kind = kind;
    this.retryAt = retryAt;
  }
}

function runGh(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, {
      shell: false,
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ stdout, stderr, code: error?.code ?? 0 });
    });
    // gh --input - must see EOF; non-interactive calls must never wait on stdin.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

function repositoryPath(fullName) {
  if (typeof fullName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/.test(fullName)) {
    throw new GitHubError('Choose a valid owner/repository.', { status: 400, kind: 'validation' });
  }
  return `repos/${fullName}`;
}

function parseResponse(stdout) {
  let remaining = String(stdout ?? '');
  let response;
  // Normally gh prints one response. Also accept interim/redirect header blocks.
  while (/^HTTP\//.test(remaining)) {
    const match = remaining.match(/^HTTP\/[\d.]+\s+(\d{3})[^\r\n]*\r?\n/);
    const boundary = remaining.search(/\r?\n\r?\n/);
    if (!match || boundary < 0) break;
    const head = remaining.slice(0, boundary);
    const headers = {};
    for (const line of head.split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(':');
      if (colon < 1) continue;
      const key = line.slice(0, colon).toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
    }
    remaining = remaining.slice(boundary).replace(/^\r?\n\r?\n/, '');
    response = { status: Number(match[1]), headers, body: null };
  }
  if (!response) {
    throw new GitHubError('GitHub CLI returned an unreadable API response.', { kind: 'protocol' });
  }
  if (remaining.trim()) {
    try { response.body = JSON.parse(remaining); }
    catch {
      if (response.status < 400) {
        throw new GitHubError('GitHub CLI returned an unreadable API response.', { kind: 'protocol' });
      }
    }
  }
  return response;
}

function retryTime(headers) {
  const after = headers['retry-after'];
  if (after && /^\d+(?:\.\d+)?$/.test(after)) return new Date(Date.now() + Number(after) * 1000).toISOString();
  if (after && Number.isFinite(Date.parse(after))) return new Date(after).toISOString();
  const reset = Number(headers['x-ratelimit-reset']);
  if (headers['x-ratelimit-remaining'] === '0' && reset > 0 && Number.isFinite(reset)) return new Date(reset * 1000).toISOString();
  return new Date(Date.now() + 60_000).toISOString();
}

function permissionFor(repository) {
  const permissions = repository.permissions ?? {};
  return ['admin', 'maintain', 'push', 'triage', 'pull'].map((key, index) =>
    permissions[key] ? ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'][index] : null).find(Boolean) ?? 'UNKNOWN';
}

function fieldError(errors, index, field) {
  return errors.some((error) => !Array.isArray(error?.path)
    || (error.path[0] === 'nodes' && (error.path.length === 1
      || (error.path[1] === index && (error.path.length === 2 || error.path[2] === field)))));
}

export class GitHubClient {
  constructor({ hostname = 'github.com', runner = runGh } = {}) {
    if (typeof hostname !== 'string' || hostname.length > 253
      || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(hostname)) {
      throw new GitHubError('Use a GitHub hostname without a URL or path.', { status: 400, kind: 'validation' });
    }
    this.hostname = hostname.toLowerCase();
    this.runner = runner;
    this.rateLimit = null;
    const apiHost = this.hostname === 'github.com' ? 'api.github.com'
      : this.hostname.endsWith('.ghe.com') ? `api.${this.hostname}` : this.hostname;
    this.apiOrigin = `https://${apiHost}`;
    this.apiPrefix = this.hostname === 'github.com' || this.hostname.endsWith('.ghe.com') ? '' : '/api/v3';
  }

  async #request(endpoint, { method = 'GET', input } = {}) {
    const args = ['api', '--hostname', this.hostname, '--include', '--method', method,
      '--header', 'Accept: application/vnd.github+json', '--header', `X-GitHub-Api-Version: ${API_VERSION}`, endpoint];
    if (input !== undefined) args.push('--input', '-');
    let result;
    try { result = await this.runner(args, input === undefined ? undefined : JSON.stringify(input)); }
    catch (error) {
      if (error?.code === 'ENOENT') throw new GitHubError('GitHub CLI is not installed or is not on PATH. Install gh, then run gh auth login.', { kind: 'cli_missing' });
      if (error?.killed || error?.code === 'ETIMEDOUT') throw new GitHubError('GitHub CLI timed out. Try refreshing again.', { kind: 'timeout' });
      throw new GitHubError('GitHub CLI could not complete the request. Check your connection and gh auth status.', { kind: 'connection' });
    }
    let response;
    try { response = parseResponse(result.stdout); }
    catch (error) {
      if (result.code === 4 || /(?:gh auth login|not logged into|authentication required)/i.test(result.stderr ?? '')) {
        throw new GitHubError('Sign in with gh auth login, then refresh the dashboard.', { status: 401, kind: 'auth' });
      }
      if (result.code) throw new GitHubError('GitHub CLI could not complete the request. Check your connection and gh auth status.', { kind: 'connection' });
      throw error;
    }
    const { status, headers, body } = response;
    if (headers['x-ratelimit-remaining'] !== undefined) {
      this.rateLimit = {
        remaining: Number(headers['x-ratelimit-remaining']),
        limit: Number(headers['x-ratelimit-limit']) || null,
        resetAt: Number(headers['x-ratelimit-reset']) > 0 ? new Date(Number(headers['x-ratelimit-reset']) * 1000).toISOString() : null,
      };
    }
    if (status === 429 || ((status === 403 || status >= 400) &&
      (headers['x-ratelimit-remaining'] === '0' || headers['retry-after'] || /rate limit|abuse detection/i.test(body?.message ?? '')))
      || (Array.isArray(body?.errors) && body.errors.some((error) => error?.type === 'RATE_LIMITED'))) {
      throw new GitHubError('GitHub API rate limit reached. Refresh after the limit resets.', {
        status, kind: 'rate_limit', retryAt: retryTime(headers),
      });
    }
    if (status === 401) throw new GitHubError('Your GitHub session needs attention. Run gh auth status or gh auth login, then refresh.', { status, kind: 'auth' });
    if (status === 403) throw new GitHubError('GitHub denied access. Check repository permissions, token scopes, and organization SSO authorization.', { status, kind: 'restricted' });
    if (status === 404) throw new GitHubError('GitHub could not return this resource. It may be inaccessible to your active gh credentials.', { status, kind: 'not_found' });
    if (status >= 400) throw new GitHubError(status >= 500 ? 'GitHub is temporarily unavailable. Try refreshing again.' : 'GitHub could not accept this request.', { status, kind: status >= 500 ? 'unavailable' : 'github' });
    // gh exits nonzero for GraphQL field errors even when HTTP 200 includes usable data.
    if (result.code && !(endpoint === 'graphql' && Array.isArray(body?.errors) && body.errors.length)) {
      throw new GitHubError('GitHub CLI did not complete the request.', { kind: 'connection' });
    }
    return response;
  }

  #nextPage(link, resource) {
    if (!link) return null;
    const matches = [...link.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)];
    const next = matches.find((match) => match[2].split(/\s+/).includes('next'))?.[1];
    if (!next) return null;
    let url;
    try { url = new URL(next, `${this.apiOrigin}${this.apiPrefix}/`); }
    catch { throw new GitHubError('GitHub returned an invalid pagination link.', { kind: 'protocol' }); }
    // GitHub uses numeric repository URLs in Dependabot cursor links. Keep the
    // caller's owner/repo endpoint and copy only the pagination query string.
    const canonicalAlertPath = /^repos\/[^/]+\/[^/]+\/dependabot\/alerts$/.test(resource)
      && url.pathname.startsWith(`${this.apiPrefix}/`)
      && /^\/repositories\/\d+\/dependabot\/alerts$/.test(url.pathname.slice(this.apiPrefix.length));
    if (url.origin !== this.apiOrigin || url.username || url.password || url.hash
      || (url.pathname !== `${this.apiPrefix}/${resource}` && !canonicalAlertPath)) {
      throw new GitHubError('GitHub returned an unexpected pagination link.', { kind: 'protocol' });
    }
    return `${resource}${url.search}`;
  }

  async getViewer() {
    const { body } = await this.#request('user');
    if (typeof body?.login !== 'string') throw new GitHubError('GitHub returned an incomplete account response.', { kind: 'protocol' });
    return { login: body.login, url: body.html_url };
  }

  async listRepositories(onPage) {
    const repositories = [];
    const warnings = new Set();
    const visited = new Set();
    let endpoint = 'user/repos?affiliation=owner,collaborator,organization_member&visibility=all&per_page=100&sort=full_name';
    while (endpoint) {
      if (visited.has(endpoint)) throw new GitHubError('GitHub repeated a pagination link. Refresh to retry the scan.', { kind: 'protocol' });
      visited.add(endpoint);
      const { body, headers } = await this.#request(endpoint);
      if (!Array.isArray(body)) throw new GitHubError('GitHub returned an unreadable repository list.', { kind: 'protocol' });
      repositories.push(...body);
      if (/partial-results/i.test(headers['x-github-sso'] ?? '')) warnings.add('Some organization repositories were omitted because SSO authorization is required.');
      if (onPage) await onPage(body);
      endpoint = this.#nextPage(headers.link, 'user/repos');
    }
    if (this.rateLimit?.remaining < 100) warnings.add('GitHub API rate limit is low. Further scans may need to wait for the limit to reset.');
    return { repositories, warnings: [...warnings], rateLimit: this.rateLimit };
  }

  async getEnablement(repositories) {
    const result = new Map(repositories.map((repository) => [String(repository.id), {
      enabled: null, permission: permissionFor(repository), error: 'GitHub did not return a repository node ID.',
    }]));
    const withNodeIds = repositories.filter((repository) => typeof repository.node_id === 'string' && repository.node_id);
    for (let offset = 0; offset < withNodeIds.length; offset += 40) {
      const batch = withNodeIds.slice(offset, offset + 40);
      let body;
      try {
        ({ body } = await this.#request('graphql', { method: 'POST', input: { query: ENABLEMENT_QUERY, variables: { ids: batch.map((repository) => repository.node_id) } } }));
      } catch (error) {
        if (['rate_limit', 'auth', 'cli_missing'].includes(error.kind)) throw error;
        for (const repository of batch) result.set(String(repository.id), { enabled: null, permission: permissionFor(repository), error: error.message });
        continue;
      }
      const nodes = Array.isArray(body?.data?.nodes) ? body.data.nodes : [];
      const errors = Array.isArray(body?.errors) ? body.errors : [];
      batch.forEach((repository, index) => {
        const node = nodes[index];
        const validNode = node?.id === repository.node_id;
        const enabledError = fieldError(errors, index, 'hasVulnerabilityAlertsEnabled');
        const permissionError = fieldError(errors, index, 'viewerPermission');
        const enabled = validNode && !enabledError && typeof node.hasVulnerabilityAlertsEnabled === 'boolean' ? node.hasVulnerabilityAlertsEnabled : null;
        const permission = validNode && !permissionError && ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'].includes(node.viewerPermission) ? node.viewerPermission : permissionFor(repository);
        result.set(String(repository.id), {
          enabled,
          permission,
          error: enabled === null ? 'GitHub did not make Dependabot settings available to your active credentials.'
            : permissionError ? 'GitHub did not make your repository permission available.' : null,
        });
      });
    }
    return result;
  }

  async listAlerts(fullName) {
    const resource = `${repositoryPath(fullName)}/dependabot/alerts`;
    let endpoint = `${resource}?state=open&per_page=100`;
    const alerts = [];
    const visited = new Set();
    while (endpoint) {
      if (visited.has(endpoint)) throw new GitHubError('GitHub repeated an alert pagination link. Refresh to retry.', { kind: 'protocol' });
      visited.add(endpoint);
      const { body, headers } = await this.#request(endpoint);
      if (!Array.isArray(body)) throw new GitHubError('GitHub returned an unreadable alert list.', { kind: 'protocol' });
      for (const alert of body) {
        if (!alert || typeof alert !== 'object') throw new GitHubError('GitHub returned an incomplete alert.', { kind: 'protocol' });
        alerts.push({
          number: alert.number,
          url: alert.html_url,
          package: alert.dependency?.package?.name ?? 'Unknown package',
          ecosystem: alert.dependency?.package?.ecosystem ?? 'unknown',
          severity: alert.security_vulnerability?.severity ?? alert.security_advisory?.severity ?? 'unknown',
          summary: alert.security_advisory?.summary ?? 'Dependabot alert',
          manifest: alert.dependency?.manifest_path ?? '',
          vulnerableRange: alert.security_vulnerability?.vulnerable_version_range ?? '',
          patchedVersion: alert.security_vulnerability?.first_patched_version?.identifier ?? null,
          advisoryUrl: alert.security_advisory?.html_url ?? (alert.security_advisory?.ghsa_id ? `https://github.com/advisories/${encodeURIComponent(alert.security_advisory.ghsa_id)}` : null),
          createdAt: alert.created_at ?? null,
        });
      }
      endpoint = this.#nextPage(headers.link, resource);
    }
    return alerts;
  }

  async getRepository(fullName) {
    const { body } = await this.#request(repositoryPath(fullName));
    if (!body || typeof body.full_name !== 'string' || !body.permissions) throw new GitHubError('GitHub returned incomplete repository permissions.', { kind: 'protocol' });
    return body;
  }

  async enableAlerts(fullName) {
    const { status } = await this.#request(`${repositoryPath(fullName)}/vulnerability-alerts`, { method: 'PUT' });
    if (status !== 204) throw new GitHubError('GitHub did not confirm that Dependabot alerts were enabled.', { status, kind: 'protocol' });
    return { enabled: true };
  }
}
