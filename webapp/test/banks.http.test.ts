import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { parseFxbBank } from '../src/library/fxb-bank';
import { buildBank } from './helpers/fxb-bank';
import { writePluginDll } from './helpers/vfx-plugin';

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

/** Banco real de MauSynth: 100 programas, uniqueID `Pang`, fxVersion 1. */
const MAUSYNTH_BANK = path.join(
  __dirname,
  '..',
  '..',
  'test',
  'fixtures',
  'fxb',
  'mausynth-az-bank.fxb',
);

interface Fixture {
  root: string;
  pluginDir: string;
  banksDir: string;
  presetsDir: string;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-banks-http-'));
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

async function bank(fixtureData: Fixture, name: string, options = {}): Promise<string> {
  const file = path.join(fixtureData.banksDir, name);
  await writeFile(file, buildBank(options));
  return file;
}

/** Guarda `defaultFxbName` con el control optimista que exige la API. */
async function setDefault(fixtureData: Fixture, defaultFxbName: string): Promise<void> {
  const configPath = path.join(fixtureData.pluginDir, 'fxbLoader.config');
  const current = await stat(configPath).catch(() => null);
  await http()
    .put('/fxb-config')
    .send({
      pluginDir: fixtureData.pluginDir,
      expectedMtimeMs: current === null ? null : current.mtimeMs,
      config: { defaultFxbName },
    })
    .expect(200);
}

test('POST /library/banks/import responde 200 y copia los bancos', async (t) => {
  const fixtureData = await fixture(t);
  const first = await bank(fixtureData, 'Rhodes.fxb', { uniqueId: 'MySy' });
  const second = await bank(fixtureData, 'Strings.fxb', { uniqueId: 'MySy' });

  const response = await http()
    .post('/library/banks/import')
    .send({
      libraryRoot: fixtureData.root,
      plugin: 'Synth',
      sourcePaths: [first, second],
      expectedUniqueId: 'MySy',
      expectedFxVersion: 1000,
    })
    .expect(200);

  assert.equal(response.body.reference.source, 'explicit');
  assert.deepEqual(
    response.body.results.map((item: { status: string; compatibility: string }) => [
      item.status,
      item.compatibility,
    ]),
    [
      ['imported', 'compatible'],
      ['imported', 'compatible'],
    ],
  );
  assert.deepEqual((await readdir(fixtureData.presetsDir)).sort(), [
    'Rhodes.fxb',
    'Strings.fxb',
  ]);
  assert.deepEqual(
    await readFile(path.join(fixtureData.presetsDir, 'Rhodes.fxb')),
    await readFile(first),
  );
});

test('POST /library/banks/import copia y valida el banco real de 100 programas en un solo POST', async (t) => {
  const fixtureData = await fixture(t);
  // Segundo archivo del lote, con el mismo uniqueID y versión que el real.
  const second = await bank(fixtureData, 'Strings.fxb', {
    uniqueId: 'Pang',
    fxVersion: 1,
    programs: 2,
  });

  const response = await http()
    .post('/library/banks/import')
    .send({
      libraryRoot: fixtureData.root,
      plugin: 'Synth',
      sourcePaths: [MAUSYNTH_BANK, second],
      expectedUniqueId: 'Pang',
      expectedFxVersion: 1,
    })
    .expect(200);

  const results = response.body.results as {
    fileName: string;
    status: string;
    compatibility: string;
    bank: { kind: string; numPrograms: number; uniqueId: string; fxVersion: number };
  }[];
  assert.deepEqual(
    results.map((item) => [item.status, item.compatibility]),
    [
      ['imported', 'compatible'],
      ['imported', 'compatible'],
    ],
  );

  // La respuesta ya describe el banco completo, no solo el archivo copiado.
  const mausynth = results[0]!;
  assert.equal(mausynth.fileName, 'mausynth-az-bank.fxb');
  assert.equal(mausynth.bank.kind, 'FxBk');
  assert.equal(mausynth.bank.numPrograms, 100);
  assert.equal(mausynth.bank.uniqueId, 'Pang');
  assert.equal(mausynth.bank.fxVersion, 1);
  assert.equal(results[1]!.bank.numPrograms, 2);

  assert.deepEqual((await readdir(fixtureData.presetsDir)).sort(), [
    'Strings.fxb',
    'mausynth-az-bank.fxb',
  ]);

  // Copia byte a byte y, además, los 100 programas se vuelven a parsear bien.
  const copied = path.join(fixtureData.presetsDir, 'mausynth-az-bank.fxb');
  const copy = await readFile(copied);
  assert.deepEqual(copy, await readFile(MAUSYNTH_BANK));

  const parsed = parseFxbBank(copy);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.bank?.numPrograms, 100);
  assert.equal(parsed.bank?.uniqueId, 'Pang');
  assert.equal(parsed.bank?.fxVersion, 1);
});

test('POST /library/banks/import responde 400 con peticiones mal formadas', async (t) => {
  const fixtureData = await fixture(t);
  const valid = await bank(fixtureData, 'A.fxb');

  const base = { libraryRoot: fixtureData.root, plugin: 'Synth' };
  await http().post('/library/banks/import').send(base).expect(400);
  await http()
    .post('/library/banks/import')
    .send({ ...base, sourcePaths: [] })
    .expect(400);
  await http()
    .post('/library/banks/import')
    .send({ ...base, sourcePaths: [42] })
    .expect(400);
  await http()
    .post('/library/banks/import')
    .send({ ...base, sourcePaths: ['relative/A.fxb'] })
    .expect(400);
  await http()
    .post('/library/banks/import')
    .send({ ...base, sourcePaths: [valid], expectedUniqueId: 'TooLong' })
    .expect(400);
  await http()
    .post('/library/banks/import')
    .send({ ...base, sourcePaths: [valid], expectedUniqueId: 'ABCD', expectedFxVersion: -1 })
    .expect(400);
});

test('POST /library/banks/import responde 404 con un plugin inexistente', async (t) => {
  const fixtureData = await fixture(t);
  const valid = await bank(fixtureData, 'A.fxb');

  await http()
    .post('/library/banks/import')
    .send({
      libraryRoot: fixtureData.root,
      plugin: 'Ghost',
      sourcePaths: [valid],
    })
    .expect(404);
});

test('POST /library/banks/import responde 422 si ningún banco es válido', async (t) => {
  const fixtureData = await fixture(t);
  const corrupt = path.join(fixtureData.banksDir, 'Broken.fxb');
  await writeFile(corrupt, Buffer.alloc(200, 0x41));
  const foreign = await bank(fixtureData, 'Foreign.fxb', { uniqueId: 'Othr' });

  const response = await http()
    .post('/library/banks/import')
    .send({
      libraryRoot: fixtureData.root,
      plugin: 'Synth',
      sourcePaths: [corrupt, foreign],
      expectedUniqueId: 'MySy',
    })
    .expect(422);

  assert.equal(response.body.results.length, 2);
  assert.deepEqual(
    response.body.results.map((item: { status: string; compatibility: string }) => [
      item.status,
      item.compatibility,
    ]),
    [
      ['rejected', 'unverified'],
      ['rejected', 'incompatible'],
    ],
  );
  await assert.rejects(readdir(fixtureData.presetsDir));
});

test('POST /library/banks/export convierte el banco y respeta overwrite', async (t) => {
  const fixtureData = await fixture(t);
  const source = await bank(fixtureData, 'Legacy.fxb', { endianness: 'big' });
  await http()
    .post('/library/banks/import')
    .send({ libraryRoot: fixtureData.root, plugin: 'Synth', sourcePaths: [source] })
    .expect(200);

  const request = {
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    fileName: 'Legacy.fxb',
    endianness: 'little',
  };

  const response = await http().post('/library/banks/export').send(request).expect(200);
  assert.equal(response.body.changed, true);
  assert.equal(response.body.source.bank.endianness, 'big');
  assert.equal(response.body.target.bank.endianness, 'little');
  assert.equal(response.body.target.fileName, 'Legacy-le.fxb');
  assert.deepEqual((await readdir(fixtureData.presetsDir)).sort(), [
    'Legacy-le.fxb',
    'Legacy.fxb',
  ]);

  const conflict = await http().post('/library/banks/export').send(request).expect(409);
  assert.match(String(conflict.body.message), /overwrite/);

  await http()
    .post('/library/banks/export')
    .send({ ...request, overwrite: true })
    .expect(200);
});

test('POST /library/banks/convert convierte el banco por defecto en el sitio', async (t) => {
  const fixtureData = await fixture(t);
  const source = await bank(fixtureData, 'Warm Rhodes.fxb', { endianness: 'little' });
  await http()
    .post('/library/banks/import')
    .send({ libraryRoot: fixtureData.root, plugin: 'Synth', sourcePaths: [source] })
    .expect(200);
  await http()
    .put('/fxb-config')
    .send({
      pluginDir: fixtureData.pluginDir,
      expectedMtimeMs: null,
      config: { defaultFxbName: 'Warm Rhodes.fxb', pluginName: 'Synth.dll' },
    })
    .expect(200);

  const request = { libraryRoot: fixtureData.root, plugin: 'Synth' };
  const response = await http().post('/library/banks/convert').send(request).expect(200);

  assert.equal(response.body.changed, true);
  assert.equal(response.body.fileName, 'Warm Rhodes.fxb');
  assert.equal(response.body.source.bank.endianness, 'little');
  assert.equal(response.body.target.bank.endianness, 'big');
  assert.equal(response.body.backup.fileName, 'Warm Rhodes.fxb.orig');
  assert.equal(response.body.backupCreated, true);

  // El banco se reescribe en su sitio y el respaldo guarda el original.
  const bankPath = path.join(fixtureData.presetsDir, 'Warm Rhodes.fxb');
  assert.equal(parseFxbBank(await readFile(bankPath)).bank?.endianness, 'big');
  const backupPath = path.join(fixtureData.presetsDir, 'Warm Rhodes.fxb.orig');
  assert.deepEqual(await readFile(backupPath), await readFile(source));
  assert.deepEqual((await readdir(fixtureData.presetsDir)).sort(), [
    'Warm Rhodes.fxb',
    'Warm Rhodes.fxb.orig',
  ]);

  // Repetirlo en el mismo orden no reescribe nada y tampoco duplica el respaldo.
  const again = await http()
    .post('/library/banks/convert')
    .send({ ...request, endianness: 'big' })
    .expect(200);
  assert.equal(again.body.changed, false);
  assert.equal(again.body.backup, null);
  assert.equal(again.body.backupCreated, false);
  assert.deepEqual((await readdir(fixtureData.presetsDir)).sort(), [
    'Warm Rhodes.fxb',
    'Warm Rhodes.fxb.orig',
  ]);
});

test('POST /library/banks/convert responde 400, 404, 409 y 422 con motivos claros', async (t) => {
  const fixtureData = await fixture(t);
  const source = await bank(fixtureData, 'Legacy.fxb', { endianness: 'little' });
  await http()
    .post('/library/banks/import')
    .send({ libraryRoot: fixtureData.root, plugin: 'Synth', sourcePaths: [source] })
    .expect(200);

  const base = { libraryRoot: fixtureData.root, plugin: 'Synth' };

  // 409: todavía no hay banco por defecto configurado.
  const noDefault = await http().post('/library/banks/convert').send(base).expect(409);
  assert.match(String(noDefault.body.message), /no tiene un banco por defecto/);

  // 400: orden de bytes desconocido.
  const badOrder = await http()
    .post('/library/banks/convert')
    .send({ ...base, endianness: 'middle' })
    .expect(400);
  assert.match(String(badOrder.body.message), /endianness/);

  // 404: el plugin no existe.
  await http()
    .post('/library/banks/convert')
    .send({ ...base, plugin: 'Nope' })
    .expect(404);

  // 409: el banco configurado no está en la carpeta.
  await http()
    .put('/fxb-config')
    .send({
      pluginDir: fixtureData.pluginDir,
      expectedMtimeMs: null,
      config: { defaultFxbName: 'Missing.fxb', pluginName: 'Synth.dll' },
    })
    .expect(200);
  const missing = await http().post('/library/banks/convert').send(base).expect(409);
  assert.match(String(missing.body.message), /no está en la carpeta del plugin/);

  // 422: el banco configurado no es un .fxb válido.
  await writeFile(path.join(fixtureData.presetsDir, 'Roto.fxb'), Buffer.alloc(200, 0x41));
  const mtimeMs = (await stat(path.join(fixtureData.pluginDir, 'fxbLoader.config'))).mtimeMs;
  await http()
    .put('/fxb-config')
    .send({
      pluginDir: fixtureData.pluginDir,
      expectedMtimeMs: mtimeMs,
      config: { defaultFxbName: 'Roto.fxb' },
    })
    .expect(200);
  const invalid = await http().post('/library/banks/convert').send(base).expect(422);
  assert.match(String(invalid.body.message), /no es un \.fxb válido/);
});

test('POST /library/banks/restore devuelve el banco al .orig sin consumirlo', async (t) => {
  const fixtureData = await fixture(t);
  const source = await bank(fixtureData, 'Warm Rhodes.fxb', { endianness: 'little' });
  const original = await readFile(source);
  await http()
    .post('/library/banks/import')
    .send({ libraryRoot: fixtureData.root, plugin: 'Synth', sourcePaths: [source] })
    .expect(200);
  await http()
    .put('/fxb-config')
    .send({
      pluginDir: fixtureData.pluginDir,
      expectedMtimeMs: null,
      config: { defaultFxbName: 'Warm Rhodes.fxb', pluginName: 'Synth.dll' },
    })
    .expect(200);

  const request = { libraryRoot: fixtureData.root, plugin: 'Synth' };
  await http().post('/library/banks/convert').send(request).expect(200);

  // La lista anuncia el respaldo para que la vista habilite el botón.
  const listed = await http().post('/library/banks/list').send(request).expect(200);
  assert.deepEqual(listed.body.defaultBackup, {
    fileName: 'Warm Rhodes.fxb.orig',
    size: original.length,
  });

  const response = await http().post('/library/banks/restore').send(request).expect(200);
  assert.equal(response.body.changed, true);
  assert.equal(response.body.fileName, 'Warm Rhodes.fxb');
  assert.equal(response.body.restored.fileName, 'Warm Rhodes.fxb');
  assert.equal(response.body.restored.bank.endianness, 'little');
  assert.equal(response.body.backup.fileName, 'Warm Rhodes.fxb.orig');
  assert.equal(response.body.backup.sha256, response.body.restored.sha256);

  const bankPath = path.join(fixtureData.presetsDir, 'Warm Rhodes.fxb');
  const backupPath = `${bankPath}.orig`;
  assert.deepEqual(await readFile(bankPath), original);
  // El respaldo sigue ahí, con los mismos bytes: se puede restaurar otra vez.
  assert.deepEqual(await readFile(backupPath), original);

  const again = await http().post('/library/banks/restore').send(request).expect(200);
  assert.equal(again.body.changed, false);
  assert.deepEqual(await readFile(backupPath), original);
  assert.deepEqual((await readdir(fixtureData.presetsDir)).sort(), [
    'Warm Rhodes.fxb',
    'Warm Rhodes.fxb.orig',
  ]);
});

test('POST /library/banks/restore responde 400, 404, 409 y 422 con motivos claros', async (t) => {
  const fixtureData = await fixture(t);
  const source = await bank(fixtureData, 'Legacy.fxb', { endianness: 'little' });
  const original = await readFile(source);
  await http()
    .post('/library/banks/import')
    .send({ libraryRoot: fixtureData.root, plugin: 'Synth', sourcePaths: [source] })
    .expect(200);

  const base = { libraryRoot: fixtureData.root, plugin: 'Synth' };

  // 409: sin banco por defecto no hay nada que restaurar.
  const noDefault = await http().post('/library/banks/restore').send(base).expect(409);
  assert.match(String(noDefault.body.message), /no tiene un banco por defecto/);

  // 404: el plugin no existe.
  await http()
    .post('/library/banks/restore')
    .send({ ...base, plugin: 'Nope' })
    .expect(404);

  // 400: petición sin `libraryRoot` y nombre de banco inseguro.
  await http().post('/library/banks/restore').send({ plugin: 'Synth' }).expect(400);
  await setDefault(fixtureData, '..\\Legacy.fxb');
  const traversal = await http().post('/library/banks/restore').send(base).expect(400);
  assert.match(String(traversal.body.message), /separadores de ruta/);

  // 409: el banco configurado nunca se convirtió, así que no hay `.orig`.
  await setDefault(fixtureData, 'Legacy.fxb');
  const noBackup = await http().post('/library/banks/restore').send(base).expect(409);
  assert.match(String(noBackup.body.message), /no hay respaldo Legacy\.fxb\.orig/);

  // 422: el respaldo existe pero no es un banco válido.
  await writeFile(path.join(fixtureData.presetsDir, 'Legacy.fxb.orig'), Buffer.alloc(200, 0x41));
  const invalid = await http().post('/library/banks/restore').send(base).expect(422);
  assert.match(String(invalid.body.message), /no es un \.fxb válido/);
  assert.deepEqual(
    await readFile(path.join(fixtureData.presetsDir, 'Legacy.fxb')),
    original,
    'un rechazo no toca el banco',
  );
});

test('POST /library/banks/export responde 400 y 422 con motivos claros', async (t) => {
  const fixtureData = await fixture(t);
  const source = await bank(fixtureData, 'Legacy.fxb', { endianness: 'big' });
  await http()
    .post('/library/banks/import')
    .send({ libraryRoot: fixtureData.root, plugin: 'Synth', sourcePaths: [source] })
    .expect(200);

  const base = {
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    fileName: 'Legacy.fxb',
    endianness: 'little',
  };

  const badOrder = await http()
    .post('/library/banks/export')
    .send({ ...base, endianness: 'middle' })
    .expect(400);
  assert.match(String(badOrder.body.message), /endianness/);

  const badName = await http()
    .post('/library/banks/export')
    .send({ ...base, fileName: '..\\Legacy.fxb' })
    .expect(400);
  assert.match(String(badName.body.message), /separadores/);

  await writeFile(path.join(fixtureData.presetsDir, 'Roto.fxb'), Buffer.alloc(200, 0x41));
  const invalid = await http()
    .post('/library/banks/export')
    .send({ ...base, fileName: 'Roto.fxb' })
    .expect(422);
  assert.match(String(invalid.body.message), /no es un .fxb válido/);

  await http()
    .post('/library/banks/export')
    .send({ ...base, plugin: 'NoExiste' })
    .expect(404);
});

test('POST /library/banks/import responde 200 si al menos uno se importa', async (t) => {
  const fixtureData = await fixture(t);
  const good = await bank(fixtureData, 'Good.fxb');
  const foreign = await bank(fixtureData, 'Foreign.fxb', { uniqueId: 'Othr' });

  const response = await http()
    .post('/library/banks/import')
    .send({
      libraryRoot: fixtureData.root,
      plugin: 'Synth',
      sourcePaths: [good, foreign],
    })
    .expect(200);

  assert.deepEqual(
    response.body.results.map((item: { status: string }) => item.status),
    ['imported', 'rejected'],
  );
});
