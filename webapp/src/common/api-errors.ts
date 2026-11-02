/**
 * Códigos estables de error del API.
 *
 * El mensaje del servidor va en el idioma del servidor (castellano) y no puede
 * cambiar con la vista. El código sí: la UI traduce `msg.apiError.<code>` con
 * los parámetros que manda el servidor y, si no hay traducción, cae al mensaje
 * recibido. El mensaje no se traduce: también lo leen los logs y las pruebas.
 */

export const API_ERROR_CODES = [
  'libraryRootRequired',
  'libraryRootRelative',
  'plugsMissing',
  'packagePathMissing',
  'vfxinfoMissing',
  'loaderMissing',
  'batchActionInvalid',
  'batchPluginsEmpty',
  'banksEmpty',
  'tooManyBanks',
  'bankExtensionInvalid',
  'fileEmpty',
  'wizardCatalogUnavailable',
  'wizardNotFound',
  'driveNotFound',
  'pluginFolderMissing',
  'libraryNameInvalid',
  'notEnoughSpace',
  'copyMismatch',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorDetails {
  code: ApiErrorCode;
  /** Valores para `{0}`, `{1}`… del texto traducido. */
  params?: Record<string, string | number>;
}

/**
 * Base de las excepciones de dominio que viajan al cliente con un código. El
 * campo es `apiCode` y no `code` porque `code` ya lo usan los errores de Node
 * (`ENOENT`, `EACCES`…): escribirlo encima convertiría un fallo de sistema en
 * un error de validación.
 */
export class CodedError extends Error {
  readonly apiCode?: ApiErrorCode;
  readonly apiParams?: Record<string, string | number>;

  constructor(
    message: string,
    apiCode?: ApiErrorCode,
    apiParams?: Record<string, string | number>,
  ) {
    super(message);
    this.apiCode = apiCode;
    this.apiParams = apiParams;
  }
}

/** Código y parámetros de un error, si los lleva. */
export function apiErrorDetails(error: unknown): ApiErrorDetails | null {
  if (typeof error !== 'object' || error === null) return null;
  const { apiCode, apiParams } = error as { apiCode?: unknown; apiParams?: unknown };
  if (typeof apiCode !== 'string') return null;
  const params =
    typeof apiParams === 'object' && apiParams !== null
      ? (apiParams as Record<string, string | number>)
      : undefined;
  return params === undefined
    ? { code: apiCode as ApiErrorCode }
    : { code: apiCode as ApiErrorCode, params };
}
