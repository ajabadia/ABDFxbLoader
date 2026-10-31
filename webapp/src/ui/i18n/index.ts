/**
 * i18n de la WebUI de fxbLoader.
 *
 * Sigue el estándar de la suite (`ABDShared/Docs/architecture/I18N_MULTI_LANGUAGE_STANDARD.md`):
 * capa 1 = diccionarios comunes de `@abdsynths/shared/i18n`, capa 2 = este
 * diccionario propio. El idioma por defecto es inglés y se guarda en la misma
 * clave que el resto de la suite (`abdsynths.locale`).
 */
import { createSynthI18n } from '@abdsynths/shared/i18n';
import { appEn } from './locales/en.js';
import { appEs } from './locales/es.js';

export type Locale = 'en' | 'es';

const i18n = createSynthI18n<Locale>({
  locales: { en: appEn, es: appEs },
  defaultLocale: 'en',
  storageKey: 'abdsynths.locale',
});

export const { getLocale, setLocale, onLocaleChange, t, applyI18n, getSupportedLocales } = i18n;
export { appEn, appEs };

/** `lang` del documento = idioma activo (lectores de pantalla y heurísticas del navegador). */
export function syncDocumentLang(locale: Locale = getLocale()): void {
  document.documentElement.lang = locale;
}

export function initAppI18n(): Locale {
  const locale = i18n.initI18n();
  syncDocumentLang(locale);
  return locale;
}
