import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeVfxinfo,
  dllBasename,
  patchVfxinfo,
} from '../src/library/vfxinfo';

test('analyze encuentga dll_name y extrae el nombre base', () => {
  const text = 'name: X\r\ndll_name: Folder/MySynth.dll\r\nversion: 1\r\n';

  const analysis = analyzeVfxinfo(text);

  assert.ok(analysis);
  assert.equal(analysis.lineIndex, 1);
  assert.equal(analysis.dllNameValue, 'Folder/MySynth.dll');
  assert.equal(analysis.pluginName, 'MySynth.dll');
  assert.equal(analysis.hasLoader, false);
});

test('analyze acepta rutas con barra invertida y detecta el loader', () => {
  const analysis = analyzeVfxinfo('dll_name: Folder\\fxbLoader.dll\n');

  assert.ok(analysis);
  assert.equal(analysis.pluginName, 'fxbLoader.dll');
  assert.equal(analysis.hasLoader, true);
});

test('analyze devuelve null sin dll_name', () => {
  assert.equal(analyzeVfxinfo('name: X\nversion: 1\n'), null);
  assert.equal(analyzeVfxinfo(''), null);
});

test('patch reescribe solo la línea dll_name y conserva CRLF', () => {
  const original = 'name: X\r\ndll_name: Old/Old.dll\r\nversion: 1\r\n';

  const patched = patchVfxinfo(original, 'New');

  assert.equal(
    patched.text,
    'name: X\r\ndll_name: New/fxbLoader.dll\r\nversion: 1\r\n',
  );
  assert.equal(patched.analysis.pluginName, 'Old.dll');
});

test('patch usa CRLF si dll_name era la última línea sin terminador', () => {
  const patched = patchVfxinfo('name: X\ndll_name: Old.dll', 'New');

  assert.equal(patched.text, 'name: X\ndll_name: New/fxbLoader.dll\r\n');
});

test('patch conserva LF en archivos LF', () => {
  const patched = patchVfxinfo('a\r\ndll_name: Old.dll\nb\n', 'New');

  assert.equal(patched.text, 'a\r\ndll_name: New/fxbLoader.dll\nb\n');
});

test('patch falla si no hay dll_name', () => {
  assert.throws(() => patchVfxinfo('name: X\n', 'New'), /dll_name/);
});

test('dllBasename se queda con el último segmento', () => {
  assert.equal(dllBasename('a/b/c.dll'), 'c.dll');
  assert.equal(dllBasename('a\\b\\c.dll'), 'c.dll');
  assert.equal(dllBasename('c.dll'), 'c.dll');
  assert.equal(dllBasename(''), '');
});
