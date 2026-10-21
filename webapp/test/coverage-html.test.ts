import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

// El compilado vive en `dist-test/test`, así que la raíz de webapp queda dos
// niveles arriba (igual que los recursos que usan los demás tests).
const converter = path.resolve(__dirname, '..', '..', 'scripts', 'lcov-html.mjs');

function convert(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [converter, ...args], { cwd, encoding: 'utf8' });
}

const LCOV = [
  'TN:',
  'SF:src/a.ts',
  'FN:1,add',
  'FNDA:4,add',
  'FNF:1',
  'FNH:1',
  'DA:1,4',
  'DA:2,4',
  'DA:3,0',
  'DA:4,0',
  'LF:4',
  'LH:2',
  'BRDA:2,0,0,4',
  'BRDA:2,0,1,-',
  'BRF:2',
  'BRH:1',
  'end_of_record',
  'TN:',
  'SF:src/b.ts',
  'DA:1,1',
  'LF:1',
  'LH:1',
  'end_of_record',
  '',
].join('\n');

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fxb-coverage-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(
    path.join(dir, 'src', 'a.ts'),
    ['export function add(a: number, b: number) {', '  if (a < b) return b;', '  return a + b;', '}'].join('\n'),
  );
  await writeFile(path.join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
  await writeFile(path.join(dir, 'lcov.info'), LCOV);
  return dir;
}

test('convierte el lcov a un índice con porcentajes y una página por archivo', async (t) => {
  const dir = await fixture(t);

  const result = convert(dir, 'lcov.info', 'html', '--root', '.');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 archivo\(s\)/);

  const index = await readFile(path.join(dir, 'html', 'index.html'), 'utf8');
  assert.match(index, /Líneas/);
  assert.match(index, /60\.00 %/); // 2 de 4 líneas de a.ts + 1 de 1 de b.ts
  assert.match(index, /50\.00 %/); // una de dos ramas
  assert.match(index, /100\.00 %/); // la única función
  assert.match(index, /src\/a\.ts/);
  assert.match(index, /3-4/); // líneas sin cubrir
  assert.match(index, /href="files\//);
  assert.match(index, /href="style.css"/);

  const pages = await readdir(path.join(dir, 'html', 'files'));
  assert.equal(pages.length, 2);

  const contents = await Promise.all(
    pages.map((page) => readFile(path.join(dir, 'html', 'files', page), 'utf8')),
  );
  const pageA = contents.find((html) => html.includes('<h1>src/a.ts</h1>'));
  assert.ok(pageA, 'falta la página de src/a.ts');
  // El código se muestra escapado y las líneas con 0 éxitos van marcadas.
  assert.match(pageA, /a &lt; b/);
  assert.equal(pageA.match(/class="uncovered"/g)?.length, 2);
  assert.equal(pageA.match(/class="covered"/g)?.length, 2);
  assert.match(pageA, /href="..\/index.html"/);
  assert.match(await readFile(path.join(dir, 'html', 'style.css'), 'utf8'), /--uncovered/);
});

test('no inventa porcentajes cuando el lcov no trae archivos', async (t) => {
  const dir = await fixture(t);
  await writeFile(path.join(dir, 'vacio.info'), 'TN:\n');

  const result = convert(dir, 'vacio.info', 'salida');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no hay registros de cobertura/);
});

test('falla con un mensaje claro si el lcov no existe', async (t) => {
  const dir = await fixture(t);

  const result = convert(dir, 'no-existe.info', 'html');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /No se pudo generar el informe HTML/);
});

test('exige las dos rutas de entrada', () => {
  const result = convert(process.cwd());

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Uso: node scripts\/lcov-html\.mjs/);
});
