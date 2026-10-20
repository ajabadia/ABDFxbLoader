import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { FxbConfigService } from '../src/fxb-config/fxb-config.service';
import { LibraryService } from '../src/library/library.service';
import { LibraryOperationError, LibraryPathError } from '../src/library/library.types';
import { buildBank, FXB_HEADER } from './helpers/fxb-bank';

const configService = new FxbConfigService();
const service = new LibraryService(configService);

interface Fixture {
  root: string;
  pluginDir: string;
  banksDir: string;
  presetsDir: string;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-banks-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pluginDir = path.join(root, 'plugs', 'Synth');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, 'vfxinfo.txt'),
    Buffer.from('name: Synth\r\ndll_name: Synth/Synth.dll\r\n', 'latin1'),
  );

  const banksDir = path.join(root, 'banks');
  await mkdir(banksDir);

  return { root, pluginDir, banksDir, presetsDir: path.join(pluginDir, 'presets') };
}

async function writeBank(fixture: Fixture, name: string, buffer: Buffer): Promise<string> {
  const file = path.join(fixture.banksDir, name);
  await writeFile(file, buffer);
  return file;
}

test('importa un FxBk válido en presets y reporta su identidad', async (t) => {
  const fixtureData = await fixture(t);
  const source = await writeBank(fixtureData, 'Rhodes.fxb', buildBank({ programs: 2 }));

  const result = await service.importBanks({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    sourcePaths: [source],
  });

  assert.equal(result.results.length, 1);
  const [imported] = result.results;
  assert.equal(imported?.status, 'imported');
  assert.equal(imported?.compatibility, 'unverified');
  assert.equal(imported?.bank?.kind, 'FxBk');
  assert.equal(imported?.bank?.uniqueId, 'MySy');
  assert.equal(imported?.bank?.numPrograms, 2);
  assert.equal(imported?.bank?.fxVersion, 1000);
  assert.equal(imported?.target, path.join(fixtureData.presetsDir, 'Rhodes.fxb'));
  assert.deepEqual(await readFile(source), await readFile(imported!.target));
  assert.equal(result.reference.source, 'batch');
  assert.equal(result.reference.uniqueId, 'MySy');

  // Importar bancos no toca la configuración existente.
  const config = await configService.read(fixtureData.pluginDir);
  assert.equal(config.exists, false);
});

test('valida contra expectedUniqueId y expectedFxVersion explícitos', async (t) => {
  const fixtureData = await fixture(t);
  const matching = await writeBank(fixtureData, 'A.fxb', buildBank({ uniqueId: 'MySy' }));
  const other = await writeBank(fixtureData, 'B.fxb', buildBank({ uniqueId: 'Othr' }));

  const ok = await service.importBanks({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    sourcePaths: [matching],
    expectedUniqueId: 'MySy',
    expectedFxVersion: 1000,
  });
  assert.equal(ok.results[0]?.status, 'imported');
  assert.equal(ok.results[0]?.compatibility, 'compatible');
  assert.equal(ok.reference.source, 'explicit');

  const badId = await service.importBanks({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    sourcePaths: [other],
    expectedUniqueId: 'MySy',
  });
  assert.equal(badId.results[0]?.status, 'rejected');
  assert.equal(badId.results[0]?.compatibility, 'incompatible');
  assert.match(badId.results[0]?.reason ?? '', /uniqueID Othr/);

  const badVersion = await service.importBanks({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    sourcePaths: [matching],
    expectedUniqueId: 'MySy',
    expectedFxVersion: 2000,
  });
  assert.equal(badVersion.results[0]?.compatibility, 'incompatible');
  assert.match(badVersion.results[0]?.reason ?? '', /versión del plugin/);

  assert.deepEqual(await readdir(fixtureData.presetsDir), ['A.fxb']);
});

test('usa el primer banco del lote como referencia para el resto', async (t) => {
  const fixtureData = await fixture(t);
  const first = await writeBank(fixtureData, 'A.fxb', buildBank({ uniqueId: 'MySy' }));
  const foreign = await writeBank(fixtureData, 'B.fxb', buildBank({ uniqueId: 'Othr' }));

  const result = await service.importBanks({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    sourcePaths: [first, foreign],
  });

  assert.deepEqual(result.results.map((item) => item.status), ['imported', 'rejected']);
  assert.equal(result.results[1]?.compatibility, 'incompatible');
  assert.match(result.results[1]?.reason ?? '', /uniqueID Othr/);
  assert.deepEqual(await readdir(fixtureData.presetsDir), ['A.fxb']);
});

test('infiere la compatibilidad de un banco ya presente al añadir otro', async (t) => {
  const fixtureData = await fixture(t);
  await mkdir(fixtureData.presetsDir);
  await writeFile(path.join(fixtureData.presetsDir, 'Old.fxb'), buildBank({ uniqueId: 'MySy' }));

  // La DLL ignora fxVersion; con la misma identidad debe aceptarse.
  const compatible = await writeBank(
    fixtureData,
    'New.fxb',
    buildBank({ uniqueId: 'MySy', fxVersion: 2000 }),
  );
  const foreign = await writeBank(fixtureData, 'Foreign.fxb', buildBank({ uniqueId: 'Othr' }));

  const ok = await service.importBanks({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    sourcePaths: [compatible],
  });
  assert.equal(ok.reference.source, 'existing-bank');
  assert.equal(ok.results[0]?.compatibility, 'compatible');
  assert.equal(ok.results[0]?.status, 'imported');

  const bad = await service.importBanks({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    sourcePaths: [foreign],
  });
  assert.equal(bad.results[0]?.status, 'rejected');
  assert.equal(bad.results[0]?.compatibility, 'incompatible');
});

test('reemplazar un banco existente no se bloquea por la referencia inferida', async (t) => {
  const fixtureData = await fixture(t);
  await mkdir(fixtureData.presetsDir);
  const target = path.join(fixtureData.presetsDir, 'Same.fxb');
  await writeFile(target, buildBank({ uniqueId: 'MySy' }));
  const replacement = await writeBank(fixtureData, 'Same.fxb', buildBank({ uniqueId: 'Othr' }));

  const result = await service.importBanks({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    sourcePaths: [replacement],
  });

  assert.equal(result.results[0]?.status, 'overwritten');
  assert.equal(result.reference.source, 'none');
  assert.deepEqual(await readFile(target), await readFile(replacement));
});

test('valida bancos FBCh y archivos big-endian', async (t) => {
  const fixtureData = await fixture(t);
  const chunked = await writeBank(
    fixtureData,
    'Chunk.fxb',
    buildBank({ kind: 'FBCh', chunkSize: 32 }),
  );
  const big = await writeBank(fixtureData, 'Big.fxb', buildBank({ endianness: 'big' }));

  const result = await service.importBanks({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    sourcePaths: [chunked, big],
  });

  assert.deepEqual(result.results.map((item) => item.status), ['imported', 'imported']);
  assert.equal(result.results[0]?.bank?.kind, 'FBCh');
  assert.equal(result.results[0]?.bank?.chunkSize, 32);
  assert.equal(result.results[1]?.bank?.endianness, 'big');
});

test('rechaza archivos corruptos sin copiarlos', async (t) => {
  const fixtureData = await fixture(t);

  const badMagic = await writeBank(fixtureData, 'Magic.fxb', Buffer.alloc(200, 0x41));
  const brokenSize = buildBank();
  brokenSize.writeUInt32LE(1234, 4);
  const badSize = await writeBank(fixtureData, 'Size.fxb', brokenSize);
  const truncated = buildBank();
  const cut = await writeBank(fixtureData, 'Cut.fxb', truncated.subarray(0, FXB_HEADER + 10));

  const result = await service.importBanks({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    sourcePaths: [badMagic, badSize, cut],
  });

  assert.deepEqual(result.results.map((item) => item.status), [
    'rejected',
    'rejected',
    'rejected',
  ]);
  assert.match(result.results[0]?.issues?.[0] ?? '', /chunkMagic/);
  assert.match(result.results[1]?.issues?.join(' ') ?? '', /byteSize/);
  assert.match(result.results[2]?.issues?.join(' ') ?? '', /byteSize|termina antes/);
  await assert.rejects(readdir(fixtureData.presetsDir));
});

test('respeta overwrite y reporta el reemplazo', async (t) => {
  const fixtureData = await fixture(t);
  const first = await writeBank(fixtureData, 'Same.fxb', buildBank({ fxVersion: 1000 }));
  await service.importBanks({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    sourcePaths: [first],
  });

  const second = await writeBank(fixtureData, 'Same.fxb', buildBank({ fxVersion: 1001 }));

  const blocked = await service.importBanks({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    sourcePaths: [second],
    overwrite: false,
  });
  assert.equal(blocked.results[0]?.status, 'rejected');
  assert.match(blocked.results[0]?.reason ?? '', /overwrite=false/);

  const replaced = await service.importBanks({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    sourcePaths: [second],
  });
  assert.equal(replaced.results[0]?.status, 'overwritten');
});

test('rechaza programDirName con traversal', async (t) => {
  const fixtureData = await fixture(t);
  await configService.write({
    pluginDir: fixtureData.pluginDir,
    expectedMtimeMs: null,
    config: { pluginName: 'Synth.dll', programDirName: '..\\evil' },
  });
  const source = await writeBank(fixtureData, 'A.fxb', buildBank());

  await assert.rejects(
    service.importBanks({
      libraryRoot: fixtureData.root,
      plugin: 'Synth',
      sourcePaths: [source],
    }),
    LibraryOperationError,
  );
  await assert.rejects(readFile(path.join(fixtureData.root, 'plugs', 'evil', 'A.fxb')));
});

test('rechaza rutas relativas, extensiones y orígenes ausentes', async (t) => {
  const fixtureData = await fixture(t);
  const notFxb = await writeBank(fixtureData, 'bank.txt', buildBank());

  await assert.rejects(
    service.importBanks({
      libraryRoot: fixtureData.root,
      plugin: 'Synth',
      sourcePaths: ['banks/A.fxb'],
    }),
    LibraryPathError,
  );

  const result = await service.importBanks({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    sourcePaths: [notFxb, path.join(fixtureData.banksDir, 'missing.fxb')],
  });

  assert.equal(result.results[0]?.status, 'rejected');
  assert.match(result.results[0]?.reason ?? '', /extensión/);
  assert.equal(result.results[1]?.status, 'rejected');
  assert.match(result.results[1]?.reason ?? '', /no existe/);
});

test('rechaza uniqueIDs explícitos mal formados', async (t) => {
  const fixtureData = await fixture(t);
  const source = await writeBank(fixtureData, 'A.fxb', buildBank());

  await assert.rejects(
    service.importBanks({
      libraryRoot: fixtureData.root,
      plugin: 'Synth',
      sourcePaths: [source],
      expectedUniqueId: 'TooLong',
    }),
    LibraryPathError,
  );
  await assert.rejects(
    service.importBanks({
      libraryRoot: fixtureData.root,
      plugin: 'Synth',
      sourcePaths: [source],
      expectedFxVersion: -1,
    }),
    LibraryPathError,
  );
});
