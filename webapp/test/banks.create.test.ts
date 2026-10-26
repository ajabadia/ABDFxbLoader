import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pe32Dll } from './helpers/pe';
import { writePluginDll } from './helpers/vfx-plugin';
import { parseFxbBank } from '../src/library/fxb-bank';
import type { BankCreateResult, BankInspectResult } from '../src/library/library.types';

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
  presets: string;
  dll: string;
}

/** Plugin con `vfxinfo.txt` (y su `id` opcional); el cargador solo si se pide. */
async function scaffold(
  t: TestContext,
  options: { plugin?: string; withId?: boolean; vfxinfo?: string } = {},
): Promise<Scaffold> {
  const plugin = options.plugin ?? 'Synth';
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-create-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pluginDir = path.join(root, 'plugs', plugin);
  await mkdir(pluginDir, { recursive: true });
  const lines =
    options.vfxinfo ??
    `name: ${plugin}\r\n` +
      (options.withId === false ? '' : `id: MySy\r\n`) +
      `dll_name: ${plugin}/${plugin}.dll\r\n`;
  await writeFile(path.join(pluginDir, 'vfxinfo.txt'), Buffer.from(lines, 'latin1'));
  await writePluginDll(pluginDir, `${plugin}/${plugin}.dll`);
  const dll = path.join(root, 'loader.dll');
  await writeFile(dll, pe32Dll());

  await http()
    .post('/library/loader/add')
    .send({ libraryRoot: root, plugin, dllSourcePath: dll })
    .expect(200);

  return { root, pluginDir, presets: path.join(pluginDir, 'presets'), dll };
}

function create(root: string, plugin: string, extra: Record<string, unknown> = {}) {
  return http()
    .post('/library/banks/create')
    .send({ libraryRoot: root, plugin, programNames: ['Init'], ...extra });
}

test('crea un banco FxBk con el FourCC del id de vfxinfo', async (t) => {
  const data = await scaffold(t, { plugin: 'MySynth' });

  const body = (
    await create(data.root, 'MySynth', {
      bankName: 'Init Bank.fxb',
      programNames: ['Init', '  ', 'Bright Rhodes'],
      numParams: 3,
      fxVersion: 1000,
    }).expect(200)
  ).body as BankCreateResult;

  assert.equal(body.status, 'created');
  assert.equal(body.fourCc, 'MySy');
  assert.equal(body.presetsDir, data.presets);
  assert.equal(body.bank.numPrograms, 3);
  assert.equal(body.plugin.name, 'MySynth');
  assert.deepEqual((await readdir(data.presets)).sort(), ['Init Bank.fxb']);

  const file = await readFile(path.join(data.presets, 'Init Bank.fxb'));
  const parsed = parseFxbBank(file);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.bank?.uniqueIdValue, 0x4d795379);
  assert.equal(parsed.bank?.fxVersion, 1000);
  // 156 de cabecera + 3 programas de 68 bytes (48 + 4*3 parámetros).
  assert.equal(file.length, 156 + 3 * 68);
});

test('reusa el nombre por defecto <plugin>.fxb y respeta overwrite=false', async (t) => {
  const data = await scaffold(t);

  const first = (
    await create(data.root, 'Synth').expect(200)
  ).body as BankCreateResult;
  assert.equal(first.status, 'created');
  assert.equal(path.basename(first.target), 'Synth.fxb');

  const second = (
    await create(data.root, 'Synth', { overwrite: false }).expect(409)
  );
  assert.match(second.body.message, /overwrite/);

  const again = (
    await create(data.root, 'Synth', { overwrite: true }).expect(200)
  ).body as BankCreateResult;
  assert.equal(again.status, 'overwritten');
});

test('cross-FourCC: el banco creado es incompatible con otro plugin', async (t) => {
  const source = await scaffold(t, { plugin: 'MySynth' });
  const target = await scaffold(t, { plugin: 'Other' });

  const created = (
    await create(source.root, 'MySynth', { programNames: ['Init'] }).expect(200)
  ).body as BankCreateResult;

  const inspected = (
    await http()
      .post('/library/banks/inspect')
      .send({
        sourcePath: created.target,
        libraryRoot: target.root,
        plugin: 'Other',
        expectedUniqueId: 'Othr',
      })
      .expect(200)
  ).body as BankInspectResult;

  assert.equal(inspected.compatibility, 'incompatible');
  assert.match(inspected.reason ?? '', /uniqueID/);
  assert.equal(inspected.existingBanks.length, 0);
});

test('rechaza crear sin vfxinfo id, con plugin ausente y peticiones mal formadas', async (t) => {
  const data = await scaffold(t, { plugin: 'NoId', vfxinfo: 'name: NoId\r\ndll_name: NoId/NoId.dll\r\n' });

  const noId = await create(data.root, 'NoId').expect(409);
  assert.match(noId.body.message, /línea `id`/);

  await create(data.root, 'Fantasma').expect(404);

  // Con id presente, las validaciones del cuerpo saltan antes de escribir.
  const ok = await scaffold(t, { plugin: 'WithId' });
  await create('relativa', 'WithId').expect(400);
  await create(ok.root, 'WithId', { programNames: [] }).expect(400);
  await create(ok.root, 'WithId', { programNames: [5 as never] }).expect(400);
  await create(ok.root, 'WithId', { programNames: ['Init'], numParams: -1 }).expect(400);
  await create(ok.root, 'WithId', { programNames: ['Init'], bankName: '../x.fxb' }).expect(400);
  await create(ok.root, 'WithId', { programNames: ['Init'], fxVersion: -5 }).expect(400);
});
