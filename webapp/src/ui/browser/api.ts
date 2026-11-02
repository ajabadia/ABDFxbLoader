import {
  createFxbClient,
  isFxbApiError,
  type FxbApiError,
  type FxbClient,
} from '../../client/fxb-client.js';
import { t } from '../i18n/index.js';

let currentBaseUrl = '';
let activeClient: FxbClient = createFxbClient({ baseUrl: currentBaseUrl });

export function setClientBaseUrl(url: string): void {
  currentBaseUrl = url;
  activeClient = createFxbClient({ baseUrl: currentBaseUrl });
}

export function getClientBaseUrl(): string {
  return currentBaseUrl;
}

/**
 * Proxy transparente del cliente tipado. Permite conmutar la URL base en
 * caliente (por ejemplo, desde un despliegue web remoto en Vercel hacia el agente
 * local en 127.0.0.1:3210) sin que ningún módulo pierda la referencia al cliente.
 */
export const client: FxbClient = new Proxy({} as FxbClient, {
  get(_target, prop) {
    return (activeClient as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export { createFxbClient, isFxbApiError };

/** Texto para la UI: el mensaje del API, sus `issues` y los fallos de red. */
/**
 * Texto del fallo en el idioma de la vista. Si el servidor manda un código con
 * traducción, manda ella; si no, se enseña el mensaje recibido tal cual: mejor
 * un mensaje en castellano que una clave cruda.
 */
function messageOf(error: FxbApiError): string {
  const body = error.body as { code?: unknown; params?: unknown } | null;
  if (body === null || typeof body.code !== 'string') return error.message;
  const key = `msg.apiError.${body.code}`;
  const params =
    typeof body.params === 'object' && body.params !== null
      ? (body.params as Record<string, string | number>)
      : {};
  const translated = t(key, params);
  return translated === key ? error.message : translated;
}

export function describeError(error: unknown): string {
  if (isFxbApiError(error)) {
    const body = error.body as { issues?: unknown } | null;
    const issues =
      body !== null && Array.isArray(body.issues) && body.issues.length > 0
        ? `\n${body.issues.join('\n')}`
        : '';
    return `${messageOf(error)}${issues}`;
  }
  if (
    error instanceof TypeError &&
    (error.message.includes('fetch') ||
      error.message.includes('NetworkError') ||
      error.message.includes('Failed to fetch'))
  ) {
    return t('msg.serverUnreachable', { 0: error.message });
  }
  return error instanceof Error ? error.message : String(error);
}
