import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { FxbConfigService } from '../src/fxb-config/fxb-config.service';
import { parseFxbBank } from '../src/library/fxb-bank';
import { LibraryService } from '../src/library/library.service';
import { buildBank } from './helpers/fxb-bank';
import { writePluginDll } from './helpers/vfx-plugin';

// El borrado de esta suite no debe llenar la Papelera real en cada corrida.
process.env['FXB_TRASH_MODE'] = 'direct';

const configService = new FxbConfigService();
const service = new LibraryService(configService);

interface Fixture {
  root: string;
  pluginDir: string;
  presetsDir: string;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-bank-ops-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pluginDir = path.join(root, 'plugs', 'Synth');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, 'vfxinfo.txt'),
    Buffer.from('name: Synth\r\ndll_name: Synth/Synth.dll\r\n', 'latin1'),
  );
  await writePluginDll(pluginDir, 'Synth/Synth.dll');

  const presetsDir = path.join(pluginDir, 'presets');
  await mkdir(presetsDir, { recursive: true });

  await configService.write({
    pluginDir,
    expectedMtimeMs: null,
    config: { pluginName: 'Synth.dll', programDirName: 'presets', defaultFxbName: 'Legacy.fxb' },
  });

  return { root, pluginDir, presetsDir };
}

test('rename mueve el banco, su respaldo y actualiza el banco por defecto', async (t) => {
  const data = await fixture(t);
  const bank = buildBank({ programs: 2 });
  await writeFile(path.join(data.presetsDir, 'Legacy.fxb'), bank);
  await writeFile(path.join(data.presetsDir, 'Legacy.fxb.orig'), bank);

  const result = await service.renameBank({
    libraryRoot: data.root,
    plugin: 'Synth',
    fileName: 'Legacy.fxb',
    newName: 'Rhodes.fxb',
  });

  assert.equal(existsSync(path.join(data.presetsDir, 'Legacy.fxb')), false);
  assert.equal(existsSync(path.join(data.presetsDir, 'Rhodes.fxb')), true);
  assert.equal(result.renamed.fileName, 'Rhodes.fxb');
  assert.equal(result.previous.fileName, 'Legacy.fxb');
  assert.equal(result.renamed.sha256, result.previous.sha256, 'el contenido no cambia');
  assert.deepEqual(await readFile(path.join(data.presetsDir, 'Rhodes.fxb')), bank);

  assert.equal(result.defaultUpdated, true, 'era el banco por defecto');
  assert.equal(result.backupRenamed, 'Rhodes.fxb.orig');
  assert.equal(existsSync(path.join(data.presetsDir, 'Legacy.fxb.orig')), false);

  const snapshot = await configService.read(data.pluginDir);
  assert.equal(snapshot.config.defaultFxbName, 'Rhodes.fxb');
});

test('rename no pisa un banco que ya existe', async (t) => {
  const data = await fixture(t);
  await writeFile(path.join(data.presetsDir, 'Legacy.fxb'), buildBank({ programs: 1 }));
  await writeFile(path.join(data.presetsDir, 'Taken.fxb'), buildBank({ programs: 1 }));

  await assert.rejects(
    service.renameBank({
      libraryRoot: data.root,
      plugin: 'Synth',
      fileName: 'Legacy.fxb',
      newName: 'Taken.fxb',
    }),
    /ya existe un archivo con el nombre nuevo/,
  );
  assert.equal(existsSync(path.join(data.presetsDir, 'Legacy.fxb')), true);
});

test('clear deja el banco sin programas, conserva el uniqueID y respalda el original', async (t) => {
  const data = await fixture(t);
  const bank = buildBank({ programs: 2 });
  const file = path.join(data.presetsDir, 'Legacy.fxb');
  await writeFile(file, bank);

  const result = await service.clearBank({
    libraryRoot: data.root,
    plugin: 'Synth',
    fileName: 'Legacy.fxb',
  });

  assert.equal(result.programs, 2);
  assert.equal(result.cleared.bank.numPrograms, 0);
  assert.equal(result.cleared.bank.uniqueId, result.previous.bank.uniqueId);
  assert.equal(result.backupCreated, true);

  const cleared = parseFxbBank(await readFile(file));
  assert.equal(cleared.issues.length, 0);
  assert.equal(cleared.bank?.numPrograms, 0);

  const backup = await readFile(path.join(data.presetsDir, 'Legacy.fxb.orig'));
  assert.deepEqual(backup, bank, 'el respaldo es el original byte a byte');

  // Un segundo vaciado conserva el primer respaldo.
  const again = await service.clearBank({
    libraryRoot: data.root,
    plugin: 'Synth',
    fileName: 'Legacy.fxb',
  });
  assert.equal(again.programs, 0);
  assert.equal(again.backupCreated, false);
  assert.deepEqual(await readFile(path.join(data.presetsDir, 'Legacy.fxb.orig')), bank);
});

test('delete envía el banco a la papelera y cuenta los que quedan', async (t) => {
  const data = await fixture(t);
  await writeFile(path.join(data.presetsDir, 'Legacy.fxb'), buildBank({ programs: 1 }));
  await writeFile(path.join(data.presetsDir, 'Other.fxb'), buildBank({ programs: 1 }));

  const result = await service.deleteBank({
    libraryRoot: data.root,
    plugin: 'Synth',
    fileName: 'Legacy.fxb',
  });

  assert.equal(existsSync(path.join(data.presetsDir, 'Legacy.fxb')), false);
  assert.equal(result.remaining, 1);
  assert.equal(result.wasDefault, true);
  assert.equal(result.deleted.fileName, 'Legacy.fxb');
  assert.match(result.trash.label, /Papelera/);
  assert.deepEqual((await readdir(data.presetsDir)).sort(), ['Other.fxb']);

  await assert.rejects(
    service.deleteBank({ libraryRoot: data.root, plugin: 'Synth', fileName: 'Legacy.fxb' }),
    /no existe el banco en la carpeta del plugin/,
  );
});
