import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import openapiTS, { astToString, COMMENT_HEADER } from 'openapi-typescript';
import { AppModule } from '../src/app.module';
import { pe32Dll } from './helpers/pe';
import {
  createFxbClient,
  FxbApiError,
  isFxbApiError,
  type FxbClient,
  type FxbConfigSnapshotResponse,
  type LibraryBankConvertResponse,
  type LibraryBankDiscardBackupResponse,
  type LibraryBankRestoreResponse,
  type LibraryBanksImportResponse,
  type LibraryBanksListResponse,
  type LibraryBatchResponse,
  type LibraryLoaderAddResponse,
  type LibraryScanResponse,
  type PluginMetaSnapshotResponse,
} from '../src/client';
import type { BankImportStreamEvent } from '../src/client/bank-import-stream';
import type { BatchStreamEvent } from '../src/client/batch-stream';
import { buildBank } from './helpers/fxb-bank';

// Los descartes de esta suite borran directo a disco: no se debe llenar la
// Papelera real con cada corrida. El mensaje real lo cubre `trash.test.ts`,
// que sí usa la papelera del sistema.
process.env['FXB_TRASH_MODE'] = 'direct';

/**
 * Comprobaciones en tiempo de compilación: si los tipos generados dejan de
 * derivarse del contrato (o alguien relaja los métodos a `any`), `tsc` falla
 * por un `@ts-expect-error` sin usar.
 */
function typeChecks(client: FxbClient): void {
  // @ts-expect-error `plugin` es obligatorio en install
  void client.library.addLoader({ libraryRoot: 'C:\\VFX\\Library' });
  // @ts-expect-error `libraryRoot` es una cadena
  void client.library.scan({ libraryRoot: 42 });
  // @ts-expect-error el scan devuelve plugins, no un plugin suelto
  void client.library.scan({ libraryRoot: 'C:\\VFX\\Library' }).then((scan) => scan.plugin);
  // El orden de destino es opcional, pero solo admite big o little.
  void client.library.convertDefaultBank({ libraryRoot: 'C:\\VFX\\Library', plugin: 'MySynth' });
  void client.library.convertDefaultBank({
    libraryRoot: 'C:\\VFX\\Library',
    plugin: 'MySynth',
    endianness: 'little',
  });
  void client.library.convertDefaultBank({
    libraryRoot: 'C:\\VFX\\Library',
    plugin: 'MySynth',
    // @ts-expect-error `endianness` desconocida
    endianness: 'middle',
  });
  // Restaurar no elige orden: devuelve exactamente el respaldo `.orig`.
  void client.library.restoreDefaultBank({
    libraryRoot: 'C:\\VFX\\Library',
    plugin: 'MySynth',
    // @ts-expect-error restaurar no admite orden de bytes
    endianness: 'big',
  });
  // @ts-expect-error `plugin` es obligatorio al restaurar
  void client.library.restoreDefaultBank({ libraryRoot: 'C:\\VFX\\Library' });
  // Descartar el respaldo no elige orden ni banco: solo la biblioteca y el plugin.
  void client.library.discardDefaultBankBackup({
    libraryRoot: 'C:\\VFX\\Library',
    plugin: 'MySynth',
  });
  void client.library.discardDefaultBankBackup({
    libraryRoot: 'C:\\VFX\\Library',
    plugin: 'MySynth',
    // @ts-expect-error descartar el respaldo no admite `endianness`
    endianness: 'big',
  });
  // El meta exige el directorio y el `mtimeMs` leído, aunque sea `null`.
  void client.plugins.meta.read({ id: 'MySy', dir: 'C:\\VFX\\plugs\\MySynth' });
  void client.plugins.meta.write({
    id: 'MySy',
    pluginDir: 'C:\\VFX\\plugs\\MySynth',
    expectedMtimeMs: null,
  });
  // @ts-expect-error `dir` es obligatorio al leer
  void client.plugins.meta.read({ id: 'MySy' });
  // @ts-expect-error `expectedMtimeMs` es obligatorio, aunque valga null
  void client.plugins.meta.write({ id: 'MySy', pluginDir: 'C:\\VFX\\plugs\\MySynth' });
  void client.plugins.meta.write({
    id: 'MySy',
    pluginDir: 'C:\\VFX\\plugs\\MySynth',
    expectedMtimeMs: null,
    common: {
      // @ts-expect-error `common` no admite valores que no sean cadenas
      rating: 4,
    },
  });
}
void typeChecks;

const WEBAPP = path.resolve(__dirname, '..', '..');

/** Etiqueta compacta de un evento del lote: `Synth:running`, `Synth:copy`… */
function label(event: BatchStreamEvent): string {
  if (event.type === 'plugin') return `${event.name}:${event.status}`;
  if (event.type === 'step') return `${event.name}:${event.step}`;
  return event.type;
}

/** Etiqueta compacta de un evento del import: `0:imported`, `1:rejected`… */
function bankLabel(event: BankImportStreamEvent): string {
  if (event.type === 'bank') return `${event.index}:${event.result.status}`;
  return event.type;
}

test('api-types.ts está sincronizado con openapi.json', async () => {
  const schema = JSON.parse(await readFile(path.join(WEBAPP, 'openapi.json'), 'utf8')) as Parameters<
    typeof openapiTS
  >[0];
  const generated = COMMENT_HEADER + astToString(await openapiTS(schema));
  const stored = await readFile(path.join(WEBAPP, 'src', 'client', 'api-types.ts'), 'utf8');

  assert.equal(
    generated.trim(),
    stored.trim(),
    'api-types.ts no coincide con openapi.json; ejecuta npm run client',
  );
});

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

interface Scaffold {
  root: string;
  dll: string;
  bank: string;
  foreign: string;
}

async function scaffold(t: TestContext): Promise<Scaffold> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-client-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pluginDir = path.join(root, 'plugs', 'Synth');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, 'vfxinfo.txt'),
    Buffer.from('name: Synth\r\ndll_name: Synth/Synth.dll\r\n', 'latin1'),
  );
  await mkdir(path.join(pluginDir, 'Synth'), { recursive: true });
  await writeFile(path.join(pluginDir, 'Synth', 'Synth.dll'), pe32Dll());

  const dll = path.join(root, 'loader.dll');
  await writeFile(dll, pe32Dll());

  const banks = path.join(root, 'banks');
  await mkdir(banks);
  const bank = path.join(banks, 'Rhodes.fxb');
  const foreign = path.join(banks, 'Otro.fxb');
  await writeFile(bank, buildBank({ uniqueId: 'MySy', programs: 1 }));
  await writeFile(foreign, buildBank({ uniqueId: 'OtSy', programs: 1 }));

  return { root, dll, bank, foreign };
}

test('el cliente tipado recorre scan, install, import, uninstall y config', async (t) => {
  const data = await scaffold(t);
  let calls = 0;
  // baseUrl con barra final y fetch inyectado: las dos opciones deben aplicarse.
  const client = createFxbClient({
    baseUrl: `${baseUrl}/`,
    fetch: (input, init) => {
      calls += 1;
      return fetch(input, init);
    },
  });

  const scan: LibraryScanResponse = await client.library.scan({ libraryRoot: data.root });
  assert.equal(calls, 1);
  assert.deepEqual(
    scan.plugins.map((plugin) => [plugin.name, plugin.hasLoader, plugin.pluginName]),
    [['Synth', false, null]],
  );
  assert.equal(scan.loader.valid, true);
  assert.equal(scan.loader.bitness, 32);
  assert.equal(scan.plugins[0]?.compatible, true);

  const dry: LibraryLoaderAddResponse = await client.library.addLoader({
    libraryRoot: data.root,
    plugin: 'Synth',
    dllSourcePath: data.dll,
    dryRun: true,
  });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(
    dry.actions.map((action) => action.kind),
    ['backup', 'copy', 'patch', 'write-config', 'create-dir'],
  );

  const added: LibraryLoaderAddResponse = await client.library.addLoader({
    libraryRoot: data.root,
    plugin: 'Synth',
    dllSourcePath: data.dll,
  });
  assert.equal(added.plugin.hasLoader, true);
  assert.equal(added.plugin.pluginName, 'Synth.dll');

  await assert.rejects(
    client.library.addLoader({ libraryRoot: data.root, plugin: 'Synth', dllSourcePath: data.dll }),
    (error: unknown) => {
      assert.equal(isFxbApiError(error), true);
      assert.equal((error as FxbApiError).status, 409);
      const body = (error as FxbApiError).body as { message?: string };
      assert.match(String(body.message), /ya tiene el cargador/);
      return true;
    },
  );

  // El lote pasa por el servidor y devuelve el resultado de cada plugin.
  const batched: LibraryBatchResponse = await client.library.batch({
    libraryRoot: data.root,
    action: 'add',
    plugins: ['Synth'],
    dllSourcePath: data.dll,
    force: true,
  });
  assert.equal(batched.action, 'add');
  assert.equal(batched.total, 1);
  assert.equal(batched.succeeded, 1);
  assert.equal(batched.failed, 0);
  assert.equal(batched.results[0]?.name, 'Synth');
  assert.equal(batched.results[0]?.status, 'added');
  assert.equal(batched.results[0]?.message, null);
  assert.equal(batched.results[0]?.entry?.hasLoader, true);

  // El mismo lote leyendo el progreso NDJSON: los eventos llegan en orden y el
  // resultado es el del evento `end`.
  const streamEvents: BatchStreamEvent[] = [];
  const streamed = await client.library.batchStream(
    {
      libraryRoot: data.root,
      action: 'add',
      plugins: ['Synth'],
      dllSourcePath: data.dll,
      force: true,
    },
    { onEvent: (event) => streamEvents.push(event) },
  );
  assert.deepEqual(streamEvents.map(label), [
    'start',
    'Synth:running',
    'Synth:backup',
    'Synth:copy',
    'Synth:patch',
    'Synth:write-config',
    'Synth:create-dir',
    'Synth:added',
    'end',
  ]);
  assert.equal(streamed.succeeded, 1);
  assert.deepEqual(
    streamed.results.map((result) => [result.name, result.status]),
    [['Synth', 'added']],
  );

  const inspected = await client.library.inspectBank({
    sourcePath: data.bank,
    libraryRoot: data.root,
    plugin: 'Synth',
  });
  assert.equal(inspected.valid, true);
  assert.equal(inspected.bank?.uniqueId, 'MySy');
  assert.equal(inspected.existingBanks.length, 0);
  assert.equal(inspected.targetExists, false);

  const imported: LibraryBanksImportResponse = await client.library.importBanks({
    libraryRoot: data.root,
    plugin: 'Synth',
    sourcePaths: [data.bank],
    expectedUniqueId: 'MySy',
  });
  assert.equal(imported.results[0]?.status, 'imported');
  assert.equal(imported.reference.source, 'explicit');
  assert.equal(imported.results[0]?.bank?.uniqueId, 'MySy');

  // La misma importación por NDJSON entrega el resultado en cuanto acaba el
  // banco y resuelve con el cuerpo del evento `end`.
  const importEvents: BankImportStreamEvent[] = [];
  const streamedImport = await client.library.importBanksStream(
    {
      libraryRoot: data.root,
      plugin: 'Synth',
      sourcePaths: [data.bank],
      expectedUniqueId: 'MySy',
    },
    { onEvent: (event) => importEvents.push(event) },
  );
  assert.deepEqual(
    importEvents.map((event) =>
      event.type === 'bank' ? `${event.result.fileName}:${event.result.status}` : event.type,
    ),
    ['start', 'Rhodes.fxb:overwritten', 'end'],
  );
  assert.equal(streamedImport.results[0]?.status, 'overwritten');
  assert.equal(streamedImport.reference.source, 'explicit');

  const listed: LibraryBanksListResponse = await client.library.listBanks({
    libraryRoot: data.root,
    plugin: 'Synth',
  });
  assert.deepEqual(
    listed.banks.map((entry) => entry.fileName),
    ['Rhodes.fxb'],
  );
  assert.equal(listed.presetsDirExists, true);
  assert.equal(listed.config.exists, true);

  // Exportación: el banco importado (little-endian) se convierte a big-endian.
  const exported = await client.library.exportBank({
    libraryRoot: data.root,
    plugin: 'Synth',
    fileName: 'Rhodes.fxb',
    endianness: 'big',
  });
  assert.equal(exported.changed, true);
  assert.equal(exported.source.bank.endianness, 'little');
  assert.equal(exported.target.bank.endianness, 'big');
  assert.equal(exported.target.fileName, 'Rhodes-be.fxb');

  await assert.rejects(
    client.library.exportBank({
      libraryRoot: data.root,
      plugin: 'Synth',
      fileName: 'Rhodes.fxb',
      endianness: 'big',
    }),
    (error: unknown) => {
      assert.equal(isFxbApiError(error), true);
      assert.equal((error as FxbApiError).status, 409);
      return true;
    },
  );

  await assert.rejects(
    client.library.importBanks({
      libraryRoot: data.root,
      plugin: 'Synth',
      sourcePaths: [data.foreign],
      expectedUniqueId: 'MySy',
    }),
    (error: unknown) => {
      assert.equal(isFxbApiError(error), true);
      const apiError = error as FxbApiError;
      assert.equal(apiError.status, 422);
      const body = apiError.body as LibraryBanksImportResponse & { message: string };
      assert.equal(body.message, 'Ningún banco se pudo importar');
      assert.equal(body.results[0]?.compatibility, 'incompatible');
      return true;
    },
  );

  const snapshot: FxbConfigSnapshotResponse = await client.config.read({
    pluginDir: path.join(data.root, 'plugs', 'Synth'),
  });
  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.config.programDirName, 'presets');
  assert.equal(typeof snapshot.mtimeMs, 'number');

  const written: FxbConfigSnapshotResponse = await client.config.write({
    pluginDir: snapshot.configPath.replace(/[\\/]fxbLoader\.config$/, ''),
    expectedMtimeMs: snapshot.mtimeMs,
    config: { defaultFxbName: 'Rhodes.fxb' },
  });
  assert.equal(written.config.defaultFxbName, 'Rhodes.fxb');
  assert.equal(written.config.programDirName, 'presets');

  // Conversión en el sitio del banco por defecto: mismo nombre y un respaldo.
  const converted: LibraryBankConvertResponse = await client.library.convertDefaultBank({
    libraryRoot: data.root,
    plugin: 'Synth',
  });
  assert.equal(converted.fileName, 'Rhodes.fxb');
  assert.equal(converted.changed, true);
  assert.equal(converted.source.bank.endianness, 'little');
  assert.equal(converted.target.bank.endianness, 'big');
  assert.equal(converted.target.fileName, 'Rhodes.fxb');
  assert.equal(converted.backup?.fileName, 'Rhodes.fxb.orig');
  assert.equal(converted.backupCreated, true);

  // La lista anuncia el respaldo y la restauración lo devuelve sin consumirlo.
  const withBackup: LibraryBanksListResponse = await client.library.listBanks({
    libraryRoot: data.root,
    plugin: 'Synth',
  });
  assert.deepEqual(withBackup.defaultBackup, {
    fileName: 'Rhodes.fxb.orig',
    size: converted.backup?.size,
  });

  const restored: LibraryBankRestoreResponse = await client.library.restoreDefaultBank({
    libraryRoot: data.root,
    plugin: 'Synth',
  });
  assert.equal(restored.fileName, 'Rhodes.fxb');
  assert.equal(restored.changed, true);
  assert.equal(restored.restored.bank.endianness, 'little');
  assert.equal(restored.restored.sha256, converted.source.sha256);
  assert.equal(restored.backup.fileName, 'Rhodes.fxb.orig');
  assert.equal(restored.backup.sha256, converted.source.sha256);

  const restoredAgain: LibraryBankRestoreResponse = await client.library.restoreDefaultBank({
    libraryRoot: data.root,
    plugin: 'Synth',
  });
  assert.equal(restoredAgain.changed, false);
  assert.equal(restoredAgain.backup.sha256, restored.backup.sha256);

  // Descartar el respaldo deja el banco como está y ya no se puede restaurar.
  const discarded: LibraryBankDiscardBackupResponse =
    await client.library.discardDefaultBankBackup({
      libraryRoot: data.root,
      plugin: 'Synth',
    });
  assert.equal(discarded.fileName, 'Rhodes.fxb');
  assert.equal(discarded.discarded.fileName, 'Rhodes.fxb.orig');
  assert.equal(discarded.discarded.sha256, converted.source.sha256);

  const afterDiscard = await client.library.listBanks({
    libraryRoot: data.root,
    plugin: 'Synth',
  });
  assert.equal(afterDiscard.defaultBackup, null);
  assert.equal(afterDiscard.config.config.defaultFxbName, 'Rhodes.fxb');

  await assert.rejects(
    client.config.write({
      pluginDir: snapshot.configPath.replace(/[\\/]fxbLoader\.config$/, ''),
      expectedMtimeMs: snapshot.mtimeMs,
      config: { loadFxbBank: false },
    }),
    (error: unknown) => {
      assert.equal((error as FxbApiError).status, 409);
      const body = (error as FxbApiError).body as { current?: { mtimeMs: number | null } };
      assert.equal(typeof body.current?.mtimeMs, 'number');
      return true;
    },
  );

  await assert.rejects(
    client.library.scan({ libraryRoot: 'plugs' }),
    (error: unknown) => {
      assert.equal((error as FxbApiError).status, 400);
      assert.match(String((error as FxbApiError).message), /ruta absoluta/);
      return true;
    },
  );

  const removed = await client.library.removeLoader({
    libraryRoot: data.root,
    plugin: 'Synth',
  });
  assert.equal(removed.plugin.hasLoader, false);
  assert.deepEqual(
    removed.actions.map((action) => action.kind),
    ['restore', 'restore', 'delete'],
  );
});

test('el cliente lee y escribe el meta del plugin con control de mtime', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fxb-client-meta-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const client = createFxbClient({ baseUrl });

  const empty = await client.plugins.meta.read({ id: 'My Sy', dir });
  assert.equal(empty.exists, false);
  assert.equal(empty.mtimeMs, null);
  assert.equal(empty.metaPath, path.join(dir, 'fxbLoader.meta.json'));

  const created: PluginMetaSnapshotResponse = await client.plugins.meta.write({
    id: 'My Sy',
    pluginDir: dir,
    expectedMtimeMs: null,
    common: { id: 'MySy', name: 'MySynth' },
    extended: { category: 'electric-piano' },
  });
  assert.equal(created.exists, true);
  assert.equal(created.common.name, 'MySynth');
  assert.deepEqual(created.extended, { category: 'electric-piano' });
  assert.equal(typeof created.mtimeMs, 'number');

  // Una segunda escritura parte del `mtimeMs` devuelto y conserva lo omitido.
  const updated = await client.plugins.meta.write({
    id: 'My Sy',
    pluginDir: dir,
    expectedMtimeMs: created.mtimeMs,
    common: { name: 'MySynth 2' },
    extended: { tags: { family: 'keys' } },
  });
  assert.equal(updated.common.name, 'MySynth 2');
  assert.equal(updated.common.id, 'MySy');
  assert.deepEqual(updated.extended, {
    category: 'electric-piano',
    tags: { family: 'keys' },
  });

  // El id de la ruta se codifica: un espacio no rompe la petición.
  const read = await client.plugins.meta.read({ id: 'My Sy', dir });
  assert.equal(read.common.name, 'MySynth 2');

  // Un `mtimeMs` viejo es conflicto y trae el estado del disco.
  await assert.rejects(
    client.plugins.meta.write({
      id: 'My Sy',
      pluginDir: dir,
      expectedMtimeMs: 1,
      common: { name: 'Otro' },
    }),
    (error: unknown) => {
      assert.equal(isFxbApiError(error), true);
      assert.equal((error as FxbApiError).status, 409);
      const body = (error as FxbApiError).body as { current?: { common?: { name?: string } } };
      assert.equal(body.current?.common?.name, 'MySynth 2');
      return true;
    },
  );

  // Una ruta inexistente es 400, no un fallo del cliente.
  await assert.rejects(
    client.plugins.meta.read({ id: 'My Sy', dir: path.join(dir, 'NoExiste') }),
    (error: unknown) => {
      assert.equal(isFxbApiError(error), true);
      assert.equal((error as FxbApiError).status, 400);
      assert.match(String((error as FxbApiError).message), /el directorio no existe/);
      return true;
    },
  );
});

/** Deja correr las microtareas pendientes de la lectura del flujo. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('associationAudit.list manda el filtro por plugin en el cuerpo', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-client-audit-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const line = (plugin: string, ts: string): string =>
    `${JSON.stringify({
      ts,
      kind: 'association-change',
      plugin,
      libraryRoot: root,
      field: 'dll_name',
      previousValue: 'a.dll',
      newValue: 'b.dll',
    })}\n`;
  await writeFile(
    path.join(root, 'fxbLoader.audit.jsonl'),
    `${line('Synth', '2026-10-25T09:32:11.482Z')}${line('OtroModulo', '2026-10-25T09:35:02.100Z')}`,
    'utf8',
  );

  const client = createFxbClient({ baseUrl });

  const all = await client.associationAudit.list({ libraryRoot: root });
  assert.equal(all.exists, true);
  assert.equal(all.total, 2, 'sin filtro se leen las dos líneas del almacén');

  const filtered = await client.associationAudit.list({ libraryRoot: root, plugin: 'Synth' });
  assert.equal(filtered.total, 1, 'el filtro por plugin viaja en el cuerpo y lo aplica el servidor');
  assert.equal(filtered.entries[0]?.plugin, 'Synth');
  assert.match(filtered.auditPath, /fxbLoader\.audit\.jsonl$/);
});

/** `fetch` falso que devuelve un flujo que el test controla trozo a trozo. */
function controlledStream(): {
  fetch: typeof globalThis.fetch;
  push: (text: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let push: (text: string) => void = () => undefined;
  let close: () => void = () => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (text) => controller.enqueue(encoder.encode(text));
      close = () => controller.close();
    },
  });
  const fake = (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    })) as unknown as typeof globalThis.fetch;
  return { fetch: fake, push, close };
}

test('batchStream entrega cada evento según llega, sin esperar al final', async () => {
  const stream = controlledStream();
  const client = createFxbClient({ baseUrl: 'http://127.0.0.1:1', fetch: stream.fetch });

  const seen: string[] = [];
  let finished = false;
  const pending = client.library.batchStream(
    { libraryRoot: 'C:\VFX\Library', action: 'add', plugins: ['Synth'] },
    { onEvent: (event) => seen.push(label(event)) },
  );
  void pending.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );

  // El primer evento llega partido en dos trozos, como puede pasar por TCP.
  stream.push(
    '{"type":"start","action":"add","dryRun":false,"total":1,"plugins":["Synth"]}\n{"type":"plug',
  );
  await tick();
  assert.deepEqual(seen, ['start'], 'el start se entrega con el lote aún abierto');
  assert.equal(finished, false, 'la promesa no se resuelve hasta el evento end');

  stream.push('in","index":0,"total":1,"name":"Synth","status":"running","message":null}\n');
  await tick();
  assert.deepEqual(seen, ['start', 'Synth:running']);
  assert.equal(finished, false);

  stream.push(
    '{"type":"end","result":{"action":"add","dryRun":false,"total":1,"succeeded":1,' +
      '"failed":0,"results":[{"name":"Synth","status":"added","message":null}]}}\n',
  );
  stream.close();

  const result = await pending;
  assert.deepEqual(seen, ['start', 'Synth:running', 'end']);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);
});

test('importBanksStream entrega cada banco según llega, sin esperar al final', async () => {
  const stream = controlledStream();
  const client = createFxbClient({ baseUrl: 'http://127.0.0.1:1', fetch: stream.fetch });

  const seen: string[] = [];
  let finished = false;
  const pending = client.library.importBanksStream(
    {
      libraryRoot: 'C:\\VFX\\Library',
      plugin: 'Synth',
      sourcePaths: ['C:\\Banks\\First.fxb', 'C:\\Banks\\Second.fxb'],
    },
    { onEvent: (event) => seen.push(bankLabel(event)) },
  );
  void pending.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );

  stream.push(
    '{"type":"start","total":2,"sourcePaths":["C:/Banks/First.fxb","C:/Banks/Second.fxb"]}\n' +
      '{"type":"bank","index":0,"total":2,"result":{"source":"C:/Banks/First.fxb",' +
      '"fileName":"First.fxb","target":"C:/VFX/Library/presets/First.fxb",' +
      '"status":"imported","compatibility":"compatible","reason":null,"issues":[],"warnings":[],"bank":null}}\n',
  );
  await tick();
  assert.deepEqual(seen, ['start', '0:imported'], 'el primer banco se entrega con el flujo abierto');
  assert.equal(finished, false, 'la promesa no se resuelve hasta el evento end');

  stream.push(
    '{"type":"bank","index":1,"total":2,"result":{"source":"C:/Banks/Second.fxb",' +
      '"fileName":"Second.fxb","target":"C:/VFX/Library/presets/Second.fxb",' +
      '"status":"rejected","compatibility":"incompatible","reason":"uniqueID distinto",' +
      '"issues":[],"warnings":[],"bank":null}}\n' +
      '{"type":"end","result":{"plugin":null,"presetsDir":"",' +
      '"reference":{"source":"none","uniqueId":null,"uniqueIdValue":null,"fxVersion":null,"file":null},' +
      '"results":[{"source":"C:/Banks/First.fxb","fileName":"First.fxb",' +
      '"target":"C:/VFX/Library/presets/First.fxb","status":"imported",' +
      '"compatibility":"compatible","reason":null,"issues":[],"warnings":[],"bank":null},' +
      '{"source":"C:/Banks/Second.fxb","fileName":"Second.fxb",' +
      '"target":"C:/VFX/Library/presets/Second.fxb","status":"rejected",' +
      '"compatibility":"incompatible","reason":"uniqueID distinto","issues":[],"warnings":[],"bank":null}]}}\n',
  );
  stream.close();

  const result = await pending;
  assert.deepEqual(seen, ['start', '0:imported', '1:rejected', 'end']);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[1]?.status, 'rejected');
});

test('importBanksStream falla si el flujo se corta sin evento end', async () => {
  const stream = controlledStream();
  const client = createFxbClient({ baseUrl: 'http://127.0.0.1:1', fetch: stream.fetch });

  const pending = client.library.importBanksStream({
    libraryRoot: 'C:\\VFX\\Library',
    plugin: 'Synth',
    sourcePaths: ['C:\\Banks\\First.fxb'],
  });
  stream.push('{"type":"start","total":1,"sourcePaths":["C:/Banks/First.fxb"]}\n');
  stream.close();

  await assert.rejects(pending, (error: unknown) => {
    assert.equal(isFxbApiError(error), true);
    assert.match((error as FxbApiError).message, /sin evento end/);
    return true;
  });
});

test('batchStream falla si el flujo se corta sin evento end', async () => {
  const stream = controlledStream();
  const client = createFxbClient({ baseUrl: 'http://127.0.0.1:1', fetch: stream.fetch });

  const pending = client.library.batchStream({
    libraryRoot: 'C:\VFX\Library',
    action: 'add',
    plugins: ['Synth'],
  });
  stream.push('{"type":"start","action":"add","dryRun":false,"total":1,"plugins":["Synth"]}\n');
  stream.close();

  await assert.rejects(pending, (error: unknown) => {
    assert.equal(isFxbApiError(error), true);
    assert.match((error as FxbApiError).message, /sin evento end/);
    return true;
  });
});
