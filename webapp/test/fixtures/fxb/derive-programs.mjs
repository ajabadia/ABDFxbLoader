#!/usr/bin/env node
/**
 * Deriva el bloque `programs` de cada fixture a partir de los bytes del propio
 * `.fxb`, sin creerse el manifiesto.
 *
 * El bloque resume lo que declara el archivo: cuántos programas recorre, cómo se
 * reparten entre `FxCk` (parámetros) y `FPCh` (chunk opaco), el rango de
 * `numParams`/`chunkSize` y la suma de los `byteSize`. Es exactamente lo que
 * `manifest.json` guarda en cada entrada, y el test
 * `el manifiesto coincide con los bloques programs derivados de los .fxb`
 * exige que coincidan; este script es la única vía para escribirlo.
 *
 *   node test/fixtures/fxb/derive-programs.mjs             # imprime los bloques
 *   node test/fixtures/fxb/derive-programs.mjs --check     # falla si se desvían
 *   node test/fixtures/fxb/derive-programs.mjs --write     # reescribe los bloques
 *
 * `--manifest <ruta>` permite trabajar sobre una copia y `--fixtures <dir>`
 * derivar de otro directorio (ambos los usan los tests de mutación y de error).
 * `--write` solo sustituye el valor de `programs` de cada entrada: el resto del
 * archivo queda byte a byte igual, y una entrada ya sincronizada no se toca.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = path.join(DIR, 'manifest.json');

/** `CCONST('C','c','n','K')`. */
const CHUNK_MAGIC = 0x43636e4b;
/** Cabecera del banco: 32 bytes de campos + 124 de `future[]`. */
const FXB_HEADER = 156;
/** `chunkMagic` + `byteSize` que preceden a cada programa. */
const PROGRAM_HEADER = 8;

const EMPTY = {
  count: 0,
  fxck: 0,
  fpch: 0,
  params: null,
  chunkBytes: null,
  byteSizeTotal: 0,
};

function range(values) {
  return values.length === 0
    ? null
    : { min: Math.min(...values), max: Math.max(...values) };
}

/** `params` suma los `numParams` de los `FxCk`, no solo su rango. */
function paramsBlock(params) {
  const bounds = range(params);
  return bounds === null
    ? null
    : { total: params.reduce((total, value) => total + value, 0), ...bounds };
}

/**
 * Recorre el banco leyendo los tamaños que declara cada programa. El orden de
 * bytes lo decide el `chunkMagic`, así que vale también para el fixture
 * little-endian. Lanza si el archivo no se puede recorrer entero: un bloque
 * derivado de un banco truncado no debe acabar en el manifiesto.
 */
export function derivePrograms(data, label = 'banco') {
  if (data.length < FXB_HEADER) {
    throw new Error(`${label}: ${data.length} bytes; un .fxb necesita al menos ${FXB_HEADER}`);
  }

  const little = data.readUInt32LE(0) === CHUNK_MAGIC;
  if (!little && data.readUInt32BE(0) !== CHUNK_MAGIC) {
    throw new Error(`${label}: chunkMagic distinto de "CcnK": no parece un banco VST2`);
  }
  const u32 = (offset) => (little ? data.readUInt32LE(offset) : data.readUInt32BE(offset));
  const magicAt = (offset) => {
    const raw = Buffer.from(data.subarray(offset, offset + 4));
    return (little ? raw.reverse() : raw).toString('latin1');
  };

  const kind = magicAt(8);
  if (kind === 'FBCh') {
    // Un banco opaco guarda un único chunk y no declara programas.
    return { ...EMPTY };
  }
  if (kind !== 'FxBk') {
    throw new Error(`${label}: fxMagic "${kind}" no es "FxBk" ni "FBCh"`);
  }

  const count = u32(24);
  const params = [];
  const chunks = [];
  let byteSizeTotal = 0;
  let offset = FXB_HEADER;

  for (let index = 0; index < count; index += 1) {
    if (offset + PROGRAM_HEADER > data.length) {
      throw new Error(`${label}: programa ${index + 1}: el archivo termina antes de su cabecera`);
    }
    const byteSize = u32(offset + 4);
    if (offset + PROGRAM_HEADER + byteSize > data.length) {
      throw new Error(
        `${label}: programa ${index + 1}: byteSize ${byteSize} se sale del archivo ` +
          `(quedan ${data.length - offset - PROGRAM_HEADER} bytes)`,
      );
    }

    const magic = magicAt(offset + 8);
    byteSizeTotal += byteSize;
    if (magic === 'FxCk') {
      // 6 campos de 4 bytes + nombre de 28 bytes + un float por parámetro.
      params.push(u32(offset + 24));
    } else if (magic === 'FPCh') {
      // 48 bytes de fxProgram + 4 del tamaño del chunk + el chunk opaco.
      chunks.push(u32(offset + 56));
    } else {
      throw new Error(`${label}: programa ${index + 1}: fxMagic "${magic}" no es "FxCk" ni "FPCh"`);
    }

    offset += PROGRAM_HEADER + byteSize;
  }

  if (byteSizeTotal > 0 && offset !== data.length) {
    throw new Error(`${label}: quedan ${data.length - offset} bytes tras los ${count} programas`);
  }
  if (byteSizeTotal === 0 && data.length !== FXB_HEADER) {
    throw new Error(
      `${label}: banco sin programas con ${data.length - FXB_HEADER} bytes tras la cabecera`,
    );
  }

  return {
    count,
    fxck: params.length,
    fpch: chunks.length,
    params: paramsBlock(params),
    chunkBytes: range(chunks),
    byteSizeTotal,
  };
}

/** Bloques derivados de todos los `.fxb` del directorio, ordenados por nombre. */
export function deriveAll(dir = DIR) {
  const files = readdirSync(dir)
    .filter((name) => /\.fxb$/i.test(name))
    .sort();
  const blocks = new Map();
  for (const file of files) {
    blocks.set(file, derivePrograms(readFileSync(path.join(dir, file)), file));
  }
  return blocks;
}

function formatRange(value, fields) {
  if (value === null) return 'null';
  return `{ ${fields.map((field) => `"${field}": ${value[field]}`).join(', ')} }`;
}

/**
 * Formatea el bloque como está en `manifest.json`: una línea cuando no hay
 * programas (los `FBCh`), y una entrada por campo, con los rangos en línea,
 * cuando los hay.
 */
function formatPrograms(programs) {
  const flat =
    `{ "count": ${programs.count}, "fxck": ${programs.fxck}, "fpch": ${programs.fpch}, ` +
    `"params": ${formatRange(programs.params, ['total', 'min', 'max'])}, ` +
    `"chunkBytes": ${formatRange(programs.chunkBytes, ['min', 'max'])}, ` +
    `"byteSizeTotal": ${programs.byteSizeTotal} }`;
  if (programs.params === null && programs.chunkBytes === null) return flat;

  return [
    '{',
    `        "count": ${programs.count},`,
    `        "fxck": ${programs.fxck},`,
    `        "fpch": ${programs.fpch},`,
    `        "params": ${formatRange(programs.params, ['total', 'min', 'max'])},`,
    `        "chunkBytes": ${formatRange(programs.chunkBytes, ['min', 'max'])},`,
    `        "byteSizeTotal": ${programs.byteSizeTotal}`,
    '      }',
  ].join('\n');
}

/** Índice justo después del valor JSON que empieza en `start` (`{` o `[`). */
function jsonValueEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error('manifest.json: valor sin cerrar');
}

/**
 * Devuelve el manifiesto con el bloque `programs` de cada entrada sustituido
 * por el derivado. Solo se reemplaza ese valor: el resto del texto (formato,
 * orden y comentarios, si los hubiera) se conserva tal cual.
 */
export function rewriteManifest(source, blocks) {
  // El manifiesto versionado usa LF, pero un checkout con `autocrlf` puede
  // traerlo en CRLF: se parchea en LF y se devuelve con el fin de línea de
  // origen, para no reescribir el archivo entero por el cambio de formato.
  const crlf = source.includes('\r\n');
  const text = crlf ? source.replace(/\r\n/g, '\n') : source;
  const manifest = JSON.parse(text);
  const patches = [];

  for (const fixture of manifest.fixtures) {
    const block = blocks.get(fixture.file);
    if (block === undefined) {
      throw new Error(`${fixture.file}: está en manifest.json pero no en el directorio`);
    }

    const marker = `"file": ${JSON.stringify(fixture.file)}`;
    const markerAt = text.indexOf(marker);
    if (markerAt === -1) throw new Error(`${fixture.file}: no se encuentra su entrada en el texto`);

    const lineStart = text.lastIndexOf('\n', markerAt) + 1;
    const open = text.lastIndexOf('\n    {\n', lineStart);
    if (open === -1 || open + '\n    {\n'.length !== lineStart) {
      throw new Error(`${fixture.file}: se esperaba la entrada abierta en una línea propia`);
    }
    const close = text.indexOf('\n    }', lineStart);
    if (close === -1) throw new Error(`${fixture.file}: entrada sin cerrar`);

    const key = '\n      "programs": ';
    const keyAt = text.indexOf(key, lineStart);
    if (keyAt === -1 || keyAt > close) {
      throw new Error(`${fixture.file}: entrada sin bloque "programs"`);
    }
    const valueAt = keyAt + key.length;
    if (text[valueAt] !== '{') throw new Error(`${fixture.file}: "programs" no es un objeto`);

    patches.push({
      start: keyAt,
      end: jsonValueEnd(text, valueAt),
      text: key + formatPrograms(block),
    });
  }

  patches.sort((first, second) => second.start - first.start);
  let result = text;
  for (const patch of patches) {
    result = result.slice(0, patch.start) + patch.text + result.slice(patch.end);
  }
  return crlf ? result.replace(/\n/g, '\r\n') : result;
}

/** Diferencias campo a campo entre el bloque del manifiesto y el derivado. */
function describeDifferences(expected, derived) {
  const differences = [];
  const show = (value) => (value === undefined ? 'ausente' : JSON.stringify(value));

  for (const field of Object.keys(derived)) {
    const declared = expected?.[field];
    const actual = derived[field];
    if (field !== 'params' && field !== 'chunkBytes') {
      if (declared !== actual) differences.push(`${field}: manifiesto ${show(declared)}, .fxb ${show(actual)}`);
      continue;
    }
    if (declared === null || actual === null) {
      if (declared !== actual) differences.push(`${field}: manifiesto ${show(declared)}, .fxb ${show(actual)}`);
      continue;
    }
    for (const subfield of new Set([...Object.keys(declared), ...Object.keys(actual)])) {
      if (declared[subfield] !== actual[subfield]) {
        differences.push(
          `${field}.${subfield}: manifiesto ${show(declared[subfield])}, .fxb ${show(actual[subfield])}`,
        );
      }
    }
  }

  for (const field of Object.keys(expected ?? {})) {
    if (!(field in derived)) differences.push(`${field}: manifiesto ${show(expected[field])}, .fxb ausente`);
  }
  return differences;
}

function check(text, blocks) {
  const manifest = JSON.parse(text);
  const problems = [];
  const listed = new Set(manifest.fixtures.map((fixture) => fixture.file));

  for (const [file, block] of blocks) {
    if (!listed.has(file)) {
      problems.push(`${file}: el .fxb no tiene entrada en manifest.json`);
    }
  }
  for (const fixture of manifest.fixtures) {
    const block = blocks.get(fixture.file);
    if (block === undefined) {
      problems.push(`${fixture.file}: está en manifest.json pero no en el directorio`);
      continue;
    }
    for (const difference of describeDifferences(fixture.programs, block)) {
      problems.push(`${fixture.file}: ${difference}`);
    }
  }

  if (problems.length > 0) {
    console.error('manifest.json no coincide con los bytes de los .fxb:');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('\nEjecuta `node test/fixtures/fxb/derive-programs.mjs --write` para regenerarlos.');
    return 1;
  }

  console.log(`manifest.json coincide con los ${blocks.size} .fxb del directorio`);
  return 0;
}

function main(argv) {
  let mode = 'print';
  let manifestPath = DEFAULT_MANIFEST;
  let fixturesDir = DIR;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--write' || argument === '--check') {
      if (mode !== 'print') throw new Error('--write y --check son excluyentes');
      mode = argument.slice(2);
    } else if (argument === '--manifest' || argument === '--fixtures') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined) throw new Error(`${argument} necesita una ruta`);
      if (argument === '--manifest') manifestPath = path.resolve(value);
      else fixturesDir = path.resolve(value);
    } else {
      throw new Error(`argumento desconocido: ${argument}`);
    }
  }

  const blocks = deriveAll(fixturesDir);
  const manifestText = readFileSync(manifestPath, 'utf8');

  if (mode === 'print') {
    console.log(JSON.stringify(Object.fromEntries(blocks), null, 2));
    return 0;
  }
  if (mode === 'check') return check(manifestText, blocks);

  const rewritten = rewriteManifest(manifestText, blocks);
  if (rewritten === manifestText) {
    console.log(`${manifestPath}: ${blocks.size} bloques ya coinciden, sin cambios`);
    return 0;
  }
  writeFileSync(manifestPath, rewritten);
  console.log(`${manifestPath}: bloques "programs" reescritos desde ${blocks.size} .fxb`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
