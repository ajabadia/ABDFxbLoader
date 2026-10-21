#!/usr/bin/env node
/**
 * Genera un `.fxb` little-endian a partir de un banco real big-endian,
 * invirtiendo solo los enteros y floats de 32 bits. Nombres, chunks opacos y
 * todo lo que no es un campo numérico quedan byte a byte iguales.
 *
 * Es el orden que escribe un plugin de Windows que guarda su struct nativo sin
 * pasarlo a big-endian, que es el camino que el parser acepta como
 * `endianness: 'little'`. El test
 * `el fixture little-endian es un banco real con los enteros invertidos`
 * recorre ambos archivos y comprueba justo eso.
 *
 *   node test/fixtures/fxb/make-little-endian.mjs \
 *     test/fixtures/fxb/wavosaur-reeq-3set.fxb \
 *     test/fixtures/fxb/wavosaur-reeq-3set-le.fxb
 *
 * Después hay que actualizar `size` y `sha256` en `manifest.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FXB_HEADER = 156;
const FX_BANK_MAGIC = 'FxBk';
const FX_PROGRAM_MAGIC = 'FxCk';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('uso: node make-little-endian.mjs <banco-big-endian.fxb> <salida-little-endian.fxb>');
  process.exit(1);
}

const source = readFileSync(input);
const result = Buffer.from(source);
const magic = source.subarray(0, 4).toString('latin1');
if (magic !== 'CcnK') {
  console.error(`se esperaba un banco big-endian ("CcnK"), llegó "${magic}"`);
  process.exit(1);
}

/** Invierte los 4 bytes del campo y lo devuelve como entero sin signo. */
const swap = (offset) => {
  const [a, b, c, d] = [result[offset], result[offset + 1], result[offset + 2], result[offset + 3]];
  result.set([d, c, b, a], offset);
  return result.readUInt32LE(offset);
};

// Cabecera del banco: chunkMagic, byteSize, fxMagic, version, fxID, fxVersion,
// numPrograms y currentProgram. `future[]` son bytes y no se tocan.
const kind = source.subarray(8, 12).toString('latin1');
for (let offset = 0; offset < 32; offset += 4) swap(offset);

if (kind === FX_BANK_MAGIC) {
  const programs = source.readUInt32BE(24);
  let offset = FXB_HEADER;
  for (let index = 0; index < programs; index += 1) {
    const byteSize = source.readUInt32BE(offset + 4);
    const fxMagic = source.subarray(offset + 8, offset + 12).toString('latin1');
    const numParams = source.readUInt32BE(offset + 24);

    for (let field = 0; field < 7; field += 1) swap(offset + 4 * field);

    if (fxMagic === FX_PROGRAM_MAGIC) {
      // Parámetros sueltos: floats de 4 bytes.
      for (let param = 0; param < numParams; param += 1) swap(offset + 56 + 4 * param);
    } else {
      // Chunk opaco: solo se invierte el int32 con su tamaño.
      swap(offset + 56);
    }
    offset += 8 + byteSize;
  }
  if (offset !== source.length) {
    throw new Error(`quedan ${source.length - offset} bytes sin recorrer`);
  }
} else if (kind === 'FBCh') {
  swap(FXB_HEADER); // tamaño del chunk del banco opaco
} else {
  console.error(`fxMagic "${kind}" no es "FxBk" ni "FBCh"`);
  process.exit(1);
}

writeFileSync(output, result);
console.log(`${output}: ${result.length} bytes, ${kind} little-endian (origen ${input})`);
