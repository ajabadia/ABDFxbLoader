import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CaptureService } from '../src/capture/capture.service';
import type { CaptureDiff, CaptureSnapshot } from '../src/capture/capture.types';
import { buildBank } from './helpers/fxb-bank';
import { pe32Dll } from './helpers/pe';

/**
 * Empaquetado de v-machine con un staging sintético.
 *
 * Un diff real exige dos capturas del sistema (minutos y acceso al registro),
 * así que las pruebas siembran el `diffs` y los `snapshots` del servicio, y
 * escriben en disco el staging con la forma que deja `POST /capture/package`:
 * rutas relativas a la unidad de origen, los metadatos de la captura y el
 * `.reg` en UTF-16LE.
 *
 * Lo que se fija es el contrato que usa el frontal: el paquete generado tiene
 * la estructura de una librería real (`plugs\<Plugin>\` con el DLL en la raíz,
 * `vfxinfo.txt`, `presets\` y el registro), suma los archivos del plugin que ya
 * existían antes de la captura y `POST /library/scan` —la misma ruta que
 * escanea una librería del disco— lo reconoce como plugin compatible.
 */

const PLUGIN_NAME = 'SuperWave P8';
const UNIQUE_ID = '1398231096';

interface SeededService {
  diffs: Map<string, CaptureDiff>;
  snapshots: Map<string, CaptureSnapshot>;
}

/** Diff mínimo con las rutas de una captura; el empaquetado solo usa recuentos. */
function syntheticDiff(snapshotIdBefore: string, capturedFiles: string[]): CaptureDiff {
  return {
    snapshotIdBefore,
    snapshotIdAfter: randomUUID(),
    createdAt: new Date().toISOString(),
    addedFiles: capturedFiles.map((file) => ({ path: file, size: 0, mtimeMs: 0, isDir: false })),
    modifiedFiles: [],
    removedFiles: [],
    addedRegistry: [],
    modifiedRegistry: [],
    removedRegistry: [],
    filteredOut: 0,
  };
}

/** Snapshot inicial con los archivos que existían antes de la captura. */
function snapshotWith(id: string, files: string[]): CaptureSnapshot {
  return {
    id,
    createdAt: new Date().toISOString(),
    platform: 'win32',
    files: files.map((file) => ({ path: file, size: 0, mtimeMs: 0, isDir: false })),
    registry: [],
    scanRoots: [],
    registryRoots: [],
  };
}

/**
 * Árbol del paquete como rutas posix ordenadas. Fija la estructura exacta: un
 * archivo de más (metadatos de la captura, residuos de escritura atómica) o de
 * menos rompe la prueba, que es justo lo que ya pasó una vez.
 */
async function treeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  await walk(root);
  return files.sort();
}

async function makeApp(t: TestContext) {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  t.after(async () => {
    await app.close();
  });
  return { http: () => request(app.getHttpServer()), service: app.get(CaptureService) };
}

test('v-machine empaqueta el staging sintético con la estructura de la librería', async (t) => {
  const { http, service } = await makeApp(t);
  const outputDir = await mkdtemp(path.join(tmpdir(), 'fxb-vmachine-'));
  const diffId = randomUUID();
  const snapshotId = randomUUID();
  const stagingPath = path.join(service.stagingRoot, diffId);
  const capturedRoot = 'C:\\Users\\tester\\Program Files\\VstPlugins';
  const staged = ['P8.dll', 'presets/factory.fxb'];
  const { diffs, snapshots } = service as unknown as SeededService;
  t.after(async () => {
    diffs.delete(diffId);
    snapshots.delete(snapshotId);
    await rm(stagingPath, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  });

  const writeStaged = async (relative: string, content: Buffer | string): Promise<void> => {
    const target = path.join(stagingPath, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };

  await writeStaged('P8.dll', pe32Dll());
  await writeStaged('presets/factory.fxb', buildBank({ uniqueId: 'SwP8' }));
  // Metadatos que empaqueta `packageDiff` y no deben acabar dentro del plugin.
  await writeStaged('manifest.json', '{}');
  await writeStaged('capture_diff.json', '{}');
  await writeStaged(
    'registry_changes.reg',
    Buffer.from(
      'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_LOCAL_MACHINE\\Software\\SuperWave]\r\n',
      'utf16le',
    ),
  );

  const capturedFiles = staged.map((file) => `${capturedRoot}\\${file.split('/').join('\\')}`);
  // El snapshot inicial contiene los mismos archivos que el staging: no queda
  // nada previo que recuperar y no debe aparecer el aviso por ello.
  snapshots.set(snapshotId, snapshotWith(snapshotId, capturedFiles));
  diffs.set(diffId, syntheticDiff(snapshotId, capturedFiles));

  const response = await http()
    .post(`/capture/vmachine/${diffId}`)
    .send({
      pluginName: PLUGIN_NAME,
      uniqueId: UNIQUE_ID,
      isSynth: true,
      vendor: 'SuperWave',
      outputDir,
    })
    .expect(200);

  const bankDir = path.join(outputDir, 'plugs', PLUGIN_NAME);
  assert.equal(response.body.bankDir, bankDir);
  assert.deepEqual(response.body.warnings, [], 'el staging tiene DLL: no debe haber avisos');

  // Estructura de una librería real, con el DLL en la raíz del plugin.
  await assert.doesNotReject(stat(path.join(bankDir, 'P8.dll')), 'falta el DLL en la raíz');
  await assert.doesNotReject(stat(path.join(bankDir, 'presets', 'factory.fxb')), 'falta el banco');
  // Los metadatos de la captura no son parte del plugin.
  for (const skipped of ['manifest.json', 'capture_diff.json']) {
    await assert.rejects(stat(path.join(bankDir, skipped)), `${skipped} se copió al plugin`);
  }
  // El registro va aparte, con el nombre que espera la librería.
  const registry = await readFile(path.join(bankDir, 'registry_keys.reg'));
  assert.match(registry.toString('utf16le'), /HKEY_LOCAL_MACHINE\\Software\\SuperWave/);

  // `vfxinfo.txt` en la raíz y `dll_name` relativo a esa carpeta.
  const vfxinfo = (await readFile(path.join(bankDir, 'vfxinfo.txt'), 'latin1')).split(/\r?\n/);
  for (const line of [
    `id: ${UNIQUE_ID}`,
    `name: ${PLUGIN_NAME}`,
    'dll_name: P8.dll',
    'is_synth: 1',
    'genre: Synth',
    'vendor: SuperWave',
  ]) {
    assert.ok(vfxinfo.includes(line), `vfxinfo.txt no declara "${line}"`);
  }

  // El wizard se genera junto al paquete, no dentro del plugin.
  const wizardPath = path.join(outputDir, `${PLUGIN_NAME}.vfxwizard`);
  assert.equal(response.body.wizardPath, wizardPath);
  const wizard = (await readFile(wizardPath, 'utf8')).split(/\r?\n/);
  assert.ok(wizard.includes(`id: ${UNIQUE_ID}`), 'el wizard no conserva el ID del plugin');
  assert.ok(wizard.includes('dll_name: P8.dll'), 'el wizard no apunta al DLL del paquete');
  assert.ok(
    wizard.includes(`Generado desde captura ThinApp - Diff: ${diffId}`),
    'el wizard no deja constancia del diff de origen',
  );
  await assert.rejects(stat(path.join(bankDir, `${PLUGIN_NAME}.vfxwizard`)));

  // La app reconoce su propia salida con el escáner de librerías.
  const loader = path.join(outputDir, 'fxbLoader.dll');
  await writeFile(loader, pe32Dll());
  const scan = await http()
    .post('/library/scan')
    .send({ libraryRoot: outputDir, dllSourcePath: loader })
    .expect(200);

  assert.equal(scan.body.loader.valid, true);
  assert.equal(scan.body.plugins.length, 1, 'el paquete debe aparecer como un único plugin');
  const plugin = scan.body.plugins[0];
  assert.equal(plugin.name, PLUGIN_NAME);
  assert.equal(plugin.hasVfxinfo, true);
  assert.equal(
    plugin.compatible,
    true,
    `el escaneo no lo da por compatible: ${JSON.stringify(plugin.compatibilityIssues)}`,
  );
  assert.deepEqual(plugin.banks, { count: 1, names: ['factory.fxb'] });
  assert.deepEqual(plugin.warnings, [], 'el propio paquete no debe generar avisos de escaneo');

  // Estructura exacta: nada de metadatos de la captura ni residuos del staging.
  assert.deepEqual(await treeFiles(bankDir), [
    'P8.dll',
    'presets/factory.fxb',
    'registry_keys.reg',
    'vfxinfo.txt',
  ]);
  assert.deepEqual(await treeFiles(path.join(outputDir, 'plugs')), [
    `${PLUGIN_NAME}/P8.dll`,
    `${PLUGIN_NAME}/presets/factory.fxb`,
    `${PLUGIN_NAME}/registry_keys.reg`,
    `${PLUGIN_NAME}/vfxinfo.txt`,
  ]);
});

/**
 * Captura donde el plugin ya existía en disco antes de empezar: la captura solo
 * añadió `P8.ini` y `presets/factory.fxb`, y hay piezas del plugin (DLL, datos,
 * un preset), otro plugin de la misma carpeta y un DLL que la captura borró.
 */
async function preExistingFixture(t: TestContext) {
  const { http, service } = await makeApp(t);
  const systemDir = await mkdtemp(path.join(tmpdir(), 'fxb-vmachine-sys-'));
  const pluginsDir = path.join(systemDir, 'VstPlugins');
  const diffId = randomUUID();
  const snapshotId = randomUUID();
  const stagingPath = path.join(service.stagingRoot, diffId);
  const { diffs, snapshots } = service as unknown as SeededService;
  t.after(async () => {
    diffs.delete(diffId);
    snapshots.delete(snapshotId);
    await rm(stagingPath, { recursive: true, force: true });
    await rm(systemDir, { recursive: true, force: true });
  });

  const systemFile = (relative: string): string => path.join(pluginsDir, ...relative.split('/'));
  const writeSystem = async (relative: string, content: Buffer | string): Promise<void> => {
    const target = systemFile(relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  // El staging conserva la ruta relativa a la unidad, como `packageDiff`.
  const writeStagedFromSystem = async (relative: string): Promise<void> => {
    const staged = path.relative(path.parse(systemDir).root, systemFile(relative));
    const target = path.join(stagingPath, staged);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(systemFile(relative)));
  };

  await writeSystem('P8.dll', pe32Dll());
  await writeSystem('P8/wavetables/table.wav', Buffer.from('RIFF'));
  await writeSystem('Other/Other.dll', pe32Dll());
  await writeSystem('Old.dll', pe32Dll());
  await writeSystem('presets/legacy.fxb', buildBank({ uniqueId: 'Lgcy' }));
  await writeSystem('P8.ini', '[P8]\n');
  await writeSystem('presets/factory.fxb', buildBank({ uniqueId: 'SwP8' }));
  await writeStagedFromSystem('P8.ini');
  await writeStagedFromSystem('presets/factory.fxb');

  const captured = [systemFile('P8.ini'), systemFile('presets/factory.fxb')];
  snapshots.set(
    snapshotId,
    snapshotWith(snapshotId, [
      systemFile('P8.dll'),
      systemFile('P8/wavetables/table.wav'),
      systemFile('Other/Other.dll'),
      systemFile('Old.dll'),
      systemFile('presets/legacy.fxb'),
    ]),
  );
  const diff = syntheticDiff(snapshotId, captured);
  diff.removedFiles.push({ path: systemFile('Old.dll'), size: 0, mtimeMs: 0, isDir: false });
  diffs.set(diffId, diff);

  return { http, diffId };
}

test('v-machine suma los archivos del plugin que ya existían antes de la captura', async (t) => {
  const { http, diffId } = await preExistingFixture(t);
  const outputDir = await mkdtemp(path.join(tmpdir(), 'fxb-vmachine-prev-'));
  t.after(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  const response = await http()
    .post(`/capture/vmachine/${diffId}`)
    .send({ pluginName: PLUGIN_NAME, uniqueId: UNIQUE_ID, isSynth: true, outputDir })
    .expect(200);
  assert.deepEqual(response.body.warnings, []);

  const bankDir = path.join(outputDir, 'plugs', PLUGIN_NAME);
  for (const relative of [
    'P8.ini',
    'P8.dll',
    'P8/wavetables/table.wav',
    'presets/factory.fxb',
    'presets/legacy.fxb',
  ]) {
    await assert.doesNotReject(
      stat(path.join(bankDir, ...relative.split('/'))),
      `falta el archivo previo "${relative}" en el paquete`,
    );
  }
  // Los archivos de otro plugin de la misma carpeta y el que se borró no viajan.
  for (const relative of ['Other/Other.dll', 'Old.dll']) {
    await assert.rejects(
      stat(path.join(bankDir, ...relative.split('/'))),
      `"${relative}" no es del plugin y no debe empaquetarse`,
    );
  }
  const vfxinfo = (await readFile(path.join(bankDir, 'vfxinfo.txt'), 'latin1')).split(/\r?\n/);
  assert.ok(vfxinfo.includes('dll_name: P8.dll'), 'el DLL previo debe ser el principal');

  const loader = path.join(outputDir, 'fxbLoader.dll');
  await writeFile(loader, pe32Dll());
  const scan = await http()
    .post('/library/scan')
    .send({ libraryRoot: outputDir, dllSourcePath: loader })
    .expect(200);
  const plugin = scan.body.plugins[0];
  assert.equal(plugin.compatible, true, JSON.stringify(plugin.compatibilityIssues));
  assert.deepEqual(plugin.banks, { count: 2, names: ['factory.fxb', 'legacy.fxb'] });

  // Lo capturado y lo previo conviven sin duplicar el plugin ni su carpeta de
  // datos, y sin arrastrar el vecino ni el DLL borrado.
  assert.deepEqual(await treeFiles(bankDir), [
    'P8.dll',
    'P8.ini',
    'P8/wavetables/table.wav',
    'presets/factory.fxb',
    'presets/legacy.fxb',
    'vfxinfo.txt',
  ]);
});

test('v-machine respeta includePreExisting:false y empaqueta solo lo capturado', async (t) => {
  const { http, diffId } = await preExistingFixture(t);
  const outputDir = await mkdtemp(path.join(tmpdir(), 'fxb-vmachine-only-'));
  t.after(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  const response = await http()
    .post(`/capture/vmachine/${diffId}`)
    .send({
      pluginName: PLUGIN_NAME,
      uniqueId: UNIQUE_ID,
      isSynth: true,
      outputDir,
      includePreExisting: false,
    })
    .expect(200);

  const bankDir = path.join(outputDir, 'plugs', PLUGIN_NAME);
  // Lo que cambió durante la captura sigue ahí.
  for (const relative of ['P8.ini', 'presets/factory.fxb']) {
    await assert.doesNotReject(
      stat(path.join(bankDir, ...relative.split('/'))),
      `falta el archivo capturado "${relative}"`,
    );
  }
  // Ni el plugin previo ni el de al lado viajan cuando la opción está apagada.
  for (const relative of [
    'P8.dll',
    'P8/wavetables/table.wav',
    'presets/legacy.fxb',
    'Other/Other.dll',
    'Old.dll',
  ]) {
    await assert.rejects(
      stat(path.join(bankDir, ...relative.split('/'))),
      `"${relative}" no debería empaquetarse con includePreExisting:false`,
    );
  }

  // Sin DLL en el paquete queda el aviso y un `dll_name` de relleno.
  assert.equal(response.body.warnings.length, 1);
  assert.match(response.body.warnings[0], /No se encontró ningún DLL en el staging/);
  const vfxinfo = (await readFile(path.join(bankDir, 'vfxinfo.txt'), 'latin1')).split(/\r?\n/);
  assert.ok(vfxinfo.includes(`dll_name: ${PLUGIN_NAME}/${PLUGIN_NAME}.dll`));
  assert.deepEqual(await treeFiles(bankDir), [
    'P8.ini',
    'presets/factory.fxb',
    'vfxinfo.txt',
  ]);
});
