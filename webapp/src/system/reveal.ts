import { spawn } from 'node:child_process';

/**
 * Abre la carpeta del Explorador de Windows con un archivo seleccionado.
 *
 * El navegador no puede lanzar programas del escritorio, así que lo hace el
 * servidor, que corre en la misma máquina (igual que los diálogos nativos de
 * `picker.service.ts`). Se usa `explorer.exe /select,` para que el usuario vea
 * el archivo resaltado entre sus vecinos, no una ventana suelta.
 *
 * `explorer.exe` termina con código 1 aunque haya abierto la ventana, así que
 * no se espera ni se comprueba su salida: la promesa se resuelve en cuanto el
 * proceso arranca.
 */

/** El servidor no corre en Windows: no hay Explorador que abrir. */
export class RevealUnsupportedError extends Error {
  constructor(message = 'Abrir en el Explorador solo está disponible en Windows') {
    super(message);
    this.name = 'RevealUnsupportedError';
  }
}

/** Argumentos de `explorer.exe`: el verbo y la ruta van separados por la coma. */
export function explorerRevealArgs(target: string): string[] {
  // Con la ruta como argumento aparte, Node la entrecomilla si lleva espacios
  // (`C:\Program Files\…`) y el comando sigue siendo válido.
  return ['/select,', target];
}

/** Lo mínimo que se usa del proceso hijo; los tests pasan un doble. */
export interface RevealChild {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  unref?(): void;
}

export type RevealSpawn = (command: string, args: string[]) => RevealChild;

const nodeSpawn: RevealSpawn = (command, args) =>
  spawn(command, args, { detached: true, stdio: 'ignore' });

/** Resuelve cuando el Explorador arranca; rechaza si ni siquiera se lanza. */
export function revealInExplorer(
  target: string,
  platform: NodeJS.Platform = process.platform,
  spawnFn: RevealSpawn = nodeSpawn,
): Promise<void> {
  if (platform !== 'win32') return Promise.reject(new RevealUnsupportedError());

  return new Promise<void>((resolve, reject) => {
    const child = spawnFn('explorer.exe', explorerRevealArgs(target));
    child.once('spawn', () => resolve());
    child.once('error', (error) =>
      reject(new Error(`no se pudo abrir el Explorador: ${error.message}`)),
    );
    // El proceso no se espera: la vista ya tiene su ventana abierta.
    child.unref?.();
  });
}
