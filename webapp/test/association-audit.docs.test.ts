import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  ASSOCIATION_AUDIT_BAD_REQUEST_EXAMPLE,
  ASSOCIATION_AUDIT_EMPTY_EXAMPLE,
  ASSOCIATION_AUDIT_LIST_EXAMPLE,
} from '../src/association-audit/association-audit.dto';
import { ASSOCIATION_AUDIT_FILENAME } from '../src/association-audit/association-audit.types';
import { pe32Dll } from './helpers/pe';

/**
 * Los ejemplos de la auditoría tampoco son decoración: se ejecutan contra la API
 * real y se compara la forma de la respuesta, tanto con el almacén vacío como
 * con eventos reales escritos por las operaciones de la librería.
 */

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

function keys(value: object): string[] {
  return Object.keys(value).sort();
}

function assertSameKeys(actual: object, expected: object, label: string): void {
  assert.deepEqual(keys(actual), keys(expected), `${label}: campos documentados y reales distintos`);
}

async function library(t: TestContext): Promise<{ root: string; dll: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-audit-docs-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pluginDir = path.join(root, 'plugs', 'Synth');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, 'vfxinfo.txt'),
    Buffer.from('name: Synth\r\ndll_name: Synth/Synth.dll\r\n', 'latin1'),
  );
  await mkdir(path.join(pluginDir, 'Synth'), { recursive: true });
  await writeFile(path.join(pluginDir, 'Synth', 'Synth.dll'), pe32Dll());

  const dll = path.join(root, 'loader.dll');
  await writeFile(dll, pe32Dll());
  return { root, dll };
}

async function auditPath(root: string): Promise<string> {
  return path.join(root, ASSOCIATION_AUDIT_FILENAME);
}

test('el ejemplo de auditoría vacía coincide con la respuesta real y no crea el almacén', async (t) => {
  const { root } = await library(t);

  const res = await http()
    .post('/library/association-audit/list')
    .send({ libraryRoot: root })
    .expect(200);

  assertSameKeys(res.body, ASSOCIATION_AUDIT_EMPTY_EXAMPLE, 'auditoría vacía 200');
  assert.equal(res.body.exists, false);
  assert.equal(res.body.size, 0);
  assert.equal(res.body.total, 0);
  assert.equal(res.body.auditPath, await auditPath(root));
  assert.deepEqual(res.body.entries, []);

  await assert.rejects(stat(await auditPath(root)), { code: 'ENOENT' });
});

test('los eventos reales del alta y de la preferencia coinciden con el ejemplo documentado', async (t) => {
  const { root, dll } = await library(t);

  await http()
    .post('/library/loader/add')
    .send({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dll })
    .expect(200);
  // Segundo evento real: devolver la preferencia a la DLL original del plugin.
  await http()
    .post('/library/plugin-dll-preference')
    .send({ pluginDir: path.join(root, 'plugs', 'Synth'), dllName: 'Synth/Synth.dll' })
    .expect(200);

  const res = await http()
    .post('/library/association-audit/list')
    .send({ libraryRoot: root })
    .expect(200);

  assertSameKeys(res.body, ASSOCIATION_AUDIT_LIST_EXAMPLE, 'auditoría con eventos 200');
  assert.equal(res.body.exists, true);
  assert.equal(res.body.total, 2, 'dos operaciones reales dejan dos eventos');
  assert.equal(res.body.entries.length, 2);
  for (const entry of res.body.entries) {
    assertSameKeys(entry, ASSOCIATION_AUDIT_LIST_EXAMPLE.entries[0]!, 'auditoría: entrada');
    assert.equal(entry.kind, 'association-change');
    assert.equal(entry.plugin, 'Synth');
    assert.equal(entry.field, 'dll_name');
    assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(path.resolve(entry.libraryRoot), path.resolve(root));
  }

  const [first, second] = res.body.entries as {
    previousValue: string | null;
    newValue: string | null;
  }[];
  assert.equal(first!.previousValue, 'Synth/Synth.dll');
  assert.equal(first!.newValue, 'Synth/fxbLoader.dll');
  assert.equal(second!.previousValue, 'Synth/fxbLoader.dll');
  assert.equal(second!.newValue, 'Synth/Synth.dll');

  const size = (await stat(await auditPath(root))).size;
  assert.equal(res.body.size, size, 'size es el tamaño real del almacén');
});

test('filtros y límite de la auditoría se aplican sobre eventos reales', async (t) => {
  const { root, dll } = await library(t);

  await http()
    .post('/library/loader/add')
    .send({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dll })
    .expect(200);
  await http()
    .post('/library/plugin-dll-preference')
    .send({ pluginDir: path.join(root, 'plugs', 'Synth'), dllName: 'Synth/Synth.dll' })
    .expect(200);

  const byPlugin = await http()
    .post('/library/association-audit/list')
    .send({ libraryRoot: root, plugin: 'Synth' })
    .expect(200);
  assert.equal(byPlugin.body.total, 2);

  const none = await http()
    .post('/library/association-audit/list')
    .send({ libraryRoot: root, kind: 'collision' })
    .expect(200);
  assert.equal(none.body.total, 0);
  assert.deepEqual(none.body.entries, []);

  const limited = await http()
    .post('/library/association-audit/list')
    .send({ libraryRoot: root, limit: 1 })
    .expect(200);
  assert.equal(limited.body.total, 2, 'total cuenta antes del límite');
  assert.equal(limited.body.entries.length, 1);
  assert.equal(limited.body.entries[0].newValue, 'Synth/Synth.dll', 'el límite deja el más reciente');

  const stream = await http()
    .get('/library/association-audit/stream')
    .query({ libraryRoot: root, plugin: 'Synth' })
    .expect(200);
  assertSameKeys(stream.body, byPlugin.body, 'stream 200: mismo snapshot');
  assert.deepEqual(stream.body.entries, byPlugin.body.entries);
});

test('el 400 del listado responde el cuerpo exacto que documenta el ejemplo', async (t) => {
  const { root } = await library(t);

  const missing = await http().post('/library/association-audit/list').send({}).expect(400);
  assert.deepEqual(missing.body, { message: 'libraryRoot es obligatorio y debe ser una cadena' });

  const relative = await http()
    .post('/library/association-audit/list')
    .send({ libraryRoot: 'rel/ativa' })
    .expect(400);
  assertSameKeys(relative.body, ASSOCIATION_AUDIT_BAD_REQUEST_EXAMPLE, 'auditoría 400');
  assert.deepEqual(relative.body, ASSOCIATION_AUDIT_BAD_REQUEST_EXAMPLE);

  const badKind = await http()
    .post('/library/association-audit/list')
    .send({ libraryRoot: root, kind: 'otro' })
    .expect(400);
  assert.match(badKind.body.message, /^kind no válido/);

  const badLimit = await http()
    .post('/library/association-audit/list')
    .send({ libraryRoot: root, limit: 0 })
    .expect(400);
  assert.equal(badLimit.body.message, 'limit debe ser un entero positivo');
});
