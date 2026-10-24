import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PLUGIN_META_SNAPSHOT_EXAMPLE } from '../src/plugin-meta/plugin-meta.dto';

const META_FILENAME = 'fxbLoader.meta.json';

let app: INestApplication;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

after(async () => {
  await app?.close();
});

function http() {
  return request(app.getHttpServer());
}

/** Directorio de plugin vacío, como el que deja el escaneo antes de instalar. */
async function pluginDir(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-meta-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function metaPath(dir: string): string {
  return path.join(dir, META_FILENAME);
}

/** Claves de un objeto, ordenadas, para comparar la forma con el ejemplo. */
function keys(value: object): string[] {
  return Object.keys(value).sort();
}

test('GET /plugins/:id/meta exige el parámetro dir', async () => {
  const response = await http().get('/plugins/MySy/meta').expect(400);

  assert.deepEqual(response.body, { message: 'dir es obligatorio y debe ser una cadena' });
});

test('GET /plugins/:id/meta rechaza rutas relativas, inexistentes y archivos', async (t) => {
  const dir = await pluginDir(t);

  const relative = await http()
    .get('/plugins/MySy/meta')
    .query({ dir: 'plugs/MySynth' })
    .expect(400);
  assert.match(String(relative.body.message), /ruta absoluta/);

  const missing = await http()
    .get('/plugins/MySy/meta')
    .query({ dir: path.join(dir, 'NoExiste') })
    .expect(400);
  assert.match(String(missing.body.message), /no existe el directorio|el directorio no existe/);

  const file = path.join(dir, 'plugin.txt');
  await writeFile(file, 'x');
  const notADir = await http().get('/plugins/MySy/meta').query({ dir: file }).expect(400);
  assert.match(String(notADir.body.message), /no es un directorio/);

  // Ninguna de las tres respuestas escribe nada.
  assert.equal(existsSync(path.join(dir, META_FILENAME)), false);
});

test('GET /plugins/:id/meta devuelve exists:false sin crear el archivo', async (t) => {
  const dir = await pluginDir(t);

  const response = await http()
    .get('/plugins/MySy/meta')
    .query({ dir: `${dir}${path.sep}` })
    .expect(200);

  assert.deepEqual(keys(response.body), keys(PLUGIN_META_SNAPSHOT_EXAMPLE));
  assert.deepEqual(keys(response.body.common), keys(PLUGIN_META_SNAPSHOT_EXAMPLE.common));
  assert.equal(response.body.exists, false);
  assert.equal(response.body.mtimeMs, null);
  assert.equal(response.body.size, 0);
  assert.equal(response.body.metaPath, metaPath(dir));
  assert.deepEqual(response.body.extended, {});
  assert.equal(response.body.source, null);
  assert.equal(response.body.updated, null);
  assert.equal(existsSync(metaPath(dir)), false);
});

test('GET /plugins/:id/meta responde 400 si el archivo no cumple el formato', async (t) => {
  const dir = await pluginDir(t);
  await writeFile(metaPath(dir), 'no es json', 'utf8');

  const response = await http().get('/plugins/MySy/meta').query({ dir }).expect(400);

  assert.equal(response.body.message, 'Metadatos no válidos');
  assert.deepEqual(response.body.issues, ['el archivo propio no es JSON válido']);
});

test('POST /plugins/:id/meta crea el archivo y conserva lo que no se envía', async (t) => {
  const dir = await pluginDir(t);

  const created = await http()
    .post('/plugins/MySy/meta')
    .send({
      pluginDir: dir,
      expectedMtimeMs: null,
      common: { id: 'MySy', name: 'MySynth' },
      extended: { category: 'electric-piano' },
    })
    .expect(200);

  assert.deepEqual(keys(created.body), keys(PLUGIN_META_SNAPSHOT_EXAMPLE));
  assert.equal(created.body.exists, true);
  assert.equal(typeof created.body.mtimeMs, 'number');
  assert.equal(created.body.common.id, 'MySy');
  assert.equal(created.body.common.name, 'MySynth');
  assert.equal(created.body.common.vendor, '');
  assert.deepEqual(created.body.extended, { category: 'electric-piano' });
  assert.match(String(created.body.updated), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  const stored = JSON.parse(await readFile(metaPath(dir), 'utf8')) as {
    common: Record<string, string>;
    extended: Record<string, unknown>;
  };
  assert.equal(stored.common.name, 'MySynth');
  assert.deepEqual(stored.extended, { category: 'electric-piano' });

  // La siguiente escritura parte del `mtimeMs` devuelto y conserva el resto.
  const updated = await http()
    .post('/plugins/MySy/meta')
    .send({
      pluginDir: dir,
      expectedMtimeMs: created.body.mtimeMs,
      common: { name: 'MySynth 2' },
      extended: { tags: { family: 'keys' } },
    })
    .expect(200);

  assert.equal(updated.body.common.name, 'MySynth 2');
  assert.equal(updated.body.common.id, 'MySy');
  assert.deepEqual(updated.body.extended, {
    category: 'electric-piano',
    tags: { family: 'keys' },
  });

  // Un `null` explícito borra la clave extendida.
  const cleared = await http()
    .post('/plugins/MySy/meta')
    .send({
      pluginDir: dir,
      expectedMtimeMs: updated.body.mtimeMs,
      extended: { category: null },
    })
    .expect(200);

  assert.equal(cleared.body.extended.category, null);
  assert.deepEqual(cleared.body.extended.tags, { family: 'keys' });
});

test('POST /plugins/:id/meta responde 409 si el mtime ya no es el vigente', async (t) => {
  const dir = await pluginDir(t);

  await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: dir, expectedMtimeMs: null, common: { id: 'MySy', name: 'MySynth' } })
    .expect(200);

  // Otra escritura (la app, otra pestaña) adelanta el archivo un segundo.
  await writeFile(
    metaPath(dir),
    JSON.stringify({ common: { id: 'MySy', name: 'Desde disco' }, extended: {} }),
    'utf8',
  );
  const later = new Date(Date.now() + 2000);
  await utimes(metaPath(dir), later, later);

  const conflict = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: dir, expectedMtimeMs: 1, common: { name: 'MySynth' } })
    .expect(409);

  assert.equal(conflict.body.message, 'El archivo propio cambió en disco desde la última lectura');
  assert.deepEqual(keys(conflict.body.current), keys(PLUGIN_META_SNAPSHOT_EXAMPLE));
  assert.equal(conflict.body.current.exists, true);
  assert.equal(conflict.body.current.common.name, 'Desde disco');
  assert.equal(typeof conflict.body.current.mtimeMs, 'number');

  // Nada se escribió: el archivo sigue con el nombre que puso el otro proceso.
  const stored = JSON.parse(await readFile(metaPath(dir), 'utf8')) as {
    common: Record<string, string>;
  };
  assert.equal(stored.common.name, 'Desde disco');

  // Si el archivo no existe y el cliente esperaba uno, también es conflicto.
  const empty = await pluginDir(t);
  const stale = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: empty, expectedMtimeMs: 1, common: { name: 'MySynth' } })
    .expect(409);

  assert.equal(stale.body.current.exists, false);
  assert.equal(stale.body.current.mtimeMs, null);
  assert.equal(existsSync(metaPath(empty)), false);
});

test('POST /plugins/:id/meta rechaza rutas inválidas con 400', async (t) => {
  const dir = await pluginDir(t);

  const relative = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: 'plugs/MySynth', expectedMtimeMs: null })
    .expect(400);
  assert.match(String(relative.body.message), /ruta absoluta/);

  const missing = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: path.join(dir, 'NoExiste'), expectedMtimeMs: null })
    .expect(400);
  assert.match(String(missing.body.message), /el directorio no existe/);

  assert.equal(existsSync(metaPath(dir)), false);
});

test('POST /plugins/:id/meta rechaza metadatos no válidos con 400', async (t) => {
  const dir = await pluginDir(t);

  const emptyId = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: dir, expectedMtimeMs: null, common: { id: '' } })
    .expect(400);
  assert.deepEqual(emptyId.body, {
    message: 'Metadatos no válidos',
    issues: ['common.id: no puede estar vacío'],
  });

  const control = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: dir, expectedMtimeMs: null, common: { name: 'My\u0007Synth' } })
    .expect(400);
  assert.match(String(control.body.issues[0]), /caracteres de control/);

  const long = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: dir, expectedMtimeMs: null, common: { name: 'a'.repeat(256) } })
    .expect(400);
  assert.match(String(long.body.issues[0]), /256 caracteres; el máximo es 255/);

  const array = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: dir, expectedMtimeMs: null, extended: { tags: ['a'] } })
    .expect(400);
  assert.deepEqual(array.body, {
    message: 'Metadatos no válidos',
    issues: ['extended.tags: los arrays no se permiten'],
  });

  const badKey = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: dir, expectedMtimeMs: null, extended: { 'sin espacios': 1 } })
    .expect(400);
  assert.match(String(badKey.body.issues[0]), /no válida/);

  // Nada de lo rechazado llegó al disco.
  assert.equal(existsSync(metaPath(dir)), false);
});

test('POST /plugins/:id/meta valida la forma del cuerpo antes de tocar el disco', async (t) => {
  const dir = await pluginDir(t);

  const notAnObject = await http().post('/plugins/MySy/meta').send([1, 2]).expect(400);
  assert.equal(notAnObject.body.message, 'El cuerpo debe ser un objeto JSON');

  const noDir = await http()
    .post('/plugins/MySy/meta')
    .send({ expectedMtimeMs: null })
    .expect(400);
  assert.equal(noDir.body.message, 'pluginDir es obligatorio y debe ser una cadena');

  const noMtime = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: dir })
    .expect(400);
  assert.match(String(noMtime.body.message), /expectedMtimeMs es obligatorio/);

  const badMtime = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: dir, expectedMtimeMs: 'ayer' })
    .expect(400);
  assert.equal(badMtime.body.message, 'expectedMtimeMs debe ser un número o null');

  const badCommon = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: dir, expectedMtimeMs: null, common: [] })
    .expect(400);
  assert.equal(badCommon.body.message, 'common debe ser un objeto');

  const unknownCommon = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: dir, expectedMtimeMs: null, common: { colour: 'rojo' } })
    .expect(400);
  assert.match(String(unknownCommon.body.message), /clave desconocida en common: "colour"/);

  const nonString = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: dir, expectedMtimeMs: null, common: { name: 7 } })
    .expect(400);
  assert.equal(nonString.body.message, 'common.name debe ser una cadena');

  const badExtended = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: dir, expectedMtimeMs: null, extended: 'nada' })
    .expect(400);
  assert.equal(badExtended.body.message, 'extended debe ser un objeto');

  assert.equal(existsSync(metaPath(dir)), false);
});

test('GET y POST devuelven el mismo snapshot tras escribir', async (t) => {
  const dir = await pluginDir(t);

  const written = await http()
    .post('/plugins/MySy/meta')
    .send({ pluginDir: dir, expectedMtimeMs: null, common: { id: 'MySy', name: 'MySynth' } })
    .expect(200);

  const read = await http().get('/plugins/MySy/meta').query({ dir }).expect(200);

  assert.deepEqual(read.body, written.body);
  const stats = await stat(metaPath(dir));
  assert.equal(written.body.mtimeMs, stats.mtimeMs);
});
