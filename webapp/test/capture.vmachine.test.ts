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
  // El snapshot inicial contiene lo mismo que el staging: v-machine solo lee el
  // staging, así que aquí no se añade nada extra.
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
 *
 * El staging lo produce `POST /capture/package` de verdad: la prueba cubre así
 * que los archivos previos del plugin llegan ahí y se pueden revisar o quitar
 * antes de empaquetar.
 */
async function preExistingFixture(t: TestContext) {
  const { http, service } = await makeApp(t);
  const systemDir = await mkdtemp(path.join(tmpdir(), 'fxb-vmachine-sys-'));
  const pluginsDir = path.join(systemDir, 'VstPlugins');
  const diffId = randomUUID();
  const snapshotId = randomUUID();
  const stagingPath = path.join(service.stagingRoot, diffId);
  const targetDir = await mkdtemp(path.join(tmpdir(), 'fxb-vmachine-pkg-'));
  const { diffs, snapshots } = service as unknown as SeededService;
  t.after(async () => {
    diffs.delete(diffId);
    snapshots.delete(snapshotId);
    await rm(stagingPath, { recursive: true, force: true });
    await rm(systemDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  });

  const systemFile = (relative: string): string => path.join(pluginsDir, ...relative.split('/'));
  const writeSystem = async (relative: string, content: Buffer | string): Promise<void> => {
    const target = systemFile(relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };

  await writeSystem('P8.dll', pe32Dll());
  await writeSystem('P8/wavetables/table.wav', Buffer.from('RIFF'));
  await writeSystem('Other/Other.dll', pe32Dll());
  await writeSystem('Old.dll', pe32Dll());
  await writeSystem('presets/legacy.fxb', buildBank({ uniqueId: 'Lgcy' }));
  await writeSystem('P8.ini', '[P8]\n');
  await writeSystem('presets/factory.fxb', buildBank({ uniqueId: 'SwP8' }));

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

  const packaged = await http()
    .post('/capture/package')
    .send({ diffId, targetDir })
    .expect(200);

  return { http, diffId, packaged: packaged.body as { filesCopied: number; preExistingFiles: number; warnings: string[] } };
}

test('v-machine suma los archivos del plugin que ya existían antes de la captura', async (t) => {
  const { http, diffId, packaged } = await preExistingFixture(t);
  const outputDir = await mkdtemp(path.join(tmpdir(), 'fxb-vmachine-prev-'));
  t.after(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  // Los previos del plugin no se esconden: `/capture/package` los deja en el
  // staging para poder revisarlos y quitarlos antes de empaquetar.
  assert.equal(packaged.preExistingFiles, 3);
  assert.deepEqual(packaged.warnings, []);
  const staging = await http().get(`/capture/staging/${diffId}`).expect(200);
  const staged = (staging.body.files as string[]).map((file) => file.split(/[\\/]+/).join('/'));
  for (const relative of ['P8.dll', 'P8/wavetables/table.wav', 'presets/legacy.fxb']) {
    assert.ok(
      staged.some((file) => file.endsWith(`/${relative}`)),
      `el archivo previo "${relative}" debe aparecer en el staging`,
    );
  }
  for (const relative of ['Other/Other.dll', 'Old.dll']) {
    assert.ok(
      !staged.some((file) => file.endsWith(`/${relative}`)),
      `"${relative}" no es del plugin y no debe llegar al staging`,
    );
  }

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
  const { http, diffId, packaged } = await preExistingFixture(t);
  // El staging sí trae los previos: el filtro tiene que quitarlos al empaquetar.
  assert.equal(packaged.preExistingFiles, 3, 'el staging debe incluir los archivos previos del plugin');
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

/**
 * El paso 4 enseña cuántos archivos previos entran antes de generar, y ese
 * recuento sale del snapshot inicial: los mismos tres del fixture, sin el
 * vecino ni el DLL que la captura borró. Al quitar uno del staging baja a dos,
 * porque lo que no está en el staging no llega al banco.
 */
test('GET /capture/pre-existing cuenta los previos del snapshot inicial', async (t) => {
  const { http, diffId } = await preExistingFixture(t);

  const before = await http().get(`/capture/pre-existing/${diffId}`).expect(200);
  assert.equal(before.body.count, 3);
  const relative = (before.body.files as string[]).map((file) => file.split(/[\\/]+/).join('/'));
  for (const file of ['P8.dll', 'P8/wavetables/table.wav', 'presets/legacy.fxb']) {
    assert.ok(relative.some((entry) => entry.endsWith(file)), `falta el previo "${file}" en el recuento`);
  }
  for (const file of ['Other/Other.dll', 'Old.dll']) {
    assert.ok(
      !relative.some((entry) => entry.endsWith(file)),
      `"${file}" no es del plugin y no debe contarse`,
    );
  }
  assert.deepEqual(before.body.warnings, []);

  const staging = await http().get(`/capture/staging/${diffId}`).expect(200);
  const legacy = (staging.body.files as string[]).find((file) => file.endsWith('legacy.fxb'));
  assert.ok(legacy, 'el preset previo debe estar en el staging para poder quitarlo');
  await http().delete(`/capture/staging/${diffId}`).query({ path: legacy }).expect(200);

  const after = await http().get(`/capture/pre-existing/${diffId}`).expect(200);
  assert.equal(after.body.count, 2, 'lo quitado del staging ya no se va a incluir');
  assert.ok(
    !(after.body.files as string[]).some((file) => file.endsWith('legacy.fxb')),
    'el archivo quitado no puede seguir en el recuento',
  );
});

/**
 * El staging es la única fuente del paquete: un archivo previo del plugin que
 * se quita al revisar el staging no vuelve a aparecer al generar para v-machine.
 */
test('v-machine no empaqueta el archivo previo que se quita del staging', async (t) => {
  const { http, diffId } = await preExistingFixture(t);
  const outputDir = await mkdtemp(path.join(tmpdir(), 'fxb-vmachine-drop-'));
  t.after(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  const staging = await http().get(`/capture/staging/${diffId}`).expect(200);
  const legacy = (staging.body.files as string[]).find((file) => file.endsWith('legacy.fxb'));
  assert.ok(legacy, 'el preset previo debe estar en el staging para poder quitarlo');
  await http().delete(`/capture/staging/${diffId}`).query({ path: legacy }).expect(200);

  const response = await http()
    .post(`/capture/vmachine/${diffId}`)
    .send({ pluginName: PLUGIN_NAME, uniqueId: UNIQUE_ID, isSynth: true, outputDir })
    .expect(200);
  assert.deepEqual(response.body.warnings, []);

  const bankDir = path.join(outputDir, 'plugs', PLUGIN_NAME);
  await assert.rejects(
    stat(path.join(bankDir, 'presets', 'legacy.fxb')),
    'lo quitado del staging no debe acabar en el paquete',
  );
  for (const relative of ['P8.ini', 'P8.dll', 'P8/wavetables/table.wav', 'presets/factory.fxb']) {
    await assert.doesNotReject(
      stat(path.join(bankDir, ...relative.split('/'))),
      `falta "${relative}": solo se quitó el preset del staging`,
    );
  }

  // El paquete sigue siendo válido: un único banco, el capturado.
  const loader = path.join(outputDir, 'fxbLoader.dll');
  await writeFile(loader, pe32Dll());
  const scan = await http()
    .post('/library/scan')
    .send({ libraryRoot: outputDir, dllSourcePath: loader })
    .expect(200);
  const plugin = scan.body.plugins[0];
  assert.equal(plugin.compatible, true, JSON.stringify(plugin.compatibilityIssues));
  assert.deepEqual(plugin.banks, { count: 1, names: ['factory.fxb'] });
});

/**
 * Generar dos veces sobre la misma carpeta tiene que dar el paquete del staging
 * actual, no la unión de las dos generaciones. Un archivo que se quitó del
 * staging entre ambas no puede sobrevivir en `plugs\\<Plugin>\\`, ni su carpeta
 * contenedora: es justo lo que se revisa a mano antes de empaquetar.
 */
test('regenerar el paquete en la misma carpeta no deja archivos de la generación anterior', async (t) => {
  const { http, diffId } = await preExistingFixture(t);
  const outputDir = await mkdtemp(path.join(tmpdir(), 'fxb-vmachine-regen-'));
  t.after(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  const generate = () =>
    http()
      .post(`/capture/vmachine/${diffId}`)
      .send({ pluginName: PLUGIN_NAME, uniqueId: UNIQUE_ID, isSynth: true, outputDir })
      .expect(200);

  await generate();
  const bankDir = path.join(outputDir, 'plugs', PLUGIN_NAME);
  // Primera generación: lo capturado más todo lo previo del plugin.
  assert.deepEqual(await treeFiles(bankDir), [
    'P8.dll',
    'P8.ini',
    'P8/wavetables/table.wav',
    'presets/factory.fxb',
    'presets/legacy.fxb',
    'vfxinfo.txt',
  ]);

  // Se revisan el staging y se quitan dos previos: un preset y la carpeta de
  // datos del DLL (que deja `P8/wavetables/` vacía).
  const staging = await http().get(`/capture/staging/${diffId}`).expect(200);
  const removable = (staging.body.files as string[]).filter((file) =>
    file.endsWith('legacy.fxb') || file.endsWith(path.join('P8', 'wavetables', 'table.wav')),
  );
  assert.equal(removable.length, 2, 'los dos previos deben estar en el staging');
  for (const file of removable) {
    await http().delete(`/capture/staging/${diffId}`).query({ path: file }).expect(200);
  }

  const second = await generate();
  assert.deepEqual(second.body.warnings, []);

  // Ni los archivos quitados ni la carpeta que los contenía sobreviven.
  for (const relative of ['presets/legacy.fxb', 'P8/wavetables/table.wav', 'P8/wavetables']) {
    await assert.rejects(
      stat(path.join(bankDir, ...relative.split('/'))),
      `"${relative}" es de la generación anterior y no debe quedar en el paquete`,
    );
  }
  // El resto se regeneró completo.
  assert.deepEqual(await treeFiles(bankDir), [
    'P8.dll',
    'P8.ini',
    'presets/factory.fxb',
    'vfxinfo.txt',
  ]);
});

/**
 * El `.vfxwizard` no vive dentro de `plugs\\<Plugin>\\` sino suelto en la carpeta
 * de salida, así que el borrado de la generación anterior del plugin no lo
 * alcanza. Regenerar sin wizard tiene que retirarlo: si no, queda al lado del
 * paquete un archivo que describe algo que esta generación decidió no hacer.
 */
test('regenerar sin wizard borra el .vfxwizard de la generación anterior', async (t) => {
  const { http, diffId } = await preExistingFixture(t);
  const outputDir = await mkdtemp(path.join(tmpdir(), 'fxb-vmachine-nowizard-'));
  t.after(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  const wizardPath = path.join(outputDir, `${PLUGIN_NAME}.vfxwizard`);
  const generate = (extra: Record<string, unknown> = {}) =>
    http()
      .post(`/capture/vmachine/${diffId}`)
      .send({ pluginName: PLUGIN_NAME, uniqueId: UNIQUE_ID, isSynth: true, outputDir, ...extra })
      .expect(200);

  const first = await generate();
  assert.equal(first.body.wizardPath, wizardPath);
  await assert.doesNotReject(stat(wizardPath), 'la primera generación debe escribir el wizard');

  // El wizard de otro plugin en la misma carpeta no es de esta generación.
  const otherWizard = path.join(outputDir, 'Otro Plugin.vfxwizard');
  await writeFile(otherWizard, 'id: Otro\n');

  const bankDir = path.join(outputDir, 'plugs', PLUGIN_NAME);
  const packaged = await treeFiles(bankDir);

  const second = await generate({ generateWizard: false });
  assert.equal(second.body.wizardPath, undefined, 'sin wizard no hay ruta que devolver');
  await assert.rejects(
    stat(wizardPath),
    'el .vfxwizard de la generación anterior no debe quedar en la carpeta de salida',
  );
  await assert.doesNotReject(stat(otherWizard), 'el wizard de otro plugin no se toca');
  assert.deepEqual(await treeFiles(bankDir), packaged, 'el paquete del plugin se regenera igual');
});
