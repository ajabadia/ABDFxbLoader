import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appEn } from '../src/ui/i18n/locales/en.js';
import { appEs } from '../src/ui/i18n/locales/es.js';

type Dict = { [key: string]: string | Dict };

function keys(obj: Dict, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix === '' ? key : prefix + '.' + key;
    if (value !== null && typeof value === 'object') out.push(...keys(value, full));
    else out.push(full);
  }
  return out.sort();
}

function lookup(dict: Dict, key: string): string | undefined {
  let node: string | Dict | undefined = dict;
  for (const part of key.split('.')) {
    if (node === undefined || typeof node === 'string') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

test('en.ts y es.ts mantienen el 100% de las claves', () => {
  assert.deepEqual(keys(appEn), keys(appEs));
  assert.ok(keys(appEn).length > 150);
});

test('cada texto marcado en index.html existe en los dos idiomas', () => {
  const html = readFileSync(path.resolve(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  const used = new Set<string>();
  for (const match of html.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) {
    used.add(match[1]!);
  }
  assert.ok(used.size > 100);
  for (const key of used) {
    assert.ok(lookup(appEn, key), 'falta en inglés: ' + key);
    assert.ok(lookup(appEs, key), 'falta en español: ' + key);
  }
});

test('el diccionario inglés traduce de verdad el dominio de la aplicación', () => {
  assert.equal(lookup(appEn, 'common.close'), 'Close');
  assert.equal(lookup(appEn, 'nav.settingsTitle'), 'General settings');
  assert.equal(lookup(appEs, 'nav.settingsTitle'), 'Ajustes generales');
  assert.notEqual(lookup(appEn, 'banks.defaultBank'), lookup(appEs, 'banks.defaultBank'));
});
