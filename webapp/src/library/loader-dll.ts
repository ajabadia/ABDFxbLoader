import { existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * DLL del cargador que se instala por defecto. La profundidad cambia entre
 * `dist/`, `dist-test/src/` y el árbol de fuentes, así que se prueban las rutas
 * candidatas en vez de fijar un único `../../../`.
 */
export function defaultLoaderDllPath(): string {
  const configured = process.env['FXB_LOADER_DLL'];
  if (configured !== undefined && configured.trim() !== '') return configured;

  const candidates = [
    path.resolve(__dirname, '../../../vst/fxbLoader.dll'), // dist/library
    path.resolve(__dirname, '../../../../vst/fxbLoader.dll'), // dist-test/src/library
    path.resolve(process.cwd(), '../vst/fxbLoader.dll'), // cwd = webapp
    path.resolve(process.cwd(), 'vst/fxbLoader.dll'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
