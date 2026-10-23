/* Dependabot Sitrep — sample-only UI. No requests, tokens, backend, or GitHub mutations. */
(() => {
  'use strict';
  const severities = ['critical', 'high', 'medium', 'low'];
  const organizations = ['northstar-labs', 'meridian-tools', 'fieldwork-studio'];
  const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const templateAlerts = {
    critical: [
      ['form-data', 'npm', '< 4.0.4', '4.0.4', 'package-lock.json', 'Predictable boundary in multipart form data'],
      ['jsonpath-plus', 'npm', '< 10.3.0', '10.3.0', 'package-lock.json', 'Unsafe expression evaluation'],
    ],
    high: [
      ['axios', 'npm', '< 1.8.2', '1.8.2', 'package-lock.json', 'Server-side request forgery'],
      ['vite', 'npm', '< 6.2.3', '6.2.3', 'pnpm-lock.yaml', 'Development server file access'],
      ['cross-spawn', 'npm', '< 7.0.5', '7.0.5', 'package-lock.json', 'Regular expression denial of service'],
    ],
    medium: [
      ['lodash', 'npm', '< 4.17.21', '4.17.21', 'package-lock.json', 'Prototype pollution in dependency'],
      ['esbuild', 'npm', '<= 0.24.2', '0.25.0', 'pnpm-lock.yaml', 'Development server request exposure'],
      ['nanoid', 'npm', '< 3.3.8', '3.3.8', 'pnpm-lock.yaml', 'Predictable identifier generation'],
    ],
    low: [
      ['brace-expansion', 'npm', '< 2.0.2', '2.0.2', 'package-lock.json', 'Regular expression resource exhaustion'],
    ],
  };
  const fixtures = [
    {id:'platform-api', owner:'northstar-labs', name:'platform-api', language:'TypeScript', visibility:'Private', admin:true, enabled:true, counts:[2,3,2,1]},
    {id:'web-console', owner:'northstar-labs', name:'web-console', language:'TypeScript', visibility:'Private', admin:true, enabled:true, counts:[0,2,3,0]},
    {id:'worker-service', owner:'northstar-labs', name:'worker-service', language:'Go', visibility:'Private', admin:true, enabled:false},
    {id:'design-system', owner:'northstar-labs', name:'design-system', language:'TypeScript', visibility:'Public', admin:true, enabled:true, counts:[0,0,0,0]},
    {id:'cli', owner:'meridian-tools', name:'cli', language:'Rust', visibility:'Public', admin:false, enabled:true, counts:[0,1,0,1]},
    {id:'data-pipeline', owner:'meridian-tools', name:'data-pipeline', language:'Python', visibility:'Private', admin:false, enabled:true, reason:'Alerts are enabled, but this session cannot read security alerts. Ask a repository admin to review your alert access.'},
    {id:'docs-site', owner:'meridian-tools', name:'docs-site', language:'MDX', visibility:'Public', admin:false, enabled:false},
    {id:'studio-web', owner:'fieldwork-studio', name:'studio-web', language:'JavaScript', visibility:'Private', admin:true, enabled:true, counts:[0,1,1,0]},
    {id:'assets-service', owner:'fieldwork-studio', name:'assets-service', language:'Go', visibility:'Private', admin:false, enabled:null, reason:'Repository metadata is visible, but the enablement field could not be read. An alert endpoint returned 404; that response alone does not prove alerts are disabled.'},
    {id:'legacy-cms', owner:'fieldwork-studio', name:'legacy-cms', language:'PHP', visibility:'Private', admin:true, archived:true, enabled:false},
    {id:'dotfiles', owner:'alexmorgan', name:'dotfiles', language:'Shell', visibility:'Public', admin:true, enabled:true, counts:[0,0,0,0]},
    {id:'weekend-build', owner:'alexmorgan', name:'weekend-build', language:'TypeScript', visibility:'Private', admin:true, enabled:false},
  ];
  const repositories = fixtures.map(repo => {
    const counts = repo.counts ? Object.fromEntries(severities.map((severity, index) => [severity, repo.counts[index]])) : null;
    const alerts = [];
    severities.forEach(severity => {
      for (let index = 0; index < (counts?.[severity] || 0); index++) {
        const entry = templateAlerts[severity][index % templateAlerts[severity].length];
        const rust = repo.language === 'Rust';
        const packageName = rust ? (severity === 'high' ? 'tokio' : 'time') : entry[0];
        alerts.push({id:`${repo.id}-${severity}-${index}`, package:packageName, ecosystem:rust ? 'cargo' : entry[1], vulnerableRange:rust ? '< 1.38.2 (illustrative)' : entry[2], fixVersion:rust ? '1.38.2 (illustrative)' : entry[3], manifest:rust ? 'Cargo.lock' : entry[4], title:rust ? 'Illustrative dependency security advisory' : entry[5], severity, advisoryUrl:`https://github.com/advisories?query=${encodeURIComponent(packageName)}`});
      }
    });
    return {...repo, archived:!!repo.archived, counts, countsReadable:counts !== null, alerts};
  });
  const defaults = {org:'all', query:'', status:'all', severity:'all', hasAlerts:'all', archived:'all', sort:'severity', attention:false};
  const state = {view:'overview', filters:{...defaults}, connected:true, scanning:false, activeRepo:null, pendingEnable:null, lastScan:null};
  try {
    const saved = JSON.parse(localStorage.getItem('sitrep-preferences') || 'null');
    if (saved && ['overview','repositories','coverage'].includes(saved.view)) state.view = saved.view;
  } catch (_) { /* Local storage is optional in embedded previews. */ }
  let toastTimer;
  let scanTimer;
  const total = repo => repo.countsReadable && repo.counts ? severities.reduce((sum, severity) => sum + repo.counts[severity], 0) : null;
  const status = repo => repo.enabled === true ? 'enabled' : repo.enabled === false ? 'disabled' : 'unknown';
  const needsAttention = repo => !repo.archived && (repo.enabled !== true || !repo.countsReadable || total(repo) > 0);
  const eligible = repo => repo && repo.admin && !repo.archived && repo.enabled === false;
  function ownerScope() {
    const org = state.filters.org;
    return repositories.filter(repo => org === 'all' || (org === 'organizations' ? organizations.includes(repo.owner) : org === 'personal' ? repo.owner === 'alexmorgan' : repo.owner === org));
  }
  function summarize(repos) {
    const counts = Object.fromEntries(severities.map(severity => [severity, repos.reduce((sum, repo) => sum + (repo.countsReadable ? repo.counts?.[severity] || 0 : 0), 0)]));
    return {total:repos.length, enabled:repos.filter(repo => repo.enabled === true).length, disabled:repos.filter(repo => repo.enabled === false).length, unknown:repos.filter(repo => repo.enabled === null).length, readable:repos.filter(repo => repo.enabled === true && repo.countsReadable).length, restricted:repos.filter(repo => repo.enabled === null || (repo.enabled === true && !repo.countsReadable)).length, alertRepos:repos.filter(repo => total(repo) > 0).length, attention:repos.filter(needsAttention).length, archived:repos.filter(repo => repo.archived).length, counts, alerts:Object.values(counts).reduce((sum,value)=>sum+value,0)};
  }
  function filterRepos() {
    const f = state.filters;
    return ownerScope().filter(repo => {
      const count = total(repo);
      return (`${repo.owner}/${repo.name} ${repo.language}`.toLowerCase().includes(f.query.toLowerCase().trim()))
        && (f.status === 'all' || status(repo) === f.status)
        && (f.severity === 'all' || (repo.countsReadable && repo.counts?.[f.severity] > 0))
        && (f.hasAlerts === 'all' || (f.hasAlerts === 'yes' ? count > 0 : f.hasAlerts === 'no' ? repo.enabled === true && count === 0 : count === null))
        && (f.archived === 'all' || (f.archived === 'archived' ? repo.archived : !repo.archived))
        && (!f.attention || needsAttention(repo));
    }).sort((a,b) => {
      const byName = `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`);
      if (f.sort === 'name') return byName;
      if (f.sort === 'status') return ({enabled:0,disabled:1,unknown:2}[status(a)] - {enabled:0,disabled:1,unknown:2}[status(b)]) || byName;
      if (f.sort === 'alerts') return (total(b) ?? -1) - (total(a) ?? -1) || byName;
      for (const severity of severities) {
        const difference = (b.counts?.[severity] || 0) - (a.counts?.[severity] || 0);
        if (difference) return difference;
      }
      return Number(b.enabled === false) - Number(a.enabled === false) || byName;
    });
  }
  function statusBadge(repo) {
    const value = status(repo);
    return `<span class="status-badge ${value}"><span class="status-dot"></span>${value === 'unknown' ? 'Unknown' : value === 'enabled' ? 'Enabled' : 'Disabled'}</span>`;
  }
  function coverageBar(stats) {
    return `<div class="coverage-track" role="img" aria-label="${stats.enabled} enabled, ${stats.disabled} disabled, ${stats.unknown} unknown, of ${stats.total} repositories">${['enabled','disabled','unknown'].map(value => stats[value] ? `<span class="coverage-segment ${value}" style="flex:${stats[value]}"></span>` : '').join('')}</div>`;
  }
  function renderMetrics() {
    const stats = summarize(ownerScope());
    $('#metrics-grid').innerHTML = `
      <article class="metric-card" data-od-id="metric-repositories"><div class="metric-label">Accessible repositories${icon('repo')}</div><div class="metric-value">${stats.total.toString().padStart(2,'0')}</div><div class="metric-note">${state.filters.org === 'all' ? '3 organizations <span class="note-dot">·</span> 2 personal repos' : state.filters.org === 'personal' ? 'Your personal projects' : 'In the selected organization scope'}</div></article>
      <article class="metric-card" data-od-id="metric-open-alerts"><div class="metric-label">Open alerts <span class="metric-tag">READABLE</span></div><div class="metric-inline"><div class="metric-value">${stats.alerts}</div><span class="metric-side-note">across ${stats.alertRepos} repos</span></div><div class="severity-legend">${severities.map(severity => `<span class="severity-item" title="${severity}"><span class="severity-dot ${severity}"></span><strong>${stats.counts[severity]}</strong><span>${severity === 'medium' ? 'Med' : severity[0].toUpperCase()+severity.slice(1)}</span></span>`).join('')}</div><div class="metric-note alert-denominator">Counts readable for ${stats.readable} of ${stats.enabled} enabled repos</div></article>
      <article class="metric-card" data-od-id="metric-coverage"><div class="metric-label">Alerts enabled${icon('shield')}</div><div class="metric-inline"><div class="metric-value">${stats.enabled}<span class="metric-denominator">/ ${stats.total}</span></div><span class="metric-side-note">repositories</span></div>${coverageBar(stats)}<div class="metric-note">${stats.disabled} disabled <span class="note-dot">·</span> ${stats.unknown} unknown</div></article>
      <article class="metric-card attention-metric" data-od-id="metric-attention"><div class="metric-label">Needs attention${icon('alert')}</div><div class="metric-value">${stats.attention.toString().padStart(2,'0')}<span class="metric-unit">repos</span></div><button class="metric-link" id="show-attention" data-od-id="show-needs-attention">Review active repositories ${icon('arrow')}</button></article>`;
    $('#access-notice').hidden = stats.restricted === 0;
    $('#access-notice-copy').textContent = `${stats.restricted} of ${stats.total} repositories have limited visibility. Enabled status and permission to read alert counts are checked separately.`;
  }
  function rowMarkup(repo) {
    const count = total(repo);
    const mobileCounts = count === null ? '<span class="mobile-unavailable">Alert counts unavailable</span>' : severities.map(severity => `<span class="mobile-count"><span class="severity-dot ${severity}"></span>${repo.counts[severity]}<span class="sr-only"> ${severity} alerts</span></span>`).join('');
    const caption = repo.enabled === true ? (repo.pendingScan ? 'Initial scan pending' : !repo.countsReadable ? 'Alert access restricted' : count === 0 ? 'No open alerts' : `${count} open alerts`) : repo.enabled === null ? 'Access restricted' : repo.archived ? 'Archived repository' : repo.admin ? 'Ready to enable' : 'Admin permission required';
    const action = eligible(repo) ? `<button class="row-action enable-action" data-enable="${repo.id}" data-od-id="enable-${repo.id}">${icon('shield')}Enable</button>` : `<button class="row-action icon-button" data-open="${repo.id}" aria-label="View ${escape(repo.name)} details" data-od-id="details-${repo.id}">${icon('chevron')}</button>`;
    return `<tr class="repo-row ${repo.archived ? 'archived-row' : ''}" data-repo="${repo.id}" data-od-id="repo-${repo.id}">
      <td class="repository-cell"><div class="repo-cell">${icon(repo.archived ? 'package' : 'repo')}<div class="repo-name"><button class="repo-open" data-open="${repo.id}" data-od-id="open-${repo.id}"><span>${escape(repo.owner)} / </span><strong>${escape(repo.name)}</strong></button><div class="repo-meta">${repo.visibility === 'Private' ? icon('lock') : ''}<span>${repo.visibility}</span>${repo.archived ? '<span class="archived-label">Archived</span>' : ''}</div></div></div><div class="mobile-counts">${mobileCounts}</div></td>
      <td class="language-cell"><span class="language-dot lang-${repo.language.toLowerCase()}"></span>${repo.language}</td>
      <td class="status-cell">${statusBadge(repo)}<span class="status-caption">${caption}</span></td>
      ${severities.map(severity => `<td class="counts-cell"><span class="severity-count ${count === null ? 'unavailable' : repo.counts[severity] ? severity : 'zero'}" aria-label="${count === null ? `${severity} count unavailable` : `${repo.counts[severity]} ${severity} alerts`}">${count === null ? '—' : repo.counts[severity]}</span></td>`).join('')}
      <td class="actions-cell">${action}</td></tr>`;
  }
  function renderRows() {
    const repos = filterRepos();
    $('#repo-rows').innerHTML = repos.map(rowMarkup).join('');
    $('#no-results').hidden = repos.length !== 0;
    $('.repo-table').hidden = repos.length === 0;
    $('#section-count').textContent = repos.length;
    $('#result-summary').textContent = `Showing ${repos.length} of ${repositories.length} accessible repositories`;
    renderFilterChips();
  }
  function renderFilterChips() {
    const f = state.filters;
    const labels = {org:f.org === 'personal' ? 'Personal repos' : f.org === 'organizations' ? 'All organizations' : f.org, query:`Search: ${f.query}`, status:`Status: ${f.status}`,severity:`Severity: ${f.severity}`,hasAlerts:f.hasAlerts === 'yes' ? 'Has open alerts' : f.hasAlerts === 'no' ? 'Verified zero alerts' : 'Counts unavailable',archived:f.archived === 'active' ? 'Active only' : 'Archived only',attention:'Needs attention'};
    const keys = Object.keys(f).filter(key => key !== 'sort' && f[key] !== defaults[key]);
    $('#active-filters').hidden = !keys.length;
    $('#active-filters').innerHTML = keys.map(key => `<button class="filter-chip" data-clear="${key}" aria-label="Remove ${escape(labels[key])} filter">${escape(labels[key])}${icon('close')}</button>`).join('') + (keys.length ? '<button class="text-button" data-action="clear-filters">Clear all</button>' : '');
    const extra = ['severity','hasAlerts','archived','attention'].filter(key => f[key] !== defaults[key]).length;
    $('#extra-filter-count').hidden = !extra;
    $('#extra-filter-count').textContent = extra;
  }
  function renderCoverage() {
    const groups = state.filters.org === 'all' ? [...organizations, 'alexmorgan'] : [...new Set(ownerScope().map(repo => repo.owner))];
    $('#coverage-view').innerHTML = `<div class="section-heading"><div><h2>Coverage by owner</h2></div><span class="table-hint">Confirmed enablement, not alert volume</span></div><div class="coverage-list">${groups.map(owner => {
      const stats = summarize(repositories.filter(repo => repo.owner === owner));
      return `<article class="coverage-row" data-od-id="coverage-${owner}"><div class="coverage-org"><span class="org-avatar">${owner === 'alexmorgan' ? 'AM' : owner[0].toUpperCase()}</span><div><strong>${owner}</strong><span>${stats.total} repositories${owner === 'alexmorgan' ? ' · personal' : ''}</span></div></div><div class="coverage-bar">${coverageBar(stats)}<div class="coverage-legend"><span>${stats.enabled} enabled</span><span>${stats.disabled} disabled</span><span>${stats.unknown} unknown</span></div></div><div class="coverage-numbers"><strong>${stats.enabled}<span> / ${stats.total}</span></strong><button class="text-button" data-owner-review="${owner}">Review ${icon('arrow')}</button></div></article>`;
    }).join('')}</div><div class="coverage-explainer">${icon('info')}<div><strong>Enabled and readable are two different things.</strong><p>Coverage uses GitHub GraphQL’s <code>hasVulnerabilityAlertsEnabled</code> field. Reading alerts needs separate permissions. A missing field or a 404 stays unknown; it never proves alerts are disabled. Archived repos remain in the denominator.</p></div></div>`;
  }
  function syncControls() {
    const ids = {org:'org-filter',query:'repo-search',status:'status-filter',severity:'severity-filter',hasAlerts:'alerts-filter',archived:'archive-filter',sort:'sort-filter'};
    Object.entries(ids).forEach(([key,id]) => { if ($(`#${id}`).value !== state.filters[key]) $(`#${id}`).value = state.filters[key]; });
    $('#attention-filter').checked = state.filters.attention;
    $$('.org-item').forEach(item => { item.classList.toggle('active', item.dataset.org === state.filters.org); item.setAttribute('aria-pressed', String(item.dataset.org === state.filters.org)); });
  }
  function render() {
    const titles = {overview:'Overview',repositories:'Repositories',coverage:'Coverage'};
    $('#page-title').innerHTML = `${titles[state.view]}<span class="title-dot">.</span>`;
    $('#breadcrumb-current').textContent = titles[state.view];
    $('#page-description').textContent = state.view === 'coverage' ? 'Know where alerts are enabled. Understand where visibility stops.' : state.view === 'repositories' ? 'Find, inspect, and prioritize every repository you can access.' : 'A clear view of your repositories. A shorter path to what needs attention.';
    document.title = `${titles[state.view]} · Dependabot Sitrep`;
    $$('[data-view]').forEach(button => {
      if (!button.classList.contains('nav-item')) return;
      button.classList.toggle('active', button.dataset.view === state.view);
      if (button.dataset.view === state.view) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
    });
    $('#login-state').hidden = state.connected;
    $('#connected-content').hidden = !state.connected;
    $('#refresh-button').hidden = !state.connected;
    $('#scan-time').hidden = !state.connected;
    $('#identity-status').textContent = state.connected ? 'Connected via gh' : 'Authentication required';
    $('#coverage-view').hidden = state.view !== 'coverage';
    $('#repo-section').hidden = state.view === 'coverage';
    renderMetrics(); renderRows(); renderCoverage(); syncControls();
    try { localStorage.setItem('sitrep-preferences', JSON.stringify({view:state.view})); } catch (_) { /* Optional persistence. */ }
  }
  function closeNavigation() {
    const wasOpen = $('#sidebar').classList.contains('open');
    $('#sidebar').classList.remove('open');
    $('#sidebar-scrim').hidden = true;
    $('#menu-button').setAttribute('aria-expanded','false');
    document.body.classList.remove('nav-open');
    $('.workspace').inert = false;
    if (window.matchMedia('(max-width: 700px)').matches) $('#sidebar').inert = true;
    if (wasOpen) $('#menu-button').focus();
  }
  function setView(view) { state.view = view; closeNavigation(); render(); }
  function showToast(message) {
    clearTimeout(toastTimer);
    $('#toast').innerHTML = `${icon('check')}<span>${escape(message)}</span>`;
    $('#toast').hidden = false;
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
  }
  function alertCard(alert) {
    return `<article class="alert-card" data-od-id="alert-${alert.id}"><div class="alert-heading"><span class="alert-package">${icon('package')}<strong>${escape(alert.package)}</strong><span class="ecosystem">${alert.ecosystem}</span></span><span class="severity-badge ${alert.severity}">${alert.severity}</span></div><h3>${escape(alert.title)}</h3><dl class="alert-fields"><div><dt>Vulnerable range</dt><dd><code>${escape(alert.vulnerableRange)}</code></dd></div><div><dt>Fixed in</dt><dd><code class="fix-version">${escape(alert.fixVersion)}</code></dd></div><div class="manifest-field"><dt>Manifest</dt><dd><code>${escape(alert.manifest)}</code></dd></div></dl><a class="advisory-link" href="${escape(alert.advisoryUrl)}" target="_blank" rel="noopener noreferrer">Search GitHub advisories ${icon('external')}</a></article>`;
  }
  function renderDrawer(repo) {
    const count = total(repo);
    let contents;
    if (repo.enabled === false) contents = `<div class="empty-state"><div class="empty-icon">${icon('shield')}</div><h3>Dependabot alerts are disabled.</h3><p>${repo.archived ? 'This repository is archived. Unarchive it in GitHub before changing its settings.' : repo.admin ? 'Enable alerts to start identifying vulnerable dependencies in this repository.' : 'Your account can view this repository, but only a repository admin can enable alerts here.'}</p>${eligible(repo) ? `<button class="btn btn-primary" data-enable="${repo.id}" data-od-id="drawer-enable-${repo.id}">${icon('shield')}Enable alerts</button>` : ''}</div>`;
    else if (repo.enabled === null || !repo.countsReadable) contents = `<div class="empty-state"><div class="empty-icon">${icon('lock')}</div><h3>${repo.pendingScan ? 'Waiting for the first alert scan.' : repo.enabled === true ? 'Enabled. Alert counts unavailable.' : 'Enablement could not be confirmed.'}</h3><p>${escape(repo.reason)}</p>${repo.pendingScan ? `<button class="btn btn-secondary" data-action="refresh-drawer">${icon('refresh')}Run sample scan</button>` : '<button class="btn btn-secondary" data-action="access-help">Understand access</button>'}</div>`;
    else if (count === 0) contents = `<div class="empty-state"><div class="empty-icon success">${icon('shield')}</div><h3>No open alerts.</h3><p>Alerts are enabled and the sample scan returned zero open alerts. This is a point-in-time result, not a security guarantee.</p></div>`;
    else contents = `<div class="detail-tabs"><strong>Open alerts <span>${count}</span></strong><span>Highest severity first</span></div><p class="sample-alert-note">Illustrative alerts for this fictional repository. Package ranges and fixes are demo content; links search the public advisory database.</p>${repo.alerts.map(alertCard).join('')}`;
    $('#repo-drawer').innerHTML = `<header class="drawer-head"><div class="drawer-kicker">REPOSITORY DETAILS <span class="sample-badge">Sample</span></div><button class="icon-button drawer-close" data-close="repo-drawer" aria-label="Close repository details" data-od-id="close-repository-drawer">${icon('close')}</button><div class="drawer-owner">${escape(repo.owner)} /</div><h2 class="drawer-title" id="drawer-title" data-od-id="drawer-title">${escape(repo.name)}</h2><div class="drawer-meta"><span class="language-dot lang-${repo.language.toLowerCase()}"></span>${repo.language}<span>·</span>${repo.visibility}<span>·</span>${repo.admin ? 'Admin access' : 'Read access'}${repo.archived ? '<span class="archived-label">Archived</span>' : ''}</div></header><div class="drawer-body"><div class="detail-summary"><div><span>Dependabot alerts</span>${statusBadge(repo)}</div><div><span>Open alerts</span><strong>${count === null ? 'Unavailable' : count}</strong></div><div><span>Alert read access</span><strong>${repo.enabled === false ? 'Not assessed' : repo.pendingScan ? 'Pending scan' : repo.countsReadable ? 'Granted' : 'Restricted'}</strong></div></div>${contents}<details class="status-method"><summary>How this status is determined</summary><p>Enablement uses the planned GraphQL signal <code>hasVulnerabilityAlertsEnabled</code>: <strong>${repo.enabled === null ? 'unavailable' : repo.enabled}</strong>. Alert counts require a separate successful read. A 404 alone never means disabled.</p></details></div><footer class="drawer-footer">${icon('terminal')}Local sample data · no GitHub requests</footer>`;
  }
  function openRepo(id) {
    const repo = repositories.find(item => item.id === id);
    if (!repo) return;
    state.activeRepo = id;
    renderDrawer(repo);
    $('#repo-drawer').showModal();
    $('#repo-drawer').querySelector('[data-close]').focus();
  }
  function openEnable(id) {
    const repo = repositories.find(item => item.id === id);
    if (!eligible(repo) || !state.connected) { showToast('Enabling requires admin permission on an active, disabled repository.'); return; }
    state.pendingEnable = id;
    $('#enable-modal').innerHTML = `<header class="modal-head"><div class="modal-icon">${icon('shield')}</div><button class="icon-button" data-close="enable-modal" aria-label="Cancel enabling alerts">${icon('close')}</button></header><div class="modal-body"><span class="eyebrow">ONE REPOSITORY · SAMPLE CHANGE</span><h2 id="enable-title">Enable Dependabot alerts?</h2><p>This change is scoped to the repository below. Your sample account has admin permission.</p><div class="confirm-repo">${icon('repo')}<span>${escape(repo.owner)} / <strong>${escape(repo.name)}</strong></span><span class="permission-badge">Admin</span></div><ul class="scope-list"><li>${icon('check')}<span>Enable the <strong>dependency graph</strong> to identify dependencies.</span></li><li>${icon('check')}<span>Enable <strong>Dependabot alerts</strong> for vulnerable dependencies.</span></li></ul><p class="permission-note">Security update pull requests, version updates, and organization defaults are unchanged. Alert counts stay unavailable until a new scan completes.</p><label class="checkbox-line"><input type="checkbox" id="enable-ack" data-od-id="acknowledge-enable"><span>I understand this applies to this repository only.</span></label><div class="sample-confirm-note">Sample mode: confirmation changes this page only. GitHub is never contacted.</div></div><footer class="modal-footer"><button class="btn btn-secondary" data-close="enable-modal" data-od-id="cancel-enable">Cancel</button><button class="btn btn-primary" id="confirm-enable" disabled data-od-id="confirm-enable">Enable in sample</button></footer>`;
    $('#enable-modal').showModal();
    $('#enable-modal').querySelector('[data-close]').focus();
  }
  function confirmEnable() {
    const repo = repositories.find(item => item.id === state.pendingEnable);
    if (!eligible(repo) || !$('#enable-ack')?.checked || !state.connected) return;
    repo.enabled = true;
    repo.pendingScan = true;
    repo.counts = null;
    repo.countsReadable = false;
    repo.reason = 'Alerts were enabled in this sample session. Refresh repositories to simulate the initial alert scan; no alert count is assumed before that scan.';
    $('#enable-modal').close();
    state.pendingEnable = null;
    render();
    if ($('#repo-drawer').open && state.activeRepo === repo.id) renderDrawer(repo);
    showToast(`Alerts enabled for ${repo.name} in the sample. Refresh to scan.`);
  }
  function refresh() {
    if (state.scanning || !state.connected) return;
    state.scanning = true;
    $('#scan-notice').hidden = false;
    $('#refresh-button').disabled = true;
    $('#refresh-button').classList.add('is-scanning');
    $('#refresh-button span').textContent = 'Scanning…';
    $('#scan-fill').style.width = '0%';
    $('#scan-message').textContent = 'Discovering accessible repositories…';
    $('#scan-count').textContent = '0 / 12';
    let scanned = 0;
    scanTimer = setInterval(() => {
      scanned = Math.min(scanned + 2, repositories.length);
      $('#scan-count').textContent = `${scanned} / ${repositories.length}`;
      $('#scan-fill').style.width = `${scanned / repositories.length * 100}%`;
      $('#scan-message').textContent = scanned < 4 ? 'Discovering accessible repositories…' : scanned < 10 ? 'Checking enablement and alert read access…' : 'Finishing scan · preserving partial-access results…';
      if (scanned === repositories.length) {
        clearInterval(scanTimer);
        repositories.filter(repo => repo.pendingScan).forEach(repo => {
          repo.pendingScan = false;
          repo.countsReadable = true;
          repo.counts = {critical:0,high:0,medium:0,low:0};
          repo.alerts = [];
          repo.reason = '';
        });
        state.scanning = false;
        state.lastScan = new Date();
        $('#scan-notice').hidden = true;
        $('#refresh-button').disabled = false;
        $('#refresh-button').classList.remove('is-scanning');
        $('#refresh-button span').textContent = 'Refresh repos';
        $('#scan-time').textContent = `Sample scan · ${state.lastScan.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
        render();
        if ($('#repo-drawer').open) renderDrawer(repositories.find(repo => repo.id === state.activeRepo));
        showToast('Sample scan complete. 12 repos checked; 2 access limits remain.');
      }
    }, 470);
  }
  function accessHelp() {
    $('#connection-modal').innerHTML = `<header class="modal-head"><div class="modal-icon">${icon('lock')}</div><button class="icon-button" data-close="connection-modal" aria-label="Close access information">${icon('close')}</button></header><div class="modal-body"><span class="eyebrow">PARTIAL ACCESS</span><h2 id="connection-title">Visible doesn’t always mean readable.</h2><p>Your account may see a repository without permission to read its Dependabot alerts. Contact a repository admin to review security-alert access and your token’s permissions.</p><div class="connection-row"><strong>meridian-tools / data-pipeline</strong><span>Enabled · alert counts restricted</span></div><div class="connection-row"><strong>fieldwork-studio / assets-service</strong><span>Enablement unknown · 404 is inconclusive</span></div><p class="permission-note">Sitrep keeps these states separate and never reports missing counts as zero. The prototype uses illustrative permissions only.</p></div><footer class="modal-footer"><button class="btn btn-secondary" data-close="connection-modal">Got it</button><a class="btn btn-primary" href="https://docs.github.com/en/code-security/how-tos/manage-security-alerts/grant-access-to-security-alerts" target="_blank" rel="noopener noreferrer">GitHub access docs ${icon('external')}</a></footer>`;
    $('#connection-modal').showModal();
  }
  function showConnection() {
    if (!state.connected) { $('#login-state').focus(); return; }
    $('#connection-modal').innerHTML = `<header class="modal-head"><div class="modal-icon">${icon('terminal')}</div><button class="icon-button" data-close="connection-modal" aria-label="Close session details">${icon('close')}</button></header><div class="modal-body"><span class="eyebrow">LOCAL SESSION</span><h2 id="connection-title">Your CLI. Your credentials.</h2><p>Sitrep is designed to use your authenticated GitHub CLI. This frontend uses a fictional identity and sample repositories.</p><div class="connection-state"><span class="identity-avatar">AM</span><div><strong>alexmorgan</strong><span>github.com · Sample connection</span></div><span class="status-badge enabled">Connected</span></div><div class="connection-row"><span>Authentication</span><strong>GitHub CLI (gh)</strong></div><div class="connection-row"><span>Data source</span><strong>Local sample fixtures</strong></div><div class="connection-row"><span>Repository access</span><strong>12 repos · partial alert visibility</strong></div><p class="permission-note">No tokens are collected or stored. Ending this local session shows the GitHub CLI setup flow; your fixture changes remain in memory.</p></div><footer class="modal-footer"><button class="btn btn-ghost" id="end-session">${icon('logout')}End local session</button><button class="btn btn-primary" data-close="connection-modal">Done</button></footer>`;
    $('#connection-modal').showModal();
  }
  document.addEventListener('click', async event => {
    const target = event.target.closest('button, a, [data-repo]');
    if (!target) return;
    if (target.dataset.view) { event.preventDefault(); setView(target.dataset.view); }
    else if (target.dataset.org) { state.filters.org = target.dataset.org; state.view = 'repositories'; closeNavigation(); render(); }
    else if (target.dataset.open) openRepo(target.dataset.open);
    else if (target.dataset.enable) openEnable(target.dataset.enable);
    else if (target.dataset.close) $(`#${target.dataset.close}`).close();
    else if (target.dataset.clear) { state.filters[target.dataset.clear] = defaults[target.dataset.clear]; render(); }
    else if (target.dataset.ownerReview) { state.filters = {...defaults,org:target.dataset.ownerReview}; setView('repositories'); }
    else if (target.dataset.action === 'clear-filters') { state.filters = {...defaults}; render(); }
    else if (target.dataset.action === 'access-help') accessHelp();
    else if (target.dataset.action === 'close-navigation') closeNavigation();
    else if (target.dataset.action === 'refresh-drawer') { $('#repo-drawer').close(); refresh(); }
    else if (target.dataset.copy) {
      try { await navigator.clipboard.writeText(target.dataset.copy); showToast('Command copied. Run it in your own terminal.'); }
      catch (_) { showToast('Copy this command: gh auth login'); }
    }
    else if (target.id === 'refresh-button') refresh();
    else if (target.id === 'show-attention') { state.filters = {...defaults, org:state.filters.org,attention:true}; setView('repositories'); }
    else if (target.id === 'review-access') accessHelp();
    else if (target.id === 'identity-button') showConnection();
    else if (target.id === 'confirm-enable') confirmEnable();
    else if (target.id === 'end-session') {
      $('#connection-modal').close();
      clearInterval(scanTimer);
      state.scanning = false;
      state.connected = false;
      $('#scan-notice').hidden = true;
      $('#refresh-button').disabled = false;
      $('#refresh-button').classList.remove('is-scanning');
      $('#refresh-button span').textContent = 'Refresh repos';
      render();
      $('#login-state').focus();
    }
    else if (target.id === 'reconnect-button') {
      target.disabled = true;
      target.innerHTML = `${icon('refresh','spinning')}Checking sample connection…`;
      setTimeout(() => { state.connected = true; target.disabled = false; target.innerHTML = `${icon('refresh')}Check connection`; render(); showToast('Sample gh connection restored. No commands were executed.'); }, 900);
    }
    else if (target.id === 'menu-button') {
      const open = !$('#sidebar').classList.contains('open');
      $('#sidebar').inert = !open;
      $('#sidebar').classList.toggle('open', open);
      $('#sidebar-scrim').hidden = !open;
      target.setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('nav-open',open);
      $('.workspace').inert = open;
      if (open) $('#sidebar .nav-item').focus();
    }
    else if (target.id === 'more-filters') { const open = $('#filter-panel').hidden; $('#filter-panel').hidden = !open; target.setAttribute('aria-expanded',String(open)); }
    else if (target.dataset.repo) openRepo(target.dataset.repo);
  });
  document.addEventListener('change', event => {
    const map = {'org-filter':'org','status-filter':'status','severity-filter':'severity','alerts-filter':'hasAlerts','archive-filter':'archived','sort-filter':'sort'};
    if (map[event.target.id]) { state.filters[map[event.target.id]] = event.target.value; render(); }
    if (event.target.id === 'attention-filter') { state.filters.attention = event.target.checked; render(); }
    if (event.target.id === 'enable-ack') $('#confirm-enable').disabled = !event.target.checked;
  });
  $('#repo-search').addEventListener('input', event => { state.filters.query = event.target.value; renderRows(); });
  $('#sidebar-scrim').addEventListener('click',closeNavigation);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeNavigation();
    if (event.key === '/' && !['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName) && !$$('dialog').some(dialog => dialog.open) && state.connected && state.view !== 'coverage') { event.preventDefault(); $('#repo-search').focus(); }
    if (event.key === 'Tab' && $('#sidebar').classList.contains('open') && window.matchMedia('(max-width: 700px)').matches) {
      const focusable = [...$('#sidebar').querySelectorAll('a,button')];
      if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); }
      if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); }
    }
  });
  $$('dialog').forEach(dialog => {
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
  });
  const mobileQuery = window.matchMedia('(max-width: 700px)');
  const syncSidebar = () => { if (!mobileQuery.matches) closeNavigation(); $('#sidebar').inert = mobileQuery.matches && !$('#sidebar').classList.contains('open'); };
  mobileQuery.addEventListener('change',syncSidebar);
  syncSidebar();
  render();
  // Read-only test surface for later Node adapters; sample changes are intentionally in memory.
  Object.defineProperty(window, 'SitrepPrototype', {value:{repositories, summarize, filterRepos, needsAttention, eligible, state}, writable:false});
})();
