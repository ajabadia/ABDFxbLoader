import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { FXB_CONFIG_FILENAME } from '../src/fxb-config/fxb-config.constants';
import { MAX_PLUGINS_PER_BATCH } from '../src/client/batch-stream';
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
  dllSource: string;
  pluginDir(name: string): string;
}

async function makeLibrary(t: TestContext, names: string[] = ['Synth', 'Bass']): Promise<Library> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-batch-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const name of names) {
    const pluginDir = path.join(root, 'plugs', name);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(pluginDir, 'vfxinfo.txt'),
      Buffer.from(`name: ${name}\r\ndll_name: ${name}/${name}.dll\r\n`, 'latin1'),
    );
    await mkdir(path.join(pluginDir, name), { recursive: true });
    await writeFile(path.join(pluginDir, name, `${name}.dll`), pe32Dll());
  }

  const dllSource = path.join(root, 'fxbLoader.dll');
  await writeFile(dllSource, pe32Dll());

  return { root, dllSource, pluginDir: (name) => path.join(root, 'plugs', name) };
}

function originalVfxinfo(name: string): Buffer {
  return Buffer.from(`name: ${name}\r\ndll_name: ${name}/${name}.dll\r\n`, 'latin1');
}

function patchedVfxinfo(name: string): Buffer {
  return Buffer.from(`name: ${name}\r\ndll_name: ${name}/fxbLoader.dll\r\n`, 'latin1');
}

function statuses(body: { results: { name: string; status: string }[] }): [string, string][] {
  return body.results.map((result) => [result.name, result.status]);
}

test('POST /library/batch instala varios plugins y devuelve el resultado de cada uno', async (t) => {
  const lib = await makeLibrary(t);

  const response = await http()
    .post('/library/batch')
    .send({
      libraryRoot: lib.root,
      action: 'install',
      plugins: ['Synth', 'Bass'],
      dllSourcePath: lib.dllSource,
    })
    .expect(200);

  assert.equal(response.body.action, 'install');
  assert.equal(response.body.dryRun, false);
  assert.equal(response.body.total, 2);
  assert.equal(response.body.succeeded, 2);
  assert.equal(response.body.failed, 0);
  assert.deepEqual(statuses(response.body), [
    ['Synth', 'installed'],
    ['Bass', 'installed'],
  ]);

  for (const result of response.body.results as {
    name: string;
    message: string | null;
    entry: { installed: boolean; pluginName: string | null };
    actions: { kind: string }[];
  }[]) {
    assert.equal(result.message, null);
    assert.equal(result.entry.installed, true);
    assert.equal(result.entry.pluginName, `${result.name}.dll`);
    assert.deepEqual(
      result.actions.map((action) => action.kind),
      ['backup', 'copy', 'patch', 'write-config', 'create-dir'],
    );
  }

  // El disco refleja el lote completo.
  for (const name of ['Synth', 'Bass']) {
    const dir = lib.pluginDir(name);
    assert.deepEqual(await readFile(path.join(dir, 'vfxinfo.txt')), patchedVfxinfo(name));
    assert.deepEqual(await readFile(path.join(dir, 'vfxinfo.tx_')), originalVfxinfo(name));
    assert.equal(existsSync(path.join(dir, FXB_CONFIG_FILENAME)), true);
    assert.equal(existsSync(path.join(dir, 'fxbLoader.dll')), true);
  }
});

test('POST /library/batch conserva el orden y un fallo no detiene el lote', async (t) => {
  const lib = await makeLibrary(t);

  const response = await http()
    .post('/library/batch')
    .send({
      libraryRoot: lib.root,
      action: 'install',
      plugins: ['Fantasma', 'Synth', '../Fuera'],
      dllSourcePath: lib.dllSource,
    })
    .expect(200);

  assert.equal(response.body.total, 3);
  assert.equal(response.body.succeeded, 1);
  assert.equal(response.body.failed, 2);
  assert.deepEqual(statuses(response.body), [
    ['Fantasma', 'failed'],
    ['Synth', 'installed'],
    ['../Fuera', 'failed'],
  ]);

  const [missing, installed, traversal] = response.body.results as {
    message: string | null;
    entry: { installed: boolean } | null;
    actions: unknown[];
  }[];
  assert.match(missing?.message ?? '', /no existe el plugin "Fantasma"/);
  assert.equal(missing?.entry, null);
  assert.deepEqual(missing?.actions, []);
  assert.match(traversal?.message ?? '', /nombre de plugin no válido/);
  assert.equal(installed?.message, null, 'el resultado correcto no lleva mensaje');
  assert.equal(installed?.entry?.installed, true);

  // El plugin bueno sí quedó instalado y no se creó nada para los fallidos.
  assert.equal(existsSync(path.join(lib.pluginDir('Synth'), FXB_CONFIG_FILENAME)), true);
  assert.equal(
    existsSync(lib.pluginDir('Fantasma')),
    false,
    'un plugin inexistente no debe crear su carpeta',
  );
});

test('POST /library/batch reinstala con force y sin él devuelve 409 por plugin', async (t) => {
  const lib = await makeLibrary(t);
  const batch = { libraryRoot: lib.root, action: 'install', plugins: ['Synth', 'Bass'], dllSourcePath: lib.dllSource };

  await http().post('/library/batch').send(batch).expect(200);

  const conflicted = await http().post('/library/batch').send(batch).expect(200);
  assert.equal(conflicted.body.failed, 2);
  assert.deepEqual(statuses(conflicted.body), [
    ['Synth', 'failed'],
    ['Bass', 'failed'],
  ]);
  for (const result of conflicted.body.results as { message: string | null }[]) {
    assert.match(result.message ?? '', /ya tiene fxbLoader instalado \(usa force para reinstalar\)/);
  }

  const forced = await http().post('/library/batch').send({ ...batch, force: true }).expect(200);
  assert.equal(forced.body.failed, 0);
  assert.deepEqual(statuses(forced.body), [
    ['Synth', 'installed'],
    ['Bass', 'installed'],
  ]);
  // El respaldo de la reinstalación sigue siendo el original.
  for (const name of ['Synth', 'Bass']) {
    assert.deepEqual(await readFile(path.join(lib.pluginDir(name), 'vfxinfo.tx_')), originalVfxinfo(name));
  }
});

test('POST /library/batch con dryRun devuelve el plan de cada plugin sin escribir', async (t) => {
  const lib = await makeLibrary(t);

  const dry = await http()
    .post('/library/batch')
    .send({
      libraryRoot: lib.root,
      action: 'install',
      plugins: ['Synth', 'Bass'],
      dllSourcePath: lib.dllSource,
      dryRun: true,
    })
    .expect(200);

  assert.equal(dry.body.dryRun, true);
  assert.deepEqual(statuses(dry.body), [
    ['Synth', 'planned'],
    ['Bass', 'planned'],
  ]);
  assert.deepEqual(
    (dry.body.results[0].actions as { kind: string }[]).map((action) => action.kind),
    ['backup', 'copy', 'patch', 'write-config', 'create-dir'],
  );
  assert.equal(dry.body.results[0].entry.installed, false);

  // Nada en el disco.
  for (const name of ['Synth', 'Bass']) {
    const dir = lib.pluginDir(name);
    assert.deepEqual(await readFile(path.join(dir, 'vfxinfo.txt')), originalVfxinfo(name));
    assert.equal(existsSync(path.join(dir, 'vfxinfo.tx_')), false);
    assert.equal(existsSync(path.join(dir, FXB_CONFIG_FILENAME)), false);
    assert.equal(existsSync(path.join(dir, 'fxbLoader.dll')), false);
  }

  // Como no dejó estado, la instalación real sigue funcionando.
  await http()
    .post('/library/batch')
    .send({ libraryRoot: lib.root, action: 'install', plugins: ['Synth'], dllSourcePath: lib.dllSource })
    .expect(200);

  const dryUninstall = await http()
    .post('/library/batch')
    .send({ libraryRoot: lib.root, action: 'uninstall', plugins: ['Synth'], dryRun: true })
    .expect(200);
  assert.equal(dryUninstall.body.dryRun, true);
  assert.deepEqual(statuses(dryUninstall.body), [['Synth', 'planned']]);
  assert.deepEqual(
    (dryUninstall.body.results[0].actions as { kind: string }[]).map((action) => action.kind),
    ['restore', 'restore', 'delete'],
  );
  assert.equal(existsSync(path.join(lib.pluginDir('Synth'), FXB_CONFIG_FILENAME)), true, 'dryRun no desinstala');
});

test('POST /library/batch desinstala varios plugins y restaura cada vfxinfo', async (t) => {
  const lib = await makeLibrary(t);
  await http()
    .post('/library/batch')
    .send({ libraryRoot: lib.root, action: 'install', plugins: ['Synth', 'Bass'], dllSourcePath: lib.dllSource })
    .expect(200);

  const response = await http()
    .post('/library/batch')
    .send({ libraryRoot: lib.root, action: 'uninstall', plugins: ['Synth', 'Bass'] })
    .expect(200);

  assert.equal(response.body.action, 'uninstall');
  assert.deepEqual(statuses(response.body), [
    ['Synth', 'uninstalled'],
    ['Bass', 'uninstalled'],
  ]);
  assert.deepEqual(
    (response.body.results[0].actions as { kind: string }[]).map((action) => action.kind),
    ['restore', 'restore', 'delete'],
  );

  for (const name of ['Synth', 'Bass']) {
    const dir = lib.pluginDir(name);
    assert.deepEqual(await readFile(path.join(dir, 'vfxinfo.txt')), originalVfxinfo(name));
    assert.deepEqual(await readFile(path.join(dir, 'vfxinfo.loader')), patchedVfxinfo(name));
    assert.equal(existsSync(path.join(dir, FXB_CONFIG_FILENAME)), false);
    assert.equal(existsSync(path.join(dir, 'fxbLoader.dll')), true, 'el DLL se conserva');
  }

  // Desinstalar otra vez: cada plugin falla por su cuenta, sin cancelar el lote.
  const again = await http()
    .post('/library/batch')
    .send({ libraryRoot: lib.root, action: 'uninstall', plugins: ['Synth', 'Bass'] })
    .expect(200);
  assert.equal(again.body.failed, 2);
  assert.match(again.body.results[0].message, /Synth no tiene fxbLoader instalado/);
});

test('POST /library/batch rechaza la petición entera si el lote no es válido', async (t) => {
  const lib = await makeLibrary(t);
  const batch = { libraryRoot: lib.root, action: 'install', plugins: ['Synth'], dllSourcePath: lib.dllSource };

  const badAction = await http()
    .post('/library/batch')
    .send({ ...batch, action: 'borrar' })
    .expect(400);
  assert.match(badAction.body.message, /action debe ser "install" o "uninstall"/);

  const empty = await http()
    .post('/library/batch')
    .send({ ...batch, plugins: [] })
    .expect(400);
  assert.match(empty.body.message, /plugins debe ser un array con al menos un nombre/);

  const notStrings = await http()
    .post('/library/batch')
    .send({ ...batch, plugins: ['Synth', 7] })
    .expect(400);
  assert.match(notStrings.body.message, /plugins debe contener cadenas no vacías/);

  await http().post('/library/batch').send({ ...batch, libraryRoot: 'plugs' }).expect(400);
  await http().post('/library/batch').send({ ...batch, dllSourcePath: 'loader.dll' }).expect(400);

  // Ninguna de esas peticiones llegó a tocar el plugin.
  assert.deepEqual(await readFile(path.join(lib.pluginDir('Synth'), 'vfxinfo.txt')), originalVfxinfo('Synth'));
  assert.equal(existsSync(path.join(lib.pluginDir('Synth'), FXB_CONFIG_FILENAME)), false);
});

test('POST /library/batch rechaza un lote por encima del tope sin tocar ningún plugin', async (t) => {
  const lib = await makeLibrary(t);

  // Un nombre de más: el lote entero se rechaza, aunque el primero sea válido.
  const tooMany = ['Synth', ...Array.from({ length: MAX_PLUGINS_PER_BATCH }, (_, i) => `Extra${i}`)];
  assert.equal(tooMany.length, MAX_PLUGINS_PER_BATCH + 1);

  const rejected = await http()
    .post('/library/batch')
    .send({
      libraryRoot: lib.root,
      action: 'install',
      plugins: tooMany,
      dllSourcePath: lib.dllSource,
    })
    .expect(400);

  assert.equal(rejected.body.message, `como máximo ${MAX_PLUGINS_PER_BATCH} plugins por petición`);
  // No se procesó ni el primero: es un 400 de la petición, no un fallo por plugin.
  assert.deepEqual(await readFile(path.join(lib.pluginDir('Synth'), 'vfxinfo.txt')), originalVfxinfo('Synth'));
  assert.equal(existsSync(path.join(lib.pluginDir('Synth'), FXB_CONFIG_FILENAME)), false);

  // Justo en el tope sí se acepta: el límite es `>`, no `>=`. El primer plugin
  // existe y el resto no, así que el lote se recorre y cada uno lleva su fallo.
  const atLimit = tooMany.slice(0, MAX_PLUGINS_PER_BATCH);
  const accepted = await http()
    .post('/library/batch')
    .send({
      libraryRoot: lib.root,
      action: 'install',
      plugins: atLimit,
      dllSourcePath: lib.dllSource,
    })
    .expect(200);

  assert.equal(accepted.body.total, MAX_PLUGINS_PER_BATCH);
  assert.equal(accepted.body.succeeded, 1);
  assert.equal(accepted.body.failed, MAX_PLUGINS_PER_BATCH - 1);
  assert.equal(accepted.body.results[0].name, 'Synth');
  assert.equal(accepted.body.results[0].status, 'installed');
  assert.equal(accepted.body.results[1].name, 'Extra0');
  assert.equal(accepted.body.results[1].status, 'failed');
});

test('POST /library/batch con un cargador que no es PE32 no toca ningún plugin', async (t) => {
  const lib = await makeLibrary(t);
  const wrongLoader = path.join(lib.root, 'loader64.dll');
  await writeFile(wrongLoader, pe64Dll());

  const response = await http()
    .post('/library/batch')
    .send({
      libraryRoot: lib.root,
      action: 'install',
      plugins: ['Synth', 'Bass'],
      dllSourcePath: wrongLoader,
    })
    .expect(422);

  assert.match(response.body.message, /fxbLoader\.dll no es un PE32 i386 válido: es PE32\+ AMD64/);
  for (const name of ['Synth', 'Bass']) {
    assert.deepEqual(await readFile(path.join(lib.pluginDir(name), 'vfxinfo.txt')), originalVfxinfo(name));
    assert.equal(existsSync(path.join(lib.pluginDir(name), FXB_CONFIG_FILENAME)), false);
  }
});
