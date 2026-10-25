import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  AssociationAuditService,
} from '../src/association-audit/association-audit.service';
import { ASSOCIATION_AUDIT_FILENAME } from '../src/association-audit/association-audit.types';

let app: INestApplication;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

after(async () => {
  await app?.close();
});

function makeDir(t: TestContext): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'fxb-audit-')).then((root) => {
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    return root;
  });
}

function getAuditPath(root: string): string {
  return path.join(root, ASSOCIATION_AUDIT_FILENAME);
}

test('append crea el almacén con apéndice puro y fsync sin seq', async (t) => {
  const root = await makeDir(t);
  const service = app.get(AssociationAuditService);

  assert.equal(
    await service.append(root, {
      kind: 'association-change',
      plugin: 'Synth',
      libraryRoot: root,
      field: 'dll_name',
      previousValue: 'Synth/Synth.dll',
      newValue: 'Synth/fxbLoader.dll',
    }),
    true,
  );

  const snapshot = await service.read(root);
  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.entries[0]!.kind, 'association-change');
  assert.equal(snapshot.entries[0]!.plugin, 'Synth');
  assert.equal(snapshot.entries[0]!.previousValue, 'Synth/Synth.dll');
  assert.equal(snapshot.entries[0]!.newValue, 'Synth/fxbLoader.dll');

  const raw = await readFile(getAuditPath(root), 'utf8');
  assert.ok(raw.endsWith('\n'), 'cada línea termina con \\n');
  const lines = raw.split('\n').slice(0, -1);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.ok(parsed['ts'], 'cada línea lleva su marca de tiempo');
});

test('los appends se apilan por librería cruzando plugins', async (t) => {
  const root = await makeDir(t);
  const service = app.get(AssociationAuditService);

  await service.append(root, {
    kind: 'association-change',
    plugin: 'A',
    libraryRoot: root,
    field: 'dll_name',
    previousValue: null,
    newValue: 'A/x.dll',
  });
  await service.append(root, {
    kind: 'association-change',
    plugin: 'B',
    libraryRoot: root,
    field: 'dll_name',
    previousValue: 'B/y.dll',
    newValue: null,
  });

  const snapshot = await service.read(root);
  assert.equal(snapshot.total, 2);
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.plugin),
    ['A', 'B'],
  );
});

test('filtros por plugin, kind y rango temporal con límite', async (t) => {
  const root = await makeDir(t);
  const service = app.get(AssociationAuditService);

  await service.append(root, {
    kind: 'association-change',
    plugin: 'A',
    libraryRoot: root,
    field: 'dll_name',
    previousValue: null,
    newValue: 'A/x.dll',
  });
  await service.append(root, {
    kind: 'collision',
    plugin: 'A',
    libraryRoot: root,
    packageSource: 'pack',
    collisionPolicy: 'skip',
    collisionNames: ['A'],
  });
  await service.append(root, {
    kind: 'association-change',
    plugin: 'B',
    libraryRoot: root,
    field: 'dll_name',
    previousValue: null,
    newValue: 'B/y.dll',
  });

  const onlyA = await service.read(root, { plugin: 'A' });
  assert.equal(onlyA.total, 2);
  assert.ok(onlyA.entries.every((entry) => entry.plugin === 'A'));

  const onlyChange = await service.read(root, { kind: 'association-change' });
  assert.equal(onlyChange.total, 2);

  const onlyCollisions = await service.read(root, {
    plugin: 'A',
    kind: 'collision',
  });
  assert.equal(onlyCollisions.total, 1);
  assert.equal(onlyCollisions.entries[0]!.collisionPolicy, 'skip');
  assert.deepEqual(onlyCollisions.entries[0]!.collisionNames, ['A']);

  const limited = await service.read(root, {
    kind: 'association-change',
    limit: 1,
  });
  assert.equal(limited.total, 2, 'el total cuenta antes del límite');
  assert.deepEqual(
    limited.entries.map((entry) => entry.plugin),
    ['B'],
    'el límite recorta los más antiguos',
  );
});

test('tombstone de desinstalación: newValue null se conserva', async (t) => {
  const root = await makeDir(t);
  const service = app.get(AssociationAuditService);

  await service.append(root, {
    kind: 'association-change',
    plugin: 'Synth',
    libraryRoot: root,
    field: 'dll_name',
    previousValue: 'fxbLoader.dll',
    newValue: null,
  });

  const snapshot = await service.read(root);
  assert.equal(snapshot.entries[0]!.newValue, null);
  const raw = await readFile(getAuditPath(root), 'utf8');
  assert.ok(raw.includes('"newValue":null'));
});

test('línea corrupta: la lectura la salta y sigue', async (t) => {
  const root = await makeDir(t);
  const service = app.get(AssociationAuditService);

  await service.append(root, {
    kind: 'association-change',
    plugin: 'A',
    libraryRoot: root,
    field: 'dll_name',
    previousValue: null,
    newValue: 'A/x.dll',
  });
  await writeFile(
    getAuditPath(root),
    'no-es-json\n{\"ts\": 123}\n{\n',
    { flag: 'a' },
  );
  await service.append(root, {
    kind: 'association-change',
    plugin: 'B',
    libraryRoot: root,
    field: 'dll_name',
    previousValue: null,
    newValue: 'B/y.dll',
  });

  const snapshot = await service.read(root);
  assert.equal(snapshot.total, 2, 'las líneas corruptas e incompletas se saltan');
});

test('una librería sin almacén responde exists: false y listas vacías', async (t) => {
  const root = await makeDir(t);
  const service = app.get(AssociationAuditService);

  const snapshot = await service.read(root);
  assert.equal(snapshot.exists, false);
  assert.equal(snapshot.total, 0);
  assert.deepEqual(snapshot.entries, []);
});

test('POST /library/association-audit/list: 200 sin almacén, 200 con eventos y 400 con libraryRoot malo', async (t) => {
  const root = await makeDir(t);
  const service = app.get(AssociationAuditService);
  await service.append(root, {
    kind: 'association-change',
    plugin: 'Synth',
    libraryRoot: root,
    field: 'dll_name',
    previousValue: 'a.dll',
    newValue: 'b.dll',
  });

  const base = '/library/association-audit';

  const empty = await request(app.getHttpServer())
    .post(`${base}/list`)
    .send({ libraryRoot: path.join(tmpdir(), 'fxb-audit-nonexistent-root') });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.exists, false);
  assert.deepEqual(empty.body.entries, []);

  const ok = await request(app.getHttpServer())
    .post(`${base}/list`)
    .send({ libraryRoot: root, kind: 'association-change' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.total, 1);
  assert.equal(ok.body.entries[0]!.kind, 'association-change');

  const missing = await request(app.getHttpServer()).post(`${base}/list`).send({});
  assert.equal(missing.status, 400);

  const relative = await request(app.getHttpServer()).post(`${base}/list`).send({ libraryRoot: 'rel/ativa' });
  assert.equal(relative.status, 400);

  const badKind = await request(app.getHttpServer())
    .post(`${base}/list`)
    .send({ libraryRoot: root, kind: 'otro' });
  assert.equal(badKind.status, 400);
});

test('GET /library/association-audit/stream lee lo mismo con query', async (t) => {
  const root = await makeDir(t);
  const service = app.get(AssociationAuditService);
  await service.append(root, {
    kind: 'import',
    libraryRoot: root,
    packageSource: 'C:/downloads/pack.vfxlibrary',
    repairedBanks: [],
  });

  const res = await request(app.getHttpServer()).get('/library/association-audit/stream').query({
    libraryRoot: root,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.entries[0]!.packageSource, 'C:/downloads/pack.vfxlibrary');
});
