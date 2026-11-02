import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { SHARED_EN, SHARED_ES } from '@abdsynths/shared/i18n';
import { appEn } from '../src/ui/i18n/locales/en';
import { appEs } from '../src/ui/i18n/locales/es';

/**
 * El motor i18n devuelve la clave tal cual cuando no la encuentra, así que un
 * `t('ui.tabla.encabezado')` con una errata se ve en producción como
 * «ui.tabla.encabezado» y ningún test se entera. Este barre el código en busca
 * de claves literales y comprueba que existen en los dos diccionarios (capa 1 de
 * la suite + capa 2 de la app).
 */

const SRC = path.resolve(__dirname, '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'locales') continue;
      files.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && entry.name !== 'api-types.ts') {
      files.push(full);
    }
  }
  return files;
}

function hasKey(dictionary: unknown, key: string): boolean {
  let node: unknown = dictionary;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' && node !== '';
}

const KEY = /(?<![\w.$])t\(\s*'([^']+)'/g;

test('cada clave literal de `t()` existe en inglés y en español', () => {
  const english = [SHARED_EN, appEn];
  const spanish = [SHARED_ES, appEs];
  const missing: string[] = [];
  let checked = 0;

  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    for (const match of text.matchAll(KEY)) {
      const key = match[1]!;
      checked += 1;
      if (!english.some((dictionary) => hasKey(dictionary, key))) missing.push(`${key} · en · ${relative}`);
      if (!spanish.some((dictionary) => hasKey(dictionary, key))) missing.push(`${key} · es · ${relative}`);
    }
  }

  assert.ok(checked > 100, `se esperaban más de 100 claves, hay ${checked}`);
  assert.deepEqual(missing, [], `claves que el motor no resolvería:\n  ${missing.join('\n  ')}`);
});
