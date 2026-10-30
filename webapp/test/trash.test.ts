import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { moveToTrash } from '../src/common/trash';
import { recycleBinSkipReason } from './helpers/environment';

/**
 * «Descartar respaldo» no borra: mueve el `.orig` a la papelera. En Windows se
 * usa la Papelera de reciclaje real; en Linux/macOS la del escritorio. Los tests
 * comprueban que el archivo sale de su carpeta, que vuelve a ser recuperable
 * desde la papelera y qué le cuentan a la vista para encontrarlo.
 */

/**
 * Este fichero es el único que debe usar la papelera REAL: esa integración es
 * lo que prueba. Se fuerza el modo real aunque el entorno pida lo contrario y
 * se retira lo que se mete (ver `purgarEntradasPropias`), para que ninguna
 * corrida engorde la Papelera. Además, en Linux/macOS la rama por defecto
 * escribiría en la papelera del usuario: se apunta a un temporal que se borra
 * al terminar (en Windows la rama nativa no la lee).
 */
delete process.env['FXB_TRASH_MODE'];

/**
 * Las pruebas que miran la Papelera de reciclaje REAL necesitan Windows y su
 * PowerShell. Donde no los haya se omiten con el motivo: usar la papelera del
 * escritorio de Linux no prueba lo que estas pruebas dicen probar.
 */
const noHayPapeleraReal = recycleBinSkipReason();

let papeleraTemporal: string | undefined;
before(async () => {
  if (process.platform === 'win32') return;
  papeleraTemporal = await mkdtemp(path.join(tmpdir(), 'fxb-xdg-home-'));
  process.env['XDG_DATA_HOME'] = papeleraTemporal;
});
after(async () => {
  if (papeleraTemporal === undefined) return;
  delete process.env['XDG_DATA_HOME'];
  await rm(papeleraTemporal, { recursive: true, force: true });
});

async function tempDir(t: { after: (fn: () => Promise<void>) => void }, prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * Los índices `C:\$Recycle.Bin\<SID>\$I<aleatorio>` guardan, en UTF-16LE, la
 * ruta original junto a su dato `$R` (mismo sufijo). Este lector devuelve la
 * ruta de un índice, o `null` si el formato no se entiende.
 */
async function leerRutaIndice(indice: string): Promise<string | null> {
  let b: Buffer;
  try {
    b = await readFile(indice);
  } catch {
    return null;
  }
  if (b.length < 20) return null;
  const version = b.readUInt32LE(0);
  let length: number;
  let offset: number;
  if (version === 1) {
    length = b.readUInt32LE(16);
    offset = 20;
  } else if (version === 2 && b.readUInt32LE(4) === 0) {
    length = b.readUInt32LE(24);
    offset = 28;
  } else {
    return null;
  }
  if (offset + length * 2 > b.length) return null;
  return b.subarray(offset, offset + length * 2).toString('utf16le');
}

/**
 * Retira de la Papelera real las entradas cuya ruta original empieza por
 * `prefijo`: solo los archivos que acaba de mandar este test (un temporal
 * propio y fresco). Lo demás queda intacto. Devuelve cuántas retiró, o `null`
 * si no se pudo inspeccionar la papelera (sin acceso a `$Recycle.Bin`, como en
 * un runner de CI): ahí no hay nada que comprobar y la papelera es efímera,
 * así que un permiso del entorno no puede convertirse en un fallo del código.
 */
async function purgarEntradasPropias(prefijo: string): Promise<number | null> {
  if (process.platform !== 'win32') return null;
  const bin = path.join(path.parse(prefijo).root, '$Recycle.Bin');
  let sids: string[] = [];
  try {
    sids = (await readdir(bin, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  let retiradas = 0;
  let carpetasLegibles = 0;
  for (const sid of sids) {
    const carpeta = path.join(bin, sid);
    let ficheros: string[];
    try {
      ficheros = await readdir(carpeta);
    } catch {
      continue; // carpeta de sistema u otro usuario: acceso denegado
    }
    carpetasLegibles += 1;
    for (const nombre of ficheros) {
      if (!nombre.startsWith('$I') || nombre.length <= 2) continue;
      const original = await leerRutaIndice(path.join(carpeta, nombre));
      if (original === null || !original.toLowerCase().startsWith(prefijo.toLowerCase())) continue;
      await rm(path.join(carpeta, nombre), { force: true });
      await rm(path.join(carpeta, '$R' + nombre.slice(2)), { force: true, recursive: true });
      retiradas += 1;
    }
  }
  // Ninguna carpeta legible: se pudo listar `$Recycle.Bin` pero no entrar en
  // ninguna (permisos del runner), así que no se puede asegurar nada.
  return carpetasLegibles === 0 ? null : retiradas;
}

test(
  'mueve el archivo a la papelera del sistema y dice dónde recuperarlo',
  { skip: noHayPapeleraReal },
  async (t) => {
    const dir = await tempDir(t, 'fxb-trash-');
    // Lo que esta prueba mande a la Papelera real se retira al terminar.
    t.after(async () => {
      const retiradas = await purgarEntradasPropias(dir);
      if (retiradas === null) return; // sin acceso a la papelera (CI): nada que comprobar
      assert.equal(retiradas, 1, 'la entrada de este test debe salir de la Papelera real');
    });
    const target = path.join(dir, 'Rhodes.fxb.orig');
    await writeFile(target, 'respaldo');

    const trash = await moveToTrash(target);

    assert.equal(await readFile(target).catch(() => null), null, 'el archivo ya no está en su sitio');
    assert.notEqual(trash.label, '');
    assert.match(trash.label, /Papelera/);
    assert.match(trash.hint, /recuperarlo|Restaurar|Volver a poner/);

    if (process.platform === 'win32') {
      assert.equal(trash.path, null, 'Windows no expone una ruta a su Papelera de reciclaje');
    } else {
      assert.equal(typeof trash.path, 'string');
    }
  },
);

test(
  'acepta dos respaldos con el mismo nombre sin pisarse',
  { skip: noHayPapeleraReal },
  async (t) => {
    const dir = await tempDir(t, 'fxb-trash-dup-');
    const first = path.join(dir, 'a', 'Rhodes.fxb.orig');
    const second = path.join(dir, 'b', 'Rhodes.fxb.orig');
    await mkdir(path.dirname(first), { recursive: true });
    await mkdir(path.dirname(second), { recursive: true });
    await writeFile(first, 'uno');
    await writeFile(second, 'dos');

    // Las dos entradas de este test se retiran de la Papelera real al terminar.
    t.after(async () => {
      const retiradas = await purgarEntradasPropias(dir);
      if (retiradas === null) return; // sin acceso a la papelera (CI): nada que comprobar
      assert.equal(retiradas, 2, 'las dos entradas de este test deben salir de la Papelera real');
    });

    await moveToTrash(first);
    await moveToTrash(second);

    assert.equal(await readFile(first).catch(() => null), null);
    assert.equal(await readFile(second).catch(() => null), null);
  },
);

test('si el archivo no existe, falla en vez de decir que lo movió', async (t) => {
  const dir = await tempDir(t, 'fxb-trash-missing-');
  await assert.rejects(moveToTrash(path.join(dir, 'no-existe.fxb.orig')));
});

test('la papelera XDG de Linux deja el archivo y su .trashinfo', async (t) => {
  const dataHome = await tempDir(t, 'fxb-xdg-');
  const previous = process.env['XDG_DATA_HOME'];
  process.env['XDG_DATA_HOME'] = dataHome;
  t.after(() => {
    if (previous === undefined) delete process.env['XDG_DATA_HOME'];
    else process.env['XDG_DATA_HOME'] = previous;
  });

  const dir = await tempDir(t, 'fxb-trash-xdg-');
  const target = path.join(dir, 'Rhodes ñ.fxb.orig');
  await writeFile(target, 'respaldo');

  // Se fuerza la rama de Linux para probarla también desde Windows.
  const trash = await moveToTrash(target, 'linux');

  const files = path.join(dataHome, 'Trash', 'files');
  const info = path.join(dataHome, 'Trash', 'info');
  assert.deepEqual(await readdir(files), ['Rhodes ñ.fxb.orig']);
  assert.deepEqual(await readdir(info), ['Rhodes ñ.fxb.orig.trashinfo']);
  assert.equal(trash.path, files);
  assert.equal(await readFile(path.join(files, 'Rhodes ñ.fxb.orig'), 'utf8'), 'respaldo');

  const contents = await readFile(path.join(info, 'Rhodes ñ.fxb.orig.trashinfo'), 'utf8');
  assert.match(contents, /^\[Trash Info\]\n/);
  assert.match(contents, /\nDeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\n/);

  const pathLine = contents.split('\n').find((line) => line.startsWith('Path='));
  assert.ok(pathLine, 'el .trashinfo debe guardar la ruta original');
  const decoded = pathLine
    .slice('Path='.length)
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/');
  assert.equal(decoded, path.resolve(target), 'la ruta se guarda codificada pero completa');
});

/**
 * Dos respaldos distintos pueden llamarse igual (`Rhodes.fxb.orig` de dos
 * plugins). La papelera XDG usa el `.trashinfo` como índice, así que el nombre
 * libre hay que buscarlo ahí: si se busca en `files/` el segundo respaldo pisa
 * al primero y su escritura falla con `EEXIST`. Se fuerza la rama de Linux para
 * cubrirlo también desde Windows, donde la rama nativa es otra.
 */
test('la papelera XDG no pisa un respaldo que ya tiene ese nombre', async (t) => {
  const dataHome = await tempDir(t, 'fxb-xdg-dup-');
  const previous = process.env['XDG_DATA_HOME'];
  process.env['XDG_DATA_HOME'] = dataHome;
  t.after(() => {
    if (previous === undefined) delete process.env['XDG_DATA_HOME'];
    else process.env['XDG_DATA_HOME'] = previous;
  });

  const first = path.join(await tempDir(t, 'fxb-trash-uno-'), 'Rhodes.fxb.orig');
  const second = path.join(await tempDir(t, 'fxb-trash-dos-'), 'Rhodes.fxb.orig');
  await writeFile(first, 'uno');
  await writeFile(second, 'dos');

  await moveToTrash(first, 'linux');
  await moveToTrash(second, 'linux');

  const files = path.join(dataHome, 'Trash', 'files');
  const info = path.join(dataHome, 'Trash', 'info');
  assert.deepEqual((await readdir(files)).sort(), ['Rhodes.fxb (1).orig', 'Rhodes.fxb.orig']);
  assert.deepEqual((await readdir(info)).sort(), [
    'Rhodes.fxb (1).orig.trashinfo',
    'Rhodes.fxb.orig.trashinfo',
  ]);

  // El contenido importa: pisar el primero lo dejaría con los bytes del segundo.
  assert.equal(await readFile(path.join(files, 'Rhodes.fxb.orig'), 'utf8'), 'uno');
  assert.equal(await readFile(path.join(files, 'Rhodes.fxb (1).orig'), 'utf8'), 'dos');
});

/**
 * El shell de Windows puede bloquearse para siempre al hablar con la Papelera
 * (ya pasó al quedarse colgada su vista). El envío no debe colgar: el timeout
 * mata a PowerShell y cuenta el fallo con el archivo aún en su sitio. Se fuerza
 * un timeout de 1 ms para que dispare antes de que PowerShell arranque.
 */
test(
  'el timeout aborta el envío si la Papelera no responde',
  { skip: noHayPapeleraReal },
  async (t) => {
    const dir = await tempDir(t, 'fxb-trash-timeout-');
    const target = path.join(dir, 'Rhodes.fxb.orig');
    await writeFile(target, 'respaldo');

    const previous = process.env['FXB_TRASH_TIMEOUT_MS'];
    process.env['FXB_TRASH_TIMEOUT_MS'] = '1';
    t.after(() => {
      if (previous === undefined) delete process.env['FXB_TRASH_TIMEOUT_MS'];
      else process.env['FXB_TRASH_TIMEOUT_MS'] = previous;
    });

    await assert.rejects(moveToTrash(target), /no respondió en 1 ms/);

    // PowerShell murió sin llegar a mover nada: el respaldo sigue intacto.
    assert.equal(await readFile(target, 'utf8'), 'respaldo');
  },
);
