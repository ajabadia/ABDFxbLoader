/** Constructor de `.fxb` VST2 válidos para los tests. */

const CHUNK_MAGIC = 0x43636e4b; // 'CcnK'
const FX_BANK_MAGIC = 0x4678426b; // 'FxBk'
const FX_CHUNK_BANK_MAGIC = 0x46424368; // 'FBCh'
const FX_PROGRAM_MAGIC = 0x4678436b; // 'FxCk'

export const FXB_HEADER = 156;

export interface BuildBankOptions {
  /** uniqueID de 4 caracteres. */
  uniqueId?: string;
  fxVersion?: number;
  programs?: number;
  kind?: 'FxBk' | 'FBCh';
  endianness?: 'little' | 'big';
  chunkSize?: number;
  /** El formato de banco admite 1 (clásico) o 2 (con currentProgram). */
  version?: 1 | 2;
  currentProgram?: number;
}

function cconst(text: string): number {
  const codes = [...text].map((character) => character.codePointAt(0) ?? 0);
  return (
    (((codes[0] ?? 0) << 24) |
      ((codes[1] ?? 0) << 16) |
      ((codes[2] ?? 0) << 8) |
      (codes[3] ?? 0)) >>>
    0
  );
}

function writeU32(
  buffer: Buffer,
  offset: number,
  value: number,
  endianness: 'little' | 'big',
): void {
  if (endianness === 'little') buffer.writeUInt32LE(value >>> 0, offset);
  else buffer.writeUInt32BE(value >>> 0, offset);
}

function buildProgram(
  uniqueId: number,
  fxVersion: number,
  index: number,
  endianness: 'little' | 'big',
): Buffer {
  const numParams = 1;
  const byteSize = 48 + 4 * numParams;
  const program = Buffer.alloc(8 + byteSize);
  writeU32(program, 0, CHUNK_MAGIC, endianness);
  writeU32(program, 4, byteSize, endianness);
  writeU32(program, 8, FX_PROGRAM_MAGIC, endianness);
  writeU32(program, 12, 1, endianness);
  writeU32(program, 16, uniqueId, endianness);
  writeU32(program, 20, fxVersion, endianness);
  writeU32(program, 24, numParams, endianness);
  program.write(`Program ${index + 1}`, 28, 'latin1');
  if (endianness === 'little') program.writeFloatLE(0.5, 56);
  else program.writeFloatBE(0.5, 56);
  return program;
}

export function buildBank(options: BuildBankOptions = {}): Buffer {
  const {
    uniqueId = 'MySy',
    fxVersion = 1000,
    programs = 2,
    kind = 'FxBk',
    endianness = 'little',
    chunkSize = 64,
    version = 1,
    currentProgram = 0,
  } = options;

  const idValue = cconst(uniqueId);
  let payload: Buffer;
  if (kind === 'FxBk') {
    payload = Buffer.concat(
      Array.from({ length: programs }, (_, index) =>
        buildProgram(idValue, fxVersion, index, endianness),
      ),
    );
  } else {
    // FBCh: int32 con el tamaño del chunk y después el chunk opaco.
    payload = Buffer.alloc(4 + chunkSize, 0xab);
    writeU32(payload, 0, chunkSize, endianness);
  }

  const total = FXB_HEADER + payload.length;
  const buffer = Buffer.alloc(total);
  writeU32(buffer, 0, CHUNK_MAGIC, endianness);
  writeU32(buffer, 4, total - 8, endianness);
  writeU32(buffer, 8, kind === 'FxBk' ? FX_BANK_MAGIC : FX_CHUNK_BANK_MAGIC, endianness);
  writeU32(buffer, 12, version, endianness);
  writeU32(buffer, 16, idValue, endianness);
  writeU32(buffer, 20, fxVersion, endianness);
  writeU32(buffer, 24, kind === 'FxBk' ? programs : 0, endianness);
  if (version === 2) writeU32(buffer, 28, currentProgram, endianness);
  payload.copy(buffer, FXB_HEADER);
  return buffer;
}
