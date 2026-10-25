import assert from 'node:assert/strict';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { FxbConfigService } from '../src/fxb-config/fxb-config.service';
import { LibraryImportService } from '../src/library/library-import.service';
import { LibraryController } from '../src/library/library.controller';
import { LibraryService } from '../src/library/library.service';
import { pe32Dll } from './helpers/pe';

const controller = new LibraryController(
  new LibraryService(new FxbConfigService()),
  new LibraryImportService(),
);

interface Fixture {
  root: string;
  pluginDir: string;
  dllSource: string;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-ctl-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pluginDir = path.join(root, 'plugs', 'Synth');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, 'vfxinfo.txt'),
    Buffer.from('name: S\r\ndll_name: Synth/Synth.dll\r\n', 'latin1'),
  );
  await mkdir(path.join(pluginDir, 'Synth'), { recursive: true });
  await writeFile(path.join(pluginDir, 'Synth', 'Synth.dll'), pe32Dll());

  const dllSource = path.join(root, 'fxbLoader.dll');
  await writeFile(dllSource, pe32Dll());
  return { root, pluginDir, dllSource };
}

test('loader/add traduce PluginStateError a 409', async (t) => {
  const { root, dllSource } = await fixture(t);
  await controller.addLoader({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource });

  await assert.rejects(
    controller.addLoader({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource }),
    ConflictException,
  );
});

test('loader/add traduce rutas inválidas a 400 y plugin inexistente a 404', async (t) => {
  const { root, dllSource } = await fixture(t);

  await assert.rejects(
    controller.addLoader({ libraryRoot: 'relative', plugin: 'Synth', dllSourcePath: dllSource }),
    BadRequestException,
  );
  await assert.rejects(
    controller.addLoader({ libraryRoot: root, plugin: '../Synth', dllSourcePath: dllSource }),
    BadRequestException,
  );
  await assert.rejects(
    controller.addLoader({ libraryRoot: root, plugin: 'Ghost', dllSourcePath: dllSource }),
    NotFoundException,
  );
});

test('loader/add traduce vfxinfo sin dll_name a 422', async (t) => {
  const { root, pluginDir, dllSource } = await fixture(t);
  await writeFile(path.join(pluginDir, 'vfxinfo.txt'), 'name: S\r\n');

  await assert.rejects(
    controller.addLoader({ libraryRoot: root, plugin: 'Synth', dllSourcePath: dllSource }),
    UnprocessableEntityException,
  );
});

test('loader/remove traduce sin cargador a 409', async (t) => {
  const { root } = await fixture(t);

  await assert.rejects(
    controller.removeLoader({ libraryRoot: root, plugin: 'Synth' }),
    ConflictException,
  );
});

test('scan exige libraryRoot y devuelve el listado', async (t) => {
  const { root, dllSource } = await fixture(t);

  await assert.rejects(controller.scan({}), BadRequestException);

  const result = await controller.scan({ libraryRoot: root, dllSourcePath: dllSource });
  assert.equal(result.plugins.length, 1);
  assert.equal(result.plugins[0]?.name, 'Synth');
  assert.equal(result.loader.valid, true);
  assert.equal(result.plugins[0]?.compatible, true);
});
