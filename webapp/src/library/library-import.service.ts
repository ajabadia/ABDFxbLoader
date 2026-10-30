import { Injectable, Logger, Optional } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AssociationAuditService } from '../association-audit/association-audit.service';
import { PluginLogService } from '../plugin-log/plugin-log.service';
import { normalizeName, normalizeWizardPath, WizardService } from '../wizard/wizard.service';
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

async function findWizardSource(
  root: string,
  relativePath: string,
  expectDirectory: boolean,
): Promise<string | null> {
  const safeRelativePath = normalizeWizardPath(relativePath);
  if (!safeRelativePath) return null;
  const wanted = safeRelativePath.replace(/\\/g, '/').toLowerCase();
  const matches: string[] = [];
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 12 || matches.length > 1) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      const isDirectory = entry.isDirectory();
      const rel = path.relative(root, full).replace(/\\/g, '/').toLowerCase();
      if (isDirectory === expectDirectory && (rel === wanted || rel.endsWith(`/${wanted}`))) {
        matches.push(full);
        if (matches.length > 1) return;
        continue;
      }
      if (isDirectory) await visit(full, depth + 1);
    }
  };
  await visit(root, 0);
  return matches.length === 1 ? matches[0]! : null;
}

function isSafeWizardSourcePath(value: string): boolean {
  const portable = value.trim().replace(/\\/g, '/');
  if (!portable || portable.startsWith('//') || /^[a-z]:/i.test(portable)) return false;
  if (portable.split('/').includes('..')) return false;
  const normalized = normalizeWizardPath(portable);
  return normalized !== null && !normalized.split('/').includes('..');
}

async function copyWizardDependency(
  root: string,
  destinationRoot: string,
  relativePath: string,
  expectDirectory: boolean,
): Promise<boolean> {
  if (!isSafeWizardSourcePath(relativePath)) return false;
  const normalized = normalizeWizardPath(relativePath)!;
  const destination = path.resolve(destinationRoot, normalized);
  const relativeDestination = path.relative(destinationRoot, destination);
  if (relativeDestination.startsWith('..') || path.isAbsolute(relativeDestination)) return false;
  const source = await findWizardSource(root, normalized, expectDirectory);
  if (!source) return false;
  const stat = await fs.stat(source);
  if (expectDirectory && !stat.isDirectory()) return false;
  if (!expectDirectory && !stat.isFile() && !stat.isDirectory()) return false;
  if (await fileExists(destination) || await directoryExists(destination)) return true;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (stat.isDirectory()) {
    await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  } else {
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  }
  return true;
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
      const allWizards = this.wizardService?.getAll() ?? [];
      const idMatch = vfxinfoId !== null ? this.wizardService?.getById(String(vfxinfoId)) ?? null : null;
      const dllMatches = dllEntry
        ? allWizards.filter((candidate) => normalizeName(path.basename(candidate.dllName)) === normalizeName(dllEntry.name))
        : [];
      const nameMatches = allWizards.filter(
        (candidate) => normalizeName(candidate.name) === normalizeName(vfxinfoName || name),
      );
      const strongMatches = [
        ...(idMatch ? [{ record: idMatch, reason: 'id' as const }] : []),
        ...dllMatches.map((record) => ({ record, reason: 'dll' as const })),
        ...nameMatches.map((record) => ({ record, reason: 'name' as const })),
      ].filter((match, index, matches) => matches.findIndex((other) => other.record.id === match.record.id) === index);
      const hasConflictingMatches = new Set(strongMatches.map((match) => match.record.id)).size > 1;
      const fuzzyMatch = this.wizardService?.match({
        name: vfxinfoName || name,
        dllName: dllEntry?.name,
      }) ?? null;
      const selectedMatch = hasConflictingMatches
        ? null
        : strongMatches[0] ?? (fuzzyMatch ? { record: fuzzyMatch, reason: 'suggestion' as const } : null);

      const summarizeWizard = async (
        wizard: NonNullable<typeof fuzzyMatch>,
        matchReason: NonNullable<PackagePluginSummary['matchedWizard']>['matchReason'],
      ): Promise<NonNullable<PackagePluginSummary['matchedWizard']>> => {
        const filesToCopy = wizard.filesToCopy.map(normalizeWizardPath).filter((item): item is string => item !== null);
        const dirsToCopy = wizard.dirsToCopy.map(normalizeWizardPath).filter((item): item is string => item !== null);
        const filesToCreate = Object.keys(wizard.filesToCreate ?? {}).map(normalizeWizardPath).filter((item): item is string => item !== null);
        const missingFilesToCopy: string[] = [];
        const missingDirsToCopy: string[] = [];
        const missingFilesToCreate: string[] = [];

        for (const item of filesToCopy) {
          if (
            !isSafeWizardSourcePath(item) ||
            (!(await fileExists(path.join(pluginDir, item))) && !(await findWizardSource(input.packagePath, item, false)))
          ) {
            missingFilesToCopy.push(item);
          }
        }
        for (const item of dirsToCopy) {
          if (
            !isSafeWizardSourcePath(item) ||
            (!(await directoryExists(path.join(pluginDir, item))) && !(await findWizardSource(input.packagePath, item, true)))
          ) {
            missingDirsToCopy.push(item);
          }
        }
        for (const item of filesToCreate) {
          if (!(await fileExists(path.join(pluginDir, item)))) missingFilesToCreate.push(item);
        }

        return {
          id: wizard.id,
          name: wizard.name,
          vendor: wizard.vendor,
          isSynth: wizard.isSynth,
          matchReason,
          dllName: wizard.dllName,
          filesToCopy,
          missingFilesToCopy,
          dirsToCopy,
          missingDirsToCopy,
          filesToCreate,
          missingFilesToCreate,
          hasRegistryKeys: wizard.registryKeys.trim().length > 0,
          registryFilePresent: await fileExists(path.join(pluginDir, 'registry_keys.reg')),
          hasReadme: Boolean(wizard.readme?.trim()),
          readme: wizard.readme?.trim() || null,
          notes: [wizard.notes, wizard.vendorNotes].filter((value) => value.trim()).join('\n\n'),
          symlinks: wizard.symlinks,
          registryKeys: wizard.registryKeys,
        };
      };

      let matchedWizard: PackagePluginSummary['matchedWizard'] = null;
      let wizardCandidates: NonNullable<PackagePluginSummary['wizardCandidates']> = [];
      if (selectedMatch) {
        matchedWizard = await summarizeWizard(selectedMatch.record, selectedMatch.reason);
      }
      if (this.wizardService && (hasConflictingMatches || !selectedMatch || selectedMatch.reason === 'suggestion')) {
        const related = allWizards.filter((candidate) => {
          const candidateName = normalizeName(candidate.name);
          const candidateDll = normalizeName(path.basename(candidate.dllName));
          const detectedName = normalizeName(vfxinfoName || name);
          const detectedDll = normalizeName(dllEntry?.name ?? '');
          return candidate.id !== selectedMatch?.record.id && (
            (detectedName.length >= 4 && (candidateName.includes(detectedName) || detectedName.includes(candidateName))) ||
            (detectedDll.length >= 4 && (candidateDll.includes(detectedDll) || detectedDll.includes(candidateDll)))
          );
        });
        const selectedIds = new Set(strongMatches.map((match) => match.record.id));
        const candidateRecords = hasConflictingMatches
          ? strongMatches.map((match) => match.record)
          : [...(selectedMatch ? [selectedMatch.record] : []), ...related.filter((candidate) => !selectedIds.has(candidate.id)).slice(0, 10)];
        wizardCandidates = await Promise.all(
          candidateRecords.map((candidate) => summarizeWizard(candidate, 'suggestion')),
        );
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
        wizardCandidates,
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
    if (input.selectedWizards) {
      for (const plugin of inspection.plugins) {
        const selectedId = input.selectedWizards[plugin.sourceDir] ?? input.selectedWizards[plugin.name];
        if (selectedId === undefined) continue;
        if (!this.wizardService) throw new LibraryOperationError('El catálogo de wizards no está disponible para confirmar la selección.');
        if (selectedId === '') {
          plugin.matchedWizard = null;
          continue;
        }
        const wizard = this.wizardService.getById(selectedId);
        if (!wizard) throw new LibraryOperationError(`Wizard seleccionado no encontrado: ${selectedId}`);
        const offeredWizardIds = new Set([
          plugin.matchedWizard?.id,
          ...(plugin.wizardCandidates ?? []).map((candidate) => candidate.id),
        ].filter((id): id is string => Boolean(id)));
        if (!offeredWizardIds.has(selectedId)) {
          throw new LibraryOperationError(`El wizard ${selectedId} no pertenece a los candidatos inspeccionados para ${plugin.name}.`);
        }
        const requiredFiles = wizard.filesToCopy.map(normalizeWizardPath).filter((item): item is string => item !== null);
        const requiredDirs = wizard.dirsToCopy.map(normalizeWizardPath).filter((item): item is string => item !== null);
        const filesToCreate = Object.keys(wizard.filesToCreate ?? {}).map(normalizeWizardPath).filter((item): item is string => item !== null);
        const missingFilesToCopy: string[] = [];
        const missingDirsToCopy: string[] = [];
        const missingFilesToCreate: string[] = [];
        for (const item of requiredFiles) {
          const inPlugin = await fileExists(path.join(plugin.sourceDir, item));
          const packaged = inPlugin ? null : await findWizardSource(input.packagePath, item, false);
          if (!inPlugin && !packaged) missingFilesToCopy.push(item);
        }
        for (const item of requiredDirs) {
          const inPlugin = await directoryExists(path.join(plugin.sourceDir, item));
          const packaged = inPlugin ? null : await findWizardSource(input.packagePath, item, true);
          if (!inPlugin && !packaged) missingDirsToCopy.push(item);
        }
        for (const item of filesToCreate) {
          if (!(await fileExists(path.join(plugin.sourceDir, item)))) missingFilesToCreate.push(item);
        }
        plugin.matchedWizard = {
          id: wizard.id,
          name: wizard.name,
          vendor: wizard.vendor,
          isSynth: wizard.isSynth,
          matchReason: 'selected',
          dllName: wizard.dllName,
          filesToCopy: requiredFiles,
          missingFilesToCopy,
          dirsToCopy: requiredDirs,
          missingDirsToCopy,
          filesToCreate,
          missingFilesToCreate,
          hasRegistryKeys: wizard.registryKeys.trim().length > 0,
          registryFilePresent: await fileExists(path.join(plugin.sourceDir, 'registry_keys.reg')),
          hasReadme: Boolean(wizard.readme?.trim()),
          readme: wizard.readme?.trim() || null,
          notes: [wizard.notes, wizard.vendorNotes].filter((value) => value.trim()).join('\n\n'),
          symlinks: wizard.symlinks,
          registryKeys: wizard.registryKeys,
        };
      }
    }

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
    const preparedPlugins: string[] = [];
    const wizardWarnings: { plugin: string; message: string }[] = [];
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

      // Aplicar solo una coincidencia inequívoca. El catálogo aporta vfxinfo,
      // metadatos y .reg; dependencias adicionales se buscan en el paquete y
      // se copian únicamente con una ruta segura y coincidencia única.
      const wizardMatch = plugin.matchedWizard;
      if (wizardMatch && this.wizardService) {
        const wizard = this.wizardService.getById(wizardMatch.id);
        const missing: string[] = [];
        try {
          if (wizard) {
            for (const item of wizardMatch.filesToCopy) {
              try {
                if (!(await copyWizardDependency(input.packagePath, destDir, item, false))) {
                  missing.push(`archivo ${item}`);
                }
              } catch (error) {
                missing.push(`archivo ${item}: ${(error as Error).message}`);
              }
            }
            for (const item of wizardMatch.dirsToCopy) {
              try {
                if (!(await copyWizardDependency(input.packagePath, destDir, item, true))) {
                  missing.push(`carpeta ${item}`);
                }
              } catch (error) {
                missing.push(`carpeta ${item}: ${(error as Error).message}`);
              }
            }
            for (const [filename, content] of Object.entries(wizard.filesToCreate ?? {})) {
              const safePath = isSafeWizardSourcePath(filename) ? normalizeWizardPath(filename) : null;
              if (!safePath) {
                missing.push(`ruta insegura para archivo generado: ${filename}`);
                continue;
              }
              const destination = path.resolve(destDir, safePath);
              const relDest = path.relative(destDir, destination);
              if (relDest.startsWith('..') || path.isAbsolute(relDest)) {
                missing.push(`ruta insegura para archivo generado: ${filename}`);
                continue;
              }
              await fs.mkdir(path.dirname(destination), { recursive: true });
              await fs.writeFile(destination, Buffer.from(content, 'latin1'), { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'EEXIST') throw error;
              });
            }
            if (!plugin.hasVfxinfo) {
              await this.wizardService.createVfxinfo({ pluginDir: destDir, wizardId: wizard.id });
            }
            const meta = await this.wizardService.getPluginMetaService().read(destDir);
            if (!meta.exists) await this.wizardService.applyToMeta({ pluginDir: destDir, wizardId: wizard.id });
            preparedPlugins.push(plugin.name);
            const registryPath = path.join(destDir, 'registry_keys.reg');
            if (wizard.registryKeys.trim() && !(await fileExists(registryPath))) {
              await fs.writeFile(registryPath, `${wizard.registryKeys.trim()}\r\n`, { flag: 'wx' });
            }
            if (wizardMatch.hasRegistryKeys) {
              wizardWarnings.push({ plugin: plugin.name, message: `Claves de Registro disponibles en ${registryPath}. Revísalas; no se aplicaron al Registro.` });
            }
            if (missing.length) wizardWarnings.push({ plugin: plugin.name, message: `Requisitos sin resolver: ${missing.join(', ')}.` });
            if (wizard.symlinks.length > 0) wizardWarnings.push({ plugin: plugin.name, message: `El wizard declara enlaces simbólicos para V-Machine; revisa manualmente: ${wizard.symlinks.join(', ')}.` });
            if (wizard.readme?.trim()) await fs.writeFile(path.join(destDir, 'wizard_readme.txt'), `${wizard.readme.trim()}\r\n`, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'EEXIST') throw error;
            });
          }
        } catch (error) {
          wizardWarnings.push({ plugin: plugin.name, message: `No se pudo completar la preparación del wizard: ${(error as Error).message}` });
        }
      } else if (wizardMatch) {
        wizardWarnings.push({ plugin: plugin.name, message: `Wizard detectado (${wizardMatch.vendor} ${wizardMatch.name}), pero el catálogo no está disponible para completar la preparación.` });
      }

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
      preparedPlugins,
      wizardWarnings,
      totalCopiedBytes,
    };
  }
}
