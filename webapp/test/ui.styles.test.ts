import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  auditControlHeight,
  auditCss,
  auditPaginatedTableScroll,
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
  sources.push(await readFile(path.join(PUBLIC, 'index.html'), 'utf8'));
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

test('la auditoría de scroll de una tabla paginada entiende la cascada del cajón', () => {
  const html = parseHtml(`
    <aside class="card drawer"><div id="a-table" class="a-table"></div></aside>
    <section id="b-table" class="b-table"></section>
  `);

  const audit = auditPaginatedTableScroll(
    html,
    `
      .drawer .table-wrap { max-height: 260px; overflow-y: auto; }
      .a-table .table-wrap { max-height: none; overflow-y: visible; }
    `,
  );
  assert.deepEqual(audit.tables, ['#a-table'], 'solo se audita la tabla que vive en un cajón');
  assert.deepEqual(audit.offenders, [], 'el override de la tabla gana a la regla del cajón');

  const capped = auditPaginatedTableScroll(
    html,
    '.drawer .table-wrap { max-height: 260px; overflow-y: auto; }',
  );
  assert.deepEqual(
    capped.offenders.map((entry) => entry.property),
    ['max-height', 'overflow-y'],
    'sin override, el recorte del cajón y su scroll interno se detectan',
  );

  const later = auditPaginatedTableScroll(
    html,
    `
      .a-table .table-wrap { max-height: none; overflow-y: visible; }
      .drawer .table-wrap { max-height: 260px; overflow-y: auto; }
    `,
  );
  assert.equal(
    later.offenders.length,
    2,
    'con la misma especificidad gana la regla posterior, también hacia atrás',
  );
});

test('ninguna tabla paginada de un cajón recupera scroll interno', async () => {
  const { html, css } = await realPage();

  const audit = auditPaginatedTableScroll(html, css);
  const describe = (entry: (typeof audit.offenders)[number]): string =>
    `${entry.table} → ${entry.property}: ${entry.value} (styles.css:${entry.line})`;

  assert.deepEqual(
    audit.offenders,
    [],
    `tablas paginadas con scroll propio dentro de un cajón:\n${audit.offenders.map(describe).join('\n')}`,
  );

  // Sin este mínimo, un cambio en el detector dejaría el test comparando nada.
  assert.ok(
    audit.tables.length >= 10,
    `solo se auditaron ${audit.tables.length} tablas paginadas en cajones: ${audit.tables.join(', ')}`,
  );
  assert.ok(
    audit.tables.includes('#import-package-plugins-table') &&
      audit.tables.includes('#wizards-table'),
    `faltan tablas conocidas en la auditoría: ${audit.tables.join(', ')}`,
  );
  // Los cuatro listados de «Plugin nuevo sin wizard» también se montan con
  // `mountTable`: tienen que quedar cubiertos, no solo los del catálogo.
  for (const id of [
    '#custom-plugin-exports',
    '#custom-plugin-issues',
    '#custom-plugin-created-paths',
    '#custom-plugin-created-warnings',
  ]) {
    assert.ok(
      audit.tables.includes(id),
      `falta el listado ${id} en la auditoría: ${audit.tables.join(', ')}`,
    );
  }
});

test('la auditoría de scroll detecta una tabla paginada recortada en el styles.css real', async () => {
  const { html, css } = await realPage();
  const appended = '.audit-table .table-wrap { max-height: 260px; }';
  const mutated = `${css}\n${appended}\n`;

  const audit = auditPaginatedTableScroll(html, mutated);

  // Con el mismo código que audita el CSS real: si el detector no viera esta
  // regla, el test anterior también pasaría por vacuidad.
  const offenders = audit.offenders.filter((entry) => entry.table === '#audit-table');
  assert.equal(offenders.length, 1, 'la tabla de auditoría vuelve a recortarse');
  assert.equal(offenders[0]!.property, 'max-height');
  assert.equal(offenders[0]!.value, '260px');
  assert.equal(
    offenders[0]!.line,
    mutated.slice(0, mutated.indexOf(appended)).split('\n').length,
    'la línea debe apuntar a la regla añadida',
  );
  assert.deepEqual(
    audit.offenders.every((entry) => entry.table === '#audit-table' || entry.table === '#data-audit-table'),
    true,
    'las dos tablas de auditoría comparten clase y selector',
  );
});

test('un selector con [open] de un details queda sin verificar, no muerto', () => {
  const html = parseHtml(`
    <details>
      <summary><svg class="chevron"></svg>Opciones</summary>
      <p>Contenido</p>
    </details>
  `);
  const audit = auditCss(
    html,
    'details[open] > summary .chevron { transform: rotate(90deg); }',
  );

  assert.deepEqual(audit.dead, [], 'open lo pone el navegador al desplegar');
  assert.equal(audit.unverified, 1, 'el estado nativo no se comprueba contra el HTML');
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

test('la auditoría de alto sigue la variable de los controles y detecta la desalineación', () => {
  const aligned = `
    :root { --control-height: 42px; }
    input, select, button { height: var(--control-height); }
  `;
  const audit = auditControlHeight(aligned);
  assert.equal(audit.variable?.value, '42px');
  assert.deepEqual(
    audit.controls.map((entry) => entry.control),
    ['input', 'select', 'button'],
  );
  assert.deepEqual(audit.offenders, [], 'los tres salen de la misma variable');

  const sinSelect = auditControlHeight(`
    :root { --control-height: 42px; }
    input, button { height: var(--control-height); }
  `);
  assert.deepEqual(
    sinSelect.offenders.map((entry) => [entry.control, entry.problem]),
    [['select', 'missing-height']],
    'un control sin `height` tampoco comparte el alto',
  );

  const literal = auditControlHeight(`
    :root { --control-height: 42px; }
    input { height: var(--control-height); }
    select { height: 40px; }
    button { height: var(--control-height); }
  `);
  assert.deepEqual(
    literal.offenders.map((entry) => [entry.control, entry.problem, entry.value]),
    [['select', 'fixed-height', '40px']],
    'un alto fijo se denuncia con su valor',
  );

  const sinVariable = auditControlHeight('input, select, button { height: var(--control-height); }');
  assert.equal(sinVariable.variable, null);
  assert.deepEqual(
    sinVariable.offenders.map((entry) => entry.problem),
    ['variable-undefined', 'variable-undefined', 'variable-undefined'],
    'sin declaración, el var() no resuelve y los tres fallan',
  );
});

test('input, select y botón comparten el alto de --control-height', async () => {
  const { css } = await realPage();

  const audit = auditControlHeight(css);
  const describe = (entry: (typeof audit.offenders)[number]): string =>
    `${entry.control} → ${entry.value ?? 'sin height'} (${entry.problem}, styles.css:${entry.line ?? '-'})`;

  assert.deepEqual(
    audit.offenders,
    [],
    `controles que no comparten el alto de --control-height:\n${audit.offenders.map(describe).join('\n')}`,
  );

  // Sin estas comprobaciones, un parser roto dejaría el test pasando por vacuidad.
  assert.ok(
    audit.variable !== null && audit.variable.value !== '',
    '`--control-height` tiene que estar declarada con un valor',
  );
  assert.deepEqual(
    audit.controls.map((entry) => entry.control),
    ['input', 'select', 'button'],
  );
  for (const entry of audit.controls) {
    assert.match(
      entry.value ?? '',
      /^var\(\s*--control-height\s*\)$/i,
      `${entry.control} debe llevar height: var(--control-height)`,
    );
  }
});

test('la auditoría de alto detecta un control con altura propia en el styles.css real', async () => {
  const { css } = await realPage();
  const appended = 'select { height: 30px; }';
  const mutated = `${css}\n${appended}\n`;

  const audit = auditControlHeight(mutated);

  // Mismo código que audita el CSS real: si el detector no viera esta regla,
  // el test anterior también pasaría sin comprobar el alto de verdad.
  assert.deepEqual(
    audit.offenders.map((entry) => [entry.control, entry.problem, entry.value]),
    [['select', 'fixed-height', '30px']],
  );
  assert.equal(
    audit.offenders[0]!.line,
    mutated.slice(0, mutated.indexOf(appended)).split('\n').length,
    'la línea debe apuntar a la regla añadida',
  );
});
