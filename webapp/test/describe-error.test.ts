import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FxbApiError } from '../src/client/fxb-client';
import { describeError } from '../src/ui/browser/api';

/**
 * `describeError` es el único sitio donde la vista convierte un fallo en texto.
 * El e2e comprueba el resultado pintado; aquí se fijan las tres ramas: el
 * mensaje del API con sus `issues`, los fallos de red y lo que no es del API.
 */

test('describeError: el mensaje del API y sus issues, uno por línea', () => {
  const error = new FxbApiError(
    400,
    {
      message: 'Metadatos no válidos',
      issues: ['common.notes: 256 caracteres; el máximo es 255', 'common.id: no puede estar vacío'],
    },
    'Metadatos no válidos',
  );

  assert.equal(
    describeError(error),
    'Metadatos no válidos\n' +
      'common.notes: 256 caracteres; el máximo es 255\n' +
      'common.id: no puede estar vacío',
  );
});

test('describeError: un error del API sin issues no añade líneas', () => {
  const message = 'El archivo cambió en disco desde la última lectura';
  const error = new FxbApiError(409, { message }, message);

  assert.equal(describeError(error), message);
});

test('describeError: issues vacíos o que no son lista se ignoran', () => {
  const bodies: unknown[] = [
    { message: 'x', issues: [] },
    { message: 'x', issues: 'no-es-lista' },
    { message: 'x' },
    null,
  ];

  for (const body of bodies) {
    assert.equal(
      describeError(new FxbApiError(400, body, 'x')),
      'x',
      `body=${JSON.stringify(body)}`,
    );
  }
});

test('describeError: un fallo de red se explica sin el TypeError crudo', () => {
  for (const message of [
    'fetch failed',
    'NetworkError when attempting to fetch resource.',
    'Failed to fetch',
  ]) {
    assert.equal(
      describeError(new TypeError(message)),
      `No se pudo contactar con el servidor: ${message}`,
      message,
    );
  }
});

test('describeError: un TypeError que no es de red conserva su mensaje', () => {
  // La vista no debe disfrazar de «no se pudo contactar» un fallo de JavaScript.
  assert.equal(describeError(new TypeError('x is not a function')), 'x is not a function');
});

test('describeError: errores que no vienen del API', () => {
  assert.equal(describeError(new Error('algo falló')), 'algo falló');
  assert.equal(describeError('texto suelto'), 'texto suelto');
  assert.equal(describeError(42), '42');
  assert.equal(describeError(null), 'null');
  assert.equal(describeError(undefined), 'undefined');
});
