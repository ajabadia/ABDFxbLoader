import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  PluginMetaService,
  commonFromVfxinfoFile,
  readCommonFromVfxinfo,
} from '../src/plugin-meta/plugin-meta.service';
import {
  PluginMetaConflictError,
  PluginMetaInvalidError,
  PluginMetaPathError,
} from '../src/plugin-meta/plugin-meta.types';
import type { PluginMetaSnapshot, PluginMetaValue } from '../src/plugin-meta/plugin-meta.types';

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

test('un plugin con vfxinfo.txt y sin meta.json devuelve los datos de vfxinfo como catálogo por defecto', async (t) => {
  const dir = await tempDir(t);
  await writeFile(
    path.join(dir, 'vfxinfo.txt'),
    'id: 1954033970\r\nname: Texture\r\nvendor: UGO\r\n',
    'latin1',
  );

  const snapshot = await service.read(dir);

  assert.equal(snapshot.exists, false);
  assert.equal(snapshot.common.id, '1954033970');
  assert.equal(snapshot.common.name, 'Texture');
  assert.equal(snapshot.common.vendor, 'UGO');
  assert.equal(snapshot.common.genre, '');
  assert.deepEqual(snapshot.source, { vfxinfo: true });
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
  await assert.rejects(service.read('   '), PluginMetaPathError, 'un pluginDir vacío no llega al disco');
});

test('un pluginDir absoluto que no existe se rechaza nombrando la ruta', async () => {
  const missing = path.join(tmpdir(), `fxb-meta-no-existe-${process.pid}`);

  await assert.rejects(service.read(missing), (error: unknown) => {
    assert.ok(error instanceof PluginMetaPathError);
    assert.match((error as Error).message, /el directorio no existe/);
    return true;
  });
});

test('escribir con una fecha esperada y sin archivo es conflicto, no creación', async (t) => {
  const dir = await tempDir(t);

  await assert.rejects(
    service.write({ pluginDir: dir, expectedMtimeMs: Date.now(), common: { id: '1' }, extended: {} }),
    (error: unknown) => {
      assert.ok(error instanceof PluginMetaConflictError);
      assert.equal((error as PluginMetaConflictError).current.exists, false);
      assert.equal((error as PluginMetaConflictError).current.mtimeMs, null);
      return true;
    },
  );

  await assert.rejects(readFile(metaPath(dir), 'utf8'), { code: 'ENOENT' }, 'no se escribió nada');
});

test('rechaza un pluginDir que existe pero es un archivo', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'plugin.dll');
  await writeFile(file, 'no es una carpeta');

  await assert.rejects(service.read(file), (error: unknown) => {
    assert.ok(error instanceof PluginMetaPathError);
    assert.match((error as Error).message, /no es un directorio/);
    return true;
  });
});

/**
 * Las dos funciones que traducen `vfxinfo.txt` a la parte común del meta: son
 * la única vía por la que el JSON hereda lo que el plugin ya declaraba.
 */
test('commonFromVfxinfoFile se queda con las claves conocidas y con valor', () => {
  const common = commonFromVfxinfoFile(
    [
      'name: SuperWave P8',
      'vendor : VMachine Labs ',
      'genre:',
      ': sin clave',
      'linea sin dos puntos',
      'extra: no se admite',
      'id: 1398231096',
    ].join('\r\n'),
  );

  assert.deepEqual(common, { name: 'SuperWave P8', vendor: 'VMachine Labs', id: '1398231096' });
});

test('readCommonFromVfxinfo lee el vfxinfo del plugin y devuelve vacío si no existe', async (t) => {
  const dir = await tempDir(t);

  assert.deepEqual(await readCommonFromVfxinfo(dir), {});

  await writeFile(path.join(dir, 'vfxinfo.txt'), 'name: Rhodes\r\nvendor: Yamaha\r\n', 'latin1');
  assert.deepEqual(await readCommonFromVfxinfo(dir), { name: 'Rhodes', vendor: 'Yamaha' });
});

/**
 * Cada forma que el esquema no admite, con el motivo exacto que recibe quien
 * haya editado el `.meta.json` a mano.
 */
test('rechaza las formas de meta que el esquema no admite', async (t) => {
  const dir = await tempDir(t);
  const longText = 'x'.repeat(256);
  const manyKeys = Object.fromEntries(
    Array.from({ length: 129 }, (_, index) => [`k${index}`, index]),
  );
  const cases: Array<[string, unknown]> = [
    ['el archivo propio debe ser un objeto JSON', []],
    ['common debe ser un objeto, no un array', { common: [], extended: {} }],
    ['el archivo propio debe incluir "extended" como objeto', { common: { id: '1' } }],
    ['extended debe ser un objeto, no un array', { common: { id: '1' }, extended: [] }],
    ['common.id: debe ser una cadena', { common: { id: 7 }, extended: {} }],
    ['common: clave desconocida "extra"', { common: { extra: 'x' }, extended: {} }],
    ['common.notes: 256 caracteres; el máximo es 255', { common: { notes: longText }, extended: {} }],
    ['common.notes: no puede contener caracteres de control', { common: { notes: 'a\u0001b' }, extended: {} }],
    ['extended: clave "9no" no válida', { common: {}, extended: { '9no': 1 } }],
    ['extended: más de 128 claves', { common: {}, extended: manyKeys }],
    ['extended.x: objeto con más de 128 propiedades', { common: {}, extended: { x: manyKeys } }],
    ['extended.x: clave de objeto no válida "no vale"', { common: {}, extended: { x: { 'no vale': 1 } } }],
    ['source: debe ser un objeto', { common: {}, extended: {}, source: [] }],
    ['source: clave desconocida "otra"', { common: {}, extended: {}, source: { otra: true } }],
    ['clave desconocida en el archivo propio: "extra"', { common: {}, extended: {}, extra: 1 }],
  ];

  for (const [message, payload] of cases) {
    await writeFile(metaPath(dir), JSON.stringify(payload), 'utf8');
    await assert.rejects(service.read(dir), (error: unknown) => {
      assert.ok(error instanceof PluginMetaInvalidError, `debería rechazar ${JSON.stringify(payload)}`);
      assert.ok(
        (error as PluginMetaInvalidError).issues.includes(message),
        `esperaba «${message}» y llegó «${(error as PluginMetaInvalidError).issues.join('; ')}»`,
      );
      return true;
    });
  }
});

test('la escritura rechaza lo que el esquema no admite en la entrada', async (t) => {
  const dir = await tempDir(t);
  const badExtended = (value: unknown): Readonly<Record<string, PluginMetaValue>> =>
    value as Readonly<Record<string, PluginMetaValue>>;
  const manyKeys = Object.fromEntries(
    Array.from({ length: 129 }, (_, index) => [`k${index}`, index]),
  );
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['common.id: debe ser una cadena', () =>
      service.write({ pluginDir: dir, expectedMtimeMs: null, common: { id: 7 as unknown as string }, extended: {} })],
    ['common: clave del cliente no admitida "extra"', () =>
      service.write({ pluginDir: dir, expectedMtimeMs: null, common: { extra: 'x' } as any, extended: {} })],
    ['common.id: 256 caracteres; el máximo es 255', () =>
      service.write({ pluginDir: dir, expectedMtimeMs: null, common: { id: 'x'.repeat(256) }, extended: {} })],
    ['common.name: no puede contener caracteres de control', () =>
      service.write({ pluginDir: dir, expectedMtimeMs: null, common: { name: 'a\u0000' }, extended: {} })],
    ['extended.tags: los arrays no se permiten', () =>
      service.write({ pluginDir: dir, expectedMtimeMs: null, common: {}, extended: badExtended({ tags: [1] }) })],
    ['extended: más de 128 claves', () =>
      service.write({ pluginDir: dir, expectedMtimeMs: null, common: {}, extended: badExtended(manyKeys) })],
    ['extended.x: objeto con más de 128 propiedades', () =>
      service.write({ pluginDir: dir, expectedMtimeMs: null, common: {}, extended: badExtended({ x: manyKeys }) })],
    ['extended.x: clave de objeto no válida "no vale"', () =>
      service.write({ pluginDir: dir, expectedMtimeMs: null, common: {}, extended: badExtended({ x: { 'no vale': 1 } }) })],
    ['extended.raro: el valor tiene un tipo no soportado', () =>
      service.write({ pluginDir: dir, expectedMtimeMs: null, common: {}, extended: badExtended({ raro: Symbol('x') }) })],
  ];

  for (const [message, run] of cases) {
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof PluginMetaInvalidError);
      assert.ok(
        (error as PluginMetaInvalidError).issues.includes(message),
        `esperaba «${message}» y llegó «${(error as PluginMetaInvalidError).issues.join('; ')}»`,
      );
      return true;
    });
  }

  await assert.rejects(
    service.write({ pluginDir: dir, expectedMtimeMs: null, common: { id: '   ' }, extended: {} }),
    /no puede estar vacío/,
  );
});

test('extended.notes manda sobre common.notes al escribir', async (t) => {
  const dir = await tempDir(t);
  const first = await service.write({
    pluginDir: dir,
    expectedMtimeMs: null,
    common: { id: '1', notes: 'del común' },
    extended: {},
  });
  assert.equal(first.common.notes, 'del común');

  const second = await service.write({
    pluginDir: dir,
    expectedMtimeMs: first.mtimeMs,
    common: {},
    extended: { notes: 'del extendido' },
  });

  assert.equal(second.common.notes, 'del extendido');
});

test('un error de lectura del meta que no es ENOENT se propaga', async (t) => {
  const dir = await tempDir(t);
  await mkdir(metaPath(dir));

  await assert.rejects(service.read(dir), (error: NodeJS.ErrnoException) => {
    assert.notEqual(error.code, 'ENOENT');
    return true;
  });
});

test('el conflicto devuelve lo que haya en disco aunque el archivo esté corrupto', async (t) => {
  const dir = await tempDir(t);
  await writeFile(metaPath(dir), '{ esto no es json', 'utf8');
  const stats = await stat(metaPath(dir));

  await assert.rejects(
    service.write({
      pluginDir: dir,
      expectedMtimeMs: stats.mtimeMs - 12345,
      common: { id: '2' },
      extended: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof PluginMetaConflictError);
      const current = (error as PluginMetaConflictError).current;
      assert.equal(current.exists, true);
      assert.equal(current.common.id, '', 'sin JSON no se inventan valores');
      assert.deepEqual(current.extended, {});
      assert.equal(current.source, null);
      assert.equal(current.updated, null);
      return true;
    },
  );
});

test('el conflicto refleja source.vfxinfo del archivo en disco', async (t) => {
  const dir = await tempDir(t);
  await writeFile(
    metaPath(dir),
    JSON.stringify({
      common: { id: '9', name: 'X' },
      extended: { rating: 3 },
      updated: '2026-10-22T10:00:00Z',
      source: { vfxinfo: true },
    }),
    'utf8',
  );
  const stats = await stat(metaPath(dir));

  await assert.rejects(
    service.write({
      pluginDir: dir,
      expectedMtimeMs: stats.mtimeMs - 12345,
      common: { id: '2' },
      extended: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof PluginMetaConflictError);
      const current = (error as PluginMetaConflictError).current;
      assert.equal(current.common.id, '9');
      assert.deepEqual(current.extended, { rating: 3 });
      assert.deepEqual(current.source, { vfxinfo: true });
      assert.equal(current.updated, '2026-10-22T10:00:00Z');
      return true;
    },
  );
});
