import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { VFXINFO_BACKUP_FILENAME, VFXINFO_FILENAME } from '../src/library/vfxinfo';

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

interface Scaffold {
  root: string;
  pluginDir: string;
}

/** Plugin mínimo con `vfxinfo.txt` y una DLL propia dentro de su carpeta. */
async function scaffold(t: TestContext, extraDll = true): Promise<Scaffold> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-dll-pref-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pluginDir = path.join(root, 'plugs', 'Synth');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, VFXINFO_FILENAME),
    Buffer.from(`name: Synth\r\ndll_name: Synth/Synth.dll\r\n`, 'latin1'),
  );
  if (extraDll) {
    await writeFile(path.join(pluginDir, 'Synth64.dll'), Buffer.from('dll-fake'));
  }
  return { root, pluginDir };
}

function dllPreference(input: { pluginDir: string; dllName: string }) {
  return http().post('/library/plugin-dll-preference').send(input);
}

test('guarda la preferencia de DLL, respalda el vfxinfo original y lo registra en el log', async (t) => {
  const data = await scaffold(t);

  const body = (
    await dllPreference({
      pluginDir: data.pluginDir,
      dllName: 'Synth64.dll',
    }).expect(200)
  ).body as {
    pluginDir: string;
    previousDllName: string | null;
    dllName: string;
    backupFile: string | null;
    changed: boolean;
    actions: { kind: string; path: string; detail?: string }[];
  };

  assert.equal(body.changed, true);
  assert.equal(body.pluginDir, data.pluginDir);
  assert.equal(body.previousDllName, 'Synth/Synth.dll');
  assert.equal(body.dllName, 'Synth64.dll');
  assert.ok(body.backupFile !== null && body.backupFile.endsWith(VFXINFO_BACKUP_FILENAME));

  // El respaldo conserva el valor original y el vfxinfo cambia solo la línea.
  const backup = await readFile(path.join(data.pluginDir, VFXINFO_BACKUP_FILENAME), 'latin1');
  assert.ok(backup.includes('dll_name: Synth/Synth.dll'));
  const vfxinfo = await readFile(path.join(data.pluginDir, VFXINFO_FILENAME), 'latin1');
  assert.ok(vfxinfo.includes('name: Synth'));
  assert.ok(vfxinfo.includes('dll_name: Synth64.dll'));
  // Los finales de línea CRLF del resto del archivo no cambian.
  assert.ok(vfxinfo.includes('\r\n'), 'mantiene CRLF del resto del archivo');

  const actions = body.actions.map((action) => action.kind);
  assert.deepEqual(actions, ['backup', 'patch']);

  // La operación queda registrada en el log del plugin.
  const log = await readFile(path.join(data.pluginDir, 'fxbLoader.log'), 'utf8');
  assert.ok(log.includes('[dll-preference]'));
});

test('idempotente: guardar el mismo valor no escribe ni duplica el respaldo', async (t) => {
  const data = await scaffold(t);

  await dllPreference({
    pluginDir: data.pluginDir,
    dllName: 'Synth64.dll',
  }).expect(200);

  const statBefore = await readFile(path.join(data.pluginDir, VFXINFO_FILENAME), 'latin1');
  await writeFile(path.join(data.pluginDir, VFXINFO_FILENAME), Buffer.from(statBefore, 'latin1'));

  const body = (
    await dllPreference({
      pluginDir: data.pluginDir,
      dllName: 'Synth64.dll',
    }).expect(200)
  ).body as { changed: boolean; actions: unknown[]; backupFile: string | null };

  assert.equal(body.changed, false);
  assert.deepEqual(body.actions, []);
  assert.equal(body.backupFile, null);
});

test('rechaza 422 valores fuera del plugin, archivos ausentes y vfxinfo sin dll_name', async (t) => {
  const data = await scaffold(t, true);

  await dllPreference({
    pluginDir: data.pluginDir,
    dllName: '..\\Fuga.dll',
  }).expect(422);

  await dllPreference({
    pluginDir: data.pluginDir,
    dllName: 'NoExiste.dll',
  }).expect(422);

  await dllPreference({
    pluginDir: data.pluginDir,
    dllName: '',
  }).expect(400);

  // Plugin sin línea dll_name → LibraryOperationError (422).
  const empty = await mkdtemp(path.join(tmpdir(), 'fxb-dll-pref-empty-'));
  t.after(async () => {
    await rm(empty, { recursive: true, force: true });
  });
  const emptyPluginDir = path.join(empty, 'plugs', 'SinDllName');
  await mkdir(emptyPluginDir, { recursive: true });
  await writeFile(path.join(emptyPluginDir, 'SinDllName.dll'), Buffer.from('dll'));
  await writeFile(path.join(emptyPluginDir, 'vfxinfo.txt'), Buffer.from('name: SinDllName\r\n', 'latin1'));
  const sinDllName = (
    await dllPreference({
      pluginDir: emptyPluginDir,
      dllName: 'SinDllName.dll',
    }).expect(422)
  ).body as { message: string };
  assert.ok(sinDllName.message.includes('dll_name'));
});

test('400 pluginDir no absoluto y 422 vfxinfo ausente', async (t) => {
  await dllPreference({ pluginDir: 'loco/plugs/Synth', dllName: 'a.dll' }).expect(400);

  const root = await mkdtemp(path.join(tmpdir(), 'fxb-dll-pref-missing-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const pluginDir = path.join(root, 'plugs', 'NoVfxinfo');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, 'Whatever.dll'), Buffer.from('dll'));
  const sinVfxinfo = (
    await dllPreference({
      pluginDir: pluginDir,
      dllName: 'Whatever.dll',
    }).expect(422)
  ).body as { message: string };
  assert.ok(sinVfxinfo.message.includes('vfxinfo'));
});
