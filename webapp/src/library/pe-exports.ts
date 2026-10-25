import { promises as fs } from 'node:fs';
import {
  COFF_HEADER_AND_OPTIONAL_MAGIC,
  DOS_HEADER_SIZE,
  MACHINE_I386,
  OPTIONAL_MAGIC_PE32,
  OPTIONAL_MAGIC_PE32_PLUS,
  PE_SIGNATURE,
  type PeBitness,
} from './pe';

export interface PeSectionHeader {
  name: string;
  virtualSize: number;
  virtualAddress: number;
  sizeOfRawData: number;
  pointerToRawData: number;
}

export interface PeExportInspection {
  validPe: boolean;
  bitness: PeBitness | null;
  is32BitCompatible: boolean;
  isVstPlugin: boolean;
  vstEntrypoint: 'VSTPluginMain' | 'main' | null;
  internalDllName: string | null;
  exportedNames: string[];
  issues: string[];
}

/**
 * Traduce una Relative Virtual Address (RVA) al desplazamiento dentro del archivo binario.
 */
export function rvaToFileOffset(rva: number, sections: readonly PeSectionHeader[]): number | null {
  for (const s of sections) {
    if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.sizeOfRawData)) {
      return rva - s.virtualAddress + s.pointerToRawData;
    }
  }
  return null;
}

/**
 * Lee y analiza las funciones exportadas por un binario PE de Windows (DLL).
 * Permite certificar estáticamente si es un plugin VST2 (`VSTPluginMain` o `main`)
 * y si su arquitectura es 32-bit (compatible con hardware VFX Machine y fxbLoader).
 */
export async function inspectPeExports(file: string): Promise<PeExportInspection> {
  const result: PeExportInspection = {
    validPe: false,
    bitness: null,
    is32BitCompatible: false,
    isVstPlugin: false,
    vstEntrypoint: null,
    internalDllName: null,
    exportedNames: [],
    issues: [],
  };

  let handle: fs.FileHandle | null = null;
  try {
    const stats = await fs.stat(file);
    if (!stats.isFile()) {
      result.issues.push(`No es un archivo regular: ${file}`);
      return result;
    }
    if (stats.size < DOS_HEADER_SIZE) {
      result.issues.push(`Archivo truncado: ${stats.size} bytes`);
      return result;
    }

    handle = await fs.open(file, 'r');
    const dos = Buffer.alloc(DOS_HEADER_SIZE);
    await handle.read(dos, 0, dos.length, 0);

    if (dos[0] !== 0x4d || dos[1] !== 0x5a) {
      result.issues.push('Falta firma MZ de ejecutable MS-DOS / Windows');
      return result;
    }

    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < DOS_HEADER_SIZE || peOffset + COFF_HEADER_AND_OPTIONAL_MAGIC > stats.size) {
      result.issues.push(`Cabecera PE truncada o en offset inválido: 0x${peOffset.toString(16)}`);
      return result;
    }

    // Leemos cabecera PE (firma PE + COFF header + inicio optional header)
    const peHeaderBuf = Buffer.alloc(24);
    await handle.read(peHeaderBuf, 0, peHeaderBuf.length, peOffset);

    if (peHeaderBuf.readUInt32LE(0) !== PE_SIGNATURE) {
      result.issues.push('Falta la firma PE (PE\\0\\0)');
      return result;
    }

    result.validPe = true;
    const machine = peHeaderBuf.readUInt16LE(4);
    const numberOfSections = peHeaderBuf.readUInt16LE(6);
    const sizeOfOptionalHeader = peHeaderBuf.readUInt16LE(20);

    if (sizeOfOptionalHeader < 2) {
      result.issues.push('El PE no contiene optional header');
      return result;
    }

    // Leemos el optional header completo
    const optHeaderBuf = Buffer.alloc(sizeOfOptionalHeader);
    await handle.read(optHeaderBuf, 0, optHeaderBuf.length, peOffset + 24);

    const magic = optHeaderBuf.readUInt16LE(0);
    if (magic === OPTIONAL_MAGIC_PE32) {
      result.bitness = 32;
      result.is32BitCompatible = machine === MACHINE_I386;
    } else if (magic === OPTIONAL_MAGIC_PE32_PLUS) {
      result.bitness = 64;
      result.is32BitCompatible = false;
    } else {
      result.issues.push(`Magic de optional header desconocido: 0x${magic.toString(16)}`);
      return result;
    }

    if (!result.is32BitCompatible) {
      result.issues.push(`Arquitectura no compatible con hardware VFX (detectado ${result.bitness} bits)`);
    }

    // En Optional Header, Data Directory 0 es Export Table:
    // Offset en PE32 = 96 (0x60). Offset en PE32+ = 112 (0x70).
    const exportEntryOffset = result.bitness === 32 ? 96 : 112;
    if (sizeOfOptionalHeader < exportEntryOffset + 8) {
      result.issues.push('Optional header no declara directorio de exportaciones');
      return result;
    }

    const exportRva = optHeaderBuf.readUInt32LE(exportEntryOffset);
    const exportSize = optHeaderBuf.readUInt32LE(exportEntryOffset + 4);

    if (exportRva === 0 || exportSize === 0) {
      // El binario no exporta ninguna función (no es un VST plugin)
      result.issues.push('El binario DLL no tiene tabla de exportación (no exporta funciones)');
      return result;
    }

    // Offset de la tabla de secciones
    const sectionsOffset = peOffset + 24 + sizeOfOptionalHeader;
    const sectionsTotalSize = numberOfSections * 40;
    if (sectionsOffset + sectionsTotalSize > stats.size) {
      result.issues.push('Tabla de secciones PE truncada');
      return result;
    }

    const sectionsBuf = Buffer.alloc(sectionsTotalSize);
    await handle.read(sectionsBuf, 0, sectionsBuf.length, sectionsOffset);

    const sections: PeSectionHeader[] = [];
    for (let i = 0; i < numberOfSections; i++) {
      const secOffset = i * 40;
      const rawName = sectionsBuf.subarray(secOffset, secOffset + 8).toString('ascii');
      const name = rawName.replace(/\0+$/, '');
      const virtualSize = sectionsBuf.readUInt32LE(secOffset + 8);
      const virtualAddress = sectionsBuf.readUInt32LE(secOffset + 12);
      const sizeOfRawData = sectionsBuf.readUInt32LE(secOffset + 16);
      const pointerToRawData = sectionsBuf.readUInt32LE(secOffset + 20);

      sections.push({
        name,
        virtualSize,
        virtualAddress,
        sizeOfRawData,
        pointerToRawData,
      });
    }

    const exportFileOffset = rvaToFileOffset(exportRva, sections);
    if (exportFileOffset === null || exportFileOffset + 40 > stats.size) {
      result.issues.push('RVA de la tabla de exportación no localizable en las secciones');
      return result;
    }

    // Leemos IMAGE_EXPORT_DIRECTORY (40 bytes)
    const exportDirBuf = Buffer.alloc(40);
    await handle.read(exportDirBuf, 0, exportDirBuf.length, exportFileOffset);

    const nameRva = exportDirBuf.readUInt32LE(12);
    const numberOfFunctions = exportDirBuf.readUInt32LE(20);
    const numberOfNames = exportDirBuf.readUInt32LE(24);
    const addressOfNamesRva = exportDirBuf.readUInt32LE(32);

    // Leer nombre interno de la DLL
    if (nameRva > 0) {
      const nameOffset = rvaToFileOffset(nameRva, sections);
      if (nameOffset !== null && nameOffset < stats.size) {
        const nameBuf = Buffer.alloc(Math.min(128, stats.size - nameOffset));
        await handle.read(nameBuf, 0, nameBuf.length, nameOffset);
        const nulIdx = nameBuf.indexOf(0);
        result.internalDllName = (nulIdx >= 0 ? nameBuf.subarray(0, nulIdx) : nameBuf).toString('ascii').trim() || null;
      }
    }

    // Leer nombres exportados (hasta 512 nombres para evitar sobrecargas)
    const namesToRead = Math.min(numberOfNames, 512);
    if (numberOfNames > 0 && addressOfNamesRva > 0) {
      const namesTableOffset = rvaToFileOffset(addressOfNamesRva, sections);
      if (namesTableOffset !== null && namesTableOffset + namesToRead * 4 <= stats.size) {
        const pointersBuf = Buffer.alloc(namesToRead * 4);
        await handle.read(pointersBuf, 0, pointersBuf.length, namesTableOffset);

        for (let i = 0; i < namesToRead; i++) {
          const fnNameRva = pointersBuf.readUInt32LE(i * 4);
          const fnNameOffset = rvaToFileOffset(fnNameRva, sections);
          if (fnNameOffset !== null && fnNameOffset < stats.size) {
            const strBuf = Buffer.alloc(Math.min(64, stats.size - fnNameOffset));
            await handle.read(strBuf, 0, strBuf.length, fnNameOffset);
            const nulIdx = strBuf.indexOf(0);
            const fnName = (nulIdx >= 0 ? strBuf.subarray(0, nulIdx) : strBuf).toString('ascii').trim();
            if (fnName) {
              result.exportedNames.push(fnName);
            }
          }
        }
      }
    }

    // Comprobamos si tiene el punto de entrada VST estándar
    if (result.exportedNames.includes('VSTPluginMain')) {
      result.isVstPlugin = true;
      result.vstEntrypoint = 'VSTPluginMain';
    } else if (result.exportedNames.includes('main') || result.exportedNames.includes('main_plugin')) {
      result.isVstPlugin = true;
      result.vstEntrypoint = 'main';
    } else {
      result.issues.push('No exporta VSTPluginMain ni main (no es un VST2 reconocible)');
    }

    return result;
  } catch (error) {
    result.issues.push(`Error de E/S leyendo archivo PE: ${(error as Error).message}`);
    return result;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
