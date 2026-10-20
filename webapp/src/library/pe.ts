import { promises as fs } from 'node:fs';

/**
 * Lectura mínima de la cabecera PE para comprobar arquitectura sin cargar el
 * binario entero. `fxbLoader.dll` es un VST2 de 32 bits (`Intel i386`), así que
 * un plugin de 64 bits no puede cargarlo aunque la instalación de archivos
 * funcione.
 */

export const MACHINE_I386 = 0x014c;
export const MACHINE_AMD64 = 0x8664;
export const MACHINE_ARM = 0x01c0;
export const MACHINE_ARMNT = 0x01c4;
export const MACHINE_ARM64 = 0xaa64;
export const MACHINE_IA64 = 0x0200;

const OPTIONAL_MAGIC_PE32 = 0x10b;
const OPTIONAL_MAGIC_PE32_PLUS = 0x20b;
const DOS_HEADER_SIZE = 64;
const COFF_HEADER_AND_OPTIONAL_MAGIC = 26;
const PE_SIGNATURE = 0x00004550;

const MACHINE_NAMES: Readonly<Record<number, string>> = {
  [MACHINE_I386]: 'i386',
  [MACHINE_AMD64]: 'AMD64',
  [MACHINE_ARM]: 'ARM',
  [MACHINE_ARMNT]: 'ARMNT',
  [MACHINE_ARM64]: 'ARM64',
  [MACHINE_IA64]: 'IA64',
};

export type PeBitness = 32 | 64;

export interface PeInspection {
  /** Cabecera PE completa y con arquitectura reconocible. */
  valid: boolean;
  bitness: PeBitness | null;
  /** `IMAGE_FILE_HEADER.Machine`, en decimal. */
  machine: number | null;
  machineName: string | null;
  /** `0x10b` (PE32) o `0x20b` (PE32+). */
  optionalMagic: number | null;
  issues: string[];
}

function machineName(machine: number): string {
  return MACHINE_NAMES[machine] ?? `0x${machine.toString(16).padStart(4, '0')}`;
}

function failed(issue: string, extras: Partial<PeInspection> = {}): PeInspection {
  return {
    valid: false,
    bitness: null,
    machine: null,
    machineName: null,
    optionalMagic: null,
    issues: [issue],
    ...extras,
  };
}

/** Interpreta las dos cabeceras ya leídas. Exportado para los tests. */
export function parsePeHeaders(dos: Buffer, pe: Buffer): PeInspection {
  if (dos.length < DOS_HEADER_SIZE) {
    return failed(`archivo truncado: ${dos.length} bytes; la cabecera DOS necesita 64`);
  }
  if (dos[0] !== 0x4d || dos[1] !== 0x5a) {
    return failed('no es un archivo PE: falta la firma MZ');
  }

  const peOffset = dos.readUInt32LE(0x3c);
  if (peOffset < DOS_HEADER_SIZE) {
    return failed(`cabecera PE en un desplazamiento no válido: 0x${peOffset.toString(16)}`);
  }
  if (pe.length < COFF_HEADER_AND_OPTIONAL_MAGIC) {
    return failed(`cabecera PE truncada en 0x${peOffset.toString(16)}`);
  }
  if (pe.readUInt32LE(0) !== PE_SIGNATURE) {
    return failed('falta la firma PE (PE\\0\\0)');
  }

  const machine = pe.readUInt16LE(4);
  const optionalHeaderSize = pe.readUInt16LE(20);
  if (optionalHeaderSize < 2) {
    return failed('el PE no declara un optional header utilizable', {
      machine,
      machineName: machineName(machine),
    });
  }

  const optionalMagic = pe.readUInt16LE(24);
  const bitness =
    optionalMagic === OPTIONAL_MAGIC_PE32
      ? 32
      : optionalMagic === OPTIONAL_MAGIC_PE32_PLUS
        ? 64
        : null;

  if (bitness === null) {
    return failed(`optional header desconocido: 0x${optionalMagic.toString(16)}`, {
      machine,
      machineName: machineName(machine),
      optionalMagic,
    });
  }

  const issues: string[] = [];
  if (bitness === 32 && machine === MACHINE_AMD64) {
    issues.push('cabecera incoherente: PE32 con Machine AMD64');
  }
  if (bitness === 64 && (machine === MACHINE_I386 || machine === MACHINE_ARMNT)) {
    issues.push(`cabecera incoherente: PE32+ con Machine ${machineName(machine)}`);
  }

  return {
    valid: issues.length === 0,
    bitness,
    machine,
    machineName: machineName(machine),
    optionalMagic,
    issues,
  };
}

/** Inspecciona un buffer completo (tests y archivos ya cargados). */
export function inspectPeBuffer(buffer: Buffer): PeInspection {
  if (buffer.length < DOS_HEADER_SIZE) {
    return failed(`archivo truncado: ${buffer.length} bytes; la cabecera DOS necesita 64`);
  }
  if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    return failed('no es un archivo PE: falta la firma MZ');
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + COFF_HEADER_AND_OPTIONAL_MAGIC > buffer.length) {
    return failed(`cabecera PE truncada en 0x${peOffset.toString(16)}`);
  }
  return parsePeHeaders(
    buffer.subarray(0, DOS_HEADER_SIZE),
    buffer.subarray(peOffset, peOffset + COFF_HEADER_AND_OPTIONAL_MAGIC),
  );
}

/**
 * Lee solo la cabecera del archivo. Un DLL de plugin puede pesar cientos de
 * MB; nunca se carga entero para esto.
 */
export async function inspectPeFile(file: string): Promise<PeInspection> {
  let handle: fs.FileHandle | null = null;
  try {
    const stats = await fs.stat(file);
    if (!stats.isFile()) return failed(`no es un archivo: ${file}`);
    if (stats.size < DOS_HEADER_SIZE) {
      return failed(`archivo truncado: ${stats.size} bytes; la cabecera DOS necesita 64`);
    }

    handle = await fs.open(file, 'r');
    const dos = Buffer.alloc(DOS_HEADER_SIZE);
    const dosRead = await handle.read(dos, 0, dos.length, 0);
    if (dosRead.bytesRead < DOS_HEADER_SIZE) {
      return failed(`archivo truncado: ${dosRead.bytesRead} bytes; la cabecera DOS necesita 64`);
    }
    if (dos[0] !== 0x4d || dos[1] !== 0x5a) {
      return failed('no es un archivo PE: falta la firma MZ');
    }

    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset + COFF_HEADER_AND_OPTIONAL_MAGIC > stats.size) {
      return failed(`cabecera PE truncada en 0x${peOffset.toString(16)}`);
    }

    const pe = Buffer.alloc(COFF_HEADER_AND_OPTIONAL_MAGIC);
    const peRead = await handle.read(pe, 0, pe.length, peOffset);
    if (peRead.bytesRead < pe.length) {
      return failed(`cabecera PE truncada en 0x${peOffset.toString(16)}`);
    }

    return parsePeHeaders(dos, pe);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return failed(`no existe el archivo: ${file}`);
    return failed(`no se pudo leer ${file}: ${(error as Error).message}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** El único binario que `fxbLoader.dll` puede hospedar: PE32 i386. */
export function isX86Pe32(info: PeInspection): boolean {
  return info.valid && info.bitness === 32 && info.machine === MACHINE_I386;
}

/** Texto corto para mensajes: «PE32+ AMD64 (64 bits)». */
export function describePe(info: PeInspection): string {
  if (info.optionalMagic === OPTIONAL_MAGIC_PE32_PLUS) {
    return `PE32+ ${info.machineName ?? 'desconocido'} (64 bits)`;
  }
  if (info.optionalMagic === OPTIONAL_MAGIC_PE32) {
    return `PE32 ${info.machineName ?? 'desconocido'} (32 bits)`;
  }
  return info.issues[0] ?? 'PE desconocido';
}
