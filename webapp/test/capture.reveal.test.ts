import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CaptureService } from '../src/capture/capture.service';
import type { CaptureDiff, CaptureSnapshot } from '../src/capture/capture.types';

/**
 * `POST /capture/pre-existing/:diffId/reveal` abre en el Explorador un previo
 * del paso 4. El caso de éxito lanzaría una ventana de verdad, así que aquí se
 * fijan las puertas de entrada: sin `path`, con un diff que ya no está, y con
 * una ruta que no es de los previos —o de un previo que se borró del disco— no
 * se abre nada y la respuesta dice por qué.
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

/** Ruta relativa a la unidad de origen, que es la que devuelve el listado. */
function unitRelative(absolute: string): string {
  const parsed = path.parse(absolute);
  return path.relative(parsed.root, absolute).split(path.sep).join('/');
}

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

test('reveal sin path es un 400 y con un diff desconocido un 404', async (t) => {
  const { http } = await makeApp(t);
  const diffId = randomUUID();

  const noPath = await http().post(`/capture/pre-existing/${diffId}/reveal`).expect(400);
  assert.equal(noPath.body.message, 'path requerido');

  const unknown = await http()
    .post(`/capture/pre-existing/${diffId}/reveal`)
    .query({ path: 'P8.dll' })
    .expect(404);
  assert.equal(unknown.body.message, `No existe el diff "${diffId}".`);
});

test('reveal no abre una ruta que no sea un previo del diff', async (t) => {
  const { http, service } = await makeApp(t);
  const seeded = service as unknown as SeededService;
  const diffId = randomUUID();
  const snapshotId = randomUUID();
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'fxb-reveal-'));
  t.after(async () => {
    seeded.diffs.delete(diffId);
    seeded.snapshots.delete(snapshotId);
    await rm(sourceRoot, { recursive: true, force: true });
  });

  const dll = path.join(sourceRoot, 'VstPlugins', 'P8.dll');
  const wavetable = path.join(sourceRoot, 'VstPlugins', 'P8', 'wavetables', 'table.wav');
  for (const [file, content] of [
    [dll, 'MZ-capturado'],
    [wavetable, 'RIFF-wavetable'],
  ] as const) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  seeded.snapshots.set(snapshotId, snapshotWith(snapshotId, [dll, wavetable]));
  seeded.diffs.set(diffId, diffWith(snapshotId, [dll]));

  // El listado del paso 4 sí conoce el previo: lo que se abre es esa ruta.
  const listed = await http().get(`/capture/pre-existing/${diffId}`).expect(200);
  assert.ok(listed.body.files.includes(unitRelative(wavetable)));

  const foreign = await http()
    .post(`/capture/pre-existing/${diffId}/reveal`)
    .query({ path: 'VstPlugins/P8.ini' })
    .expect(404);
  assert.match(foreign.body.message, /no es uno de los archivos previos/);
  assert.match(foreign.body.message, /ya no está en el disco/);
  assert.equal(foreign.body.ok, undefined, 'no se responde como si se hubiera abierto');

  // Una ruta que se sale del diff tampoco cuela por parecerse a una previa.
  const traversal = await http()
    .post(`/capture/pre-existing/${diffId}/reveal`)
    .query({ path: '../../../../Windows/System32/calc.exe' })
    .expect(404);
  assert.match(traversal.body.message, /no es uno de los archivos previos/);
});

test('reveal del staging: sin path es un 400 y sin staging un 404', async (t) => {
  const { http } = await makeApp(t);
  const diffId = randomUUID();

  const noPath = await http().post(`/capture/staging/${diffId}/reveal`).expect(400);
  assert.equal(noPath.body.message, 'path requerido');

  const unknown = await http()
    .post(`/capture/staging/${diffId}/reveal`)
    .query({ path: 'P8.ini' })
    .expect(404);
  assert.equal(
    unknown.body.message,
    `No existe el staging del diff "${diffId}". Ejecuta POST /capture/package para prepararlo.`,
  );
});

/**
 * El caso de éxito también lanzaría una ventana de Explorer, así que se fijan
 * las puertas: lo que se sale del staging, lo que ya no está y una carpeta no
 * se abren. El archivo válido se escribe para demostrar que existe y que, aun
 * así, las otras rutas se rechazan.
 */
test('reveal del staging no abre rutas que no sean un archivo suyo', async (t) => {
  const { http, service } = await makeApp(t);
  const diffId = randomUUID();
  const staging = path.join(service.stagingRoot, diffId);
  const file = path.join(staging, 'Program Files', 'VstPlugins', 'P8.ini');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'capturado');
  t.after(async () => {
    await rm(staging, { recursive: true, force: true });
  });

  const traversal = await http()
    .post(`/capture/staging/${diffId}/reveal`)
    .query({ path: '../../../../Windows/System32/calc.exe' })
    .expect(404);
  assert.match(traversal.body.message, /en el staging del diff/);

  const missing = await http()
    .post(`/capture/staging/${diffId}/reveal`)
    .query({ path: 'Program Files/VstPlugins/no-existe.dll' })
    .expect(404);
  assert.match(missing.body.message, /no-existe\.dll/);
  assert.equal(missing.body.ok, undefined, 'no se responde como si se hubiera abierto');

  const folder = await http()
    .post(`/capture/staging/${diffId}/reveal`)
    .query({ path: 'Program Files/VstPlugins' })
    .expect(404);
  assert.match(folder.body.message, /en el staging del diff/);
});
