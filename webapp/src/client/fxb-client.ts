import type { paths } from './api-types';

/**
 * Cliente tipado construido sobre los tipos que `openapi-typescript` genera a
 * partir de `openapi.json` (ver `npm run client`). No tiene dependencias en
 * tiempo de ejecución: usa `fetch`.
 *
 * Los tipos de petición, respuesta y error se derivan del propio contrato, así
 * que un cambio en un DTO rompe la compilación del cliente y de la UI que lo use.
 */

type Operation<P extends keyof paths, M extends keyof paths[P]> = paths[P][M];

/** Cuerpo JSON de una petición. */
export type RequestBody<
  P extends keyof paths,
  M extends keyof paths[P],
> = Operation<P, M> extends { requestBody: { content: { 'application/json': infer Body } } }
  ? Body
  : never;

/** Cuerpo JSON del 200. */
export type SuccessBody<
  P extends keyof paths,
  M extends keyof paths[P],
> = Operation<P, M> extends { responses: { 200: { content: { 'application/json': infer Body } } } }
  ? Body
  : never;

type JsonContent<Response> = Response extends {
  content: { 'application/json': infer Body };
}
  ? Body
  : never;

/** Unión de los cuerpos JSON de todos los códigos de error documentados. */
export type ErrorBody<
  P extends keyof paths,
  M extends keyof paths[P],
> = Operation<P, M> extends { responses: infer Responses }
  ? {
      [Status in keyof Responses]: Status extends 200 ? never : JsonContent<Responses[Status]>;
    }[keyof Responses]
  : never;

export type LibraryScanResponse = SuccessBody<'/library/scan', 'post'>;
export type LibraryInstallResponse = SuccessBody<'/library/install', 'post'>;
export type LibraryUninstallResponse = SuccessBody<'/library/uninstall', 'post'>;
export type LibraryBanksListResponse = SuccessBody<'/library/banks/list', 'post'>;
export type LibraryBanksImportResponse = SuccessBody<'/library/banks/import', 'post'>;
export type LibraryBankInspectResponse = SuccessBody<'/library/banks/inspect', 'post'>;
export type FxbConfigSnapshotResponse = SuccessBody<'/fxb-config/read', 'post'>;

/** Adaptador de `fetch`; permite inyectar uno instrumentado en tests o en la UI. */
export type FxbFetch = typeof globalThis.fetch;

export interface FxbClientOptions {
  /**
   * Origen de la API. Por defecto `http://127.0.0.1:3210`.
   * Con `''` las peticiones son relativas, útil si la UI se sirve desde el
   * propio Nest.
   */
  baseUrl?: string;
  /** `fetch` alternativo (por ejemplo, con instrumentación de red). */
  fetch?: FxbFetch;
  /** Cabeceras extra en todas las peticiones. */
  headers?: Record<string, string>;
}

/** Error HTTP con el cuerpo ya parseado de la respuesta. */
export class FxbApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'FxbApiError';
    this.status = status;
    this.body = body;
  }
}

export function isFxbApiError(error: unknown): error is FxbApiError {
  return error instanceof FxbApiError;
}

export interface FxbClient {
  readonly library: {
    /** Enumera `plugs\` y marca los plugins con `fxbLoader.config`. */
    scan(
      body: RequestBody<'/library/scan', 'post'>,
    ): Promise<SuccessBody<'/library/scan', 'post'>>;
    /** Instala el cargador; con `dryRun` devuelve solo el plan. */
    install(
      body: RequestBody<'/library/install', 'post'>,
    ): Promise<SuccessBody<'/library/install', 'post'>>;
    /** Restaura `vfxinfo.txt` y borra la configuración del cargador. */
    uninstall(
      body: RequestBody<'/library/uninstall', 'post'>,
    ): Promise<SuccessBody<'/library/uninstall', 'post'>>;
    /** Lista los bancos del plugin y su configuración, sin escribir nada. */
    listBanks(
      body: RequestBody<'/library/banks/list', 'post'>,
    ): Promise<SuccessBody<'/library/banks/list', 'post'>>;
    /** Valida y copia `.fxb` en la carpeta de presets del plugin. */
    importBanks(
      body: RequestBody<'/library/banks/import', 'post'>,
    ): Promise<SuccessBody<'/library/banks/import', 'post'>>;
    /** Lee un `.fxb` y lo compara con los bancos del plugin, sin copiarlo. */
    inspectBank(
      body: RequestBody<'/library/banks/inspect', 'post'>,
    ): Promise<SuccessBody<'/library/banks/inspect', 'post'>>;
  };
  readonly config: {
    /** Lee `fxbLoader.config`; no crea el archivo si falta. */
    read(
      body: RequestBody<'/fxb-config/read', 'post'>,
    ): Promise<SuccessBody<'/fxb-config/read', 'post'>>;
    /** Escribe de forma atómica con control optimista por `mtimeMs`. */
    write(
      body: RequestBody<'/fxb-config', 'put'>,
    ): Promise<SuccessBody<'/fxb-config', 'put'>>;
  };
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:3210';

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function parsePayload(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

function messageFrom(payload: unknown): string | null {
  if (typeof payload === 'object' && payload !== null && 'message' in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
    if (Array.isArray(message) && message.every((item) => typeof item === 'string')) {
      return message.join('; ');
    }
  }
  return null;
}

/**
 * Crea el cliente. Los métodos lanzan `FxbApiError` con el código y el cuerpo
 * del error (los mismos esquemas que documenta Swagger) y no reintentan de
 * oficio: reintentar una instalación o una importación es decisión de la UI.
 */
export function createFxbClient(options: FxbClientOptions = {}): FxbClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const extraHeaders = options.headers ?? {};
  const doFetch: FxbFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function request(method: 'POST' | 'PUT', route: string, body: unknown): Promise<unknown> {
    const response = await doFetch(`${baseUrl}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    });

    const payload = parsePayload(await response.text());
    if (!response.ok) {
      const fallback = `${response.status} ${response.statusText}`.trim();
      throw new FxbApiError(response.status, payload, messageFrom(payload) ?? fallback);
    }
    return payload;
  }

  return {
    library: {
      scan: (body) =>
        request('POST', '/library/scan', body) as Promise<SuccessBody<'/library/scan', 'post'>>,
      install: (body) =>
        request('POST', '/library/install', body) as Promise<
          SuccessBody<'/library/install', 'post'>
        >,
      uninstall: (body) =>
        request('POST', '/library/uninstall', body) as Promise<
          SuccessBody<'/library/uninstall', 'post'>
        >,
      listBanks: (body) =>
        request('POST', '/library/banks/list', body) as Promise<
          SuccessBody<'/library/banks/list', 'post'>
        >,
      importBanks: (body) =>
        request('POST', '/library/banks/import', body) as Promise<
          SuccessBody<'/library/banks/import', 'post'>
        >,
      inspectBank: (body) =>
        request('POST', '/library/banks/inspect', body) as Promise<
          SuccessBody<'/library/banks/inspect', 'post'>
        >,
    },
    config: {
      read: (body) =>
        request('POST', '/fxb-config/read', body) as Promise<SuccessBody<'/fxb-config/read', 'post'>>,
      write: (body) =>
        request('PUT', '/fxb-config', body) as Promise<SuccessBody<'/fxb-config', 'put'>>,
    },
  };
}
