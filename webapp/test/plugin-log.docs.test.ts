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
import {
  PLUGIN_LOG_BAD_REQUEST_EXAMPLE,
  PLUGIN_LOG_EMPTY_EXAMPLE,
  PLUGIN_LOG_SNAPSHOT_EXAMPLE,
} from '../src/plugin-log/plugin-log.dto';
import { PluginLogService } from '../src/plugin-log/plugin-log.service';
import { PLUGIN_LOG_FILENAME } from '../src/plugin-log/plugin-log.types';

/**
 * Los ejemplos de Swagger no son decoración: se ejecutan contra la API real y
 * se compara la forma de la respuesta. Así, si el endpoint gana o pierde
 * campos, el ejemplo deja de coincidir y el test falla.
 */

type Snapshot = typeof PLUGIN_LOG_SNAPSHOT_EXAMPLE;

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

function keys(value: object): string[] {
  return Object.keys(value).sort();
}

function assertSameKeys(actual: object, expected: object, label: string): void {
  assert.deepEqual(keys(actual), keys(expected), `${label}: campos documentados y reales distintos`);
}

/**
 * Las invariantes que un snapshot del log cumple siempre que no haya rotados:
 * `size` es el archivo activo —el mismo texto que `raw`—, `totalEntries` cuenta
 * las entradas devueltas y cada `raw` de entrada es la línea del texto completo.
 */
function assertSnapshotInvariants(snapshot: Snapshot, label: string): void {
  assert.equal(snapshot.rotatedFiles.length, 0, `${label}: el ejemplo no describe rotados`);
  assert.equal(
    snapshot.size,
    Buffer.byteLength(snapshot.raw, 'utf8'),
    `${label}: size debe ser el tamaño de raw cuando no hay rotados`,
  );
  assert.equal(
    snapshot.totalEntries,
    snapshot.entries.length,
    `${label}: totalEntries debe contar las entradas devueltas`,
  );
  assert.ok(snapshot.logPath.endsWith(PLUGIN_LOG_FILENAME), `${label}: logPath`);

  const positions = snapshot.entries.map((entry) => {
    assert.match(
      entry.raw,
      new RegExp(`^\\[${entry.timestamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\] \\[${entry.action}\\] `),
      `${label}: raw debe empezar por timestamp y acción`,
    );
    assert.ok(entry.summary.trim() !== '', `${label}: toda entrada tiene resumen`);

    const position = snapshot.raw.indexOf(entry.raw);
    assert.ok(position >= 0, `${label}: raw completo debe contener la entrada ${entry.action}`);
    return position;
  });
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    `${label}: las entradas deben ir en el orden del texto completo`,
  );
}

async function pluginDir(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-log-docs-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('los ejemplos del log por plugin coinciden con las respuestas reales', async (t) => {
  const dir = await pluginDir(t);
  const logPath = path.join(dir, PLUGIN_LOG_FILENAME);

  // Sin log: el ejemplo vacío es el cuerpo exacto, y leer no crea el archivo.
  const empty = await http().get('/plugins/MySynth/log').query({ dir }).expect(200);
  assertSameKeys(empty.body, PLUGIN_LOG_EMPTY_EXAMPLE, 'log vacío 200');
  assert.deepEqual(empty.body, { ...PLUGIN_LOG_EMPTY_EXAMPLE, logPath });
  assert.equal(existsSync(logPath), false, 'leer el log no debe crear el archivo');

  // Una carpeta que no existe da el mismo snapshot vacío, como dice el README.
  const missing = path.join(dir, 'no-existe');
  const missingBody = await http().get('/plugins/MySynth/log').query({ dir: missing }).expect(200);
  assert.deepEqual(missingBody.body, {
    ...PLUGIN_LOG_EMPTY_EXAMPLE,
    logPath: path.join(missing, PLUGIN_LOG_FILENAME),
  });

  // Con una entrada real: mismos campos y misma acción que el ejemplo. La
  // acción se escribe literal porque es la que registra poner el cargador; así
  // el ejemplo no puede cambiar la suya sin que el test lo note.
  await logService.append(dir, 'install', 'Instalado fxbLoader.dll');
  const filled = await http().get('/plugins/MySynth/log').query({ dir }).expect(200);

  assertSameKeys(filled.body, PLUGIN_LOG_SNAPSHOT_EXAMPLE, 'log con entradas 200');
  assertSameKeys(
    filled.body.entries[0],
    PLUGIN_LOG_SNAPSHOT_EXAMPLE.entries[0]!,
    'log con entradas 200: entrada',
  );
  assert.equal(filled.body.exists, true);
  assert.equal(filled.body.entries[0].action, PLUGIN_LOG_SNAPSHOT_EXAMPLE.entries[0]!.action);
  assert.equal(filled.body.entries[0].summary, 'Instalado fxbLoader.dll');
  assert.equal(filled.body.size, Buffer.byteLength(filled.body.raw, 'utf8'));
  assert.deepEqual(filled.body.rotatedFiles, PLUGIN_LOG_SNAPSHOT_EXAMPLE.rotatedFiles);

  // El 400 del ejemplo: el cuerpo es exactamente el documentado, sin sobre.
  const badRequest = await http().get('/plugins/MySynth/log').expect(400);
  assert.deepEqual(badRequest.body, PLUGIN_LOG_BAD_REQUEST_EXAMPLE);
});

test('los ejemplos del log cumplen las invariantes que se le exigen a la API', () => {
  // Las mismas comprobaciones que se hacen contra la respuesta real, aplicadas
  // al ejemplo: si alguien cambia `size`, `totalEntries` o un `raw` a mano, el
  // ejemplo deja de ser honesto aunque siga validando contra el esquema.
  assertSnapshotInvariants(PLUGIN_LOG_SNAPSHOT_EXAMPLE, 'ejemplo con entradas');

  assert.equal(PLUGIN_LOG_EMPTY_EXAMPLE.exists, false);
  assert.equal(PLUGIN_LOG_EMPTY_EXAMPLE.size, 0);
  assert.equal(PLUGIN_LOG_EMPTY_EXAMPLE.totalEntries, 0);
  assert.deepEqual(PLUGIN_LOG_EMPTY_EXAMPLE.entries, []);
  assert.equal(PLUGIN_LOG_EMPTY_EXAMPLE.raw, '');
  assert.deepEqual(PLUGIN_LOG_EMPTY_EXAMPLE.rotatedFiles, []);
  assert.ok(PLUGIN_LOG_EMPTY_EXAMPLE.logPath.endsWith(PLUGIN_LOG_FILENAME));
});
