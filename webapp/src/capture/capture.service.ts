import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { writeFileAtomic } from '../common/atomic-file';
import type { CaptureSnapshot, CaptureDiff, CaptureTask, CaptureTaskKind, FileSnapshotEntry, RegistrySnapshotEntry } from './capture.types';
import { serializeWizardToVfxinfo } from '../wizard/wizard-parser';
import type { WizardRecord } from '../wizard/wizard.types';

/** Parte una ruta relativa en segmentos, con independencia del separador. */
function splitRelative(value: string): string[] {
  return value
    .replace(/[\\/]+/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
}

/**
 * Directorio común de una lista de rutas relativas. El staging conserva la ruta
 * de la unidad de origen (`Users\...\Program Files\VstPlugins\P8.dll`), y el
 * paquete tiene que recortar esa cabecera para que el DLL quede en la raíz del
 * plugin, como en una librería real. La comparación ignora mayúsculas, como
 * Windows.
 */
function commonDirectory(files: string[]): string[] {
  if (files.length === 0) return [];
  const directories = files.map((file) => splitRelative(file).slice(0, -1));
  let common = directories[0]!;
  for (const directory of directories.slice(1)) {
    let length = 0;
    while (
      length < common.length &&
      length < directory.length &&
      common[length]!.toLowerCase() === directory[length]!.toLowerCase()
    ) {
      length += 1;
    }
    common = common.slice(0, length);
  }
  return common;
}

/** Nombre de carpeta válido dentro de `plugs\`; sin rutas ni caracteres reservados. */
function safePluginFolderName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'plugin' : cleaned;
}

/** Abreviatura de pantalla LCD: la primera palabra útil, en mayúsculas. */
function abbreviation(name: string): string {
  const firstWord = name.split(/[^0-9A-Za-z]+/).filter(Boolean)[0] ?? name;
  return firstWord.slice(0, 4).toUpperCase();
}

@Injectable()
export class CaptureService implements OnModuleInit {
  private readonly snapshots = new Map<string, CaptureSnapshot>();
  private readonly diffs = new Map<string, CaptureDiff>();
  private readonly tasks = new Map<string, CaptureTask>();
  private readonly taskControllers = new Map<string, AbortController>();
  private readonly storageDir: string;
  private readonly stagingDir: string;

  constructor() {
    // Usar directorio persistente en home para sobrevivir a reinicios
    this.storageDir = path.join(os.homedir(), '.fxbloader', 'capture');
    this.stagingDir = path.join(this.storageDir, 'staging');
    if (!existsSync(this.storageDir)) {
      fs.mkdir(this.storageDir, { recursive: true }).catch(() => undefined);
    }
    if (!existsSync(this.stagingDir)) {
      fs.mkdir(this.stagingDir, { recursive: true }).catch(() => undefined);
    }
  }

  /** Raíz del staging: cada diff empaquetado tiene una carpeta con su ID. */
  get stagingRoot(): string {
    return this.stagingDir;
  }

  async onModuleInit(): Promise<void> {
    await this.loadFromDisk();
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const entries = await fs.readdir(this.storageDir);
      for (const entry of entries) {
        if (entry.endsWith('.json') && !entry.startsWith('diff-')) {
          try {
            const content = await fs.readFile(path.join(this.storageDir, entry), 'utf8');
            const snapshot = JSON.parse(content) as CaptureSnapshot;
            if (snapshot.id) this.snapshots.set(snapshot.id, snapshot);
          } catch {}
        } else if (entry.startsWith('diff-') && entry.endsWith('.json')) {
          try {
            const content = await fs.readFile(path.join(this.storageDir, entry), 'utf8');
            const diff = JSON.parse(content) as CaptureDiff & { diffId?: string };
            const diffId = diff.diffId || entry.replace('diff-', '').replace('.json', '');
            if (diffId) this.diffs.set(diffId, diff);
          } catch {}
        }
      }
    } catch {}
  }

  private getDefaultScanRoots(): string[] {
    const roots: string[] = [];
    if (process.platform === 'win32') {
      roots.push(process.env['ProgramFiles'] || 'C:\\Program Files');
      roots.push(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)');
      roots.push(process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local'));
      roots.push(process.env['APPDATA'] || path.join(os.homedir(), 'AppData', 'Roaming'));
      roots.push(process.env['USERPROFILE'] || os.homedir());
      roots.push('C:\\Windows\\System32');
      roots.push('C:\\Windows\\SysWOW64');
      roots.push('C:\\Windows\\winsxs');
      // Common VST paths
      roots.push('C:\\VSTPlugins');
      roots.push('C:\\Program Files\\VstPlugins');
      roots.push('C:\\Program Files (x86)\\VstPlugins');
      roots.push('C:\\Program Files\\Steinberg\\VstPlugins');
      roots.push('C:\\Program Files (x86)\\Steinberg\\VstPlugins');
    } else {
      roots.push('/usr/local/bin', '/opt', '/usr/bin', os.homedir());
    }
    // Remove duplicates and non-existent
    const unique = [...new Set(roots)];
    return unique.filter(r => existsSync(r));
  }

  private getDefaultRegistryRoots(): string[] {
    if (process.platform !== 'win32') return [];
    return [
      'HKEY_CURRENT_USER\\Software',
      'HKEY_LOCAL_MACHINE\\SOFTWARE',
      'HKEY_CLASSES_ROOT',
    ];
  }

  private getJunkPatterns(): RegExp[] {
    return [
      /[\\/]Temp[\\/]/i,
      /[\\/]tmp[\\/]/i,
      /[\\/]Cache[\\/]/i,
      /[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i,
      /[\\/]Windows[\\/]Temp[\\/]/i,
      /[\\/]Prefetch[\\/]/i,
      /[\\/]Recent[\\/]/i,
      /[\\/]INetCache[\\/]/i,
      /\$Recycle\.Bin[\\/]/i,
      /System Volume Information[\\/]/i,
      /\.tmp$/i,
      /\.log$/i,
      /\.old$/i,
      /\.bak$/i,
      /Thumbs\.db$/i,
      /desktop\.ini$/i,
      /\.crdownload$/i,
      /\.part$/i,
      /NTUSER\.DAT\.LOG/i,
    ];
  }

  private isJunk(p: string): boolean {
    return this.getJunkPatterns().some(re => re.test(p));
  }

  async scanFiles(
    roots: string[],
    computeHashes: boolean,
    options: {
      signal?: AbortSignal;
      onRoot?: (root: string, filesFound: number, completed: number) => void;
      onProgress?: (currentRoot: string, currentPath: string, entriesVisited: number, filesFound: number) => void;
    } = {},
  ): Promise<FileSnapshotEntry[]> {
    const results: FileSnapshotEntry[] = [];
    const seen = new Set<string>();
    let entriesVisited = 0;

    const walk = async (dir: string, root: string) => {
      options.onProgress?.(root, dir, entriesVisited, results.length);
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (options.signal?.aborted) return;
          entriesVisited++;
          if (entriesVisited === 1 || entriesVisited % 250 === 0) {
            options.onProgress?.(root, dir, entriesVisited, results.length);
          }
          const fullPath = path.join(dir, entry.name);
          const normalized = path.normalize(fullPath);
          if (this.isJunk(normalized)) continue;
          if (seen.has(normalized)) continue;
          seen.add(normalized);

          try {
            const stat = await fs.stat(normalized);
            if (entry.isDirectory()) {
              results.push({
                path: normalized,
                size: 0,
                mtimeMs: stat.mtimeMs,
                isDir: true,
              });
              // Don't recurse too deep or into certain dirs to avoid performance issues
              if (normalized.includes('node_modules')) continue;
              if (normalized.includes('.git')) continue;
              await walk(normalized, root);
            } else if (entry.isFile()) {
              let hash: string | undefined;
              if (computeHashes && stat.size < 10 * 1024 * 1024) { // max 10MB for hashing
                try {
                  const content = await fs.readFile(normalized);
                  hash = createHash('sha256').update(content).digest('hex');
                } catch {}
              }
              results.push({
                path: normalized,
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                isDir: false,
                hash,
              });
            }
          } catch {}
        }
      } catch {}
    };

    for (let index = 0; index < roots.length; index++) {
      const root = roots[index]!;
      if (options.signal?.aborted) break;
      options.onRoot?.(root, results.length, index);
      if (existsSync(root)) await walk(root, root);
      options.onRoot?.(root, results.length, index + 1);
    }
    return results;
  }

  private async queryRegistryKey(key: string, signal?: AbortSignal): Promise<RegistrySnapshotEntry[]> {
    const results: RegistrySnapshotEntry[] = [];
    if (process.platform !== 'win32') return results;

    return new Promise((resolve) => {
      const args = ['query', key, '/s'];
      const proc = spawn('reg', args);
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        resolve(results);
      };
      const abort = () => {
        proc.kill();
        finish();
      };
      const timeout = setTimeout(() => {
        proc.kill();
        finish();
      }, 30000);

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', () => {
        try {
          const lines = stdout.split(/\r?\n/);
          let currentKey = key;
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;
            if (line.match(/^(HKEY_|HKLM|HKCU|HKCR|HKU|HKCC)/i)) {
              currentKey = line.trim();
              continue;
            }
            // `reg query` escribe `    ValueName    REG_SZ    ValueData`,
            // sin comillas en el nombre (eso solo lo hace un .reg exportado).
            const valueMatch = line.match(/^\s+(.+?)\s+(REG_[A-Z0-9_]+)\s+(.*)$/);
            if (valueMatch && valueMatch[1] && valueMatch[2] && valueMatch[3] !== undefined) {
              results.push({
                key: currentKey,
                valueName: valueMatch[1].trim(),
                valueType: valueMatch[2],
                valueData: valueMatch[3].trim(),
              });
            }
          }
        } catch {}
        finish();
      });

      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }

  async scanRegistry(
    roots: string[],
    options: {
      signal?: AbortSignal;
      onRoot?: (root: string, entriesFound: number, completed: number) => void;
      onProgress?: (root: string, completed: number) => void;
    } = {},
  ): Promise<RegistrySnapshotEntry[]> {
    const results: RegistrySnapshotEntry[] = [];
    for (let index = 0; index < roots.length; index++) {
      if (options.signal?.aborted) break;
      const root = roots[index]!;
      options.onRoot?.(root, results.length, index);
      options.onProgress?.(root, index);
      try {
        const entries = await this.queryRegistryKey(root, options.signal);
        results.push(...entries);
      } catch {}
      options.onRoot?.(root, results.length, index + 1);
    }
    return results;
  }

  private updateTask(taskId: string, patch: Partial<CaptureTask>): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  }

  getTask(taskId: string): CaptureTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : undefined;
  }

  cancelTask(taskId: string): CaptureTask | undefined {
    const task = this.tasks.get(taskId);
    const controller = this.taskControllers.get(taskId);
    if (!task || !controller || task.status !== 'running') return task ? { ...task } : undefined;
    this.updateTask(taskId, { status: 'cancelling', phase: 'cancelling', message: 'Parando el escaneo; esperando a que finalice la operación actual…' });
    controller.abort();
    return this.getTask(taskId);
  }

  private beginTask(kind: CaptureTaskKind, work: (taskId: string, signal: AbortSignal) => Promise<CaptureTask['result']>): CaptureTask {
    const taskId = randomUUID();
    const controller = new AbortController();
    const now = new Date().toISOString();
    const task: CaptureTask = {
      taskId, kind, status: 'running', phase: 'initializing', message: 'Preparando captura…',
      rootsTotal: 0, rootsCompleted: 0, currentRoot: null, currentPath: null,
      entriesVisited: 0, filesFound: 0, registryRootsTotal: 0, registryRootsCompleted: 0,
      currentRegistryRoot: null, startedAt: now, updatedAt: now,
    };
    this.tasks.set(taskId, task);
    this.taskControllers.set(taskId, controller);
    void work(taskId, controller.signal).then((result) => {
      const current = this.tasks.get(taskId);
      if (!current) return;
      const cancelled = controller.signal.aborted;
      this.updateTask(taskId, {
        status: cancelled ? 'cancelled' : 'completed', phase: cancelled ? 'cancelled' : 'completed',
        message: cancelled ? 'Captura detenida. No se guardó un snapshot parcial.' : 'Captura completada.',
        currentRoot: null, currentPath: null, currentRegistryRoot: null,
        ...(!cancelled && result ? { result } : {}),
      });
    }).catch((error: unknown) => {
      const cancelled = controller.signal.aborted;
      this.updateTask(taskId, {
        status: cancelled ? 'cancelled' : 'failed', phase: cancelled ? 'cancelled' : 'failed',
        message: cancelled ? 'Captura detenida. No se guardó un snapshot parcial.' : 'La captura falló.',
        currentRoot: null, currentPath: null, currentRegistryRoot: null,
        ...(!cancelled ? { error: error instanceof Error ? error.message : String(error) } : {}),
      });
    }).finally(() => {
      this.taskControllers.delete(taskId);
      // Evitar retener indefinidamente los historiales de tareas terminadas.
      const terminal = [...this.tasks.values()].filter((entry) => entry.status === 'completed' || entry.status === 'cancelled' || entry.status === 'failed');
      for (const oldTask of terminal.slice(0, Math.max(0, terminal.length - 20))) this.tasks.delete(oldTask.taskId);
    });
    return { ...task };
  }

  beginSnapshotTask(options: {
    scanRoots?: string[];
    registryRoots?: string[];
    computeHashes?: boolean;
  } = {}): CaptureTask {
    return this.beginTask('start', async (taskId, signal) => {
      const snapshot = await this.startSnapshot({ ...options, taskId, signal });
      return { snapshotId: snapshot.id };
    });
  }

  beginFinishTask(options: {
    snapshotIdBefore: string;
    scanRoots?: string[];
    registryRoots?: string[];
    computeHashes?: boolean;
    filterJunk?: boolean;
  }): CaptureTask {
    return this.beginTask('finish', async (taskId, signal) => {
      const result = await this.finishCapture({ ...options, taskId, signal });
      return {
        snapshotId: result.snapshotAfter.id,
        diffId: result.diffId,
        filesAdded: result.diff.addedFiles.filter((file) => !file.isDir).length,
        filesModified: result.diff.modifiedFiles.length,
        filesRemoved: result.diff.removedFiles.filter((file) => !file.isDir).length,
        registryAdded: result.diff.addedRegistry.length,
        registryModified: result.diff.modifiedRegistry.length,
        registryRemoved: result.diff.removedRegistry.length,
      };
    });
  }

  async startSnapshot(options: {
    scanRoots?: string[];
    registryRoots?: string[];
    computeHashes?: boolean;
    taskId?: string;
    signal?: AbortSignal;
  } = {}): Promise<CaptureSnapshot> {
    const scanRoots = options.scanRoots || this.getDefaultScanRoots();
    const registryRoots = options.registryRoots || this.getDefaultRegistryRoots();
    const computeHashes = options.computeHashes || false;
    const taskId = options.taskId;
    this.updateTask(taskId ?? '', {
      phase: 'files', message: `Escaneando archivos en ${scanRoots.length} ubicación(es)…`,
      rootsTotal: scanRoots.length, registryRootsTotal: registryRoots.length,
    });

    const files = await this.scanFiles(scanRoots, computeHashes, {
      signal: options.signal,
      onRoot: (root, filesFound, completed) => this.updateTask(taskId ?? '', {
        currentRoot: root, rootsCompleted: completed, filesFound,
        message: `Escaneando archivos: ubicación ${Math.min(completed + 1, scanRoots.length)} de ${scanRoots.length}`,
      }),
      onProgress: (root, currentPath, entriesVisited, filesFound) => this.updateTask(taskId ?? '', {
        phase: 'files', currentRoot: root, currentPath, entriesVisited, filesFound,
        message: `Archivos: ${filesFound.toLocaleString()} encontrados · ${entriesVisited.toLocaleString()} entradas revisadas`,
      }),
    });
    if (options.signal?.aborted) throw new Error('Captura cancelada');

    const registry = await this.scanRegistry(registryRoots, {
      signal: options.signal,
      onRoot: (root, entriesFound, completed) => this.updateTask(taskId ?? '', {
        phase: 'registry', currentRegistryRoot: root, registryRootsCompleted: completed,
        message: `Registro: revisando ${root} (${entriesFound.toLocaleString()} valores encontrados)`,
      }),
    });
    if (options.signal?.aborted) throw new Error('Captura cancelada');

    const snapshot: CaptureSnapshot = {
      id: randomUUID(), createdAt: new Date().toISOString(), platform: process.platform,
      files, registry, scanRoots, registryRoots,
    };
    this.snapshots.set(snapshot.id, snapshot);
    const snapshotPath = path.join(this.storageDir, `${snapshot.id}.json`);
    await writeFileAtomic(snapshotPath, Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8')).catch(() => undefined);
    return snapshot;
  }

  async finishCapture(options: {
    snapshotIdBefore: string;
    scanRoots?: string[];
    registryRoots?: string[];
    computeHashes?: boolean;
    filterJunk?: boolean;
    taskId?: string;
    signal?: AbortSignal;
  }): Promise<{ snapshotAfter: CaptureSnapshot; diff: CaptureDiff; diffId: string }> {
    const before = this.snapshots.get(options.snapshotIdBefore);
    if (!before) {
      throw new NotFoundException({
        message: `No existe el snapshot inicial "${options.snapshotIdBefore}" para cerrar la captura.`,
      });
    }
    const snapshotAfter = await this.startSnapshot({
      scanRoots: options.scanRoots || before.scanRoots, registryRoots: options.registryRoots || before.registryRoots,
      computeHashes: options.computeHashes || false, taskId: options.taskId, signal: options.signal,
    });
    if (options.signal?.aborted) throw new Error('Captura cancelada');
    const diff = this.diffSnapshots(before, snapshotAfter, options.filterJunk !== false);
    const diffId = randomUUID();
    (diff as any).diffId = diffId;
    this.diffs.set(diffId, diff);
    const diffPath = path.join(this.storageDir, `diff-${diffId}.json`);
    await writeFileAtomic(diffPath, Buffer.from(JSON.stringify({ ...diff, diffId }, null, 2), 'utf8')).catch(() => undefined);
    return { snapshotAfter, diff, diffId };
  }

  private diffSnapshots(before: CaptureSnapshot, after: CaptureSnapshot, filterJunk: boolean): CaptureDiff {
    const beforeFilesMap = new Map(before.files.map(f => [f.path, f]));
    const afterFilesMap = new Map(after.files.map(f => [f.path, f]));

    const addedFiles: FileSnapshotEntry[] = [];
    const modifiedFiles: Array<{ before: FileSnapshotEntry; after: FileSnapshotEntry }> = [];
    const removedFiles: FileSnapshotEntry[] = [];

    for (const [p, afterEntry] of afterFilesMap) {
      if (filterJunk && this.isJunk(p)) continue;
      if (!beforeFilesMap.has(p)) {
        addedFiles.push(afterEntry);
      } else {
        const beforeEntry = beforeFilesMap.get(p)!;
        if (!beforeEntry.isDir && !afterEntry.isDir) {
          if (
            beforeEntry.mtimeMs !== afterEntry.mtimeMs ||
            beforeEntry.size !== afterEntry.size ||
            (beforeEntry.hash && afterEntry.hash && beforeEntry.hash !== afterEntry.hash)
          ) {
            modifiedFiles.push({ before: beforeEntry, after: afterEntry });
          }
        }
      }
    }

    for (const [p, beforeEntry] of beforeFilesMap) {
      if (filterJunk && this.isJunk(p)) continue;
      if (!afterFilesMap.has(p)) {
        removedFiles.push(beforeEntry);
      }
    }

    const beforeRegMap = new Map(before.registry.map(r => [`${r.key}|${r.valueName}`, r]));
    const afterRegMap = new Map(after.registry.map(r => [`${r.key}|${r.valueName}`, r]));

    const addedRegistry: RegistrySnapshotEntry[] = [];
    const modifiedRegistry: Array<{ before: RegistrySnapshotEntry; after: RegistrySnapshotEntry }> = [];
    const removedRegistry: RegistrySnapshotEntry[] = [];

    for (const [k, afterEntry] of afterRegMap) {
      if (!beforeRegMap.has(k)) {
        addedRegistry.push(afterEntry);
      } else {
        const beforeEntry = beforeRegMap.get(k)!;
        if (beforeEntry.valueData !== afterEntry.valueData || beforeEntry.valueType !== afterEntry.valueType) {
          modifiedRegistry.push({ before: beforeEntry, after: afterEntry });
        }
      }
    }

    for (const [k, beforeEntry] of beforeRegMap) {
      if (!afterRegMap.has(k)) {
        removedRegistry.push(beforeEntry);
      }
    }

    return {
      snapshotIdBefore: before.id,
      snapshotIdAfter: after.id,
      createdAt: new Date().toISOString(),
      addedFiles,
      modifiedFiles,
      removedFiles,
      addedRegistry,
      modifiedRegistry,
      removedRegistry,
      filteredOut: 0,
    };
  }

  getSnapshot(snapshotId: string): CaptureSnapshot | undefined {
    return this.snapshots.get(snapshotId);
  }

  getDiff(diffId: string): CaptureDiff | undefined {
    return this.diffs.get(diffId);
  }

  async packageDiff(diffId: string, targetDir: string, packageName?: string): Promise<{ packageDir: string; stagingDir: string; filesCopied: number; registryEntries: number }> {
    const diff = this.diffs.get(diffId);
    if (!diff) {
      throw new NotFoundException({ message: `No existe el diff "${diffId}" para empaquetar.` });
    }

    const name = packageName || `capture-${diffId.slice(0, 8)}`;
    // Copiar primero a staging para poder editar antes de finalizar
    const stagingPath = path.join(this.stagingDir, diffId);
    await fs.mkdir(stagingPath, { recursive: true });

    let filesCopied = 0;

    // Copy added and modified files preserving directory structure
    const filesToCopy = [
      ...diff.addedFiles.filter(f => !f.isDir),
      ...diff.modifiedFiles.map(m => m.after).filter(f => !f.isDir),
    ];

    for (const file of filesToCopy) {
      try {
        if (!existsSync(file.path)) continue;
        // Preserve relative path from root
        const parsed = path.parse(file.path);
        let relativePath = file.path;
        if (parsed.root) {
          relativePath = path.relative(parsed.root, file.path).replace(/^[\\/]+/, '');
        }
        if (!relativePath) relativePath = path.basename(file.path);
        const destPath = path.join(stagingPath, relativePath);
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.copyFile(file.path, destPath);
        filesCopied++;
      } catch {}
    }

    const allRegEntries = [
      ...diff.addedRegistry,
      ...diff.modifiedRegistry.map(m => m.after),
    ];

    // Export registry changes as .reg file
    if (allRegEntries.length > 0) {
      const regLines: string[] = ['Windows Registry Editor Version 5.00', ''];
      // Group by key
      const byKey = new Map<string, RegistrySnapshotEntry[]>();
      for (const entry of allRegEntries) {
        if (!byKey.has(entry.key)) byKey.set(entry.key, []);
        byKey.get(entry.key)!.push(entry);
      }
      for (const [key, entries] of byKey) {
        regLines.push(`[${key}]`);
        for (const entry of entries) {
          if (entry.valueName === '(Default)') {
            regLines.push(`@="${String(entry.valueData).replace(/"/g, '\\"')}"`);
          } else {
            if (entry.valueType === 'REG_SZ') {
              regLines.push(`"${entry.valueName}"="${String(entry.valueData).replace(/"/g, '\\"')}"`);
            } else if (entry.valueType === 'REG_DWORD') {
              // Un .reg exige el DWORD en 8 dígitos hexadecimales; `reg query`
              // lo entrega como `0x7`, que regedit rechaza.
              const numeric = Number.parseInt(String(entry.valueData).trim(), 0);
              const hex = Number.isFinite(numeric) ? (numeric >>> 0).toString(16).padStart(8, '0') : '00000000';
              regLines.push(`"${entry.valueName}"=dword:${hex}`);
            } else if (entry.valueType === 'REG_EXPAND_SZ') {
              regLines.push(`"${entry.valueName}"=hex(2):${Buffer.from(String(entry.valueData) + '\0', 'utf16le').toString('hex').match(/.{2}/g)?.join(',') || ''}`);
            } else {
              regLines.push(`"${entry.valueName}"="${String(entry.valueData).replace(/"/g, '\\"')}"`);
            }
          }
        }
        regLines.push('');
      }
      const regPath = path.join(stagingPath, 'registry_changes.reg');
      await writeFileAtomic(regPath, Buffer.from(regLines.join('\r\n'), 'utf16le')).catch(() => undefined);
    }

    // Save diff info and manifest
    const manifest = {
      diffId,
      name,
      createdAt: new Date().toISOString(),
      filesCopied,
      registryEntries: allRegEntries.length,
      stagingPath,
      targetDir: path.join(targetDir, name),
      diff,
    };
    await writeFileAtomic(path.join(stagingPath, 'capture_diff.json'), Buffer.from(JSON.stringify(diff, null, 2), 'utf8')).catch(() => undefined);
    await writeFileAtomic(path.join(stagingPath, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')).catch(() => undefined);

    return { packageDir: path.join(targetDir, name), stagingDir: stagingPath, filesCopied, registryEntries: allRegEntries.length };
  }

  /** Staging inexistente: 404 con el motivo, no un 500 genérico. */
  private stagingPathOrThrow(diffId: string): string {
    const stagingPath = path.join(this.stagingDir, diffId);
    if (!existsSync(stagingPath)) {
      throw new NotFoundException({
        message: `No existe el staging del diff "${diffId}". Ejecuta POST /capture/package para prepararlo.`,
      });
    }
    return stagingPath;
  }

  async listStaging(diffId: string): Promise<{ files: string[]; stagingDir: string }> {
    const stagingPath = this.stagingPathOrThrow(diffId);
    const files: string[] = [];
    const walk = async (dir: string, base: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(base, full);
        if (entry.isDirectory()) {
          await walk(full, base);
        } else {
          files.push(rel);
        }
      }
    };
    await walk(stagingPath, stagingPath);
    return { files, stagingDir: stagingPath };
  }

  async removeFromStaging(diffId: string, relativePath: string): Promise<void> {
    const stagingPath = path.join(this.stagingDir, diffId);
    const target = path.join(stagingPath, relativePath);
    // Security check: un prefijo basta para `staging\abc` pero no para
    // `staging\otro`, así que la comparación exige el separador.
    if (target !== stagingPath && !target.startsWith(stagingPath + path.sep)) {
      throw new BadRequestException({ message: `La ruta "${relativePath}" se sale del staging.` });
    }
    this.stagingPathOrThrow(diffId);
    // `fs.rm` con `force` no falla si el archivo no está: borrar algo que no
    // existe no es un éxito, es un 404.
    if (!existsSync(target)) {
      throw new NotFoundException({
        message: `No existe "${relativePath}" en el staging del diff "${diffId}".`,
      });
    }
    await fs.rm(target, { force: true, recursive: true });
  }

  async cleanStaging(diffId: string): Promise<void> {
    const stagingPath = this.stagingPathOrThrow(diffId);
    await fs.rm(stagingPath, { force: true, recursive: true });
  }

  async finalizePackage(diffId: string, targetDir: string, packageName?: string): Promise<{ packageDir: string }> {
    const diff = this.diffs.get(diffId);
    if (!diff) throw new NotFoundException({ message: `No existe el diff "${diffId}" para finalizar.` });
    const name = packageName || `capture-${diffId.slice(0, 8)}`;
    const stagingPath = this.stagingPathOrThrow(diffId);
    const packageDir = path.join(targetDir, name);
    await fs.mkdir(packageDir, { recursive: true });
    // Copiar todo desde staging a destino final
    await fs.cp(stagingPath, packageDir, { recursive: true, force: true });
    return { packageDir };
  }

  async generateForVMachine(diffId: string, options: {
    pluginName: string;
    uniqueId?: string;
    dllName?: string;
    isSynth?: boolean;
    vendor?: string;
    generateBank?: boolean;
    generateWizard?: boolean;
    outputDir?: string;
  }): Promise<{ bankDir?: string; wizardPath?: string; warnings: string[] }> {
    const diff = this.diffs.get(diffId);
    if (!diff) throw new NotFoundException({ message: `No existe el diff "${diffId}" para v-machine.` });
    const warnings: string[] = [];
    const stagingPath = this.stagingPathOrThrow(diffId);

    const outputDir = options.outputDir || path.join(this.storageDir, 'vmachine');
    await fs.mkdir(outputDir, { recursive: true });

    let bankDir: string | undefined;
    let wizardPath: string | undefined;

    // Archivos que no forman parte del plugin: los metadatos de la captura y el
    // propio .reg, que se copia aparte con el nombre que espera la librería.
    const SKIPPED_STAGING = new Set(['capture_diff.json', 'manifest.json', 'registry_changes.reg']);
    const stagingFiles = await this.listStaging(diffId);
    const payload = stagingFiles.files.filter((file) => !SKIPPED_STAGING.has(file.toLowerCase()));

    // El staging conserva la ruta relativa a la unidad de origen. El paquete se
    // recorta al directorio común para que los archivos queden dentro de
    // `plugs\<Plugin>\` con la estructura de una librería real.
    const baseSegments = commonDirectory(payload);
    const entries = payload.map((file) => ({
      source: file,
      relative: splitRelative(file).slice(baseSegments.length).join('/'),
    }));

    const folderName = safePluginFolderName(options.pluginName);
    const pluginDir = path.join(outputDir, 'plugs', folderName);

    const dllEntries = entries.filter((entry) => entry.relative.toLowerCase().endsWith('.dll'));
    const requestedDll = (options.dllName ?? '').replace(/[\\/]+/g, '/').trim().toLowerCase();
    const primaryDll =
      (requestedDll === ''
        ? undefined
        : dllEntries.find(
            (entry) =>
              path.posix.basename(entry.relative).toLowerCase() === path.posix.basename(requestedDll),
          )) ?? dllEntries[0];
    // `dll_name` es relativo a la carpeta del plugin, igual que en la librería.
    const dllRelative = primaryDll?.relative ?? `${folderName}/${folderName}.dll`;
    const extraDlls = dllEntries
      .filter((entry) => entry !== primaryDll)
      .map((entry) => entry.relative);
    if (primaryDll === undefined) {
      warnings.push(
        'No se encontró ningún DLL en el staging; vfxinfo.txt apunta a un nombre de relleno, revísalo antes de importar.',
      );
    }

    if (options.generateBank !== false) {
      await fs.mkdir(pluginDir, { recursive: true });

      for (const entry of entries) {
        const destination = path.join(pluginDir, ...entry.relative.split('/'));
        try {
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.copyFile(path.join(stagingPath, entry.source), destination);
        } catch (err) {
          warnings.push(`No se pudo copiar ${entry.source}: ${(err as Error).message}`);
        }
      }

      // `presets\` es lo que hace que el plugin aparezca con bancos en el escaneo.
      await fs.mkdir(path.join(pluginDir, 'presets'), { recursive: true });

      // Copiar registro si existe
      const regFile = path.join(stagingPath, 'registry_changes.reg');
      if (existsSync(regFile)) {
        await fs.copyFile(regFile, path.join(pluginDir, 'registry_keys.reg')).catch(() => undefined);
      }

      // `vfxinfo.txt` va en la raíz del plugin y `dll_name` es relativo a esa
      // carpeta: es lo que comprueba `POST /library/scan`.
      const vfxinfoContent = serializeWizardToVfxinfo({
        id: options.uniqueId || randomUUID().replace(/-/g, '').slice(0, 8),
        name: options.pluginName,
        nameAbbreviation: abbreviation(options.pluginName),
        version: '1',
        dllName: dllRelative,
        dllVersion: '',
        isSynth: options.isSynth !== false,
        hasEditor: true,
        parameterCount: 0,
        programCount: 0,
        editorWidth: 0,
        editorHeight: 0,
        vendor: options.vendor || '',
        vendorUrl: '',
        vendorType: 'Commercial',
        genre: options.isSynth !== false ? 'Synth' : 'Effect',
        notes: `Generado desde captura ThinApp - Diff: ${diffId}`,
        vendorNotes: '',
        created: new Date().toISOString().split('T')[0] || '',
        filesToCopy: extraDlls,
        dirsToCopy: [],
        filesToCreate: {},
        symlinks: [],
        registryKeys: '',
        flags: {},
        sourcePath: '',
        readme: null,
      });
      await writeFileAtomic(path.join(pluginDir, 'vfxinfo.txt'), Buffer.from(vfxinfoContent, 'latin1'));

      bankDir = pluginDir;
    }

    if (options.generateWizard !== false) {
      const wizardRecord: WizardRecord = {
        id: options.uniqueId || randomUUID().replace(/-/g, '').slice(0, 8),
        name: options.pluginName,
        nameAbbreviation: abbreviation(options.pluginName),
        version: '1',
        dllName: dllRelative,
        dllVersion: '',
        isSynth: options.isSynth !== false,
        hasEditor: true,
        parameterCount: 0,
        programCount: 0,
        editorWidth: 0,
        editorHeight: 0,
        vendor: options.vendor || '',
        vendorUrl: '',
        vendorType: 'Commercial',
        genre: options.isSynth !== false ? 'Synth' : 'Effect',
        notes: `Generado desde captura ThinApp - Diff: ${diffId}\nArchivos: ${diff.addedFiles.length + diff.modifiedFiles.length}\nRegistro: ${diff.addedRegistry.length + diff.modifiedRegistry.length}`,
        vendorNotes: '',
        created: new Date().toISOString().split('T')[0] || '',
        filesToCopy: extraDlls,
        dirsToCopy: [],
        filesToCreate: {},
        symlinks: [],
        registryKeys: '',
        flags: { generatedFromCapture: 'true', diffId },
        sourcePath: '',
        readme: null,
      };

      // Si hay registro en staging, incluirlo
      const regFile = path.join(stagingPath, 'registry_changes.reg');
      if (existsSync(regFile)) {
        try {
          const regContent = await fs.readFile(regFile, 'utf8');
          // Convertir de UTF-16LE a texto si es necesario
          if (regContent.includes('Windows Registry Editor')) {
            wizardRecord.registryKeys = regContent.replace('Windows Registry Editor Version 5.00\r\n\r\n', '').replace(/Windows Registry Editor Version 5.00\n\n/, '').replace(/\r\n/g, '\n');
          }
        } catch {}
      }

      const wizardContent = serializeWizardToVfxinfo(wizardRecord);
      wizardPath = path.join(outputDir, `${options.pluginName}.vfxwizard`);
      await writeFileAtomic(wizardPath, Buffer.from(wizardContent, 'utf8')).catch(() => undefined);
    }

    return { bankDir, wizardPath, warnings };
  }
}
