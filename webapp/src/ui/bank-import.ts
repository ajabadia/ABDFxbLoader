import { isFxbApiError } from '../client/fxb-client.js';
import type { LibraryBanksImportResponse } from '../client/fxb-client.js';
import { splitBatch } from './batch.js';
import { MAX_BANKS_PER_REQUEST } from '../client/bank-limits.js';

/**
 * Importación de bancos con progreso banco a banco para la vista.
 *
 * `POST /library/banks/import/stream` avisa del resultado de cada archivo con
 * NDJSON, así que la barra avanza sin esperar al cierre de la petición. Además,
 * el endpoint acepta como máximo `MAX_BANKS_PER_REQUEST` rutas, así que una
 * lista más larga se manda en peticiones consecutivas y los resultados de todas
 * se acumulan en el orden del cuadro de texto: la lista que pinta la vista es
 * una sola, con un elemento por archivo, no una por petición. Si una petición
 * falla se corta ahí y lo ya importado se conserva.
 *
 * No toca el DOM ni conoce `fetch` (la petición la inyecta la vista), así que se
 * prueba con datos simples, igual que `runBatchInChunks`.
 */

/** Un elemento por archivo importado o rechazado, como lo devuelve el servidor. */
export type BankImportResults = LibraryBanksImportResponse['results'];

/** Progreso de la importación, para la barra y el texto mientras dura. */
export interface BankImportProgress {
  /** Archivos con resultado en este momento. */
  done: number;
  /** Rutas del cuadro de texto, no las de la petición en curso. */
  total: number;
  /** Peticiones enviadas hasta ahora. */
  requests: number;
}

export interface BankImportOptions<R> {
  /** Rutas absolutas, en el orden en que se quieren ver los resultados. */
  paths: readonly string[];
  /**
   * Envía un trozo y devuelve el resultado de cada archivo que contiene. Si el
   * transporte es NDJSON, puede llamar a `onResult` en cuanto termina cada
   * archivo; entonces la barra avanza banco a banco sin esperar al cierre del
   * trozo. Un emisor que solo devuelve el array al final sigue valiendo.
   */
  send: (
    paths: string[],
    onResult: (result: R) => void,
  ) => Promise<readonly R[]>;
  /** Tope por petición; por defecto, el que valida el servidor. */
  size?: number;
  /**
   * Copia de los resultados acumulados tras cada banco (o al cerrar el trozo si
   * el emisor no informa por banco), para pintarlos sin esperar al final.
   */
  onResults?: (results: readonly R[], progress: BankImportProgress) => void;
}

/** Texto del progreso: cuántos archivos tienen ya resultado y cuántos hay. */
export function importProgressLabel(progress: BankImportProgress): string {
  return `Importando ${progress.done} de ${progress.total} archivo(s)…`;
}

/**
 * Resultados por archivo de un 422: el servidor no importó ningún banco de la
 * petición, pero el motivo de cada uno viene en el cuerpo. `null` si el error no
 * trae esa lista y hay que tratarlo como un fallo de la petición entera.
 */
export function rejectedResults(error: unknown): BankImportResults | null {
  if (!isFxbApiError(error) || error.status !== 422) return null;
  const body = error.body as { results?: BankImportResults } | null;
  if (body === null || !Array.isArray(body.results) || body.results.length === 0) return null;
  return body.results;
}

export interface BankImportRun<R> {
  /** Resultado de cada archivo, en el orden de `paths`. */
  results: R[];
  /** Peticiones enviadas al servidor. */
  requests: number;
  /** Error que cortó la importación, o `null` si terminó entera. */
  error: unknown;
}

/**
 * Recorre las rutas en peticiones dentro del tope del servidor y acumula el
 * resultado de cada archivo. Un 422 (ningún banco del trozo se pudo importar)
 * lo decide la vista en `send`: si trae el motivo de cada archivo, se acumula y
 * se sigue con el trozo siguiente; si no, es un fallo y se corta aquí.
 */
export async function runImportInChunks<R>(
  options: BankImportOptions<R>,
): Promise<BankImportRun<R>> {
  const chunks = splitBatch(options.paths, options.size ?? MAX_BANKS_PER_REQUEST);
  const results: R[] = [];
  let requests = 0;
  let error: unknown = null;

  for (const chunk of chunks) {
    requests += 1;
    const chunkResults: R[] = [];
    let streamed = false;

    /** Copia: el acumulador sigue creciendo y quien pinte no debe ver cómo cambia. */
    const notify = (): void => {
      options.onResults?.([...results], {
        done: results.length,
        total: options.paths.length,
        requests,
      });
    };

    /** Un resultado NDJSON se pinta sin esperar al resto del trozo. */
    const push = (result: R): void => {
      streamed = true;
      chunkResults.push(result);
      results.push(result);
      notify();
    };

    try {
      const returned = await options.send(chunk, push);
      // Un emisor sin NDJSON devuelve los resultados al cerrar el trozo: se
      // acumulan y se pintan una sola vez, como antes.
      if (!streamed) {
        results.push(...returned);
        notify();
      }
    } catch (caught) {
      error = caught;
      break;
    }
  }

  return { results, requests, error };
}
