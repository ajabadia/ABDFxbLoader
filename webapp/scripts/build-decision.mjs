/**
 * Decisión de compilación de `start.bat`: ¿hace falta recompilar el servidor y
 * la UI?
 *
 * El build solo sirve si sigue siendo actual. `tsc` estampa la fecha de emisión
 * en cada archivo que emite, así que basta comparar el punto de entrada más
 * antiguo (`dist/main.js` y `public/js/ui/browser/main.js`) con el archivo más
 * reciente de `src/`, `tsconfig*.json` y `package*.json`. Si falta alguno de
 * los dos puntos de entrada o la fuente es más nueva, hay que recompilar.
 *
 * Además, un build "al día" puede arrastrar huérfanos: `tsc` no borra lo que
 * emitió de un `.ts` que ya no existe, y esos `.js` se siguen sirviendo. Por eso
 * también se recompila si hay cualquier archivo emitido en `dist/` o
 * `public/js/` sin su `.ts` de origen, aunque ninguna fecha lo delate.
 *
 * Vive en un script de Node, y no en PowerShell dentro del `.bat`, para que la
 * decisión se pueda probar en cualquier sistema (ver
 * `test/build-decision.test.ts`): el `.bat` solo pone el glue de cmd.
 *
 * Uso: node scripts/build-decision.mjs [--root <carpeta>]
 *
 *   --root   raíz del proyecto web (por defecto, el padre de `scripts/`).
 *
 * Salida: **0** = build al día, no recompilar; **1** = recompilar (y escribe el
 * motivo en una línea). Si algo falla leyendo el árbol también sale 1: ante la
 * duda se recompila, nunca se sirve un build viejo.
 */
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Archivos que tienen que existir para considerar que hay build. */
const ENTRYPOINTS = ['dist/main.js', 'public/js/ui/browser/main.js'];
/** Carpeta de fuentes que se recorre entera. */
const SOURCE_DIR = 'src';
/** Configuración que también invalida el build si cambia. */
const SOURCE_FILE = /^(?:tsconfig.*|package.*)\.json$/;

/** Salidas de `tsc` que se revisan buscando huérfanos. */
const BUILD_OUTPUTS = ['dist', 'public/js'];
/** Un archivo emitido (`x.js` o `x.js.map`) y la raíz de su fuente. */
const EMITTED_FILE = /^(.*)\.js(?:\.map)?$/;
/** Extensiones de las que `tsc` puede emitir ese `.js`. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
/** Cuántos huérfanos se nombran en el motivo; el resto se resume. */
const ORPHAN_SAMPLE = 5;

/** Ruta para el mensaje: relativa a la raíz y siempre con `/`. */
function display(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function parseRoot(argv) {
  const index = argv.indexOf('--root');
  if (index === -1) {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  }
  const value = argv[index + 1];
  if (value === undefined || value === '') {
    throw new Error('--root necesita una carpeta');
  }
  return path.resolve(value);
}

/** Fecha de modificación, o `null` si el archivo no existe. */
async function mtime(file) {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** Archivo más reciente de un árbol, con `{ mtime, file }`. */
async function newestFile(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return null;

  let newest = null;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const child = await newestFile(full);
      if (child !== null && (newest === null || child.mtime > newest.mtime)) newest = child;
      continue;
    }
    // Los enlaces simbólicos se ignoran: no hay bucles y el build no los emite.
    if (!entry.isFile()) continue;
    const time = await mtime(full);
    if (time !== null && (newest === null || time > newest.mtime)) {
      newest = { mtime: time, file: full };
    }
  }
  return newest;
}

/**
 * Archivos emitidos en `dist/` y `public/js/` que ya no tienen un `.ts` de
 * origen: los dejó `tsc` al borrar o renombrar su fuente y se servirían igual.
 * Devuelve rutas relativas a la raíz, ordenadas.
 */
export async function orphanFiles(root) {
  const orphans = [];

  /** `outputRoot` se conserva para calcular la ruta de la fuente espejo. */
  const visit = async (dir, outputRoot) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries === null) return;

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full, outputRoot);
        continue;
      }
      if (!entry.isFile()) continue;
      if (EMITTED_FILE.exec(entry.name) === null) continue;

      // `dist/library/x.js` ← `src/library/x.ts`; `public/js/ui/x.js` ← `src/ui/x.ts`.
      const base = path.relative(outputRoot, full).replace(/\.js(?:\.map)?$/, '');
      const source = path.join(root, SOURCE_DIR, base);
      const times = await Promise.all(
        SOURCE_EXTENSIONS.map((extension) => mtime(`${source}${extension}`)),
      );
      if (times.every((time) => time === null)) orphans.push(display(root, full));
    }
  };

  for (const output of BUILD_OUTPUTS) {
    const outputRoot = path.join(root, output);
    await visit(outputRoot, outputRoot);
  }
  return orphans.sort((left, right) => left.localeCompare(right, 'en'));
}

/** Un solo renglón: `start.bat` lo imprime tal cual antes de limpiar. */
function orphanReason(orphans) {
  const shown = orphans.slice(0, ORPHAN_SAMPLE).join(', ');
  const rest = orphans.length > ORPHAN_SAMPLE ? ` y ${orphans.length - ORPHAN_SAMPLE} más` : '';
  return (
    `${orphans.length} huérfano(s) sin fuente en ${BUILD_OUTPUTS.join(' y ')}: ` +
    `${shown}${rest}`
  );
}

/** Motivo por el que hay que recompilar, o `null` si el build está al día. */
export async function buildDecision(root) {
  const built = [];
  for (const entry of ENTRYPOINTS) {
    const file = path.join(root, entry);
    const time = await mtime(file);
    if (time === null) return `falta ${entry}`;
    built.push({ mtime: time, file });
  }
  const oldest = built.reduce((left, right) => (right.mtime < left.mtime ? right : left));

  // Antes de dar el build por bueno: `tsc` no borra la salida de una fuente
  // eliminada, y esos `.js` se servirían como si existieran.
  const orphans = await orphanFiles(root);
  if (orphans.length > 0) return orphanReason(orphans);

  const sources = [];
  const tree = await newestFile(path.join(root, SOURCE_DIR));
  if (tree !== null) sources.push(tree);

  const top = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of top) {
    if (!entry.isFile() || !SOURCE_FILE.test(entry.name)) continue;
    const time = await mtime(path.join(root, entry.name));
    if (time !== null) sources.push({ mtime: time, file: path.join(root, entry.name) });
  }

  if (sources.length === 0) return `no hay fuentes en ${SOURCE_DIR}/ ni tsconfig/package`;
  const newest = sources.reduce((left, right) => (right.mtime > left.mtime ? right : left));

  if (newest.mtime > oldest.mtime) {
    return (
      `${display(root, newest.file)} es más nuevo que el build ` +
      `(${display(root, oldest.file)})`
    );
  }
  return null;
}

async function main() {
  const root = parseRoot(process.argv.slice(2));
  const reason = await buildDecision(root);
  if (reason === null) return 0;

  // Una línea: `start.bat` la deja ver tal cual antes de compilar.
  console.log(`Recompilar: ${reason}`);
  return 1;
}

process.exitCode = await main();
