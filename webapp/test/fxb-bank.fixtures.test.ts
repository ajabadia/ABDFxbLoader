import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pe32Dll } from './helpers/pe';
import { FXB_CHUNK_HEADER_SIZE, FXB_HEADER_SIZE, parseFxbBank } from '../src/library/fxb-bank';
import type { FxbBankInfo } from '../src/library/fxb-bank';
import type { BankImportResponse } from '../src/library/library.types';

/**
 * Fixtures con bancos `.fxb` reales: Massive, el banco de fábrica de OB-Xd y
 * exports de ReaComp/ReaEQ de Nanohost y Wavosaur. El manifiesto fija hash,
 * tamaño y parseo esperado; si el parser cambia de criterio con datos reales,
 * estos tests fallan.
 */

const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'fxb');

interface FixtureSource {
  repo: string;
  commit: string;
  path: string;
  license: string;
  plugin: string;
}

interface Fixture {
  file: string;
  size: number;
  sha256: string;
  source: FixtureSource;
  expected: {
    bank: FxbBankInfo;
    issues: string[];
    warnings: string[];
  };
}

interface Manifest {
  description: string;
  fixtures: Fixture[];
}

let manifest: Manifest;
let app: INestApplication;

before(async () => {
  manifest = JSON.parse(await readFile(path.join(FIXTURES, 'manifest.json'), 'utf8')) as Manifest;
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

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

function fixturePath(fixture: Fixture): string {
  return path.join(FIXTURES, fixture.file);
}

test('los .fxb reales coinciden con el manifiesto', async () => {
  assert.ok(manifest.fixtures.length >= 4, 'se esperan varios fixtures');

  for (const fixture of manifest.fixtures) {
    const data = await readFile(fixturePath(fixture));

    assert.equal(data.length, fixture.size, `${fixture.file}: tamaño`);
    assert.equal(await sha256(fixturePath(fixture)), fixture.sha256, `${fixture.file}: sha256`);

    const parsed = parseFxbBank(data);
    assert.deepEqual(parsed.bank, fixture.expected.bank, `${fixture.file}: cabecera`);
    assert.deepEqual(parsed.issues, fixture.expected.issues, `${fixture.file}: issues`);
    assert.deepEqual(parsed.warnings, fixture.expected.warnings, `${fixture.file}: warnings`);
  }
});

test('el manifiesto cubre todos los .fxb del directorio', async () => {
  const files = (await readdir(FIXTURES))
    .filter((name) => /\.fxb$/i.test(name))
    .sort();
  const documented = manifest.fixtures.map((fixture) => fixture.file).sort();
  assert.deepEqual(documented, files, 'hay fixtures sin entrada en manifest.json o al revés');
});

test('la cabecera de 160 bytes basta para identificar cada banco', async () => {
  for (const fixture of manifest.fixtures) {
    const data = await readFile(fixturePath(fixture));
    const header = data.subarray(0, FXB_CHUNK_HEADER_SIZE);

    const parsed = parseFxbBank(header, data.length);
    assert.deepEqual(parsed.bank, fixture.expected.bank, `${fixture.file}: parseo de cabecera`);
    assert.deepEqual(parsed.issues, [], `${fixture.file}: la cabecera no debe dar issues`);
  }
});

test('un archivo real truncado por debajo de la cabecera se rechaza', async () => {
  const fixture = manifest.fixtures[0]!;
  const data = await readFile(fixturePath(fixture));

  const truncated = data.subarray(0, FXB_HEADER_SIZE - 1);
  const parsed = parseFxbBank(truncated, truncated.length);
  assert.equal(parsed.bank, null);
  assert.match(parsed.issues[0] ?? '', /necesita al menos 156/);
});

interface Library {
  root: string;
  dll: string;
  presets: string;
}

async function library(t: TestContext): Promise<Library> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-real-fixtures-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pluginDir = path.join(root, 'plugs', 'Synth');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, 'vfxinfo.txt'),
    Buffer.from('name: Synth\r\ndll_name: Synth/Synth.dll\r\n', 'latin1'),
  );

  const dll = path.join(root, 'loader.dll');
  await writeFile(dll, pe32Dll());

  return { root, dll, presets: path.join(pluginDir, 'presets') };
}

test('importa los bancos reales y los copia byte a byte', async (t) => {
  const data = await library(t);
  await http()
    .post('/library/install')
    .send({ libraryRoot: data.root, plugin: 'Synth', dllSourcePath: data.dll })
    .expect(200);

  const groups = new Map<string, Fixture[]>();
  for (const fixture of manifest.fixtures) {
    const uniqueId = fixture.expected.bank.uniqueId;
    groups.set(uniqueId, [...(groups.get(uniqueId) ?? []), fixture]);
  }
  assert.deepEqual([...groups.keys()].sort(), ['NiMa', 'Obxd', 'recm', 'reeq']);

  for (const [uniqueId, fixtures] of groups) {
    const response = await http()
      .post('/library/banks/import')
      .send({
        libraryRoot: data.root,
        plugin: 'Synth',
        sourcePaths: fixtures.map((fixture) => fixturePath(fixture)),
        expectedUniqueId: uniqueId,
      })
      .expect(200);

    const body = response.body as BankImportResponse;
    assert.equal(body.reference.source, 'explicit');

    for (const [index, fixture] of fixtures.entries()) {
      const result = body.results[index]!;
      assert.equal(result.status, 'imported', `${fixture.file}: estado`);
      assert.equal(result.compatibility, 'compatible', `${fixture.file}: compatibilidad`);
      assert.deepEqual(result.bank, fixture.expected.bank, `${fixture.file}: banco en la respuesta`);
      assert.equal(await sha256(result.target), fixture.sha256, `${fixture.file}: copia idéntica`);
    }
  }

  const copied = (await readdir(data.presets)).sort();
  assert.deepEqual(
    copied,
    manifest.fixtures.map((fixture) => fixture.file).sort(),
  );
});

test('rechaza un banco real de otro plugin y no lo copia', async (t) => {
  const data = await library(t);
  await http()
    .post('/library/install')
    .send({ libraryRoot: data.root, plugin: 'Synth', dllSourcePath: data.dll })
    .expect(200);

  const foreign = manifest.fixtures.find((fixture) => fixture.file === 'rea-comp.FXB')!;
  assert.equal(foreign.expected.bank.uniqueId, 'recm');

  const response = await http()
    .post('/library/banks/import')
    .send({
      libraryRoot: data.root,
      plugin: 'Synth',
      sourcePaths: [fixturePath(foreign)],
      expectedUniqueId: 'reeq',
    })
    .expect(422);

  const body = response.body as BankImportResponse & { message: string };
  assert.equal(body.message, 'Ningún banco se pudo importar');
  assert.equal(body.results[0]?.status, 'rejected');
  assert.equal(body.results[0]?.compatibility, 'incompatible');
  assert.match(body.results[0]?.reason ?? '', /uniqueID recm .*distinto del esperado reeq/);
  assert.deepEqual(await readdir(data.presets), [], 'no debe copiarse nada');
});

test('la versión real del banco solo se exige si el cliente la pide', async (t) => {
  const data = await library(t);
  await http()
    .post('/library/install')
    .send({ libraryRoot: data.root, plugin: 'Synth', dllSourcePath: data.dll })
    .expect(200);

  const wavosaur = manifest.fixtures.find((fixture) => fixture.file === 'wavosaur-reeq-3set.fxb')!;
  assert.equal(wavosaur.expected.bank.fxVersion, 0);

  const imported = await http()
    .post('/library/banks/import')
    .send({
      libraryRoot: data.root,
      plugin: 'Synth',
      sourcePaths: [fixturePath(wavosaur)],
      expectedUniqueId: 'reeq',
    })
    .expect(200);
  assert.equal((imported.body as BankImportResponse).results[0]?.compatibility, 'compatible');

  const strict = await http()
    .post('/library/banks/import')
    .send({
      libraryRoot: data.root,
      plugin: 'Synth',
      sourcePaths: [fixturePath(wavosaur)],
      expectedUniqueId: 'reeq',
      expectedFxVersion: 1100,
    })
    .expect(422);
  const body = strict.body as BankImportResponse;
  assert.equal(body.results[0]?.compatibility, 'incompatible');
  assert.match(body.results[0]?.reason ?? '', /versión del plugin 0 distinta de la esperada 1100/);
});
