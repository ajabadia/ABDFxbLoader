import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendPaths, parentDir } from '../src/ui/picker';

/**
 * Los botones de diálogo escriben rutas de Windows que llegan del servidor. Si
 * `initialDir` no es una carpeta, PowerShell la ignora; si `appendPaths` repite
 * líneas, importar dos veces el mismo archivo lo mandaría duplicado al API. Estas
 * dos funciones son la única lógica del flujo que no depende del DOM.
 */

test('parentDir devuelve la carpeta de una ruta, con \\ o /', () => {
  assert.equal(parentDir('C:\\Bancos\\Rhodes.fxb'), 'C:\\Bancos');
  assert.equal(parentDir('C:/Bancos/Rhodes.fxb'), 'C:/Bancos');
  assert.equal(parentDir('C:\\Bancos\\sub\\'), 'C:\\Bancos');
  assert.equal(parentDir('  C:\\Bancos\\Rhodes.fxb  '), 'C:\\Bancos');
  // La raíz de una unidad no tiene carpeta padre utilizable.
  assert.equal(parentDir('C:\\Rhodes.fxb'), 'C:\\');
  assert.equal(parentDir('Rhodes.fxb'), null);
  assert.equal(parentDir(''), null);
});

test('appendPaths suma rutas sin repetir ni perder lo escrito', () => {
  assert.equal(appendPaths('', ['C:\\a.fxb']), 'C:\\a.fxb');
  assert.equal(appendPaths('C:\\a.fxb', ['C:\\b.fxb']), 'C:\\a.fxb\nC:\\b.fxb');

  assert.equal(
    appendPaths('C:\\a.fxb\n\n  C:\\b.fxb  ', ['C:\\b.fxb', 'C:\\a.fxb', 'C:\\c.fxb']),
    'C:\\a.fxb\nC:\\b.fxb\nC:\\c.fxb',
    'limpia líneas vacías y conserva el orden de la lista',
  );

  assert.equal(appendPaths('C:\\a.fxb', ['  ', '']), 'C:\\a.fxb', 'no añade líneas vacías');
  assert.equal(appendPaths('', []), '', 'cancelar el diálogo no cambia el texto');
});
