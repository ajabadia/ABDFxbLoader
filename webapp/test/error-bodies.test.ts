import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PickerService } from '../src/system/picker.service';
import { PickerUnsupportedError } from '../src/system/picker.types';
import { pe32Dll } from './helpers/pe';

/**
 * Los DTO de error documentan el cuerpo sin el sobre de Nest. Los tests de cada
 * endpoint comprueban su caso, pero ninguno recorre la API entera: este pide
 * todos los códigos de error documentados y verifica el formato de una vez.
 */

interface Captured {
  label: string;
  status: number;
  body: Record<string, unknown>;
}

async function makeLibrary(
  t: TestContext,
): Promise<{ root: string; configPluginDir: string; dll: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-errors-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Plugin completo: `vfxinfo.txt` con `dll_name` y su DLL declarado. */
  const plugin = async (name: string, vfxinfo: string): Promise<string> => {
    const dir = path.join(root, 'plugs', name);
    await mkdir(path.join(dir, name), { recursive: true });
    await writeFile(path.join(dir, 'vfxinfo.txt'), Buffer.from(vfxinfo, 'latin1'));
    await writeFile(path.join(dir, name, `${name}.dll`), pe32Dll());
    return dir;
  };

  const full = (name: string): string =>
    `name: ${name}\r\ndll_name: ${name}/${name}.dll\r\n`;

  await plugin('Synth', full('Synth'));
  // Este no recibe el cargador: su `fxbLoader.config` se crea en la prueba.
  const configPluginDir = await plugin('Config', full('Config'));
  // Sin `dll_name`: el cargador no se puede poner (422).
  await plugin('SinDll', 'name: SinDll\r\n');

  const dll = path.join(root, 'fxbLoader.dll');
  await writeFile(dll, pe32Dll());
  return { root, configPluginDir, dll };
}

test('ningún cuerpo de error de la API lleva el sobre de Nest', async (t) => {
  const lib = await makeLibrary(t);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  t.after(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const captured: Captured[] = [];
  const record = (label: string, response: { status: number; body: unknown }): void => {
    captured.push({ label, status: response.status, body: response.body as Record<string, unknown> });
  };

  // 400: parámetros y cuerpos rechazados antes de tocar el disco.
  record('log sin dir', await http().get('/plugins/MySynth/log').expect(400));
  record('meta sin dir', await http().get('/plugins/MySynth/meta').expect(400));
  record('meta con cuerpo vacío', await http().post('/plugins/MySynth/meta').send({}).expect(400));
  record('config sin cuerpo', await http().put('/fxb-config').send({}).expect(400));
  record('scan con ruta relativa', await http().post('/library/scan').send({ libraryRoot: 'plugs' }).expect(400));
  record(
    'inspect con ruta relativa',
    await http().post('/library/banks/inspect').send({ sourcePath: 'Rhodes.fxb' }).expect(400),
  );
  record(
    'paths con ruta relativa',
    await http().post('/system/paths').send({ paths: ['plugs'] }).expect(400),
  );
  // Se valida antes de abrir el diálogo nativo, así que no se abre nada.
  record(
    'pick con kind desconocido',
    await http().post('/system/pick').send({ kind: 'no-existe' }).expect(400),
  );

  // 404: el plugin no está en la librería.
  record(
    'loader/add con plugin inexistente',
    await http()
      .post('/library/loader/add')
      .send({ libraryRoot: lib.root, plugin: 'NoExiste', dllSourcePath: lib.dll })
      .expect(404),
  );
  record(
    'banks/list con plugin inexistente',
    await http().post('/library/banks/list').send({ libraryRoot: lib.root, plugin: 'NoExiste' }).expect(404),
  );
  record(
    'inspect-dll con DLL inexistente',
    await http()
      .post('/library/inspect-dll')
      .send({ dllPath: path.join(lib.root, 'no-existe.dll') })
      .expect(404),
  );
  record(
    'create-custom-plugin con DLL origen inexistente',
    await http()
      .post('/library/create-custom-plugin')
      .send({
        libraryRoot: lib.root,
        sourceDllPath: path.join(lib.root, 'no-existe.dll'),
        folderName: 'Fantasma',
        name: 'Fantasma',
        id: 'Fant',
      })
      .expect(404),
  );

  // 409: el cargador ya está puesto y la configuración cambió desde la lectura.
  await http()
    .post('/library/loader/add')
    .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dll })
    .expect(200);
  record(
    'loader/add repetido sin force',
    await http()
      .post('/library/loader/add')
      .send({ libraryRoot: lib.root, plugin: 'Synth', dllSourcePath: lib.dll })
      .expect(409),
  );

  record(
    'create-custom-plugin con carpeta existente',
    await http()
      .post('/library/create-custom-plugin')
      .send({
        libraryRoot: lib.root,
        sourceDllPath: lib.dll,
        folderName: 'Synth',
        name: 'Synth',
        id: 'Sy01',
      })
      .expect(409),
  );

  const configBody = {
    pluginDir: lib.configPluginDir,
    expectedMtimeMs: null,
    config: { pluginName: 'Config.dll' },
  };
  await http().put('/fxb-config').send(configBody).expect(200);
  record('config con mtime obsoleto', await http().put('/fxb-config').send(configBody).expect(409));

  // 422: el plugin no declara qué DLL carga.
  record(
    'loader/add sin dll_name',
    await http()
      .post('/library/loader/add')
      .send({ libraryRoot: lib.root, plugin: 'SinDll', dllSourcePath: lib.dll })
      .expect(422),
  );

  // 501: el diálogo nativo solo existe en Windows. Se sustituye el servicio para
  // provocar el error sin abrir ninguna ventana.
  const pickerModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PickerService)
    .useValue({
      pick: async (): Promise<never> => {
        throw new PickerUnsupportedError();
      },
    })
    .compile();
  const pickerApp: INestApplication = pickerModule.createNestApplication();
  await pickerApp.init();
  t.after(async () => {
    await pickerApp.close();
  });
  record(
    'pick fuera de Windows',
    await request(pickerApp.getHttpServer()).post('/system/pick').send({ kind: 'folder' }).expect(501),
  );

  // Sin este mínimo, quitar casos dejaría la prueba en verde sin recorrer nada.
  const codes = [...new Set(captured.map((item) => item.status))].sort((a, b) => a - b);
  assert.deepEqual(codes, [400, 404, 409, 422, 501], 'faltan códigos de error por recorrer');

  for (const { label, status, body } of captured) {
    assert.equal(typeof body, 'object', `${label} (${status}): el cuerpo no es un objeto JSON`);
    assert.equal(Object.hasOwn(body, 'statusCode'), false, `${label} (${status}) trae statusCode`);
    assert.equal(Object.hasOwn(body, 'error'), false, `${label} (${status}) trae error`);
    assert.equal(typeof body['message'], 'string', `${label} (${status}) debe traer message`);
    assert.notEqual((body['message'] as string).trim(), '', `${label} (${status}) con message vacío`);
  }
});
