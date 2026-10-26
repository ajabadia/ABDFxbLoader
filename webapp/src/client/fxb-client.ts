import type { paths } from './api-types';
import type {
  BankImportStreamEvent,
  BankImportStreamResult,
} from './bank-import-stream';
import type { BatchStreamEvent, BatchStreamResult } from './batch-stream';

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
export type LibraryLoaderAddResponse = SuccessBody<'/library/loader/add', 'post'>;
export type LibraryLoaderRemoveResponse = SuccessBody<'/library/loader/remove', 'post'>;
export type LibraryBatchResponse = SuccessBody<'/library/batch', 'post'>;
export type LibraryBanksListResponse = SuccessBody<'/library/banks/list', 'post'>;
export type LibraryBanksImportResponse = SuccessBody<'/library/banks/import', 'post'>;
export type LibraryBankConvertResponse = SuccessBody<'/library/banks/convert', 'post'>;
export type LibraryBankRestoreResponse = SuccessBody<'/library/banks/restore', 'post'>;
export type LibraryBankDiscardBackupResponse = SuccessBody<
  '/library/banks/discard-backup',
  'post'
>;
export type LibraryBankInspectResponse = SuccessBody<'/library/banks/inspect', 'post'>;
export type LibraryInspectPackageResponse = SuccessBody<'/library/inspect-package', 'post'>;  export type LibraryImportPackageResponse = SuccessBody<'/library/import-package', 'post'>;
export type LibraryInspectDllResponse = SuccessBody<'/library/inspect-dll', 'post'>;
export type LibraryCreateCustomPluginResponse = SuccessBody<
  '/library/create-custom-plugin',
  'post'
>;
export type FxbConfigSnapshotResponse = SuccessBody<'/fxb-config/read', 'post'>;
export type SystemPickResponse = SuccessBody<'/system/pick', 'post'>;
export type SystemPathsResponse = SuccessBody<'/system/paths', 'post'>;
export type PluginMetaSnapshotResponse = SuccessBody<'/plugins/{id}/meta', 'get'>;
export type PluginMetaWriteResponse = SuccessBody<'/plugins/{id}/meta', 'post'>;
export type PluginLogSnapshotResponse = SuccessBody<'/plugins/{id}/log', 'get'>;
export type WizardListResponse = SuccessBody<'/wizards', 'get'>;
export type WizardRecordResponse = SuccessBody<'/wizards/{id}', 'get'>;
export type WizardMatchResponse = SuccessBody<'/wizards/match', 'get'>;
export type WizardApplyMetaResponse = SuccessBody<'/wizards/apply-meta', 'post'>;
export type WizardCreateVfxinfoResponse = SuccessBody<'/wizards/create-vfxinfo', 'post'>;
export type WizardInstallPluginResponse = SuccessBody<'/wizards/install', 'post'>;
export type AssociationAuditSnapshotResponse = SuccessBody<
  '/library/association-audit/list',
  'post'
>;

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

export interface BatchStreamHandlers {
  /** Se llama con cada evento de `POST /library/batch/stream`, según llega. */
  onEvent?: (event: BatchStreamEvent) => void;
  /** Cancela el lote desde el cliente (el servidor deja de escribir). */
  signal?: AbortSignal;
}

export interface BankImportStreamHandlers {
  /** Se llama con cada evento de `POST /library/banks/import/stream`, según llega. */
  onEvent?: (event: BankImportStreamEvent) => void;
  /** Corta la importación desde el cliente. */
  signal?: AbortSignal;
}

export interface FxbClient {
  readonly library: {
    /** Enumera `plugs\` y marca los plugins con `fxbLoader.config`. */
    scan(
      body: RequestBody<'/library/scan', 'post'>,
    ): Promise<SuccessBody<'/library/scan', 'post'>>;
    /** Pone el cargador en un plugin; con `dryRun` devuelve solo el plan. */
    addLoader(
      body: RequestBody<'/library/loader/add', 'post'>,
    ): Promise<SuccessBody<'/library/loader/add', 'post'>>;
    /** Restaura `vfxinfo.txt` y borra la configuración del cargador. */
    removeLoader(
      body: RequestBody<'/library/loader/remove', 'post'>,
    ): Promise<SuccessBody<'/library/loader/remove', 'post'>>;
    /** Instala o desinstala varios plugins en una llamada, con resultado por plugin. */
    batch(
      body: RequestBody<'/library/batch', 'post'>,
    ): Promise<SuccessBody<'/library/batch', 'post'>>;
    /**
     * El mismo lote, leyendo el progreso NDJSON: `onEvent` recibe cada evento
     * (`start`, `plugin`, `end`) mientras el servidor lo escribe, y la promesa
     * se resuelve con el resultado final.
     */
    batchStream(
      body: RequestBody<'/library/batch/stream', 'post'>,
      handlers?: BatchStreamHandlers,
    ): Promise<BatchStreamResult>;
    /** Lista los bancos del plugin y su configuración, sin escribir nada. */
    listBanks(
      body: RequestBody<'/library/banks/list', 'post'>,
    ): Promise<SuccessBody<'/library/banks/list', 'post'>>;
    /** Valida y copia `.fxb` en la carpeta de presets del plugin. */
    importBanks(
      body: RequestBody<'/library/banks/import', 'post'>,
    ): Promise<SuccessBody<'/library/banks/import', 'post'>>;
    /**
     * La misma importación, leyendo el progreso NDJSON: `onEvent` recibe el
     * resultado de cada banco en cuanto se procesa y la promesa se resuelve con
     * el resultado `end`.
     */
    importBanksStream(
      body: RequestBody<'/library/banks/import/stream', 'post'>,
      handlers?: BankImportStreamHandlers,
    ): Promise<BankImportStreamResult>;
    /**
     * Convierte **en el sitio** el banco por defecto del plugin, guardando una
     * copia del original como `<banco>.orig` antes de reescribirlo.
     */
    convertDefaultBank(
      body: RequestBody<'/library/banks/convert', 'post'>,
    ): Promise<SuccessBody<'/library/banks/convert', 'post'>>;
    /**
     * Devuelve el banco por defecto al contenido de `<banco>.orig`, sin tocar
     * el respaldo, que sigue disponible para restaurar otra vez.
     */
    restoreDefaultBank(
      body: RequestBody<'/library/banks/restore', 'post'>,
    ): Promise<SuccessBody<'/library/banks/restore', 'post'>>;
    /**
     * Borra el respaldo `<banco>.orig` del banco por defecto. Irreversible: el
     * banco no cambia, pero después ya no se puede restaurar el original.
     */
    discardDefaultBankBackup(
      body: RequestBody<'/library/banks/discard-backup', 'post'>,
    ): Promise<SuccessBody<'/library/banks/discard-backup', 'post'>>;
    /** Exporta un banco importado en big-endian o little-endian, sin tocar el original. */
    exportBank(
      body: RequestBody<'/library/banks/export', 'post'>,
    ): Promise<SuccessBody<'/library/banks/export', 'post'>>;
    /** Lee un `.fxb` y lo compara con los bancos del plugin, sin copiarlo. */
    inspectBank(
      body: RequestBody<'/library/banks/inspect', 'post'>,
    ): Promise<SuccessBody<'/library/banks/inspect', 'post'>>;
    /** Inspecciona un paquete externo (.vfxlibrary o carpeta de plugin). */
    inspectPackage(
      body: RequestBody<'/library/inspect-package', 'post'>,
    ): Promise<SuccessBody<'/library/inspect-package', 'post'>>;
    /** Importa plugins y bancos desde un paquete externo a la librería activa. */
    importPackage(
      body: RequestBody<'/library/import-package', 'post'>,
    ): Promise<SuccessBody<'/library/import-package', 'post'>>;
    /**
     * Guarda la preferencia local de DLL del plugin: escribe `dll_name` en su
     * `vfxinfo.txt` con respaldo inicial. La DLL debe estar en su carpeta.
     */
    updateDllPreference(
      body: RequestBody<'/library/plugin-dll-preference', 'post'>,
    ): Promise<SuccessBody<'/library/plugin-dll-preference', 'post'>>;
    /** Inspecciona estáticamente un archivo DLL para detectar exportaciones VST y compatibilidad PE32. */
    inspectDll(
      body: RequestBody<'/library/inspect-dll', 'post'>,
    ): Promise<SuccessBody<'/library/inspect-dll', 'post'>>;
    /** Crea un nuevo instrumento o efecto en la librería a partir de un DLL externo sin wizard previo. */
    createCustomPlugin(
      body: RequestBody<'/library/create-custom-plugin', 'post'>,
    ): Promise<SuccessBody<'/library/create-custom-plugin', 'post'>>;
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
  readonly associationAudit: {
    /**
     * `fxbLoader.audit.jsonl`: snapshot de solo lectura de la auditoría
     * durable de asociaciones. Sin almacén responde `exists: false` con la
     * lista vacía; solo los servicios internos escriben en él.
     */
    list(
      body: RequestBody<'/library/association-audit/list', 'post'>,
    ): Promise<AssociationAuditSnapshotResponse>;
  };
  readonly plugins: {
    /**
     * `fxbLoader.meta.json`: el catálogo propio del plugin, aparte de lo que
     * declara `vfxinfo.txt`. El `id` de la ruta solo etiqueta el plugin; el
     * archivo se resuelve con el directorio.
     */
    meta: {
      /** Lee el meta; si no existe devuelve `exists: false` sin crear nada. */
      read(input: { id: string; dir: string }): Promise<PluginMetaSnapshotResponse>;
      /**
       * Fusiona `common` y `extended` con lo que haya en disco. Exige el
       * `expectedMtimeMs` leído y responde 409 con `current` si ya no es el
       * vigente. Un `null` en `extended` borra esa clave.
       */
      write(
        input: RequestBody<'/plugins/{id}/meta', 'post'> & { id: string },
      ): Promise<PluginMetaWriteResponse>;
    };
    /**
     * `fxbLoader.log[.N]`: el log por plugin rotado por tamaño.
     */
    log: {
      /** Lee las entradas y el texto concatenado del log. */
      read(input: { id: string; dir: string }): Promise<PluginLogSnapshotResponse>;
    };
  };
  readonly system: {
    /**
     * Abre un diálogo nativo en la máquina del servidor y devuelve las rutas
     * absolutas elegidas (`paths: []` si se cancela). La promesa no se resuelve
     * hasta que el diálogo se cierra.
     */
    pick(
      body: RequestBody<'/system/pick', 'post'>,
    ): Promise<SuccessBody<'/system/pick', 'post'>>;
    /**
     * Dice cuáles de las rutas siguen en el disco y si son carpetas, para que
     * la vista descarte de su historial las que ya no están. Una ruta que falta
     * llega con `exists: false`, no como error.
     */
    paths(
      body: RequestBody<'/system/paths', 'post'>,
    ): Promise<SuccessBody<'/system/paths', 'post'>>;
  };
  readonly wizards: {
    /** Lista paginada de wizards disponibles en el repositorio con filtros. */
    list(query?: {
      query?: string;
      genre?: string;
      offset?: number;
      limit?: number;
      sort?: string;
      dir?: 'asc' | 'desc' | string;
    }): Promise<WizardListResponse>;
    /** Busca un wizard coincidente por ID VST, nombre o nombre de DLL. */
    match(query: { id?: string; name?: string; dllName?: string }): Promise<WizardMatchResponse>;
    /** Detalles completos de un wizard específico por su ID. */
    getById(id: string): Promise<WizardRecordResponse>;
    /** Aplica metadatos del wizard a fxbLoader.meta.json del plugin. */
    applyMeta(
      body: RequestBody<'/wizards/apply-meta', 'post'>,
    ): Promise<WizardApplyMetaResponse>;
    /** Crea vfxinfo.txt a partir de los datos del wizard. */
    createVfxinfo(
      body: RequestBody<'/wizards/create-vfxinfo', 'post'>,
    ): Promise<WizardCreateVfxinfoResponse>;
    /** Instala un nuevo plugin en la librería activa desde un Wizard certificado. */
    install(
      body: RequestBody<'/wizards/install', 'post'>,
    ): Promise<WizardInstallPluginResponse>;
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

  async function request(
    method: 'GET' | 'POST' | 'PUT',
    route: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await doFetch(`${baseUrl}${route}`, {
      method,
      headers:
        body === undefined
          ? { ...extraHeaders }
          : { 'content-type': 'application/json', ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const payload = parsePayload(await response.text());
    if (!response.ok) {
      const fallback = `${response.status} ${response.statusText}`.trim();
      throw new FxbApiError(response.status, payload, messageFrom(payload) ?? fallback);
    }
    return payload;
  }

  /**
   * Lote en NDJSON: cada línea es un evento que se entrega según llega, y el
   * resultado es el del evento `end`. Los errores de la petición llegan como
   * JSON normal (aún no se ha escrito ningún evento), así que se tratan igual
   * que en el resto del cliente.
   */
  async function streamBatch(
    body: unknown,
    handlers: BatchStreamHandlers,
  ): Promise<BatchStreamResult> {
    const response = await doFetch(`${baseUrl}/library/batch/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/x-ndjson',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      ...(handlers.signal === undefined ? {} : { signal: handlers.signal }),
    });

    if (!response.ok) {
      const payload = parsePayload(await response.text());
      const fallback = `${response.status} ${response.statusText}`.trim();
      throw new FxbApiError(response.status, payload, messageFrom(payload) ?? fallback);
    }
    if (response.body === null) {
      throw new FxbApiError(response.status, null, 'la respuesta del lote no tiene cuerpo');
    }

    // `result` vive en un objeto porque se rellena desde el bucle de lectura.
    const state: { result: BatchStreamResult | null } = { result: null };
    const handleLine = (line: string): void => {
      if (line.trim() === '') return;
      let event: BatchStreamEvent;
      try {
        event = JSON.parse(line) as BatchStreamEvent;
      } catch {
        throw new FxbApiError(response.status, line, 'el servidor envió un evento NDJSON inválido');
      }
      handlers.onEvent?.(event);
      if (event.type === 'end') state.result = event.result;
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          handleLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
    } finally {
      reader.releaseLock();
    }

    buffer += decoder.decode();
    handleLine(buffer);

    if (state.result === null) {
      throw new FxbApiError(
        response.status,
        null,
        'el lote terminó sin evento end: el servidor cortó la respuesta',
      );
    }
    return state.result;
  }

  /**
   * Importación de bancos en NDJSON: cada línea se entrega en cuanto llega y
   * el resultado es el del evento `end`. Mismo tratamiento de errores que el
   * lote: antes del primer evento, un 400/404 llega como JSON normal.
   */
  async function streamBankImport(
    body: unknown,
    handlers: BankImportStreamHandlers,
  ): Promise<BankImportStreamResult> {
    const response = await doFetch(`${baseUrl}/library/banks/import/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/x-ndjson',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      ...(handlers.signal === undefined ? {} : { signal: handlers.signal }),
    });

    if (!response.ok) {
      const payload = parsePayload(await response.text());
      const fallback = `${response.status} ${response.statusText}`.trim();
      throw new FxbApiError(response.status, payload, messageFrom(payload) ?? fallback);
    }
    if (response.body === null) {
      throw new FxbApiError(response.status, null, 'la respuesta de la importación no tiene cuerpo');
    }

    const state: { result: BankImportStreamResult | null } = { result: null };
    const handleLine = (line: string): void => {
      if (line.trim() === '') return;
      let event: BankImportStreamEvent;
      try {
        event = JSON.parse(line) as BankImportStreamEvent;
      } catch {
        throw new FxbApiError(
          response.status,
          line,
          'el servidor envió un evento NDJSON inválido en la importación',
        );
      }
      handlers.onEvent?.(event);
      if (event.type === 'end') state.result = event.result;
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          handleLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
    } finally {
      reader.releaseLock();
    }

    buffer += decoder.decode();
    handleLine(buffer);

    if (state.result === null) {
      throw new FxbApiError(
        response.status,
        null,
        'la importación terminó sin evento end: el servidor cortó la respuesta',
      );
    }
    return state.result;
  }

  return {
    library: {
      scan: (body) =>
        request('POST', '/library/scan', body) as Promise<SuccessBody<'/library/scan', 'post'>>,
      addLoader: (body) =>
        request('POST', '/library/loader/add', body) as Promise<
          SuccessBody<'/library/loader/add', 'post'>
        >,
      removeLoader: (body) =>
        request('POST', '/library/loader/remove', body) as Promise<
          SuccessBody<'/library/loader/remove', 'post'>
        >,
      batch: (body) =>
        request('POST', '/library/batch', body) as Promise<
          SuccessBody<'/library/batch', 'post'>
        >,
      batchStream: (body, handlers = {}) => streamBatch(body, handlers),
      listBanks: (body) =>
        request('POST', '/library/banks/list', body) as Promise<
          SuccessBody<'/library/banks/list', 'post'>
        >,
      importBanks: (body) =>
        request('POST', '/library/banks/import', body) as Promise<
          SuccessBody<'/library/banks/import', 'post'>
        >,
      importBanksStream: (body, handlers = {}) => streamBankImport(body, handlers),
      convertDefaultBank: (body) =>
        request('POST', '/library/banks/convert', body) as Promise<
          SuccessBody<'/library/banks/convert', 'post'>
        >,
      restoreDefaultBank: (body) =>
        request('POST', '/library/banks/restore', body) as Promise<
          SuccessBody<'/library/banks/restore', 'post'>
        >,
      discardDefaultBankBackup: (body) =>
        request('POST', '/library/banks/discard-backup', body) as Promise<
          SuccessBody<'/library/banks/discard-backup', 'post'>
        >,
      exportBank: (body) =>
        request('POST', '/library/banks/export', body) as Promise<
          SuccessBody<'/library/banks/export', 'post'>
        >,
      inspectBank: (body) =>
        request('POST', '/library/banks/inspect', body) as Promise<
          SuccessBody<'/library/banks/inspect', 'post'>
        >,
      inspectPackage: (body) =>
        request('POST', '/library/inspect-package', body) as Promise<
          SuccessBody<'/library/inspect-package', 'post'>
        >,
      importPackage: (body) =>
        request('POST', '/library/import-package', body) as Promise<
          SuccessBody<'/library/import-package', 'post'>
        >,
      updateDllPreference: (body) =>
        request('POST', '/library/plugin-dll-preference', body) as Promise<
          SuccessBody<'/library/plugin-dll-preference', 'post'>
        >,
      inspectDll: (body) =>
        request('POST', '/library/inspect-dll', body) as Promise<
          SuccessBody<'/library/inspect-dll', 'post'>
        >,
      createCustomPlugin: (body) =>
        request('POST', '/library/create-custom-plugin', body) as Promise<
          SuccessBody<'/library/create-custom-plugin', 'post'>
        >,
    },
    config: {
      read: (body) =>
        request('POST', '/fxb-config/read', body) as Promise<SuccessBody<'/fxb-config/read', 'post'>>,
      write: (body) =>
        request('PUT', '/fxb-config', body) as Promise<SuccessBody<'/fxb-config', 'put'>>,
    },
    associationAudit: {
      list: (body) =>
        request('POST', '/library/association-audit/list', body) as Promise<
          AssociationAuditSnapshotResponse
        >,
    },
    plugins: {
      meta: {
        read: ({ id, dir }) =>
          request(
            'GET',
            `/plugins/${encodeURIComponent(id)}/meta?dir=${encodeURIComponent(dir)}`,
          ) as Promise<PluginMetaSnapshotResponse>,
        write: ({ id, ...body }) =>
          request(
            'POST',
            `/plugins/${encodeURIComponent(id)}/meta`,
            body,
          ) as Promise<PluginMetaWriteResponse>,
      },
      log: {
        read: ({ id, dir }) =>
          request(
            'GET',
            `/plugins/${encodeURIComponent(id)}/log?dir=${encodeURIComponent(dir)}`,
          ) as Promise<PluginLogSnapshotResponse>,
      },
    },
    system: {
      pick: (body) =>
        request('POST', '/system/pick', body) as Promise<SuccessBody<'/system/pick', 'post'>>,
      paths: (body) =>
        request('POST', '/system/paths', body) as Promise<SuccessBody<'/system/paths', 'post'>>,
    },
    wizards: {
      list: (query = {}) => {
        const params = new URLSearchParams();
        if (query.query) params.set('query', query.query);
        if (query.genre) params.set('genre', query.genre);
        if (query.offset !== undefined) params.set('offset', String(query.offset));
        if (query.limit !== undefined) params.set('limit', String(query.limit));
        const qs = params.toString();
        return request('GET', `/wizards${qs ? `?${qs}` : ''}`) as Promise<WizardListResponse>;
      },
      match: (query) => {
        const params = new URLSearchParams();
        if (query.id) params.set('id', query.id);
        if (query.name) params.set('name', query.name);
        if (query.dllName) params.set('dllName', query.dllName);
        const qs = params.toString();
        return request('GET', `/wizards/match${qs ? `?${qs}` : ''}`) as Promise<WizardMatchResponse>;
      },
      getById: (id) =>
        request('GET', `/wizards/${encodeURIComponent(id)}`) as Promise<WizardRecordResponse>,
      applyMeta: (body) =>
        request('POST', '/wizards/apply-meta', body) as Promise<WizardApplyMetaResponse>,
      createVfxinfo: (body) =>
        request('POST', '/wizards/create-vfxinfo', body) as Promise<WizardCreateVfxinfoResponse>,
      install: (body) =>
        request('POST', '/wizards/install', body) as Promise<WizardInstallPluginResponse>,
    },
  };
}
