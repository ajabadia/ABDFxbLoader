import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { FXB_CONFIG_FILENAME } from '../src/fxb-config/fxb-config.constants';
import { FxbConfigService } from '../src/fxb-config/fxb-config.service';
import { LibraryService } from '../src/library/library.service';
import type { PluginEntry } from '../src/library/library.types';
import {
  LibraryOperationError,
  LibraryPathError,
  PluginNotFoundError,
  PluginStateError,
} from '../src/library/library.types';
import {
  VFXINFO_BACKUP_FILENAME,
  VFXINFO_DISABLED_FILENAME,
  VFXINFO_FILENAME,
} from '../src/library/vfxinfo';
import { pe32Dll, pe64Dll } from './helpers/pe';

const configService = new FxbConfigService();
const service = new LibraryService(configService);

function vfxinfo(dllName: string, eol = '\r\n'): string {
  return ['name: Test Plugin', `dll_name: ${dllName}`, 'version: 1.0', 'vendor: Test', ''].join(
    eol,
  );
}

async function writeLatin1(file: string, text: string): Promise<void> {
  await writeFile(file, Buffer.from(text, 'latin1'));
}

interface Fixture {
  root: string;
  plugs: string;
  pluginDir: string;
  dllSource: string;
  originalVfxinfo: Buffer;
}

async function fixture(t: TestContext, dllName = 'Synth.dll'): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-library-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const plugs = path.join(root, 'plugs');
  const pluginDir = path.join(plugs, 'Synth');
  await mkdir(pluginDir, { recursive: true });
  await writeLatin1(path.join(pluginDir, VFXINFO_FILENAME), vfxinfo(dllName));
  await writeFile(path.join(pluginDir, 'Synth.dll'), pe32Dll());

  const dllSource = path.join(root, 'fxbLoader.dll');
  await writeFile(dllSource, pe32Dll());

  return {
    root,
    plugs,
    pluginDir,
    dllSource,
    originalVfxinfo: await readFile(path.join(pluginDir, VFXINFO_FILENAME)),
  };
}

function pluginEntries(dir: string): Promise<string[]> {
  return readdir(dir).then((names) => names.sort());
}

test('scan enumera solo directorios y marca los instalados', async (t) => {
  const { root, plugs, pluginDir, dllSource, originalVfxinfo } = await fixture(t);
  await mkdir(path.join(plugs, 'Empty'));
  await writeLatin1(path.join(plugs, 'notes.txt'), 'no es un plugin');
  await configService.write({
    pluginDir,
    expectedMtimeMs: null,
    config: { pluginName: 'Synth.dll' },
  });

  const result = await service.scan(root, dllSource);

  assert.equal(result.libraryRoot, path.resolve(root));
  assert.equal(result.plugsPath, plugs);
  assert.equal(result.loader.valid, true);
  assert.equal(result.loader.bitness, 32);
  assert.equal(result.loader.machine, 'i386');
  assert.deepEqual(result.loader.issues, []);
  assert.deepEqual(
    result.plugins.map((plugin) => plugin.name),
    ['Empty', 'Synth'],
  );

  const [empty, synth] = result.plugins as [PluginEntry, PluginEntry];
  assert.equal(empty.installed, false);
  assert.equal(empty.hasVfxinfo, false);
  assert.equal(empty.pluginName, null);
  assert.equal(empty.compatible, false);
  assert.match(empty.compatibilityIssues.join(' '), /falta vfxinfo\.txt/);

  assert.equal(synth.installed, true);
  assert.equal(synth.hasVfxinfo, true);
  assert.equal(synth.pluginName, 'Synth.dll');
  assert.deepEqual(synth.warnings, []);
  // El config se escribió a mano: falta el DLL instalado.
  assert.equal(synth.compatible, false);
  assert.match(synth.compatibilityIssues.join(' '), /falta fxbLoader\.dll/);
  assert.deepEqual(await readFile(path.join(pluginDir, VFXINFO_FILENAME)), originalVfxinfo);
});

test('scan marca incompatible un plugin de 64 bits', async (t) => {
  const { root, pluginDir, dllSource } = await fixture(t);
  await writeFile(path.join(pluginDir, 'Synth.dll'), pe64Dll());

  const result = await service.scan(root, dllSource);
  const plugin = result.plugins[0]!;

  assert.equal(result.loader.valid, true);
  assert.equal(plugin.compatible, false);
  assert.match(plugin.compatibilityIssues.join(' '), /PE32\+ AMD64 \(64 bits\)/);
  assert.match(plugin.compatibilityIssues.join(' '), /requiere PE32 i386/);
});

test('scan marca incompatible el plugin si el fxbLoader.dll no es PE32', async (t) => {
  const { root, dllSource } = await fixture(t);
  await writeFile(dllSource, Buffer.alloc(0x100, 0x41));

  const result = await service.scan(root, dllSource);
  const plugin = result.plugins[0]!;

  assert.equal(result.loader.valid, false);
  assert.equal(result.loader.bitness, null);
  assert.match(result.loader.issues.join(' '), /firma MZ/);
  assert.equal(plugin.compatible, false);
  assert.match(plugin.compatibilityIssues.join(' '), /fxbLoader\.dll de origen no es PE32 i386/);
});

test('scan marca incompatible un fxbLoader.dll instalado que no es PE32', async (t) => {
  const { root, pluginDir, dllSource } = await fixture(t);
  await service.install({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource });
  await writeFile(path.join(pluginDir, 'fxbLoader.dll'), pe64Dll());

  const result = await service.scan(root, dllSource);
  const plugin = result.plugins[0]!;

  assert.equal(plugin.compatible, false);
  assert.match(plugin.compatibilityIssues.join(' '), /instalado no es PE32 i386/);
});

test('scan marca incompatible un dll_name que sale del plugin', async (t) => {
  const { root, pluginDir, dllSource } = await fixture(t);
  await writeLatin1(
    path.join(pluginDir, VFXINFO_FILENAME),
    vfxinfo('../fuera/Synth.dll'),
  );

  const result = await service.scan(root, dllSource);
  const plugin = result.plugins[0]!;

  assert.equal(plugin.compatible, false);
  assert.match(plugin.compatibilityIssues.join(' '), /fuera del plugin/);
});

test('scan deja en null un plugin cuyo binario no se puede verificar', async (t) => {
  const { root, pluginDir, dllSource } = await fixture(t);
  await rm(path.join(pluginDir, 'Synth.dll'));

  const result = await service.scan(root, dllSource);
  const plugin = result.plugins[0]!;

  assert.equal(plugin.compatible, null);
  assert.match(plugin.compatibilityIssues.join(' '), /no se pudo verificar el binario/);
});

test('install rechaza fxbLoader.dll que no sea PE32 i386', async (t) => {
  const { root, pluginDir, dllSource } = await fixture(t);
  await writeFile(dllSource, pe64Dll());

  await assert.rejects(
    service.install({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource }),
    (error: unknown) =>
      error instanceof LibraryOperationError && /no es un PE32 i386/.test(error.message),
  );
  assert.equal((await readdir(pluginDir)).includes(VFXINFO_BACKUP_FILENAME), false);
});

test('install rechaza un plugin de 64 bits sin escribir nada', async (t) => {
  const { root, pluginDir, dllSource, originalVfxinfo } = await fixture(t);
  await writeFile(path.join(pluginDir, 'Synth.dll'), pe64Dll());

  await assert.rejects(
    service.install({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource }),
    (error: unknown) =>
      error instanceof LibraryOperationError && /no es compatible/.test(error.message),
  );

  assert.deepEqual(await readFile(path.join(pluginDir, VFXINFO_FILENAME)), originalVfxinfo);
  assert.equal((await readdir(pluginDir)).includes(VFXINFO_BACKUP_FILENAME), false);
});

test('scan exige una librería con carpeta plugs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-library-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(service.scan(root), LibraryPathError);
  await assert.rejects(service.scan('relative/plugs'), LibraryPathError);
  await assert.rejects(service.scan(path.join(root, 'missing')), LibraryPathError);
});

test('install respalda, copia el DLL, parchea vfxinfo y crea config + presets', async (t) => {
  const { root, pluginDir, dllSource, originalVfxinfo } = await fixture(t);

  const result = await service.install({
    libraryRoot: root,
    plugin: 'Synth',
    dllSourcePath: dllSource,
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.plugin.installed, true);
  assert.equal(result.plugin.pluginName, 'Synth.dll');
  assert.deepEqual(
    result.actions.map((action) => action.kind),
    ['backup', 'copy', 'patch', 'write-config', 'create-dir'],
  );

  // El respaldo es byte a byte el original.
  assert.deepEqual(
    await readFile(path.join(pluginDir, VFXINFO_BACKUP_FILENAME)),
    originalVfxinfo,
  );

  const patched = (await readFile(path.join(pluginDir, VFXINFO_FILENAME))).toString('latin1');
  assert.equal(
    patched,
    [
      'name: Test Plugin',
      'dll_name: Synth/fxbLoader.dll',
      'version: 1.0',
      'vendor: Test',
      '',
    ].join('\r\n'),
  );

  assert.deepEqual(await readFile(path.join(pluginDir, 'fxbLoader.dll')), pe32Dll());

  const config = await configService.read(pluginDir);
  assert.equal(config.config.pluginName, 'Synth.dll');
  assert.equal(config.config.defaultFxbName, '');
  assert.equal(config.config.programDirName, 'presets');
  assert.equal(config.config.loadFxbBank, true);

  assert.equal((await stat(path.join(pluginDir, 'presets'))).isDirectory(), true);

  // Sin temporales sueltos.
  assert.deepEqual(await pluginEntries(pluginDir), [
    'Synth.dll',
    'fxbLoader.config',
    'fxbLoader.dll',
    'presets',
    'vfxinfo.tx_',
    'vfxinfo.txt',
  ]);
});

test('install conserva CP-1252 en el pluginName', async (t) => {
  const { root, pluginDir, dllSource } = await fixture(t, 'Órgano/Órgano.dll');

  await service.install({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource });

  const raw = await readFile(path.join(pluginDir, FXB_CONFIG_FILENAME));
  const expected = Buffer.from('pluginName = Órgano.dll\r\n', 'latin1');
  assert.deepEqual(raw.subarray(0, expected.length), expected);
  assert.equal(raw.includes(Buffer.from([0xd3])), true);
});

test('install rechaza un plugin ya instalado salvo force, y force conserva los ajustes', async (t) => {
  const { root, pluginDir, dllSource, originalVfxinfo } = await fixture(t);
  await service.install({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource });

  await configService.write({
    pluginDir,
    expectedMtimeMs: (await configService.read(pluginDir)).mtimeMs,
    config: { defaultFxbName: 'Rhodes.fxb', loadFxbBank: false },
  });

  await assert.rejects(
    service.install({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource }),
    PluginStateError,
  );

  const result = await service.install({
    libraryRoot: root,
    plugin: 'Synth',
    dllSourcePath: dllSource,
    force: true,
  });

  assert.equal(result.plugin.pluginName, 'Synth.dll');

  const config = await configService.read(pluginDir);
  assert.equal(config.config.pluginName, 'Synth.dll');
  assert.equal(config.config.defaultFxbName, 'Rhodes.fxb');
  assert.equal(config.config.loadFxbBank, false);

  // El respaldo sigue siendo el original, no el vfxinfo ya parcheado.
  assert.deepEqual(
    await readFile(path.join(pluginDir, VFXINFO_BACKUP_FILENAME)),
    originalVfxinfo,
  );
});

test('dos instalaciones con force no pisan el respaldo y conservan defaultFxbName', async (t) => {
  const { root, pluginDir, dllSource, originalVfxinfo } = await fixture(t);
  const backupPath = path.join(pluginDir, VFXINFO_BACKUP_FILENAME);

  await service.install({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource });
  const originalBackup = await readFile(backupPath);

  await configService.write({
    pluginDir,
    expectedMtimeMs: (await configService.read(pluginDir)).mtimeMs,
    config: { defaultFxbName: 'Rhodes.fxb', loadFxbBank: false },
  });

  for (const attempt of [1, 2]) {
    const result = await service.install({
      libraryRoot: root,
      plugin: 'Synth',
      dllSourcePath: dllSource,
      force: true,
    });

    assert.equal(result.plugin.pluginName, 'Synth.dll', `force ${attempt}: pluginName`);

    // Al reinstalar, el vfxinfo ya está parcheado; el respaldo debe seguir
    // siendo el original byte a byte, no una copia del archivo modificado.
    assert.deepEqual(await readFile(backupPath), originalVfxinfo, `force ${attempt}: respaldo`);
    assert.deepEqual(await readFile(backupPath), originalBackup, `force ${attempt}: respaldo intacto`);

    const backupAction = result.actions.find((action) => action.kind === 'backup');
    assert.match(backupAction?.detail ?? '', /ya existe; se conserva/, `force ${attempt}: acción backup`);

    const config = await configService.read(pluginDir);
    assert.equal(config.config.pluginName, 'Synth.dll', `force ${attempt}: config pluginName`);
    assert.equal(config.config.defaultFxbName, 'Rhodes.fxb', `force ${attempt}: defaultFxbName`);
    assert.equal(config.config.loadFxbBank, false, `force ${attempt}: loadFxbBank`);
  }
});

test('install es idempotente sobre el vfxinfo parcheado', async (t) => {
  const { root, pluginDir, dllSource } = await fixture(t);
  await service.install({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource });
  const first = await readFile(path.join(pluginDir, VFXINFO_FILENAME));

  await service.install({
    libraryRoot: root,
    plugin: 'Synth',
    dllSourcePath: dllSource,
    force: true,
  });

  assert.deepEqual(await readFile(path.join(pluginDir, VFXINFO_FILENAME)), first);
});

test('install rechaza vfxinfo sin dll_name sin escribir nada', async (t) => {
  const { root, pluginDir, dllSource } = await fixture(t);
  await writeLatin1(path.join(pluginDir, VFXINFO_FILENAME), 'name: Test\r\nversion: 1.0\r\n');
  const before = await readdir(pluginDir);

  await assert.rejects(
    service.install({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource }),
    LibraryOperationError,
  );

  assert.deepEqual((await readdir(pluginDir)).sort(), before.sort());
});

test('install rechaza un plugin sin vfxinfo o un DLL de origen inexistente', async (t) => {
  const { root, pluginDir, dllSource } = await fixture(t);

  await assert.rejects(
    service.install({
      libraryRoot: root,
      plugin: 'Synth',
      dllSourcePath: path.join(root, 'nope', 'fxbLoader.dll'),
    }),
    LibraryPathError,
  );
  assert.equal((await readdir(pluginDir)).includes(VFXINFO_BACKUP_FILENAME), false);

  await rm(path.join(pluginDir, VFXINFO_FILENAME));
  await assert.rejects(
    service.install({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource }),
    LibraryOperationError,
  );
});

test('install dryRun no toca el disco', async (t) => {
  const { root, pluginDir, dllSource } = await fixture(t);
  const before = await pluginEntries(pluginDir);

  const result = await service.install({
    libraryRoot: root,
    plugin: 'Synth',
    dllSourcePath: dllSource,
    dryRun: true,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.actions.length, 5);
  assert.deepEqual(await pluginEntries(pluginDir), before);
});

test('uninstall restaura el original y conserva DLL, bancos y copia modificada', async (t) => {
  const { root, pluginDir, dllSource, originalVfxinfo } = await fixture(t);
  await service.install({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource });
  await writeLatin1(path.join(pluginDir, 'presets', 'Rhodes.fxb'), 'bank');
  const patched = await readFile(path.join(pluginDir, VFXINFO_FILENAME));

  const result = await service.uninstall({ libraryRoot: root, plugin: 'Synth' });

  assert.equal(result.plugin.installed, false);
  assert.equal(result.plugin.pluginName, null);
  assert.deepEqual(
    result.actions.map((action) => action.kind),
    ['restore', 'restore', 'delete'],
  );

  assert.deepEqual(await readFile(path.join(pluginDir, VFXINFO_FILENAME)), originalVfxinfo);
  assert.deepEqual(await readFile(path.join(pluginDir, VFXINFO_DISABLED_FILENAME)), patched);
  assert.equal(
    (await readdir(pluginDir)).includes(FXB_CONFIG_FILENAME),
    false,
  );
  assert.equal(
    (await readdir(pluginDir)).includes(VFXINFO_BACKUP_FILENAME),
    false,
  );

  // Igual que el original: DLL y bancos importados se quedan.
  assert.equal((await readFile(path.join(pluginDir, 'fxbLoader.dll'))).length > 0, true);
  assert.equal((await readFile(path.join(pluginDir, 'presets', 'Rhodes.fxb'))).toString(), 'bank');
});

test('uninstall dryRun no toca el disco', async (t) => {
  const { root, pluginDir, dllSource } = await fixture(t);
  await service.install({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource });
  const before = await pluginEntries(pluginDir);

  const result = await service.uninstall({ libraryRoot: root, plugin: 'Synth', dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(result.plugin.installed, true);
  assert.deepEqual(await pluginEntries(pluginDir), before);
});

test('uninstall exige que esté instalado y que exista el respaldo', async (t) => {
  const { root, pluginDir, dllSource } = await fixture(t);

  await assert.rejects(
    service.uninstall({ libraryRoot: root, plugin: 'Synth' }),
    PluginStateError,
  );

  await service.install({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource });
  await rm(path.join(pluginDir, VFXINFO_BACKUP_FILENAME));

  await assert.rejects(
    service.uninstall({ libraryRoot: root, plugin: 'Synth' }),
    PluginStateError,
  );
  assert.equal((await readdir(pluginDir)).includes(FXB_CONFIG_FILENAME), true);
});

test('rechaza nombres de plugin con traversal o separadores', async (t) => {
  const { root, dllSource } = await fixture(t);

  for (const plugin of ['..', '.', '../Synth', 'a/b', 'a\\b', '']) {
    await assert.rejects(
      service.install({ libraryRoot: root, plugin, dllSourcePath: dllSource }),
      LibraryPathError,
      `plugin=${JSON.stringify(plugin)}`,
    );
  }
});

test('plugin inexistente devuelve not found', async (t) => {
  const { root, dllSource } = await fixture(t);

  await assert.rejects(
    service.install({ libraryRoot: root, plugin: 'Ghost', dllSourcePath: dllSource }),
    PluginNotFoundError,
  );
});
