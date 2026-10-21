import { createFxbClient, isFxbApiError } from '../../client/fxb-client.js';

/**
 * Cliente tipado contra el propio origen (la UI la sirve Nest). Las rutas son
 * relativas, así que funciona igual en `127.0.0.1:3210` que detrás de otro
 * puerto sin tocar la configuración.
 */
export const client = createFxbClient({ baseUrl: '' });

export { isFxbApiError };

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
  if (error instanceof TypeError) {
    return `No se pudo contactar con el servidor: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
