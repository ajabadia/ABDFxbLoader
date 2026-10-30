import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { PluginLogService } from '../src/plugin-log/plugin-log.service';
import { PluginMetaService } from '../src/plugin-meta/plugin-meta.service';
import { banksSkipReason } from './helpers/environment';
import { pe32Dll, pe64Dll } from './helpers/pe';
import {
  parseWizardText,
  serializeWizardToVfxinfo,
  toWizardSummary,
} from '../src/wizard/wizard-parser';
import {
  extractDllBase,
  normalizeName,
  resolveWizardsDir,
  WizardService,
} from '../src/wizard/wizard.service';

const SAMPLE_WIZARD_TEXT = `
dll_name: SuperWave P8/P8.dll
id: 1398231096
version: 1
dll_version: 1.0.0.1
name: SuperWave P8
name_abbreviation: P8
is_synth: 1
parameter_count: 89
program_count: 64
has_editor: 1
editor_width: 800
editor_height: 529
vendor: Superwave
vendor_url: http://home.btconnect.com/christopherg/
vendor_type: Free
genre: Synth
mac: 1

notes:
...
*Known Issues*
No known issues.

*Performance* 
Limited polyphony on 1ghz vmachine on some sounds.
...

dirs_to_copy:
...
/Program Files/Superwave/Presets
...

files_to_copy:
...
/windows/system32/special.dll
...

symlinks:
...
windows/system32/special.dll:P8/system32/special.dll
...

registry_keys:
...
REGEDIT4

[HKEY_LOCAL_MACHINE\\Software\\Superwave]
"InstallDir"="p:\\SuperWave P8"
...
`;

describe('Wizard Parser', () => {
  it('parsea correctamente campos simples, booleanos y números', () => {
    const wizard = parseWizardText(SAMPLE_WIZARD_TEXT, 'SuperWave P8/test.vfxwizard');

    assert.equal(wizard.id, '1398231096');
    assert.equal(wizard.name, 'SuperWave P8');
    assert.equal(wizard.nameAbbreviation, 'P8');
    assert.equal(wizard.dllName, 'SuperWave P8/P8.dll');
    assert.equal(wizard.isSynth, true);
    assert.equal(wizard.hasEditor, true);
    assert.equal(wizard.parameterCount, 89);
    assert.equal(wizard.programCount, 64);
    assert.equal(wizard.editorWidth, 800);
    assert.equal(wizard.editorHeight, 529);
    assert.equal(wizard.vendor, 'Superwave');
    assert.equal(wizard.vendorUrl, 'http://home.btconnect.com/christopherg/');
    assert.equal(wizard.genre, 'Synth');
    assert.equal(wizard.sourcePath, 'SuperWave P8/test.vfxwizard');
  });

  it('parsea correctamente bloques multilínea delimitados por ...', () => {
    const wizard = parseWizardText(SAMPLE_WIZARD_TEXT);

    assert.match(wizard.notes, /Known Issues/);
    assert.match(wizard.notes, /Limited polyphony/);
    assert.deepEqual(wizard.dirsToCopy, ['/Program Files/Superwave/Presets']);
    assert.deepEqual(wizard.filesToCopy, ['/windows/system32/special.dll']);
    assert.deepEqual(wizard.symlinks, ['windows/system32/special.dll:P8/system32/special.dll']);
    assert.match(wizard.registryKeys, /REGEDIT4/);
    assert.match(wizard.registryKeys, /HKEY_LOCAL_MACHINE\\Software\\Superwave/);
  });

  it('toWizardSummary extrae resumen ligero con flags booleanos', () => {
    const wizard = parseWizardText(SAMPLE_WIZARD_TEXT, 'test.vfxwizard', 'Read me first');
    const summary = toWizardSummary(wizard);

    assert.equal(summary.id, '1398231096');
    assert.equal(summary.name, 'SuperWave P8');
    assert.equal(summary.hasRegistryKeys, true);
    assert.equal(summary.hasFilesToCopy, true);
    assert.equal(summary.hasDirsToCopy, true);
    assert.equal(summary.hasReadme, true);
  });

  it('serializeWizardToVfxinfo genera formato vfxinfo.txt compatible', () => {
    const wizard = parseWizardText(SAMPLE_WIZARD_TEXT);
    const serialized = serializeWizardToVfxinfo(wizard);

    assert.match(serialized, /^id: 1398231096/m);
    assert.match(serialized, /^name: SuperWave P8/m);
    assert.match(serialized, /^dll_name: SuperWave P8\/P8\.dll/m);
    assert.match(serialized, /^parameter_count: 89/m);
    assert.match(serialized, /^editor_width: 800/m);
    assert.match(serialized, /registry_keys:\r?\n\.\.\.\r?\nREGEDIT4/);
  });
});

describe('Wizard Helpers', () => {
  it('normalizeName normaliza nombres ignorando signos, acentos y mayúsculas', () => {
    assert.equal(normalizeName('SuperWave P8'), 'superwavep8');
    assert.equal(normalizeName('  G-Force   M-Tron Pro! '), 'gforcemtronpro');
    assert.equal(normalizeName('ÁTonic'), 'atonic');
  });

  it('extractDllBase extrae el nombre base del DLL en minúsculas', () => {
    assert.equal(extractDllBase('SuperWave P8/P8.dll'), 'p8');
    assert.equal(extractDllBase('C:\\Vst\\Synth1\\Synth1 VST.DLL'), 'synth1 vst');
  });
});

describe('WizardService', () => {
  const metaService = new PluginMetaService();
  const wizardService = new WizardService(metaService);
  // `_banks/` no se versiona: en CI no hay base de datos real que indexar.
  const sinBanks = banksSkipReason();

  // El resto de estas pruebas comparten el servicio y necesitan su índice
  // cargado. Se indexa aquí una vez, con la base real si está y si no con el
  // catálogo empaquetado (el mismo que usa la app), en vez de depender de que
  // otra prueba lo haya hecho antes.
  before(async () => {
    await wizardService.initIndex(sinBanks === false ? resolveWizardsDir() : undefined);
  });

  it(
    'indexa la base de datos real de _banks/wizards con más de 200 plugins',
    { skip: sinBanks },
    async () => {
      const wizardsDir = resolveWizardsDir();
      assert.ok(existsSync(wizardsDir), `el directorio ${wizardsDir} debe existir`);

      const count = await wizardService.initIndex(wizardsDir);
      assert.ok(count >= 200, `se esperaban al menos 200 wizards, encontrados ${count}`);
    },
  );

  it('carga desde catálogo empaquetado JSON sin requerir escaneo de carpetas', async () => {
    const standaloneService = new WizardService(metaService);
    const count = await standaloneService.initIndex();
    assert.ok(count >= 200, `se esperaban al menos 200 wizards desde JSON, encontrados ${count}`);
    const records = standaloneService.getAll();
    assert.equal(records.length, count);
    const minimoog = standaloneService.match({ name: 'minimoog' });
    assert.ok(minimoog !== null, 'debe incluir wizards avanzados como Minimoog');
    assert.ok(minimoog?.filesToCopy.length > 0, 'Minimoog debe tener filesToCopy');
  });

  it('list permite buscar por texto y paginar resultados', () => {
    const result = wizardService.list({ query: 'SuperWave', limit: 10 });
    assert.ok(result.total >= 1);
    const found = result.items.find((item) => item.name.includes('SuperWave'));
    assert.ok(found !== undefined, 'debe encontrar SuperWave');
  });

  it('list ordena por campo y dirección, con vacíos al final y campo desconocido ignorado', async () => {
    const standaloneService = new WizardService(metaService);
    const count = await standaloneService.initIndex();
    assert.ok(count >= 200);

    const fetchAll = (sort?: string, dir?: string) => {
      const items: ReturnType<WizardService['list']>['items'] = [];
      for (let offset = 0; ; offset += 100) {
        const page = standaloneService.list({ limit: 100, offset, sort, dir }).items;
        if (page.length === 0) break;
        items.push(...page);
        if (items.length >= standaloneService.list({ limit: 1 }).total) break;
      }
      return items;
    };

    // Orden por defecto: name ascendente, igual que pedirlo explícitamente.
    const unordered = standaloneService.list({ limit: 100 }).items.slice(0, 5);
    assert.deepEqual(
      standaloneService.list({ limit: 5, sort: 'name', dir: 'asc' }).items,
      unordered,
    );

    // Ascendente y descendente por nombre: cada lista está ordenada de verdad.
    const cmpName = (a: string, b: string) =>
      a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
    const ascNames = fetchAll('name', 'asc').map((item) => item.name);
    for (let i = 1; i < ascNames.length; i++) {
      assert.ok(cmpName(ascNames[i - 1]!, ascNames[i]!) <= 0, `asc: ${ascNames[i - 1]} debe ir antes de ${ascNames[i]}`);
    }
    const descNames = fetchAll('name', 'desc').map((item) => item.name);
    for (let i = 1; i < descNames.length; i++) {
      assert.ok(cmpName(descNames[i - 1]!, descNames[i]!) >= 0, `desc: ${descNames[i - 1]} debe ir después de ${descNames[i]}`);
    }

    // Vacíos al final en ambos sentidos (el catálogo real tiene wizards sin fabricante).
    for (const dir of ['asc', 'desc'] as const) {
      const vendors = fetchAll('vendor', dir).map((item) => item.vendor.trim());
      assert.ok(vendors.some((v) => v === ''), 'debe haber wizards sin fabricante');
      const emptyFirstAt = vendors.indexOf('');
      assert.ok(
        vendors.slice(emptyFirstAt).every((v) => v === ''),
        `dir=${dir}: los vacíos quedan en bloque al final`,
      );
    }

    // Campo desconocido o dirección rara: vuelven al orden por defecto.
    assert.deepEqual(
      standaloneService.list({ limit: 5, sort: 'cuqui' }).items,
      standaloneService.list({ limit: 5 }).items,
    );
    assert.deepEqual(
      standaloneService.list({ limit: 5, sort: 'name', dir: 'arriba' }).items,
      standaloneService.list({ limit: 5 }).items,
    );
  });

  it('list ordena en servidor por campo y dirección solicitados', () => {
    const asc = wizardService.list({ sort: 'vendor', dir: 'asc', limit: 100 });
    const vendors: string[] = asc.items.map((w) => w.vendor);
    const noAscendente = vendors.findIndex((v, i) =>
      i + 1 < vendors.length &&
      v !== '' &&
      vendors[i + 1]! !== '' &&
      v.localeCompare(vendors[i + 1]!, undefined, { sensitivity: 'base', numeric: true }) > 0,
    );
    assert.equal(
      noAscendente,
      -1,
      noAscendente === -1 ? '' : `orden ascendente roto: ${vendors[noAscendente]!}`,  
    );

    const desc = wizardService.list({ sort: 'vendor', dir: 'desc', limit: 100 });
    const noDescendente = desc.items.findIndex((w, i) =>
      i + 1 < desc.items.length &&
      w.vendor !== '' &&
      desc.items[i + 1]!.vendor !== '' &&
      w.vendor.localeCompare(desc.items[i + 1]!.vendor, undefined, { sensitivity: 'base', numeric: true }) < 0,
    );
    assert.ok(noDescendente === -1, `orden descendente roto en ${noDescendente}`);
    assert.notDeepEqual(
      desc.items.slice(0, 10),
      asc.items.slice(0, 10),
      'desc debe invertir el orden respecto a asc',
    );

    const invalid = wizardService.list({ sort: 'noexiste', dir: 'raro', limit: 5 });
    assert.ok(invalid.items.length > 0, 'sort/dir inválidos vuelven al por defecto sin fallar');
    const nulos = wizardService.list({ sort: 'genre', dir: 'asc', limit: 100 });
    const ultimoNoNulo = nulos.items[nulos.items.length - 1];
    assert.ok(ultimoNoNulo && ultimoNoNulo.genre !== '', 'los vacíos van al final del listado');
  });

  it('getById recupera el wizard por su VST ID exacto', () => {
    const wizard = wizardService.getById('1398231096');
    assert.ok(wizard !== null, 'debe encontrar SuperWave P8 por ID');
    assert.equal(wizard?.name, 'SuperWave P8');
    assert.equal(wizard?.vendor, 'Superwave');
    assert.equal(wizard?.genre, 'Synth');
  });

  it('match encuentra wizard por ID, por nombre o por DLL', () => {
    // Coincidencia por ID
    const byId = wizardService.match({ id: '1398231096' });
    assert.equal(byId?.name, 'SuperWave P8');

    // Coincidencia por nombre aproximado
    const byName = wizardService.match({ name: 'superwave p8' });
    assert.equal(byName?.id, '1398231096');

    // Coincidencia por nombre de DLL
    const byDll = wizardService.match({ dllName: 'P8.dll' });
    assert.equal(byDll?.id, '1398231096');
  });

  it('createVfxinfo genera vfxinfo.txt y crea respaldo con force', async () => {
    const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'vfx-wizard-test-'));

    try {
      // 1. Generar vfxinfo.txt
      const result1 = await wizardService.createVfxinfo({
        pluginDir: tempDir,
        wizardId: '1398231096',
      });

      assert.equal(result1.created, true);
      assert.equal(result1.backedUp, false);
      const content = await fs.readFile(result1.path, 'utf8');
      assert.match(content, /id: 1398231096/);
      assert.match(content, /name: SuperWave P8/);

      // 2. Si ya existe y force=false, no lo sobreescribe
      const result2 = await wizardService.createVfxinfo({
        pluginDir: tempDir,
        wizardId: '1398231096',
        force: false,
      });
      assert.equal(result2.created, false);

      // 3. Con force=true, crea respaldo vfxinfo.tx_
      const result3 = await wizardService.createVfxinfo({
        pluginDir: tempDir,
        wizardId: '1398231096',
        force: true,
      });
      assert.equal(result3.created, true);
      assert.equal(result3.backedUp, true);
      assert.ok(existsSync(path.join(tempDir, 'vfxinfo.tx_')));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('applyToMeta vuelca metadatos del wizard en fxbLoader.meta.json', async () => {
    const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'vfx-meta-test-'));

    try {
      const snapshot = await wizardService.applyToMeta({
        pluginDir: tempDir,
        wizardId: '1398231096',
      });

      assert.equal(snapshot.exists, true);
      assert.equal(snapshot.common.id, '1398231096');
      assert.equal(snapshot.common.name, 'SuperWave P8');
      assert.equal(snapshot.common.vendor, 'Superwave');
      assert.equal(snapshot.common.genre, 'Synth');
      assert.equal(snapshot.common.name_abbreviation, wizardService.getById('1398231096')?.nameAbbreviation || '');
      assert.match(snapshot.common.notes, /Known Issues/);

      // El archivo en disco refleja los cambios
      const disk = await metaService.read(tempDir);
      assert.equal(disk.common.vendor, 'Superwave');
      assert.equal(disk.common.genre, 'Synth');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('installPlugin', () => {
    const logService = new PluginLogService();
    const serviceWithLog = new WizardService(metaService, logService);

    it('rechaza si la DLL de origen no existe', async () => {
      await serviceWithLog.initIndex();
      const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'vfx-install-err-'));
      try {
        await assert.rejects(
          async () => {
            await serviceWithLog.installPlugin({
              libraryRoot: tempDir,
              wizardId: '1398231096',
              dllSourcePath: path.join(tempDir, 'nonexistent.dll'),
            });
          },
          (err: Error) => err.message.includes('El archivo DLL de origen no existe'),
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('advierte y marca isCompatible32Bit: false si la DLL no es PE32 (32-bit)', async () => {
      await serviceWithLog.initIndex();
      const tempLib = await fs.mkdtemp(path.join(tmpdir(), 'vfx-install-arch-'));
      const fakeDll64 = path.join(tempLib, 'p8_64.dll');
      await fs.writeFile(fakeDll64, pe64Dll());
      try {
        const res = await serviceWithLog.installPlugin({
          libraryRoot: tempLib,
          wizardId: '1398231096',
          dllSourcePath: fakeDll64,
        });

        assert.equal(res.isCompatible32Bit, false);
        assert.ok(res.warnings.some((w) => w.includes('64 bits')));
      } finally {
        await fs.rm(tempLib, { recursive: true, force: true });
      }
    });

    it('instala el plugin correctamente creando árbol, vfxinfo, meta, presets y log', async () => {
      await serviceWithLog.initIndex();
      const tempLib = await fs.mkdtemp(path.join(tmpdir(), 'vfx-lib-install-'));
      const sourceDll = path.join(tempLib, 'original.dll');
      await fs.writeFile(sourceDll, pe32Dll());

      try {
        const res = await serviceWithLog.installPlugin({
          libraryRoot: tempLib,
          wizardId: '1398231096', // SuperWave P8
          dllSourcePath: sourceDll,
        });

        assert.equal(res.pluginName, 'SuperWave P8');
        assert.equal(res.dllName, 'SuperWave P8/P8.dll');
        assert.equal(res.isCompatible32Bit, true);
        assert.equal(res.vfxinfoCreated, true);
        assert.equal(res.metaCreated, true);
        assert.equal(res.registryFileCreated, false);
        assert.ok(existsSync(res.pluginDir));
        assert.ok(existsSync(res.dllPath));
        assert.ok(existsSync(path.join(res.pluginDir, 'vfxinfo.txt')));
        assert.ok(existsSync(path.join(res.pluginDir, 'fxbLoader.meta.json')));

        // Verificar vfxinfo.txt
        const vfxinfo = await fs.readFile(path.join(res.pluginDir, 'vfxinfo.txt'), 'utf8');
        assert.match(vfxinfo, /id: 1398231096/);
        assert.match(vfxinfo, /SuperWave P8/);

        // Verificar fxbLoader.meta.json
        const meta = await metaService.read(res.pluginDir);
        assert.equal(meta.common.vendor, 'Superwave');
        assert.equal(meta.common.genre, 'Synth');

        // Verificar carpeta presets
        assert.ok(existsSync(path.join(res.pluginDir, 'presets')));

        // Verificar log
        const logContent = await fs.readFile(path.join(res.pluginDir, 'fxbLoader.log'), 'utf8');
        assert.match(logContent, /Instalado desde wizard: SuperWave P8/);

        // Intentar instalar de nuevo sin overwrite debe dar conflicto
        await assert.rejects(
          async () => {
            await serviceWithLog.installPlugin({
              libraryRoot: tempLib,
              wizardId: '1398231096',
              dllSourcePath: sourceDll,
              overwrite: false,
            });
          },
          (err: Error) => err.message.includes('ya existe en la librería destino'),
        );

        // Con overwrite: true debe permitir reinstalación
        const overwriteRes = await serviceWithLog.installPlugin({
          libraryRoot: tempLib,
          wizardId: '1398231096',
          dllSourcePath: sourceDll,
          overwrite: true,
        });
        assert.equal(overwriteRes.vfxinfoCreated, true);
      } finally {
        await fs.rm(tempLib, { recursive: true, force: true });
      }
    });

    it('vuelca registry_keys.reg si el wizard contiene claves del registro', async () => {
      await serviceWithLog.initIndex();
      const tempLib = await fs.mkdtemp(path.join(tmpdir(), 'vfx-lib-reg-'));
      const sourceDll = path.join(tempLib, 'minimoog.dll');
      await fs.writeFile(sourceDll, pe32Dll());

      try {
        const res = await serviceWithLog.installPlugin({
          libraryRoot: tempLib,
          wizardId: '5065038', // Minimoog V Original
          dllSourcePath: sourceDll,
        });

        assert.equal(res.registryFileCreated, true);
        assert.ok(res.registryFilePath && existsSync(res.registryFilePath));
        const regContent = await fs.readFile(res.registryFilePath!, 'utf8');
        assert.match(regContent, /REGEDIT4/);
        assert.match(regContent, /Arturia\\minimoog V/);
      } finally {
        await fs.rm(tempLib, { recursive: true, force: true });
      }
    });
  });

  describe('createFromPlugin', () => {
    async function makePlugin(
      root: string,
      options: { name?: string; withVfxinfo?: boolean; dllInSubdir?: boolean } = {},
    ): Promise<string> {
      const folder = options.name ?? 'FSynthz-15';
      const pluginDir = path.join(root, 'plugs', folder);
      await fs.mkdir(pluginDir, { recursive: true });
      if (options.withVfxinfo !== false) {
        const lines = [
          'id: 1177630041',
          `dll_name: ${folder}/15.dll`,
          'name: 15 - SynthEdit',
          'is_synth: 1',
          'parameter_count: 16',
          'program_count: 16',
          'has_editor: 1',
          'editor_width: 273',
          'editor_height: 167',
          '',
        ];
        await fs.writeFile(path.join(pluginDir, 'vfxinfo.txt'), lines.join('\r\n'), 'latin1');
      }
      const binaryDir = options.dllInSubdir === false ? pluginDir : path.join(pluginDir, folder);
      await fs.mkdir(binaryDir, { recursive: true });
      await fs.writeFile(path.join(binaryDir, '15.dll'), pe32Dll());
      return pluginDir;
    }

    it('genera el .vfxwizard desde vfxinfo, meta y el DLL que vive en la carpeta del plugin', async () => {
      const tempWizards = await fs.mkdtemp(path.join(tmpdir(), 'vfx-wizards-'));
      const tempLib = await fs.mkdtemp(path.join(tmpdir(), 'vfx-plugin-'));
      const service = new WizardService(metaService);
      try {
        // Catálogo local aislado: no se toca `_banks/wizards`.
        await service.initIndex(tempWizards);
        const pluginDir = await makePlugin(tempLib);
        await metaService.write({
          pluginDir,
          expectedMtimeMs: null,
          common: { vendor: 'SynthEdit', genre: 'Synth', notes: 'Creado a mano' },
          extended: {},
        });

        const result = await service.createFromPlugin({ pluginDir });

        assert.equal(result.created, true);
        assert.equal(path.dirname(result.wizardPath), path.join(tempWizards, 'custom'));
        assert.equal(path.basename(result.wizardPath), '15 - SynthEdit.vfxwizard');
        assert.ok(existsSync(result.wizardPath));

        // El DLL se localiza dentro del plugin (`<plugin>/<plugin>/15.dll`).
        assert.equal(result.record.dllName, 'FSynthz-15/15.dll');
        // Fabricante, género y notas llegan desde fxbLoader.meta.json.
        assert.equal(result.record.vendor, 'SynthEdit');
        assert.equal(result.record.genre, 'Synth');
        assert.equal(result.record.notes, 'Creado a mano');

        const written = parseWizardText(await fs.readFile(result.wizardPath, 'latin1'));
        assert.equal(written.id, '1177630041');
        assert.equal(written.name, '15 - SynthEdit');
        assert.equal(written.dllName, 'FSynthz-15/15.dll');
        assert.equal(written.parameterCount, 16);
        assert.equal(written.editorWidth, 273);

        // Queda indexado de inmediato: `match` lo resuelve por nombre de DLL.
        assert.equal(service.match({ dllName: '15.dll' })?.id, '1177630041');

        // El stub PE32 no declara exportaciones VST: se avisa sin fallar.
        assert.ok(result.warnings.some((w) => w.includes('VSTPluginMain')));
      } finally {
        await fs.rm(tempWizards, { recursive: true, force: true });
        await fs.rm(tempLib, { recursive: true, force: true });
      }
    });

    it('encuentra el DLL aunque esté en una subcarpeta y avisa si es de 64 bits', async () => {
      const tempWizards = await fs.mkdtemp(path.join(tmpdir(), 'vfx-wizards-'));
      const tempLib = await fs.mkdtemp(path.join(tmpdir(), 'vfx-plugin-'));
      const service = new WizardService(metaService);
      try {
        await service.initIndex(tempWizards);
        const pluginDir = await makePlugin(tempLib, { dllInSubdir: false });
        // Sustituye el stub de 32 bits por uno de 64 para provocar el aviso.
        await fs.writeFile(path.join(pluginDir, '15.dll'), pe64Dll());

        const result = await service.createFromPlugin({ pluginDir });
        assert.equal(result.record.dllName, '15.dll');
        assert.ok(result.warnings.some((w) => w.includes('64 bits')));
      } finally {
        await fs.rm(tempWizards, { recursive: true, force: true });
        await fs.rm(tempLib, { recursive: true, force: true });
      }
    });

    it('rechaza un plugin sin vfxinfo.txt y no sobrescribe un wizard existente sin overwrite', async () => {
      const tempWizards = await fs.mkdtemp(path.join(tmpdir(), 'vfx-wizards-'));
      const tempLib = await fs.mkdtemp(path.join(tmpdir(), 'vfx-plugin-'));
      const service = new WizardService(metaService);
      try {
        await service.initIndex(tempWizards);

        const sinVfxinfo = await makePlugin(tempLib, { name: 'Sin vfxinfo', withVfxinfo: false });
        await assert.rejects(
          async () => {
            await service.createFromPlugin({ pluginDir: sinVfxinfo });
          },
          (err: Error) => err.message.includes('no tiene vfxinfo.txt'),
        );

        const pluginDir = await makePlugin(tempLib);
        await service.createFromPlugin({ pluginDir });
        await assert.rejects(
          async () => {
            await service.createFromPlugin({ pluginDir });
          },
          (err: Error) => err.message.includes('Ya existe el wizard'),
        );

        const overwritten = await service.createFromPlugin({ pluginDir, overwrite: true });
        assert.equal(overwritten.created, true);
      } finally {
        await fs.rm(tempWizards, { recursive: true, force: true });
        await fs.rm(tempLib, { recursive: true, force: true });
      }
    });
  });
});
