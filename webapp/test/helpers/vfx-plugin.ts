import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pe32Dll, pe64Dll } from './pe';

/**
 * Escribe el binario que el `vfxinfo.txt` de un plugin declara en `dll_name`.
 *
 * Los fixtures crean siempre un PE32 real en esa ruta: la instalación rechaza
 * los plugins cuyo `dll_name` apunta a un archivo que no existe, así que un
 * `vfxinfo.txt` sin su DLL ya no sirve como fixture. `bitness: 64` escribe un
 * PE32+ para los tests que esperan un rechazo por arquitectura.
 */
export async function writePluginDll(
  pluginDir: string,
  dllName: string,
  bitness: 32 | 64 = 32,
): Promise<string> {
  const target = path.join(pluginDir, ...dllName.split(/[\\/]+/).filter(Boolean));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bitness === 64 ? pe64Dll() : pe32Dll());
  return target;
}
