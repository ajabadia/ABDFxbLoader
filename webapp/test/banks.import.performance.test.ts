import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { parseFxbBank } from '../src/library/fxb-bank';
import { LibraryService } from '../src/library/library.service';
import type { BankImportInput, BankImportResponse } from '../src/library/library.types';
import {
  describeTiming,
  measureAsync,
  measureSync,
  timingFromSamples,
} from './helpers/timing';

/**
 * Tiempo de una **importación completa**, no solo del parser: lo que se mide es
 * el trabajo de `POST /library/banks/import` con bancos `.fxb` reales —leer el
 * archivo, parsearlo, comprobar la compatibilidad y el destino y copiarlo con
 * escritura atómica— comparado con lo que cuesta `parseFxbBank` sobre el mismo
 * buffer ya en memoria.
 *
 * Se miden cuatro alturas para poder atribuir la diferencia, de menos a más
 * trabajo: parser solo, lectura + parse, el servicio en proceso (sin HTTP) y la
 * petición HTTP completa (lo anterior + ida y vuelta + JSON). El parser tarda
 * microsegundos, así que la importación la dominan el disco y la copia; el test
 * deja esa comparación en el diagnóstico y solo exige techos absolutos amplios
 * para detectar un salto de orden sin depender de la máquina.
 */

const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'fxb');

interface Bench {
  label: string;
  file: string;
  /** `uniqueID` real del banco, para no depender de bancos ya presentes. */
  uniqueId: string;
}

/** Los mismos dos bancos reales que usa el test de rendimiento del parser. */
const BANKS: Bench[] = [
  { label: 'MauSynth (FxBk, 100 programas)', file: 'mausynth-az-bank.fxb', uniqueId: 'Pang' },
  { label: 'OB-Xd (FBCh, 128 programas)', file: 'wam-obxd-factory.fxb', uniqueId: 'Obxd' },
];

/** Calentamiento y muestras del parser: son microsegundos y necesitan cola. */
const PARSE_WARMUP = 50;
const PARSE_ITERATIONS = 500;
/** Calentamiento y muestras de las importaciones: cada una toca disco. */
const IMPORT_WARMUP = 5;
const IMPORT_ITERATIONS = 40;

/**
 * Los nueve bancos reales del manifiesto, en el orden de la tabla del README.
 * La comparación de una petición frente a nueve usa esta lista completa: no se
 * elige un subconjunto de plugin compatible, porque lo que se quiere medir es
 * exactamente lo que haría la UI con la lista entera en el portapapeles.
 */
const REAL_BANKS = [
  'massive-test-bank.FXB',
  'massive-fpch-bank.fxb',
  'rea-comp.FXB',
  'nanohost-reeq-opaque-5100.fxb',
  'wavosaur-reeq-3set.fxb',
  'wavosaur-reeq-3set-le.fxb',
  'wavosaur-reeq-4500.fxb',
  'wam-obxd-factory.fxb',
  'mausynth-az-bank.fxb',
];

/** Calentamiento y muestras de la comparación por lotes: cada una toca disco. */
const BATCH_WARMUP = 2;
const BATCH_ITERATIONS = 11;

/**
 * Techos absolutos de la comparación, por lote y mediana. Son holgados a
 * propósito: el objetivo es detectar un salto de orden, no un récord, y en
 * `npm test` este archivo compite por el disco con el resto.
 */
const ONE_REQUEST_BUDGET_MS = 1500;
const NINE_REQUESTS_BUDGET_MS = 2500;

/**
 * Techos amplios, por operación y mediana: buscan un salto de orden, no un
 * récord. `npm test` ejecuta los archivos en paralelo, así que la importación
 * compite por el disco con el resto de tests; para leer cifras comparables hay
 * que ejecutar solo los de rendimiento (`npm run test:perf`).
 */
const PARSE_BUDGET_MS = 25;
const SERVICE_BUDGET_MS = 1500;
const HTTP_BUDGET_MS = 2000;

let app: INestApplication;
let service: LibraryService;
let baseUrl: string;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  service = moduleRef.get(LibraryService);
  app = moduleRef.createNestApplication();
  // `fetch` necesita un servidor real, y así se mide el mismo camino que la UI.
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

after(async () => {
  await app?.close();
});

/** Plugin mínimo: la importación de bancos no abre el DLL ni el cargador. */
async function createLibrary(root: string): Promise<void> {
  const pluginDir = path.join(root, 'plugs', 'Synth');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, 'vfxinfo.txt'),
    Buffer.from('name: Synth\r\ndll_name: Synth/Synth.dll\r\n', 'latin1'),
  );
}

async function makeLibrary(t: TestContext): Promise<{ root: string; plugin: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-import-perf-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await createLibrary(root);
  return { root, plugin: 'Synth' };
}

/**
 * Biblioteca nueva para una muestra de la comparación por lotes. Se crea y se
 * borra fuera del reloj: si se reutilizara, la segunda importación encontraría
 * los bancos ya copiados y mediría una sobrescritura (y la referencia de
 * compatibilidad cambiaría), no la importación completa.
 */
async function withFreshLibrary<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-batch-perf-'));
  try {
    await createLibrary(root);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

test('la importación por HTTP tarda milisegundos y el parser microsegundos', async (t) => {
  const { root, plugin } = await makeLibrary(t);
  const importUrl = `${baseUrl}/library/banks/import`;

  for (const bank of BANKS) {
    const source = path.join(FIXTURES, bank.file);

    // Antes de cronometrar: que sea el banco esperado y que la importación
    // funcione, para no medir un rechazo temprano (que también sería rápido).
    const first = await service.importBanks({
      libraryRoot: root,
      plugin,
      sourcePaths: [source],
      expectedUniqueId: bank.uniqueId,
      overwrite: true,
    });
    assert.equal(
      first.results[0]?.status,
      'imported',
      `${bank.label} no se importó: ${first.results[0]?.reason ?? 'sin motivo'}`,
    );
    assert.ok(first.results[0]?.bank !== null, 'el banco importado debe venir parseado');

    const data = await readFile(source);
    const target = path.join(root, 'plugs', plugin, 'presets', bank.file);
    assert.equal(sha256(await readFile(target)), sha256(data), 'la copia debe ser byte a byte');

    const input: BankImportInput = {
      libraryRoot: root,
      plugin,
      sourcePaths: [source],
      expectedUniqueId: bank.uniqueId,
      overwrite: true,
    };
    const body = JSON.stringify(input);
    const post = (): Promise<Response> =>
      fetch(importUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });

    for (let index = 0; index < PARSE_WARMUP; index += 1) parseFxbBank(data);
    for (let index = 0; index < IMPORT_WARMUP; index += 1) {
      await service.importBanks(input);
      await post().then((response) => response.text());
    }

    const parse = measureSync(PARSE_ITERATIONS, () => {
      parseFxbBank(data);
    });

    const readParse = await measureAsync(IMPORT_ITERATIONS, async () => {
      parseFxbBank(await readFile(source));
    });

    // El servicio hace lo mismo que la petición pero sin HTTP ni JSON: aísla lo
    // que cuestan la validación y la copia atómica.
    // A partir de la segunda, el banco ya está en `presets\\` y se sobrescribe:
    // el trabajo es el mismo, solo cambia la etiqueta del resultado.
    const imported = (status: string | undefined): boolean =>
      status === 'imported' || status === 'overwritten';

    let rejected = 0;
    const inProcess = await measureAsync(IMPORT_ITERATIONS, async () => {
      const response = await service.importBanks(input);
      if (!imported(response.results[0]?.status)) rejected += 1;
    });

    const http = await measureAsync(IMPORT_ITERATIONS, async () => {
      const response = await post();
      const payload = (await response.json()) as BankImportResponse;
      if (response.status !== 200 || !imported(payload.results[0]?.status)) rejected += 1;
    });

    assert.equal(rejected, 0, `${bank.label}: ${rejected} importaciones rechazadas al medir`);

    const kilobytes = (data.length / 1024).toFixed(0);
    t.diagnostic(`${bank.label}, ${kilobytes} KB → parser ${describeTiming(parse, 'parses/s')}`);
    t.diagnostic(
      `${bank.label} → lectura + parse ${describeTiming(readParse, 'lecturas/s')} · ` +
        `servicio ${describeTiming(inProcess, 'importaciones/s')} · ` +
        `HTTP ${describeTiming(http, 'peticiones/s')}`,
    );
    t.diagnostic(
      `${bank.label} → importar cuesta ` +
        `${(inProcess.medianMs / Math.max(parse.medianMs, 1e-6)).toFixed(1)}× el parser solo ` +
        `(${(inProcess.medianMs - parse.medianMs).toFixed(3)} ms más de disco y copia atómica); ` +
        `la petición HTTP añade la ida y vuelta y el JSON de la respuesta`,
    );

    assert.ok(
      parse.medianMs < PARSE_BUDGET_MS,
      `${bank.label}: el parser tardó ${parse.medianMs.toFixed(3)} ms de mediana, ` +
        `presupuesto ${PARSE_BUDGET_MS} ms`,
    );
    assert.ok(
      inProcess.medianMs < SERVICE_BUDGET_MS,
      `${bank.label}: la importación tardó ${inProcess.medianMs.toFixed(3)} ms de mediana, ` +
        `presupuesto ${SERVICE_BUDGET_MS} ms`,
    );
    assert.ok(
      http.medianMs < HTTP_BUDGET_MS,
      `${bank.label}: la importación por HTTP tardó ${http.medianMs.toFixed(3)} ms de mediana, ` +
        `presupuesto ${HTTP_BUDGET_MS} ms`,
    );

    // Los 40 imports reescribieron el mismo archivo: sigue siendo el original.
    assert.equal(
      sha256(await readFile(target)),
      sha256(data),
      `${bank.label}: la copia dejó de coincidir tras las importaciones medidas`,
    );
  }
});

interface BatchSample {
  /** Tiempo de las peticiones, sin contar crear ni borrar la biblioteca. */
  ms: number;
  /** Código HTTP de cada petición, en orden. */
  statuses: number[];
  /** `archivo:estado` de cada banco, en el orden en que respondió el servidor. */
  outcomes: string[];
}

/**
 * Envía los lotes indicados en serie, sobre una biblioteca nueva, y mide solo
 * las peticiones: cada muestra incluye la ida y vuelta HTTP y el JSON, que es
 * justo lo que se paga una vez por petición.
 *
 * Un 422 no es un fallo del test: es la respuesta documentada cuando **todos**
 * los bancos de una petición se rechazan, y trae el resultado de cada uno igual
 * que un 200. Aparece al trocear la lista, porque cada petición suelta de un
 * banco incompatible se queda sin ninguna importación.
 */
async function timeImports(importUrl: string, batches: string[][]): Promise<BatchSample> {
  return withFreshLibrary(async (root) => {
    const started = process.hrtime.bigint();
    const statuses: number[] = [];
    const outcomes: string[] = [];

    for (const sourcePaths of batches) {
      const response = await fetch(importUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ libraryRoot: root, plugin: 'Synth', sourcePaths, overwrite: true }),
      });
      const payload = (await response.json()) as BankImportResponse;
      assert.ok(
        response.status === 200 || response.status === 422,
        `la importación respondió ${response.status}: ${JSON.stringify(payload)}`,
      );
      statuses.push(response.status);
      outcomes.push(...payload.results.map((result) => `${result.fileName}:${result.status}`));
    }

    return { ms: Number(process.hrtime.bigint() - started) / 1e6, statuses, outcomes };
  });
}

/**
 * Una petición con los nueve bancos frente a nueve peticiones de uno, en el
 * mismo orden y con la misma biblioteca de partida. Además de cronometrar,
 * comprueba que el resultado por archivo es idéntico: la compatibilidad se
 * decide banco a banco (referencia explícita, banco ya presente o primer banco
 * del lote), así que trocear la lista no debe cambiar qué se importa y qué se
 * rechaza.
 *
 * Los nueve fixtures son de cinco plugins distintos, así que solo se copian los
 * que comparten `uniqueID` con el primero y el resto se rechaza por
 * incompatibilidad, exactamente igual en las dos estrategias. La diferencia que
 * mide el test es el coste fijo de cada petición (validación de rutas, lectura
 * de la configuración, referencia del destino y JSON), no la copia de los
 * bancos, que es la misma en ambos casos.
 */
test('los nueve bancos reales: una petición frente a nueve', async (t) => {
  const importUrl = `${baseUrl}/library/banks/import`;
  const sources = REAL_BANKS.map((file) => path.join(FIXTURES, file));
  const oneRequest = [sources];
  const nineRequests = sources.map((source) => [source]);

  // Fuera del reloj: comprobar que las dos estrategias hacen el mismo trabajo.
  const firstOne = await timeImports(importUrl, oneRequest);
  const firstNine = await timeImports(importUrl, nineRequests);
  assert.deepEqual(
    firstNine.outcomes,
    firstOne.outcomes,
    'trocear la lista no debe cambiar el resultado por banco',
  );
  assert.deepEqual(firstOne.statuses, [200], 'el lote único contesta una sola vez');
  assert.equal(firstNine.statuses.length, REAL_BANKS.length, 'una petición por banco');
  assert.equal(firstNine.statuses[0], 200, 'el primer banco importa en una biblioteca vacía');
  assert.equal(firstOne.outcomes.length, REAL_BANKS.length, 'cada banco debe tener su resultado');
  assert.ok(
    firstOne.outcomes.some((outcome) => outcome.endsWith(':imported')),
    `el lote debe importar algún banco de verdad: ${firstOne.outcomes.join(', ')}`,
  );

  for (let index = 0; index < BATCH_WARMUP; index += 1) {
    await timeImports(importUrl, oneRequest);
    await timeImports(importUrl, nineRequests);
  }

  const oneSamples: number[] = [];
  const nineSamples: number[] = [];
  for (let index = 0; index < BATCH_ITERATIONS; index += 1) {
    oneSamples.push((await timeImports(importUrl, oneRequest)).ms);
    nineSamples.push((await timeImports(importUrl, nineRequests)).ms);
  }

  const one = timingFromSamples(oneSamples);
  const nine = timingFromSamples(nineSamples);
  const imported = firstOne.outcomes.filter((outcome) => outcome.endsWith(':imported')).length;
  const rejected = firstOne.outcomes.length - imported;
  const factor = nine.medianMs / Math.max(one.medianMs, 1e-6);
  const perRequest = (nine.medianMs - one.medianMs) / REAL_BANKS.length;

  const refused = firstNine.statuses.filter((status) => status === 422).length;
  t.diagnostic(
    `nueve bancos reales → ${imported} importado(s) y ${rejected} rechazado(s) por compatibilidad, ` +
      'con la misma decisión en una petición que en nueve',
  );
  t.diagnostic(
    `el lote único responde 200 una vez; las nueve peticiones dan ` +
      `${firstNine.statuses.filter((status) => status === 200).length}×200 y ${refused}×422 ` +
      '(peticiones en las que se rechazó su único banco)',
  );
  t.diagnostic(`una petición con los nueve ${describeTiming(one, 'lotes/s')}`);
  t.diagnostic(`nueve peticiones de uno ${describeTiming(nine, 'lotes/s')}`);
  t.diagnostic(
    `nueve peticiones cuestan ${factor.toFixed(2)}× el lote único: ` +
      `~${perRequest.toFixed(2)} ms por petición de más (validación de rutas, ` +
      'configuración del plugin, referencia del destino y JSON)',
  );

  assert.ok(
    one.medianMs < ONE_REQUEST_BUDGET_MS,
    `el lote único tardó ${one.medianMs.toFixed(3)} ms de mediana, presupuesto ${ONE_REQUEST_BUDGET_MS} ms`,
  );
  assert.ok(
    nine.medianMs < NINE_REQUESTS_BUDGET_MS,
    `las nueve peticiones tardaron ${nine.medianMs.toFixed(3)} ms de mediana, ` +
      `presupuesto ${NINE_REQUESTS_BUDGET_MS} ms`,
  );
});
