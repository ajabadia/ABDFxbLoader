import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { planSync, readLibraryPlugins } from '../src/vmachine/sync';
import { VMachineService } from '../src/vmachine/vmachine.service';
import {
  VMachineError,
  type VMachineInventoryPlugin,
} from '../src/vmachine/vmachine.types';

/**
 * Sincronización librería ↔ medio.
 *
 * Lo que fija esta suite es que la comparación no inventa: empareja por id VST
 * —el nombre de la carpeta puede cambiar—, cae al nombre cuando no hay id, y
 * distingue lo que falta de lo que ya está, sin contar como pendiente lo que
 * solo vive en el medio. Y que la copia en lote comprueba el espacio de todo el
 * lote antes de escribir, para no dejar el stick a medias.
 */

function service(): VMachineService {
  return new VMachineService('win32', async () => '[]', () => null);
}

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

/** Crea `<root>\plugs\<folder>` con su vfxinfo en latin1 y los archivos dados. */
async function addPlugin(
  root: string,
  folder: string,
  fields: Record<string, string>,
  files: Record<string, string> = {},
): Promise<string> {
  const dir = path.join(root, 'plugs', folder);
  await mkdir(dir, { recursive: true });
  const vfxinfo = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');
  await writeFile(path.join(dir, 'vfxinfo.txt'), Buffer.from(`${vfxinfo}\r\n`, 'latin1'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

function stickPlugin(overrides: Partial<VMachineInventoryPlugin>): VMachineInventoryPlugin {
  return {
    library: 'V-MACHINE.vfxlibrary',
    folder: 'Plugin',
    path: 'E:\\V-MACHINE.vfxlibrary\\plugs\\Plugin',
    hasVfxinfo: true,
    name: 'Plugin',
    id: null,
    version: null,
    dll: null,
    files: 1,
    bytes: 10,
    catalog: null,
    status: 'unknown',
    ...overrides,
  };
}

test('lee la librería en orden, en latin1 y con lo que ocupa cada plugin', async (t) => {
  const library = await tempDir(t, 'fxb-sync-lib-');
  await addPlugin(
    library,
    'Alfa',
    { name: 'Órgano «Doble»', id: '7', version: '1.0', dll_name: 'Alfa/Org.dll' },
    { 'Org.dll': 'dll', 'presets/Init.fxp': 'preset' },
  );
  // Sin vfxinfo: la carpeta existe, pero no hay nada que la identifique.
  await mkdir(path.join(library, 'plugs', 'Beta'), { recursive: true });
  await addPlugin(library, 'Zeta', { name: 'Zeta' });

  const plugins = await readLibraryPlugins(library);

  assert.deepEqual(
    plugins.map((plugin) => plugin.folder),
    ['Alfa', 'Beta', 'Zeta'],
  );
  const organ = plugins[0]!;
  assert.equal(organ.name, 'Órgano «Doble»');
  assert.equal(organ.version, '1.0');
  assert.equal(organ.dll, 'Alfa/Org.dll');
  assert.equal(organ.files, 3);
  // vfxinfo + DLL + preset: el recuento es lo que la vista suma como pendiente.
  assert.ok(organ.bytes > 9, `esperaba más de 9 bytes, llegaron ${organ.bytes}`);

  // Sin vfxinfo no hay identidad, pero el plugin está y se ofrece copiar.
  const empty = plugins[1]!;
  assert.equal(empty.hasVfxinfo, false);
  assert.equal(empty.name, null);
});

test('una ruta sin plugs no se hace pasar por una librería vacía', async (t) => {
  const root = await tempDir(t, 'fxb-sync-noplugs-');

  await assert.rejects(
    () => readLibraryPlugins(root),
    (error: unknown) => {
      assert.ok(error instanceof VMachineError);
      assert.equal(error.apiCode, 'plugsMissing');
      return true;
    },
  );
});

test('empareja por id, por nombre y no cuenta lo que solo está en el medio', () => {
  const library = [
    { folder: 'Carpeta Renombrada', path: '', hasVfxinfo: true, name: 'SuperWave P8', id: '42', version: '1.3', dll: null, files: 2, bytes: 100 },
    { folder: 'Viejo', path: '', hasVfxinfo: true, name: 'Viejo', id: null, version: '1.0', dll: null, files: 1, bytes: 50 },
    { folder: 'Nuevo', path: '', hasVfxinfo: true, name: 'Nuevo', id: null, version: '2.0', dll: null, files: 3, bytes: 25 },
  ];

  const plan = planSync(library, [
    stickPlugin({ folder: 'P8', name: 'SuperWave P8', id: '42', version: '1.2', bytes: 10 }),
    stickPlugin({ folder: 'Viejo', name: 'VIEJO', version: '1.0', bytes: 10 }),
    stickPlugin({ folder: 'Solo en el medio', name: 'Solo en el medio', version: '9.9', bytes: 10 }),
  ]);

  assert.deepEqual(
    plan.entries.map((entry) => [entry.folder, entry.state]),
    [
      ['Carpeta Renombrada', 'differs'],
      ['Viejo', 'same'],
      ['Nuevo', 'missing'],
    ],
  );
  // El medio va por detrás: se sabe qué carpeta pisaría y con qué versión.
  assert.equal(plan.entries[0]!.stickFolder, 'P8');
  assert.equal(plan.entries[0]!.stickVersion, '1.2');
  assert.deepEqual(
    plan.extra.map((entry) => entry.folder),
    ['Solo en el medio'],
  );
  assert.equal(plan.missing, 1);
  assert.equal(plan.differs, 1);
  assert.equal(plan.same, 1);
  assert.equal(plan.pendingBytes, 125);
});

test('sync compara el medio real y dice en qué biblioteca copiaría', async (t) => {
  const library = await tempDir(t, 'fxb-sync-lib2-');
  const stick = await tempDir(t, 'fxb-sync-stick2-');

  await addPlugin(library, 'P8', { name: 'SuperWave P8', id: '42', version: '1.3' }, { 'P8.dll': 'dll' });
  await addPlugin(library, 'Falta', { name: 'Falta', id: '77', version: '1.0' }, { 'F.dll': 'dll' });
  await addPlugin(
    path.join(stick, 'V-MACHINE.vfxlibrary'),
    'P8',
    { name: 'SuperWave P8', id: '42', version: '1.2' },
    { 'P8.dll': 'dll' },
  );

  const result = await service().sync(stick, library);

  assert.equal(result.targetLibrary, 'V-MACHINE.vfxlibrary');
  assert.equal(result.missing, 1);
  assert.equal(result.differs, 1);
  assert.equal(result.extra.length, 0);
  assert.deepEqual(
    result.entries.map((entry) => entry.folder),
    ['Falta', 'P8'],
  );
});

test('copia en lote solo lo pedido y lo deja verificado en la biblioteca', async (t) => {
  const library = await tempDir(t, 'fxb-sync-copy-lib-');
  const stick = await tempDir(t, 'fxb-sync-copy-stick-');

  await addPlugin(library, 'P8', { name: 'SuperWave P8', id: '42', version: '1.3' }, { 'P8.dll': 'dll' });
  await addPlugin(library, 'Otro', { name: 'Otro', id: '9' }, { 'Otro.dll': 'dll' });

  const vm = service();
  const result = await vm.copyToStick({
    drive: stick,
    libraryRoot: library,
    folders: ['P8'],
    spaceAvailable: async () => 1024 * 1024,
  });

  assert.equal(result.failed, 0);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]!.ok, true);
  assert.equal(result.copied, 2);
  assert.equal(result.verified, 2);
  assert.equal(result.libraryDir, path.join(stick, 'V-MACHINE.vfxlibrary'));
  assert.equal(
    await readFileText(path.join(stick, 'V-MACHINE.vfxlibrary', 'plugs', 'P8', 'P8.dll')),
    'dll',
  );
  // `Otro` no se pidió: el lote no copia la librería entera a escondidas.
  assert.equal(await exists(path.join(stick, 'V-MACHINE.vfxlibrary', 'plugs', 'Otro')), false);

  // Repetir el lote es lo que hace la vista tras copiar: pisa lo mismo y lo dice.
  const again = await vm.copyToStick({
    drive: stick,
    libraryRoot: library,
    folders: ['P8'],
    spaceAvailable: async () => 1024 * 1024,
  });
  assert.equal(again.results[0]!.replaced, 2);

  const inventory = await vm.inventory(stick);
  assert.equal(inventory.plugins, 1);
  assert.equal(inventory.libraries[0]!.plugins[0]!.version, '1.3');
});

test('si el lote no cabe no se escribe nada', async (t) => {
  const library = await tempDir(t, 'fxb-sync-space-lib-');
  const stick = await tempDir(t, 'fxb-sync-space-stick-');
  await addPlugin(library, 'Grande', { name: 'Grande', id: '1' }, { 'G.dll': 'x'.repeat(64) });

  await assert.rejects(
    () =>
      service().copyToStick({
        drive: stick,
        libraryRoot: library,
        folders: ['Grande'],
        spaceAvailable: async () => 10,
      }),
    (error: unknown) => {
      assert.ok(error instanceof VMachineError);
      assert.equal(error.apiCode, 'notEnoughSpace');
      return true;
    },
  );

  assert.equal(await exists(path.join(stick, 'V-MACHINE.vfxlibrary')), false);
});

test('no se puede pedir una carpeta fuera de la librería', async (t) => {
  const library = await tempDir(t, 'fxb-sync-escape-lib-');
  const stick = await tempDir(t, 'fxb-sync-escape-stick-');
  // Con `plugs` presente el rechazo es del nombre, no de la librería entera.
  await mkdir(path.join(library, 'plugs'), { recursive: true });

  await assert.rejects(
    () =>
      service().copyToStick({
        drive: stick,
        libraryRoot: library,
        folders: ['..\\Windows'],
        spaceAvailable: async () => 1024,
      }),
    (error: unknown) => {
      assert.ok(error instanceof VMachineError);
      assert.equal(error.apiCode, 'pluginFolderMissing');
      return true;
    },
  );
});

test('el API pide unidad y librería, y devuelve el plan con código de error', async (t) => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  t.after(async () => {
    await app.close();
  });

  await request(app.getHttpServer()).get('/vmachine/sync').expect(400);

  const stick = await tempDir(t, 'fxb-sync-http-stick-');
  const library = await tempDir(t, 'fxb-sync-http-lib-');
  await addPlugin(library, 'P8', { name: 'SuperWave P8', id: '42', version: '1.3' });

  const ok = await request(app.getHttpServer())
    .get(`/vmachine/sync?drive=${encodeURIComponent(stick)}&library=${encodeURIComponent(library)}`)
    .expect(200);
  assert.equal(ok.body.missing, 1);
  assert.equal(ok.body.targetLibrary, 'V-MACHINE.vfxlibrary');

  const noLibrary = await request(app.getHttpServer())
    .get(`/vmachine/sync?drive=${encodeURIComponent(stick)}`)
    .expect(400);
  assert.deepEqual(noLibrary.body, { message: 'library requerido' });

  const gone = await request(app.getHttpServer())
    .get(
      `/vmachine/sync?drive=${encodeURIComponent(path.join(stick, 'nada'))}&library=${encodeURIComponent(library)}`,
    )
    .expect(404);
  assert.equal(gone.body.code, 'driveNotFound');

  const copied = await request(app.getHttpServer())
    .post('/vmachine/copy')
    .send({ drive: stick, library, folders: ['P8'] })
    .expect(200);
  assert.equal(copied.body.copied, 1);
  assert.equal(copied.body.failed, 0);
});

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readFileText(target: string): Promise<string> {
  return (await readFile(target, 'latin1')).toString();
}
