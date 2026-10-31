import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  explorerRevealArgs,
  revealInExplorer,
  RevealUnsupportedError,
  type RevealChild,
  type RevealSpawn,
} from '../src/system/reveal';

/**
 * El botón «Abrir» del paso 4 abre el Explorador de Windows con el archivo
 * resaltado. Aquí se fija el comando (`explorer.exe /select,`) y que la promesa
 * no depende de su código de salida —`explorer.exe` termina con 1 aunque haya
 * abierto la ventana—, además del rechazo claro fuera de Windows.
 */

/** `spawn` de mentira: dispara el evento pedido y anota el comando. */
function fakeSpawn(outcome: 'spawn' | 'error'): {
  spawnFn: RevealSpawn;
  calls: { command: string; args: string[] }[];
  unrefs: { count: number };
} {
  const calls: { command: string; args: string[] }[] = [];
  const unrefs = { count: 0 };
  const spawnFn: RevealSpawn = (command, args) => {
    calls.push({ command, args });
    const child = {
      once(event: 'spawn' | 'error', listener: (() => void) | ((error: Error) => void)): unknown {
        queueMicrotask(() => {
          if (event === 'spawn' && outcome === 'spawn') (listener as () => void)();
          if (event === 'error' && outcome === 'error') {
            (listener as (error: Error) => void)(new Error('ENOENT'));
          }
        });
        return child;
      },
      unref(): void {
        unrefs.count += 1;
      },
    };
    return child as unknown as RevealChild;
  };
  return { spawnFn, calls, unrefs };
}

test('el comando selecciona el archivo en su carpeta', () => {
  const target = 'C:\\Program Files\\VstPlugins\\P8.dll';
  assert.deepEqual(explorerRevealArgs(target), ['/select,', target]);
});

test('abre con explorer.exe y no espera su salida', async () => {
  const double = fakeSpawn('spawn');
  await revealInExplorer('C:\\VST\\P8.dll', 'win32', double.spawnFn);

  assert.deepEqual(double.calls, [
    { command: 'explorer.exe', args: ['/select,', 'C:\\VST\\P8.dll'] },
  ]);
  // Se suelta el proceso: el servidor no se queda colgado esperando la ventana.
  assert.equal(double.unrefs.count, 1);
});

test('un Explorador que no arranca rechaza con el motivo', async () => {
  const double = fakeSpawn('error');
  await assert.rejects(
    revealInExplorer('C:\\VST\\P8.dll', 'win32', double.spawnFn),
    /no se pudo abrir el Explorador: ENOENT/,
  );
});

test('fuera de Windows no hay Explorador que abrir', async () => {
  const double = fakeSpawn('spawn');
  await assert.rejects(
    revealInExplorer('/home/tester/P8.dll', 'linux', double.spawnFn),
    (error: unknown) => error instanceof RevealUnsupportedError,
  );
  // Ni siquiera se intenta lanzar el proceso.
  assert.deepEqual(double.calls, []);
});
