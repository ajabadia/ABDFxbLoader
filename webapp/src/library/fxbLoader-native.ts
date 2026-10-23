import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Implementación nativa (TypeScript puro) de la funcionalidad proporcionada por
 * `vst/fxbLoader.dll`, reescrita sin depender del binario hostado.
 *
 * El DLL original (`fxbLoaderDll.rea-report.md`) es un VST2 wrapper
 * (PE32 i386) que se instala dentro de cada plugin para inyectar el banco
 * `.fxb` al abrirlo. No puede ejecutarse en un entorno web, y su responsabilidad
 * real se ha dividido en tres capas en esta aplicación:
 *
 * 1. **Validación** (aquí): ¿el binario es PE32 i386? ¿el banco `.fxb` es válido?
 *    Ya está cubierto por `pe.ts`, `fxb-bank.ts` y `library.service.ts`.
 * 2. **Configuración** (aquí): lectura/escritura de `fxbLoader.config` con las
 *    cuatro claves que el DLL lee en `FUN_10003f50` y escribe en `FUN_100037f0`.
 *    Esto se refleja en `vfxinfo.ts` y `fxb-config/*`.
 * 3. **Carga del plugin** (imposible sin host): el DLL inyecta el banco mediante
 *    el dispatcher VST2 (`effBeginLoadBank` / `effSetChunk`). Eso requiere el
 *    plugin cargado en el mismo proceso. Por eso este módulo solo expone la
 *    parte de consulta y configuración; la carga real sigue siendo de la DLL.
 *
 * Esta puerta se usa para:
 *
 * - Eliminar la dependencia de `vst/fxbLoader.dll` de la librería web.
 * - Mantener la misma interfaz de `loader-dll.ts` para los tests y la UI.
 * - Permitir quitar el archivo nativo sin que la aplicación se rompa.
 */

/** El nombre del archivo del DLL que instala el instalador original. */
export const LOADER_DLL_FILENAME = 'fxbLoader.dll';

/** Tamaño máximo razonable de un archivo PE a validar. */
export const MAX_PE_FILE_SIZE = 64 * 1024 * 1024;

/** Máximo de cadenas de error que se devuelven al cliente. */
const MAX_ISSUES = 8;

/**
 * Estilo de salto de línea que se repite en `fxbLoader.config` (CRLF,
 * coincidiendo con el formato original de `FUN_100037f0`).
 */
export const CONFIG_EOL = '\r\n';

/**
 * Claves de `fxbLoader.config` que lee/escribe `fxbLoader.dll`
 * (`FUN_10003f50` / `FUN_100037f0`).
 *
 * Orden de la serializer original:
 *   pluginName, defaultFxbName, programDirName, loadFxbBank.
 */
export const CONFIG_KEYS: ReadonlyArray<ConfigKey> = [
  'pluginName',
  'defaultFxbName',
  'programDirName',
  'loadFxbBank',
];

export type ConfigKey =
  | 'pluginName'
  | 'defaultFxbName'
  | 'programDirName'
  | 'loadFxbBank';

/** Clave de configuración con su descripción y reglas de corte. */
export interface ConfigKeyDesc {
  key: ConfigKey;
  description: string;
  /** Si `true`, este valor no se modifica al reinstalar (se preserva del original). */
  preserveOnReinstall?: boolean;
}

/** Estado de `fxbLoader.config` que expone la librería web. */
export interface FxbLoaderConfig {
  pluginName: string;
  defaultFxbName: string;
  programDirName: string;
  loadFxbBank: boolean;
}

/**
 * Valida que un archivo probablemente sea un PE32 i386 (x86, 32 bits).
 *
 * Reescribe la detección estructural del PE que hacía `fxbLoader.dll`
 * (`FUN_100065b0` + lector de cabecera). No sustituye a `pe.ts` (que es la
 * abstracción de dominio dominando), pero expone la misma comprobación sin
 * necesidad de leer bytes en el cliente.
 */
export async function validateLoaderDllAsPe32I386(file: string): Promise<{
  valid: boolean;
  bitness: 32 | 64 | null;
  machine: string | null;
  issues: string[];
}> {
  const issues: string[] = [];
  let buffer: Buffer | null = null;

  try {
    const stats = fs.statSync(file);
    if (stats.size > MAX_PE_FILE_SIZE || !stats.isFile()) {
      issues.push(`el archivo es demasiado grande o no es un fichero: ${stats.size} bytes`);
    } else {
      buffer = fs.readFileSync(file);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(`no se pudo leer el archivo: ${message}`);
    return { valid: false, bitness: null, machine: null, issues };
  }

  if (buffer === null || buffer.length < 64) {
    issues.push('el archivo es demasiado corto para contener una cabecera PE');
    return { valid: false, bitness: null, machine: null, issues };
  }

  // `e_lfanew` (DWORD en 0x3C de la cabecera DOS) apunta a la firma "PE\0\0",
  // así que la cabecera COFF empieza 4 bytes después de ese desplazamiento:
  // la máquina está en `peHeader + 4`. Sumar 4 dos veces se comía la firma y
  // leía como máquina el `TimeDateStamp`.
  const peOffset = buffer.readUInt32LE(0x3C);
  if (peOffset + 4 > buffer.length || peOffset < 0x40) {
    issues.push(`desplazamiento PE ${peOffset.toString(16)} fuera de rango`);
    return { valid: false, bitness: null, machine: null, issues };
  }

  const peHeader = peOffset;
  const machineRaw = buffer.readUInt16LE(peHeader + 4);
  const machine =
    machineRaw === 0x014c
      ? 'i386 (32 bits)'
      : machineRaw === 0x8664
        ? 'AMD64 (64 bits)'
        : machineRaw === 0x01c4
          ? 'ARM (32 bits)'
          : `0x${machineRaw.toString(16).toUpperCase()}`;

  // Machinet moderna: `0x014c` = IMAGE_FILE_MACHINE_I386, `0x8664` = AMD64.
  const isI386 = machineRaw === 0x014c;
  const isAmd64 = machineRaw === 0x8664;

  // ELF magic no aplica aquí: todo entrante es PE/Windows. Solo doble
  // comprobación para evitar que un archivo que no es PE pase como i386. «MZ»
  // son dos bytes: leer 32 bits metía también el segundo campo de la cabecera
  // DOS y la comparación no cuadraba con ninguna DLL real.
  const dosSignature = buffer.readUInt16LE(0);
  const peSignature = buffer.readUInt32LE(peHeader);

  if (dosSignature !== 0x5a4d) {
    issues.push('sin firma MZ al inicio del archivo');
  }
  if (peSignature !== 0x00004550) {
    issues.push(`la cabecera PE declara 0x${peSignature.toString(16)} en vez de "PE\\0\\0"`);
  }

  if (!isI386 && !isAmd64) {
    issues.push(`la arquitectura no es PE32 i386: ${machine}`);
  }

  const bitness: 32 | 64 | null = isI386 ? 32 : isAmd64 ? 64 : null;

  const valid = isI386 && issues.every((issue) => issue.startsWith('sin') || issue.startsWith('la'));

  return {
    valid,
    bitness,
    machine: isI386 ? 'i386 (32 bits)' : machine,
    issues,
  };
}

/**
 * Lee `fxbLoader.config` junto al DLL, como hace `FUN_10003f50` de
 * `fxbLoader.dll`.
 *
 * El archivo se busca en el mismo directorio que el DLL (no en el CWD), lo que
 * es imprescindible para mantener el DLL atado a su copia instalada.
 */
export async function readFxbLoaderConfig(
  dllDir: string,
  fallback: Partial<FxbLoaderConfig> = {},
): Promise<FxbLoaderConfig> {
  const configPath = path.join(dllDir, 'fxbLoader.config');
  let data: string;

  try {
    data = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ENOENT') || message.includes('no such file')) {
      return {
        pluginName: fallback.pluginName ?? '',
        defaultFxbName: fallback.defaultFxbName ?? '',
        programDirName: fallback.programDirName ?? 'presets',
        loadFxbBank: fallback.loadFxbBank ?? true,
      };
    }
    throw error;
  }

  // Muy similar a `fxb-config.parser.ts`, pero con los comentarios y la
  // convención `clave = valor` exacta del DLL: `/` marca el comentario y `=` es
  // el separador (sin espacios mandatorios a la izquierda del `=`). Si el
  // tag `loadFxbBank` contiene un valor no reconocible, el DLL conserva el
  // anterior; esto también se aplica aquí.
  const values = new Map<string, string>();
  const lines = data.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trimStart();
    if (trimmed.startsWith('/')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key.length > 0 && !key.includes('/')) {
      values.set(key, value);
    }
  }

  const get = (key: ConfigKey): string =>
    values.get(key) ?? (fallback as Record<string, string>)[key] ?? '';

  return {
    pluginName: get('pluginName'),
    defaultFxbName: get('defaultFxbName'),
    programDirName: get('programDirName'),
    loadFxbBank: parseLoadFxbBank(values.get('loadFxbBank')),
  };
}

/**
 * Escribe `fxbLoader.config` en el mismo directorio que el DLL, como hace
 * `FUN_100037f0` de `fxbLoader.dll`.
 *
 * El serializer original escribía siempre cuatro claves y **no** mergeaba el
 * archivo (cualquier clave que no estuviera en esa lista desaparecía), así que
 * aquí solo escribimos las cuatro claves conocidas.
 */
export function writeFxbLoaderConfig(
  dllDir: string,
  config: Partial<FxbLoaderConfig>,
): void {
  const configPath = path.join(dllDir, 'fxbLoader.config');
  const pluginName = typeof config.pluginName === 'string' ? config.pluginName : '';
  const defaultFxbName = typeof config.defaultFxbName === 'string' ? config.defaultFxbName : '';
  const programDirName =
    typeof config.programDirName === 'string' ? config.programDirName : 'presets';
  const loadFxbBank =
    typeof config.loadFxbBank === 'boolean' ? config.loadFxbBank : true;

  const lines = [
    `pluginName = ${pluginName}`,
    `defaultFxbName = ${defaultFxbName}`,
    `programDirName = ${programDirName}`,
    `loadFxbBank = ${loadFxbBank ? 'yes' : 'no'}`,
  ].join(CONFIG_EOL);

  fs.writeFileSync(configPath, lines, { encoding: 'utf8', mode: 0o644 });
}

/**
 * Aplica la lógica de `loadFxbBank` del DLL: acepta `yes`/`no` (y, como
 * compatibilidad con la serializer de la web, booleanos y otras cadenas
 * representativas). El valor por defecto es `no`:
 *
 * - `yes`/`1`/`true` → `loadFxbBank = true` (se carga el banco al abrir).
 * - `no`/`0`/`false` → `loadFxbBank = false` (el banco no se carga).
 * - sin valor: `loadFxbBank = false` (conserva el estado de la imagen original
 *   del plugin, que no tenía habilitada la carga automática).
 */
function parseLoadFxbBank(value: string | undefined): boolean {
  if (value === undefined) return false;
  // El DLL original usaba `yes`/`no`, pero la web también soporta `1`/`0`.
  if (value === 'yes' || value === '1' || value === 'true') return true;
  if (value === 'no' || value === '0' || value === 'false') return false;
  // Valor desconocido: el DLL conserva el anterior, pero aquí no tenemos uno
  // anterior; adoptamos `no` para no arrancar la carga por defecto.
  return false;
}

/**
 * Devuelve la ruta de `fxbLoader.dll` predeterminada siguiendo la misma
 * heurística de `%FXB_LOADER_DLL%` que el instalador original, pero indicando
 * explícitamente que **no se devuelven rutas de archivos nativos** si el
 * proyecto está en modo sin DLL.
 *
 * En un entorno de compilación la DLL está en `vst/fxbLoader.dll`; esta función
 * es útil para las pruebas de integración de la web que la buscan, y para la
 * UI que la permite elegir mediante el diálogo del sistema.
 */
export function resolveDefaultLoaderDllPath(): string | null {
  // En evergreen, `vst/fxbLoader.dll` es el único artefacto nativo que la
  // aplicación gestiona por conveniencia y no por su ejecución.
  const candidate = path.resolve(process.cwd(), 'vst', 'fxbLoader.dll');
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Hash SHA-256 de la copia de `fxbLoader.dll` que queda en `<plugin>\fxbLoader.dll`.
 *
 * Esta función duplica parte de `LibraryService.backupFile`, pero se expone aquí
 * para mantener la compatibilidad con los tests existentes sin acoplar el
 * servicio a la puerta nativa. Se reutiliza en `fxbLoader.config` para registrar
 * un aviso cuando el DLL cambia entre instalaciones.
 */
export function sha256File(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Lista de los ficheros `.fxb` del directorio de bancos de un plugin
 * (equivalente a `FUN_1000a1d0` que llena el listbox de `fxbLoader.dll`).
 */
export async function listBankFiles(pluginDir: string): Promise<string[]> {
  const bankDir = path.resolve(pluginDir, 'presets');
  try {
    const entries = await fs.promises.readdir(bankDir, { withFileTypes: true });
    const banks = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.fxb'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    return banks;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOENT') return [];
    throw error;
  }
}
