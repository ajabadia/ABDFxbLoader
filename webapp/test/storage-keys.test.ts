import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as keys from '../src/ui/storage-keys';

/**
 * Dos prefijos conviven a propósito: `abdsynths.*` lo comparte la suite (el
 * motor de i18n de `@abdsynths/shared` escribe `abdsynths.locale`) y
 * `fxbLoader.*` es estado propio del producto. Lo que no puede pasar es que una
 * clave nueva se cuele sin prefijo o que el idioma se mueva a otro sitio.
 */
test('las claves de localStorage llevan prefijo y el idioma es el de la suite', () => {
  const entries = Object.entries(keys) as [string, string][];
  assert.ok(entries.length >= 8, `se esperaban al menos 8 claves, hay ${entries.length}`);

  for (const [name, value] of entries) {
    assert.match(
      value,
      /^(fxbLoader|abdsynths)\./,
      `${name} = ${value}: falta el prefijo de producto o de suite`,
    );
  }

  assert.equal(keys.STORAGE_LOCALE, 'abdsynths.locale');
  const own = entries.filter(([, value]) => value.startsWith('fxbLoader.'));
  assert.equal(own.length, entries.length - 1, 'solo el idioma viene de la suite');
});

test('ninguna clave se repite', () => {
  const values = Object.values(keys) as string[];
  assert.equal(new Set(values).size, values.length);
});
