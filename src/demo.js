const advisory = {
  critical: ['Remote code execution in build runner', 'build-runner', 'npm', '< 4.2.3', '4.2.3'],
  high: ['Request parsing can bypass access controls', 'request-router', 'npm', '< 3.9.2', '3.9.2'],
  medium: ['Regular expression denial of service', 'string-utils', 'npm', '< 2.8.1', '2.8.1'],
  low: ['Sensitive configuration may appear in logs', 'config-reader', 'pip', '< 1.4.6', '1.4.6'],
};

function alertsFor(fullName, levels) {
  return levels.map((severity, index) => {
    const [summary, packageName, ecosystem, vulnerableRange, patchedVersion] = advisory[severity];
    return {
      number: index + 1, url: `https://github.com/${fullName}/security/dependabot/${index + 1}`,
      package: packageName, ecosystem, severity, summary,
      manifest: ecosystem === 'pip' ? 'requirements.txt' : 'package-lock.json', vulnerableRange, patchedVersion,
      advisoryUrl: null, createdAt: `2026-10-${String(20 - index).padStart(2, '0')}T09:30:00.000Z`,
    };
  });
}

export function createDemoSnapshot(clock = () => Date.now()) {
  const now = new Date(clock()).toISOString();
  const definitions = [
    ['northstar-labs', 'api-gateway', 'TypeScript', 'ADMIN', true, ['critical', 'high', 'high', 'medium']],
    ['northstar-labs', 'customer-portal', 'TypeScript', 'WRITE', true, ['high', 'medium', 'medium']],
    ['northstar-labs', 'design-system', 'TypeScript', 'ADMIN', true, []],
    ['northstar-labs', 'internal-tools', 'JavaScript', 'ADMIN', false, []],
    ['orbit-engineering', 'billing-service', 'Python', 'ADMIN', true, ['high', 'medium', 'low']],
    ['orbit-engineering', 'data-pipeline', 'Python', 'READ', true, [], 'unavailable'],
    ['orbit-engineering', 'legacy-dashboard', 'JavaScript', 'ADMIN', false, [], 'disabled', true],
    ['harbor-collective', 'marketing-site', 'JavaScript', 'ADMIN', true, ['medium', 'low']],
    ['harbor-collective', 'mobile-api', 'Go', 'MAINTAIN', false, []],
    ['harbor-collective', 'shared-services', 'Go', 'WRITE', null, [], 'unavailable'],
    ['alexchen', 'weekend-project', 'TypeScript', 'ADMIN', true, ['low']],
    ['alexchen', 'dotfiles', 'Shell', 'ADMIN', false, []],
  ];
  const repositories = definitions.map(([owner, name, language, permission, enabled, levels, state, archived = false], index) => {
    const fullName = `${owner}/${name}`;
    const alerts = alertsFor(fullName, levels);
    const counts = enabled && state !== 'unavailable' ? { total: alerts.length, critical: 0, high: 0, medium: 0, low: 0 } : null;
    for (const alert of alerts) counts[alert.severity]++;
    return {
      id: String(1001 + index), owner, ownerType: owner === 'alexchen' ? 'User' : 'Organization',
      name, fullName, url: `https://github.com/${fullName}`, language,
      private: owner !== 'alexchen' && name !== 'marketing-site', archived, permission,
      alertsEnabled: enabled, scanState: state || (enabled ? 'complete' : 'disabled'), counts, alerts,
      canEnable: enabled === false && permission === 'ADMIN' && !archived, checkedAt: now,
      error: state === 'unavailable' ? 'Your GitHub CLI identity does not have access to Dependabot alert details for this repository.' : null,
    };
  });
  return {
    session: { login: 'alexchen', host: 'github.com', connected: true },
    scan: { status: 'complete', phase: 'complete', startedAt: now, completedAt: now, total: repositories.length, processed: repositories.length, error: null, retryAt: null },
    repositories,
    warnings: ['Demo data is fictional. Repository changes are simulated locally.'],
    demo: true,
  };
}
