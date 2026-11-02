/**
 * i18n de la WebUI de fxbLoader.
 *
 * Sigue el estándar de la suite (`ABDShared/Docs/architecture/I18N_MULTI_LANGUAGE_STANDARD.md`):
 * capa 1 = diccionarios comunes de `@abdsynths/shared/i18n`, capa 2 = este
 * diccionario propio. El idioma por defecto es inglés y se guarda en la misma
 * clave que el resto de la suite (`abdsynths.locale`).
 */
import { createSynthI18n } from '@abdsynths/shared/i18n';
import { STORAGE_LOCALE } from '../storage-keys.js';
import { appEn } from './locales/en.js';
import { appEs } from './locales/es.js';

export type Locale = 'en' | 'es';

const i18n = createSynthI18n<Locale>({
  locales: { en: appEn, es: appEs },
  defaultLocale: 'en',
  storageKey: STORAGE_LOCALE,
});

// El idioma guardado se resuelve al crear el módulo, no en el arranque de la
// app: lo que se evalúa a nivel de módulo (etiquetas de tablas, mapas de tipos
// de evento) sale así en el idioma del usuario y no en el de reserva.
i18n.initI18n();

export const {
  getLocale,
  setLocale,
  onLocaleChange,
  t,
  applyI18n,
  initI18n,
  getSupportedLocales,
} = i18n;
export { appEn, appEs };
