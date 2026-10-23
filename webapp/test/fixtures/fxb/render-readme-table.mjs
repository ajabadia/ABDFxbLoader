#!/usr/bin/env node
/**
 * Genera la tabla de fixtures de `README.md` desde `manifest.json` y los bytes
 * reales de cada `.fxb`. El tamaño de la celda «Bytes» no se escribe a mano:
 * sale del propio archivo, y el script falla si el manifiesto declara otro o si
 * un `.fxb` no tiene entrada.
 *
 * La tabla vive entre los marcadores `fixtures:tabla:inicio` y
 * `fixtures:tabla:fin`; el resto del README no se toca. Los campos editoriales
 * (plugin y propósito) salen del manifiesto, y el formato y el tamaño, de la
 * cabecera y los bytes reales de cada `.fxb`.
 *
 *   node test/fixtures/fxb/render-readme-table.mjs           # imprime la tabla
 *   node test/fixtures/fxb/render-readme-table.mjs --check   # falla si se desvía
 *   node test/fixtures/fxb/render-readme-table.mjs --write   # regenera la tabla
 *
 * `--readme`, `--manifest` y `--fixtures` permiten trabajar sobre copias (los
 * usan los tests de mutación y de error).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = path.join(DIR, 'manifest.json');
const DEFAULT_README = path.join(DIR, 'README.md');

const START = '<!-- fixtures:tabla:inicio -->';
const END = '<!-- fixtures:tabla:fin -->';

/** `CCONST('C','c','n','K')`: primer campo de la cabecera del banco. */
const CHUNK_MAGIC = 0x43636e4b;
/** `CCONST('F','x','B','k')` y `CCONST('F','B','C','h')`. */
const FX_BANK_MAGIC = 0x4678426b;
const FX_CHUNK_BANK_MAGIC = 0x46424368;
/** Cabecera del banco: 32 bytes de campos + 124 de `future[]`. */
const FXB_HEADER = 156;

/** Agrupa los miles con un espacio: 86357 → 86 357. */
function formatSize(size) {
  return String(size).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Una celda de Markdown: sin saltos de línea y con las barras escapadas. */
function cell(text) {
  return String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/**
 * Cabecera mínima para documentar el formato: orden de bytes por `chunkMagic`,
 * `fxMagic` en el byte 8 y versión en el 12. Un banco truncado o con otro
 * `fxMagic` falla en vez de publicar una fila inventada.
 */
function readBank(file) {
  const data = readFileSync(file);
  if (data.length < FXB_HEADER) {
    throw new Error(
      `${path.basename(file)}: ${data.length} bytes; un .fxb necesita al menos ${FXB_HEADER}`,
    );
  }

  let endianness;
  if (data.readUInt32LE(0) === CHUNK_MAGIC) endianness = 'little';
  else if (data.readUInt32BE(0) === CHUNK_MAGIC) endianness = 'big';
  if (endianness === undefined) {
    throw new Error(`${path.basename(file)}: chunkMagic distinto de "CcnK"`);
  }

  const u32 = (offset) =>
    endianness === 'little' ? data.readUInt32LE(offset) : data.readUInt32BE(offset);
  const magic = u32(8);
  const kind = magic === FX_BANK_MAGIC ? 'FxBk' : magic === FX_CHUNK_BANK_MAGIC ? 'FBCh' : null;
  if (kind === null) {
    throw new Error(`${path.basename(file)}: fxMagic 0x${magic.toString(16)} no es FxBk ni FBCh`);
  }

  return { size: data.length, kind, endianness, version: u32(12) };
}

/** Filas de la tabla, en el orden del manifiesto. */
export function renderTable(manifest, banks) {
  if (!Array.isArray(manifest.fixtures)) {
    throw new Error('manifest.json: falta la lista "fixtures"');
  }

  const listed = new Set();
  const rows = manifest.fixtures.map((fixture) => {
    if (typeof fixture.file !== 'string' || fixture.file === '') {
      throw new Error('manifest.json: hay una entrada sin "file"');
    }
    if (listed.has(fixture.file)) {
      throw new Error(`${fixture.file}: entrada repetida en manifest.json`);
    }
    listed.add(fixture.file);

    const bank = banks.get(fixture.file);
    if (bank === undefined) {
      throw new Error(`${fixture.file}: está en manifest.json pero no hay ningún .fxb con ese nombre`);
    }
    if (fixture.size !== undefined && fixture.size !== bank.size) {
      throw new Error(
        `${fixture.file}: manifest.json declara ${fixture.size} bytes y el .fxb mide ${bank.size}`,
      );
    }
    if (typeof fixture.purpose !== 'string' || fixture.purpose.trim() === '') {
      throw new Error(`${fixture.file}: falta "purpose" en manifest.json`);
    }
    const plugin = fixture.source?.plugin;
    if (typeof plugin !== 'string' || plugin.trim() === '') {
      throw new Error(`${fixture.file}: falta "source.plugin" en manifest.json`);
    }

    return (
      `| \`${cell(fixture.file)}\` | ${cell(plugin)} | ` +
      `\`${bank.kind}\`, ${bank.endianness}-endian, v${bank.version} | ` +
      `${formatSize(bank.size)} | ${cell(fixture.purpose)} |`
    );
  });

  for (const file of banks.keys()) {
    if (!listed.has(file)) {
      throw new Error(`${file}: el .fxb no tiene entrada en manifest.json`);
    }
  }

  return [
    '| Archivo | Plugin | Formato | Bytes | Para qué sirve |',
    '| --- | --- | --- | ---: | --- |',
    ...rows,
  ].join('\n');
}

/** Rango del bloque generado dentro del README. */
function tableSpan(text) {
  const start = text.indexOf(START);
  if (start === -1) throw new Error(`README.md: falta el marcador "${START}"`);
  const end = text.indexOf(END, start + START.length);
  if (end === -1) throw new Error(`README.md: falta el marcador "${END}"`);
  return {
    start,
    end: end + END.length,
    content: text.slice(start + START.length, end),
  };
}

/** Sustituye solo el bloque entre marcadores y conserva el fin de línea de origen. */
export function replaceTable(source, table) {
  const crlf = source.includes('\r\n');
  const text = crlf ? source.replace(/\r\n/g, '\n') : source;
  const span = tableSpan(text);
  const block = `${START}\n${table}\n${END}`;
  const result = text.slice(0, span.start) + block + text.slice(span.end);
  return crlf ? result.replace(/\n/g, '\r\n') : result;
}

/** Contenido actual del bloque, sin los marcadores ni su línea en blanco. */
function currentTable(source) {
  const crlf = source.includes('\r\n');
  const text = crlf ? source.replace(/\r\n/g, '\n') : source;
  return tableSpan(text).content.replace(/^\n/, '').replace(/\n$/, '');
}

/** Diferencias línea a línea, con la fila que se desvía. */
function describeDifferences(actualText, expected) {
  const actual = actualText.split('\n');
  const lines = expected.split('\n');
  const differences = [];
  const total = Math.max(actual.length, lines.length);

  for (let index = 0; index < total; index += 1) {
    if (actual[index] === lines[index]) continue;
    const label = index < 2 ? 'cabecera' : `fila ${index - 1}`;
    differences.push(`  ${label}:`);
    differences.push(`    README:   ${actual[index] ?? '(falta)'}`);
    differences.push(`    derivada: ${lines[index] ?? '(sobra)'}`);
  }
  return differences;
}

/** Cabecera y tamaño real de todos los `.fxb` del directorio, por nombre. */
function readBanks(dir) {
  const banks = new Map();
  for (const file of readdirSync(dir)
    .filter((name) => /\.fxb$/i.test(name))
    .sort()) {
    banks.set(file, readBank(path.join(dir, file)));
  }
  return banks;
}

function main(argv) {
  let mode = 'print';
  let manifestPath = DEFAULT_MANIFEST;
  let fixturesDir = DIR;
  let readmePath = DEFAULT_README;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--write' || argument === '--check') {
      if (mode !== 'print') throw new Error('--write y --check son excluyentes');
      mode = argument.slice(2);
    } else if (argument === '--manifest' || argument === '--fixtures' || argument === '--readme') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined) throw new Error(`${argument} necesita una ruta`);
      if (argument === '--manifest') manifestPath = path.resolve(value);
      else if (argument === '--fixtures') fixturesDir = path.resolve(value);
      else readmePath = path.resolve(value);
    } else {
      throw new Error(`argumento desconocido: ${argument}`);
    }
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const table = renderTable(manifest, readBanks(fixturesDir));

  if (mode === 'print') {
    console.log(table);
    return 0;
  }

  const source = readFileSync(readmePath, 'utf8');
  if (mode === 'check') {
    const actual = currentTable(source);
    if (actual === table) {
      console.log(`README.md coincide con los ${manifest.fixtures.length} .fxb del manifiesto`);
      return 0;
    }
    console.error('La tabla de fixtures del README no coincide con manifest.json y los .fxb:');
    for (const line of describeDifferences(actual, table)) console.error(line);
    console.error(
      '\nEjecuta `node test/fixtures/fxb/render-readme-table.mjs --write` para regenerarla.',
    );
    return 1;
  }

  const rewritten = replaceTable(source, table);
  if (rewritten === source) {
    console.log(`${readmePath}: tabla ya sincronizada, sin cambios`);
    return 0;
  }
  writeFileSync(readmePath, rewritten);
  console.log(`${readmePath}: tabla regenerada desde ${manifest.fixtures.length} .fxb`);
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
