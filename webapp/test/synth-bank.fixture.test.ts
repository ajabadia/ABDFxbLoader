import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pe32Dll } from './helpers/pe';
import type { BankImportResponse, BankListResult } from '../src/library/library.types';

/**
 * Banco de fábrica real de OB-Xd (128 programas), importado sobre una copia de
 * la librería de prueba `test/fixtures/vfx-library`. El fixture y su manifiesto
 * fijan hash, tamaño y cabecera; este test comprueba la importación completa.
 */

const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures');
const FIXTURE_LIBRARY = path.join(FIXTURES, 'vfx-library');
const BANK = path.join(FIXTURES, 'fxb', 'wam-obxd-factory.fxb');
const BANK_NAME = 'wam-obxd-factory.fxb';
const PLUGIN = 'OB-Xd';

let app: INestApplication;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

after(async () => {
  await app?.close();
});

function server() {
  return request(app.getHttpServer());
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

/** Copia `plugs` de la librería de prueba a un temporal; el fixture no se toca. */
async function copyFixtureLibrary(t: TestContext): Promise<{ root: string; loader: string }> {
  const temp = await mkdtemp(path.join(tmpdir(), 'fxb-synth-bank-'));
  t.after(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  const root = path.join(temp, 'library');
  await cp(path.join(FIXTURE_LIBRARY, 'plugs'), path.join(root, 'plugs'), { recursive: true });

  // Basta un stub: la importación de bancos no abre el DLL del plugin.
  const loader = path.join(temp, 'loader.dll');
  await writeFile(loader, pe32Dll());

  return { root, loader };
}

test('importa el banco de fábrica de OB-Xd en la librería de prueba', async (t) => {
  const { root, loader } = await copyFixtureLibrary(t);
  const originalVfxinfo = await readFile(path.join(FIXTURE_LIBRARY, 'plugs', PLUGIN, 'vfxinfo.txt'));

  await server()
    .post('/library/loader/add')
    .send({ libraryRoot: root, plugin: PLUGIN, dllSourcePath: loader })
    .expect(200);

  const imported = await server()
    .post('/library/banks/import')
    .send({
      libraryRoot: root,
      plugin: PLUGIN,
      sourcePaths: [BANK],
      expectedUniqueId: 'Obxd',
    })
    .expect(200);

  const body = imported.body as BankImportResponse;
  assert.equal(body.reference.source, 'explicit');
  assert.equal(body.reference.uniqueId, 'Obxd');
  assert.equal(body.reference.uniqueIdValue, 1331853412);
  assert.equal(body.results.length, 1);

  const result = body.results[0]!;
  assert.equal(result.fileName, BANK_NAME);
  assert.equal(result.status, 'imported');
  assert.equal(result.compatibility, 'compatible');
  assert.equal(result.bank?.kind, 'FBCh');
  assert.equal(result.bank?.endianness, 'big');
  assert.equal(result.bank?.version, 2);
  assert.equal(result.bank?.uniqueId, 'Obxd');
  assert.equal(result.bank?.fxVersion, 100);
  assert.equal(result.bank?.numPrograms, 128);
  assert.equal(result.bank?.currentProgram, 6);
  assert.equal(result.bank?.chunkSize, 86197);

  const target = path.join(root, 'plugs', PLUGIN, 'presets', BANK_NAME);
  assert.equal(result.target, target);
  assert.equal(existsSync(target), true, 'el banco debe estar en presets\\');
  assert.equal((await stat(target)).size, 86357);
  assert.equal(await sha256(target), await sha256(BANK), 'la copia debe ser byte a byte');

  const listed = await server()
    .post('/library/banks/list')
    .send({ libraryRoot: root, plugin: PLUGIN })
    .expect(200);

  const banks = listed.body as BankListResult;
  assert.equal(banks.plugin.hasLoader, true);
  assert.equal(banks.presetsDirExists, true);
  assert.deepEqual(
    banks.banks.map((entry) => entry.fileName),
    [BANK_NAME],
  );
  assert.deepEqual(banks.banks[0]?.bank, result.bank);
  assert.equal(banks.config.config.defaultFxbName, '');

  // El fixture sigue intacto: sin presets y con el vfxinfo original.
  assert.equal(existsSync(path.join(FIXTURE_LIBRARY, 'plugs', PLUGIN, 'presets')), false);
  assert.deepEqual(
    await readFile(path.join(FIXTURE_LIBRARY, 'plugs', PLUGIN, 'vfxinfo.txt')),
    originalVfxinfo,
  );
});
