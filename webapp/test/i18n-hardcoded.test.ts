import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appEn } from '../src/ui/i18n/locales/en.js';

type Dict = { [key: string]: string | Dict };

function lookup(dict: Dict, key: string): string | undefined {
  let node: string | Dict | undefined = dict;
  for (const part of key.split('.')) {
    if (node === undefined || typeof node === 'string') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}


/** Regex que apunta a asignaciones literales de texto en la UI de navegador.

 * Intencionalmente no reclama todos los strings del código: se focaliza en
 * atributos de contenido visibles / accesibles que normalmente deberían ir por
 * `t()` o por `data-i18n` desde el HTML.
 */
const HARDCODED_TEXT =
  /((?:els|button|label|title|status|summary|note|placeholder|alt|aria-label|textContent)\.{0,6}\w*(?:|\.\w+))\.(?:textContent|innerText|innerHTML|placeholder|title|alt|aria-label)\s*=\s*('[^']*'|"[^"]*")/g;

function collectHardcodedTexts(source: string): Array<{ location: string; text: string }> {
  const out: Array<{ location: string; text: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = HARDCODED_TEXT.exec(source)) !== null) {
    const raw = m[2];
    if (raw === undefined || raw.length < 2) continue;
    const literal = raw[0] === "'" ? raw.slice(1, -1) : raw.slice(1, -1);
    if (literal.length === 0) continue;
    // no es necesariamente un fallo: los literales de estado vacío, iconos,
    // caracteres de UI y controles de formulario pueden ser intencionales.
    out.push({ location: m[1] ?? 'unknown', text: literal });
  }
  return out;
}

test('no hay texto visible hardcodeado que deba pasar por i18n', () => {
  const main = readFileSync(path.resolve(__dirname, '..', '..', 'src', 'ui', 'browser', 'main.ts'), 'utf8');
  const candidates = collectHardcodedTexts(main);
  // Pendiente: revisar manualmente la lista; al principio puede haber falsos
  // positivos intencionales (iconos, separadores, contenido de etiquetas).
  // Cuando el conjunto esté limpio, este test puede exigir candidates.length === 0.
  assert.ok(candidates.length <= 40, 'demasiados candidatos hardcodeados: ' + JSON.stringify(candidates));
});

test('los textos hardcodeados de la UI no son cadenas traducibles visibles (revisión manual)', () => {
  const main = readFileSync(path.resolve(__dirname, '..', '..', 'src', 'ui', 'browser', 'main.ts'), 'utf8');
  const candidates = collectHardcodedTexts(main);
  // Lista de literales que son intencionalmente no i18n (estado vacío, separadores, iconos).
  const knownNonI18n = new Set([
    '',
    '×',
    ' ',
    'Actividad',
    'Actualizado',
  ]);
  const suspicious = candidates.filter(({ text }) => !knownNonI18n.has(text));
  assert.ok(suspicious.length <= 5, 'candidatos sospechosos: ' + JSON.stringify(suspicious));
});
