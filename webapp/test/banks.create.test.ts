import assert from 'node:assert/strict';
import * as fs from 'node:fs';
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
  const body: Record<string, unknown> = { libraryRoot: root, plugin };
  // En modo chunk el banco lleva un chunk opaco; `programNames` no aplica.
  if (extra['mode'] !== 'chunk' && extra['chunkHex'] === undefined) {
    body.programNames = ['Init'];
  }
  return http()
    .post('/library/banks/create')
    .send({ ...body, ...extra });
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

test('crea un banco FBCh con el chunk opaco del plugin (versiones 1 y 2)', async (t) => {
  const data = await scaffold(t, { plugin: 'Chunky' });
  const chunkHex = 'deadbeefcafe';

  const createdV1 = (
    await create(data.root, 'Chunky', {
      mode: 'chunk',
      chunkHex,
    }).expect(200)
  ).body as BankCreateResult;
  assert.ok(createdV1.bank, 'la respuesta lleva el banco revalidado');
  assert.equal(createdV1.bank.version, 1);
  assert.equal(createdV1.bank.uniqueId, 'MySy');
  assert.equal(createdV1.bank.numPrograms, 0);
  assert.ok(fs.existsSync(createdV1.target), 'existSync del .fxb creado');
  const v1Bytes = fs.readFileSync(createdV1.target);
  // Mismas constantes que usa `parseFxbBank` (little-endian del FourCC).
  const CCNK = 0x43636e4b;
  const FBCH = 0x46424368;
  assert.equal(v1Bytes.length, 156 + 4 + 6);
  assert.equal(v1Bytes.readUInt32LE(0), CCNK);
  assert.equal(v1Bytes.readUInt32LE(8), FBCH);
  assert.equal(v1Bytes.readUInt32LE(152), CCNK, 'chunkMagic de cierre');
  assert.equal(v1Bytes.readUInt32LE(156), 6, 'chunkSize');
  assert.deepEqual(v1Bytes.subarray(160), Buffer.from(chunkHex, 'hex'), 'chunk íntegro byte a byte');

  const createdV2 = (
    await create(data.root, 'Chunky', {
      mode: 'chunk',
      chunkHex,
      chunkVersion: 2,
      currentProgram: 2,
      chunkNumPrograms: 0,
      overwrite: true,
    }).expect(200)
  ).body as BankCreateResult;
  assert.equal(createdV2.status, 'overwritten', 'se reemplazó el banco existente');
  assert.equal(createdV2.bank.version, 2);
  assert.equal(createdV2.bank.currentProgram, 2, 'currentProgram solo en versión 2');
  assert.equal(createdV2.bank.chunkSize, 6);
});

test('rechaza el modo chunk con chunkHex vacío, no hexadecimal, userInfo ilegal o chunkVersion rara', async (t) => {
  const data = await scaffold(t, { plugin: 'Chunky' });
  await create(data.root, 'Chunky', { mode: 'chunk' }).expect(400);
  await create(data.root, 'Chunky', { chunkHex: '' }).expect(400);
  await create(data.root, 'Chunky', { chunkHex: 'no-es-hex' }).expect(400);
  await create(data.root, 'Chunky', { chunkHex: 'de ad be ef 0' }).expect(400);
  await create(data.root, 'Chunky', { chunkHex: 'beef', chunkVersion: 9 }).expect(400);    await create(data.root, 'Chunky', { chunkHex: 'beef', chunkNumPrograms: -1 }).expect(400);
  // En modo chunk no se admiten programas ni params.
  await create(data.root, 'Chunky', { chunkHex: 'beef', programNames: ['Init'] }).expect(400);
  await create(data.root, 'Chunky', { chunkHex: 'beef', numParams: 4 }).expect(400);

  // Y la orden corrupta queda en el log, no en el disco.
  const presets = path.join(data.root, 'plugs', 'Chunky', data.presets);
  if (fs.existsSync(presets)) {
    assert.equal(fs.readdirSync(presets).length, 0, 'ningún .fxb escrito con chunk inválido');
  }
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
