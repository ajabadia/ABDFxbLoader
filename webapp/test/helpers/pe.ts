/**
 * Cabeceras PE mínimas para tests: no son DLLs ejecutables, solo declaran
 * `MZ`, la firma PE, `Machine` y el magic del optional header.
 */

export interface PeStubOptions {
  bitness?: 32 | 64;
  /** `IMAGE_FILE_HEADER.Machine`; por defecto i386/AMD64 según `bitness`. */
  machine?: number;
  /** `0x10b` (PE32) o `0x20b` (PE32+); por defecto según `bitness`. */
  optionalMagic?: number;
  /** Tamaño total del buffer; debe cubrir la cabecera. */
  size?: number;
  /** Desplazamiento de la firma PE. */
  peOffset?: number;
}

export function peStub(options: PeStubOptions = {}): Buffer {
  const bitness = options.bitness ?? 32;
  const machine = options.machine ?? (bitness === 64 ? 0x8664 : 0x014c);
  const optionalMagic = options.optionalMagic ?? (bitness === 64 ? 0x20b : 0x10b);
  const size = options.size ?? 0x100;
  const peOffset = options.peOffset ?? 0x80;

  const buffer = Buffer.alloc(size);
  buffer.write('MZ', 0, 'latin1');
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.writeUInt32LE(0x00004550, peOffset); // "PE\0\0"
  buffer.writeUInt16LE(machine, peOffset + 4);
  buffer.writeUInt16LE(1, peOffset + 6); // NumberOfSections
  buffer.writeUInt16LE(0xe0, peOffset + 20); // SizeOfOptionalHeader
  buffer.writeUInt16LE(optionalMagic, peOffset + 24);
  return buffer;
}

/** Stub compatible con `fxbLoader.dll`: PE32 i386. */
export function pe32Dll(): Buffer {
  return peStub({ bitness: 32 });
}

/** Stub de un plugin VST2 de 64 bits: PE32+ AMD64. */
export function pe64Dll(): Buffer {
  return peStub({ bitness: 64 });
}
