import { t } from '../../../i18n/index.js';
import { STORAGE_THEME } from '../../../storage-keys.js';
import { els } from '../../elements.js';

export type ThemeMode = 'auto' | 'dark' | 'light';

const themeIcons = [...els.themeToggle.querySelectorAll<SVGElement>('[data-icon]')];
const themeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="theme-mode"]')];
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme(mode: ThemeMode): void {
  if (mode === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    els.themeToggle.title = t('title.themeDark');
  } else if (mode === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    els.themeToggle.title = t('title.themeLight');
  } else {
    document.documentElement.removeAttribute('data-theme');
    els.themeToggle.title = t('title.themeAuto');
  }

  els.themeToggle.setAttribute('aria-label', els.themeToggle.title);

  const shown = mode === 'auto' ? (prefersDark.matches ? 'dark' : 'light') : mode;
  for (const icon of themeIcons) {
    icon.toggleAttribute('hidden', icon.dataset['icon'] !== shown);
  }

  for (const input of themeInputs) input.checked = input.value === mode;
}

export function readTheme(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_THEME);
  return stored === 'dark' || stored === 'light' ? stored : 'auto';
}

export function setTheme(mode: ThemeMode): void {
  localStorage.setItem(STORAGE_THEME, mode);
  applyTheme(mode);
}

export function cycleTheme(): void {
  const current = readTheme();
  setTheme(current === 'auto' ? 'dark' : current === 'dark' ? 'light' : 'auto');
}

export function initTheme(): void {
  applyTheme(readTheme());

  prefersDark.addEventListener('change', () => {
    if (readTheme() === 'auto') applyTheme('auto');
  });

  els.themeToggle.addEventListener('click', cycleTheme);

  for (const input of themeInputs) {
    input.addEventListener('change', () => {
      if (input.checked) setTheme(input.value as ThemeMode);
    });
  }
}
