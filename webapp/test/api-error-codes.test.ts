import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_ERROR_CODES, apiErrorDetails } from '../src/common/api-errors';
import {
  LibraryOperationError,
  LibraryPathError,
  PluginStateError,
} from '../src/library/library.types';
import { appEn } from '../src/ui/i18n/locales/en';
import { appEs } from '../src/ui/i18n/locales/es';

/**
 * El código es lo único que la vista puede traducir: si un `throw` nuevo se
 * olvida de su texto, el usuario acaba viendo el mensaje del servidor en
 * castellano. Esta prueba exige texto para todos los códigos declarados.
 */
function textOf(dictionary: unknown, key: string): unknown {
  let node: unknown = dictionary;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

test('cada código declarado tiene texto en inglés y en español', () => {
  const missing: string[] = [];
  for (const code of API_ERROR_CODES) {
    for (const [locale, dictionary] of [
      ['en', appEn],
      ['es', appEs],
    ] as const) {
      const value = textOf(dictionary, `msg.apiError.${code}`);
      if (typeof value !== 'string' || value === '') missing.push(code + ' · ' + locale);
    }
  }
  assert.deepEqual(missing, [], 'códigos sin traducción: ' + missing.join(' | '));
});

test('los códigos no se repiten', () => {
  assert.equal(new Set(API_ERROR_CODES).size, API_ERROR_CODES.length);
});

test('el código y sus parámetros viajan con la excepción', () => {
  assert.deepEqual(apiErrorDetails(new LibraryPathError('x', 'plugsMissing', { 0: 'C:/lib' })), {
    code: 'plugsMissing',
    params: { 0: 'C:/lib' },
  });
  assert.deepEqual(apiErrorDetails(new LibraryOperationError('x', 'fileEmpty')), { code: 'fileEmpty' });
  assert.deepEqual(apiErrorDetails(new PluginStateError('x', 'loaderMissing', { 0: 'OB-Xd' })), {
    code: 'loaderMissing',
    params: { 0: 'OB-Xd' },
  });
  assert.equal(apiErrorDetails(new LibraryPathError('sin código')), null);
  assert.equal(apiErrorDetails(new Error('ajeno')), null);
  assert.equal(apiErrorDetails(null), null);
});
