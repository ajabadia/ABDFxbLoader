import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { MAX_BANKS_PER_REQUEST } from '../src/client/bank-limits';
import type { BankImportStreamEvent } from '../src/client/bank-import-stream';
import { LibraryService } from '../src/library/library.service';
import { buildBank } from './helpers/fxb-bank';
import { writePluginDll } from './helpers/vfx-plugin';

/**
 * Importación de bancos con progreso NDJSON: `POST /library/banks/import/stream`
 * avisa del resultado de cada archivo en cuanto se procesa, no al cerrar el
 * trozo. El flujo se valida antes del primer byte y, si todos se rechazan,
 * termina con `end` en vez de un 422: la vista cuenta los `rejected`.
 */

let app: INestApplication;
let baseUrl: string;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

after(async () => {
  await app?.close();
});

interface Library {
  root: string;
  pluginDir: string;
  banksDir: string;
  presetsDir: string;
}

async function makeLibrary(t: TestContext): Promise<Library> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-bank-import-stream-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pluginDir = path.join(root, 'plugs', 'Synth');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, 'vfxinfo.txt'),
    Buffer.from('name: Synth\r\ndll_name: Synth/Synth.dll\r\n', 'latin1'),
  );
  await writePluginDll(pluginDir, 'Synth/Synth.dll');

  const banksDir = path.join(root, 'banks');
  await mkdir(banksDir);
  return { root, pluginDir, banksDir, presetsDir: path.join(pluginDir, 'presets') };
}

async function bank(
  library: Library,
  name: string,
  options: Parameters<typeof buildBank>[0] = {},
): Promise<string> {
  const file = path.join(library.banksDir, name);
  await writeFile(file, buildBank(options));
  return file;
}

function label(event: BankImportStreamEvent): string {
  if (event.type === 'bank') return `${event.result.fileName}:${event.result.status}`;
  return event.type;
}

test('el servicio avisa de cada banco y del cierre, en el orden del lote', async (t) => {
  const library = await makeLibrary(t);
  const good = await bank(library, 'Good.fxb');
  const foreign = await bank(library, 'Foreign.fxb', { uniqueId: 'Othr' });
  const missing = path.join(library.banksDir, 'Missing.fxb');
  const events: BankImportStreamEvent[] = [];

  const result = await app.get(LibraryService).importBanks(
    {
      libraryRoot: library.root,
      plugin: 'Synth',
      sourcePaths: [good, foreign, missing],
      expectedUniqueId: 'MySy',
    },
    (event) => events.push(event),
  );

  assert.deepEqual(events.map(label), [
    'start',
    'Good.fxb:imported',
    'Foreign.fxb:rejected',
    'Missing.fxb:rejected',
    'end',
  ]);
  assert.equal(events[0]?.type === 'start' ? events[0].total : -1, 3);
  const end = events.at(-1);
  assert.ok(end?.type === 'end');
  assert.deepEqual(end.result, result);
  assert.deepEqual(
    result.results.map((item) => item.status),
    ['imported', 'rejected', 'rejected'],
  );
});

test('POST /library/banks/import/stream responde NDJSON y termina con end', async (t) => {
  const library = await makeLibrary(t);
  const first = await bank(library, 'First.fxb');
  const second = await bank(library, 'Second.fxb', { uniqueId: 'Othr' });

  const response = await fetch(`${baseUrl}/library/banks/import/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify({
      libraryRoot: library.root,
      plugin: 'Synth',
      sourcePaths: [first, second],
      expectedUniqueId: 'MySy',
    }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/x-ndjson/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-length'), null);

  const text = await response.text();
  assert.equal(text.endsWith('\n'), true, 'cada evento termina en salto de línea');
  const events = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BankImportStreamEvent);

  assert.deepEqual(events.map(label), [
    'start',
    'First.fxb:imported',
    'Second.fxb:rejected',
    'end',
  ]);
  const start = events[0];
  assert.ok(start?.type === 'start');
  assert.equal(start.total, 2);
  assert.deepEqual(start.sourcePaths, [first, second]);
  const end = events.at(-1);
  assert.ok(end?.type === 'end');
  assert.equal(end.result.results.length, 2);
  assert.equal(end.result.results[0]?.status, 'imported');
  assert.equal(end.result.results[1]?.status, 'rejected');
});

test('todos rechazados termina con end y 200, sin convertir el rechazo en 422', async (t) => {
  const library = await makeLibrary(t);
  const foreign = await bank(library, 'Foreign.fxb', { uniqueId: 'Othr' });

  const response = await fetch(`${baseUrl}/library/banks/import/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      libraryRoot: library.root,
      plugin: 'Synth',
      sourcePaths: [foreign],
      expectedUniqueId: 'MySy',
    }),
  });

  assert.equal(response.status, 200);
  const events = (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as BankImportStreamEvent);
  assert.deepEqual(events.map(label), ['start', 'Foreign.fxb:rejected', 'end']);
  assert.equal(events.at(-1)?.type, 'end');
});

test('la validación sigue siendo JSON antes del primer evento', async (t) => {
  const library = await makeLibrary(t);
  const one = await bank(library, 'One.fxb');

  const invalid = await fetch(`${baseUrl}/library/banks/import/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ libraryRoot: library.root, plugin: 'Synth', sourcePaths: [] }),
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.headers.get('content-type') ?? '', /application\/json/);
  assert.match(((await invalid.json()) as { message: string }).message, /sourcePaths/);

  const tooMany = await fetch(`${baseUrl}/library/banks/import/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      libraryRoot: library.root,
      plugin: 'Synth',
      sourcePaths: Array.from({ length: MAX_BANKS_PER_REQUEST + 1 }, () => one),
    }),
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(
    ((await tooMany.json()) as { message: string }).message,
    `como máximo ${MAX_BANKS_PER_REQUEST} bancos por petición`,
  );

  const missingPlugin = await fetch(`${baseUrl}/library/banks/import/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      libraryRoot: library.root,
      plugin: 'NoExiste',
      sourcePaths: [one],
    }),
  });
  assert.equal(missingPlugin.status, 404);
  assert.match(missingPlugin.headers.get('content-type') ?? '', /application\/json/);
});
