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

/**
 * Genera un buffer PE sintético con una sección de exportaciones `.rdata`
 * que declara las funciones exportadas por nombre indicadas.
 */
export function peWithExportsDll(
  exportNames: string[],
  options: { bitness?: 32 | 64; internalName?: string } = {},
): Buffer {
  const bitness = options.bitness ?? 32;
  const is64 = bitness === 64;
  const machine = is64 ? 0x8664 : 0x014c;
  const optionalMagic = is64 ? 0x20b : 0x10b;
  const sizeOfOptionalHeader = is64 ? 0xf0 : 0xe0;
  const peOffset = 0x80;

  const totalSize = 0x1000;
  const buffer = Buffer.alloc(totalSize);

  // 1. Cabecera DOS
  buffer.write('MZ', 0, 'latin1');
  buffer.writeUInt32LE(peOffset, 0x3c);

  // 2. Cabecera PE y COFF
  buffer.writeUInt32LE(0x00004550, peOffset); // "PE\0\0"
  buffer.writeUInt16LE(machine, peOffset + 4);
  buffer.writeUInt16LE(1, peOffset + 6); // 1 sección
  buffer.writeUInt16LE(sizeOfOptionalHeader, peOffset + 20);

  // 3. Optional Header
  const optOffset = peOffset + 24;
  buffer.writeUInt16LE(optionalMagic, optOffset);

  // DataDirectory[0] Export Table: offset 96 en PE32, 112 en PE32+
  const exportDirEntryOffset = optOffset + (is64 ? 112 : 96);
  const sectionRva = 0x1000;
  const sectionFileOffset = 0x200;
  buffer.writeUInt32LE(sectionRva, exportDirEntryOffset); // Export RVA
  buffer.writeUInt32LE(0x400, exportDirEntryOffset + 4); // Export Size

  // 4. Section Header (IMAGE_SECTION_HEADER: 40 bytes)
  const secOffset = optOffset + sizeOfOptionalHeader;
  buffer.write('.rdata\0\0', secOffset, 'ascii');
  buffer.writeUInt32LE(0x800, secOffset + 8); // VirtualSize
  buffer.writeUInt32LE(sectionRva, secOffset + 12); // VirtualAddress
  buffer.writeUInt32LE(0x800, secOffset + 16); // SizeOfRawData
  buffer.writeUInt32LE(sectionFileOffset, secOffset + 20); // PointerToRawData

  // 5. IMAGE_EXPORT_DIRECTORY (en sectionFileOffset, correspondiendo a RVA 0x1000)
  const expDirFileOffset = sectionFileOffset;
  const internalNameRva = sectionRva + 0x60;
  const addressOfNamesRva = sectionRva + 0x30;

  buffer.writeUInt32LE(internalNameRva, expDirFileOffset + 12); // Name RVA
  buffer.writeUInt32LE(exportNames.length, expDirFileOffset + 20); // NumberOfFunctions
  buffer.writeUInt32LE(exportNames.length, expDirFileOffset + 24); // NumberOfNames
  buffer.writeUInt32LE(addressOfNamesRva, expDirFileOffset + 32); // AddressOfNames RVA

  // Escribir nombre interno de DLL
  const internalName = options.internalName ?? 'plugin.dll';
  const internalNameFileOffset = sectionFileOffset + 0x60;
  buffer.write(internalName + '\0', internalNameFileOffset, 'ascii');

  // Escribir punteros a nombres y las cadenas de nombres
  const namesPointersFileOffset = sectionFileOffset + 0x30;
  let strFileOffset = sectionFileOffset + 0x100;
  let strRva = sectionRva + 0x100;

  for (let i = 0; i < exportNames.length; i++) {
    const fnName = exportNames[i]!;
    buffer.writeUInt32LE(strRva, namesPointersFileOffset + i * 4);
    buffer.write(fnName + '\0', strFileOffset, 'ascii');
    const bytesWritten = fnName.length + 1;
    strFileOffset += bytesWritten;
    strRva += bytesWritten;
  }

  return buffer;
}

