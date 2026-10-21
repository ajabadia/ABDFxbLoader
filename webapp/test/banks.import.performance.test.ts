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
import { describeTiming, measureAsync, measureSync } from './helpers/timing';

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
async function makeLibrary(t: TestContext): Promise<{ root: string; plugin: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-import-perf-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pluginDir = path.join(root, 'plugs', 'Synth');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, 'vfxinfo.txt'),
    Buffer.from('name: Synth\r\ndll_name: Synth/Synth.dll\r\n', 'latin1'),
  );

  return { root, plugin: 'Synth' };
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
