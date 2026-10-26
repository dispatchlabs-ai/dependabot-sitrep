export function normalizeOwnerScope(value) {
  if (['all', 'organizations', 'personal'].includes(value)) return value;
  if (!Array.isArray(value) || value.some(owner => typeof owner !== 'string' || !owner.trim())) return 'all';
  return [...new Set(value.map(owner => owner.trim()))];
}

export function scopeRepositories(repositories, value, login) {
  const scope = normalizeOwnerScope(value);
  const selected = Array.isArray(scope) ? new Set(scope) : null;
  return repositories.filter(repo => {
    if (selected) return selected.has(repo.owner);
    if (scope === 'organizations') return repo.ownerType === 'Organization';
    if (scope === 'personal') return typeof login === 'string' && login.length > 0 && repo.owner === login;
    return true;
  });
}
