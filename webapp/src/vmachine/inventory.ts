import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { VFXINFO_FILENAME } from '../library/vfxinfo';
import type {
  VMachineCatalogEntry,
  VMachineInventoryPlugin,
  WizardLookup,
} from './vmachine.types';

/**
 * Inventario del medio de la v-machine, en modo lectura.
 *
 * El stick no tiene un índice: lo que hay son carpetas `plugs\<Plugin>\` con su
 * `vfxinfo.txt` (manual de operación, §2.14). Aquí se recorre esa estructura tal
 * cual, sin interpretar archivos ajenos, y cada plugin se compara con el
 * catálogo de wizards por id, DLL o nombre exacto: así se sabe qué versión de
 * cada plugin espera la aplicación y si la del medio es la misma o una anterior.
 */

/**
 * Campos de primer nivel de un `vfxinfo.txt`: `clave: valor`. Las listas
 * (`files_to_copy:` … `...`) se ignoran porque no identifican al plugin, y la
 * primera aparición de una clave manda.
 */
export function parseVfxinfoFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line === '...' || line.endsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (key === '' || fields.has(key)) continue;
    fields.set(key, line.slice(colon + 1).trim());
  }
  return fields;
}

/** Archivos y bytes de una carpeta de plugin. Los enlaces no se siguen. */
export async function countFiles(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await countFiles(absolute);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += (await fs.stat(absolute)).size;
    }
  }
  return { files, bytes };
}

/**
 * Compara la versión del medio con la del wizard. Sin versión en alguno de los
 * dos no hay nada que comparar: se da por buena, para no marcar como «distinta»
 * un plugin que simplemente no la declara.
 */
function statusOf(
  version: string | null,
  catalog: VMachineCatalogEntry | null,
): VMachineInventoryPlugin['status'] {
  if (catalog === null) return 'unknown';
  if (version !== null && catalog.version !== '' && version !== catalog.version) return 'differs';
  return 'match';
}

/** Lee un plugin del medio y lo compara con el catálogo. */
export async function readStickPlugin(
  library: string,
  pluginDir: string,
  matchWizard: WizardLookup,
): Promise<{ plugin: VMachineInventoryPlugin; warnings: string[] }> {
  const warnings: string[] = [];

  let raw: string | null = null;
  try {
    // El binario original escribe el vfxinfo en latin1 (manual §3.7.1.7).
    raw = await fs.readFile(path.join(pluginDir, VFXINFO_FILENAME), 'latin1');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(
        `No se pudo leer el vfxinfo de ${path.basename(pluginDir)}: ${(error as Error).message}`,
      );
    }
  }

  const fields = raw === null ? new Map<string, string>() : parseVfxinfoFields(raw);
  const text = (key: string): string | null => {
    const value = (fields.get(key) ?? '').trim();
    return value === '' ? null : value;
  };

  const name = text('name');
  const id = text('id');
  const dll = text('dll_name');
  const version = text('version');

  let counts = { files: 0, bytes: 0 };
  try {
    counts = await countFiles(pluginDir);
  } catch (error) {
    warnings.push(
      `No se pudo contar ${path.basename(pluginDir)}: ${(error as Error).message}`,
    );
  }

  const catalog = matchWizard({
    id: id ?? undefined,
    name: name ?? undefined,
    dllName: dll ?? undefined,
  });

  return {
    plugin: {
      library,
      folder: path.basename(pluginDir),
      path: pluginDir,
      hasVfxinfo: raw !== null,
      name,
      id,
      version,
      dll,
      files: counts.files,
      bytes: counts.bytes,
      catalog,
      status: statusOf(version, catalog),
    },
    warnings,
  };
}
