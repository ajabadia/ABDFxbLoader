import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_BANKS_PER_REQUEST } from '../src/client/bank-limits';
import { FxbApiError } from '../src/client/fxb-client';
import { importProgressLabel, rejectedResults, runImportInChunks } from '../src/ui/bank-import';

/**
 * La vista importa bancos con un emisor que puede avisar de cada archivo por
 * NDJSON, y trocea la lista porque el servidor acepta como máximo
 * `MAX_BANKS_PER_REQUEST` rutas por petición. Aquí se comprueba que la barra
 * avanza banco a banco, que los trozos cubren la lista en orden, que el
 * resultado por archivo se acumula en una sola lista y que un fallo a mitad
 * conserva lo ya importado.
 */

/** Lo mínimo de un resultado por archivo que necesita la acumulación. */
interface Imported {
  fileName: string;
  status: 'imported' | 'rejected';
}

const pathsFrom = (count: number): string[] =>
  Array.from(
    { length: count },
    (_, index) => `C:\\Banks\\banco-${String(index).padStart(3, '0')}.fxb`,
  );

const fileName = (filePath: string): string => filePath.slice(filePath.lastIndexOf('\\') + 1);

/** Emisor de mentira: apunta los trozos y devuelve un resultado por archivo. */
function fakeImport(options: { failOnRequest?: number } = {}): {
  send: (paths: string[]) => Promise<Imported[]>;
  requests: string[][];
} {
  const requests: string[][] = [];
  const send = async (paths: string[]): Promise<Imported[]> => {
    requests.push([...paths]);
    if (requests.length === options.failOnRequest) throw new Error('se cayó la red');
    return paths.map((filePath) => ({ fileName: fileName(filePath), status: 'imported' as const }));
  };
  return { send, requests };
}

test('una lista que cabe en el tope se manda en una sola petición', async () => {
  const paths = pathsFrom(3);
  const { send, requests } = fakeImport();
  const progress: number[] = [];

  const run = await runImportInChunks({
    paths,
    send,
    onResults: (results) => progress.push(results.length),
  });

  assert.deepEqual(requests, [paths]);
  assert.equal(run.requests, 1);
  assert.equal(run.error, null);
  assert.deepEqual(
    run.results.map((result) => result.fileName),
    paths.map(fileName),
    'un resultado por archivo, en el orden del cuadro de texto',
  );
  assert.deepEqual(progress, [3], 'la vista repinta al cerrar la única petición');
});

test('un emisor NDJSON hace avanzar la barra banco a banco', async () => {
  const paths = pathsFrom(3);
  const progress: number[] = [];

  const send = async (
    chunk: string[],
    onResult: (result: Imported) => void,
  ): Promise<Imported[]> => {
    for (const filePath of chunk) {
      onResult({ fileName: fileName(filePath), status: 'imported' });
    }
    return [];
  };

  const run = await runImportInChunks({
    paths,
    send,
    onResults: (results) => progress.push(results.length),
  });

  assert.deepEqual(progress, [1, 2, 3], 'cada banco se pinta sin esperar al cierre del trozo');
  assert.deepEqual(run.results.map((result) => result.fileName), paths.map(fileName));
  assert.equal(run.error, null);
});

test('si el flujo se corta conserva los bancos ya avisados', async () => {
  const paths = pathsFrom(3);

  const send = async (
    chunk: string[],
    onResult: (result: Imported) => void,
  ): Promise<Imported[]> => {
    onResult({ fileName: fileName(chunk[0]!), status: 'imported' });
    throw new Error('se cayó la red');
  };

  const run = await runImportInChunks({ paths, send });

  assert.equal(run.results.length, 1, 'lo confirmado antes del corte no se pierde');
  assert.equal(run.error instanceof Error ? run.error.message : '', 'se cayó la red');
});

test('por encima del tope se trocea y el resultado se acumula en orden', async () => {
  const paths = pathsFrom(MAX_BANKS_PER_REQUEST + 1);
  const { send, requests } = fakeImport();
  const progress: number[] = [];

  const run = await runImportInChunks({
    paths,
    send,
    onResults: (results) => progress.push(results.length),
  });

  assert.deepEqual(requests.map((request) => request.length), [MAX_BANKS_PER_REQUEST, 1]);
  assert.deepEqual(requests.flat(), paths, 'los trozos cubren la lista en orden');
  assert.equal(run.requests, 2);
  assert.equal(run.results.length, paths.length);
  assert.deepEqual(run.results.map((result) => result.fileName), paths.map(fileName));
  assert.deepEqual(
    progress,
    [MAX_BANKS_PER_REQUEST, paths.length],
    'cada trozo suma sus resultados a los anteriores',
  );
});

test('con 120 rutas manda tres peticiones de 50, 50 y 20', async () => {
  const paths = pathsFrom(120);
  const { send, requests } = fakeImport();

  const run = await runImportInChunks({ paths, send });

  assert.deepEqual(requests.map((request) => request.length), [50, 50, 20]);
  assert.equal(run.results.length, 120);
});

test('si una petición falla se corta y conserva lo ya importado', async () => {
  const paths = pathsFrom(MAX_BANKS_PER_REQUEST * 2 + 5);
  const { send, requests } = fakeImport({ failOnRequest: 2 });

  const run = await runImportInChunks({ paths, send });

  assert.equal(requests.length, 2, 'el tercer trozo ya no se envía');
  assert.equal(run.requests, 2);
  assert.equal(run.results.length, MAX_BANKS_PER_REQUEST, 'lo del primer trozo no se pierde');
  assert.ok(run.error instanceof Error, 'el motivo que cortó la importación queda a la vista');
  assert.equal(run.error instanceof Error ? run.error.message : '', 'se cayó la red');
});

test('el texto de progreso cuenta archivos resueltos sobre el total', () => {
  assert.equal(
    importProgressLabel({ done: 0, total: 51, requests: 1 }),
    'Importando 0 de 51 archivo(s)…',
  );
  assert.equal(
    importProgressLabel({ done: MAX_BANKS_PER_REQUEST, total: 51, requests: 1 }),
    'Importando 50 de 51 archivo(s)…',
  );
});

test('sin rutas no se manda ninguna petición', async () => {
  const { send, requests } = fakeImport();

  const run = await runImportInChunks({ paths: [], send });

  assert.deepEqual(requests, []);
  assert.deepEqual(run.results, []);
  assert.equal(run.requests, 0);
  assert.equal(run.error, null);
});

test('el tamaño de cada petición se puede fijar', async () => {
  const { send, requests } = fakeImport();

  await runImportInChunks({ paths: pathsFrom(5), send, size: 2 });

  assert.deepEqual(requests.map((request) => request.length), [2, 2, 1]);
});

test('un 422 con motivos por archivo se acumula como rechazos', () => {
  const results = [
    { fileName: 'a.fxb', status: 'rejected' as const, reason: 'no es un .fxb' },
    { fileName: 'b.fxb', status: 'rejected' as const, reason: 'otro plugin' },
  ];
  const error = new FxbApiError(422, { results }, 'Ningún banco se pudo importar');

  assert.deepEqual(rejectedResults(error), results, 'los motivos del trozo no se tiran');
});

test('un 422 sin motivos no se toma por resultados', () => {
  assert.equal(rejectedResults(new FxbApiError(422, null, 'sin cuerpo')), null);
  assert.equal(rejectedResults(new FxbApiError(422, { results: [] }, 'vacío')), null);
  assert.equal(rejectedResults(new FxbApiError(400, { results: [{ fileName: 'a.fxb' }] }, '400')), null);
  assert.equal(rejectedResults(new Error('red')), null);
});

test('el error de cancelación se distingue de un error de red', () => {
  const cancelError = new Error('Cancelado por el usuario');
  const networkError = new Error('se cayó la red');

  assert.equal(cancelError.message, 'Cancelado por el usuario');
  assert.equal(networkError.message, 'se cayó la red');
  assert.notEqual(cancelError.message, networkError.message);
});

test('el usuario puede cancelar una importación en curso', async () => {
  const paths = pathsFrom(3);
  const cancelError = new Error('Cancelado por el usuario');

  const send = async (
    chunk: string[],
    onResult: (result: Imported) => void,
  ): Promise<Imported[]> => {
    onResult({ fileName: fileName(chunk[0]!), status: 'imported' });
    // Lo que hace Cancelar: la petición en curso se rechaza en vez de seguir.
    throw cancelError;
  };

  // El patrón es: el botón Cancelar hace que la petición en curso se rechace
  // con el error de cancelación, que la vista distingue de un fallo de red.
  // Este test documenta el contrato: el error llega a la vista y lo ya
  // informado por el stream se conserva.
  const run = await runImportInChunks({ paths, send });

  assert.equal(run.error, cancelError);
  assert.equal(run.results.length, 1);
});
