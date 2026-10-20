import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pe32Dll } from './helpers/pe';
import {
  LIBRARY_BANK_EXAMPLE,
  LIBRARY_BANKS_LIST_EXAMPLE,
  LIBRARY_IMPORT_EXAMPLE,
  LIBRARY_IMPORT_REJECTED_EXAMPLE,
  LIBRARY_INSPECT_EXAMPLE,
  LIBRARY_INSPECT_WITHOUT_PLUGIN_EXAMPLE,
  LIBRARY_INSTALL_CONFLICT_EXAMPLE,
  LIBRARY_INSTALL_DRY_RUN_EXAMPLE,
  LIBRARY_INSTALL_EXAMPLE,
  LIBRARY_SCAN_EXAMPLE,
  LIBRARY_SCAN_PATH_ERROR_EXAMPLE,
  LIBRARY_UNINSTALL_CONFLICT_EXAMPLE,
  LIBRARY_UNINSTALL_EXAMPLE,
} from '../src/library/library.dto';
import { buildBank } from './helpers/fxb-bank';

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

  const dry = await http()
    .post('/library/install')
    .send({ libraryRoot: data.root, plugin: 'Synth', dllSourcePath: data.dll, dryRun: true })
    .expect(200);
  assertSameKeys(dry.body, LIBRARY_INSTALL_DRY_RUN_EXAMPLE, 'install dryRun 200');
  assert.deepEqual(actionKinds(dry.body), actionKinds(LIBRARY_INSTALL_DRY_RUN_EXAMPLE));
  assertSameKeys(dry.body.actions[0], LIBRARY_INSTALL_DRY_RUN_EXAMPLE.actions[0]!, 'install dryRun: acción');

  const installed = await http()
    .post('/library/install')
    .send({ libraryRoot: data.root, plugin: 'Synth', dllSourcePath: data.dll })
    .expect(200);
  assertSameKeys(installed.body, LIBRARY_INSTALL_EXAMPLE, 'install 200');
  assert.deepEqual(actionKinds(installed.body), actionKinds(LIBRARY_INSTALL_EXAMPLE));

  const conflict = await http()
    .post('/library/install')
    .send({ libraryRoot: data.root, plugin: 'Synth', dllSourcePath: data.dll })
    .expect(409);
  assertSameKeys(conflict.body, LIBRARY_INSTALL_CONFLICT_EXAMPLE, 'install 409');

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
    .post('/library/uninstall')
    .send({ libraryRoot: data.root, plugin: 'Synth' })
    .expect(200);
  assertSameKeys(uninstalled.body, LIBRARY_UNINSTALL_EXAMPLE, 'uninstall 200');
  assert.deepEqual(actionKinds(uninstalled.body), actionKinds(LIBRARY_UNINSTALL_EXAMPLE));

  const uninstallConflict = await http()
    .post('/library/uninstall')
    .send({ libraryRoot: data.root, plugin: 'Synth' })
    .expect(409);
  assertSameKeys(uninstallConflict.body, LIBRARY_UNINSTALL_CONFLICT_EXAMPLE, 'uninstall 409');

  const badRoot = await http().post('/library/scan').send({ libraryRoot: 'plugs' }).expect(400);
  assert.deepEqual(badRoot.body, LIBRARY_SCAN_PATH_ERROR_EXAMPLE);

  const notFound = await http()
    .post('/library/install')
    .send({ libraryRoot: data.root, plugin: 'NoExiste', dllSourcePath: data.dll })
    .expect(404);
  assertSameKeys(notFound.body, LIBRARY_SCAN_PATH_ERROR_EXAMPLE, 'install 404');
});
