import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { FXB_CONFIG_FILENAME } from '../src/fxb-config/fxb-config.constants';
import type { PluginEntry } from '../src/library/library.types';

/** `dist-test/test` → raíz del repositorio. */
const REPO_DLL = path.resolve(__dirname, '..', '..', '..', 'vst', 'fxbLoader.dll');
const FIXTURE_LIBRARY = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'vfx-library');
/** Permite apuntar a una librería VFX real sin tocar el fixture. */
const LIBRARY_SOURCE = process.env['FXB_VFX_LIBRARY']?.trim() || FIXTURE_LIBRARY;

let app: INestApplication;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

after(async () => {
  await app?.close();
});

function server() {
  return request(app.getHttpServer());
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

const skip = existsSync(REPO_DLL)
  ? false
  : `no está ${path.relative(process.cwd(), REPO_DLL)}; el test necesita la DLL real`;

test(
  'instala y desinstala con el fxbLoader.dll real sobre una copia de la librería',
  { skip },
  async (t) => {
    assert.ok(
      existsSync(LIBRARY_SOURCE),
      `la librería no existe: ${LIBRARY_SOURCE} (define FXB_VFX_LIBRARY o revisa el fixture)`,
    );

    const temp = await mkdtemp(path.join(tmpdir(), 'fxb-real-lib-'));
    t.after(async () => {
      await rm(temp, { recursive: true, force: true });
    });

    // Se opera siempre sobre una copia: ni el fixture ni la librería real se tocan.
    // De una biblioteca real solo se copia `plugs`, que es lo único que se lee.
    const library = path.join(temp, 'library');
    const sourcePlugs = path.join(LIBRARY_SOURCE, 'plugs');
    if (existsSync(sourcePlugs)) {
      await cp(sourcePlugs, path.join(library, 'plugs'), { recursive: true });
    } else {
      await cp(LIBRARY_SOURCE, library, { recursive: true });
    }

    const scan = await server()
      .post('/library/scan')
      .send({ libraryRoot: library })
      .expect(200);

    const candidate = (scan.body.plugins as PluginEntry[]).find(
      (plugin) => plugin.hasVfxinfo && !plugin.installed && plugin.compatible !== false,
    );
    if (!candidate) {
      t.skip('la librería no tiene ningún plugin compatible con vfxinfo.txt sin instalar');
      return;
    }
    assert.ok(candidate.pluginName === null);

    const pluginDir = path.join(library, 'plugs', candidate.name);
    const sourceDir = path.join(LIBRARY_SOURCE, 'plugs', candidate.name);
    const vfxinfoPath = path.join(pluginDir, 'vfxinfo.txt');
    const configPath = path.join(pluginDir, FXB_CONFIG_FILENAME);
    const backupPath = path.join(pluginDir, 'vfxinfo.tx_');
    const loaderCopy = path.join(pluginDir, 'fxbLoader.dll');

    const originalVfxinfo = await readFile(vfxinfoPath);
    const sourceVfxinfo = await readFile(path.join(sourceDir, 'vfxinfo.txt'));
    assert.deepEqual(sourceVfxinfo, originalVfxinfo, 'la copia debe ser byte a byte');

    const originalText = originalVfxinfo.toString('latin1');
    const dllName = (/^dll_name\s*:\s*(.+)$/m.exec(originalText)?.[1] ?? '')
      .replace(/\s+$/, '')
      .trim();
    const expectedPluginName = dllName.split(/[\\/]/).pop() ?? '';

    // Sin dllSourcePath: debe resolver la DLL real del repositorio.
    const installed = await server()
      .post('/library/install')
      .send({ libraryRoot: library, plugin: candidate.name });
    assert.equal(installed.status, 200, JSON.stringify(installed.body));

    assert.equal(installed.body.plugin.installed, true);
    assert.equal(installed.body.plugin.pluginName, expectedPluginName);

    const copyAction = (installed.body.actions as { kind: string; detail?: string }[]).find(
      (action) => action.kind === 'copy',
    );
    assert.ok(copyAction?.detail);
    assert.equal(samePath(copyAction.detail, REPO_DLL), true);

    // El archivo copiado es exactamente el DLL del repositorio.
    assert.equal(await sha256(loaderCopy), await sha256(REPO_DLL));
    assert.equal((await stat(loaderCopy)).size, (await stat(REPO_DLL)).size);

    // Respaldo intacto y vfxinfo parcheado.
    assert.deepEqual(await readFile(backupPath), originalVfxinfo);
    const patchedText = (await readFile(vfxinfoPath)).toString('latin1');
    assert.match(
      patchedText,
      new RegExp(`^dll_name: ${escapeRegExp(candidate.name)}/fxbLoader\\.dll\\r?$`, 'm'),
    );

    // Configuración creada con el nombre original del plugin.
    const configText = (await readFile(configPath)).toString('latin1');
    assert.match(configText, /^loadFxbBank = yes\r?$/m);
    assert.match(configText, /^programDirName = presets\r?$/m);
    if (expectedPluginName !== '') {
      assert.match(
        configText,
        new RegExp(`^pluginName = ${escapeRegExp(expectedPluginName)}\\r?$`, 'm'),
      );
    }

    assert.equal((await stat(path.join(pluginDir, 'presets'))).isDirectory(), true);
    assert.deepEqual(
      (await readdir(pluginDir)).filter((name) => name.endsWith('.tmp')),
      [],
      'no deben quedar temporales de la escritura atómica',
    );

    const patchedBuffer = await readFile(vfxinfoPath);

    const uninstalled = await server()
      .post('/library/uninstall')
      .send({ libraryRoot: library, plugin: candidate.name })
      .expect(200);

    assert.equal(uninstalled.body.plugin.installed, false);
    assert.deepEqual(await readFile(vfxinfoPath), originalVfxinfo);
    assert.deepEqual(await readFile(path.join(pluginDir, 'vfxinfo.loader')), patchedBuffer);
    assert.equal(existsSync(configPath), false);
    assert.equal(existsSync(loaderCopy), true, 'el DLL se conserva, como el original');
    assert.equal(existsSync(path.join(pluginDir, 'presets')), true);

    // La fuente no se ha modificado.
    assert.deepEqual(await readFile(path.join(sourceDir, 'vfxinfo.txt')), sourceVfxinfo);
  },
);
