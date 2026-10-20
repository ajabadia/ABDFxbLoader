import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FXB_CONFIG_DEFAULTS } from '../src/fxb-config/fxb-config.constants';
import { parseFxbConfig, trimLikeDll } from '../src/fxb-config/fxb-config.parser';
import {
  serializeFxbConfig,
  validateFxbConfig,
} from '../src/fxb-config/fxb-config.serializer';
import { FxbConfigValidationError } from '../src/fxb-config/fxb-config.types';
import type { FxbConfig } from '../src/fxb-config/fxb-config.types';

const base: FxbConfig = {
  pluginName: 'X.dll',
  defaultFxbName: 'bank.fxb',
  programDirName: 'presets',
  loadFxbBank: true,
};

test('trim: solo espacios al principio y espacios/CR/LF al final', () => {
  assert.equal(trimLikeDll('  Foo.dll  '), 'Foo.dll');
  assert.equal(trimLikeDll('\tFoo.dll'), '\tFoo.dll');
  assert.equal(trimLikeDll('Foo.dll\r'), 'Foo.dll');
});

test('archivo vacío devuelve los valores por defecto', () => {
  const { config, warnings } = parseFxbConfig('');
  assert.deepEqual(config, { ...FXB_CONFIG_DEFAULTS });
  assert.deepEqual(warnings, []);
});

const vectors: Array<{ name: string; input: string; expected: Partial<FxbConfig> }> = [
  { name: 'clave sin espacios', input: 'pluginName=MySynth.dll', expected: { pluginName: 'MySynth.dll' } },
  { name: 'espacios alrededor', input: '  pluginName  =  A.dll  \r\n', expected: { pluginName: 'A.dll' } },
  { name: 'valor con barra se trunca', input: 'pluginName = A/B.dll', expected: { pluginName: 'A' } },
  { name: 'clave case-sensitive', input: 'PluginName = X.dll', expected: { pluginName: '' } },
  { name: 'False no desactiva', input: 'loadFxbBank = False', expected: { loadFxbBank: true } },
  { name: 'NO desactiva', input: 'loadFxbBank = NO', expected: { loadFxbBank: false } },
  { name: '0 desactiva', input: 'loadFxbBank = 0', expected: { loadFxbBank: false } },
  { name: 'programDirName vacío se conserva', input: 'programDirName =', expected: { programDirName: '' } },
  { name: 'BOM rompe la clave', input: '\uFEFFpluginName = A.dll', expected: { pluginName: '' } },
  { name: 'CRLF', input: 'pluginName = A.dll\r\ndefaultFxbName = b.fxb\r\n', expected: { pluginName: 'A.dll', defaultFxbName: 'b.fxb' } },
  { name: 'comentario con /', input: 'pluginName = A.dll / comentario', expected: { pluginName: 'A.dll' } },
  { name: 'clave desconocida', input: 'foo = bar', expected: { pluginName: '' } },
];

for (const vector of vectors) {
  test(`parse: ${vector.name}`, () => {
    const { config } = parseFxbConfig(vector.input);
    for (const [key, value] of Object.entries(vector.expected)) {
      assert.equal(config[key as keyof FxbConfig], value);
    }
  });
}

test('clave duplicada: gana la última y avisa', () => {
  const { config, warnings } = parseFxbConfig(
    'pluginName = A.dll\r\npluginName = B.dll\r\n',
  );
  assert.equal(config.pluginName, 'B.dll');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /duplicada/);
});

test('valor de loadFxbBank no reconocido: conserva el anterior y avisa', () => {
  const { config, warnings } = parseFxbConfig('loadFxbBank = off');
  assert.equal(config.loadFxbBank, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /no reconocido/);
});

test('serializa las cuatro claves con CRLF y salto final', () => {
  const text = serializeFxbConfig(base);
  assert.equal(
    text,
    'pluginName = X.dll\r\ndefaultFxbName = bank.fxb\r\nprogramDirName = presets\r\nloadFxbBank = yes\r\n',
  );
  assert.equal(text.charCodeAt(0), 'p'.charCodeAt(0));
});

test('round-trip estable', () => {
  const parsed = parseFxbConfig(serializeFxbConfig(base)).config;
  assert.deepEqual(parsed, base);
});

test('round-trip con acentos CP-1252', () => {
  const config = { ...base, pluginName: 'Órgano.dll' };
  const parsed = parseFxbConfig(serializeFxbConfig(config)).config;
  assert.equal(parsed.pluginName, 'Órgano.dll');
});

test('validate acepta los valores por defecto', () => {
  assert.deepEqual(validateFxbConfig({ ...FXB_CONFIG_DEFAULTS }), []);
});

test('validate rechaza valores de más de 63 caracteres', () => {
  const issues = validateFxbConfig({ ...base, pluginName: 'x'.repeat(64) });
  assert.equal(issues.length, 1);
  assert.match(issues[0] ?? '', /máximo es 63/);
});

test('validate rechaza "/" en valores', () => {
  const issues = validateFxbConfig({ ...base, defaultFxbName: 'a/b.fxb' });
  assert.match(issues[0] ?? '', /no puede contener/);
});

test('validate rechaza saltos de línea', () => {
  const issues = validateFxbConfig({ ...base, pluginName: 'A\nB.dll' });
  assert.match(issues[0] ?? '', /control/);
});

test('validate rechaza programDirName vacío', () => {
  const issues = validateFxbConfig({ ...base, programDirName: '   ' });
  assert.match(issues[0] ?? '', /no puede estar vacío/);
});

test('validate rechaza caracteres fuera de ANSI', () => {
  const issues = validateFxbConfig({ ...base, pluginName: '€.dll' });
  assert.match(issues[0] ?? '', /no es representable/);
});

test('serialize lanza FxbConfigValidationError', () => {
  assert.throws(
    () => serializeFxbConfig({ ...base, pluginName: 'x'.repeat(64) }),
    FxbConfigValidationError,
  );
});
