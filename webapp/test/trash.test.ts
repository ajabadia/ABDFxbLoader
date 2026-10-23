import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { moveToTrash } from '../src/common/trash';

/**
 * «Descartar respaldo» no borra: mueve el `.orig` a la papelera. En Windows se
 * usa la Papelera de reciclaje real; en Linux/macOS la del escritorio. Los tests
 * comprueban que el archivo sale de su carpeta, que vuelve a ser recuperable
 * desde la papelera y qué le cuentan a la vista para encontrarlo.
 */

async function tempDir(t: { after: (fn: () => Promise<void>) => void }, prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('mueve el archivo a la papelera del sistema y dice dónde recuperarlo', async (t) => {
  const dir = await tempDir(t, 'fxb-trash-');
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
});

test('acepta dos respaldos con el mismo nombre sin pisarse', async (t) => {
  const dir = await tempDir(t, 'fxb-trash-dup-');
  const first = path.join(dir, 'a', 'Rhodes.fxb.orig');
  const second = path.join(dir, 'b', 'Rhodes.fxb.orig');
  await mkdir(path.dirname(first), { recursive: true });
  await mkdir(path.dirname(second), { recursive: true });
  await writeFile(first, 'uno');
  await writeFile(second, 'dos');

  await moveToTrash(first);
  await moveToTrash(second);

  assert.equal(await readFile(first).catch(() => null), null);
  assert.equal(await readFile(second).catch(() => null), null);
});

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
