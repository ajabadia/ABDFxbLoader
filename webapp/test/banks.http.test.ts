import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { buildBank } from './helpers/fxb-bank';

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

  const banksDir = path.join(root, 'banks');
  await mkdir(banksDir);
  return { root, pluginDir, banksDir, presetsDir: path.join(pluginDir, 'presets') };
}

async function bank(fixtureData: Fixture, name: string, options = {}): Promise<string> {
  const file = path.join(fixtureData.banksDir, name);
  await writeFile(file, buildBank(options));
  return file;
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
