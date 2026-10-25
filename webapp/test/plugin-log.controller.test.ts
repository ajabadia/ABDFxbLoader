import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PluginLogService } from '../src/plugin-log/plugin-log.service';
import { PLUGIN_LOG_FILENAME } from '../src/plugin-log/plugin-log.types';

let app: INestApplication;
let logService: PluginLogService;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  logService = app.get(PluginLogService);
});

after(async () => {
  await app?.close();
});

function http() {
  return request(app.getHttpServer());
}

async function pluginDir(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-log-ctrl-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('GET /plugins/:id/log exige el parámetro dir', async () => {
  // El cuerpo es el que documenta `PluginLogPathErrorDto`, sin el sobre de Nest.
  const expected = { message: 'dir es obligatorio y debe ser una cadena' };

  // Ausente, vacío o solo espacios: los tres casos se rechazan igual, porque el
  // controlador exige una cadena con contenido.
  for (const query of [{}, { dir: '' }, { dir: '   ' }]) {
    const response = await http().get('/plugins/MySynth/log').query(query).expect(400);
    assert.deepEqual(response.body, expected, `dir=${JSON.stringify(query)}`);
  }
});

test('GET /plugins/:id/log devuelve exists: false si no hay archivo de log', async (t) => {
  const dir = await pluginDir(t);
  const response = await http()
    .get('/plugins/MySynth/log')
    .query({ dir })
    .expect(200);

  assert.equal(response.body.exists, false);
  assert.equal(response.body.totalEntries, 0);
  assert.deepEqual(response.body.entries, []);
  assert.equal(response.body.raw, '');
  assert.equal(response.body.size, 0);
  assert.deepEqual(response.body.rotatedFiles, []);

  // El snapshot vacío dice de qué archivo se trata y leerlo no lo crea: un
  // plugin que nunca escribió no estrena log solo por consultarlo.
  assert.equal(response.body.logPath, path.join(dir, PLUGIN_LOG_FILENAME));
  assert.equal(existsSync(response.body.logPath), false);
});

test('GET /plugins/:id/log devuelve las entradas y el snapshot del log', async (t) => {
  const dir = await pluginDir(t);
  await logService.append(dir, 'install', 'Instalación de prueba', 'Synth.dll');

  const response = await http()
    .get('/plugins/MySynth/log')
    .query({ dir })
    .expect(200);

  assert.equal(response.body.exists, true);
  assert.equal(response.body.totalEntries, 1);
  assert.equal(response.body.entries[0]?.action, 'install');
  assert.equal(response.body.entries[0]?.summary, 'Instalación de prueba');
  assert.equal(response.body.entries[0]?.detail, 'Synth.dll');
  assert.match(response.body.raw, /\[install\] Instalación de prueba/);
});
