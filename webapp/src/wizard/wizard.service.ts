import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { copyFileAtomic, writeFileAtomic } from '../common/atomic-file';
import { inspectPeFile } from '../library/pe';
import { inspectPeExports } from '../library/pe-exports';
import { PluginLogService } from '../plugin-log/plugin-log.service';
import { PluginMetaService } from '../plugin-meta/plugin-meta.service';
import type { PluginMetaSnapshot } from '../plugin-meta/plugin-meta.types';
import { parseWizardText, serializeWizardToVfxinfo, toWizardSummary } from './wizard-parser';
import type {
  WizardApplyMetaInput,
  WizardCreateFromPluginInput,
  WizardCreateFromPluginResult,
  WizardCreateVfxinfoInput,
  WizardInstallPluginInput,
  WizardInstallPluginResult,
  WizardListResult,
  WizardMatchQuery,
  WizardRecord,
  WizardSortDir,
  WizardSortField,
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

/** Convierte una ruta de wizard en una subruta portable y rechaza escapes. */
export function normalizeWizardPath(value: string): string | null {
  const withoutDrive = value.trim().replace(/\\/g, '/').replace(/^[a-z]:/i, '').replace(/^\/+/, '');
  const normalized = path.posix.normalize(withoutDrive);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

/** Limpia las notas para el campo común (sin saltos de línea ni caracteres de control, máx 250 car.). */
export function cleanNotesForCommon(raw: string): string {
  return raw
    .replace(/\r?\n+/g, ' · ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 250);
}

const WIZARD_SORT_FIELDS: readonly WizardSortField[] = ['name', 'vendor', 'genre', 'dllName', 'id'];

/** Valida `sort`/`dir` de la query; campo desconocido o dirección rara vuelven al por defecto (`name` ascendente). */
export function parseWizardSort(sort?: string, dir?: string): { sort: WizardSortField; dir: WizardSortDir } {
  const field = (WIZARD_SORT_FIELDS as readonly string[]).includes(sort ?? '') ? (sort as WizardSortField) : 'name';
  const direction: WizardSortDir = dir === 'desc' ? 'desc' : 'asc';
  return { sort: field, dir: direction };
}

/** Ordena una lista de wizards por el campo pedido y su dirección, estable ante empates. */
function sortWizards(rows: WizardRecord[], sort: WizardSortField, dir: WizardSortDir): WizardRecord[] {
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = String(a.row[sort] ?? '');
      const right = String(b.row[sort] ?? '');
      // El vacío va al final en ambos sentidos, igual que en la tabla.
      const leftEmpty = left.trim() === '';
      const rightEmpty = right.trim() === '';
      if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? a.index - b.index : leftEmpty ? 1 : -1;
      return sign * (left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true }));
    })
    .map((item) => item.row);
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
   * Lista los wizards con paginación, filtros y orden opcionales. El orden es
   * case-insensitive y con números naturales; los valores vacíos van al final,
   * igual que en la tabla del navegador.
   */
  list(options: {
    query?: string;
    genre?: string;
    offset?: number;
    limit?: number;
    sort?: string;
    dir?: string;
  } = {}): WizardListResult {
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const q = (options.query ?? '').toLowerCase().trim();
    const genre = (options.genre ?? '').toLowerCase().trim();
    const { sort, dir } = parseWizardSort(options.sort, options.dir);

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

    const sorted = sortWizards(filtered, sort, dir);
    const items = sorted.slice(offset, offset + limit).map(toWizardSummary);

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
   * Coincidencia estricta: ID, nombre de DLL o nombre normalizado exactos, sin
   * el último recurso por subcadena de `match`. Es la que pueden usar los flujos
   * que escriben datos a partir del wizard: heredar el fabricante o las notas de
   * un plugin «parecido» es peor que no proponer nada.
   */
  matchExact(query: WizardMatchQuery): WizardRecord | null {
    if (query.id && query.id.trim() !== '') {
      const byId = this.byId.get(query.id.trim());
      if (byId) return byId;
    }

    if (query.dllName && query.dllName.trim() !== '') {
      const byDll = this.byDllBase.get(extractDllBase(query.dllName));
      if (byDll) return byDll;
    }

    if (query.name && query.name.trim() !== '') {
      const byName = this.byNormalizedName.get(normalizeName(query.name));
      if (byName) return byName;
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
  getPluginMetaService(): PluginMetaService {
    return this.pluginMetaService;
  }

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
   * Crea un `.vfxwizard` en el catálogo local a partir de un plugin que ya está
   * en la librería. La fuente de verdad es su `vfxinfo.txt`, enriquecido con
   * `fxbLoader.meta.json`; el DLL se busca **dentro de la carpeta del plugin**
   * (o en su subcarpeta), nunca en carpetas VST canónicas, y solo se usa para
   * avisar de arquitectura o de un binario que no exporta un entrypoint VST2.
   */
  async createFromPlugin(
    input: WizardCreateFromPluginInput,
  ): Promise<WizardCreateFromPluginResult> {
    const rawDir = typeof input?.pluginDir === 'string' ? input.pluginDir.trim() : '';
    if (rawDir === '') throw new Error('pluginDir es obligatorio');
    if (!path.isAbsolute(rawDir)) {
      throw new Error(`pluginDir debe ser una ruta absoluta: "${rawDir}"`);
    }

    const pluginDir = path.resolve(rawDir);
    const stats = await fs.stat(pluginDir).catch(() => null);
    if (stats === null || !stats.isDirectory()) {
      throw new Error(`No existe la carpeta del plugin: ${pluginDir}`);
    }

    const vfxinfoPath = path.join(pluginDir, VFXINFO_FILENAME);
    const rawVfxinfo = await fs.readFile(vfxinfoPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const folderName = path.basename(pluginDir);
    if (rawVfxinfo === null) {
      throw new Error(
        `El plugin "${folderName}" no tiene ${VFXINFO_FILENAME}; sin identidad VST no se puede generar un wizard`,
      );
    }

    const record = parseWizardText(rawVfxinfo.toString('latin1'));
    const warnings: string[] = [];

    // El meta manda en fabricante, género y notas: el vfxinfo no los guarda.
    const meta = await this.pluginMetaService.read(pluginDir).catch(() => null);
    if (meta !== null) {
      if (!record.name.trim() && meta.common.name.trim()) record.name = meta.common.name;
      if (!record.vendor.trim() && meta.common.vendor.trim()) record.vendor = meta.common.vendor;
      if (!record.vendorUrl.trim() && meta.common.vendor_url.trim()) record.vendorUrl = meta.common.vendor_url;
      if (!record.genre.trim() && meta.common.genre.trim()) record.genre = meta.common.genre;
      if (!record.nameAbbreviation.trim() && meta.common.name_abbreviation.trim()) {
        record.nameAbbreviation = meta.common.name_abbreviation;
      }
      if (!record.created.trim() && meta.common.created.trim()) record.created = meta.common.created;
      if (!record.notes.trim() && meta.common.notes.trim()) record.notes = meta.common.notes;
    }

    const dllPath = await this.resolvePluginDll(pluginDir, record.dllName);
    if (dllPath === null) {
      warnings.push(
        `No se encontró ningún DLL dentro de "${folderName}"; el wizard se crea solo con los datos de ${VFXINFO_FILENAME}`,
      );
    } else {
      // Ruta relativa a la carpeta del plugin, que es lo que espera el host.
      record.dllName = path.relative(pluginDir, dllPath).split(path.sep).join('/');
      try {
        const pe = await inspectPeFile(dllPath);
        if (!pe.valid) {
          warnings.push(`El DLL no tiene una cabecera PE válida: ${pe.issues.join('; ')}`);
        } else if (pe.bitness !== 32) {
          warnings.push(
            `El DLL es de ${pe.bitness ?? '?'} bits (${pe.machineName ?? 'desconocido'}); el hardware VFX y fxbLoader requieren 32 bits (i386)`,
          );
        }
      } catch (error) {
        warnings.push(`No se pudo leer la cabecera PE del DLL: ${(error as Error).message}`);
      }
      try {
        const exports = await inspectPeExports(dllPath);
        if (exports.vstEntrypoint === null) {
          warnings.push(
            'El DLL no exporta "VSTPluginMain" ni "main"; puede no responder a la API VST2',
          );
        }
      } catch {
        // Sin exportaciones legibles no hay más que avisar: el wizard sigue siendo válido.
      }
    }

    if (!record.name.trim()) record.name = folderName;
    if (!record.id.trim()) warnings.push('El plugin no declara un ID VST; complétalo antes de usar el wizard');
    if (!record.version.trim()) record.version = '1';
    // Derivados de lo que ya declara el plugin: no inventan identidad, solo el
    // género que se deduce de `is_synth` y la abreviatura de pantalla LCD.
    if (!record.genre.trim()) record.genre = record.isSynth ? 'Synth' : 'Effect';
    if (!record.nameAbbreviation.trim()) {
      // "15 - SynthEdit" -> "15", "SuperWave P8" -> "SUPE": la primera palabra útil.
      const firstWord = record.name.split(/[^0-9A-Za-z]+/).filter(Boolean)[0] ?? record.name;
      record.nameAbbreviation = firstWord.slice(0, 4).toUpperCase();
    }

    const wizardsDir = path.resolve(this.wizardsDir);
    const customDir = path.join(wizardsDir, 'custom');
    await fs.mkdir(customDir, { recursive: true });

    const baseName = (record.name || folderName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || folderName;
    const wizardPath = path.join(customDir, `${baseName}.vfxwizard`);
    if (existsSync(wizardPath) && input.overwrite !== true) {
      throw new Error(
        `Ya existe el wizard "${baseName}.vfxwizard" en el catálogo local; usa overwrite para rehacerlo`,
      );
    }

    record.sourcePath = path.relative(wizardsDir, wizardPath);
    const content = serializeWizardToVfxinfo(record);
    await writeFileAtomic(wizardPath, Buffer.from(content, 'utf8'));

    // Reindexar desde disco para que el nuevo wizard puntúe de inmediato en `match`.
    await this.initIndex({ customDir: wizardsDir });

    await this.pluginLogService?.append(
      pluginDir,
      'create-wizard',
      `Wizard creado desde la librería: "${record.name}" (ID: ${record.id || 'sin id'}, DLL: ${record.dllName || 'sin DLL'})`,
    );

    return { created: true, wizardPath, record, warnings };
  }

  /**
   * Busca el DLL del plugin dentro de su carpeta: primero el `dll_name`
   * declarado, después un DLL directo y por último uno en una subcarpeta
   * (estructura `plugs/<Plugin>/<Plugin>/<dll>`). Ignora el cargador y los
   * respaldos.
   */
  private async resolvePluginDll(pluginDir: string, dllName: string): Promise<string | null> {
    const declared = dllName.trim();
    if (declared !== '') {
      const candidate = path.resolve(pluginDir, declared.replace(/[\\/]+/g, path.sep));
      const inside = candidate === pluginDir || candidate.startsWith(pluginDir + path.sep);
      if (inside && existsSync(candidate)) return candidate;
    }

    const ignored = (name: string): boolean => {
      const lower = name.toLowerCase();
      return lower === 'fxbloader.dll' || lower.endsWith('.tx_');
    };

    const entries = await fs.readdir(pluginDir, { withFileTypes: true }).catch(() => []);
    const direct = entries.find(
      (entry) => entry.isFile() && /\.dll$/i.test(entry.name) && !ignored(entry.name),
    );
    if (direct) return path.join(pluginDir, direct.name);

    for (const dir of entries) {
      if (!dir.isDirectory()) continue;
      const subEntries = await fs
        .readdir(path.join(pluginDir, dir.name), { withFileTypes: true })
        .catch(() => []);
      const nested = subEntries.find(
        (entry) => entry.isFile() && /\.dll$/i.test(entry.name) && !ignored(entry.name),
      );
      if (nested) return path.join(pluginDir, dir.name, nested.name);
    }

    return null;
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
    let registryImported = false;
    if (wizard.registryKeys.trim().length > 0) {
      registryFilePath = path.join(targetPluginDir, 'registry_keys.reg');
      await writeFileAtomic(registryFilePath, Buffer.from(wizard.registryKeys.trim() + '\r\n', 'latin1'));
      registryFileCreated = true;
      if (input.autoImportRegistry && process.platform === 'win32') {
        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn('reg', ['import', registryFilePath!], { shell: true, windowsHide: true });
            child.on('error', reject);
            child.on('close', (code) => {
              if (code === 0) resolve();
              else reject(new Error(`reg import ha devuelto código ${code}`));
            });
          });
          registryImported = true;
        } catch (err) {
          warnings.push(
            `No se pudo importar el .reg automáticamente: ${(err as Error).message}. Impórtalo manualmente con clic derecho > Combinar.`,
          );
        }
      }
    }

    // Volcar archivos complementarios definidos en filesToCreate, sin pisar contenido existente.
    if (wizard.filesToCreate && Object.keys(wizard.filesToCreate).length > 0) {
      for (const [filename, content] of Object.entries(wizard.filesToCreate)) {
        const relativeFile = normalizeWizardPath(filename);
        if (!relativeFile) {
          warnings.push(`Ruta insegura definida por el wizard: ${filename}`);
          continue;
        }
        const filePath = path.resolve(targetPluginDir, relativeFile);
        const relativeDestination = path.relative(targetPluginDir, filePath);
        if (relativeDestination.startsWith('..') || path.isAbsolute(relativeDestination)) {
          warnings.push(`Ruta insegura definida por el wizard: ${filename}`);
          continue;
        }
        const fileDir = path.dirname(filePath);
        if (!existsSync(fileDir)) {
          await fs.mkdir(fileDir, { recursive: true });
        }
        try {
          await fs.writeFile(filePath, Buffer.from(content, 'latin1'), { flag: 'wx' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
    }

    // Copiar archivos/directorios extra si se indica sourceFilesRoot
    const copiedFiles: string[] = [];
    const copiedDirs: string[] = [];
    const sourceFilesRoot = input.sourceFilesRoot?.trim();
    if (sourceFilesRoot) {
      const sourceRootResolved = path.resolve(sourceFilesRoot);
      if (existsSync(sourceRootResolved)) {
        if (wizard.filesToCopy && wizard.filesToCopy.length > 0) {
          for (const rel of wizard.filesToCopy) {
            const safeRel = normalizeWizardPath(rel);
            if (!safeRel) {
              warnings.push(`Ruta insegura definida por el wizard: ${rel}`);
              continue;
            }
            const src = path.resolve(sourceRootResolved, safeRel);
            const dst = path.resolve(targetPluginDir, safeRel);
            const sourceRelative = path.relative(sourceRootResolved, src);
            const destinationRelative = path.relative(targetPluginDir, dst);
            if (sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative) || destinationRelative.startsWith('..') || path.isAbsolute(destinationRelative)) {
              warnings.push(`Ruta insegura definida por el wizard: ${rel}`);
              continue;
            }
            if (existsSync(dst)) continue;
            if (!existsSync(src)) {
              warnings.push(`No se encontró el archivo requerido por el wizard: ${rel}`);
              continue;
            }
            try {
              const st = await fs.stat(src);
              const dstDir = path.dirname(dst);
              if (!existsSync(dstDir)) await fs.mkdir(dstDir, { recursive: true });
              if (st.isDirectory()) {
                await fs.cp(src, dst, { recursive: true, force: false, errorOnExist: true });
                copiedDirs.push(rel);
              } else {
                await copyFileAtomic(src, dst);
                copiedFiles.push(rel);
              }
            } catch (err) {
              warnings.push(`No se pudo copiar ${rel}: ${(err as Error).message}`);
            }
          }
        }
        if (wizard.dirsToCopy && wizard.dirsToCopy.length > 0) {
          for (const rel of wizard.dirsToCopy) {
            const safeRel = normalizeWizardPath(rel);
            if (!safeRel) {
              warnings.push(`Ruta insegura definida por el wizard: ${rel}`);
              continue;
            }
            const src = path.resolve(sourceRootResolved, safeRel);
            const dst = path.resolve(targetPluginDir, safeRel);
            const sourceRelative = path.relative(sourceRootResolved, src);
            const destinationRelative = path.relative(targetPluginDir, dst);
            if (sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative) || destinationRelative.startsWith('..') || path.isAbsolute(destinationRelative)) {
              warnings.push(`Ruta insegura definida por el wizard: ${rel}`);
              continue;
            }
            if (existsSync(dst)) continue;
            if (!existsSync(src)) {
              warnings.push(`No se encontró el directorio requerido por el wizard: ${rel}`);
              continue;
            }
            try {
              if (!existsSync(dst)) await fs.mkdir(dst, { recursive: true });
              await fs.cp(src, dst, { recursive: true, force: true });
              copiedDirs.push(rel);
            } catch (err) {
              warnings.push(`No se pudo copiar el directorio ${rel}: ${(err as Error).message}`);
            }
          }
        }
      } else {
        warnings.push(`sourceFilesRoot no existe: ${sourceFilesRoot}`);
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
      registryImported,
      requiredFiles: [...wizard.filesToCopy],
      requiredDirs: [...wizard.dirsToCopy],
      copiedFiles,
      copiedDirs,
      warnings,
      readme: wizard.readme || null,
    };
  }
}

