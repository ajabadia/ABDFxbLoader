import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import { copyFileAtomic, writeFileAtomic } from '../common/atomic-file';
import { FXB_CONFIG_FILENAME } from '../fxb-config/fxb-config.constants';
import { FxbConfigService } from '../fxb-config/fxb-config.service';
import type { FxbConfigSnapshot } from '../fxb-config/fxb-config.types';
import {
  checkBankCompatibility,
  FXB_CHUNK_HEADER_SIZE,
  FXB_HEADER_SIZE,
  FXB_MAX_BYTES,
  parseFxbBank,
  parseUniqueIdInput,
  uniqueIdToText,
} from './fxb-bank';
import type { BankReference } from './fxb-bank';
import {
  analyzeVfxinfo,
  LOADER_DLL_FILENAME,
  patchVfxinfo,
  readVfxinfo,
  VFXINFO_BACKUP_FILENAME,
  VFXINFO_DISABLED_FILENAME,
  VFXINFO_FILENAME,
} from './vfxinfo';
import { defaultLoaderDllPath } from './loader-dll';
import { describePe, inspectPeFile, isX86Pe32 } from './pe';
import {
  LibraryOperationError,
  LibraryPathError,
  PluginNotFoundError,
  PluginStateError,
} from './library.types';
import type {
  BankImportInput,
  BankImportResponse,
  BankImportResult,
  BankInspectInput,
  BankInspectResult,
  BankListInput,
  BankListResult,
  InstallInput,
  InstallResult,
  LibraryAction,
  LibraryScanResult,
  LoaderDllInfo,
  PluginBankEntry,
  PluginBankSummary,
  PluginEntry,
  UninstallInput,
  UninstallResult,
} from './library.types';

/** Carpeta que contiene un subdirectorio por plugin. */
const PLUGS_DIRNAME = 'plugs';
/** Subcarpeta de bancos que crea el instalador original. */
const PRESETS_DIRNAME = 'presets';
/** Tope de archivos por petición de importación. */
export const MAX_BANKS_PER_REQUEST = 50;
/** Cuántos bancos existentes se inspeccionan para inferir compatibilidad. */
const MAX_REFERENCE_SCAN = 100;

/** `programDirName` debe ser un nombre de carpeta, no una ruta. */
function isSimpleDirectoryName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.trim() !== '' &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/]/.test(name) &&
    !/[\u0000-\u001f\u007f]/.test(name) &&
    !/[ .]$/.test(name)
  );
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(target: string): Promise<boolean> {
  return (await statOrNull(target)) !== null;
}

@Injectable()
export class LibraryService {
  constructor(private readonly configService: FxbConfigService) {}

  /**
   * Enumera `plugs\*`, valida el `fxbLoader.dll` que se instalaría y marca
   * cada plugin como compatible, incompatible o no verificable.
   */
  async scan(libraryRoot: string, dllSourcePath?: string): Promise<LibraryScanResult> {
    const { root, plugsPath } = await this.resolvePlugs(libraryRoot);
    const loader = await this.inspectLoader(dllSourcePath ?? defaultLoaderDllPath());
    const entries = await fs.readdir(plugsPath, { withFileTypes: true });

    const plugins: PluginEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      plugins.push(await this.describe(plugsPath, entry.name, loader));
    }

    plugins.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    return { libraryRoot: root, plugsPath, loader, plugins };
  }

  /**
   * Instala el cargador en un plugin: respalda `vfxinfo.txt` como
   * `vfxinfo.tx_`, copia el DLL, reescribe `dll_name` y crea
   * `fxbLoader.config` + `presets\`.
   */
  async install(input: InstallInput): Promise<InstallResult> {
    const { plugsPath } = await this.resolvePlugs(input.libraryRoot);
    const pluginDir = await this.resolvePluginDir(plugsPath, input.plugin);
    const dllSource = await this.resolveDllSource(input.dllSourcePath);

    const vfxinfoPath = path.join(pluginDir, VFXINFO_FILENAME);
    const backupPath = path.join(pluginDir, VFXINFO_BACKUP_FILENAME);
    const configPath = path.join(pluginDir, FXB_CONFIG_FILENAME);
    const dllTarget = path.join(pluginDir, LOADER_DLL_FILENAME);
    const presetsPath = path.join(pluginDir, PRESETS_DIRNAME);

    const raw = await readVfxinfo(vfxinfoPath);
    if (raw === null) {
      throw new LibraryOperationError(`no existe ${VFXINFO_FILENAME} en ${pluginDir}`);
    }
    const rawAnalysis = analyzeVfxinfo(raw);
    if (rawAnalysis === null) {
      throw new LibraryOperationError(
        `${VFXINFO_FILENAME} no contiene ninguna línea "dll_name"; el instalador original ` +
          'dejaría una configuración vacía, así que se rechaza la operación',
      );
    }

    const installed = await exists(configPath);
    if (installed && input.force !== true) {
      throw new PluginStateError(
        `${input.plugin} ya tiene fxbLoader instalado (usa force para reinstalar)`,
      );
    }

    const existing = installed ? await this.configService.read(pluginDir) : null;

    // Para reinstalar, el nombre original está en el respaldo o en la config
    // vigente: el vfxinfo ya modificado daría "fxbLoader.dll" como pluginName.
    const backupRaw = await readVfxinfo(backupPath);
    const backupAnalysis = backupRaw === null ? null : analyzeVfxinfo(backupRaw);
    const pluginName =
      backupAnalysis?.pluginName ||
      existing?.config.pluginName ||
      rawAnalysis.pluginName ||
      '';

    // El cargador debe ser PE32 i386 y el plugin original (no el cargador ya
    // instalado) debe ser de la misma arquitectura. Sin el respaldo no se
    // puede verificar el binario original en una reinstalación.
    const loaderCheck = await this.inspectLoader(dllSource);
    if (!loaderCheck.valid) {
      throw new LibraryOperationError(
        `fxbLoader.dll no es un PE32 i386 válido: ${loaderCheck.issues.join('; ')}`,
      );
    }
    const originalDllName = installed
      ? backupAnalysis?.dllNameValue ?? (rawAnalysis.hasLoader ? null : rawAnalysis.dllNameValue)
      : rawAnalysis.dllNameValue;
    const pluginCheck =
      originalDllName === null
        ? {
            compatible: null,
            issues: [
              `no se puede verificar el binario original: falta ${VFXINFO_BACKUP_FILENAME}`,
            ],
          }
        : await this.inspectPluginBinary(pluginDir, originalDllName);
    if (pluginCheck.compatible === false) {
      throw new LibraryOperationError(
        `${input.plugin} no es compatible con fxbLoader.dll de 32 bits: ` +
          pluginCheck.issues.join('; '),
      );
    }

    const patched = patchVfxinfo(raw, input.plugin);
    const backupExists = backupRaw !== null;

    const actions: LibraryAction[] = [
      backupExists
        ? { kind: 'backup', path: backupPath, detail: `${VFXINFO_BACKUP_FILENAME} ya existe; se conserva` }
        : { kind: 'backup', path: backupPath, detail: 'copia del vfxinfo.txt original' },
      { kind: 'copy', path: dllTarget, detail: dllSource },
      {
        kind: 'patch',
        path: vfxinfoPath,
        detail: `dll_name: ${input.plugin}/${LOADER_DLL_FILENAME}`,
      },
      { kind: 'write-config', path: configPath, detail: `pluginName = ${pluginName}` },
      { kind: 'create-dir', path: presetsPath },
    ];

    if (input.dryRun === true) {
      return {
        plugin: await this.describe(plugsPath, input.plugin, loaderCheck),
        actions,
        dryRun: true,
      };
    }

    if (!backupExists) await copyFileAtomic(vfxinfoPath, backupPath);
    await copyFileAtomic(dllSource, dllTarget);
    if (patched.text !== raw) {
      await writeFileAtomic(vfxinfoPath, Buffer.from(patched.text, 'latin1'));
    }

    const snapshot = await this.configService.read(pluginDir);
    await this.configService.write({
      pluginDir,
      expectedMtimeMs: snapshot.mtimeMs,
      config: { pluginName },
    });

    await fs.mkdir(presetsPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });

    return {
      plugin: await this.describe(plugsPath, input.plugin, loaderCheck),
      actions,
      dryRun: false,
    };
  }

  /**
   * Restaura el `vfxinfo.txt` original desde `vfxinfo.tx_`, conserva el
   * modificado como `vfxinfo.loader` y borra `fxbLoader.config`. El DLL y los
   * bancos importados se quedan, igual que en el binario original.
   */
  async uninstall(input: UninstallInput): Promise<UninstallResult> {
    const { plugsPath } = await this.resolvePlugs(input.libraryRoot);
    const pluginDir = await this.resolvePluginDir(plugsPath, input.plugin);

    const configPath = path.join(pluginDir, FXB_CONFIG_FILENAME);
    const vfxinfoPath = path.join(pluginDir, VFXINFO_FILENAME);
    const backupPath = path.join(pluginDir, VFXINFO_BACKUP_FILENAME);
    const disabledPath = path.join(pluginDir, VFXINFO_DISABLED_FILENAME);

    if (!(await exists(configPath))) {
      throw new PluginStateError(`${input.plugin} no tiene fxbLoader instalado`);
    }
    if (!(await exists(backupPath))) {
      throw new PluginStateError(
        `falta ${VFXINFO_BACKUP_FILENAME} en ${pluginDir}; sin el respaldo no se puede ` +
          'restaurar el vfxinfo.txt original',
      );
    }

    const actions: LibraryAction[] = [
      { kind: 'restore', path: disabledPath, detail: 'se conserva el vfxinfo.txt modificado' },
      { kind: 'restore', path: vfxinfoPath, detail: `desde ${VFXINFO_BACKUP_FILENAME}` },
      { kind: 'delete', path: configPath },
    ];

    if (input.dryRun === true) {
      return {
        plugin: await this.describe(plugsPath, input.plugin),
        actions,
        dryRun: true,
      };
    }

    if (await exists(vfxinfoPath)) {
      await fs.rename(vfxinfoPath, disabledPath);
    }
    await fs.rename(backupPath, vfxinfoPath);
    await fs.rm(configPath, { force: true });

    return {
      plugin: await this.describe(plugsPath, input.plugin),
      actions,
      dryRun: false,
    };
  }

  /**
   * Importa bancos `.fxb` en `<plugin>\<programDirName>\` validando el formato
   * VST2 y la compatibilidad con el plugin.
   *
   * El diálogo original compara contra el `uniqueID` y la versión del plugin
   * vivo; aquí no se puede hospedar el VST, así que la identidad se toma de
   * `expectedUniqueId`/`expectedFxVersion`, de un banco ya presente en el
   * destino (solo al añadir un archivo nuevo) o del primer banco del lote.
   * Sin ninguna referencia el banco se importa como `unverified`.
   */
  async importBanks(input: BankImportInput): Promise<BankImportResponse> {
    const { plugsPath } = await this.resolvePlugs(input.libraryRoot);
    const pluginDir = await this.resolvePluginDir(plugsPath, input.plugin);

    if (!Array.isArray(input.sourcePaths) || input.sourcePaths.length === 0) {
      throw new LibraryPathError('sourcePaths debe contener al menos un archivo .fxb');
    }
    if (input.sourcePaths.length > MAX_BANKS_PER_REQUEST) {
      throw new LibraryPathError(`como máximo ${MAX_BANKS_PER_REQUEST} bancos por petición`);
    }
    const sources = input.sourcePaths.map((source) => this.resolveBankSource(source));

    const presetsDir = await this.resolvePresetsDir(pluginDir, 'importar');

    let reference = this.explicitBankReference(input);
    let existingReference: BankReference | null | undefined;
    const overwrite = input.overwrite !== false;
    const results: BankImportResult[] = [];

    for (const source of sources) {
      const fileName = path.basename(source);
      const target = path.join(presetsDir, fileName);
      const push = (result: Omit<BankImportResult, 'source' | 'fileName' | 'target'>): void => {
        results.push({ source, fileName, target, ...result });
      };

      if (!/\.fxb$/i.test(fileName)) {
        push({ status: 'rejected', compatibility: 'unverified', reason: 'la extensión debe ser .fxb', bank: null });
        continue;
      }
      if (samePath(source, target)) {
        push({
          status: 'rejected',
          compatibility: 'unverified',
          reason: 'el origen ya está en la carpeta de destino',
          bank: null,
        });
        continue;
      }

      const stats = await statOrNull(source);
      if (stats === null || !stats.isFile()) {
        push({ status: 'rejected', compatibility: 'unverified', reason: 'no existe el archivo', bank: null });
        continue;
      }
      if (stats.size === 0) {
        push({ status: 'rejected', compatibility: 'unverified', reason: 'archivo vacío', bank: null });
        continue;
      }
      if (stats.size > FXB_MAX_BYTES) {
        push({
          status: 'rejected',
          compatibility: 'unverified',
          reason: `supera el máximo de ${FXB_MAX_BYTES} bytes`,
          bank: null,
        });
        continue;
      }

      let data: Buffer;
      try {
        data = await fs.readFile(source);
      } catch (error) {
        push({
          status: 'rejected',
          compatibility: 'unverified',
          reason: `no se pudo leer: ${(error as Error).message}`,
          bank: null,
        });
        continue;
      }

      const parsed = parseFxbBank(data);
      const targetExists = await exists(target);

      if (parsed.bank === null || parsed.issues.length > 0) {
        push({
          status: 'rejected',
          compatibility: 'unverified',
          reason: 'formato .fxb inválido',
          issues: parsed.issues,
          warnings: parsed.warnings,
          bank: parsed.bank,
        });
        continue;
      }

      // Solo se infiere la identidad de los bancos ya presentes al añadir un
      // archivo nuevo; al reemplazar uno existente manda el usuario.
      if (reference.source === 'none' && !targetExists) {
        if (existingReference === undefined) {
          existingReference = await this.findExistingBankReference(presetsDir);
        }
        if (existingReference !== null) {
          reference = existingReference;
        }
      }

      const check = checkBankCompatibility(parsed.bank, reference);
      if (check.compatibility === 'incompatible') {
        push({
          status: 'rejected',
          compatibility: check.compatibility,
          reason: check.reason,
          warnings: parsed.warnings,
          bank: parsed.bank,
        });
        continue;
      }

      if (targetExists && !overwrite) {
        push({
          status: 'rejected',
          compatibility: check.compatibility,
          reason: 'ya existe un banco con ese nombre y overwrite=false',
          warnings: parsed.warnings,
          bank: parsed.bank,
        });
        continue;
      }

      try {
        await fs.mkdir(presetsDir, { recursive: true });
        await copyFileAtomic(source, target);
      } catch (error) {
        push({
          status: 'rejected',
          compatibility: check.compatibility,
          reason: `no se pudo copiar: ${(error as Error).message}`,
          warnings: parsed.warnings,
          bank: parsed.bank,
        });
        continue;
      }

      push({
        status: targetExists ? 'overwritten' : 'imported',
        compatibility: check.compatibility,
        warnings: parsed.warnings,
        bank: parsed.bank,
      });

      if (reference.source === 'none' && !targetExists) {
        reference = {
          source: 'batch',
          uniqueId: parsed.bank.uniqueId,
          uniqueIdValue: parsed.bank.uniqueIdValue,
          fxVersion: parsed.bank.fxVersion,
          file: source,
        };
      }
    }

    return {
      plugin: await this.describe(plugsPath, input.plugin),
      presetsDir,
      reference,
      results,
    };
  }

  /**
   * Inspecciona un `.fxb` **sin copiarlo**: valida el archivo, calcula su
   * SHA-256 y, si se indica un plugin, lo compara con los bancos que ya tiene
   * en su carpeta de presets.
   */
  async inspectBank(input: BankInspectInput): Promise<BankInspectResult> {
    const source = this.resolveBankSource(input.sourcePath);
    const fileName = path.basename(source);
    if (!/\.fxb$/i.test(fileName)) {
      throw new LibraryPathError('la extensión debe ser .fxb');
    }

    const stats = await statOrNull(source);
    if (stats === null || !stats.isFile()) {
      throw new LibraryPathError(`no existe el archivo: ${source}`);
    }
    if (stats.size === 0) throw new LibraryPathError('archivo vacío');
    if (stats.size > FXB_MAX_BYTES) {
      throw new LibraryPathError(`supera el máximo de ${FXB_MAX_BYTES} bytes`);
    }

    const data = await fs.readFile(source);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const parsed = parseFxbBank(data);

    let reference = this.explicitBankReference(input);
    let presetsDir: string | null = null;
    let target: string | null = null;
    let targetExists = false;
    let existingBanks: PluginBankEntry[] = [];

    if (input.plugin !== undefined || input.libraryRoot !== undefined) {
      if (input.libraryRoot === undefined) {
        throw new LibraryPathError('libraryRoot es obligatorio para comparar con un plugin');
      }
      if (input.plugin === undefined) {
        throw new LibraryPathError('plugin es obligatorio para comparar con un plugin');
      }

      const { plugsPath } = await this.resolvePlugs(input.libraryRoot);
      const pluginDir = await this.resolvePluginDir(plugsPath, input.plugin);
      presetsDir = await this.resolvePresetsDir(pluginDir, 'inspeccionar');
      target = path.join(presetsDir, fileName);
      targetExists = await exists(target);
      existingBanks = await this.listPluginBanks(presetsDir);

      // La misma regla que la importación: un banco existente solo sirve de
      // referencia cuando no se reemplaza el archivo.
      if (reference.source === 'none' && !targetExists && existingBanks.length > 0) {
        const first = existingBanks[0]!;
        reference = {
          source: 'existing-bank',
          uniqueId: first.bank.uniqueId,
          uniqueIdValue: first.bank.uniqueIdValue,
          fxVersion: first.bank.fxVersion,
          file: path.join(presetsDir, first.fileName),
        };
      }
    }

    const check =
      parsed.bank === null
        ? { compatibility: 'unverified' as const }
        : checkBankCompatibility(parsed.bank, reference);

    const inspected = parsed.bank;
    const existingSummaries: PluginBankSummary[] = existingBanks.map((entry) => ({
      ...entry,
      sameUniqueId: inspected !== null && entry.bank.uniqueIdValue === inspected.uniqueIdValue,
      sameFxVersion: inspected !== null && entry.bank.fxVersion === inspected.fxVersion,
    }));

    return {
      source,
      fileName,
      size: stats.size,
      sha256,
      valid: inspected !== null && parsed.issues.length === 0,
      bank: inspected,
      issues: parsed.issues,
      warnings: parsed.warnings,
      reference,
      compatibility: check.compatibility,
      reason: 'reason' in check ? (check.reason ?? null) : null,
      target,
      presetsDir,
      targetExists,
      existingBanks: existingSummaries,
    };
  }

  /**
   * Lista los bancos de un plugin y su configuración, sin tocar el disco. Con
   * la carpeta de presets ausente devuelve `banks: []` (no la crea).
   */
  async listBanks(input: BankListInput): Promise<BankListResult> {
    const { plugsPath } = await this.resolvePlugs(input.libraryRoot);
    const pluginDir = await this.resolvePluginDir(plugsPath, input.plugin);
    const snapshot = await this.configService.read(pluginDir);
    const presetsDir = await this.resolvePresetsDir(pluginDir, 'listar los bancos', snapshot);

    return {
      plugin: await this.describe(plugsPath, input.plugin),
      presetsDir,
      presetsDirExists: (await statOrNull(presetsDir))?.isDirectory() === true,
      banks: await this.listPluginBanks(presetsDir),
      config: snapshot,
    };
  }

  /** `programDirName` del plugin, validado como nombre de carpeta simple. */
  private async resolvePresetsDir(
    pluginDir: string,
    action: string,
    snapshot?: FxbConfigSnapshot,
  ): Promise<string> {
    const config = snapshot ?? (await this.configService.read(pluginDir));
    const programDirName = config.config.programDirName;
    if (!isSimpleDirectoryName(programDirName)) {
      throw new LibraryOperationError(
        `programDirName "${programDirName}" no es un nombre de carpeta simple; ` +
          `revisa fxbLoader.config antes de ${action}`,
      );
    }
    const presetsDir = path.join(pluginDir, programDirName);
    if (!samePath(path.dirname(presetsDir), pluginDir)) {
      throw new LibraryOperationError(`programDirName "${programDirName}" apunta fuera del plugin`);
    }
    return presetsDir;
  }

  /** Bancos válidos de la carpeta de presets, leyendo solo su cabecera. */
  private async listPluginBanks(presetsDir: string): Promise<PluginBankEntry[]> {
    let names: string[];
    try {
      const entries = await fs.readdir(presetsDir, { withFileTypes: true });
      names = entries
        .filter((entry) => entry.isFile() && /\.fxb$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
        .slice(0, MAX_REFERENCE_SCAN);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const banks: PluginBankEntry[] = [];
    for (const name of names) {
      const file = path.join(presetsDir, name);
      const stats = await statOrNull(file);
      if (stats === null || stats.size < FXB_HEADER_SIZE || stats.size > FXB_MAX_BYTES) continue;

      let header: Buffer;
      try {
        const handle = await fs.open(file, 'r');
        try {
          header = Buffer.alloc(FXB_CHUNK_HEADER_SIZE);
          await handle.read(header, 0, FXB_CHUNK_HEADER_SIZE, 0);
        } finally {
          await handle.close();
        }
      } catch {
        continue; // un banco ilegible no impide inspeccionar el resto
      }

      const parsed = parseFxbBank(header, stats.size);
      if (parsed.bank === null || parsed.issues.length > 0) continue;
      banks.push({ fileName: name, size: stats.size, bank: parsed.bank });
    }
    return banks;
  }

  private explicitBankReference(input: {
    expectedUniqueId?: string | number;
    expectedFxVersion?: number;
  }): BankReference {
    if (input.expectedUniqueId === undefined && input.expectedFxVersion === undefined) {
      return { source: 'none', uniqueId: null, uniqueIdValue: null, fxVersion: null, file: null };
    }

    let uniqueIdValue: number | null = null;
    if (input.expectedUniqueId !== undefined) {
      try {
        uniqueIdValue = parseUniqueIdInput(input.expectedUniqueId);
      } catch (error) {
        throw new LibraryPathError((error as Error).message);
      }
    }

    let fxVersion: number | null = null;
    if (input.expectedFxVersion !== undefined) {
      const value = input.expectedFxVersion;
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new LibraryPathError('expectedFxVersion debe ser un entero entre 0 y 0xFFFFFFFF');
      }
      fxVersion = value;
    }

    return {
      source: 'explicit',
      uniqueId: uniqueIdValue === null ? null : uniqueIdToText(uniqueIdValue),
      uniqueIdValue,
      fxVersion,
      file: null,
    };
  }

  private resolveBankSource(source: string): string {
    if (typeof source !== 'string' || source.trim() === '') {
      throw new LibraryPathError('cada ruta de sourcePaths debe ser una cadena no vacía');
    }
    if (!path.isAbsolute(source)) {
      throw new LibraryPathError(`la ruta debe ser absoluta: "${source}"`);
    }
    return path.resolve(source);
  }

  /** Primer `.fxb` válido de la carpeta de destino, solo cabecera. */
  private async findExistingBankReference(presetsDir: string): Promise<BankReference | null> {
    let names: string[];
    try {
      const entries = await fs.readdir(presetsDir, { withFileTypes: true });
      names = entries
        .filter((entry) => entry.isFile() && /\.fxb$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
        .slice(0, MAX_REFERENCE_SCAN);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    for (const name of names) {
      const file = path.join(presetsDir, name);
      try {
        const stats = await fs.stat(file);
        if (stats.size < FXB_HEADER_SIZE || stats.size > FXB_MAX_BYTES) continue;

        const handle = await fs.open(file, 'r');
        let header: Buffer;
        try {
          header = Buffer.alloc(FXB_CHUNK_HEADER_SIZE);
          await handle.read(header, 0, FXB_CHUNK_HEADER_SIZE, 0);
        } finally {
          await handle.close();
        }

        const parsed = parseFxbBank(header, stats.size);
        if (parsed.bank !== null && parsed.issues.length === 0) {
          return {
            source: 'existing-bank',
            uniqueId: parsed.bank.uniqueId,
            uniqueIdValue: parsed.bank.uniqueIdValue,
            fxVersion: parsed.bank.fxVersion,
            file,
          };
        }
      } catch {
        // Un banco ilegible no impide probar el siguiente.
      }
    }
    return null;
  }

  private async describe(
    plugsPath: string,
    name: string,
    loader?: LoaderDllInfo,
  ): Promise<PluginEntry> {
    const dir = path.join(plugsPath, name);
    const warnings: string[] = [];
    const compatibilityIssues: string[] = [];
    let compatible: boolean | null = true;
    const hasVfxinfo = (await statOrNull(path.join(dir, VFXINFO_FILENAME)))?.isFile() === true;

    let installed = false;
    let pluginName: string | null = null;
    const configPath = path.join(dir, FXB_CONFIG_FILENAME);
    if (await exists(configPath)) {
      installed = true;
      try {
        const snapshot = await this.configService.read(dir);
        pluginName = snapshot.config.pluginName;
        for (const warning of snapshot.warnings) {
          warnings.push(`${FXB_CONFIG_FILENAME}: ${warning}`);
        }
      } catch (error) {
        warnings.push(`${FXB_CONFIG_FILENAME} ilegible: ${(error as Error).message}`);
      }
    }

    // El binario original sale de vfxinfo.txt o, si ya está instalado, del
    // respaldo: el vfxinfo vigente apunta a fxbLoader.dll, no al plugin.
    let dllNameValue: string | null = null;
    if (!hasVfxinfo) {
      compatible = false;
      compatibilityIssues.push(`falta ${VFXINFO_FILENAME}`);
    } else {
      const raw = await readVfxinfo(path.join(dir, VFXINFO_FILENAME));
      const analysis = raw === null ? null : analyzeVfxinfo(raw);
      if (analysis === null) {
        compatible = false;
        compatibilityIssues.push(`${VFXINFO_FILENAME} no contiene ninguna línea dll_name`);
      } else if (installed && analysis.hasLoader) {
        const backupRaw = await readVfxinfo(path.join(dir, VFXINFO_BACKUP_FILENAME));
        const backupAnalysis = backupRaw === null ? null : analyzeVfxinfo(backupRaw);
        if (backupAnalysis === null) {
          compatible = null;
          compatibilityIssues.push(
            `no se puede verificar el binario original: falta ${VFXINFO_BACKUP_FILENAME}`,
          );
        } else {
          dllNameValue = backupAnalysis.dllNameValue;
        }
      } else {
        dllNameValue = analysis.dllNameValue;
      }
    }

    if (dllNameValue !== null) {
      const check = await this.inspectPluginBinary(dir, dllNameValue);
      if (check.compatible === false) compatible = false;
      else if (check.compatible === null && compatible !== false) compatible = null;
      compatibilityIssues.push(...check.issues);
    }

    if (installed) {
      const installedLoader = path.join(dir, LOADER_DLL_FILENAME);
      if (!(await exists(installedLoader))) {
        compatible = false;
        compatibilityIssues.push(`fxbLoader.config existe pero falta ${LOADER_DLL_FILENAME}`);
      } else {
        const pe = await inspectPeFile(installedLoader);
        if (!isX86Pe32(pe)) {
          compatible = false;
          compatibilityIssues.push(
            `${LOADER_DLL_FILENAME} instalado no es PE32 i386: ${describePe(pe)}`,
          );
        }
      }
    }

    if (loader !== undefined && !loader.valid) {
      compatible = false;
      compatibilityIssues.push(
        `${LOADER_DLL_FILENAME} de origen no es PE32 i386: ${loader.issues.join('; ')}`,
      );
    }

    return {
      name,
      path: dir,
      installed,
      hasVfxinfo,
      pluginName,
      warnings,
      compatible,
      compatibilityIssues,
    };
  }

  private async inspectLoader(dllSourcePath: string): Promise<LoaderDllInfo> {
    const source = await this.resolveDllSource(dllSourcePath);
    const pe = await inspectPeFile(source);
    const valid = isX86Pe32(pe);
    const issues = [...pe.issues];
    if (pe.valid && !valid) {
      issues.push(`es ${describePe(pe)}; fxbLoader.dll debe ser PE32 i386`);
    }
    return {
      path: source,
      valid,
      bitness: pe.bitness,
      machine: pe.machineName,
      issues,
    };
  }

  /**
   * Compara el DLL original del plugin con el cargador de 32 bits. Un archivo
   * ausente o ilegible no es «incompatible», pero tampoco se puede verificar:
   * se devuelve `null` para que la UI lo muestre como tal.
   */
  private async inspectPluginBinary(
    pluginDir: string,
    dllNameValue: string,
  ): Promise<{ compatible: boolean | null; issues: string[] }> {
    const value = dllNameValue.trim();
    if (value === '') {
      return { compatible: false, issues: ['dll_name está vacío'] };
    }
    if (value.includes('\0')) {
      return { compatible: false, issues: ['dll_name contiene un NUL'] };
    }

    const normalized = value.replace(/[\\/]+/g, path.sep);
    if (path.isAbsolute(normalized)) {
      return {
        compatible: false,
        issues: [`dll_name debe ser una ruta relativa al plugin: "${value}"`],
      };
    }

    const binary = path.resolve(pluginDir, normalized);
    const relative = path.relative(pluginDir, binary);
    if (
      relative === '' ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return {
        compatible: false,
        issues: [`dll_name apunta fuera del plugin: "${value}"`],
      };
    }

    const pe = await inspectPeFile(binary);
    if (!pe.valid) {
      return {
        compatible: null,
        issues: [`no se pudo verificar el binario del plugin (${value}): ${pe.issues.join('; ')}`],
      };
    }
    if (!isX86Pe32(pe)) {
      return {
        compatible: false,
        issues: [`el binario del plugin es ${describePe(pe)}; fxbLoader.dll requiere PE32 i386`],
      };
    }
    return { compatible: true, issues: [] };
  }

  private async resolvePlugs(libraryRoot: string): Promise<{ root: string; plugsPath: string }> {
    if (typeof libraryRoot !== 'string' || libraryRoot.trim() === '') {
      throw new LibraryPathError('libraryRoot es obligatorio');
    }
    if (!path.isAbsolute(libraryRoot)) {
      throw new LibraryPathError(`libraryRoot debe ser una ruta absoluta: "${libraryRoot}"`);
    }

    const root = path.resolve(libraryRoot);
    const rootStats = await statOrNull(root);
    if (rootStats === null) throw new LibraryPathError(`no existe la librería: ${root}`);
    if (!rootStats.isDirectory()) throw new LibraryPathError(`no es un directorio: ${root}`);

    const plugsPath = path.join(root, PLUGS_DIRNAME);
    const plugsStats = await statOrNull(plugsPath);
    if (plugsStats === null || !plugsStats.isDirectory()) {
      throw new LibraryPathError(`la librería no contiene una carpeta "${PLUGS_DIRNAME}": ${root}`);
    }

    return { root, plugsPath };
  }

  private async resolvePluginDir(plugsPath: string, plugin: string): Promise<string> {
    if (typeof plugin !== 'string' || plugin.trim() === '') {
      throw new LibraryPathError('plugin es obligatorio');
    }
    if (plugin === '.' || plugin === '..' || /[\\/]/.test(plugin) || plugin.includes('\0')) {
      throw new LibraryPathError(`nombre de plugin no válido: "${plugin}"`);
    }

    const dir = path.join(plugsPath, plugin);
    if (!samePath(path.dirname(dir), plugsPath)) {
      throw new LibraryPathError(`nombre de plugin no válido: "${plugin}"`);
    }

    const stats = await statOrNull(dir);
    if (stats === null || !stats.isDirectory()) {
      throw new PluginNotFoundError(`no existe el plugin "${plugin}" en ${plugsPath}`);
    }
    return dir;
  }

  private async resolveDllSource(dllSourcePath: string): Promise<string> {
    if (typeof dllSourcePath !== 'string' || dllSourcePath.trim() === '') {
      throw new LibraryPathError('dllSourcePath es obligatorio (o define FXB_LOADER_DLL)');
    }
    if (!path.isAbsolute(dllSourcePath)) {
      throw new LibraryPathError(`dllSourcePath debe ser una ruta absoluta: "${dllSourcePath}"`);
    }

    const source = path.resolve(dllSourcePath);
    const stats = await statOrNull(source);
    if (stats === null || !stats.isFile()) {
      throw new LibraryPathError(`no existe el archivo DLL: ${source}`);
    }
    return source;
  }
}
