import { createDemoSnapshot } from './demo.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const severities = ['critical', 'high', 'medium', 'low'];
const alertFields = ['number', 'url', 'package', 'ecosystem', 'severity', 'summary', 'manifest', 'vulnerableRange', 'patchedVersion', 'advisoryUrl', 'createdAt'];

function failure(message, kind = 'validation', status = 400) {
  return Object.assign(new Error(message), { kind, status });
}

function message(error) {
  return String(error?.message || error || 'GitHub request failed.')
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

function permission(raw) {
  if (raw.permissions?.admin) return 'ADMIN';
  if (raw.permissions?.maintain) return 'MAINTAIN';
  if (raw.permissions?.push) return 'WRITE';
  if (raw.permissions?.triage) return 'TRIAGE';
  if (raw.permissions?.pull) return 'READ';
  return 'UNKNOWN';
}

function safeUrl(value, host, fallback = null) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === host && !url.username && !url.password && !url.port) return url.href;
  } catch {}
  return fallback;
}

function normalize(raw, host) {
  const fullName = raw.full_name || raw.nameWithOwner || '';
  const owner = raw.owner?.login || fullName.split('/')[0] || '';
  const name = raw.name || fullName.split('/')[1] || '';
  return {
    id: String(raw.id), owner,
    ownerType: ['Organization', 'User'].includes(raw.owner?.type) ? raw.owner.type : 'Unknown',
    name, fullName,
    url: safeUrl(raw.html_url || raw.url, host, `https://${host}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`),
    language: typeof raw.language === 'string' ? raw.language : null,
    private: Boolean(raw.private), archived: Boolean(raw.archived),
    permission: permission(raw), alertsEnabled: null, scanState: 'queued',
    counts: null, alerts: [], canEnable: false, checkedAt: null, error: null,
  };
}

function applyMetadata(row, metadata) {
  if (metadata) {
    row.alertsEnabled = typeof metadata.enabled === 'boolean' ? metadata.enabled : null;
    if (metadata.permission) row.permission = metadata.permission;
    if (metadata.error) row.error = message(metadata.error);
  }
  row.canEnable = row.alertsEnabled === false && row.permission === 'ADMIN' && !row.archived;
}

function applyAlerts(row, alerts, host) {
  row.alerts = alerts.map((alert) => {
    const result = Object.fromEntries(alertFields.map((key) => [key, alert[key] ?? null]));
    result.url = safeUrl(result.url, host);
    result.advisoryUrl = safeUrl(result.advisoryUrl, 'github.com');
    return result;
  });
  row.counts = Object.fromEntries(['total', ...severities].map((key) => [key, 0]));
  row.counts.total = row.alerts.length;
  for (const alert of row.alerts) {
    if (severities.includes(alert.severity)) row.counts[alert.severity]++;
  }
  if (row.alerts.length > 0) row.alertsEnabled = true;
  row.scanState = 'complete';
  row.error = null;
  row.canEnable = row.alertsEnabled === false && row.permission === 'ADMIN' && !row.archived;
}

export class Dashboard {
  constructor({ client, demo = false, clock = () => Date.now() } = {}) {
    if (!client && !demo) throw new TypeError('A GitHub client is required.');
    this.client = client;
    this.clock = clock;
    this.demo = demo;
    this.scanPromise = null;
    this.enableInFlight = false;
    this.state = demo ? createDemoSnapshot(clock) : {
      session: { login: null, host: client.hostname || 'github.com', connected: false },
      scan: { status: 'idle', phase: 'idle', startedAt: null, completedAt: null, total: 0, processed: 0, error: null, retryAt: null },
      repositories: [], warnings: [], demo: false,
    };
  }

  snapshot() {
    const state = clone(this.state);
    if (state.scan.status === 'running') {
      for (const row of state.repositories) row.canEnable = false;
    }
    return state;
  }
  now() { return new Date(this.clock()).toISOString(); }
  metadata(map, id) { return map instanceof Map ? map.get(String(id)) : map?.[String(id)]; }

  async readViewer() {
    const viewer = await this.client.getViewer();
    if (!viewer?.login) throw failure('GitHub CLI is not authenticated. Run gh auth login and try again.', 'auth', 401);
    return { login: viewer.login, host: this.client.hostname || 'github.com', connected: true };
  }

  setViewer(viewer) {
    const changed = this.state.session.login !== viewer.login || this.state.session.host !== viewer.host;
    if (changed) this.state.repositories = [];
    this.state.session = viewer;
    return changed;
  }

  async initialize() {
    if (this.demo) return this.snapshot();
    try {
      this.setViewer(await this.readViewer());
      this.state.scan.error = null;
      if (this.state.scan.phase === 'authentication' && this.state.scan.status === 'error') {
        this.state.scan.status = 'idle';
        this.state.scan.phase = 'idle';
      }
    } catch (error) {
      this.state.session.connected = false;
      this.state.repositories = [];
      this.state.scan.status = 'error';
      this.state.scan.phase = 'authentication';
      this.state.scan.error = message(error);
    }
    return this.snapshot();
  }

  async startScan() {
    if (this.scanPromise || this.enableInFlight) throw failure('Another operation is still running.', 'busy', 409);
    if (this.state.scan.status === 'paused' && Date.parse(this.state.scan.retryAt) > this.clock()) {
      throw Object.assign(failure('GitHub rate limit is still active. Wait until the displayed retry time.', 'rate_limit', 429), { retryAt: this.state.scan.retryAt });
    }
    this.state.scan = { status: 'running', phase: 'authentication', startedAt: this.now(), completedAt: null, total: 0, processed: 0, error: null, retryAt: null };
    this.state.warnings = [];
    this.scanPromise = Promise.resolve().then(() => this.demo ? this.runDemoScan() : this.runScan())
      .catch((error) => this.scanFailed(error))
      .finally(() => { this.scanPromise = null; });
    return this.snapshot();
  }

  async waitForScan() {
    await this.scanPromise;
    return this.snapshot();
  }

  scanFailed(error) {
    this.state.scan.status = error?.kind === 'rate_limit' ? 'paused' : 'error';
    this.state.scan.error = message(error);
    if (['auth', 'cli_missing'].includes(error?.kind)) {
      if (error.status !== 409) this.state.session.connected = false;
      this.state.repositories = [];
    }
    if (error?.kind === 'rate_limit') {
      const retry = new Date(error.retryAt || this.clock() + 60_000);
      this.state.scan.retryAt = Number.isFinite(retry.getTime()) ? retry.toISOString() : new Date(this.clock() + 60_000).toISOString();
    }
    this.state.scan.completedAt = this.now();
  }

  async runScan() {
    const identity = await this.readViewer();
    this.setViewer(identity);
    this.state.scan.phase = 'repositories';
    const { repositories, warnings = [] } = await this.client.listRepositories();
    this.state.warnings = warnings.map(message);
    // Do not expose raw GitHub responses, which can contain temporary tokens.
    this.state.repositories = repositories.map((raw) => normalize(raw, this.state.session.host));
    this.state.scan.total = repositories.length;
    this.state.scan.phase = 'enablement';
    for (let offset = 0; offset < repositories.length; offset += 40) {
      const batch = repositories.slice(offset, offset + 40);
      let metadata;
      try {
        metadata = await this.client.getEnablement(batch);
      } catch (error) {
        if (['rate_limit', 'auth'].includes(error?.kind)) throw error;
        this.state.warnings.push(`Some repository settings could not be checked: ${message(error)}`);
        metadata = new Map(batch.map((raw) => [String(raw.id), { enabled: null, error: message(error) }]));
      }
      for (let index = 0; index < batch.length; index++) {
        applyMetadata(this.state.repositories[offset + index], this.metadata(metadata, batch[index].id));
      }
    }
    this.state.scan.phase = 'alerts';
    for (const row of this.state.repositories) {
      if (row.alertsEnabled === false) {
        row.scanState = 'disabled';
        row.checkedAt = this.now();
      } else {
        row.scanState = 'scanning';
        try {
          applyAlerts(row, await this.client.listAlerts(row.fullName), this.state.session.host);
        } catch (error) {
          if (['auth', 'cli_missing'].includes(error?.kind)) throw error;
          if (error?.kind === 'rate_limit') {
            row.scanState = 'queued';
            throw error;
          }
          row.scanState = ['permission', 'restricted', 'not_found'].includes(error?.kind) ? 'unavailable' : 'error';
          row.error = message(error);
          row.counts = null;
          row.alerts = [];
        }
        row.checkedAt = this.now();
      }
      this.state.scan.processed++;
    }
    const currentIdentity = await this.readViewer();
    if (currentIdentity.login !== identity.login || currentIdentity.host !== identity.host) {
      this.setViewer(currentIdentity);
      this.state.scan.total = 0;
      this.state.scan.processed = 0;
      throw failure('The GitHub CLI account changed during the scan. Scan again to load the current account.', 'auth', 409);
    }
    this.state.scan.status = 'complete';
    this.state.scan.phase = 'complete';
    this.state.scan.completedAt = this.now();
  }

  async enableRepository(id) {
    if (this.scanPromise || this.enableInFlight) throw failure('Another operation is still running.', 'busy', 409);
    const row = this.state.repositories.find((repo) => repo.id === String(id));
    if (!row) throw failure('Repository was not found in the current scan.', 'validation', 404);
    if (!this.state.session.connected) throw failure('Connect GitHub CLI before changing repository settings.', 'auth', 401);
    this.enableInFlight = true;
    try {
      if (this.demo) {
        if (!row.canEnable) throw failure('This repository cannot be enabled from this dashboard.', 'permission', 403);
        await new Promise((resolve) => setTimeout(resolve, 150));
        row.alertsEnabled = true;
        applyAlerts(row, [], this.state.session.host);
        row.checkedAt = this.now();
        return this.snapshot();
      }
      const viewer = await this.readViewer();
      if (viewer.login !== this.state.session.login || viewer.host !== this.state.session.host) {
        this.setViewer(viewer);
        this.state.scan = { status: 'idle', phase: 'idle', startedAt: null, completedAt: null, total: 0, processed: 0, error: null, retryAt: null };
        throw failure('The GitHub CLI account changed. Scan repositories again before enabling alerts.', 'auth', 409);
      }
      const raw = await this.client.getRepository(row.fullName);
      if (String(raw.id) !== row.id) throw failure('This repository changed since the scan. Refresh repositories first.', 'validation', 409);
      const metadata = this.metadata(await this.client.getEnablement([raw]), raw.id);
      const fresh = normalize(raw, viewer.host);
      applyMetadata(fresh, metadata);
      Object.assign(row, fresh);
      if (row.archived || row.permission !== 'ADMIN' || raw.permissions?.admin !== true) {
        row.canEnable = false;
        throw failure(row.archived ? 'Archived repositories cannot be changed.' : 'Repository administrator access is required to enable alerts.', 'permission', 403);
      }
      if (row.alertsEnabled !== true) {
        // Clear the prior disabled claim before a write whose outcome may become uncertain.
        row.alertsEnabled = null;
        row.canEnable = false;
        await this.client.enableAlerts(row.fullName);
        const verified = this.metadata(await this.client.getEnablement([raw]), raw.id);
        applyMetadata(row, verified);
        if (row.alertsEnabled !== true) {
          throw failure('GitHub did not confirm that alerts are enabled. Refresh before trying again.', 'validation', 409);
        }
      }
      try {
        applyAlerts(row, await this.client.listAlerts(row.fullName), viewer.host);
      } catch (error) {
        row.scanState = 'unavailable';
        row.counts = null;
        row.alerts = [];
        row.error = `Alerts are enabled, but alerts could not be loaded: ${message(error)}`;
      }
      row.checkedAt = this.now();
      return this.snapshot();
    } catch (error) {
      row.error = message(error);
      if (['permission', 'restricted', 'not_found'].includes(error?.kind)) row.canEnable = false;
      if (error?.kind === 'auth' && error.status !== 409) {
        this.state.session.connected = false;
        this.state.repositories = [];
      }
      throw error;
    } finally {
      this.enableInFlight = false;
    }
  }

  async runDemoScan() {
    const rows = clone(this.state.repositories);
    this.state.scan.phase = 'alerts';
    this.state.scan.total = rows.length;
    this.state.repositories = rows.map((row) => ({ ...row, scanState: 'queued', counts: null, alerts: [], canEnable: false, checkedAt: null }));
    for (let index = 0; index < rows.length; index++) {
      this.state.repositories[index].scanState = 'scanning';
      await new Promise((resolve) => setTimeout(resolve, 150));
      this.state.repositories[index] = { ...rows[index], checkedAt: this.now() };
      this.state.scan.processed++;
    }
    this.state.scan.status = 'complete';
    this.state.scan.phase = 'complete';
    this.state.scan.completedAt = this.now();
  }
}
