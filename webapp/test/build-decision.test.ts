import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';

/**
 * Decisión de compilación de `start.bat`.
 *
 * El `.bat` no decide nada por su cuenta: llama a
 * `scripts/build-decision.mjs` y recompila si devuelve distinto de 0. Aquí se
 * ejercita ese script con árboles de fechas controladas (cualquier sistema,
 * también en la matriz de Windows) y se comprueba que el `.bat` sigue llamándolo
 * en el orden correcto: decidir, y solo si toca, limpiar y compilar.
 */

const execFileAsync = promisify(execFile);

/** `dist-test/test` → `webapp/` → raíz del repositorio. */
const WEBAPP = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(WEBAPP, '..');
const SCRIPT = path.join(WEBAPP, 'scripts', 'build-decision.mjs');
const START_BAT = path.join(REPO, 'start.bat');

const BUILT = new Date('2026-10-01T00:00:00Z');
const SOURCE = new Date('2026-10-02T00:00:00Z');
const OLDER = new Date('2026-09-30T00:00:00Z');
const NEWER = new Date('2026-10-03T00:00:00Z');

interface Decision {
  code: number;
  out: string;
}

/** Ejecuta el script como lo hace `start.bat`, con un árbol temporal. */
async function decide(root: string): Promise<Decision> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, '--root', root]);
    return { code: 0, out: stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? -1, out: failure.stdout ?? '' };
  }
}

/** Árbol mínimo: dos puntos de entrada con `built` y fuentes con `source`. */
async function fixture(
  t: TestContext,
  dates: { built: Date; source: Date } = { built: BUILT, source: SOURCE },
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-build-decision-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const entry of ['dist/main.js', 'public/js/ui/browser/main.js']) {
    const file = path.join(root, entry);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '');
    await utimes(file, dates.built, dates.built);
  }
  // Las fuentes espejo de los dos puntos de entrada, para que el árbol base no
  // tenga huérfanos: `dist/main.js` ← `src/main.ts`.
  for (const source of [
    'src/app.ts',
    'src/main.ts',
    'src/ui/browser/main.ts',
    'tsconfig.json',
    'package.json',
  ]) {
    const file = path.join(root, source);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '');
    await utimes(file, dates.source, dates.source);
  }
  return root;
}

async function setMtime(file: string, date: Date): Promise<void> {
  await utimes(file, date, date);
}

test('con el build al día el script no pide recompilar y no escribe nada', async (t) => {
  const root = await fixture(t, { built: BUILT, source: OLDER });
  const decision = await decide(root);

  assert.equal(decision.code, 0);
  assert.equal(decision.out.trim(), '', 'el arranque normal no debe llenar la consola');
});

test('recompila cuando una fuente es más nueva que el build', async (t) => {
  for (const file of ['src/app.ts', 'tsconfig.json', 'package.json']) {
    const root = await fixture(t, { built: BUILT, source: OLDER });
    await setMtime(path.join(root, file), NEWER);

    const decision = await decide(root);
    assert.equal(decision.code, 1, `${file} más nuevo debería pedir recompilar`);
    assert.match(decision.out, /^Recompilar: /m);
    assert.match(decision.out, new RegExp(file.replace(/[.]/g, '\\.')), 'el motivo nombra el archivo');
  }
});

test('una fuente anidada en src también invalida el build', async (t) => {
  const root = await fixture(t, { built: BUILT, source: OLDER });
  const deep = path.join(root, 'src', 'library', 'deep', 'thing.ts');
  await mkdir(path.dirname(deep), { recursive: true });
  await writeFile(deep, '');
  await setMtime(deep, NEWER);

  const decision = await decide(root);
  assert.equal(decision.code, 1);
  assert.match(decision.out, /thing\.ts/);
});

test('un archivo fuera de src, tsconfig o package no invalida el build', async (t) => {
  const root = await fixture(t, { built: BUILT, source: OLDER });
  const other = path.join(root, 'test', 'algo.test.ts');
  await mkdir(path.dirname(other), { recursive: true });
  await writeFile(other, '');
  await setMtime(other, NEWER);

  const decision = await decide(root);
  assert.equal(decision.code, 0, 'los tests no entran en el build');
});

test('recompila si falta cualquiera de los dos puntos de entrada', async (t) => {
  for (const entry of ['dist/main.js', 'public/js/ui/browser/main.js']) {
    const root = await fixture(t, { built: BUILT, source: OLDER });
    await unlink(path.join(root, entry));

    const decision = await decide(root);
    assert.equal(decision.code, 1, `${entry} ausente debería pedir recompilar`);
    assert.match(decision.out, new RegExp(`falta ${entry.replace(/[.]/g, '\\.')}`));
  }
});

test('sin árbol de build (primera ejecución) recompila en vez de fallar', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-build-decision-vacio-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const decision = await decide(root);
  assert.equal(decision.code, 1);
  assert.match(decision.out, /falta dist\/main\.js/);
});

test('un .js de dist sin fuente fuerza recompilar con el build al día', async (t) => {
  const root = await fixture(t, { built: BUILT, source: OLDER });
  const orphan = path.join(root, 'dist', 'library', 'viejo.js');
  await mkdir(path.dirname(orphan), { recursive: true });
  await writeFile(orphan, '');
  await setMtime(orphan, BUILT);

  const decision = await decide(root);
  assert.equal(decision.code, 1, 'un huérfano debe pedir recompilar');
  assert.match(decision.out, /huérfano/);
  assert.match(decision.out, /dist\/library\/viejo\.js/);
  assert.doesNotMatch(decision.out, /más nuevo/, 'no es un problema de fechas');
});

test('detecta huérfanos en public/js y también los .js.map', async (t) => {
  const root = await fixture(t, { built: BUILT, source: OLDER });
  await writeFile(path.join(root, 'public', 'js', 'ui', 'browser', 'viejo.js'), '');
  await writeFile(path.join(root, 'public', 'js', 'ui', 'browser', 'otro.js.map'), '');

  const decision = await decide(root);
  assert.equal(decision.code, 1);
  assert.match(decision.out, /2 huérfano\(s\)/);
  assert.match(decision.out, /public\/js\/ui\/browser\/viejo\.js/);
  assert.match(decision.out, /public\/js\/ui\/browser\/otro\.js\.map/);
});

test('un emitido con su .ts y los archivos que no emite tsc no son huérfanos', async (t) => {
  const root = await fixture(t, { built: BUILT, source: OLDER });
  const compiled = path.join(root, 'dist', 'library', 'fxb-bank.js');
  const source = path.join(root, 'src', 'library', 'fxb-bank.ts');
  await mkdir(path.dirname(compiled), { recursive: true });
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(compiled, '');
  await writeFile(source, '');
  await setMtime(compiled, BUILT);
  await setMtime(source, OLDER);
  await writeFile(path.join(root, 'dist', 'notas.txt'), 'no es una salida de tsc');

  const decision = await decide(root);
  assert.equal(decision.code, 0);
  assert.equal(decision.out.trim(), '');
});

test('el motivo de los huérfanos se adelanta a las fechas', async (t) => {
  const root = await fixture(t, { built: BUILT, source: OLDER });
  await writeFile(path.join(root, 'dist', 'viejo.js'), '');
  await setMtime(path.join(root, 'src', 'app.ts'), NEWER);

  const decision = await decide(root);
  assert.equal(decision.code, 1);
  assert.match(decision.out, /huérfano/);
  assert.doesNotMatch(decision.out, /app\.ts es más nuevo/, 'el huérfano se explica primero');
});

test('start.bat decide con el script, limpia y solo entonces compila', async (t) => {
  const bat = await readFile(START_BAT, 'utf8').catch(() => null);
  if (bat === null) {
    t.skip('no hay start.bat en este checkout (no está versionado todavía)');
    return;
  }

  // La decisión es la del script; el .bat no vuelve a tener su propia copia.
  assert.match(bat, /node "webapp\\scripts\\build-decision\.mjs"/);
  assert.match(bat, /if not errorlevel 1 goto build_ok/);
  assert.doesNotMatch(bat, /Get-ChildItem -Path 'webapp\\src'/, 'quedó la decisión vieja en PowerShell');

  const decideAt = bat.indexOf('build-decision.mjs');
  const cleanAt = bat.indexOf('rmdir /s /q "webapp\\dist"');
  const buildAt = bat.indexOf('npm run build');
  assert.ok(decideAt !== -1 && cleanAt !== -1 && buildAt !== -1, 'faltan pasos en start.bat');
  assert.ok(decideAt < cleanAt, 'primero se decide y después se limpia');
  assert.ok(cleanAt < buildAt, 'la limpieza va antes de compilar');

  // Las dos salidas se limpian y se comprueba que desaparecieron.
  assert.match(bat, /rmdir \/s \/q "webapp\\public\\js"/);
  assert.match(bat, /if exist "webapp\\dist" goto fail_clean/);
  assert.match(bat, /if exist "webapp\\public\\js" goto fail_clean/);

  // Modo sin servidor: lo usa el job de CI de Windows.
  assert.match(bat, /if defined FXB_SKIP_SERVER goto build_only/);

  // La comprobación de huérfanos es del script al que llama el .bat.
  assert.match(bat, /huerfanos/);
  const script = await readFile(SCRIPT, 'utf8');
  assert.match(script, /orphanFiles/, 'el script expone la comprobación de huérfanos');
  assert.match(script, /public\/js/, 'el script revisa también la salida de la UI');
  assert.match(script, /huérfano/, 'el motivo dice que sobran archivos sin fuente');
});
