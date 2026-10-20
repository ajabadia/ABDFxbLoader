import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pe32Dll } from './helpers/pe';
import { FXB_CONFIG_FILENAME } from '../src/fxb-config/fxb-config.constants';
import type { BankListResult } from '../src/library/library.types';
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

interface Scaffold {
  root: string;
  pluginDir: string;
  presets: string;
  dll: string;
}

/** Plugin instalado (con `fxbLoader.config`) y carpeta de presets vacía. */
async function scaffold(t: TestContext, plugin = 'Synth'): Promise<Scaffold> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-list-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pluginDir = path.join(root, 'plugs', plugin);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, 'vfxinfo.txt'),
    Buffer.from(`name: ${plugin}\r\ndll_name: ${plugin}/${plugin}.dll\r\n`, 'latin1'),
  );
  const dll = path.join(root, 'loader.dll');
  await writeFile(dll, pe32Dll());

  await http()
    .post('/library/install')
    .send({ libraryRoot: root, plugin, dllSourcePath: dll })
    .expect(200);

  return { root, pluginDir, presets: path.join(pluginDir, 'presets'), dll };
}

function list(root: string, plugin = 'Synth') {
  return http().post('/library/banks/list').send({ libraryRoot: root, plugin });
}

test('lista los bancos válidos del plugin con su configuración', async (t) => {
  const data = await scaffold(t);
  await writeFile(path.join(data.presets, 'Zip.fxb'), buildBank({ uniqueId: 'MySy', programs: 1 }));
  await writeFile(
    path.join(data.presets, 'Alpha.fxb'),
    buildBank({ uniqueId: 'MySy', programs: 2 }),
  );
  // No es un banco: se omite sin romper la vista.
  await writeFile(path.join(data.presets, 'Roto.fxb'), Buffer.alloc(200, 0x41));
  await writeFile(path.join(data.presets, 'notas.txt'), Buffer.from('hola'));

  await http()
    .put('/fxb-config')
    .send({
      pluginDir: data.pluginDir,
      expectedMtimeMs: (await stat(path.join(data.pluginDir, FXB_CONFIG_FILENAME))).mtimeMs,
      config: { defaultFxbName: 'Alpha.fxb', loadFxbBank: false },
    })
    .expect(200);

  const before = (await readdir(data.presets)).sort();
  const body = (await list(data.root).expect(200)).body as BankListResult;

  assert.equal(body.plugin.name, 'Synth');
  assert.equal(body.plugin.installed, true);
  assert.equal(body.presetsDir, data.presets);
  assert.equal(body.presetsDirExists, true);
  assert.deepEqual(
    body.banks.map((entry) => entry.fileName),
    ['Alpha.fxb', 'Zip.fxb'],
  );
  assert.equal(body.banks[0]?.bank.numPrograms, 2);
  assert.equal(body.banks[0]?.size, 156 + 2 * 60);
  assert.equal(body.config.exists, true);
  assert.equal(body.config.config.defaultFxbName, 'Alpha.fxb');
  assert.equal(body.config.config.loadFxbBank, false);
  assert.equal(typeof body.config.mtimeMs, 'number');
  assert.deepEqual((await readdir(data.presets)).sort(), before, 'listar no toca la carpeta');
});

test('no crea la carpeta ni la configuración si no existen', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-list-empty-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pluginDir = path.join(root, 'plugs', 'Synth');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, 'vfxinfo.txt'),
    Buffer.from('name: Synth\r\ndll_name: Synth/Synth.dll\r\n', 'latin1'),
  );

  const body = (await list(root).expect(200)).body as BankListResult;

  assert.equal(body.plugin.installed, false);
  assert.deepEqual(body.banks, []);
  assert.equal(body.presetsDir, path.join(pluginDir, 'presets'));
  assert.equal(body.presetsDirExists, false);
  assert.equal(body.config.exists, false);
  assert.equal(body.config.mtimeMs, null);
  assert.equal(body.config.config.defaultFxbName, '');
  await assert.rejects(readdir(body.presetsDir));
  await assert.rejects(readFile(path.join(pluginDir, FXB_CONFIG_FILENAME)));
});

test('respeta programDirName de la configuración', async (t) => {
  const data = await scaffold(t);
  await writeFile(
    path.join(data.pluginDir, FXB_CONFIG_FILENAME),
    Buffer.from(
      'pluginName = Synth.dll\r\ndefaultFxbName = Custom.fxb\r\nprogramDirName = banks\r\n',
      'latin1',
    ),
  );
  const custom = path.join(data.pluginDir, 'banks');
  await mkdir(custom);
  await writeFile(path.join(custom, 'Custom.fxb'), buildBank({ uniqueId: 'MySy' }));

  const body = (await list(data.root).expect(200)).body as BankListResult;

  assert.equal(body.presetsDir, custom);
  assert.equal(body.presetsDirExists, true);
  assert.deepEqual(
    body.banks.map((entry) => entry.fileName),
    ['Custom.fxb'],
  );
  assert.equal(body.config.config.defaultFxbName, 'Custom.fxb');
});

test('responde 400, 404 y 422 con rutas y configuraciones inválidas', async (t) => {
  const data = await scaffold(t);

  await list('plugs').expect(400);
  await list(path.join(data.root, 'NoExiste')).expect(400);
  await list(data.root, 'Fantasma').expect(404);

  const configPath = path.join(data.pluginDir, FXB_CONFIG_FILENAME);
  await writeFile(
    configPath,
    Buffer.from('pluginName = Synth.dll\r\nprogramDirName = ..\\fuera\r\n', 'latin1'),
  );

  const response = await list(data.root).expect(422);
  assert.match(response.body.message, /nombre de carpeta simple/);
  // La vista no repara ni reescribe la configuración: solo la reporta.
  assert.deepEqual(
    await readFile(configPath),
    Buffer.from('pluginName = Synth.dll\r\nprogramDirName = ..\\fuera\r\n', 'latin1'),
  );

  await http().post('/library/banks/list').send({ libraryRoot: data.root }).expect(400);
  await http().post('/library/banks/list').send({ plugin: 'Synth' }).expect(400);
});
