import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existingRecents,
  MAX_RECENTS,
  parseRecents,
  pathKey,
  rememberRecent,
  rememberRecentPaths,
} from '../src/ui/recents';

/**
 * El historial se guarda como JSON en `localStorage`, un sitio donde cualquier
 * versión anterior (o una persona curioseando las herramientas del navegador)
 * puede dejar basura. Estas pruebas fijan que la vista nunca se rompe por un
 * valor raro y que el orden de las sugerencias es el de uso.
 */

test('pathKey ignora mayúsculas, el tipo de barra y la barra final', () => {
  assert.equal(pathKey('  C:\\VFX\\Library  '), 'c:/vfx/library');
  assert.equal(pathKey('c:/vfx/library/'), 'c:/vfx/library');
  assert.equal(pathKey('C:\\VFX\\Library'), pathKey('c:/vfx/library/'));
});

test('parseRecents descarta JSON roto, valores que no son listas y entradas vacías', () => {
  assert.deepEqual(parseRecents(null), []);
  assert.deepEqual(parseRecents(''), []);
  assert.deepEqual(parseRecents('no es json'), []);
  assert.deepEqual(parseRecents('{"ruta":"C:\\\\VFX"}'), []);

  assert.deepEqual(
    parseRecents(
      JSON.stringify([' C:\\Bancos\\A.fxb ', '', 42, null, 'C:\\Bancos\\B.fxb']),
    ),
    ['C:\\Bancos\\A.fxb', 'C:\\Bancos\\B.fxb'],
  );
});

test('parseRecents quita duplicados y respeta el máximo', () => {
  assert.deepEqual(
    parseRecents(
      JSON.stringify(['C:\\Bancos\\A.fxb', 'c:/bancos/a.fxb/', 'C:\\Bancos\\B.fxb']),
      8,
    ),
    ['C:\\Bancos\\A.fxb', 'C:\\Bancos\\B.fxb'],
  );
  assert.deepEqual(parseRecents(JSON.stringify(['a', 'b', 'c']), 2), ['a', 'b']);
  assert.deepEqual(parseRecents(JSON.stringify(['a']), 0), []);
});

test('rememberRecent mueve la ruta al principio sin duplicarla ni mutar la lista', () => {
  const previous = ['C:\\Bancos\\A.fxb', 'C:\\Bancos\\B.fxb'];
  const next = rememberRecent(previous, 'c:/bancos/a.fxb/');

  assert.deepEqual(next, ['c:/bancos/a.fxb/', 'C:\\Bancos\\B.fxb']);
  assert.deepEqual(previous, ['C:\\Bancos\\A.fxb', 'C:\\Bancos\\B.fxb']);
});

test('rememberRecent ignora una ruta vacía y recorta al máximo', () => {
  assert.deepEqual(rememberRecent(['C:\\Bancos\\A.fxb'], '   '), ['C:\\Bancos\\A.fxb']);
  assert.deepEqual(rememberRecent(['a', 'b'], 'c', 2), ['c', 'a']);
  assert.deepEqual(rememberRecent(['a'], 'b', 0), []);
});

test('rememberRecentPaths deja la última ruta usada en primera posición', () => {
  assert.deepEqual(
    rememberRecentPaths([], ['C:\\Bancos\\A.fxb', 'C:\\Bancos\\B.fxb', 'C:\\Bancos\\C.fxb']),
    ['C:\\Bancos\\C.fxb', 'C:\\Bancos\\B.fxb', 'C:\\Bancos\\A.fxb'],
  );
  assert.deepEqual(
    rememberRecentPaths(['C:\\Bancos\\B.fxb'], ['C:\\Bancos\\A.fxb', 'c:/bancos/b.fxb']),
    ['c:/bancos/b.fxb', 'C:\\Bancos\\A.fxb'],
  );
});

test('el máximo por defecto deja ocho sugerencias', () => {
  const paths = Array.from({ length: MAX_RECENTS + 4 }, (_, index) => `C:\\Bancos\\${index}.fxb`);
  const recents = rememberRecentPaths([], paths);

  assert.equal(MAX_RECENTS, 8);
  assert.equal(recents.length, 8);
  assert.deepEqual(
    recents.map((path) => path.slice(path.lastIndexOf('\\') + 1)),
    ['11.fxb', '10.fxb', '9.fxb', '8.fxb', '7.fxb', '6.fxb', '5.fxb', '4.fxb'],
  );
});

test('existingRecents descarta las rutas que ya no están en el disco', () => {
  const previous = ['C:\\VFX\\Library', 'C:\\Bancos\\A.fxb', 'C:\\Bancos\\B.fxb'];
  const next = existingRecents(
    previous,
    [
      { path: 'C:\\VFX\\Library', exists: true, isDirectory: true },
      { path: 'C:\\Bancos\\A.fxb', exists: true, isDirectory: false },
      { path: 'C:\\Bancos\\B.fxb', exists: false, isDirectory: false },
    ],
    'file',
  );

  assert.deepEqual(next, ['C:\\Bancos\\A.fxb']);
  assert.equal(previous.length, 3, 'la lista recibida no se toca');
});

test('existingRecents exige el tipo que se espera y compara como pathKey', () => {
  const states = [
    { path: 'c:/vfx/library/', exists: true, isDirectory: false },
    { path: 'C:\\Bancos\\A.fxb', exists: true, isDirectory: true },
  ];

  // Una carpeta que ahora es un archivo no sirve como raíz, y un archivo que
  // ahora es una carpeta no sirve como banco.
  assert.deepEqual(existingRecents(['C:\\VFX\\Library'], states, 'directory'), []);
  assert.deepEqual(existingRecents(['C:\\Bancos\\A.fxb'], states, 'file'), []);
  assert.deepEqual(existingRecents(['C:\\VFX\\Library'], states, 'file'), [
    'C:\\VFX\\Library',
  ]);
});

test('existingRecents conserva lo que el servidor no contestó', () => {
  // Si la comprobación falló para una ruta (o no se llegó a preguntar), la
  // sugerencia se queda: un fallo de red no borra el historial.
  assert.deepEqual(
    existingRecents(
      ['C:\\VFX\\Library', 'C:\\Bancos\\A.fxb'],
      [{ path: 'C:\\Bancos\\A.fxb', exists: false, isDirectory: false }],
      'directory',
    ),
    ['C:\\VFX\\Library'],
  );
  assert.deepEqual(existingRecents(['C:\\VFX\\Library'], [], 'directory'), [
    'C:\\VFX\\Library',
  ]);
});
