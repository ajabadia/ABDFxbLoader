import { getLocale, onLocaleChange, type Locale } from '../../../i18n/index.js';
import { els } from '../../elements.js';
import { t } from '../../../i18n/index.js';

const langIcons = [...els.langToggle.querySelectorAll<SVGElement>('[data-icon]')];

export function applyLanguage(): void {
  const locale = getLocale();
  els.langToggle.title = locale === 'es' ? t('title.langToEn') : t('title.langToEs');
  els.langToggle.setAttribute('aria-label', els.langToggle.title);
  document
    .querySelector('input[name="theme-mode"]')
    ?.closest('[role="radiogroup"]')
    ?.setAttribute('aria-label', t('settings.themeGroup'));
  for (const icon of langIcons) {
    icon.toggleAttribute('hidden', icon.dataset['icon'] !== locale);
  }
}

export function initLanguage(applyLocaleFn: (locale: Locale) => void): void {
  onLocaleChange(() => {
    applyLanguage();
  });
  els.langToggle.addEventListener('click', () => {
    const locale = getLocale() === 'es' ? 'en' : 'es';
    applyLocaleFn(locale);
  });
  applyLanguage();
}
