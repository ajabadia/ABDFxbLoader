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
 * Analiza las funciones exportadas por un buffer en memoria de un binario PE de Windows (DLL).
 * Opera con tipos estándar Web (`Uint8Array` / `DataView`) sin requerir `node:fs`.
 */
export function inspectPeExportsBuffer(data: Uint8Array): PeExportInspection {
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

  const size = data.length;
  if (size < DOS_HEADER_SIZE) {
    result.issues.push(`Archivo truncado: ${size} bytes`);
    return result;
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  if (data[0] !== 0x4d || data[1] !== 0x5a) {
    result.issues.push('Falta firma MZ de ejecutable MS-DOS / Windows');
    return result;
  }

  const peOffset = view.getUint32(0x3c, true);
  if (peOffset < DOS_HEADER_SIZE || peOffset + COFF_HEADER_AND_OPTIONAL_MAGIC > size) {
    result.issues.push(`Cabecera PE truncada o en offset inválido: 0x${peOffset.toString(16)}`);
    return result;
  }

  if (view.getUint32(peOffset, true) !== PE_SIGNATURE) {
    result.issues.push('Falta la firma PE (PE\\0\\0)');
    return result;
  }

  result.validPe = true;
  const machine = view.getUint16(peOffset + 4, true);
  const numberOfSections = view.getUint16(peOffset + 6, true);
  const sizeOfOptionalHeader = view.getUint16(peOffset + 20, true);

  if (sizeOfOptionalHeader < 2) {
    result.issues.push('El PE no contiene optional header');
    return result;
  }

  const optHeaderOffset = peOffset + 24;
  const magic = view.getUint16(optHeaderOffset, true);
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

  const exportEntryOffset = optHeaderOffset + (result.bitness === 32 ? 96 : 112);
  if (optHeaderOffset + sizeOfOptionalHeader < exportEntryOffset + 8 || exportEntryOffset + 8 > size) {
    result.issues.push('Optional header no declara directorio de exportaciones o binario truncado');
    return result;
  }

  const exportRva = view.getUint32(exportEntryOffset, true);
  const exportSize = view.getUint32(exportEntryOffset + 4, true);

  if (exportRva === 0 || exportSize === 0) {
    result.issues.push('El binario DLL no tiene tabla de exportación (no exporta funciones)');
    return result;
  }

  const sectionsOffset = optHeaderOffset + sizeOfOptionalHeader;
  const sectionsTotalSize = numberOfSections * 40;
  if (sectionsOffset + sectionsTotalSize > size) {
    result.issues.push('Tabla de secciones PE truncada');
    return result;
  }

  const sections: PeSectionHeader[] = [];
  for (let i = 0; i < numberOfSections; i++) {
    const secOffset = sectionsOffset + i * 40;
    let name = '';
    for (let c = 0; c < 8; c++) {
      const code = data[secOffset + c]!;
      if (code === 0) break;
      name += String.fromCharCode(code);
    }
    const virtualSize = view.getUint32(secOffset + 8, true);
    const virtualAddress = view.getUint32(secOffset + 12, true);
    const sizeOfRawData = view.getUint32(secOffset + 16, true);
    const pointerToRawData = view.getUint32(secOffset + 20, true);

    sections.push({
      name,
      virtualSize,
      virtualAddress,
      sizeOfRawData,
      pointerToRawData,
    });
  }

  const exportFileOffset = rvaToFileOffset(exportRva, sections);
  if (exportFileOffset === null || exportFileOffset + 40 > size) {
    result.issues.push('RVA de la tabla de exportación no localizable en las secciones');
    return result;
  }

  const nameRva = view.getUint32(exportFileOffset + 12, true);
  const numberOfNames = view.getUint32(exportFileOffset + 24, true);
  const addressOfNamesRva = view.getUint32(exportFileOffset + 32, true);

  if (nameRva > 0) {
    const nameOffset = rvaToFileOffset(nameRva, sections);
    if (nameOffset !== null && nameOffset < size) {
      let str = '';
      for (let idx = nameOffset; idx < Math.min(size, nameOffset + 128); idx++) {
        if (data[idx] === 0) break;
        str += String.fromCharCode(data[idx]!);
      }
      result.internalDllName = str.trim() || null;
    }
  }

  const namesToRead = Math.min(numberOfNames, 512);
  if (numberOfNames > 0 && addressOfNamesRva > 0) {
    const namesTableOffset = rvaToFileOffset(addressOfNamesRva, sections);
    if (namesTableOffset !== null && namesTableOffset + namesToRead * 4 <= size) {
      for (let i = 0; i < namesToRead; i++) {
        const fnNameRva = view.getUint32(namesTableOffset + i * 4, true);
        const fnNameOffset = rvaToFileOffset(fnNameRva, sections);
        if (fnNameOffset !== null && fnNameOffset < size) {
          let fnName = '';
          for (let idx = fnNameOffset; idx < Math.min(size, fnNameOffset + 64); idx++) {
            if (data[idx] === 0) break;
            fnName += String.fromCharCode(data[idx]!);
          }
          fnName = fnName.trim();
          if (fnName) result.exportedNames.push(fnName);
        }
      }
    }
  }

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
}

/**
 * Lee y analiza las funciones exportadas por un binario PE de Windows (DLL).
 * Permite certificar estáticamente si es un plugin VST2 (`VSTPluginMain` o `main`)
 * y si su arquitectura es 32-bit (compatible con hardware VFX Machine y fxbLoader).
 */
export async function inspectPeExports(file: string): Promise<PeExportInspection> {
  try {
    const stats = await fs.stat(file);
    if (!stats.isFile()) {
      return {
        validPe: false,
        bitness: null,
        is32BitCompatible: false,
        isVstPlugin: false,
        vstEntrypoint: null,
        internalDllName: null,
        exportedNames: [],
        issues: [`No es un archivo regular: ${file}`],
      };
    }
    const buffer = await fs.readFile(file);
    return inspectPeExportsBuffer(buffer);
  } catch (error) {
    return {
      validPe: false,
      bitness: null,
      is32BitCompatible: false,
      isVstPlugin: false,
      vstEntrypoint: null,
      internalDllName: null,
      exportedNames: [],
      issues: [`Error de E/S leyendo archivo PE: ${(error as Error).message}`],
    };
  }
}
