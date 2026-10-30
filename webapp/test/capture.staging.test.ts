import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CaptureService } from '../src/capture/capture.service';

/**
 * Sin staging, `GET`, `DELETE` y `DELETE …/clean` lanzaban un `Error` genérico
 * (500). Estas pruebas fijan el contrato: el staging que no existe es un 404 con
 * el motivo, y borrar un archivo que ya no está tampoco es un 200.
 *
 * El caso de éxito se monta creando la carpeta que usa el servicio: el staging
 * cuelga de `~/.fxbloader/capture/staging` y `packageDiff` no es la única vía
 * para tener archivos ahí.
 */

async function makeApp(t: TestContext) {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  t.after(async () => {
    await app.close();
  });
  return { http: () => request(app.getHttpServer()), service: app.get(CaptureService) };
}

test('el staging inexistente devuelve 404 con el diff y cómo prepararlo', async (t) => {
  const { http } = await makeApp(t);
  const diffId = randomUUID();

  const list = await http().get(`/capture/staging/${diffId}`).expect(404);
  assert.equal(
    list.body.message,
    `No existe el staging del diff "${diffId}". Ejecuta POST /capture/package para prepararlo.`,
  );

  const remove = await http()
    .delete(`/capture/staging/${diffId}`)
    .query({ path: 'P8.dll' })
    .expect(404);
  assert.equal(remove.body.message, list.body.message);

  const clean = await http().delete(`/capture/staging/${diffId}/clean`).expect(404);
  assert.equal(clean.body.message, list.body.message);

  // El cuerpo es el mismo DTO sin sobre de Nest que el resto de la API.
  assert.equal(Object.hasOwn(list.body, 'statusCode'), false);
  assert.equal(Object.hasOwn(list.body, 'error'), false);
});

test('DELETE /capture/staging sin path es un 400, no un 500', async (t) => {
  const { http } = await makeApp(t);

  const response = await http().delete(`/capture/staging/${randomUUID()}`).expect(400);
  assert.deepEqual(response.body, { message: 'path requerido' });
});

test('una ruta que se sale del staging es un 400', async (t) => {
  const { http } = await makeApp(t);

  const response = await http()
    .delete(`/capture/staging/${randomUUID()}`)
    .query({ path: path.join('..', 'otro-diff', 'P8.dll') })
    .expect(400);
  assert.match(response.body.message, /se sale del staging/);
});

test('con staging en disco lista, borra y limpia; repetir el borrado da 404', async (t) => {
  const { http, service } = await makeApp(t);
  const diffId = randomUUID();
  const stagingPath = path.join(service.stagingRoot, diffId);
  const relative = path.join('Program Files', 'VstPlugins', 'P8.dll');
  t.after(async () => {
    await rm(stagingPath, { recursive: true, force: true });
  });

  await mkdir(path.dirname(path.join(stagingPath, relative)), { recursive: true });
  await writeFile(path.join(stagingPath, relative), Buffer.from('MZ'));
  await writeFile(path.join(stagingPath, 'manifest.json'), '{}');

  const list = await http().get(`/capture/staging/${diffId}`).expect(200);
  assert.equal(list.body.stagingDir, stagingPath);
  assert.deepEqual(list.body.files.sort(), [relative, 'manifest.json'].sort());

  await http().delete(`/capture/staging/${diffId}`).query({ path: relative }).expect(200);
  assert.deepEqual(
    (await http().get(`/capture/staging/${diffId}`).expect(200)).body.files,
    ['manifest.json'],
  );

  // El archivo ya no está: `fs.rm` con `force` lo habría dado por borrado.
  const missing = await http()
    .delete(`/capture/staging/${diffId}`)
    .query({ path: relative })
    .expect(404);
  assert.equal(
    missing.body.message,
    `No existe "${relative}" en el staging del diff "${diffId}".`,
  );

  await http().delete(`/capture/staging/${diffId}/clean`).expect(200);
  await http().get(`/capture/staging/${diffId}`).expect(404);
  await http().delete(`/capture/staging/${diffId}/clean`).expect(404);
});
