/**
 * Edición de `vfxinfo.txt` conservando todo lo que no se toca.
 *
 * El binario original lee con `fgets(buf, 0x80, f)`, localiza la primera línea
 * que contiene `dll_name` y la reescribe como
 * `dll_name: <plugin>/fxbLoader.dll\n` (en modo texto: CRLF). Aquí se hace lo
 * mismo pero sin truncar el resto de líneas y conservando sus finales de línea.
 */
import { promises as fs } from 'node:fs';

export const VFXINFO_FILENAME = 'vfxinfo.txt';
/** Respaldo del original que crea el instalador. */
export const VFXINFO_BACKUP_FILENAME = 'vfxinfo.tx_';
/** Nombre que recibe el vfxinfo modificado al desinstalar. */
export const VFXINFO_DISABLED_FILENAME = 'vfxinfo.loader';

export const LOADER_DLL_FILENAME = 'fxbLoader.dll';

interface VfxinfoLine {
  content: string;
  eol: string;
}

function splitLines(text: string): VfxinfoLine[] {
  const lines: VfxinfoLine[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\n') {
      lines.push({ content: text.slice(start, i), eol: '\n' });
      start = i + 1;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        lines.push({ content: text.slice(start, i), eol: '\r\n' });
        i += 1;
      } else {
        lines.push({ content: text.slice(start, i), eol: '\r' });
      }
      start = i + 1;
    }
  }
  if (start < text.length) lines.push({ content: text.slice(start), eol: '' });
  return lines;
}

function joinLines(lines: VfxinfoLine[]): string {
  return lines.map((line) => line.content + line.eol).join('');
}

/** Nombre del DLL a partir del valor de `dll_name` (se acepta `/` y `\`). */
export function dllBasename(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1]?.trim() ?? '';
}

export interface VfxinfoAnalysis {
  /** Índice de la primera línea con `dll_name`. */
  lineIndex: number;
  /** Valor completo tras los dos puntos, recortado. */
  dllNameValue: string;
  /** Último segmento del valor: es el `pluginName` de `fxbLoader.config`. */
  pluginName: string;
  /** Ya apunta al cargador. */
  hasLoader: boolean;
}

/**
 * Devuelve `null` si no hay ninguna línea con `dll_name`, que es el caso en el
 * que el instalador original escribe una configuración vacía y no toca nada.
 */
export function analyzeVfxinfo(text: string): VfxinfoAnalysis | null {
  const lines = splitLines(text);
  const lineIndex = lines.findIndex((line) => line.content.includes('dll_name'));
  if (lineIndex === -1) return null;

  const content = lines[lineIndex]!.content;
  const colon = content.indexOf(':');
  const rawValue = colon === -1 ? content.replace('dll_name', '') : content.slice(colon + 1);
  const dllNameValue = rawValue.trim();
  const pluginName = dllBasename(dllNameValue);

  return {
    lineIndex,
    dllNameValue,
    pluginName,
    hasLoader: pluginName.toLowerCase() === LOADER_DLL_FILENAME.toLowerCase(),
  };
}

export interface VfxinfoPatch {
  text: string;
  analysis: VfxinfoAnalysis;
}

/**
 * Reescribe la línea `dll_name` para que apunte a `<plugin>/fxbLoader.dll`.
 * `plugin` es el nombre de la carpeta tal cual; el original lo copia sin
 * normalizar (`FUN_00405620` solo elimina NULs embebidos).
 */
export function patchVfxinfo(text: string, plugin: string): VfxinfoPatch {
  const analysis = analyzeVfxinfo(text);
  if (analysis === null) {
    throw new Error('vfxinfo.txt no contiene ninguna línea dll_name');
  }

  const lines = splitLines(text);
  const line = lines[analysis.lineIndex]!;
  const eol = line.eol === '' ? '\r\n' : line.eol;
  lines[analysis.lineIndex] = {
    content: `dll_name: ${plugin}/${LOADER_DLL_FILENAME}`,
    eol,
  };

  return { text: joinLines(lines), analysis };
}

export async function readVfxinfo(file: string): Promise<string | null> {
  try {
    // Mismo criterio que el resto del proyecto: latin1 byte a byte.
    return (await fs.readFile(file)).toString('latin1');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw error;
  }
}
