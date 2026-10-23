import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';

/**
 * La tabla de fixtures del README no se escribe a mano: sale de `manifest.json`
 * y del tamaño real de cada `.fxb`. Estas pruebas fijan ese contrato: la tabla
 * versionada está sincronizada, `--check` detecta una celda cambiada y
 * `--write` la regenera sin tocar el resto del documento.
 */

const execFileAsync = promisify(execFile);

const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'fxb');
const TABLE_SCRIPT = path.join(FIXTURES, 'render-readme-table.mjs');
const README = path.join(FIXTURES, 'README.md');
const MANIFEST = path.join(FIXTURES, 'manifest.json');
const START = '<!-- fixtures:tabla:inicio -->';
const END = '<!-- fixtures:tabla:fin -->';

interface Fixture {
  file: string;
  size: number;
  purpose: string;
  source: { plugin: string };
  expected: { bank: { kind: string; endianness: string; version: number } };
}

interface Manifest {
  fixtures: Fixture[];
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function renderTable(args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TABLE_SCRIPT, ...args]);
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

async function tempFile(t: TestContext, name: string, contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fxb-readme-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, name);
  await writeFile(file, contents);
  return file;
}

function formatSize(size: number): string {
  return String(size).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function rowOf(table: string, file: string): string {
  const row = table.split('\n').find((line) => line.startsWith(`| \`${file}\` |`));
  assert.ok(row, `la tabla no tiene la fila de ${file}`);
  return row;
}

test('la tabla del README coincide con el manifiesto y los .fxb', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as Manifest;
  const rendered = await renderTable([]);
  assert.equal(rendered.code, 0, rendered.stderr);

  const rows = rendered.stdout.trimEnd().split('\n').slice(2);
  assert.equal(rows.length, manifest.fixtures.length, 'una fila por fixture');

  for (const fixture of manifest.fixtures) {
    const size = (await stat(path.join(FIXTURES, fixture.file))).size;
    assert.equal(fixture.size, size, `${fixture.file}: el manifiesto declara el tamaño real`);
    assert.ok(fixture.purpose.trim() !== '', `${fixture.file}: el manifiesto explica para qué sirve`);

    const row = rowOf(rendered.stdout, fixture.file);
    const bank = fixture.expected.bank;
    assert.ok(
      row.includes(`| \`${bank.kind}\`, ${bank.endianness}-endian, v${bank.version} |`),
      `${fixture.file}: formato derivado del banco`,
    );
    assert.ok(row.includes(`| ${formatSize(size)} |`), `${fixture.file}: tamaño real en la tabla`);
    assert.ok(row.includes(`| ${fixture.purpose} |`), `${fixture.file}: propósito del manifiesto`);
  }

  const check = await renderTable(['--check']);
  assert.equal(check.code, 0, check.stderr);
  assert.match(check.stdout, new RegExp(`los ${manifest.fixtures.length} \\.fxb`));
});

test('la comprobación falla si un tamaño de la tabla se desvía un byte', async (t) => {
  const original = await readFile(README, 'utf8');
  const fixture = JSON.parse(await readFile(MANIFEST, 'utf8')).fixtures.find(
    (candidate: Fixture) => candidate.file === 'rea-comp.FXB',
  ) as Fixture;
  const row = rowOf(original, fixture.file);
  const alteredRow = row.replace(`| ${fixture.size} |`, `| ${fixture.size + 1} |`);
  assert.notEqual(alteredRow, row, 'la fila debe contener el tamaño que se muta');

  const readme = await tempFile(t, 'README.md', original.replace(row, alteredRow));
  const run = await renderTable(['--check', '--readme', readme]);

  assert.equal(run.code, 1, 'un tamaño escrito a mano que no cuadra debe romper la comprobación');
  assert.match(run.stderr, /La tabla de fixtures del README no coincide/);
  assert.match(run.stderr, new RegExp(`rea-comp\\.FXB.*\\| ${fixture.size + 1} \\|`));
  assert.match(run.stderr, new RegExp(`\\| ${fixture.size} \\|`));
  assert.match(run.stderr, /--write/);
});

test('el tamaño de la tabla sale del .fxb y no de lo que declare el manifiesto', async (t) => {
  const original = await readFile(MANIFEST, 'utf8');
  const fixture = JSON.parse(original).fixtures.find(
    (candidate: Fixture) => candidate.file === 'rea-comp.FXB',
  ) as Fixture;
  const altered = original.replace(
    new RegExp(`("file": "rea-comp\\.FXB",[\\s\\S]*?"size": )${fixture.size}`),
    `$1${fixture.size + 1}`,
  );
  assert.notEqual(altered, original, 'el manifiesto debe declarar el size del fixture');

  const manifest = await tempFile(t, 'manifest.json', altered);
  const run = await renderTable(['--manifest', manifest]);
  assert.equal(run.code, 1);
  assert.match(
    run.stderr,
    new RegExp(
      `rea-comp\\.FXB: manifest\\.json declara ${fixture.size + 1} bytes y el \\.fxb mide ${fixture.size}`,
    ),
  );
});

test('el formato de la tabla sale de la cabecera del .fxb, no de expected.bank', async (t) => {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as Manifest;
  const fixture = manifest.fixtures.find((candidate) => candidate.file === 'rea-comp.FXB')!;
  fixture.expected.bank.kind = 'FBCh';
  fixture.expected.bank.endianness = 'little';
  fixture.expected.bank.version = 2;

  const altered = await tempFile(t, 'manifest.json', JSON.stringify(manifest, null, 2));
  const fromManifest = await renderTable(['--manifest', altered]);
  const fromBytes = await renderTable([]);

  assert.equal(fromManifest.code, 0, fromManifest.stderr);
  assert.equal(fromBytes.code, 0, fromBytes.stderr);
  assert.equal(
    fromManifest.stdout,
    fromBytes.stdout,
    'cambiar expected.bank no puede cambiar la tabla: el formato lo dan los bytes',
  );
});

test('--write regenera la tabla y deja el resto del README intacto', async (t) => {
  const original = await readFile(README, 'utf8');
  const fixture = JSON.parse(await readFile(MANIFEST, 'utf8')).fixtures.find(
    (candidate: Fixture) => candidate.file === 'wam-obxd-factory.fxb',
  ) as Fixture;
  const row = rowOf(original, fixture.file);
  const alteredRow = row.replace(`| ${formatSize(fixture.size)} |`, '| 1 |');
  assert.notEqual(alteredRow, row, 'la fila debe contener el tamaño que se muta');

  const readme = await tempFile(t, 'README.md', original.replace(row, alteredRow));
  const write = await renderTable(['--write', '--readme', readme]);
  assert.equal(write.code, 0, write.stderr);
  assert.equal(await readFile(readme, 'utf8'), original, 'solo se reescribe el bloque de la tabla');

  const again = await renderTable(['--write', '--readme', readme]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /sin cambios/);
});

test('la comprobación falla si faltan los marcadores o el propósito', async (t) => {
  const readme = await readFile(README, 'utf8');
  const withoutEnd = await tempFile(t, 'README.md', readme.replace(END, ''));
  const missing = await renderTable(['--check', '--readme', withoutEnd]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /falta el marcador/);

  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as Manifest;
  const fixture = manifest.fixtures.find((candidate) => candidate.file === 'rea-comp.FXB')!;
  delete (fixture as Partial<Fixture>).purpose;
  const withoutPurpose = await tempFile(t, 'manifest.json', JSON.stringify(manifest, null, 2));
  const noPurpose = await renderTable(['--manifest', withoutPurpose]);
  assert.equal(noPurpose.code, 1);
  assert.match(noPurpose.stderr, /rea-comp\.FXB: falta "purpose"/);
});

test('la tabla no admite un .fxb que falte en el manifiesto', async (t) => {
  const manifest = await tempFile(
    t,
    'manifest.json',
    JSON.stringify({ description: 'sin entradas', fixtures: [] }, null, 2),
  );
  const run = await renderTable(['--manifest', manifest]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\.fxb no tiene entrada en manifest\.json/);
});
