import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { copyFileAtomic, writeFileAtomic } from '../common/atomic-file';
import { inspectPeFile } from '../library/pe';
import { PluginLogService } from '../plugin-log/plugin-log.service';
import { PluginMetaService } from '../plugin-meta/plugin-meta.service';
import type { PluginMetaSnapshot } from '../plugin-meta/plugin-meta.types';
import { parseWizardText, serializeWizardToVfxinfo, toWizardSummary } from './wizard-parser';
import type {
  WizardApplyMetaInput,
  WizardCreateVfxinfoInput,
  WizardInstallPluginInput,
  WizardInstallPluginResult,
  WizardListResult,
  WizardMatchQuery,
  WizardRecord,
  WizardSummary,
} from './wizard.types';

const VFXINFO_FILENAME = 'vfxinfo.txt';
const VFXINFO_BACKUP_FILENAME = 'vfxinfo.tx_';

/**
 * Resuelve la ruta al directorio `_banks/wizards` comprobando variables de entorno
 * y rutas relativas comunes en desarrollo y producción.
 */
export function resolveWizardsDir(): string {
  const envPath = process.env['FXB_WIZARDS_DIR']?.trim();
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  const candidates = [
    path.resolve(__dirname, '..', '..', '..', '_banks', 'wizards'),
    path.resolve(__dirname, '..', '..', '_banks', 'wizards'),
    path.resolve(process.cwd(), '..', '_banks', 'wizards'),
    path.resolve(process.cwd(), '_banks', 'wizards'),
    'D:\\desarrollos\\ABDSynths\\ABDfxbloader\\_banks\\wizards',
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0]!;
}

/**
 * Busca el archivo JSON de catálogo empaquetado `wizards-catalog.json`.
 */
export function resolveCatalogJsonPath(): string | null {
  const envPath = process.env['FXB_WIZARDS_CATALOG_JSON']?.trim();
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  const candidates = [
    path.resolve(__dirname, 'wizards-catalog.json'),
    path.resolve(__dirname, '..', '..', 'src', 'wizard', 'wizards-catalog.json'),
    path.resolve(process.cwd(), 'src', 'wizard', 'wizards-catalog.json'),
    path.resolve(process.cwd(), 'webapp', 'src', 'wizard', 'wizards-catalog.json'),
    path.resolve(process.cwd(), 'dist', 'src', 'wizard', 'wizards-catalog.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Normaliza un nombre quitando espacios, signos y mayúsculas para búsquedas flexibles. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Extrae el nombre base del archivo DLL sin extensión. */
export function extractDllBase(dllPath: string): string {
  if (!dllPath) return '';
  const clean = dllPath.replace(/\\/g, '/');
  const filename = path.basename(clean);
  return filename.replace(/\.dll$/i, '').toLowerCase();
}

/** Limpia las notas para el campo común (sin saltos de línea ni caracteres de control, máx 250 car.). */
export function cleanNotesForCommon(raw: string): string {
  return raw
    .replace(/\r?\n+/g, ' · ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 250);
}

@Injectable()
export class WizardService implements OnModuleInit {
  private readonly logger = new Logger(WizardService.name);

  private wizardsDir: string = resolveWizardsDir();
  private initialized = false;

  private records: WizardRecord[] = [];
  private byId = new Map<string, WizardRecord>();
  private byNormalizedName = new Map<string, WizardRecord>();
  private byDllBase = new Map<string, WizardRecord>();

  constructor(
    private readonly pluginMetaService: PluginMetaService,
    private readonly pluginLogService?: PluginLogService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.initIndex();
  }

  /**
   * Devuelve todos los registros de wizards cargados en memoria.
   */
  getAll(): WizardRecord[] {
    return [...this.records];
  }

  /**
   * Inicializa o recarga el índice en memoria de todos los wizards disponibles.
   * Si no se especifica customDir ni forceScanDisk y existe `wizards-catalog.json`,
   * carga directamente desde el JSON empaquetado de forma instantánea.
   */
  async initIndex(
    arg?: string | { customDir?: string; forceScanDisk?: boolean },
  ): Promise<number> {
    const customDir = typeof arg === 'string' ? arg : arg?.customDir;
    const forceScan = typeof arg === 'object' && arg?.forceScanDisk === true;

    if (customDir) {
      this.wizardsDir = customDir;
    }

    this.records = [];
    this.byId.clear();
    this.byNormalizedName.clear();
    this.byDllBase.clear();

    const catalogPath = resolveCatalogJsonPath();

    // Si no se fuerza escaneo de directorio y tenemos catálogo JSON precompilado
    if (!customDir && !forceScan && catalogPath) {
      try {
        const raw = await fs.readFile(catalogPath, 'utf8');
        const parsed = JSON.parse(raw) as WizardRecord[];
        for (const record of parsed) {
          this.indexRecord(record);
        }
        this.logger.log(`Cargados ${this.records.length} wizards desde catálogo JSON (${catalogPath})`);
        this.initialized = true;
        return this.records.length;
      } catch (error) {
        this.logger.warn(`Error al leer catálogo JSON (${catalogPath}), recurriendo a disco: ${error}`);
      }
    }

    if (!existsSync(this.wizardsDir)) {
      this.logger.warn(`El directorio de wizards no existe: ${this.wizardsDir}`);
      this.initialized = true;
      return 0;
    }

    try {
      await this.scanDirectory(this.wizardsDir);
      this.logger.log(`Indexados ${this.records.length} wizards desde ${this.wizardsDir}`);
    } catch (error) {
      this.logger.error(`Error al indexar wizards desde ${this.wizardsDir}: ${error}`);
    }

    this.initialized = true;
    return this.records.length;
  }

  /**
   * Vuelca la base de datos indexada actual a un archivo JSON empaquetado.
   */
  async dumpCatalog(outPath?: string): Promise<string> {
    const target =
      outPath ||
      resolveCatalogJsonPath() ||
      path.resolve(process.cwd(), 'src', 'wizard', 'wizards-catalog.json');
    await fs.writeFile(target, JSON.stringify(this.records, null, 2), 'utf8');
    this.logger.log(`Catálogo de ${this.records.length} wizards exportado a ${target}`);
    return target;
  }

  private async scanDirectory(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Puede ser una carpeta de plugin o un subdirectorio como wizard_database_20101112
        const subFiles = await fs.readdir(fullPath, { withFileTypes: true });

        // Comprobar si hay un archivo wizard directamente aquí
        const wizardFile = subFiles.find(
          (f) => f.isFile() && (f.name.endsWith('.vfxwizard') || f.name.toLowerCase() === 'vfxinfo.txt'),
        );

        if (wizardFile) {
          const readmeFile = subFiles.find(
            (f) => f.isFile() && f.name.toLowerCase().startsWith('readme'),
          );
          let readmeText: string | null = null;
          if (readmeFile) {
            try {
              readmeText = await fs.readFile(path.join(fullPath, readmeFile.name), 'utf8');
            } catch {
              // Si no se puede leer el readme, ignorar
            }
          }

          try {
            const content = await fs.readFile(path.join(fullPath, wizardFile.name), 'utf8');
            const relativeSource = path.relative(this.wizardsDir, path.join(fullPath, wizardFile.name));
            const record = parseWizardText(content, relativeSource, readmeText);

            if (record.id || record.name) {
              this.indexRecord(record);
            }
          } catch (err) {
            this.logger.warn(`No se pudo leer el wizard ${path.join(fullPath, wizardFile.name)}: ${err}`);
          }
        } else {
          // Si no tiene wizard directo, explorar recursivamente (ej. wizard_database_20101112 o carpetas anidadas)
          await this.scanDirectory(fullPath);
        }
      }
    }
  }

  private indexRecord(record: WizardRecord): void {
    this.records.push(record);

    if (record.id) {
      this.byId.set(record.id.trim(), record);
    }

    if (record.name) {
      const norm = normalizeName(record.name);
      if (norm && !this.byNormalizedName.has(norm)) {
        this.byNormalizedName.set(norm, record);
      }
    }

    if (record.dllName) {
      const dllBase = extractDllBase(record.dllName);
      if (dllBase && !this.byDllBase.has(dllBase)) {
        this.byDllBase.set(dllBase, record);
      }
    }
  }

  /**
   * Lista los wizards con paginación y filtros opcionales.
   */
  list(options: { query?: string; genre?: string; offset?: number; limit?: number } = {}): WizardListResult {
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const q = (options.query ?? '').toLowerCase().trim();
    const genre = (options.genre ?? '').toLowerCase().trim();

    let filtered = this.records;

    if (genre !== '') {
      filtered = filtered.filter((r) => r.genre.toLowerCase() === genre);
    }

    if (q !== '') {
      filtered = filtered.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.vendor.toLowerCase().includes(q) ||
          r.id.includes(q) ||
          r.dllName.toLowerCase().includes(q),
      );
    }

    const items = filtered.slice(offset, offset + limit).map(toWizardSummary);

    return {
      total: filtered.length,
      offset,
      limit,
      items,
    };
  }

  /**
   * Obtiene los detalles completos de un wizard por su ID VST.
   */
  getById(id: string): WizardRecord | null {
    return this.byId.get(id.trim()) ?? null;
  }

  /**
   * Busca el mejor wizard coincidente para un plugin según su ID, nombre o nombre de DLL.
   */
  match(query: WizardMatchQuery): WizardRecord | null {
    // 1. Coincidencia por ID exacta
    if (query.id && query.id.trim() !== '') {
      const matchId = this.byId.get(query.id.trim());
      if (matchId) return matchId;
    }

    // 2. Coincidencia por nombre de DLL base
    if (query.dllName && query.dllName.trim() !== '') {
      const dllBase = extractDllBase(query.dllName);
      const matchDll = this.byDllBase.get(dllBase);
      if (matchDll) return matchDll;
    }

    // 3. Coincidencia por nombre normalizado
    if (query.name && query.name.trim() !== '') {
      const norm = normalizeName(query.name);
      const matchName = this.byNormalizedName.get(norm);
      if (matchName) return matchName;

      // Coincidencia parcial (subcadena)
      for (const [key, record] of this.byNormalizedName.entries()) {
        if (norm.length >= 4 && (key.includes(norm) || norm.includes(key))) {
          return record;
        }
      }
    }

    return null;
  }

  /**
   * Aplica los metadatos de un wizard al catálogo `fxbLoader.meta.json` de un plugin.
   */
  async applyToMeta(input: WizardApplyMetaInput): Promise<PluginMetaSnapshot> {
    const currentSnapshot = await this.pluginMetaService.read(input.pluginDir);

    let wizard: WizardRecord | null = null;
    if (input.wizardId) {
      wizard = this.getById(input.wizardId);
    } else {
      wizard = this.match({
        id: currentSnapshot.common.id || undefined,
        name: currentSnapshot.common.name || path.basename(input.pluginDir),
      });
    }

    if (!wizard) {
      throw new Error(
        `No se encontró ningún wizard coincidente para ${path.basename(input.pluginDir)}`,
      );
    }

    const updatedCommon = { ...currentSnapshot.common };

    // Rellenar campos comunes si faltan o si se desean enriquecer
    if (wizard.name && !updatedCommon.name) updatedCommon.name = wizard.name;
    if (wizard.vendor) updatedCommon.vendor = wizard.vendor;
    if (wizard.vendorUrl) updatedCommon.vendor_url = wizard.vendorUrl;
    if (wizard.genre) updatedCommon.genre = wizard.genre;
    if (wizard.nameAbbreviation) updatedCommon.name_abbreviation = wizard.nameAbbreviation;
    if (wizard.id && !updatedCommon.id) updatedCommon.id = wizard.id;
    if (wizard.created && !updatedCommon.created) updatedCommon.created = wizard.created;

    // Gestión de notas
    const cleanNotes = cleanNotesForCommon(wizard.notes);
    if (cleanNotes) {
      if (input.overwriteNotes || !updatedCommon.notes.trim()) {
        updatedCommon.notes = cleanNotes;
      } else if (!updatedCommon.notes.includes(cleanNotes)) {
        updatedCommon.notes = `${updatedCommon.notes} · ${cleanNotes}`.slice(0, 250);
      }
    }

    const updatedExtended = {
      ...currentSnapshot.extended,
      ...(wizard.notes.trim() ? { wizard_notes: wizard.notes } : {}),
    };

    return this.pluginMetaService.write({
      pluginDir: input.pluginDir,
      expectedMtimeMs: currentSnapshot.mtimeMs,
      common: updatedCommon,
      extended: updatedExtended,
    });
  }

  /**
   * Genera el archivo `vfxinfo.txt` en la carpeta del plugin a partir de un wizard.
   */
  async createVfxinfo(
    input: WizardCreateVfxinfoInput,
  ): Promise<{ path: string; created: boolean; backedUp: boolean }> {
    const vfxinfoPath = path.join(input.pluginDir, VFXINFO_FILENAME);
    const backupPath = path.join(input.pluginDir, VFXINFO_BACKUP_FILENAME);

    const exists = existsSync(vfxinfoPath);
    if (exists && !input.force) {
      return { path: vfxinfoPath, created: false, backedUp: false };
    }

    let backedUp = false;
    if (exists && input.force) {
      await copyFileAtomic(vfxinfoPath, backupPath);
      backedUp = true;
    }

    let wizard: WizardRecord | null = null;
    if (input.wizardId) {
      wizard = this.getById(input.wizardId);
    } else {
      const meta = await this.pluginMetaService.read(input.pluginDir);
      wizard = this.match({
        id: meta.common.id || undefined,
        name: meta.common.name || path.basename(input.pluginDir),
      });
    }

    if (!wizard) {
      throw new Error(
        `No se encontró ningún wizard coincidente para generar vfxinfo.txt en ${path.basename(input.pluginDir)}`,
      );
    }

    const content = serializeWizardToVfxinfo(wizard);
    await writeFileAtomic(vfxinfoPath, Buffer.from(content, 'latin1'));

    return { path: vfxinfoPath, created: true, backedUp };
  }

  /**
   * Instala un nuevo instrumento/plugin en la librería activa a partir de un Wizard certificado.
   * Copia el binario DLL, genera vfxinfo.txt oficial, crea fxbLoader.meta.json,
   * vuelca claves de registro o dependencias y registra la operación en fxbLoader.log.
   */
  async installPlugin(input: WizardInstallPluginInput): Promise<WizardInstallPluginResult> {
    const libraryRoot = path.resolve(input.libraryRoot);
    if (!existsSync(libraryRoot)) {
      throw new Error(`La librería destino no existe: ${libraryRoot}`);
    }

    const plugsDir = path.join(libraryRoot, 'plugs');
    if (!existsSync(plugsDir)) {
      await fs.mkdir(plugsDir, { recursive: true });
    }

    const wizard = this.getById(input.wizardId);
    if (!wizard) {
      throw new Error(`Wizard no encontrado con ID: ${input.wizardId}`);
    }

    const dllSource = path.resolve(input.dllSourcePath);
    if (!existsSync(dllSource)) {
      throw new Error(`El archivo DLL de origen no existe: ${dllSource}`);
    }

    // Inspección de arquitectura PE del DLL de origen
    const pe = await inspectPeFile(dllSource);
    const warnings: string[] = [];
    if (!pe.valid) {
      warnings.push(`El binario seleccionado no tiene una cabecera PE válida: ${pe.issues.join('; ')}`);
    } else if (pe.bitness !== 32) {
      warnings.push(
        `El DLL es de ${pe.bitness || '64'} bits (${pe.machineName || 'AMD64'}). El hardware VFX y fxbLoader requieren binarios de 32 bits (i386).`,
      );
    }

    // Determinar nombre de la carpeta de plugin
    const rawFolderName = input.pluginFolderName?.trim() || wizard.name.trim();
    const folderName = rawFolderName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
    if (!folderName) {
      throw new Error(`Nombre de carpeta de plugin no válido: "${rawFolderName}"`);
    }

    const targetPluginDir = path.join(plugsDir, folderName);
    const folderExists = existsSync(targetPluginDir);
    if (folderExists && !input.overwrite) {
      throw new Error(`El plugin "${folderName}" ya existe en la librería destino. Usa overwrite para sobrescribir.`);
    }

    if (!folderExists) {
      await fs.mkdir(targetPluginDir, { recursive: true });
    }

    // Ruta relativa esperada por el wizard para el DLL (ej. "P8.dll" o "SuperWave P8/P8.dll")
    const relativeDll = wizard.dllName.trim() || path.basename(dllSource);
    const targetDllPath = path.join(targetPluginDir, relativeDll);
    const targetDllDir = path.dirname(targetDllPath);
    if (!existsSync(targetDllDir)) {
      await fs.mkdir(targetDllDir, { recursive: true });
    }

    // Copiar DLL de origen de forma atómica
    await copyFileAtomic(dllSource, targetDllPath);

    // Generar vfxinfo.txt oficial
    const vfxinfoContent = serializeWizardToVfxinfo(wizard);
    const vfxinfoPath = path.join(targetPluginDir, VFXINFO_FILENAME);
    await writeFileAtomic(vfxinfoPath, Buffer.from(vfxinfoContent, 'latin1'));

    // Generar fxbLoader.meta.json
    try {
      const existingMeta = await this.pluginMetaService.read(targetPluginDir);
      const expectedMtimeMs = existingMeta.exists ? existingMeta.mtimeMs : null;

      await this.pluginMetaService.write({
        pluginDir: targetPluginDir,
        expectedMtimeMs,
        common: {
          id: wizard.id,
          name: wizard.name,
          vendor: wizard.vendor,
          vendor_url: wizard.vendorUrl,
          genre: wizard.genre,
          name_abbreviation: wizard.nameAbbreviation,
          notes: cleanNotesForCommon(wizard.notes),
          created: wizard.created || new Date().toISOString().slice(0, 10),
        },
        extended: {
          ...(wizard.vendorNotes.trim() ? { vendor_notes: wizard.vendorNotes } : {}),
          ...(wizard.version.trim() ? { wizard_version: wizard.version } : {}),
        },
      });
    } catch (metaErr) {
      this.logger.warn(`No se pudo inicializar fxbLoader.meta.json para ${folderName}: ${(metaErr as Error).message}`);
    }

    // Volcar claves de registro si el wizard las define
    let registryFileCreated = false;
    let registryFilePath: string | null = null;
    if (wizard.registryKeys.trim().length > 0) {
      registryFilePath = path.join(targetPluginDir, 'registry_keys.reg');
      await writeFileAtomic(registryFilePath, Buffer.from(wizard.registryKeys.trim() + '\r\n', 'latin1'));
      registryFileCreated = true;
    }

    // Volcar archivos complementarios definidos en filesToCreate
    if (wizard.filesToCreate && Object.keys(wizard.filesToCreate).length > 0) {
      for (const [filename, content] of Object.entries(wizard.filesToCreate)) {
        const filePath = path.join(targetPluginDir, filename);
        const fileDir = path.dirname(filePath);
        if (!existsSync(fileDir)) {
          await fs.mkdir(fileDir, { recursive: true });
        }
        await writeFileAtomic(filePath, Buffer.from(content, 'latin1'));
      }
    }

    // Volcar readme si existe
    if (wizard.readme && wizard.readme.trim().length > 0) {
      const readmePath = path.join(targetPluginDir, 'wizard_readme.txt');
      await writeFileAtomic(readmePath, Buffer.from(wizard.readme.trim() + '\r\n', 'utf8'));
    }

    // Inicializar estructura de bancos / presets
    if (input.initializeBank !== false) {
      const presetsDir = path.join(targetPluginDir, 'presets');
      if (!existsSync(presetsDir)) {
        await fs.mkdir(presetsDir, { recursive: true });
      }
    }

    // Registrar en fxbLoader.log
    if (this.pluginLogService) {
      await this.pluginLogService.append(
        targetPluginDir,
        'install-from-wizard',
        `Instalado desde wizard: ${wizard.name} (ID: ${wizard.id})`,
        `DLL copiado desde ${dllSource} hacia ${relativeDll}`,
      );
    }

    return {
      pluginName: folderName,
      pluginDir: targetPluginDir,
      dllName: relativeDll,
      dllPath: targetDllPath,
      isCompatible32Bit: pe.valid && pe.bitness === 32,
      vfxinfoCreated: true,
      metaCreated: true,
      registryFileCreated,
      registryFilePath,
      requiredFiles: [...wizard.filesToCopy],
      requiredDirs: [...wizard.dirsToCopy],
      warnings,
      readme: wizard.readme || null,
    };
  }
}

