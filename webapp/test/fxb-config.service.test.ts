import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { FXB_CONFIG_FILENAME } from '../src/fxb-config/fxb-config.constants';
import { FxbConfigService } from '../src/fxb-config/fxb-config.service';
import {
  FxbConfigConflictError,
  FxbConfigPathError,
  FxbConfigValidationError,
} from '../src/fxb-config/fxb-config.types';
import type { FxbConfigSnapshot } from '../src/fxb-config/fxb-config.types';

const service = new FxbConfigService();

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fxb-config-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function configPath(dir: string): string {
  return path.join(dir, FXB_CONFIG_FILENAME);
}

test('lee un directorio sin config como valores por defecto', async (t) => {
  const dir = await tempDir(t);

  const snapshot = await service.read(dir);

  assert.equal(snapshot.exists, false);
  assert.equal(snapshot.mtimeMs, null);
  assert.equal(snapshot.size, 0);
  assert.equal(snapshot.configPath, configPath(dir));
  assert.deepEqual(snapshot.config, {
    pluginName: '',
    defaultFxbName: '',
    programDirName: 'presets',
    loadFxbBank: true,
  });
  assert.deepEqual(await readdir(dir), []);
});

test('escribe las cuatro claves en CRLF y sin temporales', async (t) => {
  const dir = await tempDir(t);

  const snapshot = await service.write({
    pluginDir: dir,
    expectedMtimeMs: null,
    config: {
      pluginName: 'MySynth.dll',
      defaultFxbName: 'Rhodes.fxb',
      loadFxbBank: false,
    },
  });

  const text = (await readFile(configPath(dir))).toString('latin1');
  assert.equal(
    text,
    'pluginName = MySynth.dll\r\ndefaultFxbName = Rhodes.fxb\r\nprogramDirName = presets\r\nloadFxbBank = no\r\n',
  );
  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.size, Buffer.byteLength(text, 'latin1'));
  assert.equal(snapshot.config.loadFxbBank, false);
  assert.deepEqual(await readdir(dir), [FXB_CONFIG_FILENAME]);
});

test('un mtime obsoleto produce conflicto y no toca el archivo', async (t) => {
  const dir = await tempDir(t);
  const first = await service.write({
    pluginDir: dir,
    expectedMtimeMs: null,
    config: { pluginName: 'A.dll' },
  });
  assert.ok(first.mtimeMs !== null);
  const before = await readFile(configPath(dir));

  await assert.rejects(
    service.write({
      pluginDir: dir,
      expectedMtimeMs: first.mtimeMs - 1000,
      config: { pluginName: 'B.dll' },
    }),
    FxbConfigConflictError,
  );

  assert.deepEqual(await readFile(configPath(dir)), before);
});

test('expectedMtimeMs null con archivo existente es conflicto', async (t) => {
  const dir = await tempDir(t);
  await service.write({ pluginDir: dir, expectedMtimeMs: null, config: {} });

  await assert.rejects(
    service.write({ pluginDir: dir, expectedMtimeMs: null, config: { pluginName: 'B.dll' } }),
    FxbConfigConflictError,
  );
});

test('detecta un cambio externo (por ejemplo, la DLL al guardar)', async (t) => {
  const dir = await tempDir(t);
  const first = await service.write({
    pluginDir: dir,
    expectedMtimeMs: null,
    config: { pluginName: 'A.dll' },
  });
  assert.ok(first.mtimeMs !== null);

  await utimes(configPath(dir), new Date(), new Date(Date.now() + 5000));

  await assert.rejects(
    service.write({
      pluginDir: dir,
      expectedMtimeMs: first.mtimeMs,
      config: { pluginName: 'B.dll' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof FxbConfigConflictError);
      assert.notEqual(error.current.mtimeMs, first.mtimeMs);
      return true;
    },
  );
});

test('conserva las claves no incluidas en la actualización', async (t) => {
  const dir = await tempDir(t);
  const first = await service.write({
    pluginDir: dir,
    expectedMtimeMs: null,
    config: { pluginName: 'A.dll', defaultFxbName: 'bank.fxb' },
  });
  assert.ok(first.mtimeMs !== null);

  const second = await service.write({
    pluginDir: dir,
    expectedMtimeMs: first.mtimeMs,
    config: { loadFxbBank: false },
  });

  assert.equal(second.config.pluginName, 'A.dll');
  assert.equal(second.config.defaultFxbName, 'bank.fxb');
  assert.equal(second.config.loadFxbBank, false);
});

test('rechaza valores inválidos sin crear el archivo', async (t) => {
  const dir = await tempDir(t);

  await assert.rejects(
    service.write({
      pluginDir: dir,
      expectedMtimeMs: null,
      config: { pluginName: 'x'.repeat(64) },
    }),
    FxbConfigValidationError,
  );
  await assert.rejects(
    service.write({
      pluginDir: dir,
      expectedMtimeMs: null,
      config: { defaultFxbName: 'a/b.fxb' },
    }),
    FxbConfigValidationError,
  );
  await assert.rejects(
    service.write({
      pluginDir: dir,
      expectedMtimeMs: null,
      config: { programDirName: '  ' },
    }),
    FxbConfigValidationError,
  );

  await assert.rejects(readFile(configPath(dir)), { code: 'ENOENT' });
  assert.deepEqual(await readdir(dir), []);
});

test('conserva bytes CP-1252 al escribir y leer', async (t) => {
  const dir = await tempDir(t);

  const snapshot = await service.write({
    pluginDir: dir,
    expectedMtimeMs: null,
    config: { pluginName: 'Órgano.dll' },
  });

  const bytes = await readFile(configPath(dir));
  assert.ok(bytes.includes(0xd3), 'la Ó debe quedar como 0xD3 en latin1');
  assert.equal(snapshot.config.pluginName, 'Órgano.dll');
  assert.equal((await service.read(dir)).config.pluginName, 'Órgano.dll');
});

test('expone warnings al leer un archivo raro', async (t) => {
  const dir = await tempDir(t);
  await writeFile(
    configPath(dir),
    Buffer.from('foo = bar\r\nloadFxbBank = False\r\n', 'latin1'),
  );

  const snapshot = await service.read(dir);

  assert.equal(snapshot.config.loadFxbBank, true);
  assert.equal(snapshot.warnings.length, 2);
});

test('rechaza rutas relativas y directorios inexistentes', async () => {
  await assert.rejects(service.read('relative/dir'), FxbConfigPathError);
  await assert.rejects(
    service.read(path.join(tmpdir(), 'no-existe-fxb-config-12345')),
    FxbConfigPathError,
  );
});

test('el snapshot del conflicto contiene el estado actual', async (t) => {
  const dir = await tempDir(t);
  const first = await service.write({
    pluginDir: dir,
    expectedMtimeMs: null,
    config: { pluginName: 'A.dll' },
  });
  assert.ok(first.mtimeMs !== null);

  let conflicted: FxbConfigSnapshot | null = null;
  try {
    await service.write({
      pluginDir: dir,
      expectedMtimeMs: first.mtimeMs - 1,
      config: { pluginName: 'B.dll' },
    });
  } catch (error) {
    assert.ok(error instanceof FxbConfigConflictError);
    conflicted = error.current;
  }

  assert.ok(conflicted !== null);
  assert.equal((conflicted as FxbConfigSnapshot).config.pluginName, 'A.dll');
});
