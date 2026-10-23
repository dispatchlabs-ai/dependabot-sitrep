/* Apply the saved appearance before styles load to avoid flashing the wrong theme. */
(() => {
  'use strict';
  const storageKey = 'sitrep-theme';
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try {
    const saved = localStorage.getItem(storageKey);
    if (['system', 'light', 'dark'].includes(saved)) preference = saved;
  } catch { /* Storage is optional. */ }

  function applyTheme() {
    const root = document.documentElement;
    root.dataset.theme = preference === 'system' ? systemTheme.matches ? 'dark' : 'light' : preference;
    root.dataset.themePreference = preference;
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference));
    });
    const color = getComputedStyle(root).getPropertyValue('--theme-color').trim();
    if (color) document.querySelector('meta[name="theme-color"]').content = color;
  }

  applyTheme();
  document.addEventListener('DOMContentLoaded', applyTheme, { once: true });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-theme-choice]');
    if (!button) return;
    preference = button.dataset.themeChoice;
    applyTheme();
    try { localStorage.setItem(storageKey, preference); } catch { /* Storage is optional. */ }
  });
  systemTheme.addEventListener('change', () => {
    if (preference === 'system') applyTheme();
  });
})();
