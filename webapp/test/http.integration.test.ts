import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
    response.body.plugins.map((plugin: { name: string; hasLoader: boolean }) => [
      plugin.name,
      plugin.hasLoader,
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
    .post('/library/loader/add')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dllSource })
    .expect(422);
  assert.match(rejected.body.message, /no es compatible/);
});

test('POST /library/loader/add responde 422 si el DLL declarado no existe', async (t) => {
  const lib = await makeLibrary(t);
  await rm(path.join(lib.pluginDir, 'Synth', 'Synth.dll'));

  const response = await http()
    .post('/library/loader/add')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dllSource })
    .expect(422);

  assert.match(response.body.message, /Synth no es compatible con fxbLoader\.dll de 32 bits/);
  assert.match(
    response.body.message,
    /no existe el binario declarado en dll_name: Synth\/Synth\.dll/,
  );

  // El escaneo lo marca como incompatible, así que la UI deshabilita Instalar.
  const scan = await http()
    .post('/library/scan')
    .send({ libraryRoot: lib.root, dllSourcePath: lib.dllSource })
    .expect(200);
  assert.equal(scan.body.plugins[0].compatible, false);
  // Nada escrito: ni respaldo, ni cargador, ni configuración.
  await assert.rejects(readFile(path.join(lib.pluginDir, 'fxbLoader.config')));
  await assert.rejects(readFile(path.join(lib.pluginDir, 'fxbLoader.dll')));
  await assert.rejects(readFile(path.join(lib.pluginDir, 'vfxinfo.tx_')));
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

test('POST /library/loader/add responde 200, escribe los archivos y luego 409', async (t) => {
  const lib = await makeLibrary(t);

  const response = await http()
    .post('/library/loader/add')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dllSource })
    .expect(200);

  assert.equal(response.body.dryRun, false);
  assert.deepEqual(
    response.body.actions.map((action: { kind: string }) => action.kind),
    ['backup', 'copy', 'patch', 'write-config', 'create-dir'],
  );
  assert.equal(response.body.plugin.hasLoader, true);
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
    .post('/library/loader/add')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dllSource })
    .expect(409);
  assert.match(conflict.body.message, /ya tiene el cargador/);
});

test('POST /library/loader/add responde 400 con traversal y 404 con plugin inexistente', async (t) => {
  const lib = await makeLibrary(t);

  await http()
    .post('/library/loader/add')
    .send({ libraryRoot: lib.root, plugin: '../Synth', dllSourcePath: lib.dllSource })
    .expect(400);

  await http()
    .post('/library/loader/add')
    .send({ libraryRoot: lib.root, plugin: 'Ghost', dllSourcePath: lib.dllSource })
    .expect(404);
});

test('POST /library/loader/remove responde 200 y después 409', async (t) => {
  const lib = await makeLibrary(t);
  await http()
    .post('/library/loader/add')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dllSource })
    .expect(200);

  const response = await http()
    .post('/library/loader/remove')
    .send({ libraryRoot: lib.root, plugin: 'Synth' })
    .expect(200);

  assert.equal(response.body.plugin.hasLoader, false);
  assert.equal(
    (await readFile(path.join(lib.pluginDir, 'vfxinfo.txt'))).toString('latin1'),
    'name: Synth\r\ndll_name: Synth/Synth.dll\r\nversion: 1.0\r\n',
  );

  await http()
    .post('/library/loader/remove')
    .send({ libraryRoot: lib.root, plugin: 'Synth' })
    .expect(409);
});

test('POST /library/loader/remove restaura el original tras dos instalaciones con force', async (t) => {
  const lib = await makeLibrary(t);
  const vfxinfoPath = path.join(lib.pluginDir, 'vfxinfo.txt');
  const backupPath = path.join(lib.pluginDir, 'vfxinfo.tx_');
  const loaderPath = path.join(lib.pluginDir, 'vfxinfo.loader');
  const configPath = path.join(lib.pluginDir, 'fxbLoader.config');

  const original = Buffer.from(
    'name: Synth\r\ndll_name: Synth/Synth.dll\r\nversion: 1.0\r\n',
    'latin1',
  );
  assert.deepEqual(await readFile(vfxinfoPath), original);

  // Primera instalación; force sobre un plugin sin instalar se ignora.
  await http()
    .post('/library/loader/add')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dllSource, force: true })
    .expect(200);
  const patched = await readFile(vfxinfoPath);
  assert.deepEqual(await readFile(backupPath), original, 'el respaldo es el original');
  assert.equal(
    patched.toString('latin1'),
    'name: Synth\r\ndll_name: Synth/fxbLoader.dll\r\nversion: 1.0\r\n',
  );

  // Sin force no se reinstala.
  await http()
    .post('/library/loader/add')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dllSource })
    .expect(409);

  const forced = await http()
    .post('/library/loader/add')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dllSource, force: true })
    .expect(200);
  assert.equal(forced.body.plugin.hasLoader, true);
  assert.equal(
    forced.body.plugin.pluginName,
    'Synth.dll',
    'la reinstalación sigue viendo el plugin original, no el cargador',
  );
  const backupAction = (forced.body.actions as { kind: string; detail?: string }[]).find(
    (action) => action.kind === 'backup',
  );
  assert.match(backupAction?.detail ?? '', /ya existe; se conserva/);

  // El respaldo no se pisa con el ya parcheado y la config conserva el nombre.
  assert.deepEqual(await readFile(backupPath), original, 'force no pisa el respaldo');
  assert.deepEqual(await readFile(vfxinfoPath), patched, 'vfxinfo.txt sigue parcheado');
  assert.match(
    (await readFile(configPath)).toString('latin1'),
    /^pluginName = Synth\.dll\r?$/m,
  );

  const uninstalled = await http()
    .post('/library/loader/remove')
    .send({ libraryRoot: lib.root, plugin: 'Synth' })
    .expect(200);
  assert.equal(uninstalled.body.plugin.hasLoader, false);

  assert.deepEqual(await readFile(vfxinfoPath), original, 'vfxinfo.txt vuelve al original');
  assert.deepEqual(
    await readFile(loaderPath),
    patched,
    'el parcheado se conserva como vfxinfo.loader',
  );
  assert.equal(existsSync(backupPath), false, 'el respaldo se consume al restaurar');
  assert.equal(existsSync(configPath), false);
  assert.equal(existsSync(path.join(lib.pluginDir, 'fxbLoader.dll')), true, 'el DLL queda');
  assert.deepEqual(
    (await readdir(lib.pluginDir)).filter((name) => name.endsWith('.tmp')),
    [],
    'no deben quedar temporales de la escritura atómica',
  );
});

test('POST /library/loader/remove responde 409 sin tocar vfxinfo.txt si falta el respaldo', async (t) => {
  const lib = await makeLibrary(t);
  const vfxinfoPath = path.join(lib.pluginDir, 'vfxinfo.txt');
  const backupPath = path.join(lib.pluginDir, 'vfxinfo.tx_');
  const configPath = path.join(lib.pluginDir, 'fxbLoader.config');
  const loaderCopyPath = path.join(lib.pluginDir, 'vfxinfo.loader');

  // Instalación y reinstalación con force: el respaldo sigue siendo el original.
  await http()
    .post('/library/loader/add')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dllSource })
    .expect(200);
  const patched = await readFile(vfxinfoPath);
  await http()
    .post('/library/loader/add')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dllSource, force: true })
    .expect(200);
  assert.deepEqual(await readFile(vfxinfoPath), patched, 'la reinstalación deja el mismo parche');

  // Tras reinstalar, el respaldo desaparece (antivirus, limpieza manual...).
  await rm(backupPath);
  const before = (await readdir(lib.pluginDir)).sort();

  // `dryRun` valida igual: tampoco puede prometer un plan que no se puede cumplir.
  await http()
    .post('/library/loader/remove')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dryRun: true })
    .expect(409);

  const conflict = await http()
    .post('/library/loader/remove')
    .send({ libraryRoot: lib.root, plugin: 'Synth' })
    .expect(409);
  assert.match(conflict.body.message, /falta vfxinfo\.tx_ en/);
  assert.match(conflict.body.message, /restaurar el vfxinfo\.txt original/);

  // Nada se movió: ni el vfxinfo parcheado, ni la config, ni el DLL del cargador.
  assert.deepEqual(await readFile(vfxinfoPath), patched, 'vfxinfo.txt sigue parcheado');
  assert.equal(
    (await readFile(configPath)).toString('latin1'),
    'pluginName = Synth.dll\r\ndefaultFxbName = \r\nprogramDirName = presets\r\nloadFxbBank = yes\r\n',
  );
  assert.equal(existsSync(loaderCopyPath), false, 'no se crea vfxinfo.loader');
  assert.equal(existsSync(backupPath), false);
  assert.deepEqual((await readdir(lib.pluginDir)).sort(), before, 'la carpeta del plugin queda igual');
  assert.deepEqual(
    (await readdir(lib.pluginDir)).filter((name) => name.endsWith('.tmp')),
    [],
    'no deben quedar temporales',
  );
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
  // Sin sobre de Nest: el cuerpo es `message` + `issues`, como el DTO.
  assert.deepEqual(Object.keys(invalid.body).sort(), ['issues', 'message']);
});

test('los 400 devuelven solo el cuerpo que documenta su DTO', async () => {
  // Excepción con mensaje de texto: Nest añadía `statusCode` y `error`.
  const missing = await http().post('/library/scan').send({}).expect(400);
  assert.deepEqual(missing.body, {
    message: 'libraryRoot es obligatorio y debe ser una cadena',
  });

  // Un 400 que no nace en un controlador: el cuerpo JSON mal formado.
  const malformed = await http()
    .post('/library/scan')
    .set('content-type', 'application/json')
    .send('{"libraryRoot": ')
    .expect(400);
  assert.deepEqual(Object.keys(malformed.body), ['message']);
  assert.equal(typeof malformed.body.message, 'string');
});

test('POST /system/paths dice qué rutas recordadas siguen en el disco', async (t) => {
  const lib = await makeLibrary(t);
  const missing = path.join(lib.root, 'plugs', 'Borrado.fxb');

  const response = await http()
    .post('/system/paths')
    .send({ paths: [lib.root, `  ${lib.dllSource}  `, missing] })
    .expect(200);

  // Un elemento por ruta, en el orden pedido y sin los espacios del campo.
  assert.deepEqual(response.body, {
    results: [
      { path: lib.root, exists: true, isDirectory: true },
      { path: lib.dllSource, exists: true, isDirectory: false },
      { path: missing, exists: false, isDirectory: false },
    ],
  });

  await http().post('/system/paths').send({ paths: [] }).expect(200, { results: [] });
  await http().post('/system/paths').send({ paths: ['plugs'] }).expect(400);
});
