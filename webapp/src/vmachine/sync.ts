import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { VFXINFO_FILENAME } from '../library/vfxinfo';
import { countFiles, parseVfxinfoFields } from './inventory';
import {
  VMachineError,
  type VMachineInventoryPlugin,
  type VMachineSyncEntry,
  type VMachineSyncExtra,
  type VMachineSyncPlan,
} from './vmachine.types';

/**
 * Sincronización entre la librería del equipo y el medio de la v-machine.
 *
 * El medio y la librería son dos copias de lo mismo, y ninguna es la fuente de
 * la verdad: aquí solo se comparan. La librería se identifica por carpeta de
 * `plugs\` y su `vfxinfo.txt`; el medio, por lo que devuelve `inventory`. La
 * comparación va por id VST —la clave que no cambia al renombrar— y cae al
 * nombre de carpeta y al nombre declarado, que es lo que hay cuando el vfxinfo
 * no trae id.
 *
 * Nada de esto escribe: el plan se calcula y la copia la decide la vista.
 */

export interface LibraryPlugin {
  folder: string;
  path: string;
  hasVfxinfo: boolean;
  name: string | null;
  id: string | null;
  version: string | null;
  dll: string | null;
  files: number;
  bytes: number;
}

/** Clave de comparación por nombre: sin mayúsculas ni espacios de más. */
function nameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function text(fields: Map<string, string>, key: string): string | null {
  const value = (fields.get(key) ?? '').trim();
  return value === '' ? null : value;
}

/**
 * Plugins que hay en `<librería>\plugs`, por nombre de carpeta. Sin `plugs` la
 * librería no es una librería: se avisa con `plugsMissing` en vez de devolver
 * una lista vacía que parecería un medio sin plugins.
 */
export async function readLibraryPlugins(libraryRoot: string): Promise<LibraryPlugin[]> {
  const plugs = path.join(libraryRoot, 'plugs');
  let entries;
  try {
    entries = await fs.readdir(plugs, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new VMachineError(
        `No existe la carpeta plugs de la librería "${libraryRoot}".`,
        'plugsMissing',
        { 0: libraryRoot },
      );
    }
    throw new VMachineError(
      `No se pudo leer ${plugs}: ${(error as Error).message}`,
    );
  }

  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const plugins: LibraryPlugin[] = [];
  for (const folder of folders) {
    const dir = path.join(plugs, folder);
    let raw: string | null = null;
    try {
      raw = await fs.readFile(path.join(dir, VFXINFO_FILENAME), 'latin1');
    } catch {
      // Un plugin sin vfxinfo sigue estando en la librería: se compara por
      // carpeta y, si el medio tampoco lo tiene, se ofrece copiar igual.
    }
    const fields = raw === null ? new Map<string, string>() : parseVfxinfoFields(raw);
    let counts = { files: 0, bytes: 0 };
    try {
      counts = await countFiles(dir);
    } catch {
      // El recuento es informativo: no impide copiar.
    }
    plugins.push({
      folder,
      path: dir,
      hasVfxinfo: raw !== null,
      name: text(fields, 'name'),
      id: text(fields, 'id'),
      version: text(fields, 'version'),
      dll: text(fields, 'dll_name'),
      files: counts.files,
      bytes: counts.bytes,
    });
  }
  return plugins;
}

/**
 * Compara la librería con lo que hay en el medio. `miss` es lo que solo está en
 * la librería, `differs` lo que está en los dos con otra versión, `same` lo que
 * coincide, y `extra` lo que el medio tiene y la librería no: eso no se toca,
 * porque puede ser un plugin instalado a mano en la máquina.
 */
export function planSync(
  library: LibraryPlugin[],
  stick: VMachineInventoryPlugin[],
): VMachineSyncPlan {
  const byId = new Map<string, VMachineInventoryPlugin>();
  const byFolder = new Map<string, VMachineInventoryPlugin>();
  const byName = new Map<string, VMachineInventoryPlugin>();
  for (const plugin of stick) {
    if (plugin.id !== null && !byId.has(plugin.id)) byId.set(plugin.id, plugin);
    if (!byFolder.has(plugin.folder.toLowerCase())) {
      byFolder.set(plugin.folder.toLowerCase(), plugin);
    }
    if (plugin.name !== null) {
      const key = nameKey(plugin.name);
      if (!byName.has(key)) byName.set(key, plugin);
    }
  }

  const used = new Set<VMachineInventoryPlugin>();
  const entries: VMachineSyncEntry[] = [];
  let missing = 0;
  let differs = 0;
  let same = 0;
  let pendingBytes = 0;

  for (const plugin of library) {
    const found =
      (plugin.id !== null ? byId.get(plugin.id) : undefined) ??
      (plugin.name !== null ? byName.get(nameKey(plugin.name)) : undefined) ??
      byFolder.get(plugin.folder.toLowerCase()) ??
      null;
    if (found !== null) used.add(found);

    // Sin versión en alguno de los dos no hay nada que comparar: se da por
    // buena, igual que hace el inventario con el catálogo.
    const state: VMachineSyncEntry['state'] =
      found === null
        ? 'missing'
        : plugin.version !== null &&
            found.version !== null &&
            plugin.version !== found.version
          ? 'differs'
          : 'same';

    if (state === 'missing') missing += 1;
    else if (state === 'differs') differs += 1;
    else same += 1;
    if (state !== 'same') pendingBytes += plugin.bytes;

    entries.push({
      folder: plugin.folder,
      path: plugin.path,
      name: plugin.name,
      id: plugin.id,
      version: plugin.version,
      files: plugin.files,
      bytes: plugin.bytes,
      stickFolder: found === null ? null : found.folder,
      stickVersion: found === null ? null : found.version,
      state,
    });
  }

  const extra: VMachineSyncExtra[] = stick
    .filter((plugin) => !used.has(plugin))
    .map((plugin) => ({
      library: plugin.library,
      folder: plugin.folder,
      name: plugin.name,
      version: plugin.version,
      bytes: plugin.bytes,
    }));

  return { entries, extra, missing, differs, same, pendingBytes };
}
