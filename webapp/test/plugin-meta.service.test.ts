import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { PluginMetaService } from '../src/plugin-meta/plugin-meta.service';
import {
  PluginMetaConflictError,
  PluginMetaInvalidError,
  PluginMetaPathError,
} from '../src/plugin-meta/plugin-meta.types';
import type { PluginMetaSnapshot } from '../src/plugin-meta/plugin-meta.types';

const service = new PluginMetaService();

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'plugin-meta-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function metaPath(dir: string): string {
  return path.join(dir, 'fxbLoader.meta.json');
}

test('lee un plugin sin meta como no existente', async (t) => {
  const dir = await tempDir(t);

  const snapshot = await service.read(dir);

  assert.equal(snapshot.exists, false);
  assert.equal(snapshot.mtimeMs, null);
  assert.equal(snapshot.size, 0);
  assert.equal(snapshot.metaPath, metaPath(dir));
  assert.deepEqual(snapshot.common, {
    id: '',
    name: '',
    vendor: '',
    vendor_url: '',
    genre: '',
    name_abbreviation: '',
    notes: '',
    created: '',
  });
  assert.deepEqual(snapshot.extended, {});
  assert.ok(snapshot.source === null);
  assert.ok(snapshot.updated === null);
  await assert.rejects(
    async () => readFile(metaPath(dir), 'utf8'),
    { code: 'ENOENT' },
    'no se creó el archivo',
  );
});

test('no lee un meta existente sin extended pero admite un meta existente con extended', async (t) => {
  const dir = await tempDir(t);
  await writeFile(
    metaPath(dir),
    JSON.stringify({
      common: {
        id: '1398231096',
        name: 'SuperWave P8',
        vendor: 'VMachine Labs',
      },
      extended: { rating: 4 },
      updated: '2026-10-22T10:00:00Z',
      source: { vfxinfo: true },
    }),
    'utf8',
  );

  const snapshot = await service.read(dir);

  assert.equal(snapshot.exists, true);
  assert.ok(snapshot.mtimeMs !== null);
  assert.ok(snapshot.size > 0);
  assert.equal(snapshot.metaPath, metaPath(dir));
  assert.equal(snapshot.common.id, '1398231096');
  assert.equal(snapshot.common.name, 'SuperWave P8');
  assert.equal(snapshot.common.vendor, 'VMachine Labs');
  assert.equal(snapshot.common.vendor_url, '');
  assert.equal(snapshot.common.genre, '');
  assert.equal(snapshot.common.name_abbreviation, '');
  assert.equal(snapshot.common.notes, '');
  assert.equal(snapshot.common.created, '');
  assert.deepEqual(snapshot.extended, { rating: 4 });
  assert.equal(snapshot.source?.vfxinfo, true);
  assert.equal(snapshot.updated, '2026-10-22T10:00:00Z');
});

test('rechaza un meta truncado con campos faltantes', async (t) => {
  const dir = await tempDir(t);
  await writeFile(metaPath(dir), JSON.stringify({ common: { id: '42' } }), 'utf8');

  await assert.rejects(
    service.read(dir),
    (error: unknown) => {
      assert.ok(error instanceof PluginMetaInvalidError);
      return true;
    },
  );
});

test('escribe un meta nuevo de forma atómica', async (t) => {
  const dir = await tempDir(t);

  const snapshot = await service.write({
    pluginDir: dir,
    expectedMtimeMs: null,
    common: { id: '1398231096', name: 'SuperWave P8', vendor: 'VMachine Labs' },
    extended: { notes: 'Prueba' },
  });

  assert.equal(snapshot.exists, true);
  assert.ok(snapshot.mtimeMs !== null);
  assert.ok(snapshot.size > 0);
  assert.equal(snapshot.common.id, '1398231096');
  assert.equal(snapshot.common.name, 'SuperWave P8');
  assert.ok(snapshot.updated !== null);
  assert.ok(snapshot.source !== null);
  assert.equal(snapshot.source?.vfxinfo, false);

  const text = await readFile(metaPath(dir), 'utf8');
  const obj = JSON.parse(text);
  // Los campos propios de la app se añaden en la escritura; no se permiten
  // en la entrada del cliente.
  assert.equal(obj.common.id, '1398231096');
  assert.equal(obj.common.name, 'SuperWave P8');
  assert.equal(obj.common.vendor, 'VMachine Labs');
  assert.equal(obj.common.vendor_url, '');
  assert.equal(obj.common.genre, '');
  assert.equal(obj.common.name_abbreviation, '');
  assert.equal(obj.common.notes, 'Prueba');
  assert.equal(obj.common.created, '');
  assert.deepEqual(obj.extended, { notes: 'Prueba' });
  assert.ok(typeof obj.updated === 'string');
  assert.deepEqual(obj.source, { vfxinfo: false });
});

test('un mtime obsoleto produce conflicto y no toca el archivo', async (t) => {
  const dir = await tempDir(t);
  const first = await service.write({
    pluginDir: dir,
    expectedMtimeMs: null,
    common: { id: '1' },
    extended: {},
  });
  assert.ok(first.mtimeMs !== null);
  const before = await readFile(metaPath(dir), 'utf8');

  await assert.rejects(
    service.write({
      pluginDir: dir,
      expectedMtimeMs: first.mtimeMs - 1000,
      common: { id: '2' },
      extended: {},
    }),
    PluginMetaConflictError,
  );

  assert.deepEqual(await readFile(metaPath(dir), 'utf8'), before);
});

test('expectedMtimeMs null con archivo existente es conflicto', async (t) => {
  const dir = await tempDir(t);
  await service.write({
    pluginDir: dir,
    expectedMtimeMs: null,
    common: { id: '1' },
    extended: {},
  });

  await assert.rejects(
    service.write({
      pluginDir: dir,
      expectedMtimeMs: null,
      common: { id: '2' },
      extended: {},
    }),
    PluginMetaConflictError,
  );
});

test('detecta un cambio externo en disco', async (t) => {
  const dir = await tempDir(t);
  const first = await service.write({
    pluginDir: dir,
    expectedMtimeMs: null,
    common: { id: '1' },
    extended: {},
  });
  assert.ok(first.mtimeMs !== null);

  const before = await readFile(metaPath(dir), 'utf8');
  await writeFile(metaPath(dir), JSON.stringify({ common: { id: 'x' } }), 'utf8');

  await assert.rejects(
    service.write({
      pluginDir: dir,
      expectedMtimeMs: first.mtimeMs,
      common: { id: '2' },
      extended: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof PluginMetaConflictError);
      assert.notStrictEqual(error.current.mtimeMs, first.mtimeMs, 'el conflicto debe reflejar el estado actual del archivo');
      return true;
    },
  );
});

test('la fusión conserva la entrada no incluida en la actualización', async (t) => {
  const dir = await tempDir(t);
  const first = await service.write({
    pluginDir: dir,
    expectedMtimeMs: null,
    common: { id: '1398231096', name: 'SuperWave P8', vendor: 'VMachine Labs' },
    extended: { rating: 4 },
  });
  assert.ok(first.mtimeMs !== null);

  const second = await service.write({
    pluginDir: dir,
    expectedMtimeMs: first.mtimeMs,
    common: { id: '1398231096', name: 'SuperWave P8', vendor: 'VMachine Labs' },
    extended: { notes: 'Editada' },
  });

  assert.equal(second.common.id, '1398231096');
  assert.equal(second.common.name, 'SuperWave P8');
  assert.equal(second.common.vendor, 'VMachine Labs');
  assert.equal(second.extended.notes, 'Editada');
  assert.equal(second.extended.rating, 4, 'el rating anterior se conserva en la fusión de extended');
});

test('rechaza un id vacío en la entrada del cliente', async (t) => {
  const dir = await tempDir(t);

  const write = service.write({
    pluginDir: dir,
    expectedMtimeMs: null,
    common: { id: '' },
    extended: {},
  });
  await assert.rejects(
    write,
    PluginMetaInvalidError,
  );
  await assert.rejects(async () => readFile(metaPath(dir), 'utf8'), { code: 'ENOENT' });
});

test('rechaza un nombre vacío en la entrada del cliente', async (t) => {
  const dir = await tempDir(t);

  const write = service.write({
    pluginDir: dir,
    expectedMtimeMs: null,
    common: { id: '1', name: '' },
    extended: {},
  });
  await assert.rejects(
    write,
    PluginMetaInvalidError,
  );
});

test('rechaza extended con una clave con forma inválida', async (t) => {
  const dir = await tempDir(t);

  await assert.rejects(
    service.write({
      pluginDir: dir,
      expectedMtimeMs: null,
      common: { id: '1', name: 'X' },
      extended: { '0bad': 'x' },
    }),
    PluginMetaInvalidError,
  );
});

test('rechaza un archivo propio corrupto', async (t) => {
  const dir = await tempDir(t);
  await writeFile(metaPath(dir), 'no es json', 'utf8');

  await assert.rejects(
    service.read(dir),
    (error: unknown) => {
      assert.ok(error instanceof PluginMetaInvalidError, 'el error debe ser PluginMetaInvalidError');
      assert.ok('issues' in error, 'el error PluginMetaInvalidError debe incluir issues');
      return true;
    },
  );
});

test('rechaza un archivo propio sin la clave common', async (t) => {
  const dir = await tempDir(t);
  await writeFile(metaPath(dir), JSON.stringify({ extended: {} }), 'utf8');

  await assert.rejects(
    service.read(dir),
    (error: unknown) => {
      assert.ok(error instanceof PluginMetaInvalidError);
      return true;
    },
  );
});

test('rechaza un extended con un valor no escalar', async (t) => {
  const dir = await tempDir(t);
  await writeFile(
    metaPath(dir),
    JSON.stringify({ common: { id: '1', name: 'X' }, extended: { nested: { a: [1, 2] } } }),
    'utf8',
  );

  await assert.rejects(
    service.read(dir),
    (error: unknown) => {
      assert.ok(error instanceof PluginMetaInvalidError);
      return true;
    },
  );
});

test('rechaza un extended con un array de objetos', async (t) => {
  const dir = await tempDir(t);
  await writeFile(
    metaPath(dir),
    JSON.stringify({ common: { id: '1', name: 'X' }, extended: { tags: [{ a: 1 }] } }),
    'utf8',
  );

  await assert.rejects(
    service.read(dir),
    (error: unknown) => {
      assert.ok(error instanceof PluginMetaInvalidError);
      return true;
    },
  );
});

test('rechaza un meta con source con forma inválida', async (t) => {
  const dir = await tempDir(t);
  await writeFile(
    metaPath(dir),
    JSON.stringify({
      common: { id: '1', name: 'X' },
      extended: {},
      updated: '2026-10-22T10:00:00Z',
      source: { vfxinfo: 'sí' },
    }),
    'utf8',
  );

  await assert.rejects(
    service.read(dir),
    (error: unknown) => {
      assert.ok(error instanceof PluginMetaInvalidError);
      return true;
    },
  );
});

test('rechaza un meta con updated de forma inválida', async (t) => {
  const dir = await tempDir(t);
  await writeFile(
    metaPath(dir),
    JSON.stringify({
      common: { id: '1', name: 'X' },
      extended: {},
      updated: 'no es fecha',
    }),
    'utf8',
  );

  await assert.rejects(
    service.read(dir),
    (error: unknown) => {
      assert.ok(error instanceof PluginMetaInvalidError);
      return true;
    },
  );
});

test('rechaza un meta con un campo extra no admitido en common', async (t) => {
  const dir = await tempDir(t);
  await writeFile(
    metaPath(dir),
    JSON.stringify({
      common: { id: '1', name: 'X', extra: 'no' },
      extended: {},
      updated: '2026-10-22T10:00:00Z',
    }),
    'utf8',
  );

  await assert.rejects(
    service.read(dir),
    (error: unknown) => {
      assert.ok(error instanceof PluginMetaInvalidError);
      return true;
    },
  );
});

test('el snapshot del conflicto contiene el estado actual', async (t) => {
  const dir = await tempDir(t);
  const first = await service.write({
    pluginDir: dir,
    expectedMtimeMs: null,
    common: { id: '1', name: 'X' },
    extended: {},
  });
  assert.ok(first.mtimeMs !== null);

  let conflicted: PluginMetaSnapshot | null = null;
  try {
    await service.write({
      pluginDir: dir,
      expectedMtimeMs: first.mtimeMs - 1,
      common: { id: '2' },
      extended: {},
    });
  } catch (error) {
    assert.ok(error instanceof PluginMetaConflictError);
    conflicted = error.current;
  }

  assert.ok(conflicted !== null);
  assert.equal(conflicted!.common.id, '1');
  assert.equal(conflicted!.common.name, 'X');
});

test('rechaza rutas relativas y directorios inexistentes', async () => {
  await assert.rejects(
    service.read('relative/dir'),
    PluginMetaPathError,
  );
  await assert.rejects(
    service.write({
      pluginDir: 'relative/dir',
      expectedMtimeMs: null,
      common: { id: '1' },
      extended: {},
    }),
    PluginMetaPathError,
  );
});
