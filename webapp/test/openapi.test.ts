import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { OpenAPIObject } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import {
  FXB_CONFIG_CONFLICT_EXAMPLE,
  FXB_CONFIG_SNAPSHOT_EXAMPLE,
} from '../src/fxb-config/fxb-config.dto';
import {
  LIBRARY_BANKS_LIST_EXAMPLE,
  LIBRARY_IMPORT_EXAMPLE,
  LIBRARY_IMPORT_REJECTED_EXAMPLE,
  LIBRARY_INSPECT_EXAMPLE,
  LIBRARY_INCOMPATIBLE_ERROR_EXAMPLE,
  LIBRARY_INSPECT_WITHOUT_PLUGIN_EXAMPLE,
  LIBRARY_INSTALL_CONFLICT_EXAMPLE,
  LIBRARY_INSTALL_DRY_RUN_EXAMPLE,
  LIBRARY_INSTALL_EXAMPLE,
  LIBRARY_SCAN_EXAMPLE,
  LIBRARY_UNINSTALL_CONFLICT_EXAMPLE,
  LIBRARY_UNINSTALL_EXAMPLE,
  LIBRARY_VFXINFO_ERROR_EXAMPLE,
} from '../src/library/library.dto';
import { MAX_BANKS_PER_REQUEST } from '../src/library/library.service';
import { buildOpenApiDocument } from '../src/swagger';

let app: INestApplication;
let document: OpenAPIObject;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  document = buildOpenApiDocument(app);
});

after(async () => {
  await app?.close();
});

function responses(route: string, method: 'get' | 'post' | 'put') {
  const operation = document.paths[route]?.[method];
  assert.ok(operation, `falta ${method.toUpperCase()} ${route}`);
  return operation.responses;
}

function jsonBody(response: unknown): Record<string, unknown> {
  const content = (response as { content?: Record<string, { example?: unknown; examples?: unknown }> })
    .content?.['application/json'];
  assert.ok(content, 'la respuesta no declara application/json');
  return content as Record<string, unknown>;
}

test('el documento expone los endpoints de fxb-config', () => {
  assert.equal(document.openapi?.startsWith('3.'), true);
  assert.deepEqual(Object.keys(document.paths).sort(), [
    '/fxb-config',
    '/fxb-config/read',
    '/library/banks/import',
    '/library/banks/inspect',
    '/library/banks/list',
    '/library/install',
    '/library/scan',
    '/library/uninstall',
  ]);
  assert.equal(document.paths['/fxb-config/read']?.post?.tags?.[0], 'fxb-config');
});

test('POST /fxb-config/read documenta 200 con ejemplo y 400 con ejemplo', () => {
  const read = responses('/fxb-config/read', 'post');

  const ok = jsonBody(read['200']);
  assert.deepEqual(ok['example'], FXB_CONFIG_SNAPSHOT_EXAMPLE);
  assert.deepEqual((ok['schema'] as { $ref: string }).$ref, '#/components/schemas/FxbConfigSnapshotDto');

  const bad = jsonBody(read['400']);
  assert.deepEqual(bad['example'], {
    message: 'pluginDir debe ser una ruta absoluta: "plugs/MySynth"',
  });
});

test('PUT /fxb-config documenta 200, 400 y 409 con ejemplos', () => {
  const write = responses('/fxb-config', 'put');
  assert.deepEqual(Object.keys(write).sort(), ['200', '400', '409']);

  const ok = jsonBody(write['200']);
  assert.deepEqual(ok['example'], FXB_CONFIG_SNAPSHOT_EXAMPLE);

  const bad = jsonBody(write['400']);
  const examples = bad['examples'] as Record<string, { value: unknown }>;
  assert.deepEqual(Object.keys(examples).sort(), ['rutaInvalida', 'validacion']);
  assert.deepEqual(examples['validacion']!.value, {
    message: 'Configuración no válida',
    issues: ['programDirName: no puede estar vacío'],
  });
  const schema = bad['schema'] as { oneOf?: { $ref: string }[] };
  assert.equal(schema.oneOf?.length, 2);

  const conflict = jsonBody(write['409']);
  assert.deepEqual(conflict['example'], FXB_CONFIG_CONFLICT_EXAMPLE);
  assert.deepEqual(
    (conflict['schema'] as { $ref: string }).$ref,
    '#/components/schemas/FxbConfigConflictErrorDto',
  );
});

test('los esquemas referenciados existen y documentan las cuatro claves', () => {
  const schemas = document.components?.schemas ?? {};
  for (const name of [
    'FxbConfigSnapshotDto',
    'FxbConfigDto',
    'FxbConfigWriteRequestDto',
    'FxbConfigPatchDto',
    'FxbConfigPathErrorDto',
    'FxbConfigValidationErrorDto',
    'FxbConfigConflictErrorDto',
  ]) {
    assert.ok(schemas[name], `falta el esquema ${name}`);
  }

  const config = schemas['FxbConfigDto'] as {
    properties: Record<string, { example?: unknown }>;
  };
  assert.deepEqual(Object.keys(config.properties).sort(), [
    'defaultFxbName',
    'loadFxbBank',
    'pluginName',
    'programDirName',
  ]);
  assert.equal(config.properties['pluginName']?.example, 'MySynth.dll');
});

function requestContent(route: string, method: 'post') {
  const requestBody = document.paths[route]?.[method]?.requestBody as
    | { content?: Record<string, unknown> }
    | undefined;
  const content = requestBody?.content?.['application/json'];
  assert.ok(content, `falta el requestBody de ${method.toUpperCase()} ${route}`);
  return content as {
    schema?: { $ref?: string; oneOf?: { $ref: string }[] };
    examples?: Record<string, { summary?: string; value: unknown }>;
  };
}

test('POST /library/scan documenta cuerpo, 200 y 400', () => {
  const body = requestContent('/library/scan', 'post');
  assert.equal(body.schema?.$ref, '#/components/schemas/LibraryScanRequestDto');
  assert.deepEqual(Object.keys(body.examples ?? {}).sort(), ['conDll', 'libreria']);
  assert.deepEqual(body.examples?.['libreria']?.value, { libraryRoot: 'C:\\VFX\\Library' });
  assert.deepEqual(body.examples?.['conDll']?.value, {
    libraryRoot: 'C:\\VFX\\Library',
    dllSourcePath: 'C:\\fxbLoader\\vst\\fxbLoader.dll',
  });

  const scan = responses('/library/scan', 'post');
  assert.deepEqual(Object.keys(scan).sort(), ['200', '400']);
  assert.equal(document.paths['/library/scan']?.post?.tags?.[0], 'library');

  const ok = jsonBody(scan['200']);
  assert.equal((ok['schema'] as { $ref: string }).$ref, '#/components/schemas/LibraryScanResponseDto');
  assert.deepEqual(ok['example'], LIBRARY_SCAN_EXAMPLE);

  const bad = jsonBody(scan['400']);
  assert.equal((bad['schema'] as { $ref: string }).$ref, '#/components/schemas/LibraryErrorDto');
  assert.deepEqual(Object.keys(bad['examples'] as object).sort(), [
    'dll',
    'rutaRelativa',
    'sinPlugs',
  ]);
});

test('POST /library/install documenta 200 (real y dryRun), 400, 404, 409 y 422', () => {
  const body = requestContent('/library/install', 'post');
  assert.equal(body.schema?.$ref, '#/components/schemas/LibraryInstallRequestDto');
  assert.deepEqual(Object.keys(body.examples ?? {}).sort(), ['instalacion', 'simulacion']);

  const install = responses('/library/install', 'post');
  assert.deepEqual(Object.keys(install).sort(), ['200', '400', '404', '409', '422']);

  const ok = jsonBody(install['200']);
  const okExamples = ok['examples'] as Record<string, { value: unknown }>;
  assert.deepEqual(Object.keys(okExamples).sort(), ['dryRun', 'instalado']);
  assert.deepEqual(okExamples['instalado']!.value, LIBRARY_INSTALL_EXAMPLE);
  assert.deepEqual(okExamples['dryRun']!.value, LIBRARY_INSTALL_DRY_RUN_EXAMPLE);

  assert.deepEqual(
    (jsonBody(install['404'])['example'] as unknown),
    { message: 'no existe el plugin "NoExiste" en C:\\VFX\\Library\\plugs' },
  );

  const conflict = jsonBody(install['409']);
  const schema = conflict['schema'] as { oneOf?: { $ref: string }[] };
  assert.deepEqual(schema.oneOf, [
    { $ref: '#/components/schemas/LibraryConflictErrorDto' },
    { $ref: '#/components/schemas/LibraryErrorDto' },
  ]);
  const conflictExamples = conflict['examples'] as Record<string, { value: Record<string, unknown> }>;
  assert.deepEqual(Object.keys(conflictExamples).sort(), ['configCambiada', 'yaInstalado']);
  assert.deepEqual(conflictExamples['yaInstalado']!.value, LIBRARY_INSTALL_CONFLICT_EXAMPLE);
  assert.deepEqual(conflictExamples['configCambiada']!.value['current'], FXB_CONFIG_SNAPSHOT_EXAMPLE);

  const unprocessable = jsonBody(install['422']);
  const unprocessableExamples = unprocessable['examples'] as Record<
    string,
    { value: unknown }
  >;
  assert.deepEqual(Object.keys(unprocessableExamples).sort(), ['incompatible', 'vfxinfo']);
  assert.deepEqual(unprocessableExamples['vfxinfo']!.value, LIBRARY_VFXINFO_ERROR_EXAMPLE);
  assert.deepEqual(
    unprocessableExamples['incompatible']!.value,
    LIBRARY_INCOMPATIBLE_ERROR_EXAMPLE,
  );
});

test('POST /library/uninstall documenta 200, 400, 404 y 409', () => {
  const body = requestContent('/library/uninstall', 'post');
  assert.equal(body.schema?.$ref, '#/components/schemas/LibraryUninstallRequestDto');
  assert.deepEqual(Object.keys(body.examples ?? {}).sort(), ['desinstalacion', 'simulacion']);

  const uninstall = responses('/library/uninstall', 'post');
  assert.deepEqual(Object.keys(uninstall).sort(), ['200', '400', '404', '409']);

  const okExamples = jsonBody(uninstall['200'])['examples'] as Record<string, { value: unknown }>;
  assert.deepEqual(okExamples['desinstalado']!.value, LIBRARY_UNINSTALL_EXAMPLE);
  assert.deepEqual(jsonBody(uninstall['409'])['example'], LIBRARY_UNINSTALL_CONFLICT_EXAMPLE);
});

test('POST /library/banks/list documenta 200, 400, 404 y 422 sin escribir', () => {
  const body = requestContent('/library/banks/list', 'post');
  assert.equal(body.schema?.$ref, '#/components/schemas/LibraryBanksListRequestDto');
  assert.deepEqual(Object.keys(body.examples ?? {}), ['plugin']);

  const list = responses('/library/banks/list', 'post');
  assert.deepEqual(Object.keys(list).sort(), ['200', '400', '404', '422']);

  const ok = jsonBody(list['200']);
  assert.equal(
    (ok['schema'] as { $ref: string }).$ref,
    '#/components/schemas/LibraryBanksListResponseDto',
  );
  assert.deepEqual(ok['example'], LIBRARY_BANKS_LIST_EXAMPLE);

  assert.equal(
    (jsonBody(list['404'])['schema'] as { $ref: string }).$ref,
    '#/components/schemas/LibraryErrorDto',
  );
  assert.equal(
    (jsonBody(list['422'])['schema'] as { $ref: string }).$ref,
    '#/components/schemas/LibraryErrorDto',
  );
});

test('POST /library/banks/import documenta 200, 400, 404 y 422 con el detalle por archivo', () => {
  const body = requestContent('/library/banks/import', 'post');
  assert.equal(body.schema?.$ref, '#/components/schemas/LibraryBanksImportRequestDto');
  assert.deepEqual(Object.keys(body.examples ?? {}).sort(), ['lote', 'sinReferencia']);

  const importResponses = responses('/library/banks/import', 'post');
  assert.deepEqual(Object.keys(importResponses).sort(), ['200', '400', '404', '422']);
  assert.deepEqual(jsonBody(importResponses['200'])['example'], LIBRARY_IMPORT_EXAMPLE);
  assert.deepEqual(jsonBody(importResponses['422'])['example'], LIBRARY_IMPORT_REJECTED_EXAMPLE);

  const source = jsonBody(importResponses['400'])['examples'] as Record<string, { value: unknown }>;
  assert.deepEqual(Object.keys(source).sort(), ['demasiados', 'rutaRelativa']);
  assert.deepEqual(source['demasiados']!.value, {
    message: `como máximo ${MAX_BANKS_PER_REQUEST} bancos por petición`,
  });
});

test('POST /library/banks/inspect documenta 200, 400, 404 y 422 sin copiar', () => {
  const body = requestContent('/library/banks/inspect', 'post');
  assert.equal(body.schema?.$ref, '#/components/schemas/LibraryBankInspectRequestDto');
  assert.deepEqual(Object.keys(body.examples ?? {}).sort(), ['conPlugin', 'soloArchivo']);

  const inspect = responses('/library/banks/inspect', 'post');
  assert.deepEqual(Object.keys(inspect).sort(), ['200', '400', '404', '422']);

  const ok = jsonBody(inspect['200']);
  assert.equal(
    (ok['schema'] as { $ref: string }).$ref,
    '#/components/schemas/LibraryBankInspectResponseDto',
  );
  const okExamples = ok['examples'] as Record<string, { value: unknown }>;
  assert.deepEqual(Object.keys(okExamples).sort(), ['compatible', 'invalido', 'soloArchivo']);
  assert.deepEqual(okExamples['compatible']!.value, LIBRARY_INSPECT_EXAMPLE);
  assert.deepEqual(okExamples['soloArchivo']!.value, LIBRARY_INSPECT_WITHOUT_PLUGIN_EXAMPLE);

  const bad = jsonBody(inspect['400']);
  assert.deepEqual(Object.keys(bad['examples'] as object).sort(), ['extension', 'inexistente']);

  assert.equal((jsonBody(inspect['404'])['schema'] as { $ref: string }).$ref, '#/components/schemas/LibraryErrorDto');
  assert.equal((jsonBody(inspect['422'])['schema'] as { $ref: string }).$ref, '#/components/schemas/LibraryErrorDto');
});

test('los esquemas de /library existen y encadenan sus referencias', () => {
  const schemas = document.components?.schemas ?? {};
  for (const name of [
    'LibraryScanRequestDto',
    'LibraryScanResponseDto',
    'LibraryInstallRequestDto',
    'LibraryUninstallRequestDto',
    'LibraryBanksImportRequestDto',
    'LibraryBanksImportResponseDto',
    'LibraryBankInspectRequestDto',
    'LibraryBankInspectResponseDto',
    'LibraryBanksListRequestDto',
    'LibraryBanksListResponseDto',
    'PluginBankEntryDto',
    'PluginBankDto',
    'LibraryOperationResponseDto',
    'LibraryActionDto',
    'LoaderDllDto',
    'PluginEntryDto',
    'BankInfoDto',
    'BankReferenceDto',
    'BankImportResultDto',
    'LibraryErrorDto',
    'LibraryConflictErrorDto',
    'LibraryBanksImportErrorDto',
  ]) {
    assert.ok(schemas[name], `falta el esquema ${name}`);
  }

  type Prop = {
    type?: string;
    nullable?: boolean;
    items?: { $ref?: string };
    allOf?: { $ref: string }[];
  };
  const plugin = schemas['PluginEntryDto'] as { properties: Record<string, Prop> };
  assert.deepEqual(Object.keys(plugin.properties).sort(), [
    'compatibilityIssues',
    'compatible',
    'hasVfxinfo',
    'installed',
    'name',
    'path',
    'pluginName',
    'warnings',
  ]);
  assert.equal(plugin.properties['pluginName']?.nullable, true);
  assert.equal(plugin.properties['compatible']?.nullable, true);

  const scan = schemas['LibraryScanResponseDto'] as { properties: Record<string, Prop> };
  assert.equal(scan.properties['plugins']?.type, 'array');
  assert.deepEqual(scan.properties['plugins']?.items, {
    $ref: '#/components/schemas/PluginEntryDto',
  });
  assert.deepEqual(scan.properties['loader']?.allOf, [
    { $ref: '#/components/schemas/LoaderDllDto' },
  ]);

  const loader = schemas['LoaderDllDto'] as { properties: Record<string, Prop> };
  assert.equal(loader.properties['valid']?.type, 'boolean');
  assert.equal(loader.properties['bitness']?.nullable, true);

  const imported = schemas['LibraryBanksImportResponseDto'] as { properties: Record<string, Prop> };
  assert.deepEqual(imported.properties['results']?.items, {
    $ref: '#/components/schemas/BankImportResultDto',
  });
  const reference = imported.properties['reference'] as {
    allOf?: { $ref: string }[];
  };
  assert.deepEqual(reference.allOf, [{ $ref: '#/components/schemas/BankReferenceDto' }]);

  const request = schemas['LibraryBanksImportRequestDto'] as {
    properties: Record<string, { type?: string; items?: { type?: string }; oneOf?: unknown[] }>;
  };
  assert.equal(request.properties['sourcePaths']?.type, 'array');
  assert.deepEqual(request.properties['sourcePaths']?.items, { type: 'string' });
  assert.equal(request.properties['expectedUniqueId']?.oneOf?.length, 2);

  const bank = schemas['BankInfoDto'] as { properties: Record<string, Prop> };
  assert.equal(bank.properties['currentProgram']?.nullable, true);
  assert.equal(bank.properties['chunkSize']?.nullable, true);

  const list = schemas['LibraryBanksListResponseDto'] as {
    properties: Record<string, Prop>;
  };
  assert.deepEqual(list.properties['banks']?.items, {
    $ref: '#/components/schemas/PluginBankEntryDto',
  });
  assert.deepEqual(list.properties['config']?.allOf, [
    { $ref: '#/components/schemas/FxbConfigSnapshotDto' },
  ]);
  assert.equal(list.properties['presetsDirExists']?.type, 'boolean');

  const entry = schemas['PluginBankEntryDto'] as { properties: Record<string, Prop> };
  assert.deepEqual(Object.keys(entry.properties).sort(), ['bank', 'fileName', 'size']);
});

test('openapi.json está sincronizado con el documento generado', async () => {
  const file = path.resolve(__dirname, '..', '..', 'openapi.json');
  const stored = JSON.parse(await readFile(file, 'utf8')) as OpenAPIObject;
  // `undefined` no sobrevive a la serialización; se normaliza el documento.
  const normalized = JSON.parse(JSON.stringify(document)) as OpenAPIObject;

  assert.deepEqual(stored, normalized);
});
