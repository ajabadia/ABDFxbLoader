import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { parseDrives } from '../src/vmachine/drives';
import {
  VMachineService,
  libraryNameProblem,
  withLibrarySuffix,
} from '../src/vmachine/vmachine.service';
import { VMachineError } from '../src/vmachine/vmachine.types';

/**
 * Copia del paquete a la unidad de la v-machine.
 *
 * Lo que fija esta suite es la forma que la máquina espera —`<Nombre>.vfxlibrary`
 * en la raíz del medio, con `plugs\<Plugin>\` dentro— y que la copia se
 * comprueba: el mismo contenido en origen y destino, y los recuentos que la
 * vista enseña. El medio es una carpeta temporal, así que no hace falta ningún
 * stick ni PowerShell.
 */

const PLUGIN = 'SuperWave P8';

async function makePlugin(t: TestContext, name = PLUGIN): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-vmachine-src-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'plugs', name);
  await mkdir(path.join(dir, 'presets'), { recursive: true });
  await writeFile(path.join(dir, 'vfxinfo.txt'), Buffer.from(`name: ${name}\r\ndll_name: ${name}/${name}.dll\r\n`, 'latin1'));
  await writeFile(path.join(dir, `${name}.dll`), Buffer.from('MZ no es un PE, pero pesa'));
  await writeFile(path.join(dir, 'presets', 'Init.fxp'), Buffer.from('preset'));
  return dir;
}

async function makeDrive(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-vmachine-drive-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function service(): VMachineService {
  // `supported: false` no se usa aquí: la instalación funciona sobre cualquier
  // carpeta, y el espacio se inyecta para no depender del disco de la máquina.
  return new VMachineService('win32', async () => '[]');
}

test('el parser acepta un disco suelto, varios y tamaños en texto', () => {
  assert.deepEqual(parseDrives(''), []);

  const uno = parseDrives(
    JSON.stringify({
      DeviceID: 'E:',
      VolumeName: 'V-MACHINE',
      FileSystem: 'FAT32',
      Size: 8004304896,
      FreeSpace: '5123481600',
      DriveType: 2,
    }),
  );
  assert.equal(uno.length, 1);
  assert.equal(uno[0]?.id, 'E:');
  assert.equal(uno[0]?.removable, true);
  assert.equal(uno[0]?.freeBytes, 5123481600);

  const dos = parseDrives(
    JSON.stringify([
      { DeviceID: 'C:', VolumeName: null, FileSystem: 'NTFS', Size: 100, FreeSpace: 10, DriveType: 3 },
      { DeviceID: 'E:', VolumeName: 'STICK', FileSystem: 'FAT32', Size: 200, FreeSpace: 20, DriveType: 2 },
      { VolumeName: 'sin letra', DriveType: 2 },
    ]),
  );
  assert.deepEqual(
    dos.map((drive) => drive.id),
    ['C:', 'E:'],
  );
  assert.equal(dos[0]?.removable, false);
  assert.equal(dos[0]?.label, '');
});

test('el nombre de la biblioteca termina en .vfxlibrary y rechaza lo que Windows no admite', () => {
  assert.equal(withLibrarySuffix('V-MACHINE'), 'V-MACHINE.vfxlibrary');
  assert.equal(withLibrarySuffix('mis sonidos.VFXLIBRARY'), 'mis sonidos.VFXLIBRARY');
  assert.equal(libraryNameProblem('V-MACHINE.vfxlibrary'), null);
  assert.notEqual(libraryNameProblem('..'), null);
  assert.notEqual(libraryNameProblem('con/barra'), null);
  assert.notEqual(libraryNameProblem('con:dos'), null);
  assert.notEqual(libraryNameProblem('termina en punto.'), null);
});

test('el paquete se copia envuelto en la biblioteca y se verifica', async (t) => {
  const pluginDir = await makePlugin(t);
  const drive = await makeDrive(t);

  const result = await service().install({ drive, pluginDir, spaceAvailable: async () => null });

  const libraryDir = path.join(drive, 'V-MACHINE.vfxlibrary');
  assert.equal(result.libraryDir, libraryDir);
  assert.equal(result.copied, 3);
  assert.equal(result.replaced, 0);
  assert.equal(result.verified, 3);
  assert.deepEqual(result.sizeOnly, []);

  // La máquina lee la biblioteca desde la raíz y el plugin dentro de `plugs\`.
  const target = path.join(libraryDir, 'plugs', PLUGIN);
  assert.equal(existsSync(path.join(target, 'vfxinfo.txt')), true);
  assert.equal(existsSync(path.join(target, `${PLUGIN}.dll`)), true);
  assert.equal(existsSync(path.join(target, 'presets', 'Init.fxp')), true);
  assert.equal(
    await readFile(path.join(target, `${PLUGIN}.dll`), 'utf8'),
    'MZ no es un PE, pero pesa',
  );

  // Regenerar el mismo plugin cuenta los archivos que pisa, no los duplica.
  const again = await service().install({ drive, pluginDir, spaceAvailable: async () => null });
  assert.equal(again.copied, 3);
  assert.equal(again.replaced, 3);
});

test('reusa la biblioteca que ya está en la raíz y respeta el nombre pedido', async (t) => {
  const pluginDir = await makePlugin(t);
  const drive = await makeDrive(t);
  await mkdir(path.join(drive, 'EN DIRECTO.vfxlibrary', 'plugs'), { recursive: true });

  const reused = await service().install({ drive, pluginDir, spaceAvailable: async () => null });
  assert.equal(path.basename(reused.libraryDir), 'EN DIRECTO.vfxlibrary');

  const requested = await service().install({
    drive,
    pluginDir,
    libraryName: 'Mis Sonidos',
    spaceAvailable: async () => null,
  });
  assert.equal(path.basename(requested.libraryDir), 'Mis Sonidos.vfxlibrary');
  assert.equal(existsSync(path.join(drive, 'Mis Sonidos.vfxlibrary', 'plugs', PLUGIN)), true);
});

test('no copia si el paquete no cabe: dice cuánto falta y no crea la biblioteca', async (t) => {
  const pluginDir = await makePlugin(t);
  const drive = await makeDrive(t);

  await assert.rejects(
    () => service().install({ drive, pluginDir, spaceAvailable: async () => 1 }),
    (error: unknown) => {
      assert.ok(error instanceof VMachineError);
      assert.equal(error.apiCode, 'notEnoughSpace');
      return true;
    },
  );
  assert.equal(existsSync(path.join(drive, 'V-MACHINE.vfxlibrary')), false);
});

test('rechaza lo que no es un plugin y la unidad que no existe', async (t) => {
  const drive = await makeDrive(t);
  const vacio = path.join(drive, 'sin-vfxinfo');
  await mkdir(vacio, { recursive: true });

  await assert.rejects(
    () => service().install({ drive, pluginDir: vacio, spaceAvailable: async () => null }),
    (error: unknown) => {
      assert.equal((error as VMachineError).apiCode, 'vfxinfoMissing');
      return true;
    },
  );

  await assert.rejects(
    () =>
      service().install({
        drive: path.join(drive, 'no-existe'),
        pluginDir: vacio,
        spaceAvailable: async () => null,
      }),
    (error: unknown) => {
      assert.equal((error as VMachineError).apiCode, 'driveNotFound');
      return true;
    },
  );
});

test('el error viaja al cliente con código y parámetros, sin sobre de Nest', async (t) => {
  const drive = await makeDrive(t);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  t.after(async () => {
    await app.close();
  });

  const missing = path.join(drive, 'plugs', 'Nada');
  const response = await request(app.getHttpServer())
    .post('/vmachine/install')
    .send({ drive, pluginDir: missing })
    .expect(404);

  assert.deepEqual(response.body, {
    message: `No existe la carpeta del plugin "${missing}".`,
    code: 'pluginFolderMissing',
    params: { 0: missing },
  });
});
