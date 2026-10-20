import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import openapiTS, { astToString, COMMENT_HEADER } from 'openapi-typescript';
import { AppModule } from '../src/app.module';
import { pe32Dll } from './helpers/pe';
import {
  createFxbClient,
  FxbApiError,
  isFxbApiError,
  type FxbClient,
  type FxbConfigSnapshotResponse,
  type LibraryBanksImportResponse,
  type LibraryBanksListResponse,
  type LibraryInstallResponse,
  type LibraryScanResponse,
} from '../src/client';
import { buildBank } from './helpers/fxb-bank';

/**
 * Comprobaciones en tiempo de compilación: si los tipos generados dejan de
 * derivarse del contrato (o alguien relaja los métodos a `any`), `tsc` falla
 * por un `@ts-expect-error` sin usar.
 */
function typeChecks(client: FxbClient): void {
  // @ts-expect-error `plugin` es obligatorio en install
  void client.library.install({ libraryRoot: 'C:\\VFX\\Library' });
  // @ts-expect-error `libraryRoot` es una cadena
  void client.library.scan({ libraryRoot: 42 });
  // @ts-expect-error el scan devuelve plugins, no un plugin suelto
  void client.library.scan({ libraryRoot: 'C:\\VFX\\Library' }).then((scan) => scan.plugin);
}
void typeChecks;

const WEBAPP = path.resolve(__dirname, '..', '..');

test('api-types.ts está sincronizado con openapi.json', async () => {
  const schema = JSON.parse(await readFile(path.join(WEBAPP, 'openapi.json'), 'utf8')) as Parameters<
    typeof openapiTS
  >[0];
  const generated = COMMENT_HEADER + astToString(await openapiTS(schema));
  const stored = await readFile(path.join(WEBAPP, 'src', 'client', 'api-types.ts'), 'utf8');

  assert.equal(
    generated.trim(),
    stored.trim(),
    'api-types.ts no coincide con openapi.json; ejecuta npm run client',
  );
});

let app: INestApplication;
let baseUrl: string;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

after(async () => {
  await app?.close();
});

interface Scaffold {
  root: string;
  dll: string;
  bank: string;
  foreign: string;
}

async function scaffold(t: TestContext): Promise<Scaffold> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-client-'));
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

  const dll = path.join(root, 'loader.dll');
  await writeFile(dll, pe32Dll());

  const banks = path.join(root, 'banks');
  await mkdir(banks);
  const bank = path.join(banks, 'Rhodes.fxb');
  const foreign = path.join(banks, 'Otro.fxb');
  await writeFile(bank, buildBank({ uniqueId: 'MySy', programs: 1 }));
  await writeFile(foreign, buildBank({ uniqueId: 'OtSy', programs: 1 }));

  return { root, dll, bank, foreign };
}

test('el cliente tipado recorre scan, install, import, uninstall y config', async (t) => {
  const data = await scaffold(t);
  let calls = 0;
  // baseUrl con barra final y fetch inyectado: las dos opciones deben aplicarse.
  const client = createFxbClient({
    baseUrl: `${baseUrl}/`,
    fetch: (input, init) => {
      calls += 1;
      return fetch(input, init);
    },
  });

  const scan: LibraryScanResponse = await client.library.scan({ libraryRoot: data.root });
  assert.equal(calls, 1);
  assert.deepEqual(
    scan.plugins.map((plugin) => [plugin.name, plugin.installed, plugin.pluginName]),
    [['Synth', false, null]],
  );
  assert.equal(scan.loader.valid, true);
  assert.equal(scan.loader.bitness, 32);
  assert.equal(scan.plugins[0]?.compatible, true);

  const dry: LibraryInstallResponse = await client.library.install({
    libraryRoot: data.root,
    plugin: 'Synth',
    dllSourcePath: data.dll,
    dryRun: true,
  });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(
    dry.actions.map((action) => action.kind),
    ['backup', 'copy', 'patch', 'write-config', 'create-dir'],
  );

  const installed: LibraryInstallResponse = await client.library.install({
    libraryRoot: data.root,
    plugin: 'Synth',
    dllSourcePath: data.dll,
  });
  assert.equal(installed.plugin.installed, true);
  assert.equal(installed.plugin.pluginName, 'Synth.dll');

  await assert.rejects(
    client.library.install({ libraryRoot: data.root, plugin: 'Synth', dllSourcePath: data.dll }),
    (error: unknown) => {
      assert.equal(isFxbApiError(error), true);
      assert.equal((error as FxbApiError).status, 409);
      const body = (error as FxbApiError).body as { message?: string };
      assert.match(String(body.message), /ya tiene fxbLoader/);
      return true;
    },
  );

  const inspected = await client.library.inspectBank({
    sourcePath: data.bank,
    libraryRoot: data.root,
    plugin: 'Synth',
  });
  assert.equal(inspected.valid, true);
  assert.equal(inspected.bank?.uniqueId, 'MySy');
  assert.equal(inspected.existingBanks.length, 0);
  assert.equal(inspected.targetExists, false);

  const imported: LibraryBanksImportResponse = await client.library.importBanks({
    libraryRoot: data.root,
    plugin: 'Synth',
    sourcePaths: [data.bank],
    expectedUniqueId: 'MySy',
  });
  assert.equal(imported.results[0]?.status, 'imported');
  assert.equal(imported.reference.source, 'explicit');
  assert.equal(imported.results[0]?.bank?.uniqueId, 'MySy');

  const listed: LibraryBanksListResponse = await client.library.listBanks({
    libraryRoot: data.root,
    plugin: 'Synth',
  });
  assert.deepEqual(
    listed.banks.map((entry) => entry.fileName),
    ['Rhodes.fxb'],
  );
  assert.equal(listed.presetsDirExists, true);
  assert.equal(listed.config.exists, true);

  await assert.rejects(
    client.library.importBanks({
      libraryRoot: data.root,
      plugin: 'Synth',
      sourcePaths: [data.foreign],
      expectedUniqueId: 'MySy',
    }),
    (error: unknown) => {
      assert.equal(isFxbApiError(error), true);
      const apiError = error as FxbApiError;
      assert.equal(apiError.status, 422);
      const body = apiError.body as LibraryBanksImportResponse & { message: string };
      assert.equal(body.message, 'Ningún banco se pudo importar');
      assert.equal(body.results[0]?.compatibility, 'incompatible');
      return true;
    },
  );

  const snapshot: FxbConfigSnapshotResponse = await client.config.read({
    pluginDir: path.join(data.root, 'plugs', 'Synth'),
  });
  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.config.programDirName, 'presets');
  assert.equal(typeof snapshot.mtimeMs, 'number');

  const written: FxbConfigSnapshotResponse = await client.config.write({
    pluginDir: snapshot.configPath.replace(/[\\/]fxbLoader\.config$/, ''),
    expectedMtimeMs: snapshot.mtimeMs,
    config: { defaultFxbName: 'Rhodes.fxb' },
  });
  assert.equal(written.config.defaultFxbName, 'Rhodes.fxb');
  assert.equal(written.config.programDirName, 'presets');

  await assert.rejects(
    client.config.write({
      pluginDir: snapshot.configPath.replace(/[\\/]fxbLoader\.config$/, ''),
      expectedMtimeMs: snapshot.mtimeMs,
      config: { loadFxbBank: false },
    }),
    (error: unknown) => {
      assert.equal((error as FxbApiError).status, 409);
      const body = (error as FxbApiError).body as { current?: { mtimeMs: number | null } };
      assert.equal(typeof body.current?.mtimeMs, 'number');
      return true;
    },
  );

  await assert.rejects(
    client.library.scan({ libraryRoot: 'plugs' }),
    (error: unknown) => {
      assert.equal((error as FxbApiError).status, 400);
      assert.match(String((error as FxbApiError).message), /ruta absoluta/);
      return true;
    },
  );

  const uninstalled = await client.library.uninstall({
    libraryRoot: data.root,
    plugin: 'Synth',
  });
  assert.equal(uninstalled.plugin.installed, false);
  assert.deepEqual(
    uninstalled.actions.map((action) => action.kind),
    ['restore', 'restore', 'delete'],
  );
});
