import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Motivos para omitir las pruebas que dependen de algo que este checkout no
 * siempre trae. Cada una devuelve `false` cuando el entorno puede cumplirla, o
 * el texto que la suite muestra al omitirla: un motivo explícito es mejor que
 * un fallo por un `ENOENT` que no dice qué falta.
 */
export type SkipReason = string | false;

/** Raíz del repo: los tests se compilan a `webapp/dist-test/test/helpers`. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/**
 * Los paquetes de librería reales que usan varias pruebas viven en `_banks/`,
 * que está en `.gitignore` porque pesa demasiado para versionarlo. En CI no
 * existe, así que las pruebas que los leen se omiten en vez de fallar.
 */
export const BANKS_ROOT = path.join(REPO_ROOT, '_banks');

/** Motivo para omitir la prueba, o `false` si `_banks/` (y lo indicado) está. */
export function banksSkipReason(required: readonly string[] = []): SkipReason {
  if (!existsSync(BANKS_ROOT)) {
    return `no existe ${BANKS_ROOT}: \`_banks/\` no se versiona, esta prueba necesita el checkout local`;
  }
  for (const name of required) {
    if (!existsSync(path.join(BANKS_ROOT, name))) return `falta ${name} en ${BANKS_ROOT}`;
  }
  return false;
}

/**
 * La Papelera de reciclaje real es la de Windows: solo ahí existen los índices
 * `$I`/`$R` que estas pruebas leen, y `moveToTrash` usa la papelera del
 * escritorio en Linux/macOS. En Windows hace falta además `powershell.exe`, que
 * es quien mueve el archivo (`SHFileOperation` vía `Microsoft.VisualBasic`).
 */
export function recycleBinSkipReason(): SkipReason {
  if (process.platform !== 'win32') {
    return 'la Papelera de reciclaje real solo existe en Windows';
  }
  const probe = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
    { stdio: 'ignore', timeout: 15_000, windowsHide: true },
  );
  if (probe.error !== undefined || probe.status !== 0) {
    return 'no hay powershell.exe: sin él no se puede usar la Papelera de reciclaje real';
  }
  return false;
}
