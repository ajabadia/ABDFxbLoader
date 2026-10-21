import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { FxbConfigService } from '../src/fxb-config/fxb-config.service';
import { LibraryService } from '../src/library/library.service';
import { parseFxbBank } from '../src/library/fxb-bank';
import {
  LibraryOperationError,
  LibraryPathError,
  PluginStateError,
} from '../src/library/library.types';
import { buildBank, FXB_HEADER } from './helpers/fxb-bank';
import { writePluginDll } from './helpers/vfx-plugin';

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
  await writePluginDll(pluginDir, 'Synth/Synth.dll');

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

async function importedBank(
  fixtureData: Fixture,
  name: string,
  buffer: Buffer,
): Promise<string> {
  const source = await writeBank(fixtureData, name, buffer);
  const result = await service.importBanks({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    sourcePaths: [source],
  });
  assert.equal(result.results[0]?.status, 'imported', `${name}: importación previa`);
  return path.join(fixtureData.presetsDir, name);
}

test('exporta un banco importado a little-endian sin tocar el original', async (t) => {
  const fixtureData = await fixture(t);
  const original = buildBank({ endianness: 'big', programs: 2 });
  const installed = await importedBank(fixtureData, 'Legacy.fxb', original);

  const result = await service.exportBank({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    fileName: 'Legacy.fxb',
    endianness: 'little',
  });

  assert.equal(result.changed, true);
  assert.equal(result.fields, 8 + 2 * (7 + 1));
  assert.equal(result.programs, 2);
  assert.equal(result.chunks, 0);
  assert.equal(result.source.fileName, 'Legacy.fxb');
  assert.equal(result.source.bank.endianness, 'big');
  assert.equal(result.target.fileName, 'Legacy-le.fxb');
  assert.equal(result.target.path, path.join(fixtureData.presetsDir, 'Legacy-le.fxb'));
  assert.equal(result.target.bank.endianness, 'little');
  assert.equal(result.target.bank.numPrograms, 2);
  assert.equal(result.target.size, original.length);
  assert.equal(result.presetsDir, fixtureData.presetsDir);
  assert.equal(result.plugin.name, 'Synth');

  const written = await readFile(result.target.path);
  assert.deepEqual(parseFxbBank(written).issues, []);
  assert.deepEqual(await readFile(installed), original, 'el banco importado no se modifica');

  // Volver a big-endian desde el convertido devuelve los bytes originales.
  const back = await service.exportBank({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    fileName: 'Legacy-le.fxb',
    endianness: 'big',
  });
  assert.equal(back.target.fileName, 'Legacy-be.fxb');
  assert.deepEqual(await readFile(back.target.path), original);
});

test('exporta un FBCh conservando el chunk opaco', async (t) => {
  const fixtureData = await fixture(t);
  const original = buildBank({ kind: 'FBCh', chunkSize: 24, endianness: 'big' });
  await importedBank(fixtureData, 'Opaque.fxb', original);

  const result = await service.exportBank({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    fileName: 'Opaque.fxb',
    endianness: 'little',
  });

  assert.equal(result.fields, 9);
  assert.equal(result.chunks, 1);
  assert.equal(result.target.bank.kind, 'FBCh');
  assert.equal(result.target.bank.chunkSize, 24);

  const written = await readFile(result.target.path);
  // Los bytes del chunk opaco (tras el tamaño) quedan iguales.
  assert.deepEqual(written.subarray(160), original.subarray(160));
});

test('no reexporta sin overwrite ni duplica el sufijo del orden', async (t) => {
  const fixtureData = await fixture(t);
  await importedBank(fixtureData, 'Legacy.fxb', buildBank({ endianness: 'big' }));

  const base = {
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    fileName: 'Legacy.fxb',
    endianness: 'little' as const,
  };
  await service.exportBank(base);

  await assert.rejects(service.exportBank(base), PluginStateError);
  const again = await service.exportBank({ ...base, overwrite: true });
  assert.equal(again.changed, true);
  assert.equal(again.target.fileName, 'Legacy-le.fxb');

  // El archivo convertido ya está en little-endian: no hay nada que invertir.
  const idempotent = await service.exportBank({
    ...base,
    fileName: 'Legacy-le.fxb',
    overwrite: true,
  });
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.fields, 0);
  assert.equal(idempotent.target.path, idempotent.source.path);

  assert.deepEqual((await readdir(fixtureData.presetsDir)).sort(), [
    'Legacy-le.fxb',
    'Legacy.fxb',
  ]);
});

test('rechaza rutas, bancos ausentes, contenido inválido y nombres engañosos', async (t) => {
  const fixtureData = await fixture(t);
  await importedBank(fixtureData, 'Legacy.fxb', buildBank({ endianness: 'big' }));

  const base = {
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    fileName: 'Legacy.fxb',
    endianness: 'little' as const,
  };

  await assert.rejects(
    service.exportBank({ ...base, fileName: '../Legacy.fxb' }),
    /separadores de ruta/,
  );
  await assert.rejects(service.exportBank({ ...base, fileName: 'Nope.fxb' }), /no existe el banco/);
  await assert.rejects(service.exportBank({ ...base, fileName: 'Legacy.txt' }), /extensión/);
  await assert.rejects(
    service.exportBank({ ...base, endianness: 'middle' as never }),
    LibraryPathError,
  );

  // Un .fxb con contenido inválido no se convierte.
  await writeFile(path.join(fixtureData.presetsDir, 'Roto.fxb'), Buffer.alloc(200, 0x41));
  await assert.rejects(
    service.exportBank({ ...base, fileName: 'Roto.fxb' }),
    LibraryOperationError,
  );

  // El sufijo del nombre no puede mentir sobre el contenido.
  await writeFile(
    path.join(fixtureData.presetsDir, 'Trampa-le.fxb'),
    buildBank({ endianness: 'big' }),
  );
  await assert.rejects(
    service.exportBank({ ...base, fileName: 'Trampa-le.fxb' }),
    /renómbralo antes de exportar/,
  );
});

async function setDefaultBank(fixtureData: Fixture, defaultFxbName: string): Promise<void> {
  const current = await configService.read(fixtureData.pluginDir);
  await configService.write({
    pluginDir: fixtureData.pluginDir,
    expectedMtimeMs: current.exists ? current.mtimeMs : null,
    config: { defaultFxbName, pluginName: 'Synth.dll' },
  });
}

test('convierte en el sitio el banco por defecto y guarda el original', async (t) => {
  const fixtureData = await fixture(t);
  const original = buildBank({ endianness: 'little', programs: 2 });
  await importedBank(fixtureData, 'Warm Rhodes.fxb', original);
  await setDefaultBank(fixtureData, 'Warm Rhodes.fxb');

  const result = await service.convertDefaultBank({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
  });

  assert.equal(result.fileName, 'Warm Rhodes.fxb');
  assert.equal(result.changed, true);
  assert.equal(result.source.bank.endianness, 'little');
  assert.equal(result.target.bank.endianness, 'big');
  assert.equal(result.target.fileName, 'Warm Rhodes.fxb');
  assert.equal(result.target.path, path.join(fixtureData.presetsDir, 'Warm Rhodes.fxb'));
  assert.equal(result.fields, 8 + 2 * (7 + 1));
  assert.equal(result.programs, 2);
  assert.equal(result.chunks, 0);
  assert.equal(result.presetsDir, fixtureData.presetsDir);
  assert.equal(result.plugin.name, 'Synth');

  // El respaldo es el archivo original, byte a byte, y no se cuela como banco.
  assert.equal(result.backup?.fileName, 'Warm Rhodes.fxb.orig');
  assert.equal(result.backup?.path, `${result.target.path}.orig`);
  assert.equal(result.backupCreated, true);
  assert.equal(result.backup?.size, original.length);
  assert.equal(result.backup?.sha256, result.source.sha256);
  assert.deepEqual(await readFile(result.backup!.path), original);

  // Se reescribió en su sitio (mismo nombre y ruta) y sigue siendo un banco válido.
  const written = await readFile(result.target.path);
  const reparsed = parseFxbBank(written);
  assert.deepEqual(reparsed.issues, []);
  assert.equal(reparsed.bank?.endianness, 'big');
  assert.equal(reparsed.bank?.numPrograms, 2);
  assert.equal(written.length, original.length);
  assert.notEqual(result.target.sha256, result.source.sha256);

  // La configuración no cambia: el banco conserva el nombre que la DLL conoce.
  const snapshot = await configService.read(fixtureData.pluginDir);
  assert.equal(snapshot.config.defaultFxbName, 'Warm Rhodes.fxb');

  // Volver al orden original devuelve los bytes de partida y conserva el respaldo.
  const back = await service.convertDefaultBank({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    endianness: 'little',
  });
  assert.equal(back.changed, true);
  assert.equal(back.target.bank.endianness, 'little');
  assert.equal(back.backupCreated, false);
  assert.deepEqual(await readFile(back.target.path), original);
  assert.deepEqual(await readFile(back.backup!.path), original);
});

test('no reescribe el banco por defecto si ya está en el orden pedido', async (t) => {
  const fixtureData = await fixture(t);
  const original = buildBank({ endianness: 'big' });
  await importedBank(fixtureData, 'Rhodes.fxb', original);
  await setDefaultBank(fixtureData, 'Rhodes.fxb');

  const result = await service.convertDefaultBank({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
    endianness: 'big',
  });

  assert.equal(result.changed, false);
  assert.equal(result.fields, 0);
  assert.equal(result.backup, null);
  assert.equal(result.backupCreated, false);
  assert.equal(result.target.path, result.source.path);
  assert.deepEqual(await readFile(result.target.path), original);
  assert.deepEqual((await readdir(fixtureData.presetsDir)).sort(), ['Rhodes.fxb']);
});

test('convierte un FBCh por defecto sin tocar su chunk opaco', async (t) => {
  const fixtureData = await fixture(t);
  const original = buildBank({ kind: 'FBCh', chunkSize: 24, endianness: 'little' });
  await importedBank(fixtureData, 'Opaque.fxb', original);
  await setDefaultBank(fixtureData, 'Opaque.fxb');

  const result = await service.convertDefaultBank({
    libraryRoot: fixtureData.root,
    plugin: 'Synth',
  });

  assert.equal(result.changed, true);
  assert.equal(result.fields, 9);
  assert.equal(result.chunks, 1);
  assert.equal(result.target.bank.kind, 'FBCh');
  assert.equal(result.target.bank.chunkSize, 24);
  assert.deepEqual(await readFile(result.backup!.path), original);

  const written = await readFile(result.target.path);
  // El payload opaco (tras el tamaño del chunk) queda igual.
  assert.deepEqual(written.subarray(160), original.subarray(160));
});

test('rechaza convertir sin banco por defecto, sin el archivo o con un nombre engañoso', async (t) => {
  const fixtureData = await fixture(t);
  await importedBank(fixtureData, 'Legacy.fxb', buildBank({ endianness: 'little' }));

  const base = { libraryRoot: fixtureData.root, plugin: 'Synth' };

  // Sin fxbLoader.config no hay banco que convertir.
  await assert.rejects(service.convertDefaultBank(base), /no tiene un banco por defecto/);

  await setDefaultBank(fixtureData, 'Missing.fxb');
  await assert.rejects(service.convertDefaultBank(base), /no está en la carpeta del plugin/);

  await setDefaultBank(fixtureData, '..\\Legacy.fxb');
  await assert.rejects(service.convertDefaultBank(base), /separadores de ruta/);

  await setDefaultBank(fixtureData, 'Legacy.txt');
  await assert.rejects(service.convertDefaultBank(base), /debe terminar en \.fxb/);

  // El nombre `-le` no puede acabar en big-endian.
  await writeFile(
    path.join(fixtureData.presetsDir, 'Trampa-le.fxb'),
    buildBank({ endianness: 'little' }),
  );
  await setDefaultBank(fixtureData, 'Trampa-le.fxb');
  await assert.rejects(
    service.convertDefaultBank(base),
    /declara little-endian en el nombre pero se pidió big-endian/,
  );
  assert.deepEqual(
    (await readdir(fixtureData.presetsDir)).filter((name) => name.endsWith('.orig')),
    [],
    'un rechazo no deja respaldos a medias',
  );

  // Contenido que no es un banco.
  await writeFile(path.join(fixtureData.presetsDir, 'Roto.fxb'), Buffer.alloc(200, 0x41));
  await setDefaultBank(fixtureData, 'Roto.fxb');
  await assert.rejects(service.convertDefaultBank(base), LibraryOperationError);

  await setDefaultBank(fixtureData, 'Legacy.fxb');
  await assert.rejects(
    service.convertDefaultBank({ ...base, endianness: 'middle' as never }),
    LibraryPathError,
  );
  await assert.rejects(
    service.convertDefaultBank({ ...base, plugin: 'Nope' }),
    /no existe el plugin/,
  );
});

test('restaura el banco por defecto desde el .orig sin pisar el respaldo', async (t) => {
  const fixtureData = await fixture(t);
  const original = buildBank({ endianness: 'little', programs: 2 });
  await importedBank(fixtureData, 'Warm Rhodes.fxb', original);
  await setDefaultBank(fixtureData, 'Warm Rhodes.fxb');

  const base = { libraryRoot: fixtureData.root, plugin: 'Synth' };
  const converted = await service.convertDefaultBank(base);
  const bankPath = path.join(fixtureData.presetsDir, 'Warm Rhodes.fxb');
  const backupPath = `${bankPath}.orig`;
  assert.notDeepEqual(await readFile(bankPath), original);

  const restored = await service.restoreDefaultBank(base);

  assert.equal(restored.fileName, 'Warm Rhodes.fxb');
  assert.equal(restored.changed, true);
  assert.equal(restored.presetsDir, fixtureData.presetsDir);
  assert.equal(restored.plugin.name, 'Synth');
  assert.equal(restored.restored.fileName, 'Warm Rhodes.fxb');
  assert.equal(restored.restored.path, bankPath);
  assert.equal(restored.restored.bank.endianness, 'little');
  assert.equal(restored.restored.bank.numPrograms, 2);
  assert.equal(restored.restored.size, original.length);
  // El banco vuelve a ser exactamente el respaldo, byte a byte.
  assert.deepEqual(await readFile(bankPath), original);
  assert.equal(restored.restored.sha256, converted.backup?.sha256);

  // El respaldo no se movió ni se reescribió: mismo nombre, ruta, hash y bytes.
  assert.equal(restored.backup.fileName, 'Warm Rhodes.fxb.orig');
  assert.equal(restored.backup.path, backupPath);
  assert.equal(restored.backup.size, original.length);
  assert.equal(restored.backup.sha256, converted.source.sha256);
  assert.deepEqual(await readFile(backupPath), original);
  assert.deepEqual((await readdir(fixtureData.presetsDir)).sort(), [
    'Warm Rhodes.fxb',
    'Warm Rhodes.fxb.orig',
  ]);

  // La configuración no cambia: la DLL sigue cargando el mismo nombre.
  const snapshot = await configService.read(fixtureData.pluginDir);
  assert.equal(snapshot.config.defaultFxbName, 'Warm Rhodes.fxb');

  // Restaurar otra vez no escribe nada y el respaldo sigue disponible.
  const again = await service.restoreDefaultBank(base);
  assert.equal(again.changed, false);
  assert.equal(again.restored.sha256, restored.restored.sha256);
  assert.deepEqual(await readFile(backupPath), original);
  assert.deepEqual(await readFile(bankPath), original);

  // Y el respaldo conservado permite volver a convertir si hace falta.
  const reconverted = await service.convertDefaultBank(base);
  assert.equal(reconverted.backupCreated, false);
  assert.deepEqual(await readFile(backupPath), original);
});

test('listBanks anuncia el respaldo del banco por defecto sin abrirlo', async (t) => {
  const fixtureData = await fixture(t);
  const original = buildBank({ endianness: 'little' });
  await importedBank(fixtureData, 'Rhodes.fxb', original);
  await setDefaultBank(fixtureData, 'Rhodes.fxb');

  const base = { libraryRoot: fixtureData.root, plugin: 'Synth' };
  const before = await service.listBanks(base);
  assert.equal(before.defaultBackup, null, 'todavía no hay .orig');

  await service.convertDefaultBank(base);
  const after = await service.listBanks(base);
  assert.deepEqual(after.defaultBackup, {
    fileName: 'Rhodes.fxb.orig',
    size: original.length,
  });

  // Sin banco por defecto no hay respaldo que anunciar.
  await setDefaultBank(fixtureData, '');
  assert.equal((await service.listBanks(base)).defaultBackup, null);
});

test('rechaza restaurar sin banco por defecto, sin respaldo o con un respaldo roto', async (t) => {
  const fixtureData = await fixture(t);
  const original = buildBank({ endianness: 'little' });
  const bankPath = await importedBank(fixtureData, 'Legacy.fxb', original);
  const base = { libraryRoot: fixtureData.root, plugin: 'Synth' };

  // Sin fxbLoader.config no hay banco por defecto que restaurar.
  await assert.rejects(service.restoreDefaultBank(base), /no tiene un banco por defecto/);

  // Con banco configurado pero sin .orig, el mensaje dice qué falta.
  await setDefaultBank(fixtureData, 'Legacy.fxb');
  await assert.rejects(service.restoreDefaultBank(base), PluginStateError);
  await assert.rejects(service.restoreDefaultBank(base), /no hay respaldo Legacy\.fxb\.orig/);

  // Nombre inseguro o sin .fxb: se rechaza antes de tocar el disco.
  await setDefaultBank(fixtureData, '..\\Legacy.fxb');
  await assert.rejects(service.restoreDefaultBank(base), LibraryPathError);
  await setDefaultBank(fixtureData, 'Legacy.txt');
  await assert.rejects(service.restoreDefaultBank(base), /debe terminar en \.fxb/);

  await setDefaultBank(fixtureData, 'Legacy.fxb');
  const backupPath = `${bankPath}.orig`;

  // Un respaldo vacío no es un banco.
  await writeFile(backupPath, Buffer.alloc(0));
  await assert.rejects(service.restoreDefaultBank(base), /está vacío/);

  // Y uno corrupto tampoco: no puede dejar el plugin con un banco roto.
  await writeFile(backupPath, Buffer.alloc(200, 0x41));
  await assert.rejects(service.restoreDefaultBank(base), LibraryOperationError);
  await assert.rejects(service.restoreDefaultBank(base), /no es un \.fxb válido/);
  assert.deepEqual(await readFile(bankPath), original, 'un rechazo no toca el banco');

  await assert.rejects(
    service.restoreDefaultBank({ ...base, plugin: 'Nope' }),
    /no existe el plugin/,
  );
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
