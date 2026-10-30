import { Injectable, Optional } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { PluginMetaService } from '../plugin-meta/plugin-meta.service';
import type { PluginMetaCommon } from '../plugin-meta/plugin-meta.types';
import { inspectPeExports } from './pe-exports';
import { inspectPeFile } from './pe';
import type {
  LibraryAuditDll,
  LibraryAuditIssue,
  LibraryAuditPlugin,
  LibraryAuditProposal,
  LibraryAuditResult,
} from './library-audit.types';
import { LibraryPathError } from './library.types';
import { readVfxinfo, VFXINFO_FILENAME } from './vfxinfo';

/**
 * Campos de `vfxinfo.txt` que solo se pueden conocer cargando el binario: el
 * análisis estático del DLL no los expone, así que la auditoría los marca como
 * huecos sin proponer un valor inventado.
 */
const RUNTIME_VFXINFO_FIELDS = [
  'is_synth',
  'parameter_count',
  'program_count',
  'has_editor',
  'editor_width',
  'editor_height',
] as const;

/** Pares clave-valor simples del vfxinfo; la primera aparición manda, como el binario. */
function parseVfxinfoFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed === '...') continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    if (!fields.has(key)) fields.set(key, trimmed.slice(colon + 1).trim());
  }
  return fields;
}

async function isFile(candidate: string): Promise<boolean> {
  const stats = await fs.stat(candidate).catch(() => null);
  return stats !== null && stats.isFile();
}

/** Abreviatura de pantalla LCD: la primera palabra útil, en mayúsculas. */
function abbreviationOf(name: string): string {
  const firstWord = name.split(/[^0-9A-Za-z]+/).filter(Boolean)[0] ?? name;
  return firstWord.slice(0, 4).toUpperCase();
}

function toPortable(relative: string): string {
  return relative.split(path.sep).join('/');
}

/**
 * Auditoría de datos en modo lectura: recorre `plugs\*`, lee `vfxinfo.txt` y
 * `fxbLoader.meta.json`, inspecciona el DLL (arquitectura y entrypoint VST) y
 * devuelve, por plugin, qué falta y qué se puede rellenar automáticamente.
 * No escribe nada.
 */
@Injectable()
export class LibraryAuditService {
  constructor(@Optional() private readonly metaService?: PluginMetaService) {}

  async audit(libraryRoot: string): Promise<LibraryAuditResult> {
    const raw = typeof libraryRoot === 'string' ? libraryRoot.trim() : '';
    if (raw === '') throw new LibraryPathError('libraryRoot es obligatorio');
    if (!path.isAbsolute(raw)) {
      throw new LibraryPathError(`libraryRoot debe ser una ruta absoluta: "${libraryRoot}"`);
    }

    const root = path.resolve(raw);
    const plugsPath = path.join(root, 'plugs');
    const stats = await fs.stat(plugsPath).catch(() => null);
    if (stats === null || !stats.isDirectory()) {
      throw new LibraryPathError(`no existe la carpeta plugs\\ en la librería: ${plugsPath}`);
    }

    const entries = await fs.readdir(plugsPath, { withFileTypes: true });
    const plugins: LibraryAuditPlugin[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      plugins.push(await this.auditPlugin(plugsPath, entry.name));
    }
    plugins.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

    const complete = plugins.filter((plugin) =>
      plugin.issues.every((issue) => issue.severity === 'note'),
    ).length;

    return {
      libraryRoot: root,
      plugsPath,
      scannedAt: new Date().toISOString(),
      total: plugins.length,
      complete,
      incomplete: plugins.length - complete,
      issueCount: plugins.reduce((total, plugin) => total + plugin.issues.length, 0),
      proposalCount: plugins.reduce((total, plugin) => total + plugin.proposals.length, 0),
      plugins,
    };
  }

  private async auditPlugin(plugsPath: string, folder: string): Promise<LibraryAuditPlugin> {
    const pluginDir = path.join(plugsPath, folder);
    const issues: LibraryAuditIssue[] = [];
    const proposals: LibraryAuditProposal[] = [];

    const addIssue = (field: string, severity: LibraryAuditIssue['severity'], message: string): void => {
      if (issues.some((issue) => issue.field === field)) return;
      issues.push({ field, severity, message });
    };
    const addProposal = (
      field: string,
      value: string,
      source: LibraryAuditProposal['source'],
      note?: string,
    ): void => {
      const clean = value.trim();
      if (clean === '') return;
      if (proposals.some((proposal) => proposal.field === field)) return;
      proposals.push(note === undefined ? { field, value: clean, source } : { field, value: clean, source, note });
    };

    const rawVfxinfo = await readVfxinfo(path.join(pluginDir, VFXINFO_FILENAME));
    const fields = rawVfxinfo === null ? new Map<string, string>() : parseVfxinfoFields(rawVfxinfo);
    const hasVfxinfo = rawVfxinfo !== null;
    if (!hasVfxinfo) {
      addIssue(
        'vfxinfo',
        'missing',
        `no existe ${VFXINFO_FILENAME}: el host no sabe qué DLL cargar ni con qué identidad`,
      );
    }

    const declared = (fields.get('dll_name') ?? '').trim();
    const resolved = await this.resolveDll(pluginDir, plugsPath, declared);
    const dllRelative = resolved === null ? null : toPortable(path.relative(plugsPath, resolved));
    const dll: LibraryAuditDll = {
      declared: declared === '' ? null : declared,
      resolved: dllRelative,
      bitness: null,
      vstEntrypoint: null,
    };

    if (resolved === null) {
      addIssue('dll', 'invalid', 'no se encuentra ningún DLL dentro del plugin');
    } else {
      const pe = await inspectPeFile(resolved).catch(() => null);
      dll.bitness = pe?.bitness ?? null;
      if (pe !== null && pe.valid && pe.bitness !== null && pe.bitness !== 32) {
        addIssue(
          'dll.bitness',
          'invalid',
          `el DLL es de ${pe.bitness} bits (${pe.machineName ?? 'desconocido'}); VFX requiere PE32 i386`,
        );
      } else if (pe !== null && !pe.valid) {
        addIssue('dll.bitness', 'invalid', `el DLL no tiene cabecera PE válida: ${pe.issues.join('; ')}`);
      }
      const exports = await inspectPeExports(resolved).catch(() => null);
      dll.vstEntrypoint = exports?.vstEntrypoint ?? null;
      if (exports !== null && exports.vstEntrypoint === null) {
        addIssue('dll.vst', 'invalid', 'el DLL no exporta "VSTPluginMain" ni "main"');
      }
    }

    // --- dll_name ---
    if (declared === '') {
      addIssue('vfxinfo.dll_name', 'missing', 'vfxinfo.txt no declara dll_name');
      if (dllRelative !== null) {
        addProposal('vfxinfo.dll_name', dllRelative, 'dll', 'ruta relativa a plugs\\');
      }
    } else if (resolved !== null && dllRelative !== null && !(await this.declaredDllExists(pluginDir, plugsPath, declared))) {
      addIssue(
        'vfxinfo.dll_name',
        'invalid',
        `dll_name apunta a "${declared}", que no existe; el DLL está en "${dllRelative}"`,
      );
      addProposal('vfxinfo.dll_name', dllRelative, 'dll', 'ruta relativa a plugs\\');
    }

    // --- identidad en vfxinfo ---
    const id = (fields.get('id') ?? '').trim();
    const name = (fields.get('name') ?? '').trim();
    const version = (fields.get('version') ?? '').trim();

    const meta = this.metaService === undefined
      ? null
      : await this.metaService.read(pluginDir).catch(() => null);
    const common: PluginMetaCommon | null = meta?.common ?? null;
    const hasMeta = meta?.exists ?? false;

    if (hasVfxinfo) {
      if (id === '') {
        addIssue('vfxinfo.id', 'missing', 'el plugin no declara un ID VST');
        if (common !== null && common.id.trim() !== '') {
          addProposal('vfxinfo.id', common.id, 'meta');
        }
      } else if (!/^\d+$/.test(id)) {
        addIssue('vfxinfo.id', 'invalid', `el ID VST no es numérico: "${id}"`);
      }
      if (name === '') {
        addIssue('vfxinfo.name', 'missing', 'el plugin no declara nombre');
        addProposal('vfxinfo.name', common?.name ?? folder, common?.name ? 'meta' : 'derived');
      }
      if (version === '') {
        addIssue('vfxinfo.version', 'note', 'sin versión declarada; el catálogo asume 1');
        addProposal('vfxinfo.version', '1', 'derived');
      }
      // Solo se propone lo que falta: si el meta ya guarda ese valor, proponerlo
      // otra vez sería ruido en la lista de rellenables.
      if (id !== '' && name !== '') {
        if (!hasMeta || (common !== null && common.id.trim() === '')) {
          addProposal('meta.id', id, 'vfxinfo');
        }
        if (!hasMeta || (common !== null && common.name.trim() === '')) {
          addProposal('meta.name', name, 'vfxinfo');
        }
      }
      for (const field of RUNTIME_VFXINFO_FIELDS) {
        if ((fields.get(field) ?? '').trim() === '') {
          addIssue(
            `vfxinfo.${field}`,
            'missing',
            `falta "${field}"; no se puede leer sin cargar el DLL`,
          );
        }
      }
    } else {
      const metaId = (common?.id ?? '').trim();
      const metaName = (common?.name ?? '').trim();
      addProposal('vfxinfo.id', metaId, 'meta');
      addProposal('vfxinfo.name', metaName || folder, metaName === '' ? 'derived' : 'meta');
    }

    // --- catálogo (fxbLoader.meta.json) ---
    if (!hasMeta) {
      addIssue(
        'meta',
        'missing',
        'no existe fxbLoader.meta.json: el catálogo no tiene fabricante, género ni notas',
      );
    }
    if (common !== null) {
      if (common.vendor.trim() === '') {
        addIssue(
          'meta.vendor',
          'missing',
          'sin fabricante; no se deduce de vfxinfo ni del DLL sin ejecutarlo',
        );
      }
      if (common.vendor_url.trim() === '') {
        addIssue('meta.vendor_url', 'note', 'sin URL del fabricante');
      }
      if (common.genre.trim() === '') {
        const isSynth = (fields.get('is_synth') ?? '').trim();
        if (isSynth === '1' || isSynth === '0') {
          addProposal('meta.genre', isSynth === '1' ? 'Synth' : 'Effect', 'derived', 'deducido de is_synth');
        } else {
          addIssue('meta.genre', 'missing', 'sin género y sin is_synth del que deducirlo');
        }
      }
      if (common.name_abbreviation.trim() === '') {
        addProposal(
          'meta.name_abbreviation',
          abbreviationOf(common.name.trim() || name || folder),
          'derived',
        );
      }
      if (common.notes.trim() === '') {
        addIssue('meta.notes', 'note', 'sin notas de compatibilidad');
      }
    }

    return {
      name: folder,
      path: pluginDir,
      hasVfxinfo,
      hasMeta,
      dll,
      issues,
      proposals,
    };
  }

  /**
   * `dll_name` se resuelve de dos formas en la práctica: relativo a la carpeta
   * del plugin (lo que escribe el alta guiada) y relativo a `plugs\\` (lo que
   * traen las librerías ya montadas, p. ej. `StringSynth/StringSynth.dll`).
   * Ambas son válidas para el host.
   */
  private async declaredDllExists(
    pluginDir: string,
    plugsPath: string,
    declared: string,
  ): Promise<boolean> {
    const normalized = declared.replace(/[\\/]+/g, path.sep);
    if (path.isAbsolute(normalized)) return false;
    for (const base of [pluginDir, plugsPath]) {
      if (await isFile(path.resolve(base, normalized))) return true;
    }
    return false;
  }

  /** Localiza el DLL declarado o, si no aparece, el primero dentro del plugin. */
  private async resolveDll(
    pluginDir: string,
    plugsPath: string,
    declared: string,
  ): Promise<string | null> {
    if (declared !== '') {
      const normalized = declared.replace(/[\\/]+/g, path.sep);
      if (!path.isAbsolute(normalized)) {
        for (const base of [pluginDir, plugsPath]) {
          const candidate = path.resolve(base, normalized);
          if (await isFile(candidate)) return candidate;
        }
      }
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

    for (const directory of entries) {
      if (!directory.isDirectory()) continue;
      const subEntries = await fs
        .readdir(path.join(pluginDir, directory.name), { withFileTypes: true })
        .catch(() => []);
      const nested = subEntries.find(
        (entry) => entry.isFile() && /\.dll$/i.test(entry.name) && !ignored(entry.name),
      );
      if (nested) return path.join(pluginDir, directory.name, nested.name);
    }
    return null;
  }
}
