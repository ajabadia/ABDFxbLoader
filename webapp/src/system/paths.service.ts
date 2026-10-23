import { promises as fs } from 'node:fs';

/**
 * Comprueba en el disco las rutas que la vista recuerda entre sesiones.
 *
 * La vista guarda las últimas carpetas y archivos usados en `localStorage`, y
 * con el tiempo aparecen entradas que ya no sirven: una carpeta renombrada, un
 * `.fxb` borrado, un DLL desinstalado. El navegador no puede consultarlo, así
 * que pregunta al servidor, que corre en la misma máquina y ve el mismo disco.
 *
 * Una ruta que no existe **no es un error**: es un dato más de la respuesta,
 * para que la vista descarte solo esa sugerencia.
 */

/** Lo que se sabe de una ruta: si está y si es carpeta. */
export interface PathState {
  path: string;
  exists: boolean;
  isDirectory: boolean;
}

/** `fs.stat` inyectable: los tests no necesitan un disco de verdad. */
export type PathStat = (target: string) => Promise<{ isDirectory(): boolean }>;

const nodeStat: PathStat = (target) => fs.stat(target);

export class PathsService {
  constructor(private readonly stat: PathStat = nodeStat) {}

  /** Un estado por ruta, en el mismo orden que la petición. */
  async check(paths: readonly string[]): Promise<PathState[]> {
    return Promise.all(paths.map(async (target) => this.checkOne(target)));
  }

  private async checkOne(target: string): Promise<PathState> {
    try {
      const stats = await this.stat(target);
      return { path: target, exists: true, isDirectory: stats.isDirectory() };
    } catch {
      // Falta o no se puede leer: para la vista es una sugerencia caducada y la
      // descarta. Un permiso denegado no invalida la petición entera.
      return { path: target, exists: false, isDirectory: false };
    }
  }
}
