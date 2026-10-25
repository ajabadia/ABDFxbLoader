import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pe32Dll } from './helpers/pe';
import { writePluginDll } from './helpers/vfx-plugin';
import {
  convertFxbEndianness,
  FXB_CHUNK_HEADER_SIZE,
  FXB_HEADER_SIZE,
  parseFxbBank,
} from '../src/library/fxb-bank';
import type { FxbBankInfo } from '../src/library/fxb-bank';
import type { BankImportResponse } from '../src/library/library.types';

/**
 * Fixtures con bancos `.fxb` reales: Massive, el banco de fábrica de OB-Xd,
 * exports de ReaComp/ReaEQ de Nanohost y Wavosaur, y un banco de sintetizador
 * (`FxBk` con 100 programas `FxCk`, versión 2) de MauSynth. El manifiesto fija
 * hash, tamaño, los tamaños que declara cada programa y el parseo esperado; si
 * el parser cambia de criterio con datos reales, estos tests fallan.
 *
 * Uno de ellos (`wavosaur-reeq-3set-le.fxb`) es un banco real pasado a
 * little-endian, el orden que escribe un plugin de Windows cuando guarda su
 * struct nativo sin convertirlo, para cubrir ese camino del parser con datos
 * de verdad y no con los que generamos en `helpers/fxb-bank.ts`.
 *
 * `massive-fpch-bank.fxb` es el único con programas `FPCh` (chunk opaco por
 * programa): un `FxBk` de dos programas reales exportados por Massive, con
 * chunks de tamaños distintos, para que la rama que comprueba
 * `byteSize === 52 + chunkSize` también se pruebe con bytes reales.
 */

const execFileAsync = promisify(execFile);

const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'fxb');
/** Script que deriva `size`, `sha256` y el bloque `programs` de cada `.fxb`. */
const DERIVE_MANIFEST = path.join(FIXTURES, 'derive-manifest.mjs');

interface FixtureSource {
  /** Archivo publicado en un repositorio: commit y ruta exacta de donde se copió. */
  repo?: string;
  commit?: string;
  path?: string;
  /** Archivo publicado en una web: URL directa de descarga y fecha de consulta. */
  url?: string;
  retrieved?: string;
  license: string;
  plugin: string;
  /** Fixture del manifiesto del que se deriva y cómo se transformó. */
  derivedFrom?: string;
  method?: string;
  /** Programas `.fxp` reales (del directorio de fixtures) con los que se ensambló el banco. */
  programs?: string[];
}

interface FixturePrograms {
  /** Programas que debe recorrer el banco; 0 en los `FBCh`, que no los declaran. */
  count: number;
  fxck: number;
  fpch: number;
  /** Parámetros declarados por los `FxCk`: total y rango. `null` si no hay. */
  params: { total: number; min: number; max: number } | null;
  /** `chunkSize` declarado por los `FPCh`: rango. `null` si no hay. */
  chunkBytes: { min: number; max: number } | null;
  /** Suma de los `byteSize` declarados por todos los programas. */
  byteSizeTotal: number;
}

interface Fixture {
  file: string;
  /** Tamaños que declara cada programa; obligatorio para cualquier banco. */
  programs: FixturePrograms;
  size: number;
  sha256: string;
  source: FixtureSource;
  expected: {
    bank: FxbBankInfo;
    issues: string[];
    warnings: string[];
  };
}

interface Manifest {
  description: string;
  fixtures: Fixture[];
}

let manifest: Manifest;
let app: INestApplication;

before(async () => {
  manifest = JSON.parse(await readFile(path.join(FIXTURES, 'manifest.json'), 'utf8')) as Manifest;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

after(async () => {
  await app?.close();
});

function http() {
  return request(app.getHttpServer());
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

function fixturePath(fixture: Fixture): string {
  return path.join(FIXTURES, fixture.file);
}

test('los .fxb reales coinciden con el manifiesto', async () => {
  assert.ok(manifest.fixtures.length >= 4, 'se esperan varios fixtures');

  for (const fixture of manifest.fixtures) {
    const data = await readFile(fixturePath(fixture));

    assert.equal(data.length, fixture.size, `${fixture.file}: tamaño`);
    assert.equal(await sha256(fixturePath(fixture)), fixture.sha256, `${fixture.file}: sha256`);

    const parsed = parseFxbBank(data);
    assert.deepEqual(parsed.bank, fixture.expected.bank, `${fixture.file}: cabecera`);
    assert.deepEqual(parsed.issues, fixture.expected.issues, `${fixture.file}: issues`);
    assert.deepEqual(parsed.warnings, fixture.expected.warnings, `${fixture.file}: warnings`);
  }
});

test('cada fixture declara de dónde salió', async () => {
  for (const fixture of manifest.fixtures) {
    const source = fixture.source;
    if (source.derivedFrom !== undefined) {
      assert.ok(source.method, `${fixture.file}: derivado sin explicar el método`);
      assert.ok(
        manifest.fixtures.some((candidate) => candidate.file === source.derivedFrom),
        `${fixture.file}: se deriva de ${source.derivedFrom}, que no está en el manifiesto`,
      );
    } else if (source.repo !== undefined) {
      assert.ok(source.commit && source.path, `${fixture.file}: sin commit o ruta de origen`);
    } else {
      assert.ok(
        source.url && source.retrieved,
        `${fixture.file}: sin URL de descarga o fecha de consulta`,
      );
    }
    assert.ok(source.license, `${fixture.file}: sin licencia`);
    assert.ok(source.plugin, `${fixture.file}: sin plugin`);

    if (source.programs !== undefined) {
      assert.ok(source.method, `${fixture.file}: banco ensamblado sin explicar el método`);
      assert.ok(source.programs.length > 0, `${fixture.file}: sin programas de origen`);
      for (const program of source.programs) {
        await access(path.join(FIXTURES, program)).catch(() => {
          assert.fail(`${fixture.file}: falta el programa de origen ${program}`);
        });
      }
    }
  }
});

/**
 * Offsets de los campos numéricos de 32 bits de un `.fxb` big-endian: cabecera
 * del banco, cabecera de cada programa y, en los `FxCk`, cada parámetro float.
 * Todo lo demás (nombres, chunks opacos) no se toca al cambiar de orden.
 */
function numericBlocks(data: Buffer): Set<number> {
  const blocks = new Set<number>();
  for (let offset = 0; offset < 32; offset += 4) blocks.add(offset);

  const kind = data.subarray(8, 12).toString('latin1');
  if (kind !== 'FxBk') {
    blocks.add(FXB_HEADER_SIZE); // chunkSize del banco opaco
    return blocks;
  }

  const programs = data.readUInt32BE(24);
  let offset = FXB_HEADER_SIZE;
  for (let index = 0; index < programs; index += 1) {
    const byteSize = data.readUInt32BE(offset + 4);
    const fxMagic = data.subarray(offset + 8, offset + 12).toString('latin1');
    const numParams = data.readUInt32BE(offset + 24);
    for (let field = 0; field < 7; field += 1) blocks.add(offset + 4 * field);
    if (fxMagic === 'FxCk') {
      for (let param = 0; param < numParams; param += 1) blocks.add(offset + 56 + 4 * param);
    } else {
      blocks.add(offset + 56);
    }
    offset += 8 + byteSize;
  }
  return blocks;
}

test('el fixture little-endian es un banco real con los enteros invertidos', async () => {
  const derived = manifest.fixtures.filter((fixture) => fixture.source.derivedFrom !== undefined);
  assert.ok(derived.length >= 1, 'falta el fixture little-endian');

  for (const fixture of derived) {
    const origin = manifest.fixtures.find(
      (candidate) => candidate.file === fixture.source.derivedFrom,
    )!;
    assert.ok(origin, `${fixture.file}: no se encuentra su origen`);
    assert.equal(origin.expected.bank.endianness, 'big');
    assert.equal(fixture.expected.bank?.endianness, 'little', `${fixture.file}: debe ser little-endian`);

    const { endianness: _origin, ...originFields } = origin.expected.bank;
    const { endianness: _derived, ...derivedFields } = fixture.expected.bank!;
    assert.deepEqual(derivedFields, originFields, `${fixture.file}: mismos campos que su origen`);

    const little = await readFile(fixturePath(fixture));
    const big = await readFile(fixturePath(origin));
    assert.equal(little.length, big.length, `${fixture.file}: mismo tamaño`);

    const numeric = numericBlocks(big);
    assert.ok(numeric.size > 8, `${origin.file}: el recorrido debe encontrar los campos numéricos`);
    for (let offset = 0; offset < big.length; offset += 4) {
      const expected = numeric.has(offset)
        ? Buffer.from(big.subarray(offset, offset + 4)).reverse()
        : big.subarray(offset, offset + 4);
      assert.deepEqual(
        little.subarray(offset, offset + 4),
        expected,
        `${fixture.file}: bytes ${offset}..${offset + 3} frente al original`,
      );
    }
  }
});

/** Cabecera propia de cada programa dentro del `FxBk` (fxMagic + byteSize). */
const PROGRAM_HEADER_SIZE = 8;

interface ProgramEntry {
  offset: number;
  magic: string;
  byteSize: number;
  /** Parámetros de un `FxCk`; los `FPCh` guardan el chunk en su lugar. */
  numParams: number;
  /** Declarado por el propio programa; solo los `FPCh` lo llevan. */
  chunkSize: number | null;
}

/**
 * Recorre los programas de un banco `FxBk` leyendo los tamaños que declara el
 * propio archivo, sin pasar por el parser. El `chunkSize` de un `FPCh` son los
 * 4 bytes que siguen a los 48 fijos del `fxProgram` (fxMagic, version, fxID,
 * fxVersion, numParams y nombre de 28 bytes).
 */
function programEntries(data: Buffer): ProgramEntry[] {
  // El `chunkMagic` decide el orden: `CcnK` en el archivo o invertido en un
  // little-endian. Los magics se devuelven canónicos y los enteros se leen con
  // el orden detectado, para que el recorrido valga en ambos casos.
  const little = data.readUInt32LE(0) === 0x43636e4b;
  const u32 = (offset: number): number =>
    little ? data.readUInt32LE(offset) : data.readUInt32BE(offset);
  const magicAt = (offset: number): string => {
    const raw = Buffer.from(data.subarray(offset, offset + 4));
    return (little ? raw.reverse() : raw).toString('latin1');
  };

  const count = u32(24);
  const entries: ProgramEntry[] = [];
  let offset = FXB_HEADER_SIZE;
  for (let index = 0; index < count && offset + 8 <= data.length; index += 1) {
    const byteSize = u32(offset + 4);
    const magic = magicAt(offset + 8);
    entries.push({
      offset,
      magic,
      byteSize,
      numParams: u32(offset + 24),
      chunkSize: magic === 'FPCh' ? u32(offset + 56) : null,
    });
    offset += 8 + byteSize;
  }
  return entries;
}

function fpchFixture(): Fixture {
  const fixture = manifest.fixtures.find(
    (candidate) => candidate.file === 'massive-fpch-bank.fxb',
  );
  assert.ok(fixture, 'falta el fixture con programas FPCh');
  assert.equal(fixture.expected.bank.kind, 'FxBk');
  return fixture;
}

function range(values: number[]): { min: number; max: number } | null {
  return values.length === 0 ? null : { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * Contrasta los tamaños que declara cada programa del banco con el manifiesto:
 * un `FxCk` ocupa `48 + 4 × numParams` bytes y un `FPCh` `52 + chunkSize`, el
 * recorrido cubre el archivo exacto y la suma de los tamaños coincide con la
 * esperada. Sin el bloque `programs` ningún banco entra en el manifiesto.
 */
function checkPrograms(fixture: Fixture, data: Buffer): void {
  const expected = fixture.programs;
  const file = fixture.file;
  assert.ok(expected, `${file}: falta el bloque "programs" en manifest.json`);

  if (fixture.expected.bank.kind !== 'FxBk') {
    // Los `FBCh` guardan un chunk opaco: no declaran programas, así que el
    // manifiesto tampoco puede inventarlos.
    assert.equal(expected.count, 0, `${file}: un ${fixture.expected.bank.kind} no tiene programas`);
    assert.equal(expected.byteSizeTotal, 0, `${file}: un ${fixture.expected.bank.kind} sin programas`);
    assert.equal(expected.params, null, `${file}: un ${fixture.expected.bank.kind} sin parámetros`);
    assert.equal(expected.chunkBytes, null, `${file}: un ${fixture.expected.bank.kind} sin chunks`);
    return;
  }

  const entries = programEntries(data);
  assert.equal(entries.length, expected.count, `${file}: programas recorridos`);
  assert.equal(entries.length, fixture.expected.bank.numPrograms, `${file}: programas de la cabecera`);
  assert.equal(
    expected.fxck + expected.fpch,
    expected.count,
    `${file}: el manifiesto reparte mal los FxCk y FPCh`,
  );

  let byteSizeTotal = 0;
  const params: number[] = [];
  const chunks: number[] = [];
  for (const [index, program] of entries.entries()) {
    const label = `${file}: programa ${index + 1}`;
    assert.ok(
      program.offset + PROGRAM_HEADER_SIZE + program.byteSize <= data.length,
      `${label}: declara más bytes de los que hay`,
    );
    byteSizeTotal += program.byteSize;

    if (program.magic === 'FxCk') {
      // 6 campos de 4 bytes + nombre de 28 bytes + un float por parámetro.
      assert.equal(
        program.byteSize,
        48 + 4 * program.numParams,
        `${label}: byteSize distinto de 48 + 4 × ${program.numParams} parámetros`,
      );
      params.push(program.numParams);
    } else {
      assert.equal(program.magic, 'FPCh', `${label}: fxMagic inesperado`);
      const chunkSize = program.chunkSize;
      assert.notEqual(chunkSize, null, `${label}: sin chunkSize`);
      // 48 bytes de fxProgram + 4 del tamaño del chunk + el chunk opaco.
      assert.equal(
        program.byteSize,
        52 + chunkSize!,
        `${label}: byteSize distinto de 52 + ${chunkSize} de chunk`,
      );
      assert.ok(chunkSize! > 0, `${label}: chunk vacío`);
      chunks.push(chunkSize!);
    }
  }

  assert.equal(params.length, expected.fxck, `${file}: programas FxCk`);
  assert.equal(chunks.length, expected.fpch, `${file}: programas FPCh`);
  assert.equal(byteSizeTotal, expected.byteSizeTotal, `${file}: suma de los byteSize declarados`);
  assert.equal(
    params.reduce((total, value) => total + value, 0),
    expected.params?.total ?? 0,
    `${file}: parámetros totales de los FxCk`,
  );
  assert.deepEqual(
    range(params),
    expected.params === null ? null : { min: expected.params.min, max: expected.params.max },
    `${file}: rango de parámetros de los FxCk`,
  );
  assert.deepEqual(range(chunks), expected.chunkBytes, `${file}: rango de chunks de los FPCh`);

  const last = entries[entries.length - 1];
  if (last === undefined) {
    // Un banco sin programas no puede dejar bytes sueltos tras la cabecera.
    assert.equal(FXB_HEADER_SIZE, data.length, `${file}: un banco vacío debe acabar en la cabecera`);
  } else {
    assert.equal(
      last.offset + PROGRAM_HEADER_SIZE + last.byteSize,
      data.length,
      `${file}: los programas cubren el archivo`,
    );
  }

  // El orden de los enteros lo delata el `chunkMagic` (`CcnK` en big-endian).
  const little = data.readUInt32LE(0) === 0x43636e4b;
  const bankByteSize = little ? data.readUInt32LE(4) : data.readUInt32BE(4);
  assert.equal(bankByteSize, data.length - PROGRAM_HEADER_SIZE, `${file}: byteSize del banco`);
  assert.deepEqual(parseFxbBank(data).issues, [], `${file}: el parser debe aceptarlo sin issues`);
}

test('cada fixture declara los tamaños de todos sus programas', async () => {
  for (const fixture of manifest.fixtures) {
    checkPrograms(fixture, await readFile(fixturePath(fixture)));
  }
});

test('el manifiesto reparte todos los programas entre FxCk y FPCh', () => {
  let fxck = 0;
  let fpch = 0;
  for (const fixture of manifest.fixtures) {
    const programs = fixture.programs;
    assert.ok(programs, `${fixture.file}: falta el bloque "programs" en manifest.json`);
    assert.equal(
      programs.fxck + programs.fpch,
      programs.count,
      `${fixture.file}: el manifiesto reparte mal los FxCk y FPCh`,
    );
    fxck += programs.fxck;
    fpch += programs.fpch;
  }

  // Ambos caminos tienen que estar cubiertos por fixtures reales.
  assert.ok(fxck > 0, 'ningún fixture real declara programas FxCk');
  assert.ok(fpch > 0, 'ningún fixture real declara programas FPCh');
});

interface DerivationRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Lo que el script deriva de cada `.fxb` y tiene que estar en el manifiesto. */
interface DerivedFixture {
  size: number;
  sha256: string;
  programs: FixturePrograms;
}

/** Ejecuta el script como lo haría una persona, con el Node que corre los tests. */
async function deriveManifest(args: string[]): Promise<DerivationRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [DERIVE_MANIFEST, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

/** Copia del manifiesto en un directorio temporal, para probar `--check` y `--write`. */
async function tempManifest(t: TestContext, contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fxb-manifest-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'manifest.json');
  await writeFile(file, contents);
  return file;
}

/** Fixture pequeño y conocido que usan los tests de mutación del manifiesto. */
function reaCompFixture(): Fixture {
  const fixture = manifest.fixtures.find((candidate) => candidate.file === 'rea-comp.FXB');
  assert.ok(fixture, 'falta el fixture rea-comp.FXB');
  return fixture;
}

/** Manifest con el `size` de `rea-comp.FXB` cambiado en un byte. */
function brokenSize(original: string): { text: string; declared: number } {
  const { size, sha256 } = reaCompFixture();
  const declared = size + 1;
  // El `size` va justo antes del `sha256`: anclarlo así no confunde 288 con 2886,
  // y el `\r?\n` lo hace funcionar también en un checkout con CRLF.
  const text = original.replace(
    new RegExp(`"size": ${size},(\\r?\\n\\s*"sha256": "${sha256}")`),
    `"size": ${declared},$1`,
  );
  assert.notEqual(text, original, `manifest.json debe declarar "size": ${size} en rea-comp.FXB`);
  return { text, declared };
}

/** Manifest con un dígito del `sha256` de `rea-comp.FXB` cambiado. */
function brokenSha256(original: string): { text: string; declared: string } {
  const { sha256 } = reaCompFixture();
  const declared = `${sha256[0] === 'a' ? 'b' : 'a'}${sha256.slice(1)}`;
  const text = original.replace(`"sha256": "${sha256}"`, `"sha256": "${declared}"`);
  assert.notEqual(text, original, `manifest.json debe declarar el sha256 de rea-comp.FXB`);
  return { text, declared };
}

/** Manifest con la suma de `byteSize` de `rea-comp.FXB` cambiada en un byte. */
function brokenPrograms(original: string): { text: string; declared: number } {
  const { byteSizeTotal } = reaCompFixture().programs;
  const text = original.replace(
    `"byteSizeTotal": ${byteSizeTotal}`,
    `"byteSizeTotal": ${byteSizeTotal + 1}`,
  );
  assert.notEqual(text, original, 'manifest.json debe declarar el byteSizeTotal de rea-comp.FXB');
  return { text, declared: byteSizeTotal + 1 };
}

test('el manifiesto coincide con lo derivado de los .fxb: size, sha256 y programs', async () => {
  const run = await deriveManifest([]);
  assert.equal(run.code, 0, run.stderr);
  const derived = JSON.parse(run.stdout) as Record<string, DerivedFixture>;

  const files = (await readdir(FIXTURES))
    .filter((name) => /\.fxb$/i.test(name))
    .sort();
  assert.deepEqual(
    Object.keys(derived).sort(),
    files,
    'el script debe derivar todos los .fxb del directorio',
  );
  assert.deepEqual(
    Object.keys(derived).sort(),
    manifest.fixtures.map((fixture) => fixture.file).sort(),
    'hay un .fxb sin entrada en manifest.json o al revés',
  );

  for (const fixture of manifest.fixtures) {
    assert.deepEqual(
      derived[fixture.file],
      { size: fixture.size, sha256: fixture.sha256, programs: fixture.programs },
      `${fixture.file}: size, sha256 o programs no coinciden con sus bytes ` +
        '(regenera con `node test/fixtures/fxb/derive-manifest.mjs --write`)',
    );
  }

  // El mismo contrato por la vía que usa una persona en la terminal.
  const check = await deriveManifest(['--check']);
  assert.equal(check.code, 0, check.stderr);
});

test('la comprobación falla si el manifiesto se desvía un solo byte', async (t) => {
  const original = await readFile(path.join(FIXTURES, 'manifest.json'), 'utf8');
  const broken = brokenPrograms(original);

  const run = await deriveManifest(['--check', '--manifest', await tempManifest(t, broken.text)]);
  assert.equal(run.code, 1, 'una diferencia de un byte debe romper la comprobación');
  assert.match(
    run.stderr,
    new RegExp(
      `rea-comp\\.FXB: byteSizeTotal: manifiesto ${broken.declared}, \\.fxb ${reaCompFixture().programs.byteSizeTotal}`,
    ),
  );
  assert.match(run.stderr, /--write/);
});

test('la comprobación también falla si se desvía el size o el sha256', async (t) => {
  const original = await readFile(path.join(FIXTURES, 'manifest.json'), 'utf8');
  const fixture = reaCompFixture();

  const size = brokenSize(original);
  const sizeRun = await deriveManifest(['--check', '--manifest', await tempManifest(t, size.text)]);
  assert.equal(sizeRun.code, 1, 'un tamaño distinto debe romper la comprobación');
  assert.match(
    sizeRun.stderr,
    new RegExp(`rea-comp\\.FXB: size: manifiesto ${size.declared}, \\.fxb ${fixture.size}`),
  );

  const hash = brokenSha256(original);
  const hashRun = await deriveManifest(['--check', '--manifest', await tempManifest(t, hash.text)]);
  assert.equal(hashRun.code, 1, 'un hash distinto debe romper la comprobación');
  assert.match(hashRun.stderr, /rea-comp\.FXB: sha256: manifiesto "[0-9a-f]+", \.fxb "[0-9a-f]+"/);
  assert.match(hashRun.stderr, new RegExp(`\.fxb "${fixture.sha256}"`));
});

/** Directorio de fixtures temporal para los caminos de error del script. */
async function tempFixtures(t: TestContext, files: Record<string, Buffer>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fxb-derive-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  for (const [file, data] of Object.entries(files)) {
    await writeFile(path.join(directory, file), data);
  }
  return directory;
}

test('el script falla ante un .fxb truncado en vez de inventar el bloque', async (t) => {
  const data = await readFile(path.join(FIXTURES, 'rea-comp.FXB'));
  const fixtures = await tempFixtures(t, { 'rea-comp.FXB': data.subarray(0, 200) });

  const run = await deriveManifest(['--fixtures', fixtures]);
  assert.equal(run.code, 1, 'un banco truncado no puede producir un bloque');
  assert.match(run.stderr, /programa 1: byteSize 124 se sale del archivo/);
  assert.doesNotMatch(run.stdout, /byteSizeTotal/, 'no debe imprimir un bloque a medias');
});

test('la comprobación nombra un .fxb sin entrada en el manifiesto', async (t) => {
  const data = await readFile(path.join(FIXTURES, 'rea-comp.FXB'));
  const fixtures = await tempFixtures(t, { 'rea-comp.FXB': data });
  const manifestPath = await tempManifest(
    t,
    JSON.stringify({ description: 'sin entradas', fixtures: [] }, null, 2),
  );

  const run = await deriveManifest(['--check', '--fixtures', fixtures, '--manifest', manifestPath]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /rea-comp\.FXB: el \.fxb no tiene entrada en manifest\.json/);
});

test('--write corrige size, sha256 y programs y no toca el resto del manifiesto', async (t) => {
  const original = await readFile(path.join(FIXTURES, 'manifest.json'), 'utf8');
  const fixture = reaCompFixture();
  const broken = brokenSize(original)
    .text.replace(
      `"sha256": "${fixture.sha256}"`,
      `"sha256": "${brokenSha256(original).declared}"`,
    )
    .replace(
      `"byteSizeTotal": ${fixture.programs.byteSizeTotal}`,
      `"byteSizeTotal": ${brokenPrograms(original).declared}`,
    );
  assert.notEqual(broken, original, 'las tres mutaciones deben cambiar el manifiesto');

  const manifestPath = await tempManifest(t, broken);
  const run = await deriveManifest(['--write', '--manifest', manifestPath]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(
    await readFile(manifestPath, 'utf8'),
    original,
    'los tres campos regenerados deben dejar el manifiesto byte a byte como el versionado',
  );

  // Y una segunda pasada no reescribe nada.
  const again = await deriveManifest(['--write', '--manifest', manifestPath]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /sin cambios/);
  assert.equal(await readFile(manifestPath, 'utf8'), original);
});

test('--write añade size, sha256 y programs a una entrada que no los declara', async (t) => {
  const fixture = reaCompFixture();
  const manifestPath = await tempManifest(
    t,
    `${JSON.stringify(
      {
        description: 'entrada recién añadida, sin campos derivados',
        fixtures: [{ file: fixture.file, source: fixture.source, expected: fixture.expected }],
      },
      null,
      2,
    )}\n`,
  );

  // `--check` los echa en falta: una entrada sin ellos no se da por buena.
  const check = await deriveManifest(['--check', '--fixtures', FIXTURES, '--manifest', manifestPath]);
  assert.equal(check.code, 1);
  assert.match(check.stderr, /rea-comp\.FXB: size: manifiesto ausente/);

  const run = await deriveManifest(['--write', '--fixtures', FIXTURES, '--manifest', manifestPath]);
  assert.equal(run.code, 0, run.stderr);

  const written = JSON.parse(await readFile(manifestPath, 'utf8')) as { fixtures: Fixture[] };
  assert.deepEqual(written.fixtures[0], {
    file: fixture.file,
    programs: fixture.programs,
    size: fixture.size,
    sha256: fixture.sha256,
    source: fixture.source,
    expected: fixture.expected,
  });
  assert.match(
    await readFile(manifestPath, 'utf8'),
    /"file": "rea-comp\.FXB",\n      "programs": \{/,
    'los campos se insertan detrás de "file", con la indentación del manifiesto',
  );

  // Con los tres campos ya dentro, la segunda pasada no toca el archivo.
  const again = await deriveManifest(['--write', '--fixtures', FIXTURES, '--manifest', manifestPath]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /sin cambios/);
});

test('--write completa una entrada cuyo "file" es el último campo', async (t) => {
  const manifestPath = await tempManifest(
    t,
    '{\n  "fixtures": [\n    {\n      "file": "rea-comp.FXB"\n    }\n  ]\n}\n',
  );

  const run = await deriveManifest(['--write', '--fixtures', FIXTURES, '--manifest', manifestPath]);
  assert.equal(run.code, 0, run.stderr);

  const written = JSON.parse(await readFile(manifestPath, 'utf8')) as { fixtures: Fixture[] };
  const fixture = reaCompFixture();
  assert.deepEqual(written.fixtures[0], {
    file: 'rea-comp.FXB',
    programs: fixture.programs,
    size: fixture.size,
    sha256: fixture.sha256,
  });
});

test('la comprobación de tamaños detecta un FxCk con numParams manipulado', async () => {
  const fixture = manifest.fixtures.find((candidate) => candidate.file === 'rea-comp.FXB')!;
  const data = Buffer.from(await readFile(fixturePath(fixture)));

  // Cambia los parámetros sin tocar el byteSize: 124 bytes ya no cuadran.
  data.writeUInt32BE(20, FXB_HEADER_SIZE + 24);

  assert.throws(
    () => checkPrograms(fixture, data),
    /programa 1: byteSize distinto de 48 \+ 4 × 20 parámetros/,
  );
});

test('la comprobación de tamaños detecta un FPCh con chunkSize manipulado', async () => {
  const fixture = fpchFixture();
  const data = Buffer.from(await readFile(fixturePath(fixture)));
  const first = programEntries(data)[0]!;

  data.writeUInt32BE(first.chunkSize! + 8, first.offset + 56);

  assert.throws(
    () => checkPrograms(fixture, data),
    /programa 1: byteSize distinto de 52 \+ \d+ de chunk/,
  );
});

test('un chunkSize declarado de más se ve contra el byteSize del programa', async () => {
  const fixture = fpchFixture();
  const data = await readFile(fixturePath(fixture));
  const first = programEntries(data)[0]!;
  const declared = first.chunkSize!;

  const corrupted = Buffer.from(data);
  corrupted.writeUInt32BE(declared + 8, first.offset + 56);

  const parsed = parseFxbBank(corrupted);
  assert.equal(parsed.issues.length, 1, parsed.issues.join('; '));
  assert.equal(
    parsed.issues[0],
    `programa 1: byteSize ${first.byteSize} distinto de ${52 + declared + 8} ` +
      `(chunk de ${declared + 8} bytes)`,
  );
});

test('un programa que declara más bytes de los que quedan se rechaza', async () => {
  const fixture = fpchFixture();
  const data = await readFile(fixturePath(fixture));
  const first = programEntries(data)[0]!;

  const corrupted = Buffer.from(data);
  corrupted.writeUInt32BE(data.length, first.offset + 4);

  const parsed = parseFxbBank(corrupted);
  assert.equal(parsed.issues.length, 1, parsed.issues.join('; '));
  assert.equal(
    parsed.issues[0],
    `programa 1: byteSize ${data.length} fuera de rango ` +
      `(quedan ${data.length - first.offset - 8} bytes)`,
  );
});

test('convertir el banco real a little-endian reproduce el fixture derivado', async () => {
  const big = manifest.fixtures.find((fixture) => fixture.file === 'wavosaur-reeq-3set.fxb')!;
  const little = manifest.fixtures.find((fixture) => fixture.file === 'wavosaur-reeq-3set-le.fxb')!;

  const source = await readFile(fixturePath(big));
  const converted = convertFxbEndianness(source, 'little');

  // 8 campos de cabecera + 7 del programa + 9 parámetros del `FxCk`.
  assert.equal(converted.fields, 24);
  assert.equal(converted.programs, 1);
  assert.equal(converted.chunks, 0);
  assert.deepEqual(
    converted.data,
    await readFile(fixturePath(little)),
    'el conversor debe reproducir el fixture little-endian byte a byte',
  );

  // Y volver atrás devuelve exactamente el archivo original.
  assert.deepEqual(convertFxbEndianness(converted.data, 'big').data, source);
});

test('convierte los programas FPCh del banco real y vuelve al original', async () => {
  const fixture = fpchFixture();
  const source = await readFile(fixturePath(fixture));

  const converted = convertFxbEndianness(source, 'little');
  assert.equal(converted.programs, 2);
  assert.equal(converted.chunks, 2, 'un chunk por programa FPCh');
  assert.equal(converted.fields, 8 + 2 * (7 + 1));

  const parsed = parseFxbBank(converted.data);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.bank?.endianness, 'little');
  assert.equal(parsed.bank?.numPrograms, 2);

  // Los tamaños declarados siguen cuadrando tras invertir el orden.
  for (const [index, program] of programEntries(converted.data).entries()) {
    assert.equal(program.magic, 'FPCh', `programa ${index + 1}: fxMagic`);
    assert.equal(program.byteSize, 52 + program.chunkSize!, `programa ${index + 1}: byteSize`);
  }

  assert.deepEqual(convertFxbEndianness(converted.data, 'big').data, source);
});

test('el manifiesto cubre todos los .fxb del directorio', async () => {
  const files = (await readdir(FIXTURES))
    .filter((name) => /\.fxb$/i.test(name))
    .sort();
  const documented = manifest.fixtures.map((fixture) => fixture.file).sort();
  assert.deepEqual(documented, files, 'hay fixtures sin entrada en manifest.json o al revés');
});

test('la cabecera de 160 bytes basta para identificar cada banco', async () => {
  for (const fixture of manifest.fixtures) {
    const data = await readFile(fixturePath(fixture));
    const header = data.subarray(0, FXB_CHUNK_HEADER_SIZE);

    const parsed = parseFxbBank(header, data.length);
    assert.deepEqual(parsed.bank, fixture.expected.bank, `${fixture.file}: parseo de cabecera`);
    assert.deepEqual(parsed.issues, [], `${fixture.file}: la cabecera no debe dar issues`);
  }
});

test('un archivo real truncado por debajo de la cabecera se rechaza', async () => {
  const fixture = manifest.fixtures[0]!;
  const data = await readFile(fixturePath(fixture));

  const truncated = data.subarray(0, FXB_HEADER_SIZE - 1);
  const parsed = parseFxbBank(truncated, truncated.length);
  assert.equal(parsed.bank, null);
  assert.match(parsed.issues[0] ?? '', /necesita al menos 156/);
});

interface Library {
  root: string;
  dll: string;
  presets: string;
}

async function library(t: TestContext): Promise<Library> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-real-fixtures-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pluginDir = path.join(root, 'plugs', 'Synth');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, 'vfxinfo.txt'),
    Buffer.from('name: Synth\r\ndll_name: Synth/Synth.dll\r\n', 'latin1'),
  );
  await writePluginDll(pluginDir, 'Synth/Synth.dll');

  const dll = path.join(root, 'loader.dll');
  await writeFile(dll, pe32Dll());

  return { root, dll, presets: path.join(pluginDir, 'presets') };
}

test('importa los bancos reales y los copia byte a byte', async (t) => {
  const data = await library(t);
  await http()
    .post('/library/loader/add')
    .send({ libraryRoot: data.root, plugin: 'Synth', dllSourcePath: data.dll })
    .expect(200);

  const groups = new Map<string, Fixture[]>();
  for (const fixture of manifest.fixtures) {
    const uniqueId = fixture.expected.bank.uniqueId;
    groups.set(uniqueId, [...(groups.get(uniqueId) ?? []), fixture]);
  }
  assert.deepEqual([...groups.keys()].sort(), ['NiMa', 'Obxd', 'Pang', 'recm', 'reeq']);

  for (const [uniqueId, fixtures] of groups) {
    const response = await http()
      .post('/library/banks/import')
      .send({
        libraryRoot: data.root,
        plugin: 'Synth',
        sourcePaths: fixtures.map((fixture) => fixturePath(fixture)),
        expectedUniqueId: uniqueId,
      })
      .expect(200);

    const body = response.body as BankImportResponse;
    assert.equal(body.reference.source, 'explicit');

    for (const [index, fixture] of fixtures.entries()) {
      const result = body.results[index]!;
      assert.equal(result.status, 'imported', `${fixture.file}: estado`);
      assert.equal(result.compatibility, 'compatible', `${fixture.file}: compatibilidad`);
      assert.deepEqual(result.bank, fixture.expected.bank, `${fixture.file}: banco en la respuesta`);
      assert.equal(await sha256(result.target), fixture.sha256, `${fixture.file}: copia idéntica`);
    }
  }

  const copied = (await readdir(data.presets)).sort();
  assert.deepEqual(
    copied,
    manifest.fixtures.map((fixture) => fixture.file).sort(),
  );
});

test('rechaza un banco real de otro plugin y no lo copia', async (t) => {
  const data = await library(t);
  await http()
    .post('/library/loader/add')
    .send({ libraryRoot: data.root, plugin: 'Synth', dllSourcePath: data.dll })
    .expect(200);

  const foreign = manifest.fixtures.find((fixture) => fixture.file === 'rea-comp.FXB')!;
  assert.equal(foreign.expected.bank.uniqueId, 'recm');

  const response = await http()
    .post('/library/banks/import')
    .send({
      libraryRoot: data.root,
      plugin: 'Synth',
      sourcePaths: [fixturePath(foreign)],
      expectedUniqueId: 'reeq',
    })
    .expect(422);

  const body = response.body as BankImportResponse & { message: string };
  assert.equal(body.message, 'Ningún banco se pudo importar');
  assert.equal(body.results[0]?.status, 'rejected');
  assert.equal(body.results[0]?.compatibility, 'incompatible');
  assert.match(body.results[0]?.reason ?? '', /uniqueID recm .*distinto del esperado reeq/);
  assert.deepEqual(await readdir(data.presets), [], 'no debe copiarse nada');
});

test('la versión real del banco solo se exige si el cliente la pide', async (t) => {
  const data = await library(t);
  await http()
    .post('/library/loader/add')
    .send({ libraryRoot: data.root, plugin: 'Synth', dllSourcePath: data.dll })
    .expect(200);

  const wavosaur = manifest.fixtures.find((fixture) => fixture.file === 'wavosaur-reeq-3set.fxb')!;
  assert.equal(wavosaur.expected.bank.fxVersion, 0);

  const imported = await http()
    .post('/library/banks/import')
    .send({
      libraryRoot: data.root,
      plugin: 'Synth',
      sourcePaths: [fixturePath(wavosaur)],
      expectedUniqueId: 'reeq',
    })
    .expect(200);
  assert.equal((imported.body as BankImportResponse).results[0]?.compatibility, 'compatible');

  const strict = await http()
    .post('/library/banks/import')
    .send({
      libraryRoot: data.root,
      plugin: 'Synth',
      sourcePaths: [fixturePath(wavosaur)],
      expectedUniqueId: 'reeq',
      expectedFxVersion: 1100,
    })
    .expect(422);
  const body = strict.body as BankImportResponse;
  assert.equal(body.results[0]?.compatibility, 'incompatible');
  assert.match(body.results[0]?.reason ?? '', /versión del plugin 0 distinta de la esperada 1100/);
});
