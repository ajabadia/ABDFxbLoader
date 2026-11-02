import { t } from './i18n/index.js';

/**
 * Texto del resumen del paso 4 de la captura: cuántos archivos previos a la
 * captura entran en el paquete antes de generar. El recuento sale de
 * `GET /capture/pre-existing/:diffId`, que mira el snapshot inicial; aquí solo
 * se decide cómo se cuenta y qué pasa al desmarcar la casilla. No toca el DOM,
 * así que se prueba con datos simples.
 */

export interface PreExistingSummaryInput {
  /** Archivos previos que entrarían; `null` mientras no se ha consultado. */
  count: number | null;
  /** Estado de «incluir los archivos que ya existían antes de la captura». */
  include: boolean;
  /** Aviso del servidor (por ejemplo, snapshot inicial irrecuperable). */
  warning?: string;
}

/** «1 archivo previo» / «N archivos previos», sin el clásico «1 archivos». */
function filesLabel(count: number): string {
  return count === 1 ? t('msg.captureFilesOne') : t('msg.captureFilesMany', { 0: count });
}

/** Línea del paso 4; vacía cuando todavía no hay recuento que enseñar. */
export function formatPreExistingSummary(input: PreExistingSummaryInput): string {
  const warning = input.warning?.trim() ?? '';
  if (warning !== '') return warning;
  const count = input.count;
  if (count === null) return '';

  if (!input.include) {
    return count === 0
      ? t('msg.captureNoPrevExcluded')
      : t('msg.capturePrevExcluded', { 0: filesLabel(count) });
  }
  return count === 0
    ? t('msg.captureNoPrevIncluded')
    : t('msg.capturePrevIncluded', { 0: filesLabel(count) });
}

/**
 * Rótulo del desplegable que enseña, uno a uno, los archivos previos que van a
 * entrar en el paquete. El recuento ya lo dice la línea de al lado; esto dice
 * cuáles.
 */
export function preExistingListLabel(count: number): string {
  return count === 1 ? t('msg.captureListOne') : t('msg.captureListMany', { 0: count });
}

/** Nombre accesible del botón que enseña un previo en el Explorador. */
export function revealPreExistingLabel(file: string): string {
  return t('msg.captureRevealLabel', { 0: file });
}

/**
 * Confirmación de la apertura. El servidor devuelve la ruta absoluta que abrió;
 * si no llega, se nombra la relativa del listado, que es la que el usuario ve.
 */
export function formatRevealPreExistingResult(file: string, opened: string): string {
  const target = opened.trim() === '' ? file : opened;
  return t('msg.captureRevealed', { 0: target });
}

export interface StagingEntry {
  /** Ruta tal como la devuelve `GET /capture/staging/:diffId`. */
  path: string;
  /** Ya existía antes de la captura: lo aporta el snapshot inicial. */
  preExisting: boolean;
}

/**
 * Clave comparable de una ruta relativa: `listStaging` la da con el separador
 * del sistema (`Program Files\VstPlugins\P8.dll`) y el snapshot con `/`. En
 * Windows además el disco no distingue mayúsculas.
 */
function stagingKey(value: string): string {
  return value
    .split(/[\\/]+/)
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/')
    .toLowerCase();
}

/**
 * Marca cada archivo del staging con si ya existía antes de la captura. La
 * lista de previos sale de `GET /capture/pre-existing/:diffId`, que ya descuenta
 * lo que se haya quitado del staging, así que una ruta que no aparezca ahí es
 * de la captura.
 */
export function classifyStagingFiles(
  files: readonly string[],
  preExisting: readonly string[],
): StagingEntry[] {
  const known = new Set(preExisting.map(stagingKey));
  return files.map((file) => ({ path: file, preExisting: known.has(stagingKey(file)) }));
}

/** Rótulo del botón que quita de golpe todos los previos del staging. */
export function removePreExistingLabel(preExistingStaged: number): string {
  return preExistingStaged === 1 ? t('msg.captureRemoveOne') : t('msg.captureRemoveMany', { 0: preExistingStaged });
}

/** Resumen de la acción, con el recuento en singular cuando solo se quitó uno. */
export function formatRemovePreExistingResult(removed: number, total: number): string {
  return removed === 1 && total === 1
    ? t('msg.captureRemovedOne')
    : t('msg.captureRemovedMany', { 0: removed, 1: total });
}

/** Rótulo del botón que devuelve al staging los previos recién quitados. */
export function restorePreExistingLabel(restorable: number): string {
  return restorable === 1 ? t('msg.captureRestoreOne') : t('msg.captureRestoreMany', { 0: restorable });
}

/**
 * Línea que abre el bloque de previos quitados con la × en el staging: lo que
 * el paquete no llevaría y todavía se puede devolver, uno a uno.
 */
export function removedStagingNote(count: number): string {
  return count === 1
    ? t('msg.captureRemovedNoteOne')
    : t('msg.captureRemovedNoteMany', { 0: count });
}

/** Nombre accesible del botón que devuelve un único previo quitado. */
export function restoreStagedFileLabel(file: string): string {
  return t('msg.captureRestoreFileLabel', { 0: file });
}

/** Qué pasó al pedir de vuelta un único archivo quitado con la ×. */
export type RestoreStagedFileOutcome = 'restored' | 'missing' | 'present';

/**
 * Resultado de deshacer un borrado suelto. `present` es el caso de pulsar dos
 * veces: el archivo ya estaba de vuelta, así que no es un error.
 */
export function formatRestoreStagedFileResult(
  file: string,
  outcome: RestoreStagedFileOutcome,
): string {
  if (outcome === 'restored') return t('msg.captureRestoredFile', { 0: file });
  if (outcome === 'missing') return t('msg.captureRestoreGone', { 0: file });
  return t('msg.captureAlreadyStaged', { 0: file });
}

/**
 * Resumen de la recuperación. Los que ya no están en el origen se cuentan
 * aparte: la copia se hizo, pero ese archivo no vuelve al paquete.
 */
export function formatRestorePreExistingResult(restored: number, missing: number): string {
  const base =
    restored === 0
      ? t('msg.captureNoneRestored')
      : restored === 1
        ? t('msg.captureRestoredOne')
        : t('msg.captureRestoredMany', { 0: restored });
  if (missing === 0) return base;
  return base + (missing === 1 ? t('msg.captureMissingOne') : t('msg.captureMissingMany', { 0: missing }));
}
