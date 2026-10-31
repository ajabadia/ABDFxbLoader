import { createFxbClient, isFxbApiError, type FxbClient } from '../../client/fxb-client.js';

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
export function describeError(error: unknown): string {
  if (isFxbApiError(error)) {
    const body = error.body as { issues?: unknown } | null;
    const issues =
      body !== null && Array.isArray(body.issues) && body.issues.length > 0
        ? `\n${body.issues.join('\n')}`
        : '';
    return `${error.message}${issues}`;
  }
  if (
    error instanceof TypeError &&
    (error.message.includes('fetch') ||
      error.message.includes('NetworkError') ||
      error.message.includes('Failed to fetch'))
  ) {
    return `No se pudo contactar con el servidor: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
