import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { parseVfxinfoFields } from '../src/vmachine/inventory';
import { VMachineService } from '../src/vmachine/vmachine.service';
import { VMachineError } from '../src/vmachine/vmachine.types';

/**
 * Inventario del medio de la v-machine.
 *
 * Lo que fija esta suite es que se lee lo que hay —carpetas `plugs\<Plugin>\`
 * con su `vfxinfo.txt` en latin1— sin escribir nada, y que cada plugin se
 * compara con el catálogo para saber si la versión del medio es la misma, otra
 * o si el catálogo ni siquiera lo conoce.
 */

const CATALOG: Record<string, { id: string; name: string; version: string }> = {
  '1316377392': { id: '1316377392', name: 'SuperWave P8', version: '1.2' },
  viejo: { id: '555', name: 'Viejo', version: '1.1' },
};

/** Catálogo de mentira: por id y, si no, por nombre exacto en minúsculas. */
function lookup(query: { id?: string; name?: string; dllName?: string }) {
  if (query.id !== undefined && CATALOG[query.id] !== undefined) return CATALOG[query.id]!;
  const name = (query.name ?? '').toLowerCase();
  return CATALOG[name] ?? null;
}

async function makeStick(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-vmachine-stick-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function service(): VMachineService {
  return new VMachineService('win32', async () => '[]', lookup);
}

test('el vfxinfo se lee en latin1 y sin las listas de archivos', () => {
  const fields = parseVfxinfoFields(
    'id: 42\r\nname: Órgano «P8»\r\nversion: 1.2\r\nfiles_to_copy:\r\nC:\\muestras\r\n...\r\nvendor_url: http://x:8080\r\n',
  );

  assert.equal(fields.get('name'), 'Órgano «P8»');
  assert.equal(fields.get('id'), '42');
  assert.equal(fields.get('version'), '1.2');
  assert.equal(fields.get('dll_name'), undefined);
  // Solo el primer `:` separa la clave: las URL conservan los suyos.
  assert.equal(fields.get('vendor_url'), 'http://x:8080');
});

test('el inventario recorre las bibliotecas y compara cada plugin con el catálogo', async (t) => {
  const stick = await makeStick(t);
  const plugs = path.join(stick, 'V-MACHINE.vfxlibrary', 'plugs');

  const p8 = path.join(plugs, 'P8');
  await mkdir(path.join(p8, 'presets'), { recursive: true });
  const p8Vfxinfo = Buffer.from(
    'id: 1316377392\r\nname: SuperWave P8\r\nversion: 1.2\r\ndll_name: P8/P8.dll\r\n',
    'latin1',
  );
  await writeFile(path.join(p8, 'vfxinfo.txt'), p8Vfxinfo);
  await writeFile(path.join(p8, 'P8.dll'), Buffer.from('dll'));
  await writeFile(path.join(p8, 'presets', 'Init.fxp'), Buffer.from('preset'));

  const old = path.join(plugs, 'Viejo');
  await mkdir(old, { recursive: true });
  await writeFile(path.join(old, 'vfxinfo.txt'), Buffer.from('name: Viejo\r\nversion: 1.0\r\n', 'latin1'));

  const raro = path.join(plugs, 'Raro');
  await mkdir(raro, { recursive: true });
  await writeFile(path.join(raro, 'datos.bin'), Buffer.from('x'));

  const inventory = await service().inventory(stick);

  assert.equal(inventory.plugins, 3);
  assert.equal(inventory.libraries.length, 1);
  assert.equal(inventory.warnings.length, 0);

  const plugins = inventory.libraries[0]!.plugins;
  assert.deepEqual(
    plugins.map((plugin) => plugin.folder),
    ['P8', 'Raro', 'Viejo'],
  );

  const [first, second, third] = plugins;
  assert.equal(first!.status, 'match');
  assert.equal(first!.catalog?.name, 'SuperWave P8');
  assert.equal(first!.files, 3);
  assert.equal(first!.bytes, p8Vfxinfo.length + 3 + 6);
  assert.equal(first!.dll, 'P8/P8.dll');

  // Sin vfxinfo no hay nada que comparar, pero el plugin se lista igual.
  assert.equal(second!.hasVfxinfo, false);
  assert.equal(second!.status, 'unknown');
  assert.equal(second!.catalog, null);
  assert.equal(second!.files, 1);

  // El catálogo conoce el plugin por nombre, pero con otra versión.
  assert.equal(third!.status, 'differs');
  assert.equal(third!.catalog?.version, '1.1');
  assert.equal(third!.version, '1.0');
});

test('una unidad sin bibliotecas avisa y no falla', async (t) => {
  const stick = await makeStick(t);
  const inventory = await service().inventory(stick);

  assert.equal(inventory.plugins, 0);
  assert.deepEqual(inventory.libraries, []);
  assert.equal(inventory.warnings.length, 1);
});

test('la unidad que no existe responde con su código', async (t) => {
  const stick = await makeStick(t);

  await assert.rejects(
    () => service().inventory(path.join(stick, 'no-existe')),
    (error: unknown) => {
      assert.ok(error instanceof VMachineError);
      assert.equal(error.apiCode, 'driveNotFound');
      return true;
    },
  );
});

test('el endpoint pide la unidad, lee el inventario y devuelve los errores con código', async (t) => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  t.after(async () => {
    await app.close();
  });

  const missing = await request(app.getHttpServer()).get('/vmachine/inventory').expect(400);
  assert.deepEqual(missing.body, { message: 'drive requerido' });

  const stick = await makeStick(t);
  await mkdir(path.join(stick, 'EN DIRECTO.vfxlibrary', 'plugs'), { recursive: true });

  const ok = await request(app.getHttpServer())
    .get(`/vmachine/inventory?drive=${encodeURIComponent(stick)}`)
    .expect(200);
  assert.equal(ok.body.plugins, 0);
  assert.equal(ok.body.libraries.length, 1);

  const gone = await request(app.getHttpServer())
    .get(`/vmachine/inventory?drive=${encodeURIComponent(path.join(stick, 'no-existe'))}`)
    .expect(404);
  assert.equal(gone.body.code, 'driveNotFound');
});
