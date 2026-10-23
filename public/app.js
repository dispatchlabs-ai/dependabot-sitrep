/* Browser client for the local Node server. Credentials remain managed by gh. */
(() => {
  'use strict';
  const severities = ['critical', 'high', 'medium', 'low'];
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const defaults = { org: 'all', query: '', status: 'all', severity: 'all', hasAlerts: 'all', archived: 'all', sort: 'critical', sortDirection: 'desc', attention: false, canEnable: false };
  const state = { view: 'repositories', sidebarCollapsed: false, filters: { ...defaults }, snapshot: null, connected: false, scanning: false, activeRepo: null, pendingEnable: null, enabling: false, requesting: false, error: null };
  const mobileQuery = window.matchMedia('(max-width: 700px)');
  let mobileNavigationOpen = false;
  let repositories = [], csrfToken, snapshotKey = '', ownerKey = '', rowsKey = '', drawerKey = '', pollTimer, toastTimer, loading = false;
  try {
    const saved = JSON.parse(localStorage.getItem('sitrep-preferences') || 'null');
    if (['repositories', 'coverage'].includes(saved?.view)) state.view = saved.view;
    state.sidebarCollapsed = saved?.sidebarCollapsed === true;
  } catch { /* Storage is optional. */ }
  const total = repo => repo.countsReadable ? repo.counts.total : null;
  const status = repo => repo.enabled === true ? 'enabled' : repo.enabled === false ? 'disabled' : 'unknown';
  const eligible = repo => Boolean(repo?.canEnable && repo.admin && !repo.archived && repo.enabled === false && state.connected && !state.scanning && !state.enabling && !state.requesting);
  const needsAttention = repo => !repo.archived && (repo.enabled !== true || !repo.countsReadable || total(repo) > 0);
  const login = () => state.snapshot?.session.login;
  const owners = () => [...new Set(repositories.map(repo => repo.owner))].sort((a, b) => a.localeCompare(b));
  const organizations = () => [...new Set(repositories.filter(repo => repo.ownerType === 'Organization').map(repo => repo.owner))];
  const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not yet checked';
  const languageClass = value => String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  function link(url, host, label, cls = 'advisory-link') {
    try { const parsed = new URL(url); if (parsed.protocol === 'https:' && parsed.hostname === host && !parsed.username && !parsed.password && !parsed.port) return `<a class="${cls}" href="${esc(parsed.href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ${icon('external')}</a>`; } catch { /* Missing links stay absent. */ }
    return '';
  }
  function ownerScope() {
    const org = state.filters.org;
    return repositories.filter(repo => org === 'all' || (org === 'organizations' ? repo.ownerType === 'Organization' : org === 'personal' ? repo.owner === login() : repo.owner === org));
  }
  function summarize(repos) {
    const counts = Object.fromEntries(severities.map(severity => [severity, repos.reduce((sum, repo) => sum + (repo.countsReadable ? repo.counts[severity] || 0 : 0), 0)]));
    return { total: repos.length, enabled: repos.filter(repo => repo.enabled === true).length, disabled: repos.filter(repo => repo.enabled === false).length, unknown: repos.filter(repo => repo.enabled === null).length, readable: repos.filter(repo => repo.countsReadable).length, restricted: repos.filter(repo => repo.enabled === null || (repo.enabled === true && !repo.countsReadable)).length, attention: repos.filter(needsAttention).length, counts, alerts: repos.reduce((sum, repo) => sum + (total(repo) || 0), 0) };
  }
  function filterRepos() {
    const f = state.filters;
    return ownerScope().filter(repo => {
      const count = total(repo);
      return `${repo.fullName} ${repo.language || ''}`.toLowerCase().includes(f.query.toLowerCase().trim())
        && (f.status === 'all' || status(repo) === f.status) && (f.severity === 'all' || (repo.countsReadable && repo.counts[f.severity] > 0))
        && (f.hasAlerts === 'all' || (f.hasAlerts === 'yes' ? count > 0 : f.hasAlerts === 'no' ? repo.enabled === true && count === 0 : count === null))
        && (f.archived === 'all' || (f.archived === 'archived' ? repo.archived : !repo.archived)) && (!f.attention || needsAttention(repo)) && (!f.canEnable || repo.canEnable);
    }).sort((a, b) => {
      const byName = a.fullName.localeCompare(b.fullName);
      const direction = f.sortDirection === 'asc' ? 1 : -1;
      if (f.sort === 'name') return direction * byName;
      let left, right;
      if (f.sort === 'language') {
        left = a.language || null; right = b.language || null;
      } else if (f.sort === 'status') {
        const order = { enabled: 0, disabled: 1 };
        left = order[status(a)] ?? null; right = order[status(b)] ?? null;
      } else {
        left = f.sort === 'alerts' ? total(a) : a.countsReadable ? a.counts[f.sort] ?? null : null;
        right = f.sort === 'alerts' ? total(b) : b.countsReadable ? b.counts[f.sort] ?? null : null;
      }
      // Missing values stay last in both directions; a successful zero remains sortable.
      if (left === null || right === null) return left === right ? byName : left === null ? 1 : -1;
      const difference = typeof left === 'string' ? left.localeCompare(right) : left - right;
      return direction * difference || byName;
    });
  }
  function badge(repo) { const value = status(repo); return `<span class="status-badge ${value}"><span class="status-dot"></span>${value[0].toUpperCase() + value.slice(1)}</span>`; }
  function coverageBar(stats) { return `<div class="coverage-track" role="img" aria-label="${stats.enabled} enabled, ${stats.disabled} disabled, ${stats.unknown} unknown, of ${stats.total} repositories">${['enabled', 'disabled', 'unknown'].map(value => stats[value] ? `<span class="coverage-segment ${value}" data-weight="${stats[value]}"></span>` : '').join('')}</div>`; }
  function renderMetrics() {
    const stats = summarize(ownerScope());
    const scopeLabel = state.filters.org === 'all' ? `${organizations().length} organizations · ${repositories.filter(repo => repo.owner === login()).length} personal repos` : state.filters.org === 'personal' ? 'Your personal repositories' : 'Within the selected owner scope';
    const partial = state.scanning || ['paused', 'error'].includes(state.snapshot?.scan.status);
    $('#metrics-grid').innerHTML = `
      <article class="metric-card" data-od-id="metric-repositories"><div class="metric-label">Visible repositories${icon('repo')}</div><div class="metric-value">${stats.total.toString().padStart(2, '0')}</div><div class="metric-note">${scopeLabel}</div></article>
      <article class="metric-card" data-od-id="metric-open-alerts"><div class="metric-label">Open alerts <span class="metric-tag">${partial ? 'PARTIAL' : 'READABLE'}</span></div><div class="metric-inline"><div class="metric-value">${stats.readable ? stats.alerts : '—'}</div><span class="metric-side-note">across ${stats.readable} readable repos</span></div><div class="severity-legend">${severities.map(severity => `<span class="severity-item"><span class="severity-dot ${severity}"></span><strong>${stats.readable ? stats.counts[severity] : '—'}</strong><span>${severity === 'medium' ? 'Med' : severity[0].toUpperCase() + severity.slice(1)}</span></span>`).join('')}</div><div class="metric-note">${stats.total - stats.readable} repos excluded from alert totals</div></article>
      <article class="metric-card" data-od-id="metric-coverage"><div class="metric-label">Alerts enabled${icon('shield')}</div><div class="metric-inline"><div class="metric-value">${stats.enabled}<span class="metric-denominator">/ ${stats.total}</span></div><span class="metric-side-note">repositories</span></div>${coverageBar(stats)}<div class="metric-note">${stats.disabled} disabled · ${stats.unknown} unknown</div></article>
      <article class="metric-card attention-metric" data-od-id="metric-attention"><div class="metric-label">Needs attention${icon('alert')}</div><div class="metric-value">${stats.attention.toString().padStart(2, '0')}<span class="metric-unit">repos</span></div><button class="metric-link" id="show-attention">Review active repositories ${icon('arrow')}</button></article>`;
    const warnings = state.snapshot?.warnings || [];
    $('#access-notice').hidden = stats.restricted === 0 && !warnings.length;
    $('#access-notice-copy').textContent = [stats.restricted ? `${stats.restricted} of ${stats.total} repositories in this scope have unknown settings or unreadable alert counts. Missing counts are excluded from totals.` : '', ...warnings].filter(Boolean).join(' ');
  }
  function rowMarkup(repo) {
    const count = total(repo), pending = ['queued', 'scanning'].includes(repo.scanState);
    const mobileCounts = count === null ? '<span class="counts-unavailable">Alert counts unavailable</span>' : severities.map(severity => `<span><span class="severity-dot ${severity}"></span><b>${repo.counts[severity]}</b><span class="sr-only"> ${severity} alerts</span></span>`).join('');
    const caption = pending ? (repo.scanState === 'scanning' ? 'Checking alerts…' : 'Waiting to be checked') : repo.enabled === false ? (repo.archived ? 'Archived repository' : repo.admin ? 'Ready to enable' : 'Admin permission required') : !repo.countsReadable ? (repo.scanState === 'error' ? 'Could not read alerts' : 'Counts unavailable') : count === 0 ? 'No open alerts returned' : `${count} open alerts`;
    const action = eligible(repo) ? `<button class="row-action enable-action" data-enable="${esc(repo.id)}">${icon('shield')}Enable</button>` : `<button class="row-action icon-button" data-open="${esc(repo.id)}" aria-label="View ${esc(repo.name)} details">${icon('chevron')}</button>`;
    return `<tr class="repo-row ${repo.archived ? 'archived-row' : ''}" data-repo="${esc(repo.id)}"><td class="repository-cell"><div class="repo-cell">${icon(repo.archived ? 'package' : 'repo')}<div class="repo-name"><button class="repo-open" data-open="${esc(repo.id)}"><span class="owner">${esc(repo.owner)}</span><strong>${esc(repo.name)}</strong></button><div class="repo-meta">${repo.private ? icon('lock') : ''}<span>${repo.private ? 'Private' : 'Public'}</span>${repo.archived ? '<span class="archived-label">Archived</span>' : ''}</div></div></div><div class="mobile-counts">${mobileCounts}</div></td><td class="language-cell"><span class="language-dot lang-${languageClass(repo.language)}"></span>${esc(repo.language || '—')}</td><td class="status-cell">${badge(repo)}<span class="status-caption">${caption}</span></td>${severities.map(severity => `<td class="counts-cell"><span class="severity-count ${count === null ? 'unavailable' : repo.counts[severity] ? severity : 'zero'}" aria-label="${count === null ? `${severity} count unavailable` : `${repo.counts[severity]} ${severity} alerts`}">${count === null ? '—' : repo.counts[severity]}</span></td>`).join('')}<td class="actions-cell">${action}</td></tr>`;
  }
  function renderRows() {
    const repos = filterRepos(), key = JSON.stringify([repos, state.scanning, state.enabling, state.requesting]);
    if (key !== rowsKey) {
      const focused = document.activeElement?.closest('#repo-rows button');
      const focusAction = focused?.dataset.open ? ['open', focused.dataset.open] : focused?.dataset.enable ? ['enable', focused.dataset.enable] : null;
      $('#repo-rows').innerHTML = repos.map(rowMarkup).join('');
      if (focusAction) [...$('#repo-rows').querySelectorAll('button')].find(button => button.dataset[focusAction[0]] === focusAction[1])?.focus({ preventScroll: true });
      rowsKey = key;
    }
    $('#no-results').hidden = repos.length !== 0; $('.repo-table').hidden = repos.length === 0;
    $('#no-results h3').textContent = !repositories.length && state.scanning ? 'Discovering your repositories…' : !repositories.length ? 'No repositories returned.' : 'No repositories match.';
    $('#no-results p').textContent = !repositories.length ? 'Repository visibility depends on your active GitHub CLI credentials, organization access, and SSO authorization.' : 'Try a different search or clear your filters.';
    $('#section-count').textContent = repos.length;
    $('#result-summary').textContent = `Showing ${repos.length} of ${ownerScope().length} repositories in ${state.filters.org === 'all' ? 'all owners' : 'this owner scope'} · ${repositories.length} discovered overall`;
    const f = state.filters, labels = { org: f.org === 'personal' ? 'Personal repos' : f.org === 'organizations' ? 'All organizations' : f.org, query: `Search: ${f.query}`, status: `Status: ${f.status}`, severity: `Severity: ${f.severity}`, hasAlerts: f.hasAlerts === 'yes' ? 'Has open alerts' : f.hasAlerts === 'no' ? 'Verified zero alerts' : 'Counts unavailable', archived: f.archived === 'active' ? 'Active only' : 'Archived only', attention: 'Needs attention', canEnable: 'Can enable' };
    const keys = Object.keys(f).filter(k => !['sort', 'sortDirection'].includes(k) && f[k] !== defaults[k]);
    $('#active-filters').hidden = !keys.length;
    $('#active-filters').innerHTML = keys.map(k => `<button class="filter-chip" data-clear="${k}" aria-label="Remove ${esc(labels[k])} filter">${esc(labels[k])}${icon('close')}</button>`).join('') + (keys.length ? '<button class="text-button" data-action="clear-filters">Clear all</button>' : '');
    const extra = ['severity', 'hasAlerts', 'archived', 'attention', 'canEnable'].filter(k => f[k] !== defaults[k]).length;
    $('#extra-filter-count').hidden = !extra; $('#extra-filter-count').textContent = extra;
  }
  function renderOwners() {
    const key = JSON.stringify([owners(), repositories.map(repo => repo.owner), login()]);
    if (key === ownerKey) return; ownerKey = key;
    const count = owner => repositories.filter(repo => repo.owner === owner).length;
    const options = `<option value="all">All owners</option><option value="organizations">All organizations</option>${owners().map(owner => `<option value="${esc(owner)}">${esc(owner)}</option>`).join('')}<option value="personal">Personal repos</option>`;
    $('#org-filter').innerHTML = options; $('#mobile-org-filter').innerHTML = options;
    $('#owner-navigation').innerHTML = `<span class="section-label">OWNERS <span>${owners().length}</span></span><button class="nav-item org-item" data-org="all">${icon('org')}<span>All owners</span><span class="nav-count">${repositories.length}</span></button>${owners().filter(owner => owner !== login()).map(owner => `<button class="nav-item org-item" data-org="${esc(owner)}"><span class="org-avatar">${esc(owner[0].toUpperCase())}</span><span>${esc(owner)}</span><span class="nav-count">${count(owner)}</span></button>`).join('')}<div class="personal-divider"></div><button class="nav-item org-item" data-org="personal">${icon('user')}<span>Personal repositories</span><span class="nav-count">${count(login())}</span></button>`;
    $('#nav-repo-count').textContent = repositories.length;
  }
  function renderCoverage() {
    const groups = [...new Set(ownerScope().map(repo => repo.owner))].sort((a, b) => a.localeCompare(b));
    $('#coverage-view').innerHTML = `<div class="section-heading"><div><h2>Coverage by owner</h2></div><span class="table-hint">Within the selected owner scope</span></div><div class="coverage-list">${groups.map(owner => {
      const stats = summarize(repositories.filter(repo => repo.owner === owner));
      return `<article class="coverage-row"><div class="coverage-org"><span class="org-avatar">${esc(owner[0].toUpperCase())}</span><div><strong>${esc(owner)}</strong><small>${stats.total} repositories${owner === login() ? ' · personal' : ''}</small></div></div><div class="coverage-bar">${coverageBar(stats)}</div><div class="coverage-numbers"><strong>${stats.enabled}<span> / ${stats.total}</span></strong><button class="text-button" data-owner-review="${esc(owner)}">Review ${icon('arrow')}</button></div></article>`;
    }).join('')}</div><div class="coverage-legend"><span><i></i>Enabled</span><span class="disabled"><i></i>Disabled</span><span class="unknown"><i></i>Unknown</span></div><div class="coverage-explainer"><div><h3>Alert permissions</h3><p>Repository settings confirm whether alerts are enabled. Reading alert details requires separate permission. Unavailable settings remain unknown; missing alert counts are excluded from totals.</p></div><div><h3>Repository access</h3><p>Organization SSO and token restrictions can limit visible repositories. Archived repositories remain in coverage totals.</p></div></div>`;
  }
  function syncControls() {
    const ids = { org: ['org-filter', 'mobile-org-filter'], query: ['repo-search'], status: ['status-filter', 'mobile-status-filter'], severity: ['severity-filter'], hasAlerts: ['alerts-filter'], archived: ['archive-filter'], sort: ['sort-filter'], sortDirection: ['sort-direction'] };
    Object.entries(ids).forEach(([key, items]) => items.forEach(id => { if ($(`#${id}`).value !== state.filters[key]) $(`#${id}`).value = state.filters[key]; }));
    $('#attention-filter').checked = state.filters.attention; $('#can-enable-filter').checked = state.filters.canEnable;
    $$('.org-item').forEach(item => { item.classList.toggle('active', item.dataset.org === state.filters.org); item.setAttribute('aria-pressed', String(item.dataset.org === state.filters.org)); });
    $$('[data-sort]').forEach(button => {
      const active = button.dataset.sort === state.filters.sort;
      if (active) button.closest('th').setAttribute('aria-sort', state.filters.sortDirection === 'asc' ? 'ascending' : 'descending');
      else button.closest('th').removeAttribute('aria-sort');
      button.querySelector('.sort-indicator').textContent = active ? state.filters.sortDirection === 'asc' ? '↑' : '↓' : '↕';
      const nextDirection = active ? state.filters.sortDirection === 'asc' ? 'descending' : 'ascending' : ['name', 'language', 'status'].includes(button.dataset.sort) ? 'ascending' : 'descending';
      const label = button.dataset.sort === 'alerts' ? 'total vulnerabilities' : button.textContent.replace(/[↑↓↕]/g, '').trim();
      button.title = `Sort by ${label}, ${nextDirection}`;
    });
  }
  function renderStatus() {
    const scan = state.snapshot?.scan, error = state.error || (['paused', 'error'].includes(scan?.status) ? scan.error : null);
    $('#operation-notice').hidden = !error; $('#operation-message').textContent = error ? `${error}${scan?.retryAt ? ` Try again after ${time(scan.retryAt)}.` : ''}` : '';
    $('#scan-notice').hidden = !state.scanning;
    $('#scan-message').textContent = ({ authentication: 'Checking GitHub CLI authentication…', repositories: 'Discovering repositories across owners…', enablement: 'Checking Dependabot enablement…', alerts: 'Reading available Dependabot alerts…' })[scan?.phase] || 'Starting scan…';
    $('#scan-count').textContent = scan?.total ? `${scan.processed} / ${scan.total}` : 'Discovering…'; $('#scan-fill').style.width = scan?.total ? `${Math.round(scan.processed / scan.total * 100)}%` : '6%';
    $('#scan-time').textContent = scan?.completedAt ? `${state.snapshot?.demo ? 'Demo · ' : ''}${scan.status === 'complete' ? 'Last scan' : 'Scan stopped'} ${time(scan.completedAt)}` : 'No completed scan';
    $('#refresh-button').disabled = state.scanning || state.enabling || state.requesting || (scan?.status === 'paused' && Date.parse(scan.retryAt) > Date.now());
    $('#refresh-button').classList.toggle('is-scanning', state.scanning); $('#refresh-button span').textContent = state.scanning ? 'Scanning…' : state.requesting ? 'Starting…' : 'Refresh repos';
    $('#refresh-button').setAttribute('aria-label', state.scanning ? 'Repository scan in progress' : 'Refresh repositories');
    $('#reconnect-button').disabled = state.requesting || state.scanning || !csrfToken; $('#reconnect-button').innerHTML = `${icon('refresh', state.scanning ? 'spinning' : '')}${state.scanning ? 'Checking connection…' : 'Check connection'}`;
    $('#login-state h2').textContent = loading && !state.snapshot ? 'Connecting…' : 'Connect your GitHub CLI.';
    $('#login-error').textContent = scan?.phase === 'authentication' && scan.error ? scan.error : ''; $('#login-error').hidden = !$('#login-error').textContent;
  }
  function render() {
    const titles = { repositories: 'Repositories', coverage: 'Coverage' };
    $('#page-title').textContent = titles[state.view]; $('#breadcrumb-current').textContent = titles[state.view];
    document.title = `${titles[state.view]} · Dependabot Sitrep`;
    $$('[data-view]').forEach(button => { if (!button.classList.contains('nav-item')) return; button.classList.toggle('active', button.dataset.view === state.view); if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
    $('#login-state').hidden = state.connected; $('#connected-content').hidden = !state.connected; $('#refresh-button').hidden = !state.connected; $('#scan-time').hidden = !state.connected;
    $('#identity-button .identity-copy strong').textContent = login() || 'GitHub CLI'; $('#identity-button .identity-avatar').textContent = login() ? login().slice(0, 2).toUpperCase() : 'GH';
    $('#identity-status').textContent = state.snapshot?.demo ? 'Demo session' : state.connected ? 'Connected via gh' : 'Authentication required';
    $('[data-od-id="sample-data-badge"]').hidden = !state.snapshot?.demo; $('[data-od-id="dashboard-footer"]').hidden = !state.snapshot?.demo; $('#footer-version').textContent = state.snapshot?.demo ? 'Fictional demo data · changes are simulated' : '';
    $('#coverage-view').hidden = state.view !== 'coverage'; $('#repo-section').hidden = state.view === 'coverage';
    renderOwners(); renderMetrics(); renderRows(); renderCoverage(); syncControls(); renderStatus();
    $$('[data-weight]').forEach(segment => { segment.style.flexGrow = segment.dataset.weight; });
    if ($('#repo-drawer').open) { const repo = repositories.find(item => item.id === state.activeRepo); if (repo) renderDrawer(repo); else $('#repo-drawer').close(); }
    if ($('#enable-modal').open && $('#confirm-enable')) $('#confirm-enable').disabled = !$('#enable-ack')?.checked || !eligible(repositories.find(item => item.id === state.pendingEnable));
    savePreferences();
  }
  function savePreferences() {
    try { localStorage.setItem('sitrep-preferences', JSON.stringify({ view: state.view, sidebarCollapsed: state.sidebarCollapsed })); } catch { /* Storage is optional. */ }
  }
  function syncSidebar() {
    const mobile = mobileQuery.matches;
    const open = mobile ? mobileNavigationOpen : !state.sidebarCollapsed;
    $('.app-shell').classList.toggle('sidebar-collapsed', !mobile && state.sidebarCollapsed);
    $('#sidebar').classList.toggle('open', mobile && open);
    $('#sidebar').inert = !open;
    $('#sidebar-scrim').hidden = !mobile || !open;
    document.body.classList.toggle('nav-open', mobile && open);
    $('.workspace').inert = mobile && open;
    $('#menu-button').setAttribute('aria-expanded', String(open));
    $('#menu-button').setAttribute('aria-label', open ? 'Hide sidebar' : 'Show sidebar');
  }
  function closeNavigation() {
    const wasOpen = mobileNavigationOpen;
    mobileNavigationOpen = false;
    syncSidebar();
    if (wasOpen) $('#menu-button').focus();
  }
  function toggleNavigation() {
    if (mobileQuery.matches) mobileNavigationOpen = !mobileNavigationOpen;
    else state.sidebarCollapsed = !state.sidebarCollapsed;
    syncSidebar();
    savePreferences();
    if (mobileQuery.matches && mobileNavigationOpen) $('#sidebar .nav-item').focus();
  }
  function setView(view) { state.view = view; closeNavigation(); render(); }
  function showToast(message) { clearTimeout(toastTimer); $('#toast').innerHTML = `${icon('info')}<span>${esc(message)}</span>`; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500); }
  function alertCard(alert) {
    const severity = severities.includes(alert.severity) ? alert.severity : 'unknown';
    return `<article class="alert-card"><div class="alert-heading"><span class="alert-package">${icon('package')}<strong>${esc(alert.package)}</strong><span class="ecosystem">${esc(alert.ecosystem)}</span></span><span class="severity-badge ${severity}">${severity}</span></div><h3>${esc(alert.summary)}</h3><dl class="alert-fields"><div><dt>Vulnerable range</dt><dd><code>${esc(alert.vulnerableRange || 'Not provided')}</code></dd></div><div><dt>Fixed in</dt><dd><code>${esc(alert.patchedVersion || 'No patched version listed')}</code></dd></div><div class="full-width"><dt>Manifest</dt><dd><code>${esc(alert.manifest || 'Not provided')}</code></dd></div></dl>${link(alert.url, state.snapshot.session.host, `View alert #${alert.number}`)} ${link(alert.advisoryUrl, 'github.com', 'View advisory')}</article>`;
  }
  function renderDrawer(repo) {
    const key = JSON.stringify([repo, state.scanning, state.enabling, state.snapshot.demo]); if (key === drawerKey) return; drawerKey = key;
    const scroll = $('#repo-drawer .drawer-body')?.scrollTop || 0, restoreCloseFocus = document.activeElement?.dataset.close === 'repo-drawer';
    const count = total(repo), pending = ['queued', 'scanning'].includes(repo.scanState);
    let contents;
    if (repo.enabled === false) contents = `<div class="empty-state"><div class="empty-icon">${icon('shield')}</div><h3>Dependabot alerts are disabled.</h3><p>${repo.archived ? 'This repository is archived. Unarchive it in GitHub before changing its settings.' : repo.admin ? 'Enable alerts to identify vulnerable dependencies in this repository.' : 'A repository administrator is required to enable alerts here.'}</p>${eligible(repo) ? `<button class="btn btn-primary" data-enable="${esc(repo.id)}">${icon('shield')}Enable alerts</button>` : ''}</div>`;
    else if (!repo.countsReadable) contents = `<div class="empty-state"><div class="empty-icon">${icon(pending ? 'refresh' : 'lock')}</div><h3>${pending ? 'Alert scan pending.' : repo.enabled === true ? 'Enabled. Alert counts unavailable.' : 'Enablement could not be confirmed.'}</h3><p>${esc(repo.error || (pending ? 'This repository has not finished scanning. Its missing counts are excluded from totals.' : 'The active GitHub CLI credentials could not read these details.'))}</p>${!pending ? '<button class="btn btn-secondary" data-action="access-help">Understand access</button>' : ''}</div>`;
    else if (count === 0) contents = `<div class="empty-state"><div class="empty-icon">${icon('shield')}</div><h3>No open alerts returned.</h3><p>The alert endpoint was read successfully at ${esc(time(repo.checkedAt))}. Coverage and alert access are checked separately.</p></div>`;
    else contents = `<div class="detail-tabs"><strong>Open alerts <span>${count}</span></strong><span>Highest severity first</span></div>${state.snapshot.demo ? '<p class="sample-alert-note">Fictional demo alerts. Changes are simulated locally.</p>' : ''}${[...repo.alerts].sort((a, b) => (severities.indexOf(a.severity) < 0 ? 4 : severities.indexOf(a.severity)) - (severities.indexOf(b.severity) < 0 ? 4 : severities.indexOf(b.severity))).map(alertCard).join('')}`;
    $('#repo-drawer').innerHTML = `<header class="drawer-head"><div class="drawer-kicker">REPOSITORY DETAILS ${state.snapshot.demo ? '<span class="sample-badge">Demo</span>' : ''}</div><button class="icon-button drawer-close" data-close="repo-drawer" aria-label="Close repository details">${icon('close')}</button><div class="drawer-owner">${esc(repo.owner)} /</div><h2 class="drawer-title" id="drawer-title">${esc(repo.name)}</h2><div class="drawer-meta"><span class="language-dot lang-${languageClass(repo.language)}"></span>${esc(repo.language || 'No language detected')}<span>·</span>${repo.private ? 'Private' : 'Public'}<span>·</span>${esc(repo.permission.toLowerCase())} access${repo.archived ? '<span class="archived-label">Archived</span>' : ''}</div></header><div class="drawer-body"><div class="detail-summary"><div><span>Dependabot alerts</span>${badge(repo)}</div><div><span>Open alerts</span><strong>${count === null ? 'Unavailable' : count}</strong></div><div><span>Alert read access</span><strong>${repo.enabled === false ? 'Not assessed' : pending ? 'Pending scan' : repo.countsReadable ? 'Granted' : 'Unavailable'}</strong></div></div>${contents}</div><footer class="drawer-footer"><span>Checked ${esc(time(repo.checkedAt))}</span>${link(repo.url, state.snapshot.session.host, 'Open repository', 'btn btn-secondary btn-small')}</footer>`;
    $('#repo-drawer .drawer-body').scrollTop = scroll; if (restoreCloseFocus) $('#repo-drawer [data-close]').focus({ preventScroll: true });
  }
  function openRepo(id) { const repo = repositories.find(item => item.id === id); if (!repo) return; state.activeRepo = id; drawerKey = ''; renderDrawer(repo); if (!$('#repo-drawer').open) $('#repo-drawer').showModal(); $('#repo-drawer [data-close]').focus(); }
  function openEnable(id) {
    const repo = repositories.find(item => item.id === id); if (!eligible(repo)) { showToast('Enabling requires administrator access on an active, disabled repository after the scan completes.'); return; }
    state.pendingEnable = id;
    $('#enable-modal').innerHTML = `<header class="modal-head"><h2 id="enable-title">Enable Dependabot alerts?</h2><button class="icon-button" data-close="enable-modal" aria-label="Cancel enabling alerts">${icon('close')}</button></header><div class="modal-body"><span class="eyebrow">ONE REPOSITORY${state.snapshot.demo ? ' · DEMO CHANGE' : ''}</span><p>Enable alerts for this repository using your active GitHub CLI account:</p><div class="confirm-repo">${icon('repo')}<strong>${esc(repo.fullName)}</strong></div><ul class="scope-list"><li>${icon('check')}<span>Enable the <strong>dependency graph</strong> to identify dependencies.</span></li><li>${icon('check')}<span>Enable <strong>Dependabot alerts</strong> for vulnerable dependencies.</span></li></ul><label class="checkbox-line"><input type="checkbox" id="enable-ack"><span>Enable dependency graph and Dependabot alerts for <strong>${esc(repo.fullName)}</strong>.</span></label>${state.snapshot.demo ? '<p class="sample-confirm-note">Demo mode: this action is simulated locally.</p>' : ''}<p id="enable-error" class="form-error" role="alert" hidden></p></div><footer class="modal-footer"><button class="btn btn-secondary" data-close="enable-modal">Cancel</button><button class="btn btn-primary" id="confirm-enable" disabled>${state.snapshot.demo ? 'Enable in demo' : 'Enable alerts'}</button></footer>`;
    $('#enable-modal').showModal(); $('#enable-modal [data-close]').focus();
  }
  async function confirmEnable() {
    const repo = repositories.find(item => item.id === state.pendingEnable); if (!eligible(repo) || !$('#enable-ack')?.checked) return;
    state.enabling = true; $('#confirm-enable').disabled = true; $('#confirm-enable').textContent = 'Enabling…'; $('#enable-modal').querySelectorAll('[data-close]').forEach(button => { button.disabled = true; });
    try { applySnapshot(await api(`/api/repositories/${encodeURIComponent(repo.id)}/enable`, { confirm: repo.fullName })); $('#enable-modal').close(); state.pendingEnable = null; showToast(`${state.snapshot.demo ? 'Demo: alerts' : 'Alerts'} enabled for ${repo.fullName}.`); }
    catch (error) { $('#enable-error').textContent = `${error.message}${error.retryAt ? ` Try again after ${time(error.retryAt)}.` : ''}`; $('#enable-error').hidden = false; await loadState(); }
    finally { state.enabling = false; $('#enable-modal').querySelectorAll('[data-close]').forEach(button => { button.disabled = false; }); if ($('#confirm-enable')) $('#confirm-enable').textContent = state.snapshot?.demo ? 'Enable in demo' : 'Enable alerts'; render(); }
  }
  async function api(path, body) {
    let response;
    try { response = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sitrep-Token': csrfToken }, body: JSON.stringify(body) }); }
    catch { throw new Error('The local server could not be reached. Check the terminal running Sitrep and retry.'); }
    let result; try { result = await response.json(); } catch { throw new Error('The local server returned an unreadable response. Refresh to reconnect.'); }
    if (!response.ok) throw Object.assign(new Error(result.error || 'The request could not be completed.'), { kind: result.kind, retryAt: result.retryAt }); return result;
  }
  function applySnapshot(snapshot) {
    if (snapshot.csrfToken) csrfToken = snapshot.csrfToken;
    const nextKey = JSON.stringify(snapshot, (key, value) => key === 'csrfToken' ? undefined : value);
    if (nextKey === snapshotKey && !state.error) { renderStatus(); return; }
    snapshotKey = nextKey; state.snapshot = snapshot; state.connected = Boolean(snapshot.session.connected); state.scanning = snapshot.scan.status === 'running'; state.error = null;
    repositories = snapshot.repositories.map(repo => ({ ...repo, enabled: repo.alertsEnabled, admin: repo.permission === 'ADMIN', countsReadable: repo.counts !== null && repo.scanState === 'complete' })); render();
  }
  function schedulePoll() { clearTimeout(pollTimer); pollTimer = setTimeout(async () => { await loadState(); schedulePoll(); }, state.scanning || state.enabling ? 1000 : 5000); }
  async function loadState() { if (loading) return; loading = true; try { applySnapshot(await api('/api/state')); } catch (error) { state.error = error.message; render(); } finally { loading = false; } }
  async function refresh() {
    if (state.scanning || state.enabling || state.requesting) return; state.requesting = true; state.error = null; render();
    try { if (!csrfToken) await loadState(); if (!csrfToken) throw new Error('Refresh the page to reconnect to the local server.'); applySnapshot(await api('/api/scan', {})); }
    catch (error) { state.error = `${error.message}${error.retryAt ? ` Try again after ${time(error.retryAt)}.` : ''}`; }
    finally { state.requesting = false; render(); schedulePoll(); }
  }
  function accessHelp() {
    const limited = ownerScope().filter(repo => repo.enabled === null || (repo.enabled === true && !repo.countsReadable));
    $('#connection-modal').innerHTML = `<header class="modal-head"><h2 id="connection-title">Repository visibility and alert access</h2><button class="icon-button" data-close="connection-modal" aria-label="Close access information">${icon('close')}</button></header><div class="modal-body"><p>The active GitHub CLI credentials may see a repository without permission to read its Dependabot alerts or settings. Ask a repository administrator to review alert access, token permissions, and organization SSO authorization.</p>${limited.slice(0, 8).map(repo => `<div class="connection-row"><strong>${esc(repo.fullName)}</strong><span>${repo.enabled === null ? 'Settings unknown' : 'Alert counts unavailable'}</span></div>`).join('')}${limited.length > 8 ? `<p>And ${limited.length - 8} other repositories in this scope.</p>` : ''}<p class="permission-note">A 403 or 404 does not establish that alerts are disabled. Missing counts are never treated as zero.</p></div><footer class="modal-footer"><button class="btn btn-primary" data-close="connection-modal">Got it</button></footer>`; $('#connection-modal').showModal();
  }
  function showConnection() {
    const session = state.snapshot?.session || {};
    $('#connection-modal').innerHTML = `<header class="modal-head"><h2 id="connection-title">Your GitHub CLI session</h2><button class="icon-button" data-close="connection-modal" aria-label="Close session details">${icon('close')}</button></header><div class="modal-body"><p>${state.snapshot?.demo ? 'This demo uses fictional repositories and simulates changes locally.' : 'Sitrep uses GitHub CLI on your machine. Your GitHub token stays with gh.'}</p><div class="connection-row"><span>Active account</span><strong>${esc(session.login || 'Not connected')}</strong></div><div class="connection-row"><span>GitHub host</span><strong>${esc(session.host || 'github.com')}</strong></div><div class="connection-row"><span>Repositories discovered</span><strong>${repositories.length}</strong></div><p class="permission-note">To sign in or change accounts, use your terminal, then refresh the repository scan.</p><div class="terminal-block"><code>gh auth login</code></div><div class="terminal-block"><code>gh auth status</code></div></div><footer class="modal-footer"><button class="btn btn-primary" data-close="connection-modal">Done</button></footer>`; $('#connection-modal').showModal();
  }
  document.addEventListener('click', async event => {
    const target = event.target.closest('button, a, [data-repo]'); if (!target || target.disabled) return;
    if (target.dataset.sort) {
      const sort = target.dataset.sort;
      state.filters.sortDirection = state.filters.sort === sort ? state.filters.sortDirection === 'asc' ? 'desc' : 'asc' : ['name', 'language', 'status'].includes(sort) ? 'asc' : 'desc';
      state.filters.sort = sort;
      render();
    }
    else if (target.dataset.view) { event.preventDefault(); setView(target.dataset.view); }
    else if (target.dataset.org) { state.filters.org = target.dataset.org; state.view = 'repositories'; closeNavigation(); render(); }
    else if (target.dataset.open) openRepo(target.dataset.open);
    else if (target.dataset.enable) openEnable(target.dataset.enable);
    else if (target.dataset.close) $(`#${target.dataset.close}`).close();
    else if (target.dataset.clear) { state.filters[target.dataset.clear] = defaults[target.dataset.clear]; render(); }
    else if (target.dataset.ownerReview) { state.filters = { ...defaults, org: target.dataset.ownerReview }; setView('repositories'); }
    else if (target.dataset.action === 'clear-filters') { state.filters = { ...defaults }; render(); }
    else if (target.dataset.action === 'access-help' || target.id === 'review-access') accessHelp();
    else if (target.dataset.action === 'close-navigation') closeNavigation();
    else if (target.dataset.copy) { try { await navigator.clipboard.writeText(target.dataset.copy); showToast('Command copied. Run it in your terminal.'); } catch { showToast('Run gh auth login in your terminal.'); } }
    else if (target.id === 'refresh-button' || target.id === 'reconnect-button') await refresh();
    else if (target.id === 'retry-button') { await loadState(); schedulePoll(); }
    else if (target.id === 'show-attention') { state.filters = { ...defaults, org: state.filters.org, attention: true }; setView('repositories'); }
    else if (target.id === 'identity-button') showConnection();
    else if (target.id === 'confirm-enable') await confirmEnable();
    else if (target.id === 'menu-button') toggleNavigation();
    else if (target.id === 'more-filters') { const open = $('#filter-panel').hidden; $('#filter-panel').hidden = !open; target.setAttribute('aria-expanded', String(open)); }
    else if (target.dataset.repo) openRepo(target.dataset.repo);
  });
  document.addEventListener('change', event => {
    const map = { 'org-filter': 'org', 'mobile-org-filter': 'org', 'status-filter': 'status', 'mobile-status-filter': 'status', 'severity-filter': 'severity', 'alerts-filter': 'hasAlerts', 'archive-filter': 'archived', 'sort-filter': 'sort', 'sort-direction': 'sortDirection' };
    if (map[event.target.id]) {
      state.filters[map[event.target.id]] = event.target.value;
      if (event.target.id === 'sort-filter') state.filters.sortDirection = ['name', 'language', 'status'].includes(event.target.value) ? 'asc' : 'desc';
      render();
    }
    if (event.target.id === 'attention-filter') { state.filters.attention = event.target.checked; render(); }
    if (event.target.id === 'can-enable-filter') { state.filters.canEnable = event.target.checked; render(); }
    if (event.target.id === 'enable-ack') $('#confirm-enable').disabled = !event.target.checked || !eligible(repositories.find(repo => repo.id === state.pendingEnable));
  });
  $('#repo-search').addEventListener('input', event => { state.filters.query = event.target.value; renderRows(); }); $('#sidebar-scrim').addEventListener('click', closeNavigation);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$$('dialog').some(dialog => dialog.open)) closeNavigation();
    if (event.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName) && !$$('dialog').some(dialog => dialog.open) && state.connected && state.view !== 'coverage') { event.preventDefault(); $('#repo-search').focus(); }
    if (event.key === 'Tab' && $('#sidebar').classList.contains('open') && window.matchMedia('(max-width: 700px)').matches) { const focusable = [...$('#sidebar').querySelectorAll('a,button')]; if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); } if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); } }
  });
  $$('dialog').forEach(dialog => {
    dialog.addEventListener('cancel', event => { if (dialog.id === 'enable-modal' && state.enabling) event.preventDefault(); });
    dialog.addEventListener('click', event => { if (event.target !== dialog || (dialog.id === 'enable-modal' && state.enabling)) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); });
  });
  mobileQuery.addEventListener('change', closeNavigation); syncSidebar(); render();
  (async () => { await loadState(); if (state.connected && state.snapshot?.scan.status === 'idle' && !state.snapshot.demo) await refresh(); schedulePoll(); })();
})();
