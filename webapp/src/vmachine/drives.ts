import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Enumeración de unidades en Windows sin dependencias nativas.
 *
 * Se usa `Get-CimInstance Win32_LogicalDisk`, que ya está en el sistema, por la
 * misma razón que la Papelera y los diálogos nativos: la app se empaqueta como
 * `.exe` y no puede arrastrar módulos que haya que compilar. `DriveType` 2 es
 * un medio extraíble —el stick de la v-machine—; 3 es un disco fijo, que se
 * lista igual porque un disco externo por USB también aparece como fijo.
 */

/** Lo que devuelve la tabla, antes de mirar qué bibliotecas tiene cada raíz. */
export interface RawDrive {
  id: string;
  label: string;
  fileSystem: string;
  totalBytes: number | null;
  freeBytes: number | null;
  removable: boolean;
}

/** Inyectable: en las pruebas no se lanza PowerShell. */
export type DriveRunner = () => Promise<string>;

/**
 * Un shell de Windows atascado no debe colgar la petición: es el mismo tope que
 * usa la Papelera, con la misma salida por timeout.
 */
const DRIVES_TIMEOUT_MS = 10_000;

const DRIVES_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Get-CimInstance Win32_LogicalDisk |',
  '  Select-Object DeviceID, VolumeName, FileSystem, Size, FreeSpace, DriveType |',
  '  ConvertTo-Json -Compress',
].join('\n');

function toBytes(value: unknown): number | null {
  // `ConvertTo-Json` manda los tamaños como número, pero un valor que llega
  // como texto (o ausente) no debe romper la lista entera.
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * Convierte el JSON de PowerShell en unidades. Un solo disco llega como objeto
 * suelto y varios como lista, así que se aceptan las dos formas; las filas sin
 * `DeviceID` se descartan porque sin letra no hay raíz que ofrecer.
 */
export function parseDrives(text: string): RawDrive[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];

  const parsed: unknown = JSON.parse(trimmed);
  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const drives: RawDrive[] = [];

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const id = String(record['DeviceID'] ?? '').trim();
    if (id === '') continue;
    drives.push({
      id,
      label: String(record['VolumeName'] ?? '').trim(),
      fileSystem: String(record['FileSystem'] ?? '').trim(),
      totalBytes: toBytes(record['Size']),
      freeBytes: toBytes(record['FreeSpace']),
      removable: Number(record['DriveType']) === 2,
    });
  }

  // Orden estable: la vista no debe reordenarse entre dos consultas.
  drives.sort((left, right) => left.id.localeCompare(right.id));
  return drives;
}

/** Bibliotecas `*.vfxlibrary` en la raíz de `root`, ordenadas. */
export async function librariesIn(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().endsWith('.vfxlibrary'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

/** Ejecuta la consulta real. Lanza si PowerShell no está o falla. */
export function runPowerShellDrives(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DRIVES_SCRIPT],
      { windowsHide: true },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error(`la consulta de unidades no respondió en ${DRIVES_TIMEOUT_MS} ms`));
    }, DRIVES_TIMEOUT_MS);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`no se pudo consultar las unidades: ${error.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() === ''
              ? `la consulta de unidades terminó con ${String(code)}`
              : `la consulta de unidades terminó con ${String(code)}: ${stderr.trim()}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

/** `E:` → `E:\`, para poder leer la raíz sin depender de la barra final. */
export function driveRoot(id: string): string {
  return path.win32.isAbsolute(id) ? path.win32.normalize(id) : `${id}${path.sep}`;
}
