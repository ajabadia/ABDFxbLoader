import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CaptureService } from '../src/capture/capture.service';
import type { CaptureDiff, CaptureSnapshot } from '../src/capture/capture.types';

/**
 * Sin staging, `GET`, `DELETE` y `DELETE …/clean` lanzaban un `Error` genérico
 * (500). Estas pruebas fijan el contrato: el staging que no existe es un 404 con
 * el motivo, y borrar un archivo que ya no está tampoco es un 200.
 *
 * El caso de éxito se monta creando la carpeta que usa el servicio: el staging
 * cuelga de `~/.fxbloader/capture/staging` y `packageDiff` no es la única vía
 * para tener archivos ahí.
 */

async function makeApp(t: TestContext) {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  t.after(async () => {
    await app.close();
  });
  return { http: () => request(app.getHttpServer()), service: app.get(CaptureService) };
}

interface SeededService {
  diffs: Map<string, CaptureDiff>;
  snapshots: Map<string, CaptureSnapshot>;
}

/** Ruta relativa a la unidad de origen, que es la que guarda el manifiesto. */
function unitRelative(absolute: string): string {
  const parsed = path.parse(absolute);
  return path.relative(parsed.root, absolute).split(path.sep).join('/');
}

/** Snapshot inicial con los archivos que existían antes de la captura. */
function snapshotWith(id: string, files: string[]): CaptureSnapshot {
  return {
    id,
    createdAt: new Date().toISOString(),
    platform: 'win32',
    files: files.map((file) => ({ path: file, size: 0, mtimeMs: 0, isDir: false })),
    registry: [],
    scanRoots: [],
    registryRoots: [],
  };
}

/** Diff mínimo: `collectPreExisting` solo mira las rutas capturadas y el snapshot. */
function diffWith(snapshotIdBefore: string, capturedFiles: string[]): CaptureDiff {
  return {
    snapshotIdBefore,
    snapshotIdAfter: randomUUID(),
    createdAt: new Date().toISOString(),
    addedFiles: capturedFiles.map((file) => ({ path: file, size: 0, mtimeMs: 0, isDir: false })),
    modifiedFiles: [],
    removedFiles: [],
    addedRegistry: [],
    modifiedRegistry: [],
    removedRegistry: [],
    filteredOut: 0,
  };
}

test('el staging inexistente devuelve 404 con el diff y cómo prepararlo', async (t) => {
  const { http } = await makeApp(t);
  const diffId = randomUUID();

  const list = await http().get(`/capture/staging/${diffId}`).expect(404);
  assert.equal(
    list.body.message,
    `No existe el staging del diff "${diffId}". Ejecuta POST /capture/package para prepararlo.`,
  );

  const remove = await http()
    .delete(`/capture/staging/${diffId}`)
    .query({ path: 'P8.dll' })
    .expect(404);
  assert.equal(remove.body.message, list.body.message);

  const clean = await http().delete(`/capture/staging/${diffId}/clean`).expect(404);
  assert.equal(clean.body.message, list.body.message);

  // El cuerpo es el mismo DTO sin sobre de Nest que el resto de la API.
  assert.equal(Object.hasOwn(list.body, 'statusCode'), false);
  assert.equal(Object.hasOwn(list.body, 'error'), false);
});

test('DELETE /capture/staging sin path es un 400, no un 500', async (t) => {
  const { http } = await makeApp(t);

  const response = await http().delete(`/capture/staging/${randomUUID()}`).expect(400);
  assert.deepEqual(response.body, { message: 'path requerido' });
});

test('una ruta que se sale del staging es un 400', async (t) => {
  const { http } = await makeApp(t);

  const response = await http()
    .delete(`/capture/staging/${randomUUID()}`)
    .query({ path: path.join('..', 'otro-diff', 'P8.dll') })
    .expect(400);
  assert.match(response.body.message, /se sale del staging/);
});

test('con staging en disco lista, borra y limpia; repetir el borrado da 404', async (t) => {
  const { http, service } = await makeApp(t);
  const diffId = randomUUID();
  const stagingPath = path.join(service.stagingRoot, diffId);
  const relative = path.join('Program Files', 'VstPlugins', 'P8.dll');
  t.after(async () => {
    await rm(stagingPath, { recursive: true, force: true });
  });

  await mkdir(path.dirname(path.join(stagingPath, relative)), { recursive: true });
  await writeFile(path.join(stagingPath, relative), Buffer.from('MZ'));
  await writeFile(path.join(stagingPath, 'manifest.json'), '{}');

  const list = await http().get(`/capture/staging/${diffId}`).expect(200);
  assert.equal(list.body.stagingDir, stagingPath);
  assert.deepEqual(list.body.files.sort(), [relative, 'manifest.json'].sort());

  await http().delete(`/capture/staging/${diffId}`).query({ path: relative }).expect(200);
  assert.deepEqual(
    (await http().get(`/capture/staging/${diffId}`).expect(200)).body.files,
    ['manifest.json'],
  );

  // El archivo ya no está: `fs.rm` con `force` lo habría dado por borrado.
  const missing = await http()
    .delete(`/capture/staging/${diffId}`)
    .query({ path: relative })
    .expect(404);
  assert.equal(
    missing.body.message,
    `No existe "${relative}" en el staging del diff "${diffId}".`,
  );

  await http().delete(`/capture/staging/${diffId}/clean`).expect(200);
  await http().get(`/capture/staging/${diffId}`).expect(404);
  await http().delete(`/capture/staging/${diffId}/clean`).expect(404);
});

test('restore devuelve los previos quitados sin preparar el staging otra vez', async (t) => {
  const { http, service } = await makeApp(t);
  const seeded = service as unknown as SeededService;
  const diffId = randomUUID();
  const snapshotId = randomUUID();
  const stagingPath = path.join(service.stagingRoot, diffId);
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'fxb-restore-'));
  t.after(async () => {
    seeded.diffs.delete(diffId);
    seeded.snapshots.delete(snapshotId);
    await rm(stagingPath, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  });

  // El origen conserva el DLL capturado y un previo; el tercer previo que
  // declara el manifiesto ya no está en disco.
  const dll = path.join(sourceRoot, 'VstPlugins', 'P8.dll');
  const wavetable = path.join(sourceRoot, 'VstPlugins', 'P8', 'wavetables', 'table.wav');
  const ghost = path.join(sourceRoot, 'VstPlugins', 'P8', 'presets', 'ghost.fxb');
  for (const [file, content] of [
    [dll, 'MZ-capturado'],
    [wavetable, 'RIFF-wavetable'],
  ] as const) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  const declared = [unitRelative(wavetable), unitRelative(ghost)];
  seeded.snapshots.set(snapshotId, snapshotWith(snapshotId, [dll, wavetable, ghost]));
  seeded.diffs.set(diffId, diffWith(snapshotId, [dll]));

  // Staging como lo deja `POST /capture/package` después de «Quitar previos»:
  // queda el archivo de la captura, el manifiesto y ningún previo.
  const dllTarget = path.join(stagingPath, ...unitRelative(dll).split('/'));
  await mkdir(path.dirname(dllTarget), { recursive: true });
  await writeFile(dllTarget, 'MZ-capturado');
  await writeFile(
    path.join(stagingPath, 'manifest.json'),
    JSON.stringify({ diffId, preExistingFiles: declared }),
  );

  const before = await http().get(`/capture/pre-existing/${diffId}`).expect(200);
  assert.equal(before.body.count, 0, 'el staging no tiene ningún previo');
  assert.equal(before.body.restorable, 1, 'solo el previo que sigue en el origen se puede devolver');
  assert.deepEqual(
    before.body.restorableFiles,
    [unitRelative(wavetable)],
    'la vista necesita la ruta para ofrecer devolver ese archivo solo',
  );

  const restored = await http().post(`/capture/staging/${diffId}/restore`).expect(200);
  assert.equal(restored.body.restored, 1);
  assert.deepEqual(restored.body.files, [unitRelative(wavetable)]);
  assert.deepEqual(restored.body.missing, [unitRelative(ghost)], 'el que falta en el origen se reporta');
  assert.deepEqual(restored.body.warnings, []);
  assert.equal(
    await readFile(path.join(stagingPath, ...unitRelative(wavetable).split('/')), 'utf8'),
    'RIFF-wavetable',
    'el contenido vuelve tal cual del snapshot inicial',
  );
  assert.equal(await readFile(dllTarget, 'utf8'), 'MZ-capturado', 'lo capturado no se pisa');

  const after = await http().get(`/capture/pre-existing/${diffId}`).expect(200);
  assert.equal(after.body.count, 1, 'el previo recuperado vuelve a contar para el paquete');
  assert.equal(after.body.restorable, 0, 'ya no queda nada que devolver');

  // Repetirlo no duplica ni pisa: el que ya está se deja como está.
  const again = await http().post(`/capture/staging/${diffId}/restore`).expect(200);
  assert.equal(again.body.restored, 0);
  assert.deepEqual(again.body.files, []);
  assert.deepEqual(again.body.missing, [unitRelative(ghost)]);
});

test('restore con path devuelve un solo previo y deja los demás donde estaban', async (t) => {
  const { http, service } = await makeApp(t);
  const seeded = service as unknown as SeededService;
  const diffId = randomUUID();
  const snapshotId = randomUUID();
  const stagingPath = path.join(service.stagingRoot, diffId);
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'fxb-restore-one-'));
  t.after(async () => {
    seeded.diffs.delete(diffId);
    seeded.snapshots.delete(snapshotId);
    await rm(stagingPath, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  });

  const dll = path.join(sourceRoot, 'VstPlugins', 'P8.dll');
  const wavetable = path.join(sourceRoot, 'VstPlugins', 'P8', 'wavetables', 'table.wav');
  const legacy = path.join(sourceRoot, 'VstPlugins', 'P8', 'presets', 'legacy.fxb');
  for (const [file, content] of [
    [dll, 'MZ-capturado'],
    [wavetable, 'RIFF-wavetable'],
    [legacy, 'Fxb-legacy'],
  ] as const) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  seeded.snapshots.set(snapshotId, snapshotWith(snapshotId, [dll, wavetable, legacy]));
  seeded.diffs.set(diffId, diffWith(snapshotId, [dll]));

  const dllTarget = path.join(stagingPath, ...unitRelative(dll).split('/'));
  await mkdir(path.dirname(dllTarget), { recursive: true });
  await writeFile(dllTarget, 'MZ-capturado');
  // Los dos previos se quitaron del staging con la ×, pero siguen en el origen.
  await writeFile(
    path.join(stagingPath, 'manifest.json'),
    JSON.stringify({ diffId, preExistingFiles: [unitRelative(wavetable), unitRelative(legacy)] }),
  );

  const before = await http().get(`/capture/pre-existing/${diffId}`).expect(200);
  assert.deepEqual(before.body.restorableFiles, [unitRelative(wavetable), unitRelative(legacy)]);
  assert.equal(before.body.restorable, 2);

  const one = await http()
    .post(`/capture/staging/${diffId}/restore`)
    .query({ path: unitRelative(wavetable) })
    .expect(200);
  assert.equal(one.body.restored, 1, 'solo vuelve el archivo pedido');
  assert.deepEqual(one.body.files, [unitRelative(wavetable)]);
  assert.deepEqual(one.body.missing, []);
  assert.equal(
    await readFile(path.join(stagingPath, ...unitRelative(wavetable).split('/')), 'utf8'),
    'RIFF-wavetable',
  );
  assert.equal(
    existsSync(path.join(stagingPath, ...unitRelative(legacy).split('/'))),
    false,
    'el otro previo sigue fuera del staging',
  );

  const after = await http().get(`/capture/pre-existing/${diffId}`).expect(200);
  assert.equal(after.body.count, 1, 'el devuelto vuelve a contar para el paquete');
  assert.equal(after.body.restorable, 1, 'queda el otro por devolver');
  assert.deepEqual(after.body.restorableFiles, [unitRelative(legacy)]);

  // Repetir el mismo path no pisa lo que ya está: 200 con `restored: 0`.
  const again = await http()
    .post(`/capture/staging/${diffId}/restore`)
    .query({ path: unitRelative(wavetable) })
    .expect(200);
  assert.equal(again.body.restored, 0);
  assert.deepEqual(again.body.files, []);

  // Una ruta que el manifiesto no marcó como previa es un 404, no un éxito vacío.
  const foreign = await http()
    .post(`/capture/staging/${diffId}/restore`)
    .query({ path: 'Otro/plugin/P8.dll' })
    .expect(404);
  assert.equal(
    foreign.body.message,
    `"Otro/plugin/P8.dll" no es uno de los archivos previos del staging del diff "${diffId}".`,
  );

  // Sin `path` se recuperan todos los que quedan.
  const rest = await http().post(`/capture/staging/${diffId}/restore`).expect(200);
  assert.equal(rest.body.restored, 1);
  assert.deepEqual(rest.body.files, [unitRelative(legacy)]);
  assert.equal((await http().get(`/capture/pre-existing/${diffId}`).expect(200)).body.count, 2);
});

test('restore sin staging o sin diff es un 404 con su motivo', async (t) => {
  const { http, service } = await makeApp(t);

  const sinStaging = randomUUID();
  const noStaging = await http().post(`/capture/staging/${sinStaging}/restore`).expect(404);
  assert.equal(
    noStaging.body.message,
    `No existe el staging del diff "${sinStaging}". Ejecuta POST /capture/package para prepararlo.`,
  );

  const diffId = randomUUID();
  const stagingPath = path.join(service.stagingRoot, diffId);
  t.after(async () => {
    await rm(stagingPath, { recursive: true, force: true });
  });
  await mkdir(stagingPath, { recursive: true });
  await writeFile(path.join(stagingPath, 'manifest.json'), '{"preExistingFiles":["P8.dll"]}');

  const noDiff = await http().post(`/capture/staging/${diffId}/restore`).expect(404);
  assert.equal(
    noDiff.body.message,
    `No existe el diff "${diffId}": sin snapshot inicial no hay de dónde recuperar los archivos previos.`,
  );
});
