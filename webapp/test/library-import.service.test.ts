import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { LibraryImportService } from '../src/library/library-import.service';
import { AssociationAuditService } from '../src/association-audit/association-audit.service';
import { PluginLogService } from '../src/plugin-log/plugin-log.service';
import { PluginMetaService } from '../src/plugin-meta/plugin-meta.service';
import { WizardService } from '../src/wizard/wizard.service';
import { banksSkipReason } from './helpers/environment';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const BANKS_ROOT = path.join(PROJECT_ROOT, '_banks');
// `_banks/` no se versiona: sin él no hay paquete real que inspeccionar, así
// que la suite entera se omite con el motivo en vez de fallar con un ENOENT.
const banksSkip = banksSkipReason([
  'Novation V-Station demo.vfxlibrary',
  'MDAPiano.vfxlibrary',
]);
const NOVATION_DEMO_DIR = path.join(BANKS_ROOT, 'Novation V-Station demo.vfxlibrary');
const MDA_PIANO_DIR = path.join(BANKS_ROOT, 'MDAPiano.vfxlibrary');
const STORAGE_DIR = path.join(BANKS_ROOT, 'storage');

describe('LibraryImportService', { skip: banksSkip }, () => {
  const wizardService = new WizardService(new PluginMetaService());
  const service = new LibraryImportService(
    new PluginLogService(),
    wizardService,
    new AssociationAuditService(),
  );

  it('inspecciona un paquete de librería real (Novation V-Station demo) con Wizard y concordancia', async () => {
    await wizardService.onModuleInit();

    const result = await service.inspect({
      packagePath: NOVATION_DEMO_DIR,
      targetLibraryRoot: STORAGE_DIR,
    });

    assert.equal(result.resolvedKind, 'vfxlibrary');
    assert.equal(result.plugins.length, 1);
    const plugin = result.plugins[0]!;
    assert.equal(plugin.name, 'V-Station Demo');
    assert.equal(plugin.dllName, 'V-Station.dll');
    assert.equal(plugin.hasVfxinfo, true);
    assert.equal(plugin.vfxinfoId, 1316377392);
    assert.ok(plugin.totalSizeBytes > 1_000_000);
    assert.equal(plugin.alreadyExistsInTarget, false);
    assert.ok(plugin.matchedWizard, 'Debe emparejar con el wizard de Novation V-Station');
    assert.equal(plugin.matchedWizard.name, 'V-Station Demo');
    assert.equal(plugin.matchedWizard.vendor, 'Novation');

    assert.equal(result.banks.length, 1);
    const bank = result.banks[0]!;
    assert.equal(bank.name, '000_Novation V-Station demo.vfxbank');
    assert.equal(bank.presetCount, 6);
    assert.equal(bank.alreadyExistsInTarget, false);
    assert.equal(bank.chunkPluginId, 1316377392);
    assert.equal(bank.chunkPluginFourCc, 'NvS0');
    assert.equal(bank.isConcordant, true);
    assert.equal(bank.matchedWizardName, 'V-Station Demo');
  });

  it('inspecciona MDAPiano.vfxlibrary correctamente', async () => {
    const result = await service.inspect({
      packagePath: MDA_PIANO_DIR,
      targetLibraryRoot: STORAGE_DIR,
    });

    assert.equal(result.resolvedKind, 'vfxlibrary');
    assert.equal(result.plugins.length, 1);
    const plugin = result.plugins[0]!;
    assert.equal(plugin.name, 'mda Piano');
    assert.equal(plugin.dllName, 'mda Piano.dll');
    assert.equal(plugin.hasVfxinfo, true);

    assert.equal(result.banks.length, 1);
    const bank = result.banks[0]!;
    assert.equal(bank.name, '000_MDA Piano.vfxbank');
    assert.equal(bank.presetCount, 1);
  });

  it('detecta colisiones si el plugin o banco ya existen en la librería destino', async () => {
    // Si pasamos storage como destino y storage como origen
    const result = await service.inspect({
      packagePath: STORAGE_DIR,
      targetLibraryRoot: STORAGE_DIR,
    });

    assert.ok(result.plugins.length > 5);
    const fsynthz = result.plugins.find((p) => p.name === 'FSynthz-15');
    assert.ok(fsynthz);
    assert.equal(fsynthz.alreadyExistsInTarget, true);
  });

  it('importa instrumentos y bancos a una librería temporal con políticas skip y overwrite', async () => {
    const tempTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-import-target-'));

    try {
      // 1. Primera importación limpia
      const res1 = await service.importPackage({
        packagePath: NOVATION_DEMO_DIR,
        targetLibraryRoot: tempTarget,
        collisionPolicy: 'skip',
      });

      assert.deepEqual(res1.importedPlugins, ['V-Station Demo']);
      assert.deepEqual(res1.importedBanks, ['000_Novation V-Station demo.vfxbank']);
      assert.equal(res1.skippedPlugins.length, 0);
      assert.equal(res1.skippedBanks.length, 0);

      // Comprobar archivos en destino
      const pluginDll = path.join(tempTarget, 'plugs', 'V-Station Demo', 'V-Station.dll');
      const vfxinfo = path.join(tempTarget, 'plugs', 'V-Station Demo', 'vfxinfo.txt');
      const logFile = path.join(tempTarget, 'plugs', 'V-Station Demo', 'fxbLoader.log');
      const bankDir = path.join(tempTarget, 'banks', '000_Novation V-Station demo.vfxbank');

      assert.ok(await fs.stat(pluginDll));
      assert.ok(await fs.stat(vfxinfo));
      assert.ok(await fs.stat(logFile));
      assert.ok(await fs.stat(bankDir));

      // El log del plugin debe registrar la importación
      const logContent = await fs.readFile(logFile, 'utf8');
      assert.ok(logContent.includes('[import]'));
      assert.ok(logContent.includes('Instrumento importado'));

      // 2. Segunda importación con policy 'skip' -> omite
      const res2 = await service.importPackage({
        packagePath: NOVATION_DEMO_DIR,
        targetLibraryRoot: tempTarget,
        collisionPolicy: 'skip',
      });

      assert.equal(res2.importedPlugins.length, 0);
      assert.equal(res2.importedBanks.length, 0);
      assert.equal(res2.skippedPlugins.length, 1);
      assert.equal(res2.skippedBanks.length, 1);
      assert.equal(res2.skippedPlugins[0]!.name, 'V-Station Demo');

      // 3. Tercera importación con policy 'overwrite' -> reemplaza
      const res3 = await service.importPackage({
        packagePath: NOVATION_DEMO_DIR,
        targetLibraryRoot: tempTarget,
        collisionPolicy: 'overwrite',
      });

      assert.deepEqual(res3.importedPlugins, ['V-Station Demo']);
      assert.deepEqual(res3.importedBanks, ['000_Novation V-Station demo.vfxbank']);
      assert.equal(res3.skippedPlugins.length, 0);
    } finally {
      await fs.rm(tempTarget, { recursive: true, force: true });
    }
  });

  it('audita import, association-change y collision enlazados por packageSource', async () => {
    const tempTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-audit-import-'));

    try {
      const service2 = new LibraryImportService(
        new PluginLogService(),
        wizardService,
        new AssociationAuditService(),
      );
      // 1. Primera importación: sin colisiones, con association-change inicial
      await service2.importPackage({
        packagePath: NOVATION_DEMO_DIR,
        targetLibraryRoot: tempTarget,
        collisionPolicy: 'skip',
      });

      const audit = new AssociationAuditService();
      const snap1 = await audit.read(tempTarget);
      assert.ok(snap1.exists);
      const kinds1 = snap1.entries.map((entry) => entry.kind);
      assert.ok(kinds1.includes('import'), `falta 'import': ${kinds1}`);
      assert.ok(kinds1.includes('association-change'), `falta 'association-change': ${kinds1}`);
      const importEvent = snap1.entries.find((entry) => entry.kind === 'import')!;
      assert.equal(importEvent.packageSource, NOVATION_DEMO_DIR);
      assert.deepEqual(importEvent.repairedBanks, []);
      const associationChange = snap1.entries.find(
        (entry) => entry.kind === 'association-change',
      )!;
      assert.equal(associationChange.plugin, 'V-Station Demo');
      assert.equal(associationChange.previousValue, null);
      assert.equal(associationChange.packageSource, NOVATION_DEMO_DIR);

      // 2. Reimportación con 'skip': collision con la política, sin cambios de asociación
      await service2.importPackage({
        packagePath: NOVATION_DEMO_DIR,
        targetLibraryRoot: tempTarget,
        collisionPolicy: 'skip',
      });
      const snap2 = await audit.read(tempTarget);
      const collisions = snap2.entries.filter((entry) => entry.kind === 'collision');
      // Dos colisiones: un plugin y un banco
      assert.equal(collisions.length, 2);
      assert.ok(collisions.every((entry) => entry.collisionPolicy === 'skip'));
      assert.ok(
        collisions.every(
          (entry) => entry.packageSource === NOVATION_DEMO_DIR,
        ),
      );
      assert.deepEqual(
        collisions[0]!.collisionNames,
        ['V-Station Demo'],
      );

      // 3. Reimportación con 'overwrite': kind reimport y previousValue real desde disco
      await service2.importPackage({
        packagePath: NOVATION_DEMO_DIR,
        targetLibraryRoot: tempTarget,
        collisionPolicy: 'overwrite',
      });
      const snap3 = await audit.read(tempTarget);
      const reimports = snap3.entries.filter((entry) => entry.kind === 'reimport');
      assert.equal(reimports.length, 1);
      const overwriteChange = snap3.entries.filter(
        (entry) => entry.kind === 'association-change' && entry.previousValue !== null,
      );
      assert.ok(
        overwriteChange.length >= 1,
        'el overwrite registra el dado y cambia real (previousValue desde disco)',
      );
    } finally {
      await fs.rm(tempTarget, { recursive: true, force: true });
    }
  });

  it('inspecciona recursivamente la raíz y encuentra múltiples librerías y plugins candidatos', async () => {
    const result = await service.inspect({
      packagePath: BANKS_ROOT,
      targetLibraryRoot: STORAGE_DIR,
    });

    assert.equal(result.resolvedKind, 'vfxlibrary');
    assert.ok(result.plugins.length >= 2, `Se esperaban al menos 2 plugins, encontrados: ${result.plugins.length}`);
    const vstation = result.plugins.find((p) => p.name === 'V-Station Demo');
    const mdapiano = result.plugins.find((p) => p.name === 'mda Piano');
    assert.ok(vstation, 'Debe encontrar V-Station Demo');
    assert.ok(mdapiano, 'Debe encontrar mda Piano');
    assert.ok(vstation.packageSource, 'Debe incluir la procedencia del paquete');
    assert.ok(mdapiano.packageSource, 'Debe incluir la procedencia del paquete');
    assert.ok(result.banks.length >= 2, 'Debe encontrar bancos de ambos paquetes');
  });

  it('inspecciona una subcarpeta anidada (.vfxlibrary dentro de .vfxlibrary) directamente', async () => {
    const nestedDir = path.join(NOVATION_DEMO_DIR, 'Novation V-Station demo.vfxlibrary');
    const result = await service.inspect({
      packagePath: nestedDir,
      targetLibraryRoot: STORAGE_DIR,
    });

    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.name, 'V-Station Demo');
    assert.equal(result.banks.length, 1);
    assert.equal(result.banks[0]!.name, '000_Novation V-Station demo.vfxbank');
  });

  it('permite seleccionar e importar múltiples plugins a la vez desde un escaneo recursivo', async () => {
    const tempTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-multi-target-'));

    try {
      const result = await service.importPackage({
        packagePath: BANKS_ROOT,
        targetLibraryRoot: tempTarget,
        selectedPlugins: ['V-Station Demo', 'mda Piano'],
        selectedBanks: ['000_Novation V-Station demo.vfxbank', '000_MDA Piano.vfxbank'],
        collisionPolicy: 'skip',
      });

      assert.ok(result.importedPlugins.includes('V-Station Demo'));
      assert.ok(result.importedPlugins.includes('mda Piano'));
      assert.ok(result.importedBanks.includes('000_Novation V-Station demo.vfxbank'));
      assert.ok(result.importedBanks.includes('000_MDA Piano.vfxbank'));

      assert.ok(await fs.stat(path.join(tempTarget, 'plugs', 'V-Station Demo')));
      assert.ok(await fs.stat(path.join(tempTarget, 'plugs', 'mda Piano')));
      assert.ok(await fs.stat(path.join(tempTarget, 'banks', '000_Novation V-Station demo.vfxbank')));
      assert.ok(await fs.stat(path.join(tempTarget, 'banks', '000_MDA Piano.vfxbank')));
    } finally {
      await fs.rm(tempTarget, { recursive: true, force: true });
    }
  });

  it('inspecciona paquetes sin plugs/ como kvr TruePianos con vfxinfo en subcarpeta', async () => {
    const kvrDir = path.join(BANKS_ROOT, 'kvr_196229_2627_4FrontTruePianosTrial');
    const result = await service.inspect({
      packagePath: kvrDir,
      targetLibraryRoot: STORAGE_DIR,
    });

    assert.equal(result.plugins.length, 1);
    const plug = result.plugins[0]!;
    assert.equal(plug.name, '4Front-TruePianos');
    assert.equal(plug.hasVfxinfo, true);
    assert.equal(plug.dllName, null);
  });

  it('detecta plugins anidados profundamente dentro de plugs/Vendor/Plugin', async () => {
    const tempPkg = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-deep-pkg-'));
    try {
      const nestedPlugDir = path.join(tempPkg, 'plugs', 'AcmeCorp', 'SuperSynth');
      await fs.mkdir(nestedPlugDir, { recursive: true });
      await fs.writeFile(path.join(nestedPlugDir, 'SuperSynth.dll'), 'dummy-dll');
      await fs.writeFile(path.join(nestedPlugDir, 'vfxinfo.txt'), 'id: 9999\nname: Super Synth\n');

      const result = await service.inspect({
        packagePath: tempPkg,
        targetLibraryRoot: STORAGE_DIR,
      });

      assert.equal(result.resolvedKind, 'vfxlibrary');
      assert.equal(result.plugins.length, 1);
      assert.equal(result.plugins[0]!.name, 'SuperSynth');
      assert.equal(result.plugins[0]!.dllName, 'SuperSynth.dll');
      assert.equal(result.plugins[0]!.vfxinfoId, 9999);
    } finally {
      await fs.rm(tempPkg, { recursive: true, force: true });
    }
  });
});
