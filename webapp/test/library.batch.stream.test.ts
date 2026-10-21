import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { MAX_PLUGINS_PER_BATCH } from '../src/client/batch-stream';
import type { BatchStreamEvent } from '../src/client/batch-stream';
import { FXB_CONFIG_FILENAME } from '../src/fxb-config/fxb-config.constants';
import { LibraryService } from '../src/library/library.service';
import { pe32Dll, pe64Dll } from './helpers/pe';

/**
 * Progreso en caliente del lote: `POST /library/batch/stream` escribe un evento
 * NDJSON por línea en cuanto ocurre, para que la vista sepa qué plugin se está
 * procesando sin esperar al final.
 *
 * El test del servicio comprueba el intercalado real (el aviso de "en curso"
 * sale antes de que el plugin esté escrito en disco, consultando el disco desde
 * el propio callback); el test HTTP comprueba el formato del flujo, que la
 * validación siga siendo JSON antes del primer byte y que el resultado final
 * coincida con el de `POST /library/batch`.
 */

let app: INestApplication;
let baseUrl: string;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  // `fetch` necesita un servidor real: supertest acumula la respuesta entera.
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

after(async () => {
  await app?.close();
});

interface Library {
  root: string;
  dllSource: string;
  pluginDir(name: string): string;
}

async function makeLibrary(
  t: TestContext,
  names: string[] = ['Synth', 'Bass'],
): Promise<Library> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-batch-stream-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const name of names) {
    const pluginDir = path.join(root, 'plugs', name);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(pluginDir, 'vfxinfo.txt'),
      Buffer.from(`name: ${name}\r\ndll_name: ${name}/${name}.dll\r\n`, 'latin1'),
    );
    await mkdir(path.join(pluginDir, name), { recursive: true });
    await writeFile(path.join(pluginDir, name, `${name}.dll`), pe32Dll());
  }

  const dllSource = path.join(root, 'fxbLoader.dll');
  await writeFile(dllSource, pe32Dll());

  return { root, dllSource, pluginDir: (name) => path.join(root, 'plugs', name) };
}

/** Etiqueta compacta de un evento: `Synth:running`, `Synth:copy`, `end`… */
function label(event: BatchStreamEvent): string {
  if (event.type === 'plugin') return `${event.name}:${event.status}`;
  if (event.type === 'step') return `${event.name}:${event.step}`;
  return event.type;
}

/** Pasos internos de una instalación, en el orden en que los avisa el servidor. */
const INSTALL_STEPS = ['backup', 'copy', 'patch', 'write-config', 'create-dir'] as const;

test('runBatch avisa del plugin en curso antes de escribir su estado en disco', async (t) => {
  // `Missing` no existe en la librería: es el plugin que falla a mitad del lote.
  const lib = await makeLibrary(t, ['Synth', 'Bass']);
  const service = app.get(LibraryService);

  const events: BatchStreamEvent[] = [];
  const installed = (name: string): boolean =>
    existsSync(path.join(lib.pluginDir(name), FXB_CONFIG_FILENAME));

  // El callback es síncrono y se llama dentro del bucle del lote: lo que se
  // vea en el disco aquí es el estado real a mitad del lote.
  const diskAtEvent: { label: string; synth: boolean; bass: boolean }[] = [];
  const stepDisk: { label: string; config: boolean }[] = [];
  const result = await service.runBatch(
    {
      libraryRoot: lib.root,
      action: 'install',
      plugins: ['Synth', 'Missing', 'Bass'],
      dllSourcePath: lib.dllSource,
    },
    (event) => {
      events.push(event);
      if (event.type === 'plugin') {
        diskAtEvent.push({ label: label(event), synth: installed('Synth'), bass: installed('Bass') });
      }
      if (event.type === 'step') {
        stepDisk.push({ label: label(event), config: installed(event.name) });
      }
    },
  );

  assert.deepEqual(events.map(label), [
    'start',
    'Synth:running',
    ...INSTALL_STEPS.map((step) => `Synth:${step}`),
    'Synth:installed',
    'Missing:running',
    'Missing:failed',
    'Bass:running',
    ...INSTALL_STEPS.map((step) => `Bass:${step}`),
    'Bass:installed',
    'end',
  ]);

  // Un `step` por paso interno, numerado dentro del plugin.
  const steps = events.filter((event) => event.type === 'step');
  assert.deepEqual(
    steps.filter((event) => event.name === 'Synth').map((event) => [event.step, event.stepIndex, event.steps]),
    INSTALL_STEPS.map((step, index) => [step, index, INSTALL_STEPS.length]),
  );
  assert.deepEqual(
    steps.filter((event) => event.name === 'Synth').map((event) => [event.index, event.total]),
    INSTALL_STEPS.map(() => [0, 3]),
    'cada paso lleva la posición del plugin en el lote',
  );
  assert.deepEqual(
    steps.map((event) => event.name).filter((name, index) => name !== steps[index - 1]?.name),
    ['Synth', 'Bass'],
    'los pasos de un plugin salen juntos, no mezclados con los del siguiente',
  );

  // La config se escribe en el paso `write-config`: hasta ahí el plugin no está
  // instalado, y el aviso del paso siguiente ya lo ve en disco.
  assert.deepEqual(
    stepDisk.filter((entry) => entry.label.startsWith('Synth:')).map((entry) => entry.config),
    [false, false, false, false, true],
  );

  assert.deepEqual(events[0], {
    type: 'start',
    action: 'install',
    dryRun: false,
    total: 3,
    plugins: ['Synth', 'Missing', 'Bass'],
  });
  assert.deepEqual(events[events.length - 1], { type: 'end', result });

  // Cada aviso de "en curso" llega antes de que ese plugin esté escrito.
  assert.deepEqual(diskAtEvent, [
    { label: 'Synth:running', synth: false, bass: false },
    { label: 'Synth:installed', synth: true, bass: false },
    { label: 'Missing:running', synth: true, bass: false },
    { label: 'Missing:failed', synth: true, bass: false },
    { label: 'Bass:running', synth: true, bass: false },
    { label: 'Bass:installed', synth: true, bass: true },
  ]);

  // Al desinstalar, los pasos son conservar el vfxinfo modificado, restaurar el
  // original y borrar la config.
  const uninstallEvents: BatchStreamEvent[] = [];
  const removed = await service.runBatch(
    {
      libraryRoot: lib.root,
      action: 'uninstall',
      plugins: ['Synth', 'Bass'],
      dllSourcePath: lib.dllSource,
    },
    (event) => uninstallEvents.push(event),
  );
  assert.equal(removed.succeeded, 2);
  assert.deepEqual(uninstallEvents.map(label), [
    'start',
    'Synth:running',
    'Synth:restore',
    'Synth:restore',
    'Synth:delete',
    'Synth:uninstalled',
    'Bass:running',
    'Bass:restore',
    'Bass:restore',
    'Bass:delete',
    'Bass:uninstalled',
    'end',
  ]);

  // Sin callback, `runBatch` devuelve exactamente el mismo resultado.
  const silent = await service.runBatch({
    libraryRoot: lib.root,
    action: 'install',
    plugins: ['Synth', 'Bass'],
    dllSourcePath: lib.dllSource,
  });
  assert.equal(silent.succeeded, 2);
});

test('un dryRun calcula el plan sin avisar de pasos internos', async (t) => {
  const lib = await makeLibrary(t, ['Synth']);
  const service = app.get(LibraryService);
  const events: BatchStreamEvent[] = [];

  const result = await service.runBatch(
    {
      libraryRoot: lib.root,
      action: 'install',
      plugins: ['Synth'],
      dllSourcePath: lib.dllSource,
      dryRun: true,
    },
    (event) => events.push(event),
  );

  // No se ejecuta nada, así que no hay pasos que anunciar; el plan sigue en
  // `actions` para que la vista pueda explicarlo.
  assert.deepEqual(events.map(label), ['start', 'Synth:running', 'Synth:planned', 'end']);
  assert.equal(result.results[0]?.actions.length, 5);
  assert.equal(existsSync(path.join(lib.pluginDir('Synth'), FXB_CONFIG_FILENAME)), false);
});

test('POST /library/batch/stream responde NDJSON con un evento por línea', async (t) => {
  // Dos librerías idénticas: una para el flujo y otra para compararlo con
  // `POST /library/batch`, que si no encontraría los plugins ya instalados.
  const lib = await makeLibrary(t);
  const twin = await makeLibrary(t);

  const response = await fetch(`${baseUrl}/library/batch/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify({
      libraryRoot: lib.root,
      action: 'install',
      plugins: ['Synth', 'Missing', 'Bass'],
      dllSourcePath: lib.dllSource,
    }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/x-ndjson/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  // Si el servidor acumulara la respuesta entera sabría su longitud de antemano.
  assert.equal(response.headers.get('content-length'), null);

  const text = await response.text();
  assert.equal(text.endsWith('\n'), true, 'cada evento termina en salto de línea');
  const events = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BatchStreamEvent);

  assert.deepEqual(events.map(label), [
    'start',
    'Synth:running',
    ...INSTALL_STEPS.map((step) => `Synth:${step}`),
    'Synth:installed',
    'Missing:running',
    'Missing:failed',
    'Bass:running',
    ...INSTALL_STEPS.map((step) => `Bass:${step}`),
    'Bass:installed',
    'end',
  ]);

  const last = events[events.length - 1]!;
  assert.equal(last.type, 'end');
  assert.ok(last.type === 'end');
  assert.equal(last.result.action, 'install');
  assert.equal(last.result.total, 3);
  assert.equal(last.result.succeeded, 2);
  assert.equal(last.result.failed, 1);
  assert.deepEqual(
    last.result.results.map((result) => [result.name, result.status]),
    [
      ['Synth', 'installed'],
      ['Missing', 'failed'],
      ['Bass', 'installed'],
    ],
  );
  assert.match(
    last.result.results[1]?.message ?? '',
    /no existe el plugin "Missing"/,
    'el motivo del fallo va en el evento final de ese plugin',
  );

  // El mismo lote por `POST /library/batch` da los mismos contadores y estados.
  const plain = await fetch(`${baseUrl}/library/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      libraryRoot: twin.root,
      action: 'install',
      plugins: ['Synth', 'Missing', 'Bass'],
      dllSourcePath: twin.dllSource,
    }),
  });
  assert.equal(plain.status, 200);
  const body = (await plain.json()) as {
    action: string;
    total: number;
    succeeded: number;
    failed: number;
    results: { name: string; status: string }[];
  };
  assert.equal(body.action, last.result.action);
  assert.equal(body.total, last.result.total);
  assert.equal(body.succeeded, last.result.succeeded);
  assert.equal(body.failed, last.result.failed);
  assert.deepEqual(
    body.results.map((result) => [result.name, result.status]),
    last.result.results.map((result) => [result.name, result.status]),
  );
});

test('el flujo no escribe nada si la petición no pasa la validación', async (t) => {
  const lib = await makeLibrary(t, ['Synth']);
  const badLoader = path.join(lib.root, 'loader64.dll');
  await writeFile(badLoader, pe64Dll());

  const invalid = await fetch(`${baseUrl}/library/batch/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ libraryRoot: lib.root, action: 'install', plugins: [] }),
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.headers.get('content-type') ?? '', /application\/json/);
  assert.match(((await invalid.json()) as { message: string }).message, /plugins/);

  const wrongLoader = await fetch(`${baseUrl}/library/batch/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      libraryRoot: lib.root,
      action: 'install',
      plugins: ['Synth'],
      dllSourcePath: badLoader,
    }),
  });
  assert.equal(wrongLoader.status, 422);
  assert.match(wrongLoader.headers.get('content-type') ?? '', /application\/json/);
  assert.match(((await wrongLoader.json()) as { message: string }).message, /PE32\+|PE32 i386/);

  // Tampoco por encima del tope: el rechazo también es JSON, sin `start`.
  const tooMany = await fetch(`${baseUrl}/library/batch/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      libraryRoot: lib.root,
      action: 'install',
      plugins: Array.from({ length: MAX_PLUGINS_PER_BATCH + 1 }, (_, index) => `P${index}`),
      dllSourcePath: lib.dllSource,
    }),
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(
    ((await tooMany.json()) as { message: string }).message,
    `como máximo ${MAX_PLUGINS_PER_BATCH} plugins por petición`,
  );

  // Ninguna de las tres peticiones llegó a tocar el plugin.
  assert.equal(existsSync(path.join(lib.pluginDir('Synth'), FXB_CONFIG_FILENAME)), false);
});
