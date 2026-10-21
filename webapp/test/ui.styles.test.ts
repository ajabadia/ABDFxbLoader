import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  auditCss,
  baseSelector,
  parseCssSelectors,
  selectorNames,
  sourceNames,
  splitSelectorList,
} from './helpers/css';
import { parseHtml, type HtmlNode } from './helpers/ui-dom';

/**
 * `styles.css` se escribe a mano y crece con la vista: una regla que sobrevive
 * a un cambio de HTML (un id renombrado, una fila que ya no existe) no falla,
 * simplemente deja de pintar. Este test la busca con el mismo matcher que
 * `ui.test.ts` usa para los ids y selectores de la UI:
 *
 * - primero comprueba el parser y la auditoría con HTML/CSS de juguete, para no
 *   dar por bueno un detector que no detecta nada;
 * - después audita el `styles.css` real contra `index.html` y los nombres que
 *   crea `src/ui` en tiempo de ejecución (filas, badges, estados del lote).
 *
 * Un selector se considera muerto si nombra algo que no existe en ninguno de
 * los dos sitios, o si todos sus nombres están en el HTML pero la estructura ya
 * no coincide (por ejemplo `.card .hint` cuando `.hint` quedó fuera de `.card`).
 */

const WEBAPP = path.resolve(__dirname, '..', '..');
const PUBLIC = path.join(WEBAPP, 'public');
const UI = path.join(WEBAPP, 'src', 'ui');

const SAMPLE_HTML = `
<main id="page" class="card">
  <p class="status busy">Listo</p>
  <button type="button" disabled>Acción</button>
  <table><tbody id="rows"></tbody></table>
  <section id="results" class="card" hidden>
    <span class="badge">estado</span>
  </section>
</main>
<template id="row-template"><tr><td class="cell"></td></tr></template>
`;

/** 'busy' y 'created' los pone la vista; el resto es HTML estático. */
const SAMPLE_DYNAMIC = ['busy', 'created'];

test('el parser saca los selectores de cada regla, también dentro de @media', () => {
  const css = `
    /* comentario con { llaves } */
    main { color: red; }
    .card > .missing,
    .status.busy:hover { color: blue; }
    @media (max-width: 640px) {
      .card { padding: 0; }
    }
    @keyframes fade {
      from { opacity: 0; }
      to { opacity: 1; }
    }
  `;

  assert.deepEqual(
    parseCssSelectors(css).map((rule) => [rule.selector, rule.line]),
    [
      ['main', 3],
      ['.card > .missing,\n    .status.busy:hover', 4],
      ['.card', 7],
    ],
  );
});

test('las listas de selectores se parten por comas sin romper corchetes ni paréntesis', () => {
  assert.deepEqual(
    splitSelectorList("td[data-field='name'], .a:not(.b, .c), .d"),
    ["td[data-field='name']", '.a:not(.b, .c)', '.d'],
  );
  assert.deepEqual(splitSelectorList('   '), []);
});

test('las pseudoclases se quitan y los combinadores no soportados se apartan', () => {
  assert.equal(baseSelector('button:hover:not(:disabled)'), 'button');
  assert.equal(baseSelector('tbody tr:last-child td'), 'tbody tr td');
  assert.equal(baseSelector('.batch-progress::-webkit-progress-value'), '.batch-progress');
  assert.equal(baseSelector(':root'), 'html');
  assert.equal(baseSelector('.actions button + button'), null);
  assert.equal(baseSelector('*'), null);
});

test('selectorNames se queda con ids, clases, etiquetas y atributos', () => {
  assert.deepEqual(
    selectorNames("td[data-field='name'], details.import label[for='import-paths']").sort(),
    ['data-field', 'details', 'for', 'import', 'import-paths', 'label', 'name', 'td'],
  );
});

test('la auditoría distingue reglas vivas, dinámicas y muertas', () => {
  const html = parseHtml(SAMPLE_HTML);
  const css = `
    main { color: red; }
    .status:hover { color: blue; }
    .status.busy { color: green; }
    .created { color: purple; }
    .missing { color: black; }
    .status > .created { color: teal; }
    .status > .badge { color: brown; }
    tbody td.cell { color: pink; }
    button + button { margin: 0; }
    * { box-sizing: border-box; }
  `;

  const audit = auditCss(html, css, SAMPLE_DYNAMIC);

  assert.deepEqual(
    audit.dead.map((entry) => entry.selector),
    ['.missing', '.status > .badge'],
    '`.status > .created` se queda en dinámica: `.created` lo crea la vista',
  );
  assert.deepEqual(audit.dead[0]?.unknown, ['missing']);
  assert.deepEqual(audit.dead[1]?.unknown, [], 'el fallo es estructural, no de nombres');
  assert.equal(audit.structural, 3, 'main, .status:hover y .status.busy coinciden');
  assert.equal(
    audit.dynamic,
    3,
    '.created, .status > .created y tbody td.cell (su td sale de la plantilla)',
  );
  assert.equal(audit.unverified, 2, 'el combinador + y el universal');
  assert.equal(audit.total, 10);
});

/** La página real y los nombres que crea la vista, para auditar el CSS. */
async function realPage(): Promise<{ html: HtmlNode; css: string; dynamic: Set<string> }> {
  const html = parseHtml(await readFile(path.join(PUBLIC, 'index.html'), 'utf8'));
  const css = await readFile(path.join(PUBLIC, 'styles.css'), 'utf8');

  const files = (await readdir(UI, { recursive: true }))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => path.join(UI, file));
  const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  return { html, css, dynamic: sourceNames(sources) };
}

test('styles.css no tiene reglas que no puedan pintar ningún elemento', async () => {
  const { html, css, dynamic } = await realPage();

  const audit = auditCss(html, css, dynamic);
  const describe = (entry: (typeof audit.dead)[number]): string =>
    `${entry.selector} (styles.css:${entry.line})` +
    (entry.unknown.length === 0
      ? ' → ningún elemento de index.html encaja con esa estructura'
      : ` → no existe: ${entry.unknown.join(', ')}`);

  assert.deepEqual(audit.dead, [], `reglas muertas en styles.css:\n${audit.dead.map(describe).join('\n')}`);

  // Sin estos mínimos, un cambio en el parser dejaría el test comparando nada.
  assert.ok(audit.total >= 90, `solo se auditaron ${audit.total} selectores`);
  assert.ok(
    audit.structural >= 60,
    `solo ${audit.structural} selectores se comprobaron contra el HTML`,
  );
  assert.ok(audit.dynamic >= 15, `solo ${audit.dynamic} selectores dependen de la vista`);
  assert.ok(audit.unverified >= 1, 'los combinadores + / ~ deben quedar como no comprobados');
});

test('la auditoría detecta una regla muerta añadida al styles.css real', async () => {
  const { html, css, dynamic } = await realPage();
  const selector = '.fxb-regla-inexistente';
  const mutated = `${css}\n${selector} { color: red; }\n`;

  const audit = auditCss(html, mutated, dynamic);

  // Si el auditor no viera esta regla, el test anterior también pasaría por
  // vacuidad: el CSS real se audita con el mismo código que esta mutación.
  assert.equal(audit.dead.length, 1, 'la regla añadida debe quedar como muerta');
  const dead = audit.dead[0]!;
  assert.equal(dead.selector, selector);
  assert.deepEqual(dead.unknown, ['fxb-regla-inexistente']);
  assert.equal(
    dead.line,
    mutated.slice(0, mutated.indexOf(selector)).split('\n').length,
    'la línea debe apuntar a la regla añadida',
  );
});
