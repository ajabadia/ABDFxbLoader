import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureStaticAssets, resolvePublicDir } from '../src/app.setup';

let app: NestExpressApplication;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureStaticAssets(app);
  await app.init();
});

after(async () => {
  await app?.close();
});

test('sirve la UI en la raíz', async () => {
  const response = await request(app.getHttpServer())
    .get('/')
    .expect(200)
    .expect('content-type', /text\/html/);

  assert.match(response.text, /fxbLoader/);
  assert.match(response.text, /id="plugins"/);
  assert.match(response.text, /id="scan-form"/);
  assert.match(response.text, /id="banks"/);
  assert.match(response.text, /id="banks-rows"/);
  assert.match(response.text, /id="default-bank"/);
  assert.match(response.text, /id="import-paths"/);
  assert.match(response.text, /id="install-all"/);
  assert.match(response.text, /id="uninstall-all"/);
  assert.match(response.text, /id="batch-errors"/);
  assert.match(response.text, /id="batch-error-list"/);
  assert.match(response.text, /id="loader-status"/);
  assert.match(response.text, /Compatibilidad/);
  assert.match(response.text, /data-field="compatibility"/);
  assert.match(response.text, /\/batch\.js/);
  assert.match(response.text, /\/app\.js/);
});

test('sirve los assets de la UI', async () => {
  const script = await request(app.getHttpServer())
    .get('/app.js')
    .expect(200)
    .expect('content-type', /javascript/);

  // La vista de bancos usa el listado, la importación y el guardado optimista.
  assert.match(script.text, /\/library\/banks\/list/);
  assert.match(script.text, /\/library\/banks\/import/);
  assert.match(script.text, /expectedMtimeMs/);

  // El lote delega en el orquestador y cada fallo se puede reintentar.
  assert.match(script.text, /FxbBatch\.runBatch/);
  assert.match(script.text, /FxbBatch\.callWithRetry/);
  assert.match(script.text, /FxbBatch\.summarize/);

  // El escaneo valida el cargador y bloquea los plugins incompatibles.
  assert.match(script.text, /dllSourcePath/);
  assert.match(script.text, /loader\.valid/);
  assert.match(script.text, /plugin\.compatible === false/);
  assert.match(script.text, /plugin\.compatible === true/);
  assert.match(script.text, /dataset\.blocked/);

  const batch = await request(app.getHttpServer())
    .get('/batch.js')
    .expect(200)
    .expect('content-type', /javascript/);

  assert.match(batch.text, /async function runBatch/);
  assert.match(batch.text, /async function callWithRetry/);
  assert.match(batch.text, /function summarize/);

  const styles = await request(app.getHttpServer())
    .get('/styles.css')
    .expect(200)
    .expect('content-type', /text\/css/);

  assert.match(styles.text, /\.default-row/);
  assert.match(styles.text, /\.batch-errors/);
});

test('los estáticos no tapan la API', async () => {
  const response = await request(app.getHttpServer()).post('/library/scan').send({}).expect(400);

  assert.match(response.body.message, /libraryRoot/);
});

test('resolvePublicDir encuentra index.html', () => {
  const dir = resolvePublicDir();
  assert.equal(path.basename(dir), 'public');
  assert.equal(existsSync(path.join(dir, 'index.html')), true);
});
