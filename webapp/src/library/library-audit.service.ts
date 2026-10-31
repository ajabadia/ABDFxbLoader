import { Injectable, Optional } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../common/atomic-file';
import { META_FILENAME } from '../plugin-meta/plugin-meta.constants';
import { PluginMetaService } from '../plugin-meta/plugin-meta.service';
import type { PluginMetaCommon } from '../plugin-meta/plugin-meta.types';
import {
  COMMON_KEYS,
  PluginMetaConflictError,
  PluginMetaInvalidError,
} from '../plugin-meta/plugin-meta.types';
import { cleanNotesForCommon, WizardService } from '../wizard/wizard.service';
import type { WizardRecord } from '../wizard/wizard.types';
import { inspectPeExports } from './pe-exports';
import { inspectPeFile } from './pe';
import type {
  LibraryAuditApplied,
  LibraryAuditApplyResult,
  LibraryAuditApplySkipped,
  LibraryAuditDll,
  LibraryAuditIssue,
  LibraryAuditPlugin,
  LibraryAuditProposal,
  LibraryAuditResult,
} from './library-audit.types';
import {
  LibraryOperationError,
  LibraryPathError,
  PluginNotFoundError,
  PluginStateError,
} from './library.types';
import { readVfxinfo, VFXINFO_FILENAME, writeVfxinfoFields } from './vfxinfo';

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

/**
 * Pares clave-valor del encabezado del vfxinfo; la primera aparición manda,
 * como el binario. Los bloques entre `...` (notas, registro, archivos…) son
 * texto libre: una línea `version:` dentro de las notas no declara el campo.
 */
function parseVfxinfoFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '...') {
      inBlock = !inBlock;
      continue;
    }
    if (inBlock || trimmed === '' || trimmed.startsWith('#')) continue;
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
 * Valor de un campo de ejecución tal como lo escribe `vfxinfo.txt`, tomado del
 * wizard. Los contadores y el tamaño del editor valen `0` cuando el wizard no
 * los declara —el parser no distingue el cero declarado del ausente—, así que
 * no se proponen: escribir un cero inventado es peor que dejarlo como hueco.
 * Los booleanos sí: `0` solo aparece cuando el wizard lo dice expresamente
 * (su valor por defecto es `1`) y `1` es el caso normal de un plugin con editor.
 */
function runtimeVfxinfoValue(wizard: WizardRecord, field: string): string {
  switch (field) {
    case 'is_synth':
      return wizard.isSynth ? '1' : '0';
    case 'has_editor':
      return wizard.hasEditor ? '1' : '0';
    case 'parameter_count':
      return wizard.parameterCount > 0 ? String(wizard.parameterCount) : '';
    case 'program_count':
      return wizard.programCount > 0 ? String(wizard.programCount) : '';
    case 'editor_width':
      return wizard.editorWidth > 0 ? String(wizard.editorWidth) : '';
    case 'editor_height':
      return wizard.editorHeight > 0 ? String(wizard.editorHeight) : '';
    default:
      return '';
  }
}

/**
 * Auditoría de datos en modo lectura: recorre `plugs\*`, lee `vfxinfo.txt` y
 * `fxbLoader.meta.json`, inspecciona el DLL (arquitectura y entrypoint VST) y
 * devuelve, por plugin, qué falta y qué se puede rellenar automáticamente.
 * No escribe nada.
 */
@Injectable()
export class LibraryAuditService {
  constructor(
    @Optional() private readonly metaService?: PluginMetaService,
    @Optional() private readonly wizardService?: WizardService,
  ) {}

  private async resolvePlugs(libraryRoot: string): Promise<{ root: string; plugsPath: string }> {
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
    return { root, plugsPath };
  }

  async audit(libraryRoot: string): Promise<LibraryAuditResult> {
    const { root, plugsPath } = await this.resolvePlugs(libraryRoot);

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

  /**
   * Escribe las propuestas de un plugin. Reaudita antes de tocar nada —nunca
   * se escriben valores enviados por el cliente, solo los que la propia
   * auditoría propone—, respalda cada archivo existente como `*.bak` y deja
   * intacto todo lo que no son los campos pedidos. Un campo que ya tiene ese
   * valor no reescribe el archivo y se informa como omitido.
   */
  async apply(input: {
    libraryRoot: string;
    plugin: string;
    fields?: readonly string[];
  }): Promise<LibraryAuditApplyResult> {
    const { plugsPath } = await this.resolvePlugs(input.libraryRoot);
    const folder = typeof input.plugin === 'string' ? input.plugin.trim() : '';
    if (folder === '' || folder === '.' || folder === '..' || /[\\/]/.test(folder)) {
      throw new LibraryPathError(
        `plugin debe ser el nombre de una carpeta bajo plugs\\: "${String(input.plugin)}"`,
      );
    }

    const pluginDir = path.join(plugsPath, folder);
    const stats = await fs.stat(pluginDir).catch(() => null);
    if (stats === null || !stats.isDirectory()) {
      throw new PluginNotFoundError(`no existe el plugin "${folder}" en ${plugsPath}`);
    }

    const audited = await this.auditPlugin(plugsPath, folder);
    const available = new Map(audited.proposals.map((proposal) => [proposal.field, proposal]));
    const selected: LibraryAuditProposal[] = [];
    const skipped: LibraryAuditApplySkipped[] = [];
    if (input.fields === undefined) {
      selected.push(...audited.proposals);
    } else {
      for (const field of input.fields) {
        const proposal = available.get(field);
        if (proposal === undefined) {
          skipped.push({ field, reason: 'la auditoría no propone un valor para este campo' });
        } else if (!selected.some((item) => item.field === field)) {
          selected.push(proposal);
        }
      }
    }
    for (const proposal of selected) {
      if (!proposal.field.startsWith('vfxinfo.') && !proposal.field.startsWith('meta.')) {
        skipped.push({ field: proposal.field, reason: 'este campo no se escribe en disco' });
      }
    }

    const applied: LibraryAuditApplied[] = [];
    const backups: string[] = [];
    const warnings: string[] = [];
    let vfxinfoPath: string | null = null;
    let metaPath: string | null = null;

    // --- vfxinfo.txt ---
    const vfxinfoUpdates = selected
      .filter((proposal) => proposal.field.startsWith('vfxinfo.'))
      .map((proposal) => ({
        field: proposal.field,
        key: proposal.field.slice('vfxinfo.'.length),
        value: proposal.value,
      }));
    if (vfxinfoUpdates.length > 0) {
      const file = path.join(pluginDir, VFXINFO_FILENAME);
      const current = await readVfxinfo(file);
      if (current === null) {
        for (const update of vfxinfoUpdates) {
          skipped.push({ field: update.field, reason: `no existe ${VFXINFO_FILENAME}` });
        }
        warnings.push(
          `No se creó ${VFXINFO_FILENAME}: créalo desde el frontal o instala el cargador y vuelve a aplicar.`,
        );
      } else {
        const { text, changed } = writeVfxinfoFields(
          current,
          vfxinfoUpdates.map(({ key, value }) => ({ key, value })),
        );
        if (changed.length > 0) {
          await this.backupFile(file, backups);
          await writeFileAtomic(file, Buffer.from(text, 'latin1'));
          vfxinfoPath = file;
        }
        for (const update of vfxinfoUpdates) {
          if (changed.some((key) => key.toLowerCase() === update.key.toLowerCase())) {
            applied.push({ field: update.field, value: update.value });
          } else {
            skipped.push({ field: update.field, reason: 'el valor ya era el vigente' });
          }
        }
      }
    }

    // --- fxbLoader.meta.json ---
    const metaUpdates = selected.filter((proposal) => proposal.field.startsWith('meta.'));
    if (metaUpdates.length > 0 && this.metaService === undefined) {
      for (const update of metaUpdates) {
        skipped.push({ field: update.field, reason: 'el servicio de catálogo no está disponible' });
      }
      warnings.push(`No se pudo escribir ${META_FILENAME}: el servicio de catálogo no está disponible.`);
    } else if (metaUpdates.length > 0) {
      const metaService = this.metaService!;
      const snapshot = await metaService.read(pluginDir).catch((error) => {
        throw new LibraryOperationError(
          `no se pudo leer ${META_FILENAME}: ${(error as Error).message}`,
        );
      });

      const common: Record<string, string> = {};
      for (const update of metaUpdates) {
        const key = update.field.slice('meta.'.length);
        if (!COMMON_KEYS.has(key as keyof PluginMetaCommon)) {
          skipped.push({ field: update.field, reason: 'solo se escriben campos comunes del catálogo' });
          continue;
        }
        // Con el meta ausente, `read` rellena `common` desde el vfxinfo: eso no
        // significa que el archivo ya tenga el valor, así que hay que crearlo.
        if (
          snapshot.exists &&
          (snapshot.common[key as keyof PluginMetaCommon] ?? '') === update.value
        ) {
          skipped.push({ field: update.field, reason: 'el valor ya era el vigente' });
          continue;
        }
        common[key] = update.value;
      }

      if (Object.keys(common).length > 0) {
        await this.backupFile(path.join(pluginDir, META_FILENAME), backups);
        try {
          const written = await metaService.write({
            pluginDir,
            expectedMtimeMs: snapshot.mtimeMs,
            common,
            extended: {},
          });
          metaPath = written.metaPath;
          for (const [key, value] of Object.entries(common)) {
            applied.push({ field: `meta.${key}`, value });
          }
        } catch (error) {
          if (error instanceof PluginMetaConflictError) {
            throw new PluginStateError(
              `${META_FILENAME} cambió en disco mientras se aplicaba; vuelve a auditar y repite.`,
            );
          }
          if (error instanceof PluginMetaInvalidError) {
            throw new LibraryOperationError(error.message);
          }
          throw error;
        }
      }
    }

    return {
      plugin: folder,
      applied,
      skipped,
      vfxinfoPath,
      metaPath,
      backups,
      warnings,
    };
  }

  /** Copia el archivo como `*.bak` antes de tocarlo; se reemplaza en cada aplicación. */
  private async backupFile(file: string, backups: string[]): Promise<void> {
    if (!(await isFile(file))) return;
    const backup = `${file}.bak`;
    await fs.copyFile(file, backup);
    backups.push(backup);
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

    // El catálogo de wizards es la única fuente que declara lo que el análisis
    // estático del DLL no ve: fabricante, URL, notas, versión y los campos de
    // ejecución. Se busca una vez por plugin y solo se usa para lo que falta en
    // disco: un valor ya escrito nunca se pisa con lo que diga el wizard.
    const wizard = this.matchWizard({ id, name: name || folder, dllName: declared });
    const wizardValue = (pick: (record: WizardRecord) => string): string =>
      wizard === null ? '' : pick(wizard).trim();
    const wizardNote = wizard === null ? undefined : `wizard del catálogo: ${wizard.name}`;

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
        const fromWizard = wizardValue((record) => record.version);
        if (fromWizard !== '') {
          addIssue(
            'vfxinfo.version',
            'note',
            `sin versión declarada; el wizard del catálogo trae ${fromWizard}`,
          );
          addProposal('vfxinfo.version', fromWizard, 'wizard', wizardNote);
        } else {
          addIssue('vfxinfo.version', 'note', 'sin versión declarada; el catálogo asume 1');
          addProposal('vfxinfo.version', '1', 'derived');
        }
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
        if ((fields.get(field) ?? '').trim() !== '') continue;
        const fromWizard = wizard === null ? '' : runtimeVfxinfoValue(wizard, field);
        if (fromWizard !== '') {
          addProposal(`vfxinfo.${field}`, fromWizard, 'wizard', wizardNote);
        } else {
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
        const fromWizard = wizardValue((record) => record.vendor);
        if (fromWizard !== '') {
          addProposal('meta.vendor', fromWizard, 'wizard', wizardNote);
        } else {
          addIssue(
            'meta.vendor',
            'missing',
            'sin fabricante; no se deduce de vfxinfo ni del DLL sin ejecutarlo',
          );
        }
      }
      if (common.vendor_url.trim() === '') {
        const fromWizard = wizardValue((record) => record.vendorUrl);
        if (fromWizard !== '') {
          addProposal('meta.vendor_url', fromWizard, 'wizard', wizardNote);
        } else {
          addIssue('meta.vendor_url', 'note', 'sin URL del fabricante');
        }
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
        // Las notas del wizard son texto libre de varias líneas; el campo común
        // del catálogo es una línea corta, así que se limpia como al aplicar un
        // wizard al meta (`cleanNotesForCommon`).
        const fromWizard = wizard === null ? '' : cleanNotesForCommon(wizard.notes);
        if (fromWizard !== '') {
          addProposal('meta.notes', fromWizard, 'wizard', wizardNote);
        } else {
          addIssue('meta.notes', 'note', 'sin notas de compatibilidad');
        }
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
   * Wizard del catálogo que corresponde al plugin, o `null`. Se busca la
   * coincidencia estricta (`matchExact`): la auditoría escribe datos, así que un
   * wizard solo vale si es el mismo plugin por ID, DLL o nombre, no un parecido.
   * Un catálogo sin cargar no puede tumbar la auditoría: sin coincidencia todo
   * sigue igual.
   */
  private matchWizard(query: {
    id: string;
    name: string;
    dllName: string;
  }): WizardRecord | null {
    if (this.wizardService === undefined) return null;
    try {
      return this.wizardService.matchExact(query);
    } catch {
      return null;
    }
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
