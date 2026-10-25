import { Injectable, Logger, Optional } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AssociationAuditService } from '../association-audit/association-audit.service';
import { PluginLogService } from '../plugin-log/plugin-log.service';
import { WizardService } from '../wizard/wizard.service';
import {
  ImportPackageInput,
  ImportPackageResult,
  InspectPackageInput,
  InspectPackageResult,
  PackageBankSummary,
  PackagePluginSummary,
} from './library-import.types';
import { LibraryOperationError, LibraryPathError } from './library.types';
import { VFXINFO_FILENAME, readVfxinfo } from './vfxinfo';
import { analyzeVfxinfo } from './vfxinfo';
import { diagnoseVfxBank, repairVfxBank } from './vfx-bank-validator';

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const s = await fs.stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const s = await fs.stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

async function calculateDirStats(dir: string): Promise<{ fileCount: number; totalSizeBytes: number }> {
  let fileCount = 0;
  let totalSizeBytes = 0;

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        fileCount += 1;
        try {
          const s = await fs.stat(full);
          totalSizeBytes += s.size;
        } catch {
          // ignore stat errors
        }
      }
    }
  }

  await walk(dir);
  return { fileCount, totalSizeBytes };
}

function parseQuickVfxinfo(content: string): { id: number | null; name: string | null } {
  const idMatch = content.match(/^id:\s*(\d+)/m);
  const nameMatch = content.match(/^name:\s*(.+)/m);
  return {
    id: idMatch ? Number.parseInt(idMatch[1]!, 10) : null,
    name: nameMatch ? nameMatch[1]!.trim() : null,
  };
}

@Injectable()
export class LibraryImportService {
  private readonly logger = new Logger(LibraryImportService.name);

  constructor(
    @Optional() private readonly pluginLogService?: PluginLogService,
    @Optional() private readonly wizardService?: WizardService,
    @Optional() private readonly auditService?: AssociationAuditService,
  ) {}

  /**
   * Resuelve la raíz canónica del paquete o comprueba si existe una estructura válida.
   */
  async resolvePackageRoot(
    packagePath: string,
  ): Promise<{ resolvedPath: string; kind: 'vfxlibrary' | 'plugin-folder' }> {
    const exists = await directoryExists(packagePath);
    if (!exists) {
      throw new LibraryPathError(`La ruta del paquete no existe: "${packagePath}"`);
    }

    if (await directoryExists(path.join(packagePath, 'plugs'))) {
      return { resolvedPath: packagePath, kind: 'vfxlibrary' };
    }

    try {
      const entries = await fs.readdir(packagePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const candidate = path.join(packagePath, entry.name);
          if (await directoryExists(path.join(candidate, 'plugs'))) {
            return { resolvedPath: candidate, kind: 'vfxlibrary' };
          }
        }
      }

      const hasDll = entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.dll'));
      const hasVfxinfo = entries.some((e) => e.isFile() && e.name.toLowerCase() === 'vfxinfo.txt');
      if (hasDll || hasVfxinfo) {
        return { resolvedPath: packagePath, kind: 'plugin-folder' };
      }
    } catch {
      // ignore
    }

    throw new LibraryOperationError(
      `No se encontró una estructura válida en "${packagePath}". Debe contener una carpeta "plugs/" o un plugin con DLL/vfxinfo.txt.`,
    );
  }

  /**
   * Inspecciona la ruta especificada y busca recursivamente en la raíz y todos sus
   * subdirectorios para detectar todos los candidatos (paquetes .vfxlibrary y carpetas de plugins),
   * alertando sobre posibles colisiones contra la librería de destino activa.
   */
  async inspect(input: InspectPackageInput): Promise<InspectPackageResult> {
    const exists = await directoryExists(input.packagePath);
    if (!exists) {
      throw new LibraryPathError(`La ruta del paquete no existe: "${input.packagePath}"`);
    }

    const targetPlugs = path.join(input.targetLibraryRoot, 'plugs');
    const targetBanks = path.join(input.targetLibraryRoot, 'banks');

    const plugins: PackagePluginSummary[] = [];
    const banks: PackageBankSummary[] = [];
    const seenPluginDirs = new Set<string>();
    const seenBankDirs = new Set<string>();

    let foundVfxLibrary = false;
    let singleResolvedPath: string | null = null;

    const inspectPluginDir = async (pluginDir: string, defaultName: string, packageSource?: string) => {
      const normalizedDir = path.resolve(pluginDir).toLowerCase();
      if (seenPluginDirs.has(normalizedDir)) return;
      seenPluginDirs.add(normalizedDir);

      let entries: import('node:fs').Dirent[] = [];
      try {
        entries = await fs.readdir(pluginDir, { withFileTypes: true });
      } catch {
        return;
      }

      const dllEntry = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith('.dll'));
      const hasVfxinfo = entries.some((e) => e.isFile() && e.name.toLowerCase() === 'vfxinfo.txt');

      if (!dllEntry && !hasVfxinfo) {
        return;
      }

      let vfxinfoId: number | null = null;
      let vfxinfoName: string | null = null;
      if (hasVfxinfo) {
        try {
          const content = await fs.readFile(path.join(pluginDir, 'vfxinfo.txt'), 'utf8');
          const parsed = parseQuickVfxinfo(content);
          vfxinfoId = parsed.id;
          vfxinfoName = parsed.name;
        } catch {
          // ignore
        }
      }

      const name = defaultName;
      let matchedWizard: PackagePluginSummary['matchedWizard'] = null;
      if (this.wizardService) {
        const rec = this.wizardService.match({
          id: vfxinfoId !== null ? vfxinfoId.toString() : undefined,
          name,
          dllName: dllEntry ? dllEntry.name : undefined,
        });
        if (rec) {
          matchedWizard = {
            id: rec.id,
            name: rec.name,
            vendor: rec.vendor,
            isSynth: rec.isSynth,
          };
        }
      }

      const stats = await calculateDirStats(pluginDir);
      const alreadyExists = await directoryExists(path.join(targetPlugs, name));

      plugins.push({
        name,
        sourceDir: pluginDir,
        packageSource,
        dllName: dllEntry ? dllEntry.name : null,
        hasVfxinfo,
        vfxinfoId,
        vfxinfoName,
        fileCount: stats.fileCount,
        totalSizeBytes: stats.totalSizeBytes,
        alreadyExistsInTarget: alreadyExists,
        matchedWizard,
      });
    };

    const inspectBankDir = async (bankDir: string, defaultName: string, packageSource?: string) => {
      const normalizedDir = path.resolve(bankDir).toLowerCase();
      if (seenBankDirs.has(normalizedDir)) return;
      seenBankDirs.add(normalizedDir);

      const diag = await diagnoseVfxBank(bankDir, {
        wizardLookup: (id) => this.wizardService?.getById(id) ?? null,
      });

      const stats = await calculateDirStats(bankDir);
      const alreadyExists = await directoryExists(path.join(targetBanks, defaultName));

      banks.push({
        name: defaultName,
        sourceDir: bankDir,
        packageSource,
        presetCount: diag.presetCount,
        totalSizeBytes: stats.totalSizeBytes,
        alreadyExistsInTarget: alreadyExists,
        chunkPluginId: diag.primaryPluginId,
        chunkPluginFourCc: diag.primaryPluginFourCc,
        matchedWizardName: diag.matchedWizard?.name ?? null,
        isConcordant: diag.isConcordant,
        canRepair: diag.canRepair,
        deficiencies: diag.deficiencies.map((d) => d.message),
      });
    };

    const maxDepth = 6;
    const targetRootNorm = path.resolve(input.targetLibraryRoot).toLowerCase();

    const scanDir = async (current: string, currentDepth: number): Promise<void> => {
      if (currentDepth > maxDepth) return;
      const currentNorm = path.resolve(current).toLowerCase();
      if (currentDepth > 0 && currentNorm === targetRootNorm) return;

      let entries: import('node:fs').Dirent[] = [];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }

      const baseName = path.basename(current);
      if (
        currentDepth > 0 &&
        (baseName.startsWith('.') ||
          baseName === 'node_modules' ||
          baseName === 'tmp' ||
          baseName.startsWith('_backup') ||
          baseName.toLowerCase() === 'wizards')
      ) {
        return;
      }

      // 1. ¿Contiene directamente `plugs/`? -> Es un paquete / raíz VFX
      const plugsSubdir = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === 'plugs');
      if (plugsSubdir) {
        foundVfxLibrary = true;
        if (!singleResolvedPath) singleResolvedPath = current;
        const rawRel = path.relative(input.packagePath, current);
        const pkgRel = rawRel === '' ? path.basename(current) : rawRel;
        const plugsPath = path.join(current, plugsSubdir.name);

        const scanPlugsRecursive = async (dir: string, depth = 0): Promise<void> => {
          if (depth > 6) return;
          let subEntries: import('node:fs').Dirent[] = [];
          try {
            subEntries = await fs.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }

          const hasDll = subEntries.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.dll'));
          const hasVfxinfo = subEntries.some((e) => e.isFile() && e.name.toLowerCase() === 'vfxinfo.txt');

          if (hasDll || hasVfxinfo) {
            await inspectPluginDir(dir, path.basename(dir), pkgRel);
            return;
          }

          for (const sub of subEntries) {
            if (sub.isDirectory() && !sub.name.startsWith('.')) {
              await scanPlugsRecursive(path.join(dir, sub.name), depth + 1);
            }
          }
        };

        await scanPlugsRecursive(plugsPath, 0);

        const banksSubdir = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === 'banks');
        if (banksSubdir) {
          const banksPath = path.join(current, banksSubdir.name);

          const scanBanksRecursive = async (dir: string, depth = 0): Promise<void> => {
            if (depth > 6) return;
            let subEntries: import('node:fs').Dirent[] = [];
            try {
              subEntries = await fs.readdir(dir, { withFileTypes: true });
            } catch {
              return;
            }

            const isBankFolder =
              path.basename(dir).toLowerCase().endsWith('.vfxbank') ||
              subEntries.some((e) => e.isDirectory() && e.name.toLowerCase().endsWith('.vfxpreset'));

            if (isBankFolder) {
              await inspectBankDir(dir, path.basename(dir), pkgRel);
              return;
            }

            for (const sub of subEntries) {
              if (sub.isDirectory() && !sub.name.startsWith('.')) {
                await scanBanksRecursive(path.join(dir, sub.name), depth + 1);
              }
            }
          };

          await scanBanksRecursive(banksPath, 0);
        }
        return;
      }

      // 2. ¿Es una carpeta de plugin individual (con .dll o vfxinfo.txt)?
      const hasDll = entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.dll'));
      const hasVfxinfo = entries.some((e) => e.isFile() && e.name.toLowerCase() === 'vfxinfo.txt');
      if (hasDll || hasVfxinfo) {
        if (!singleResolvedPath) singleResolvedPath = current;
        const rawRel = path.relative(input.packagePath, path.dirname(current));
        const pkgRel = rawRel === '' ? undefined : rawRel;
        await inspectPluginDir(current, baseName, pkgRel);
        return;
      }

      // 3. ¿Es una carpeta de banco individual (.vfxbank)?
      if (baseName.toLowerCase().endsWith('.vfxbank')) {
        const rawRel = path.relative(input.packagePath, path.dirname(current));
        const pkgRel = rawRel === '' ? undefined : rawRel;
        await inspectBankDir(current, baseName, pkgRel);
        return;
      }

      // 4. Continuar recursión en subdirectorios
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subName = entry.name;
        if (
          subName.startsWith('.') ||
          subName === 'node_modules' ||
          subName === 'tmp' ||
          subName.startsWith('_backup')
        ) {
          continue;
        }
        await scanDir(path.join(current, subName), currentDepth + 1);
      }
    };

    await scanDir(input.packagePath, 0);

    if (plugins.length === 0 && banks.length === 0) {
      throw new LibraryOperationError(
        `No se encontró una estructura válida en "${input.packagePath}". Debe contener una carpeta "plugs/" o plugins con DLL/vfxinfo.txt en la raíz o subdirectorios.`,
      );
    }

    const resolvedKind: 'vfxlibrary' | 'plugin-folder' = foundVfxLibrary ? 'vfxlibrary' : 'plugin-folder';
    const sourcePath =
      foundVfxLibrary && singleResolvedPath && plugins.length <= 2
        ? singleResolvedPath
        : input.packagePath;

    return {
      sourcePath,
      resolvedKind,
      plugins,
      banks,
    };
  }

  /** Lee el `dll_name` actual de un vfxinfo.txt, o `null` si no existe/está vacío. */
  private async readCurrentDllName(dir: string): Promise<string | null> {
    const raw = await readVfxinfo(path.join(dir, VFXINFO_FILENAME));
    if (raw === null) return null;
    const analysis = analyzeVfxinfo(raw);
    if (analysis === null || analysis.hasLoader) return null;
    return analysis.dllNameValue;
  }

  /**
   * Importa de forma segura los plugins y bancos seleccionados hacia la librería activa.
   */
  async importPackage(input: ImportPackageInput): Promise<ImportPackageResult> {
    const inspection = await this.inspect({
      packagePath: input.packagePath,
      targetLibraryRoot: input.targetLibraryRoot,
    });

    const targetPlugs = path.join(input.targetLibraryRoot, 'plugs');
    const targetBanks = path.join(input.targetLibraryRoot, 'banks');
    const policy = input.collisionPolicy ?? 'skip';

    await fs.mkdir(targetPlugs, { recursive: true });
    await fs.mkdir(targetBanks, { recursive: true });

    const pluginsToImport =
      input.selectedPlugins && input.selectedPlugins.length > 0
        ? inspection.plugins.filter(
            (p) => input.selectedPlugins!.includes(p.name) || input.selectedPlugins!.includes(p.sourceDir),
          )
        : inspection.plugins;

    const banksToImport =
      input.selectedBanks && input.selectedBanks.length > 0
        ? inspection.banks.filter(
            (b) => input.selectedBanks!.includes(b.name) || input.selectedBanks!.includes(b.sourceDir),
          )
        : inspection.banks;

    const importedPlugins: string[] = [];
    const skippedPlugins: { name: string; reason: string }[] = [];
    const importedBanks: string[] = [];
    const skippedBanks: { name: string; reason: string }[] = [];
    const repairedBanks: string[] = [];
    const associationChanges: { plugin: string; previousValue: string | null }[] = [];
    let totalCopiedBytes = 0;
    let overwritten = false;

    // 1. Copiar plugins
    for (const plugin of pluginsToImport) {
      const destDir = path.join(targetPlugs, plugin.name);
      const exists = await directoryExists(destDir);

      if (exists) {
        if (policy === 'skip') {
          skippedPlugins.push({
            name: plugin.name,
            reason: 'El plugin ya existe en la librería activa y la política es omitir.',
          });
          continue;
        }
        // Valor previo del vfxinfo destino ANTES de reemplazarlo: la auditoría
        // registra el dado y cambia real, no el borrador del paquete.
        const previousValue = await this.readCurrentDllName(destDir);
        associationChanges.push({ plugin: plugin.name, previousValue });
        overwritten = true;
        // Sobrescribir: borrar el directorio destino para asegurar reemplazo limpio
        try {
          await fs.rm(destDir, { recursive: true, force: true });
        } catch (err) {
          this.logger.warn(`No se pudo limpiar destino para sobrescribir ${destDir}: ${String(err)}`);
        }
      } else {
        associationChanges.push({ plugin: plugin.name, previousValue: null });
      }

      await fs.cp(plugin.sourceDir, destDir, { recursive: true, force: true });
      totalCopiedBytes += plugin.totalSizeBytes;
      importedPlugins.push(plugin.name);

      // Registrar en log del plugin
      if (this.pluginLogService) {
        await this.pluginLogService.append(
          destDir,
          'import',
          `Instrumento importado a la librería desde "${plugin.sourceDir}"`,
          `Archivos: ${plugin.fileCount}, Bytes: ${plugin.totalSizeBytes}`,
        );
      }
    }

    // 2. Copiar bancos
    for (const bank of banksToImport) {
      const destDir = path.join(targetBanks, bank.name);
      const exists = await directoryExists(destDir);

      if (exists) {
        if (policy === 'skip') {
          skippedBanks.push({
            name: bank.name,
            reason: 'El banco ya existe en la librería activa y la política es omitir.',
          });
          continue;
        }
        try {
          await fs.rm(destDir, { recursive: true, force: true });
        } catch (err) {
          this.logger.warn(`No se pudo limpiar banco destino ${destDir}: ${String(err)}`);
        }
      }

      await fs.cp(bank.sourceDir, destDir, { recursive: true, force: true });
      totalCopiedBytes += bank.totalSizeBytes;
      importedBanks.push(bank.name);

      if (input.repairBanks) {
        const targetPlugin =
          pluginsToImport.find(
            (p) =>
              (bank.chunkPluginId && p.vfxinfoId === bank.chunkPluginId) ||
              bank.name.toLowerCase().includes(p.name.toLowerCase()) ||
              (p.vfxinfoName && bank.name.toLowerCase().includes(p.vfxinfoName.toLowerCase())),
          ) ?? (pluginsToImport.length === 1 ? pluginsToImport[0] : null);

        if (targetPlugin && targetPlugin.vfxinfoId) {
          try {
            const rep = await repairVfxBank(destDir, {
              targetPluginId: targetPlugin.vfxinfoId,
              targetPluginName: targetPlugin.name,
              targetShortName: targetPlugin.vfxinfoName ?? undefined,
            });
            if (rep.repairedPresets > 0) {
              repairedBanks.push(bank.name);
            }
          } catch (err) {
            this.logger.warn(`No se pudo reparar el banco ${bank.name}: ${String(err)}`);
          }
        }
      }
    }

    this.logger.log(
      `Importación completada: ${importedPlugins.length} plugins, ${importedBanks.length} bancos (${totalCopiedBytes} bytes).`,
    );

    // Auditoría durable: primero la auditoría, después el log rotado (ya se
    // escribió arriba, no redirection): el orden audit-first solo aplica a
    // association-change, que lleva el dado y cambia real.
    const source = input.packagePath;
    if (this.auditService) {
      const packageSource = source;
      for (const change of associationChanges) {
        const pkg = pluginsToImport.find((p) => p.name === change.plugin);
        if (!pkg) continue;
        await this.auditService.append(input.targetLibraryRoot, {
          kind: 'association-change',
          plugin: change.plugin,
          libraryRoot: input.targetLibraryRoot,
          field: 'dll_name',
          previousValue: change.previousValue,
          newValue: pkg.dllName ? `${pkg.name}/${pkg.dllName}` : null,
          packageSource,
        });
      }
      // Resumen de la importación y colisiones, enlazadas por packageSource.
      if (importedPlugins.length > 0 || importedBanks.length > 0 || overwritten) {
        await this.auditService.append(input.targetLibraryRoot, {
          kind: overwritten ? 'reimport' : 'import',
          libraryRoot: input.targetLibraryRoot,
          packageSource,
          repairedBanks: [...repairedBanks],
        });
      }
      for (const skipped of skippedPlugins) {
        await this.auditService.append(input.targetLibraryRoot, {
          kind: 'collision',
          plugin: skipped.name,
          libraryRoot: input.targetLibraryRoot,
          packageSource,
          collisionPolicy: policy,
          collisionNames: [skipped.name],
        });
      }
      for (const skipped of skippedBanks) {
        await this.auditService.append(input.targetLibraryRoot, {
          kind: 'collision',
          libraryRoot: input.targetLibraryRoot,
          packageSource,
          collisionPolicy: policy,
          collisionNames: [skipped.name],
        });
      }
    }

    return {
      targetLibraryRoot: input.targetLibraryRoot,
      importedPlugins,
      skippedPlugins,
      importedBanks,
      skippedBanks,
      repairedBanks,
      totalCopiedBytes,
    };
  }
}
