import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pe32Dll, pe64Dll } from './helpers/pe';

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

interface Library {
  root: string;
  pluginDir: string;
  dllSource: string;
}

async function makeLibrary(t: TestContext): Promise<Library> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-http-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pluginDir = path.join(root, 'plugs', 'Synth');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, 'vfxinfo.txt'),
    Buffer.from('name: Synth\r\ndll_name: Synth/Synth.dll\r\nversion: 1.0\r\n', 'latin1'),
  );
  await mkdir(path.join(pluginDir, 'Synth'), { recursive: true });
  await writeFile(path.join(pluginDir, 'Synth', 'Synth.dll'), pe32Dll());

  const dllSource = path.join(root, 'fxbLoader.dll');
  await writeFile(dllSource, pe32Dll());

  return { root, pluginDir, dllSource };
}

test('POST /library/scan responde 200 con el listado', async (t) => {
  const lib = await makeLibrary(t);

  const response = await http()
    .post('/library/scan')
    .send({ libraryRoot: lib.root })
    .expect(200);

  assert.equal(response.body.plugsPath, path.join(lib.root, 'plugs'));
  assert.deepEqual(
    response.body.plugins.map((plugin: { name: string; installed: boolean }) => [
      plugin.name,
      plugin.installed,
    ]),
    [['Synth', false]],
  );
});

test('POST /library/scan valida el cargador y marca plugins de 64 bits', async (t) => {
  const lib = await makeLibrary(t);
  const pluginBinary = path.join(lib.pluginDir, 'Synth', 'Synth.dll');
  await writeFile(pluginBinary, pe64Dll());

  const scan = await http()
    .post('/library/scan')
    .send({ libraryRoot: lib.root, dllSourcePath: lib.dllSource })
    .expect(200);

  assert.equal(scan.body.loader.valid, true);
  assert.equal(scan.body.loader.bitness, 32);
  assert.equal(scan.body.plugins[0].compatible, false);
  assert.match(
    scan.body.plugins[0].compatibilityIssues.join(' '),
    /PE32\+ AMD64 \(64 bits\)/,
  );

  const badLoader = path.join(lib.root, 'bad-loader.dll');
  await writeFile(badLoader, pe64Dll());
  const bad = await http()
    .post('/library/scan')
    .send({ libraryRoot: lib.root, dllSourcePath: badLoader })
    .expect(200);

  assert.equal(bad.body.loader.valid, false);
  assert.match(bad.body.loader.issues.join(' '), /PE32\+ AMD64/);
  assert.equal(bad.body.plugins[0].compatible, false);

  const rejected = await http()
    .post('/library/install')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dllSource })
    .expect(422);
  assert.match(rejected.body.message, /no es compatible/);
});

test('POST /library/scan responde 400 sin libraryRoot o con ruta relativa', async (t) => {
  const lib = await makeLibrary(t);

  const missing = await http().post('/library/scan').send({}).expect(400);
  assert.match(missing.body.message, /libraryRoot/);

  await http().post('/library/scan').send({ libraryRoot: 'plugs' }).expect(400);
  await http().post('/library/scan').send({ libraryRoot: path.join(lib.root, 'nope') }).expect(400);
  await http()
    .post('/library/scan')
    .send({ libraryRoot: lib.root, dllSourcePath: 'fxbLoader.dll' })
    .expect(400);
  await http()
    .post('/library/scan')
    .send({ libraryRoot: lib.root, dllSourcePath: path.join(lib.root, 'nope.dll') })
    .expect(400);
});

test('POST /library/install responde 200, escribe los archivos y luego 409', async (t) => {
  const lib = await makeLibrary(t);

  const response = await http()
    .post('/library/install')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dllSource })
    .expect(200);

  assert.equal(response.body.dryRun, false);
  assert.deepEqual(
    response.body.actions.map((action: { kind: string }) => action.kind),
    ['backup', 'copy', 'patch', 'write-config', 'create-dir'],
  );
  assert.equal(response.body.plugin.installed, true);
  assert.equal(response.body.plugin.pluginName, 'Synth.dll');

  const vfxinfo = (await readFile(path.join(lib.pluginDir, 'vfxinfo.txt'))).toString('latin1');
  assert.equal(
    vfxinfo,
    'name: Synth\r\ndll_name: Synth/fxbLoader.dll\r\nversion: 1.0\r\n',
  );
  assert.equal(
    (await readFile(path.join(lib.pluginDir, 'fxbLoader.config'))).toString('latin1'),
    'pluginName = Synth.dll\r\ndefaultFxbName = \r\nprogramDirName = presets\r\nloadFxbBank = yes\r\n',
  );
  assert.deepEqual(await readFile(path.join(lib.pluginDir, 'fxbLoader.dll')), pe32Dll());

  const conflict = await http()
    .post('/library/install')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dllSource })
    .expect(409);
  assert.match(conflict.body.message, /ya tiene fxbLoader/);
});

test('POST /library/install responde 400 con traversal y 404 con plugin inexistente', async (t) => {
  const lib = await makeLibrary(t);

  await http()
    .post('/library/install')
    .send({ libraryRoot: lib.root, plugin: '../Synth', dllSourcePath: lib.dllSource })
    .expect(400);

  await http()
    .post('/library/install')
    .send({ libraryRoot: lib.root, plugin: 'Ghost', dllSourcePath: lib.dllSource })
    .expect(404);
});

test('POST /library/uninstall responde 200 y después 409', async (t) => {
  const lib = await makeLibrary(t);
  await http()
    .post('/library/install')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dllSource })
    .expect(200);

  const response = await http()
    .post('/library/uninstall')
    .send({ libraryRoot: lib.root, plugin: 'Synth' })
    .expect(200);

  assert.equal(response.body.plugin.installed, false);
  assert.equal(
    (await readFile(path.join(lib.pluginDir, 'vfxinfo.txt'))).toString('latin1'),
    'name: Synth\r\ndll_name: Synth/Synth.dll\r\nversion: 1.0\r\n',
  );

  await http()
    .post('/library/uninstall')
    .send({ libraryRoot: lib.root, plugin: 'Synth' })
    .expect(409);
});

test('PUT /fxb-config responde 200, 409 con mtime obsoleto y 400 con config inválida', async (t) => {
  const lib = await makeLibrary(t);

  const created = await http()
    .put('/fxb-config')
    .send({
      pluginDir: lib.pluginDir,
      expectedMtimeMs: null,
      config: { pluginName: 'Synth.dll' },
    })
    .expect(200);

  assert.equal(created.body.exists, true);
  assert.equal(created.body.config.programDirName, 'presets');

  const stale = await http()
    .put('/fxb-config')
    .send({
      pluginDir: lib.pluginDir,
      expectedMtimeMs: null,
      config: { loadFxbBank: false },
    })
    .expect(409);
  assert.equal(stale.body.current.exists, true);
  assert.equal(stale.body.current.config.loadFxbBank, true);

  const invalid = await http()
    .put('/fxb-config')
    .send({
      pluginDir: lib.pluginDir,
      expectedMtimeMs: created.body.mtimeMs,
      config: { programDirName: '' },
    })
    .expect(400);
  assert.equal(Array.isArray(invalid.body.issues), true);
});
