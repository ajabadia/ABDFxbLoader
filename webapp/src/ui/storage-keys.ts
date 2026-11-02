/**
 * Claves de `localStorage` de la WebUI, en un solo sitio.
 *
 * Conviven dos prefijos y es a propósito:
 *
 * - `abdsynths.*` es de la suite. `@abdsynths/shared` crea su motor de i18n con
 *   `abdsynths.locale` por defecto (`DEFAULT_STORAGE_KEY` en
 *   `Components/I18n/index.js`) y el estándar de idiomas lo documenta como clave
 *   compartida: si el usuario elige español en un sintetizador de ABDSynths,
 *   fxbLoader abre también en español. Renombrarla a `fxbLoader.locale` cortaría
 *   esa continuidad sin ganar nada.
 * - `fxbLoader.*` es estado propio del producto: rutas, historiales, tarea de
 *   captura y el tema. No se comparte con la suite porque el tema de fxbLoader
 *   es su propia paleta de utilidades, no el del sintetizador que el usuario
 *   tenga abierto al lado; pisarlo desde otra app sería un efecto colateral.
 *
 * Los dos prefijos se comprueban en `test/storage-keys.test.ts`.
 */

/** Idioma de la suite (la escribe el motor de `@abdsynths/shared`). */
export const STORAGE_LOCALE = 'abdsynths.locale';

/** Librería VFX activa. */
export const STORAGE_ROOT = 'fxbLoader.libraryRoot';

/** DLL de carga elegida como fuente. */
export const STORAGE_DLL = 'fxbLoader.dllSource';

/** Historial de librerías, DLL y bancos recientes. */
export const STORAGE_RECENT_ROOTS = 'fxbLoader.recentLibraryRoots';
export const STORAGE_RECENT_DLLS = 'fxbLoader.recentDlls';
export const STORAGE_RECENT_BANKS = 'fxbLoader.recentBanks';

/** Captura de instalación en curso, para poder retomarla al recargar. */
export const STORAGE_CAPTURE_TASK = 'fxbLoader.captureTask';

/** Modo de tema (`auto` | `dark` | `light`). */
export const STORAGE_THEME = 'fxbLoader.theme';
