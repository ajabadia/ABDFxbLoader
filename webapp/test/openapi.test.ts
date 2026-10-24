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
  LIBRARY_BANKS_IMPORT_STREAM_EXAMPLE,
  LIBRARY_BANKS_LIST_EXAMPLE,
  LIBRARY_BATCH_DRY_RUN_EXAMPLE,
  LIBRARY_BATCH_EXAMPLE,
  LIBRARY_BATCH_LOADER_ERROR_EXAMPLE,
  LIBRARY_BATCH_STREAM_EXAMPLE,
  LIBRARY_CONVERT_EXAMPLE,
  LIBRARY_CONVERT_NO_DEFAULT_EXAMPLE,
  LIBRARY_DISCARD_BACKUP_EXAMPLE,
  LIBRARY_DISCARD_NO_BACKUP_EXAMPLE,
  LIBRARY_DISCARD_TRASH_ERROR_EXAMPLE,
  LIBRARY_EXPORT_EXAMPLE,
  LIBRARY_EXPORT_TARGET_EXISTS_EXAMPLE,
  LIBRARY_IMPORT_EXAMPLE,
  LIBRARY_IMPORT_REJECTED_EXAMPLE,
  LIBRARY_INSPECT_EXAMPLE,
  LIBRARY_INCOMPATIBLE_ERROR_EXAMPLE,
  LIBRARY_INSPECT_WITHOUT_PLUGIN_EXAMPLE,
  LIBRARY_INSTALL_CONFLICT_EXAMPLE,
  LIBRARY_INSTALL_DRY_RUN_EXAMPLE,
  LIBRARY_MISSING_PLUGIN_DLL_ERROR_EXAMPLE,
  LIBRARY_INSTALL_EXAMPLE,
  LIBRARY_RESTORE_EXAMPLE,
  LIBRARY_RESTORE_INVALID_BACKUP_EXAMPLE,
  LIBRARY_RESTORE_NO_BACKUP_EXAMPLE,
  LIBRARY_RESTORE_UNCHANGED_EXAMPLE,
  LIBRARY_SCAN_EXAMPLE,
  LIBRARY_UNINSTALL_CONFLICT_EXAMPLE,
  LIBRARY_UNINSTALL_EXAMPLE,
  LIBRARY_VFXINFO_ERROR_EXAMPLE,
} from '../src/library/library.dto';
import {
  PLUGIN_META_CONFLICT_EXAMPLE,
  PLUGIN_META_PATH_ERROR_EXAMPLE,
  PLUGIN_META_SNAPSHOT_EXAMPLE,
  PLUGIN_META_VALIDATION_ERROR_EXAMPLE,
} from '../src/plugin-meta/plugin-meta.dto';
import { SYSTEM_PATHS_MIXED_EXAMPLE } from '../src/system/paths.dto';
import { MAX_PLUGINS_PER_BATCH } from '../src/client/batch-stream';
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
    '/library/banks/convert',
    '/library/banks/discard-backup',
    '/library/banks/export',
    '/library/banks/import',
    '/library/banks/import/stream',
    '/library/banks/inspect',
    '/library/banks/list',
    '/library/banks/restore',
    '/library/batch',
    '/library/batch/stream',
    '/library/install',
    '/library/scan',
    '/library/uninstall',
    '/plugins/{id}/meta',
    '/system/paths',
    '/system/pick',
  ]);
  assert.equal(document.paths['/fxb-config/read']?.post?.tags?.[0], 'fxb-config');
});

test('POST /system/paths documenta cuerpo, 200 y 400 con ejemplos', () => {
  const body = requestContent('/system/paths', 'post');
  assert.equal(body.schema?.$ref, '#/components/schemas/SystemPathsRequestDto');
  assert.deepEqual(Object.keys(body.examples ?? {}).sort(), ['mezcla', 'vacia']);
  assert.deepEqual(body.examples?.['vacia']?.value, { paths: [] });
  assert.equal(document.paths['/system/paths']?.post?.tags?.[0], 'system');

  const check = responses('/system/paths', 'post');
  assert.deepEqual(Object.keys(check).sort(), ['200', '400']);

  const ok = jsonBody(check['200']);
  const okExamples = ok['examples'] as Record<string, { value: unknown }>;
  assert.deepEqual(Object.keys(okExamples).sort(), ['mezcla', 'vacia']);
  assert.deepEqual(okExamples['mezcla']!.value, SYSTEM_PATHS_MIXED_EXAMPLE);
  assert.deepEqual((ok['schema'] as { $ref: string }).$ref, '#/components/schemas/SystemPathsResponseDto');

  const bad = jsonBody(check['400']);
  assert.deepEqual(Object.keys(bad['examples'] as Record<string, unknown>).sort(), [
    'relativa',
    'tipo',
    'tope',
  ]);
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
  const schema = bad['schema'] as { anyOf?: { $ref: string }[] };
  assert.equal(schema.anyOf?.length, 2);

  const conflict = jsonBody(write['409']);
  assert.deepEqual(conflict['example'], FXB_CONFIG_CONFLICT_EXAMPLE);
  assert.deepEqual(
    (conflict['schema'] as { $ref: string }).$ref,
    '#/components/schemas/FxbConfigConflictErrorDto',
  );
});

test('GET y POST /plugins/{id}/meta documentan 200, 400 y 409 con ejemplos', () => {
  const read = responses('/plugins/{id}/meta', 'get');
  assert.deepEqual(Object.keys(read).sort(), ['200', '400']);
  assert.equal(document.paths['/plugins/{id}/meta']?.get?.tags?.[0], 'plugin-meta');
  assert.deepEqual(jsonBody(read['200'])['example'], PLUGIN_META_SNAPSHOT_EXAMPLE);

  // El 400 del GET cubre tanto la ruta como un archivo que no cumple el formato.
  const readBad = jsonBody(read['400']);
  assert.deepEqual(Object.keys(readBad['examples'] as object).sort(), [
    'archivoInvalido',
    'falta',
    'rutaInvalida',
  ]);
  const readSchema = readBad['schema'] as { anyOf?: { $ref: string }[] };
  assert.deepEqual(
    readSchema.anyOf?.map((branch) => branch.$ref),
    [
      '#/components/schemas/PluginMetaPathErrorDto',
      '#/components/schemas/PluginMetaValidationErrorDto',
    ],
  );

  const body = requestContent('/plugins/{id}/meta', 'post');
  assert.equal(body.schema?.$ref, '#/components/schemas/PluginMetaWriteRequestDto');
  assert.deepEqual(Object.keys(body.examples ?? {}).sort(), ['archivoNuevo', 'cambioParcial']);

  const write = responses('/plugins/{id}/meta', 'post');
  assert.deepEqual(Object.keys(write).sort(), ['200', '400', '409']);
  assert.deepEqual(jsonBody(write['200'])['example'], PLUGIN_META_SNAPSHOT_EXAMPLE);

  const writeBad = jsonBody(write['400'])['examples'] as Record<string, { value: unknown }>;
  assert.deepEqual(Object.keys(writeBad).sort(), ['rutaInvalida', 'validacion']);
  assert.deepEqual(writeBad['validacion']!.value, PLUGIN_META_VALIDATION_ERROR_EXAMPLE);
  assert.match(
    String((writeBad['rutaInvalida']!.value as { message: string }).message),
    /ruta absoluta/,
  );

  const conflict = jsonBody(write['409']);
  assert.deepEqual(conflict['example'], PLUGIN_META_CONFLICT_EXAMPLE);
  assert.equal(
    (conflict['schema'] as { $ref: string }).$ref,
    '#/components/schemas/PluginMetaConflictErrorDto',
  );

  // Los dos ejemplos de ruta del GET son el mismo error, con el parámetro ausente
  // o con una ruta que no existe.
  const readExamples = readBad['examples'] as Record<string, { value: unknown }>;
  assert.deepEqual(readExamples['rutaInvalida']!.value, PLUGIN_META_PATH_ERROR_EXAMPLE);
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
  const schema = conflict['schema'] as { anyOf?: { $ref: string }[] };
  assert.deepEqual(schema.anyOf, [
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
  assert.deepEqual(Object.keys(unprocessableExamples).sort(), [
    'binarioAusente',
    'incompatible',
    'vfxinfo',
  ]);
  assert.deepEqual(unprocessableExamples['vfxinfo']!.value, LIBRARY_VFXINFO_ERROR_EXAMPLE);
  assert.deepEqual(
    unprocessableExamples['binarioAusente']!.value,
    LIBRARY_MISSING_PLUGIN_DLL_ERROR_EXAMPLE,
  );
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

test('POST /library/batch documenta 200 con resultado por plugin, 400 y 422', () => {
  const body = requestContent('/library/batch', 'post');
  assert.deepEqual(Object.keys(body.examples ?? {}).sort(), ['instalacion', 'reconexion', 'simulacion']);

  const batch = responses('/library/batch', 'post');
  assert.deepEqual(Object.keys(batch).sort(), ['200', '400', '422']);
  assert.equal(document.paths['/library/batch']?.post?.tags?.[0], 'library');

  const ok = jsonBody(batch['200']);
  const okExamples = ok['examples'] as Record<string, { value: unknown }>;
  assert.deepEqual(Object.keys(okExamples).sort(), ['aplicado', 'dryRun']);
  assert.deepEqual(okExamples['aplicado']!.value, LIBRARY_BATCH_EXAMPLE);
  assert.deepEqual(okExamples['dryRun']!.value, LIBRARY_BATCH_DRY_RUN_EXAMPLE);

  const bad = jsonBody(batch['400']);
  assert.deepEqual(Object.keys(bad['examples'] as object).sort(), [
    'actionInvalida',
    'demasiadosPlugins',
    'dllRelativa',
    'pluginsVacios',
  ]);
  assert.deepEqual((bad['schema'] as { $ref: string }).$ref, '#/components/schemas/LibraryErrorDto');
  assert.deepEqual(
    (bad['examples'] as Record<string, { value: unknown }>)['demasiadosPlugins']!.value,
    { message: `como máximo ${MAX_PLUGINS_PER_BATCH} plugins por petición` },
  );

  const unprocessable = jsonBody(batch['422']);
  assert.deepEqual(unprocessable['example'], LIBRARY_BATCH_LOADER_ERROR_EXAMPLE);
});

test('POST /library/batch/stream documenta el NDJSON y los mismos errores', () => {
  const body = requestContent('/library/batch/stream', 'post');
  assert.equal(body.schema?.$ref, '#/components/schemas/LibraryBatchRequestDto');
  assert.deepEqual(Object.keys(body.examples ?? {}).sort(), ['instalacion', 'simulacion']);

  const stream = responses('/library/batch/stream', 'post');
  assert.deepEqual(Object.keys(stream).sort(), ['200', '400', '422']);

  // El 200 no es JSON: es el flujo de líneas, así que se documenta como NDJSON
  // y el ejemplo es el texto exacto que escribe el servidor.
  const ok = stream['200'] as { content?: Record<string, { example?: unknown }> };
  assert.deepEqual(Object.keys(ok.content ?? {}), ['application/x-ndjson']);
  assert.equal(ok.content?.['application/x-ndjson']?.example, LIBRARY_BATCH_STREAM_EXAMPLE);

  const lines = LIBRARY_BATCH_STREAM_EXAMPLE.split('\n');
  assert.equal(lines.length, 11, 'un evento por línea: start, los pasos del plugin y end');
  assert.equal(lines[0]!.startsWith('{"type":"start"'), true);
  assert.equal(lines[lines.length - 1]!.startsWith('{"type":"end"'), true);

  // El ejemplo enseña el intercalado real: los pasos internos salen entre el
  // `running` del plugin y su estado final.
  const exampleEvents = lines.map(
    (line) => JSON.parse(line) as { type: string; step?: string; name?: string },
  );
  assert.deepEqual(exampleEvents.map((event) => event.type), [
    'start',
    'plugin',
    ...Array<string>(5).fill('step'),
    'plugin',
    'plugin',
    'plugin',
    'end',
  ]);
  assert.deepEqual(
    exampleEvents.filter((event) => event.type === 'step').map((event) => event.step),
    ['backup', 'copy', 'patch', 'write-config', 'create-dir'],
  );

  const bad = jsonBody(stream['400']);
  assert.deepEqual(Object.keys(bad['examples'] as object).sort(), [
    'demasiadosPlugins',
    'pluginsVacios',
  ]);
  assert.deepEqual(jsonBody(stream['422'])['example'], LIBRARY_BATCH_LOADER_ERROR_EXAMPLE);
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

test('POST /library/banks/import/stream documenta el NDJSON y los errores previos', () => {
  const body = requestContent('/library/banks/import/stream', 'post');
  assert.equal(body.schema?.$ref, '#/components/schemas/LibraryBanksImportRequestDto');
  assert.deepEqual(Object.keys(body.examples ?? {}).sort(), ['lote', 'sinReferencia']);

  const stream = responses('/library/banks/import/stream', 'post');
  assert.deepEqual(Object.keys(stream).sort(), ['200', '400', '404']);

  const ok = stream['200'] as { content?: Record<string, { example?: unknown }> };
  assert.deepEqual(Object.keys(ok.content ?? {}), ['application/x-ndjson']);
  assert.equal(ok.content?.['application/x-ndjson']?.example, LIBRARY_BANKS_IMPORT_STREAM_EXAMPLE);

  const lines = LIBRARY_BANKS_IMPORT_STREAM_EXAMPLE.split('\n');
  assert.equal(lines.length, 4, 'un evento por línea: start, dos bancos y end');
  const events = lines.map(
    (line) => JSON.parse(line) as { type: string; index?: number; result?: { status?: string } },
  );
  assert.deepEqual(events.map((event) => event.type), ['start', 'bank', 'bank', 'end']);
  assert.deepEqual(events.filter((event) => event.type === 'bank').map((event) => event.index), [0, 1]);

  assert.match(((jsonBody(stream['400'])['example'] as { message: string }).message), /absoluta/);
  assert.equal(
    (jsonBody(stream['404'])['schema'] as { $ref: string }).$ref,
    '#/components/schemas/LibraryErrorDto',
  );
});

test('POST /library/banks/convert documenta 200, 400, 404, 409 y 422', () => {
  const body = requestContent('/library/banks/convert', 'post');
  assert.equal(body.schema?.$ref, '#/components/schemas/LibraryBankConvertRequestDto');
  assert.deepEqual(Object.keys(body.examples ?? {}).sort(), ['alReves', 'explicito']);

  const converted = responses('/library/banks/convert', 'post');
  assert.deepEqual(Object.keys(converted).sort(), ['200', '400', '404', '409', '422']);
  assert.equal(document.paths['/library/banks/convert']?.post?.tags?.[0], 'library');

  const ok = jsonBody(converted['200']);
  assert.equal(
    (ok['schema'] as { $ref: string }).$ref,
    '#/components/schemas/LibraryBankConvertResponseDto',
  );
  assert.deepEqual(ok['example'], LIBRARY_CONVERT_EXAMPLE);

  const bad = jsonBody(converted['400']);
  assert.deepEqual(Object.keys(bad['examples'] as object).sort(), ['nombre', 'orden']);

  const conflicts = jsonBody(converted['409'])['examples'] as Record<string, { value: unknown }>;
  assert.deepEqual(Object.keys(conflicts).sort(), ['ausente', 'sinDefecto']);
  assert.deepEqual(conflicts['sinDefecto']!.value, LIBRARY_CONVERT_NO_DEFAULT_EXAMPLE);

  for (const status of ['400', '404', '409', '422'] as const) {
    assert.equal(
      (jsonBody(converted[status])['schema'] as { $ref: string }).$ref,
      '#/components/schemas/LibraryErrorDto',
      `${status} debe usar LibraryErrorDto`,
    );
  }
});

test('POST /library/banks/restore documenta 200, 400, 404, 409 y 422', () => {
  const body = requestContent('/library/banks/restore', 'post');
  assert.equal(body.schema?.$ref, '#/components/schemas/LibraryBankRestoreRequestDto');
  assert.deepEqual(Object.keys(body.examples ?? {}), ['restaurar']);

  const restored = responses('/library/banks/restore', 'post');
  assert.deepEqual(Object.keys(restored).sort(), ['200', '400', '404', '409', '422']);
  assert.equal(document.paths['/library/banks/restore']?.post?.tags?.[0], 'library');

  const ok = jsonBody(restored['200']);
  assert.equal(
    (ok['schema'] as { $ref: string }).$ref,
    '#/components/schemas/LibraryBankRestoreResponseDto',
  );
  const examples = ok['examples'] as Record<string, { value: unknown }>;
  assert.deepEqual(Object.keys(examples).sort(), ['restaurado', 'yaRestaurado']);
  assert.deepEqual(examples['restaurado']!.value, LIBRARY_RESTORE_EXAMPLE);
  assert.deepEqual(examples['yaRestaurado']!.value, LIBRARY_RESTORE_UNCHANGED_EXAMPLE);

  const conflicts = jsonBody(restored['409'])['examples'] as Record<string, { value: unknown }>;
  assert.deepEqual(Object.keys(conflicts).sort(), ['sinDefecto', 'sinRespaldo']);
  assert.deepEqual(conflicts['sinRespaldo']!.value, LIBRARY_RESTORE_NO_BACKUP_EXAMPLE);
  assert.deepEqual(jsonBody(restored['422'])['example'], LIBRARY_RESTORE_INVALID_BACKUP_EXAMPLE);

  for (const status of ['400', '404', '409', '422'] as const) {
    assert.equal(
      (jsonBody(restored[status])['schema'] as { $ref: string }).$ref,
      '#/components/schemas/LibraryErrorDto',
      `${status} debe usar LibraryErrorDto`,
    );
  }
});

test('POST /library/banks/discard-backup documenta 200, 400, 404, 409 y 422', () => {
  const body = requestContent('/library/banks/discard-backup', 'post');
  assert.equal(
    body.schema?.$ref,
    '#/components/schemas/LibraryBankDiscardBackupRequestDto',
  );
  assert.deepEqual(Object.keys(body.examples ?? {}), ['descartar']);

  const discarded = responses('/library/banks/discard-backup', 'post');
  assert.deepEqual(Object.keys(discarded).sort(), ['200', '400', '404', '409', '422']);
  assert.equal(
    document.paths['/library/banks/discard-backup']?.post?.tags?.[0],
    'library',
  );

  const ok = jsonBody(discarded['200']);
  assert.equal(
    (ok['schema'] as { $ref: string }).$ref,
    '#/components/schemas/LibraryBankDiscardBackupResponseDto',
  );
  assert.deepEqual(ok['example'], LIBRARY_DISCARD_BACKUP_EXAMPLE);

  const conflicts = jsonBody(discarded['409'])['examples'] as Record<string, { value: unknown }>;
  assert.deepEqual(Object.keys(conflicts).sort(), ['sinDefecto', 'sinRespaldo']);
  assert.deepEqual(conflicts['sinRespaldo']!.value, LIBRARY_DISCARD_NO_BACKUP_EXAMPLE);
  assert.deepEqual(jsonBody(discarded['422'])['example'], LIBRARY_DISCARD_TRASH_ERROR_EXAMPLE);

  for (const status of ['400', '404', '409', '422'] as const) {
    assert.equal(
      (jsonBody(discarded[status])['schema'] as { $ref: string }).$ref,
      '#/components/schemas/LibraryErrorDto',
      `${status} debe usar LibraryErrorDto`,
    );
  }
});

test('POST /library/banks/export documenta 200, 400, 404, 409 y 422', () => {
  const body = requestContent('/library/banks/export', 'post');
  assert.equal(body.schema?.$ref, '#/components/schemas/LibraryBankExportRequestDto');
  assert.deepEqual(Object.keys(body.examples ?? {}).sort(), ['big', 'little']);

  const exported = responses('/library/banks/export', 'post');
  assert.deepEqual(Object.keys(exported).sort(), ['200', '400', '404', '409', '422']);
  assert.equal(document.paths['/library/banks/export']?.post?.tags?.[0], 'library');

  const ok = jsonBody(exported['200']);
  assert.equal(
    (ok['schema'] as { $ref: string }).$ref,
    '#/components/schemas/LibraryBankExportResponseDto',
  );
  assert.deepEqual(ok['example'], LIBRARY_EXPORT_EXAMPLE);

  const bad = jsonBody(exported['400']);
  assert.deepEqual(Object.keys(bad['examples'] as object).sort(), ['nombre', 'orden']);
  assert.deepEqual(jsonBody(exported['409'])['example'], LIBRARY_EXPORT_TARGET_EXISTS_EXAMPLE);
  assert.equal(
    (jsonBody(exported['404'])['schema'] as { $ref: string }).$ref,
    '#/components/schemas/LibraryErrorDto',
  );
  assert.equal(
    (jsonBody(exported['422'])['schema'] as { $ref: string }).$ref,
    '#/components/schemas/LibraryErrorDto',
  );
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
    'LibraryBankConvertRequestDto',
    'LibraryBankConvertResponseDto',
    'BankBackupFileDto',
    'LibraryBankExportRequestDto',
    'LibraryBankExportResponseDto',
    'BankExportFileDto',
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
  // El respaldo del banco por defecto es opcional: sin `.orig` la vista no
  // habilita «Restaurar original».
  assert.equal(list.properties['defaultBackup']?.nullable, true);
  assert.deepEqual(list.properties['defaultBackup']?.allOf, [
    { $ref: '#/components/schemas/BankBackupSummaryDto' },
  ]);

  const entry = schemas['PluginBankEntryDto'] as { properties: Record<string, Prop> };
  assert.deepEqual(Object.keys(entry.properties).sort(), ['bank', 'fileName', 'size']);

  const convertRequest = schemas['LibraryBankConvertRequestDto'] as {
    properties: Record<string, { enum?: string[]; type?: string }>;
    required: string[];
  };
  assert.deepEqual(convertRequest.properties['endianness']?.enum, ['big', 'little']);
  assert.deepEqual(Object.keys(convertRequest.properties).sort(), [
    'endianness',
    'libraryRoot',
    'plugin',
  ]);
  // El orden de destino es opcional: sin él se invierte el actual.
  assert.deepEqual([...convertRequest.required].sort(), ['libraryRoot', 'plugin']);

  const convertResponse = schemas['LibraryBankConvertResponseDto'] as {
    properties: Record<string, Prop>;
  };
  assert.equal(convertResponse.properties['backup']?.nullable, true);
  assert.deepEqual(convertResponse.properties['backup']?.allOf, [
    { $ref: '#/components/schemas/BankBackupFileDto' },
  ]);

  const restoreRequest = schemas['LibraryBankRestoreRequestDto'] as {
    properties: Record<string, Prop>;
    required: string[];
  };
  assert.deepEqual(Object.keys(restoreRequest.properties).sort(), ['libraryRoot', 'plugin']);
  assert.deepEqual([...restoreRequest.required].sort(), ['libraryRoot', 'plugin']);

  const restoreResponse = schemas['LibraryBankRestoreResponseDto'] as {
    properties: Record<string, Prop>;
    required: string[];
  };
  assert.deepEqual(Object.keys(restoreResponse.properties).sort(), [
    'backup',
    'changed',
    'fileName',
    'plugin',
    'presetsDir',
    'restored',
  ]);
  assert.equal(restoreResponse.properties['backup']?.nullable, undefined, 'el respaldo es obligatorio');

  const exportRequest = schemas['LibraryBankExportRequestDto'] as {
    properties: Record<string, { enum?: string[]; type?: string }>;
  };
  assert.deepEqual(exportRequest.properties['endianness']?.enum, ['big', 'little']);
  assert.deepEqual(Object.keys(exportRequest.properties).sort(), [
    'endianness',
    'fileName',
    'libraryRoot',
    'overwrite',
    'plugin',
  ]);
});

test('openapi.json está sincronizado con el documento generado', async () => {
  const file = path.resolve(__dirname, '..', '..', 'openapi.json');
  const stored = JSON.parse(await readFile(file, 'utf8')) as OpenAPIObject;
  // `undefined` no sobrevive a la serialización; se normaliza el documento.
  const normalized = JSON.parse(JSON.stringify(document)) as OpenAPIObject;

  assert.deepEqual(stored, normalized);
});
