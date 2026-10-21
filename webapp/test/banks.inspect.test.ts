import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pe32Dll } from './helpers/pe';
import { writePluginDll } from './helpers/vfx-plugin';
import { FXB_CONFIG_FILENAME } from '../src/fxb-config/fxb-config.constants';
import type { BankInspectResult } from '../src/library/library.types';

const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'fxb');
const REEQ_FIXTURE = path.join(FIXTURES, 'wavosaur-reeq-3set.fxb');
const FOREIGN_FIXTURE = path.join(FIXTURES, 'rea-comp.FXB');
const MASSIVE_FIXTURE = path.join(FIXTURES, 'massive-test-bank.FXB');

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

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

interface Scaffold {
  root: string;
  dll: string;
  presets: string;
  banks: string;
}

/** Librería temporal con un plugin instalado y una carpeta para bancos ajenos. */
async function scaffold(t: TestContext): Promise<Scaffold> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-inspect-'));
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

  const dll = path.join(root, 'loader.dll');
  await writeFile(dll, pe32Dll());
  await http()
    .post('/library/install')
    .send({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dll })
    .expect(200);

  const banks = path.join(root, 'banks');
  await mkdir(banks);

  return { root, dll, presets: path.join(pluginDir, 'presets'), banks };
}

function inspect(sourcePath: string, extra: Record<string, unknown> = {}) {
  return http().post('/library/banks/inspect').send({ sourcePath, ...extra });
}

test('inspecciona un banco real y lo compara con los del plugin sin copiarlo', async (t) => {
  const data = await scaffold(t);
  const existing = path.join(data.presets, 'Warm Rhodes.fxb');
  await copyFile(REEQ_FIXTURE, existing);

  const source = path.join(data.banks, 'Rhodes.fxb');
  await copyFile(REEQ_FIXTURE, source);
  const before = (await readdir(data.presets)).sort();
  const sourceBefore = await readFile(source);

  const response = await inspect(source, { libraryRoot: data.root, plugin: 'Synth' }).expect(200);
  const body = response.body as BankInspectResult;

  assert.equal(body.valid, true);
  assert.equal(body.bank?.uniqueId, 'reeq');
  assert.equal(body.size, (await readFile(source)).length);
  assert.equal(body.sha256, await sha256(source));
  assert.deepEqual(body.issues, []);
  assert.deepEqual(body.warnings, []);

  assert.equal(body.reference.source, 'existing-bank');
  assert.equal(body.reference.uniqueId, 'reeq');
  assert.equal(body.compatibility, 'compatible');
  assert.equal(body.reason, null);

  assert.equal(body.target, path.join(data.presets, 'Rhodes.fxb'));
  assert.equal(body.presetsDir, data.presets);
  assert.equal(body.targetExists, false);

  assert.equal(body.existingBanks.length, 1);
  assert.equal(body.existingBanks[0]?.fileName, 'Warm Rhodes.fxb');
  assert.equal(body.existingBanks[0]?.sameUniqueId, true);
  assert.equal(body.existingBanks[0]?.sameFxVersion, true);

  assert.deepEqual((await readdir(data.presets)).sort(), before, 'no se copia nada');
  await assert.rejects(readFile(path.join(data.presets, 'Rhodes.fxb')));
  assert.deepEqual(await readFile(source), sourceBefore, 'el origen no se modifica');
});

test('sin plugin solo valida el archivo', async (t) => {
  const data = await scaffold(t);
  const source = path.join(data.banks, 'Rhodes.fxb');
  await copyFile(REEQ_FIXTURE, source);

  const body = (await inspect(source).expect(200)).body as BankInspectResult;

  assert.equal(body.valid, true);
  assert.equal(body.reference.source, 'none');
  assert.equal(body.compatibility, 'unverified');
  assert.equal(body.target, null);
  assert.equal(body.presetsDir, null);
  assert.equal(body.targetExists, false);
  assert.deepEqual(body.existingBanks, []);
});

test('un archivo que no es un banco VST2 devuelve 200 con valid:false', async (t) => {
  const data = await scaffold(t);
  const source = path.join(data.banks, 'Roto.fxb');
  await writeFile(source, Buffer.alloc(120, 0x41));

  const body = (await inspect(source).expect(200)).body as BankInspectResult;

  assert.equal(body.valid, false);
  assert.equal(body.bank, null);
  assert.match(body.issues[0] ?? '', /156/);
  assert.equal(body.compatibility, 'unverified');
});

test('marca incompatible un banco real de otro plugin y no copia nada', async (t) => {
  const data = await scaffold(t);
  await copyFile(REEQ_FIXTURE, path.join(data.presets, 'Warm Rhodes.fxb'));
  const source = path.join(data.banks, 'comp.fxb');
  await copyFile(FOREIGN_FIXTURE, source);
  const before = (await readdir(data.presets)).sort();

  const body = (await inspect(source, { libraryRoot: data.root, plugin: 'Synth' }).expect(200))
    .body as BankInspectResult;

  assert.equal(body.bank?.uniqueId, 'recm');
  assert.equal(body.compatibility, 'incompatible');
  assert.match(body.reason ?? '', /uniqueID recm .*distinto del esperado reeq/);
  assert.equal(body.existingBanks[0]?.sameUniqueId, false);
  assert.deepEqual((await readdir(data.presets)).sort(), before);
});

test('un banco opaco de Massive se compara igual y el destino existe si se repite el nombre', async (t) => {
  const data = await scaffold(t);
  await copyFile(REEQ_FIXTURE, path.join(data.presets, 'Warm Rhodes.fxb'));

  const source = path.join(data.banks, 'Massive.fxb');
  await copyFile(MASSIVE_FIXTURE, source);

  const body = (await inspect(source, { libraryRoot: data.root, plugin: 'Synth' }).expect(200))
    .body as BankInspectResult;
  assert.equal(body.bank?.kind, 'FBCh');
  assert.equal(body.bank?.numPrograms, 128);
  assert.equal(body.compatibility, 'incompatible');

  // Mismo nombre que un banco ya presente: se reporta, pero no se toca.
  const repeated = path.join(data.banks, 'Warm Rhodes.fxb');
  await copyFile(REEQ_FIXTURE, repeated);
  const repeatedResponse = await inspect(repeated, {
    libraryRoot: data.root,
    plugin: 'Synth',
  }).expect(200);
  const repeatedBody = repeatedResponse.body as BankInspectResult;
  assert.equal(repeatedBody.targetExists, true);
  assert.equal(repeatedBody.existingBanks[0]?.sameUniqueId, true);
});

test('no crea la carpeta de presets si no existe', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-inspect-empty-'));
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
  const banks = path.join(root, 'banks');
  await mkdir(banks);
  const source = path.join(banks, 'Rhodes.fxb');
  await copyFile(REEQ_FIXTURE, source);

  const body = (await inspect(source, { libraryRoot: root, plugin: 'Synth' }).expect(200))
    .body as BankInspectResult;

  assert.deepEqual(body.existingBanks, []);
  assert.equal(body.targetExists, false);
  await assert.rejects(readdir(path.join(pluginDir, 'presets')));
});

test('responde 400 y 404 con rutas, extensiones y plugins inválidos', async (t) => {
  const data = await scaffold(t);
  const source = path.join(data.banks, 'Rhodes.fxb');
  await copyFile(REEQ_FIXTURE, source);

  await inspect('Banks/Rhodes.fxb').expect(400);
  await inspect(path.join(data.banks, 'NoExiste.fxb')).expect(400);

  const txt = path.join(data.banks, 'notas.txt');
  await writeFile(txt, Buffer.from('no soy un banco'));
  const wrongExtension = await inspect(txt).expect(400);
  assert.match(wrongExtension.body.message, /\.fxb/);

  await inspect(source, { libraryRoot: data.root, plugin: 'Fantasma' }).expect(404);

  await inspect(source, { libraryRoot: data.root }).expect(400);
  await inspect(source, { plugin: 'Synth' }).expect(400);
});

test('responde 422 si programDirName apunta fuera del plugin', async (t) => {
  const data = await scaffold(t);
  await writeFile(
    path.join(data.root, 'plugs', 'Synth', FXB_CONFIG_FILENAME),
    Buffer.from('programDirName = ..\\fuera\r\n', 'latin1'),
  );
  const source = path.join(data.banks, 'Rhodes.fxb');
  await copyFile(REEQ_FIXTURE, source);

  const response = await inspect(source, { libraryRoot: data.root, plugin: 'Synth' }).expect(422);
  assert.match(response.body.message, /nombre de carpeta simple/);
});
