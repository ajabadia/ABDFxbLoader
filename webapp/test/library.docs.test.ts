import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pe32Dll, peWithExportsDll } from './helpers/pe';
import {
  LIBRARY_BANK_EXAMPLE,
  LIBRARY_BANKS_LIST_EXAMPLE,
  LIBRARY_BATCH_DRY_RUN_EXAMPLE,
  LIBRARY_BATCH_EXAMPLE,
  LIBRARY_DISCARD_BACKUP_EXAMPLE,
  LIBRARY_EXPORT_EXAMPLE,
  LIBRARY_EXPORT_TARGET_EXISTS_EXAMPLE,
  LIBRARY_IMPORT_EXAMPLE,
  LIBRARY_IMPORT_REJECTED_EXAMPLE,
  LIBRARY_INSPECT_EXAMPLE,
  LIBRARY_INSPECT_WITHOUT_PLUGIN_EXAMPLE,
  LIBRARY_LOADER_ADD_CONFLICT_EXAMPLE,
  LIBRARY_LOADER_ADD_DRY_RUN_EXAMPLE,
  LIBRARY_LOADER_ADD_EXAMPLE,
  LIBRARY_RESTORE_EXAMPLE,
  LIBRARY_RESTORE_UNCHANGED_EXAMPLE,
  LIBRARY_SCAN_EXAMPLE,
  LIBRARY_SCAN_PATH_ERROR_EXAMPLE,
  LIBRARY_LOADER_REMOVE_CONFLICT_EXAMPLE,
  LIBRARY_LOADER_REMOVE_EXAMPLE,
  LIBRARY_CREATE_CUSTOM_PLUGIN_RESPONSE_EXAMPLE,
  LIBRARY_INSPECT_DLL_RESPONSE_EXAMPLE,
} from '../src/library/library.dto';
import { LIBRARY_AUDIT_EXAMPLE } from '../src/library/library-audit.dto';
import { buildBank } from './helpers/fxb-bank';

// Los descartes de esta suite borran directo a disco: no se debe llenar la
// Papelera real con cada corrida. El mensaje real lo cubre `trash.test.ts`,
// que sí usa la papelera del sistema.
process.env['FXB_TRASH_MODE'] = 'direct';

/**
 * Los ejemplos de Swagger no son decoración: se ejecutan contra la API real y
 * se compara la forma de la respuesta. Así, si un endpoint gana o pierde
 * campos, el ejemplo deja de coincidir y el test falla.
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

function actionKinds(value: { actions: { kind: string }[] }): string[] {
  return value.actions.map((action) => action.kind);
}

async function library(t: TestContext): Promise<{ root: string; dll: string; banks: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-docs-'));
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

  // El cargador de los ejemplos es un PE32 i386 válido.
  const dll = path.join(root, 'loader.dll');
  await writeFile(dll, pe32Dll());

  const banks = path.join(root, 'banks');
  await mkdir(banks);
  return { root, dll, banks };
}

test('los ejemplos de /library coinciden con las respuestas reales', async (t) => {
  const data = await library(t);

  const scan = await http().post('/library/scan').send({ libraryRoot: data.root }).expect(200);
  assertSameKeys(scan.body, LIBRARY_SCAN_EXAMPLE, 'scan 200');
  assertSameKeys(scan.body.plugins[0], LIBRARY_SCAN_EXAMPLE.plugins[0]!, 'scan 200: plugin');

  const audited = await http().post('/library/audit').send({ libraryRoot: data.root }).expect(200);
  assertSameKeys(audited.body, LIBRARY_AUDIT_EXAMPLE, 'audit 200');
  assertSameKeys(audited.body.plugins[0], LIBRARY_AUDIT_EXAMPLE.plugins[0]!, 'audit 200: plugin');
  assertSameKeys(
    audited.body.plugins[0].dll,
    LIBRARY_AUDIT_EXAMPLE.plugins[0]!.dll,
    'audit 200: DLL',
  );
  assertSameKeys(
    audited.body.plugins[0].issues[0],
    LIBRARY_AUDIT_EXAMPLE.plugins[0]!.issues[0]!,
    'audit 200: hueco',
  );
  assertSameKeys(
    audited.body.plugins[0].proposals[0],
    LIBRARY_AUDIT_EXAMPLE.plugins[0]!.proposals[0]!,
    'audit 200: propuesta',
  );
  const auditRelative = await http()
    .post('/library/audit')
    .send({ libraryRoot: 'libreria' })
    .expect(400);
  assertSameKeys(auditRelative.body, LIBRARY_SCAN_PATH_ERROR_EXAMPLE, 'audit 400');

  const dry = await http()
    .post('/library/loader/add')
    .send({ libraryRoot: data.root, plugin: 'Synth', dllSourcePath: data.dll, dryRun: true })
    .expect(200);
  assertSameKeys(dry.body, LIBRARY_LOADER_ADD_DRY_RUN_EXAMPLE, 'install dryRun 200');
  assert.deepEqual(actionKinds(dry.body), actionKinds(LIBRARY_LOADER_ADD_DRY_RUN_EXAMPLE));
  assertSameKeys(dry.body.actions[0], LIBRARY_LOADER_ADD_DRY_RUN_EXAMPLE.actions[0]!, 'install dryRun: acción');

  const installed = await http()
    .post('/library/loader/add')
    .send({ libraryRoot: data.root, plugin: 'Synth', dllSourcePath: data.dll })
    .expect(200);
  assertSameKeys(installed.body, LIBRARY_LOADER_ADD_EXAMPLE, 'install 200');
  assert.deepEqual(actionKinds(installed.body), actionKinds(LIBRARY_LOADER_ADD_EXAMPLE));

  const conflict = await http()
    .post('/library/loader/add')
    .send({ libraryRoot: data.root, plugin: 'Synth', dllSourcePath: data.dll })
    .expect(409);
  assertSameKeys(conflict.body, LIBRARY_LOADER_ADD_CONFLICT_EXAMPLE, 'install 409');

  // El lote responde 200 con el resultado de cada plugin (uno bien y otro fallido).
  const batched = await http()
    .post('/library/batch')
    .send({
      libraryRoot: data.root,
      action: 'add',
      plugins: ['Synth', 'NoExiste'],
      dllSourcePath: data.dll,
      force: true,
    })
    .expect(200);
  assertSameKeys(batched.body, LIBRARY_BATCH_EXAMPLE, 'batch 200');
  assertSameKeys(batched.body.results[0], LIBRARY_BATCH_EXAMPLE.results[0]!, 'batch 200: resultado');
  assertSameKeys(batched.body.results[1], LIBRARY_BATCH_EXAMPLE.results[1]!, 'batch 200: fallo');
  assert.deepEqual(actionKinds(batched.body.results[0]), actionKinds(LIBRARY_BATCH_EXAMPLE.results[0]!));
  assert.equal(batched.body.results[0].status, 'added');
  assert.equal(batched.body.results[1].status, 'failed');
  assert.equal(batched.body.results[1].entry, null);

  const batchDry = await http()
    .post('/library/batch')
    .send({
      libraryRoot: data.root,
      action: 'add',
      plugins: ['Synth'],
      dllSourcePath: data.dll,
      force: true,
      dryRun: true,
    })
    .expect(200);
  assertSameKeys(batchDry.body, LIBRARY_BATCH_DRY_RUN_EXAMPLE, 'batch dryRun 200');
  assertSameKeys(
    batchDry.body.results[0],
    LIBRARY_BATCH_DRY_RUN_EXAMPLE.results[0]!,
    'batch dryRun: resultado',
  );
  assert.deepEqual(
    actionKinds(batchDry.body.results[0]),
    actionKinds(LIBRARY_BATCH_DRY_RUN_EXAMPLE.results[0]!),
  );
  assert.equal(batchDry.body.results[0].status, 'planned');

  const bank = path.join(data.banks, 'Rhodes.fxb');
  await writeFile(bank, buildBank({ uniqueId: 'MySy', programs: 1 }));

  const imported = await http()
    .post('/library/banks/import')
    .send({
      libraryRoot: data.root,
      plugin: 'Synth',
      sourcePaths: [bank],
      expectedUniqueId: 'MySy',
    })
    .expect(200);
  assertSameKeys(imported.body, LIBRARY_IMPORT_EXAMPLE, 'import 200');
  assertSameKeys(imported.body.results[0], LIBRARY_IMPORT_EXAMPLE.results[0]!, 'import 200: resultado');
  assertSameKeys(imported.body.results[0].bank, LIBRARY_BANK_EXAMPLE, 'import 200: banco');
  // El ejemplo declara un programa con un parámetro: 156 + 60 - 8 = 208.
  assert.equal(imported.body.results[0].bank.byteSize, LIBRARY_BANK_EXAMPLE.byteSize);

  const listed = await http()
    .post('/library/banks/list')
    .send({ libraryRoot: data.root, plugin: 'Synth' })
    .expect(200);
  assertSameKeys(listed.body, LIBRARY_BANKS_LIST_EXAMPLE, 'banks/list 200');
  assertSameKeys(listed.body.banks[0], LIBRARY_BANKS_LIST_EXAMPLE.banks[0]!, 'banks/list: banco');
  assertSameKeys(listed.body.config, LIBRARY_BANKS_LIST_EXAMPLE.config, 'banks/list: config');
  assertSameKeys(
    listed.body.config.config,
    LIBRARY_BANKS_LIST_EXAMPLE.config.config,
    'banks/list: valores de config',
  );

  const inspected = await http()
    .post('/library/banks/inspect')
    .send({ sourcePath: bank, libraryRoot: data.root, plugin: 'Synth' })
    .expect(200);
  assertSameKeys(inspected.body, LIBRARY_INSPECT_EXAMPLE, 'inspect 200');
  assertSameKeys(inspected.body.bank, LIBRARY_BANK_EXAMPLE, 'inspect 200: banco');
  assertSameKeys(
    inspected.body.existingBanks[0],
    LIBRARY_INSPECT_EXAMPLE.existingBanks[0]!,
    'inspect 200: banco existente',
  );

  const inspectedOnly = await http()
    .post('/library/banks/inspect')
    .send({ sourcePath: bank })
    .expect(200);
  assertSameKeys(inspectedOnly.body, LIBRARY_INSPECT_WITHOUT_PLUGIN_EXAMPLE, 'inspect sin plugin');

  // El export convierte el banco importado y deja el original intacto.
  const exported = await http()
    .post('/library/banks/export')
    .send({ libraryRoot: data.root, plugin: 'Synth', fileName: 'Rhodes.fxb', endianness: 'big' })
    .expect(200);
  assertSameKeys(exported.body, LIBRARY_EXPORT_EXAMPLE, 'banks/export 200');
  assertSameKeys(exported.body.source, LIBRARY_EXPORT_EXAMPLE.source, 'banks/export: origen');
  assertSameKeys(exported.body.target, LIBRARY_EXPORT_EXAMPLE.target, 'banks/export: destino');
  assertSameKeys(exported.body.source.bank, LIBRARY_BANK_EXAMPLE, 'banks/export: banco original');
  assertSameKeys(exported.body.target.bank, LIBRARY_BANK_EXAMPLE, 'banks/export: banco convertido');
  assert.equal(exported.body.source.bank.endianness, 'little');
  assert.equal(exported.body.target.bank.endianness, 'big');
  assert.equal(exported.body.changed, true);

  const existingTarget = await http()
    .post('/library/banks/export')
    .send({ libraryRoot: data.root, plugin: 'Synth', fileName: 'Rhodes.fxb', endianness: 'big' })
    .expect(409);
  assertSameKeys(existingTarget.body, LIBRARY_EXPORT_TARGET_EXISTS_EXAMPLE, 'banks/export 409');

  // El banco por defecto se convierte y luego vuelve a su `.orig`, que queda
  // intacto: la segunda restauración ya no escribe nada.
  const configPath = path.join(data.root, 'plugs', 'Synth', 'fxbLoader.config');
  await http()
    .put('/fxb-config')
    .send({
      pluginDir: path.join(data.root, 'plugs', 'Synth'),
      expectedMtimeMs: (await stat(configPath)).mtimeMs,
      config: { defaultFxbName: 'Rhodes.fxb', pluginName: 'Synth.dll' },
    })
    .expect(200);
  await http()
    .post('/library/banks/convert')
    .send({ libraryRoot: data.root, plugin: 'Synth' })
    .expect(200);

  const restoredBody = await http()
    .post('/library/banks/restore')
    .send({ libraryRoot: data.root, plugin: 'Synth' })
    .expect(200);
  assertSameKeys(restoredBody.body, LIBRARY_RESTORE_EXAMPLE, 'banks/restore 200');
  assertSameKeys(restoredBody.body.restored, LIBRARY_RESTORE_EXAMPLE.restored, 'banks/restore: banco');
  assertSameKeys(restoredBody.body.backup, LIBRARY_RESTORE_EXAMPLE.backup, 'banks/restore: respaldo');
  assertSameKeys(
    restoredBody.body.restored.bank,
    LIBRARY_BANK_EXAMPLE,
    'banks/restore: cabecera del banco',
  );
  assert.equal(restoredBody.body.changed, true);

  const restoredAgain = await http()
    .post('/library/banks/restore')
    .send({ libraryRoot: data.root, plugin: 'Synth' })
    .expect(200);
  assertSameKeys(restoredAgain.body, LIBRARY_RESTORE_UNCHANGED_EXAMPLE, 'banks/restore 200 repetido');
  assert.equal(restoredAgain.body.changed, false);

  // Descartar el respaldo: el banco queda igual y el `.orig` va a la papelera.
  const discardedBody = await http()
    .post('/library/banks/discard-backup')
    .send({ libraryRoot: data.root, plugin: 'Synth' })
    .expect(200);
  assertSameKeys(discardedBody.body, LIBRARY_DISCARD_BACKUP_EXAMPLE, 'banks/discard-backup 200');
  assertSameKeys(
    discardedBody.body.discarded,
    LIBRARY_DISCARD_BACKUP_EXAMPLE.discarded,
    'banks/discard-backup: respaldo',
  );
  assertSameKeys(
    discardedBody.body.trash,
    LIBRARY_DISCARD_BACKUP_EXAMPLE.trash,
    'banks/discard-backup: papelera',
  );
  assert.match(discardedBody.body.trash.hint, /recuperarlo|Restaurar|Volver a poner/);

  const foreign = path.join(data.banks, 'Otro.fxb');
  await writeFile(foreign, buildBank({ uniqueId: 'OtSy', programs: 1 }));

  const rejected = await http()
    .post('/library/banks/import')
    .send({
      libraryRoot: data.root,
      plugin: 'Synth',
      sourcePaths: [foreign],
      expectedUniqueId: 'MySy',
    })
    .expect(422);
  assertSameKeys(rejected.body, LIBRARY_IMPORT_REJECTED_EXAMPLE, 'import 422');
  assertSameKeys(
    rejected.body.results[0],
    LIBRARY_IMPORT_REJECTED_EXAMPLE.results[0]!,
    'import 422: resultado',
  );
  assert.equal(
    rejected.body.results[0].reason,
    LIBRARY_IMPORT_REJECTED_EXAMPLE.results[0]!.reason,
    'el motivo del rechazo del ejemplo debe ser el real',
  );
  assert.equal(
    rejected.body.results[0].bank.uniqueIdValue,
    LIBRARY_IMPORT_REJECTED_EXAMPLE.results[0]!.bank.uniqueIdValue,
  );

  const uninstalled = await http()
    .post('/library/loader/remove')
    .send({ libraryRoot: data.root, plugin: 'Synth' })
    .expect(200);
  assertSameKeys(uninstalled.body, LIBRARY_LOADER_REMOVE_EXAMPLE, 'uninstall 200');
  assert.deepEqual(actionKinds(uninstalled.body), actionKinds(LIBRARY_LOADER_REMOVE_EXAMPLE));

  const uninstallConflict = await http()
    .post('/library/loader/remove')
    .send({ libraryRoot: data.root, plugin: 'Synth' })
    .expect(409);
  assertSameKeys(uninstallConflict.body, LIBRARY_LOADER_REMOVE_CONFLICT_EXAMPLE, 'uninstall 409');

  const badRoot = await http().post('/library/scan').send({ libraryRoot: 'plugs' }).expect(400);
  assert.deepEqual(badRoot.body, LIBRARY_SCAN_PATH_ERROR_EXAMPLE);

  const notFound = await http()
    .post('/library/loader/add')
    .send({ libraryRoot: data.root, plugin: 'NoExiste', dllSourcePath: data.dll })
    .expect(404);
  assertSameKeys(notFound.body, LIBRARY_SCAN_PATH_ERROR_EXAMPLE, 'install 404');
});

test('los ejemplos de inspect-dll y create-custom-plugin coinciden con las respuestas reales', async (t) => {
  const data = await library(t);

  // La inspección lee una DLL real con exportaciones VST de 32 bits.
  const probe = path.join(data.root, 'Probe.dll');
  await writeFile(probe, peWithExportsDll(['VSTPluginMain'], { internalName: 'Probe.dll' }));

  const inspected = await http().post('/library/inspect-dll').send({ dllPath: probe }).expect(200);
  assertSameKeys(inspected.body, LIBRARY_INSPECT_DLL_RESPONSE_EXAMPLE, 'inspect-dll 200');
  assert.equal(inspected.body.validPe, LIBRARY_INSPECT_DLL_RESPONSE_EXAMPLE.validPe);
  assert.equal(inspected.body.bitness, LIBRARY_INSPECT_DLL_RESPONSE_EXAMPLE.bitness);
  assert.equal(inspected.body.is32BitCompatible, LIBRARY_INSPECT_DLL_RESPONSE_EXAMPLE.is32BitCompatible);
  assert.equal(inspected.body.isVstPlugin, LIBRARY_INSPECT_DLL_RESPONSE_EXAMPLE.isVstPlugin);
  assert.equal(inspected.body.vstEntrypoint, LIBRARY_INSPECT_DLL_RESPONSE_EXAMPLE.vstEntrypoint);
  assert.equal(inspected.body.internalDllName, 'Probe.dll');
  assert.deepEqual(inspected.body.exportedNames, LIBRARY_INSPECT_DLL_RESPONSE_EXAMPLE.exportedNames);
  assert.equal(inspected.body.matchingWizard, LIBRARY_INSPECT_DLL_RESPONSE_EXAMPLE.matchingWizard);

  const missingDll = await http()
    .post('/library/inspect-dll')
    .send({ dllPath: path.join(data.root, 'no-existe.dll') })
    .expect(404);
  assert.deepEqual(Object.keys(missingDll.body), ['message'], 'inspect-dll 404: sin sobre de Nest');
  assert.match(missingDll.body.message, /No existe el archivo DLL/);

  // El alta usa una DLL VST válida fuera de la librería.
  const custom = path.join(data.root, 'Custom.dll');
  await writeFile(custom, peWithExportsDll(['VSTPluginMain'], { internalName: 'Custom.dll' }));

  const payload = {
    libraryRoot: data.root,
    sourceDllPath: custom,
    folderName: 'Custom',
    name: 'Custom Synth',
    id: 'Cust',
    isSynth: true,
    vendor: 'ABD',
    genre: 'Synth',
  };

  const created = await http().post('/library/create-custom-plugin').send(payload).expect(200);
  assertSameKeys(created.body, LIBRARY_CREATE_CUSTOM_PLUGIN_RESPONSE_EXAMPLE, 'create-custom-plugin 200');
  assert.equal(created.body.created, LIBRARY_CREATE_CUSTOM_PLUGIN_RESPONSE_EXAMPLE.created);
  assert.equal(created.body.pluginDir, path.join(data.root, 'plugs', 'Custom'));
  assert.equal(created.body.dllRelativePath, 'Custom/Custom.dll');
  assert.equal(created.body.wizardPath, LIBRARY_CREATE_CUSTOM_PLUGIN_RESPONSE_EXAMPLE.wizardPath);
  assert.deepEqual(created.body.warnings, LIBRARY_CREATE_CUSTOM_PLUGIN_RESPONSE_EXAMPLE.warnings);

  const conflict = await http().post('/library/create-custom-plugin').send(payload).expect(409);
  assert.deepEqual(Object.keys(conflict.body), ['message'], 'create-custom-plugin 409: sin sobre de Nest');
  assert.match(conflict.body.message, /Ya existe una carpeta para el plugin/);

  const missingSource = await http()
    .post('/library/create-custom-plugin')
    .send({ ...payload, folderName: 'Otro', sourceDllPath: path.join(data.root, 'no-existe.dll') })
    .expect(404);
  assert.deepEqual(Object.keys(missingSource.body), ['message'], 'create-custom-plugin 404: sin sobre');
  assert.match(missingSource.body.message, /No existe el archivo DLL origen/);

  const invalidFolder = await http()
    .post('/library/create-custom-plugin')
    .send({ ...payload, folderName: '../Evil' })
    .expect(400);
  assert.deepEqual(Object.keys(invalidFolder.body), ['message'], 'create-custom-plugin 400: sin sobre');
  assert.match(invalidFolder.body.message, /folderName/);
});
