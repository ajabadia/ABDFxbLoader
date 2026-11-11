/**
 * Utilidades binarias para el formato de archivos `.chunk` de VFX (V-Machine / VFX Application).
 * Implementación desacoplada basada en Web Standards (Uint8Array / DataView) compatible con
 * Node.js y navegadores (Zero-Fork).
 *
 * Verificado mediante ingeniería inversa de `vfx.exe` (`0x4adff0`, `0x4aec50`, `0x438ef0`, `0x438fa0`, `0x439020`).
 */

export const VFX_CHUNK_MAGIC = '!VFXCHUNKMAGIC!\0';
export const VFX_CHUNK_HEADER_SIZE = 100;
export const VFX_CHUNK_VERSION_V4 = 4;
export const VFX_CHUNK_MAX_TOTAL_BYTES = 0xa00000; // 10 MiB

const MAGIC_BYTES = new Uint8Array([
  0x21, 0x56, 0x46, 0x58, 0x43, 0x48, 0x55, 0x4e, 0x4b, 0x4d, 0x41, 0x47, 0x49, 0x43, 0x21, 0x00,
]);

/**
 * Algoritmo CRC-16 de VFX (`vfx.exe` `0x438ef0`, `0x438fa0`).
 * Bit-serial MSB-first sobre el polinomio `0x1021`.
 */
export function vfxCrc16Update(crc: number, data: Uint8Array): number {
  let reg = crc & 0xffff;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]!;
    for (let bit = 0; bit < 8; bit++) {
      const msb = (reg & 0x8000) !== 0;
      reg = ((reg << 1) & 0xffff) | ((byte & (0x80 >> bit)) !== 0 ? 1 : 0);
      if (msb) reg = (reg ^ 0x1021) & 0xffff;
    }
  }
  return reg;
}

/**
 * Finaliza el CRC-16 introduciendo 16 ceros en el registro (`0x439020`).
 */
export function vfxCrc16Finalize(crc: number): number {
  let reg = crc & 0xffff;
  for (let bit = 0; bit < 16; bit++) {
    const msb = (reg & 0x8000) !== 0;
    reg = (reg << 1) & 0xffff;
    if (msb) reg = (reg ^ 0x1021) & 0xffff;
  }
  return reg;
}

export interface VfxChunkHeader {
  magic: string;
  headerChecksum: number;
  overallChecksum: number;
  version: number;
  totalBytes: number;
  vstChunkSize: number;
  parameterDumpSize: number;
  flags: number;
  pluginId: number;
  pluginVersion: number;
  numPrograms: number;
  isValidMagic: boolean;
  isValidHeaderChecksum: boolean;
  isValidOverallChecksum: boolean;
}

export interface VfxChunkParsed extends VfxChunkHeader {
  parameterDump: Float32Array;
  vstChunk: Uint8Array;
}

export interface VfxChunkBuildInput {
  pluginId: number;
  pluginVersion?: number;
  numPrograms?: number;
  parameters?: ArrayLike<number>; // Floats 0.0 .. 1.0
  vstChunk?: Uint8Array;
  version?: number;
  flags?: number;
}

/**
 * Comprueba si los primeros 16 bytes coinciden exactamente con `!VFXCHUNKMAGIC!\0`.
 */
export function hasVfxChunkMagic(data: Uint8Array): boolean {
  if (data.length < 16) return false;
  for (let i = 0; i < 16; i++) {
    if (data[i] !== MAGIC_BYTES[i]) return false;
  }
  return true;
}

/**
 * Parsea e inspecciona la cabecera de 100 bytes de un archivo `.chunk`.
 */
export function parseVfxChunkHeader(data: Uint8Array): VfxChunkHeader | null {
  if (data.length < VFX_CHUNK_HEADER_SIZE) return null;

  const isValidMagic = hasVfxChunkMagic(data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const headerChecksum = view.getUint16(0x10, true);
  const overallChecksum = view.getUint16(0x12, true);
  const version = view.getUint32(0x14, true);
  const totalBytes = view.getUint32(0x18, true);
  const vstChunkSize = view.getUint32(0x1c, true);
  const parameterDumpSize = view.getUint32(0x20, true);
  const flags = view.getUint32(0x24, true);
  const pluginId = view.getInt32(0x28, true);
  const pluginVersion = view.getUint32(0x2c, true);
  const numPrograms = view.getUint32(0x30, true);

  let isValidHeaderChecksum = false;
  let isValidOverallChecksum = false;

  if (isValidMagic && version >= 3) {
    const s1 = vfxCrc16Update(0xffff, data.subarray(0x14, 0x64));
    isValidHeaderChecksum = vfxCrc16Finalize(s1) === headerChecksum;
    const s2 = vfxCrc16Update(s1, data.subarray(0x64));
    isValidOverallChecksum = vfxCrc16Finalize(s2) === overallChecksum;
  } else if (isValidMagic) {
    isValidHeaderChecksum = true;
    isValidOverallChecksum = true;
  }

  const magic = new TextDecoder('latin1').decode(data.subarray(0, 16));

  return {
    magic,
    headerChecksum,
    overallChecksum,
    version,
    totalBytes,
    vstChunkSize,
    parameterDumpSize,
    flags,
    pluginId,
    pluginVersion,
    numPrograms,
    isValidMagic,
    isValidHeaderChecksum,
    isValidOverallChecksum,
  };
}

/**
 * Parsea un archivo `.chunk` completo extrayendo parámetros y chunk VST.
 */
export function parseVfxChunk(data: Uint8Array): VfxChunkParsed | null {
  const header = parseVfxChunkHeader(data);
  if (!header || !header.isValidMagic) return null;

  const paramOffset = VFX_CHUNK_HEADER_SIZE;
  const paramEnd = paramOffset + header.parameterDumpSize;
  const vstOffset = paramEnd;
  const vstEnd = vstOffset + header.vstChunkSize;

  if (data.length < vstEnd) return null;

  const paramBytes = data.subarray(paramOffset, paramEnd);
  const floatCount = Math.floor(header.parameterDumpSize / 4);
  const parameterDump = new Float32Array(floatCount);
  const paramView = new DataView(paramBytes.buffer, paramBytes.byteOffset, paramBytes.byteLength);

  for (let i = 0; i < floatCount; i++) {
    parameterDump[i] = paramView.getFloat32(i * 4, true);
  }

  const vstChunk = data.subarray(vstOffset, vstEnd);

  return {
    ...header,
    parameterDump,
    vstChunk,
  };
}

/**
 * Construye un archivo binario `.chunk` de 100 bytes de cabecera con CRC-16 calculado.
 */
export function buildVfxChunk(input: VfxChunkBuildInput): Uint8Array {
  const params = input.parameters ?? [];
  const paramCount = params.length;
  const paramDumpSize = paramCount * 4;
  const vstChunk = input.vstChunk ?? new Uint8Array(0);
  const vstChunkSize = vstChunk.byteLength;
  const totalBytes = VFX_CHUNK_HEADER_SIZE + paramDumpSize + vstChunkSize;

  const buffer = new Uint8Array(totalBytes);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // 1. Magic
  buffer.set(MAGIC_BYTES, 0);

  // 2. Cabecera (offset 0x14 a 0x64)
  const version = input.version ?? VFX_CHUNK_VERSION_V4;
  view.setUint32(0x14, version, true);
  view.setUint32(0x18, totalBytes, true);
  view.setUint32(0x1c, vstChunkSize, true);
  view.setUint32(0x20, paramDumpSize, true);
  view.setUint32(0x24, input.flags ?? 1, true);
  view.setInt32(0x28, input.pluginId, true);
  view.setUint32(0x2c, input.pluginVersion ?? 1000, true);
  view.setUint32(0x30, input.numPrograms ?? 0, true);
  // 0x34..0x63 ya son 0x00

  // 3. Parameter dump (offset 0x64)
  for (let i = 0; i < paramCount; i++) {
    view.setFloat32(0x64 + i * 4, Number(params[i]), true);
  }

  // 4. VST Chunk
  if (vstChunkSize > 0) {
    buffer.set(vstChunk, 0x64 + paramDumpSize);
  }

  // 5. Calcular checksums CRC-16
  const s1 = vfxCrc16Update(0xffff, buffer.subarray(0x14, 0x64));
  const headerChecksum = vfxCrc16Finalize(s1);
  view.setUint16(0x10, headerChecksum, true);

  const s2 = vfxCrc16Update(s1, buffer.subarray(0x64));
  const overallChecksum = vfxCrc16Finalize(s2);
  view.setUint16(0x12, overallChecksum, true);

  return buffer;
}

/**
 * Parchea el `pluginId` en un `.chunk` existente y recalcula los checksums CRC-16.
 */
export function patchVfxChunkPluginId(data: Uint8Array, newPluginId: number): Uint8Array {
  if (data.length < VFX_CHUNK_HEADER_SIZE || !hasVfxChunkMagic(data)) {
    throw new Error('Buffer no es un archivo .chunk de VFX válido');
  }

  // Copia defensiva
  const buffer = new Uint8Array(data.byteLength);
  buffer.set(data);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Escribir nuevo pluginId en 0x28
  view.setInt32(0x28, newPluginId, true);

  // Recalcular CRC-16
  const s1 = vfxCrc16Update(0xffff, buffer.subarray(0x14, 0x64));
  view.setUint16(0x10, vfxCrc16Finalize(s1), true);

  const s2 = vfxCrc16Update(s1, buffer.subarray(0x64));
  view.setUint16(0x12, vfxCrc16Finalize(s2), true);

  return buffer;
}
