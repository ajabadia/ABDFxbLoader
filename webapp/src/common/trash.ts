import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

/**
 * Envía un archivo a la papelera del sistema en vez de borrarlo, para que la
 * persona pueda recuperarlo si se arrepiente. En Windows se usa la Papelera de
 * reciclaje real (`SHFileOperation` con `FOF_ALLOWUNDO`, vía
 * `Microsoft.VisualBasic`); en Linux/macOS, la papelera del escritorio (XDG o
 * `~/.Trash`).
 *
 * Windows es la plataforma de la app; el resto existe para que la suite corra
 * en Linux y macOS sin borrar archivos de forma irreversible.
 */

/** De dónde sale el archivo y cómo recuperarlo, para el mensaje de la vista. */
export interface TrashInfo {
  /** Nombre de la papelera en este sistema: «Papelera de reciclaje de Windows», «Papelera». */
  label: string;
  /**
   * Carpeta donde quedó el archivo, o `null` si el sistema no la expone.
   * Windows no da una ruta a su Papelera de reciclaje.
   */
  path: string | null;
  /** Qué hacer para recuperarlo. */
  hint: string;
}

const WINDOWS_TRASH: TrashInfo = {
  label: 'Papelera de reciclaje de Windows',
  path: null,
  hint: 'Abre la Papelera de reciclaje de Windows y pulsa «Restaurar» para devolverlo a su carpeta.',
};

/** Mueve `target` a la Papelera de reciclaje con la API de .NET Framework. */
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName Microsoft.VisualBasic | Out-Null',
  '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(' +
    '$env:FXB_TRASH_PATH, ' +
    '[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, ' +
    '[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)',
].join('\n');

function sendToWindowsRecycleBin(target: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_SCRIPT],
      {
        env: { ...process.env, FXB_TRASH_PATH: target },
        windowsHide: true,
      },
    );

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      reject(new Error(`no se pudo abrir la Papelera de reciclaje: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() === ''
              ? `la Papelera de reciclaje terminó con ${String(code)}`
              : `la Papelera de reciclaje terminó con ${String(code)}: ${stderr.trim()}`,
          ),
        );
        return;
      }
      // Si el archivo sigue ahí, Windows no lo movió: no se finge que sí.
      if (existsSync(target)) {
        reject(new Error(`Windows no movió ${path.basename(target)} a la Papelera de reciclaje`));
        return;
      }
      resolve();
    });
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** `banco.fxb.orig` → `banco.fxb (1).orig` si ya hay uno con ese nombre. */
async function uniqueName(directory: string, name: string, suffix = ''): Promise<string> {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);

  for (let index = 0; ; index += 1) {
    const candidate = index === 0 ? name : `${stem} (${index})${extension}`;
    if (!(await exists(path.join(directory, `${candidate}${suffix}`)))) return candidate;
  }
}

/** `rename` falla con `EXDEV` entre volúmenes; se copia y se borra el origen. */
async function moveFile(target: string, destination: string): Promise<void> {
  try {
    await fs.rename(target, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fs.copyFile(target, destination);
    await fs.rm(target, { force: true });
  }
}

/** `2026-10-21T19:35:02`, la fecha local que pide el formato `.trashinfo`. */
function trashTimestamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** Codificación de `Path=` en `.trashinfo`: cada segmento, no los separadores. */
function encodeTrashPath(target: string): string {
  return target.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

async function sendToLinuxTrash(target: string): Promise<TrashInfo> {
  const dataHome =
    process.env['XDG_DATA_HOME']?.trim() || path.join(homedir(), '.local', 'share');
  const base = path.join(dataHome, 'Trash');
  const files = path.join(base, 'files');
  const info = path.join(base, 'info');
  await fs.mkdir(files, { recursive: true });
  await fs.mkdir(info, { recursive: true });

  const name = await uniqueName(files, path.basename(target), '.trashinfo');
  const destination = path.join(files, name);
  const infoPath = path.join(info, `${name}.trashinfo`);

  await moveFile(target, destination);
  try {
    await fs.writeFile(
      infoPath,
      `[Trash Info]\nPath=${encodeTrashPath(path.resolve(target))}\nDeletionDate=${trashTimestamp()}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch (error) {
    // Sin `.trashinfo` la papelera no sabría restaurarlo: se deshace el traslado.
    await fs.rename(destination, target).catch(() => undefined);
    throw error;
  }

  return {
    label: 'Papelera',
    path: files,
    hint: `Puedes recuperarlo desde la papelera del escritorio; el archivo está en ${destination}.`,
  };
}

async function sendToMacTrash(target: string): Promise<TrashInfo> {
  const trashDir = path.join(homedir(), '.Trash');
  await fs.mkdir(trashDir, { recursive: true });
  const name = await uniqueName(trashDir, path.basename(target));
  await moveFile(target, path.join(trashDir, name));

  return {
    label: 'Papelera',
    path: trashDir,
    hint: 'Abre la Papelera del Finder y elige «Volver a poner» para devolverlo a su carpeta.',
  };
}

/**
 * Mueve `target` a la papelera y describe dónde quedó. Lanza si no se pudo
 * mover; quien llama decide cómo contarlo y deja el archivo intacto.
 */
export async function moveToTrash(
  target: string,
  platform: NodeJS.Platform = process.platform,
): Promise<TrashInfo> {
  if (platform === 'win32') {
    await sendToWindowsRecycleBin(target);
    return WINDOWS_TRASH;
  }
  if (platform === 'darwin') return await sendToMacTrash(target);
  return await sendToLinuxTrash(target);
}
