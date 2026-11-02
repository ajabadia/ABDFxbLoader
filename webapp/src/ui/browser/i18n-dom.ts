/**
 * Lo unico del i18n que toca el documento: el `lang` del `<html>` y el
 * arranque del motor en la pagina. Vive en la capa de navegador porque el
 * resto del i18n (`src/ui/i18n`) tambien lo usa el servidor, que no tiene DOM.
 */
import { getLocale, initI18n, type Locale } from '../i18n/index.js';

/** `lang` del documento = idioma activo (lectores de pantalla y heuristicas). */
export function syncDocumentLang(locale: Locale = getLocale()): void {
  document.documentElement.lang = locale;
}

export function initAppI18n(): Locale {
  const locale = initI18n();
  syncDocumentLang(locale);
  return locale;
}