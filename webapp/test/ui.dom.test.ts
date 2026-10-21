import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  elementIds,
  htmlIdReferences,
  parseHtml,
  querySelectorAll,
  scanUiSource,
} from './helpers/ui-dom';

/**
 * Estas pruebas fijan el comportamiento del verificador de la UI: si el parser
 * o el matcher dejan de distinguir un elemento existente de uno que no lo está,
 * el test grande de `ui.test.ts` pasaría por la razón equivocada.
 */

const HTML = `
<main id="page" class="card wide">
  <form id="scan-form">
    <label for="library-root">Raíz</label>
    <input id="library-root" type="text" />
    <button id="scan-button" data-action="scan" type="button">Escanear</button>
  </form>
  <section id="banks" aria-labelledby="banks-title" hidden>
    <h2 id="banks-title">Bancos</h2>
    <table>
      <tbody id="banks-rows"></tbody>
    </table>
    <template id="row-template">
      <tr class="row">
        <td data-field="name"></td>
        <td><button data-action="toggle" type="button"></button></td>
      </tr>
    </template>
  </section>
  <a href="#banks">Ir a bancos</a>
  <a href="#">Arriba</a>
</main>
`;

function count(selector: string): number {
  return querySelectorAll(parseHtml(HTML), selector).length;
}

test('el matcher resuelve etiquetas, ids, clases y atributos', () => {
  assert.equal(count('button'), 2);
  assert.equal(count('tr'), 1, 'la plantilla también cuenta');
  assert.equal(count('#banks-rows'), 1);
  assert.equal(count('.card'), 1);
  assert.equal(count('main.card.wide'), 1);
  assert.equal(count('[data-action]'), 2);
  assert.equal(count('[data-action="scan"]'), 1);
  assert.equal(count('td[data-field="name"]'), 1);

  // Nada de esto existe: es justo lo que el test debe detectar.
  assert.equal(count('#banks-titlex'), 0);
  assert.equal(count('[data-field="nombre"]'), 0);
  assert.equal(count('button[type="submit"]'), 0);
  assert.equal(count('.cards'), 0);
});

test('el matcher respeta descendientes, hijos y grupos', () => {
  assert.equal(count('#banks table'), 1);
  assert.equal(count('#banks #banks-rows'), 1);
  assert.equal(count('main > form'), 1);
  assert.equal(count('form > button'), 1);
  // El botón está dentro de un `td`, no es hijo directo de la sección.
  assert.equal(count('#banks > button'), 0);
  assert.equal(count('#banks > table'), 1);
  assert.equal(count('h2, #banks-rows'), 2);
  assert.equal(count('#nope, .nope'), 0);
});

test('un selector fuera del subconjunto soportado falla en vez de ignorarse', () => {
  const document = parseHtml(HTML);
  assert.throws(() => querySelectorAll(document, 'tr:first-child'), /selector no soportado/);
  assert.throws(() => querySelectorAll(document, 'div + p'), /selector no soportado/);
  assert.throws(() => querySelectorAll(document, ''), /selector vacío/);
});

test('el escáner encuentra ids y selectores en cualquier API de DOM', () => {
  const source = [
    "const form = byId<HTMLFormElement>('scan-form');",
    "const direct = document.getElementById('library-root');",
    "const rows = form.querySelector('#banks-rows');",
    "form.querySelectorAll<HTMLButtonElement>('button');",
    "row.closest('[data-field=\"name\"]');",
    "node.matches('tr.row');",
    "query<HTMLElement>(row, '[data-field=\"status\"]');",
  ].join('\n');

  const references = scanUiSource(source, 'browser/main.ts');

  assert.deepEqual(
    references.ids.map((reference) => [reference.value, reference.line]),
    [
      ['scan-form', 1],
      ['library-root', 2],
      ['banks-rows', 3],
    ],
  );
  assert.deepEqual(
    references.selectors.map((reference) => reference.value),
    ['#banks-rows', 'button', '[data-field="name"]', 'tr.row', '[data-field="status"]'],
  );
  assert.deepEqual(references.dynamic, []);
});

test('el escáner marca los selectores con plantilla como no comprobables', () => {
  const references = scanUiSource(
    "form.querySelector(`#${id}`);\nquery(row, `[data-field=\"${field}\"]`);",
    'browser/main.ts',
  );

  assert.deepEqual(
    references.dynamic.map((reference) => reference.line),
    [1, 2],
  );
  assert.deepEqual(references.selectors, []);
});

test('las referencias por id del HTML se extraen con su origen', () => {
  const document = parseHtml(HTML);
  const references = htmlIdReferences(document);

  assert.deepEqual(
    references.map((reference) => reference.id),
    ['library-root', 'banks-title', 'banks'],
    'el `href="#"` no referencia ningún id',
  );
  assert.match(references[0]!.origin, /<label for="library-root">/);
  assert.match(references[1]!.origin, /aria-labelledby="banks-title"/);
  assert.match(references[2]!.origin, /<a href="#banks">/);
});

test('elementIds lee los ids del documento y de la plantilla', () => {
  const ids = elementIds(parseHtml(HTML));
  assert.deepEqual([...ids].sort(), [
    'banks',
    'banks-rows',
    'banks-title',
    'library-root',
    'page',
    'row-template',
    'scan-button',
    'scan-form',
  ]);
});
