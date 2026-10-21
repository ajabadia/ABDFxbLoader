#!/usr/bin/env node
/**
 * Ensambla un banco `.fxb` (`FxBk`) a partir de programas `.fxp` **reales** cuyo
 * `fxMagic` sea `FPCh` (chunk opaco por programa).
 *
 * Es lo que hace un host al guardar un banco de un plugin que declara
 * `effFlagsProgramChunks`: copia cada `getChunk()` tal cual dentro de un
 * `fxProgram` `FPCh` y les pone delante la cabecera del banco. Aquí no se toca
 * ni un byte de los programas: solo se comprueba que sus tamaños declarados
 * cuadren y se escribe la cabecera.
 *
 *   node test/fixtures/fxb/make-fpch-bank.mjs \
 *     test/fixtures/fxb/massive-fpch-bank.fxb \
 *     test/fixtures/fxb/massive-init.fxp \
 *     test/fixtures/fxb/massive-test-patch.fxp
 *
 * Después hay que actualizar `size` y `sha256` en `manifest.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const CHUNK_MAGIC = 'CcnK';
const FX_BANK_MAGIC = 'FxBk';
const FX_CHUNK_PROGRAM_MAGIC = 'FPCh';
/** fxProgram sin chunkMagic ni byteSize: 6 campos + nombre de 28 bytes. */
const PROGRAM_MIN_PAYLOAD = 48;
const FXB_HEADER = 156;

const [, , output, ...inputPaths] = process.argv;
if (!output || inputPaths.length === 0) {
  console.error('uso: node make-fpch-bank.mjs <salida.fxb> <programa.fxp> [más programas...]');
  process.exit(1);
}

const programs = inputPaths.map((file) => {
  const data = readFileSync(file);
  const magic = data.subarray(0, 4).toString('latin1');
  const fxMagic = data.subarray(8, 12).toString('latin1');
  const byteSize = data.readUInt32BE(4);
  if (magic !== CHUNK_MAGIC) throw new Error(`${file}: se esperaba "CcnK", llegó "${magic}"`);
  if (fxMagic !== FX_CHUNK_PROGRAM_MAGIC) {
    throw new Error(`${file}: fxMagic "${fxMagic}", se esperaba "FPCh"`);
  }
  const chunkSize = data.readUInt32BE(56);
  if (byteSize !== PROGRAM_MIN_PAYLOAD + 4 + chunkSize) {
    throw new Error(
      `${file}: byteSize ${byteSize} no coincide con 52 + chunk de ${chunkSize} bytes`,
    );
  }
  if (data.length !== 8 + byteSize) {
    throw new Error(`${file}: ${data.length} bytes, se esperaban ${8 + byteSize}`);
  }
  return data;
});

const first = programs[0];
const uniqueId = first.subarray(16, 20);
const fxVersion = first.readUInt32BE(20);
for (const [index, program] of programs.entries()) {
  if (!program.subarray(16, 20).equals(uniqueId)) {
    throw new Error(`programa ${index + 1}: fxID distinto del banco`);
  }
  if (program.readUInt32BE(20) !== fxVersion) {
    throw new Error(`programa ${index + 1}: fxVersion distinta del banco`);
  }
}

const payload = Buffer.concat(programs);
const total = FXB_HEADER + payload.length;
const bank = Buffer.alloc(total);
bank.write(CHUNK_MAGIC, 0, 'latin1');
bank.writeUInt32BE(total - 8, 4); // byteSize de la cabecera de chunk
bank.write(FX_BANK_MAGIC, 8, 'latin1');
bank.writeUInt32BE(1, 12); // versión del formato de banco
uniqueId.copy(bank, 16);
bank.writeUInt32BE(fxVersion, 20);
bank.writeUInt32BE(programs.length, 24);
payload.copy(bank, FXB_HEADER);

writeFileSync(output, bank);
console.log(`${output}: ${bank.length} bytes, FxBk con ${programs.length} programas FPCh`);
