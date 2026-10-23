import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { auditMarkup, classNamesInSource } from './helpers/css';
import {
  elementAriaAttributes,
  elementClasses,
  elementDataAttributes,
  parseHtml,
  scanUiSource,
} from './helpers/ui-dom';

/**
 * Auditoría inversa de la UI. Los otros tests van del código al HTML:
 * `ui.test.ts` comprueba que todo id o selector que escribe la vista existe, y
 * `ui.styles.test.ts` que ninguna regla de `styles.css` quedó huérfana. Aquí se
 * recorre el sentido contrario: qué ids, clases, atributos `data-*` y estados
 * ARIA de `index.html` no usa nadie.
 *
 * Un id vale si lo pinta el CSS, lo busca la vista o lo referencia otro atributo
 * del propio HTML (`for`, `aria-labelledby`, `href="#…"`); una clase vale si
 * tiene regla en `styles.css` o si la vista la escribe o la consulta; un
 * `data-*` vale si el CSS o la vista lo exigen con ese valor
 * (`[data-field="name"]`) o si la vista lee el atributo con `dataset`; y un
 * `role`/`aria-*` vale si es declarativo (rol, nombre, live region, relación o
 * propiedad fija) o si es un estado que el CSS o la vista consultan o
 * actualizan (`aria-expanded`, `aria-busy`…). Lo demás es marcado que se puede
 * borrar (o que hay que documentar en el HTML) sin que nada se rompa, y por eso
 * el test falla: así no se acumula.
 *
 * Primero se prueban el escáner y la auditoría con HTML/CSS/sources de juguete,
 * para no dar por bueno un detector que no detecta nada; después se audita la
 * página real y se comprueba que una etiqueta añadida al vuelo sí se reporta.
 */

const WEBAPP = path.resolve(__dirname, '..', '..');
const PUBLIC = path.join(WEBAPP, 'public');
const UI = path.join(WEBAPP, 'src', 'ui');

const SAMPLE_HTML = `
<main id="page" class="card">
  <label for="field">Campo</label>
  <input id="field" />
  <p class="from-css" role="status" aria-live="polite" aria-label="Estado" aria-busy="false">
    Listo
  </p>
  <button type="button" disabled aria-expanded="false">Acción</button>
  <p class="from-view"></p>
  <p class="orphan"></p>
  <div id="styled" class="badge"></div>
  <p id="ghost" class="ghost"></p>
  <section id="banks" aria-labelledby="banks-title">
    <h2 id="banks-title">Bancos</h2>
  </section>
  <template id="row-template"><tr class="row"><td class="cell"></td></tr></template>
  <p data-field="title"></p>
  <p data-field="unused"></p>
  <button data-action="save"></button>
  <span data-flag></span>
  <span data-ghost="1"></span>
  <div data-role="panel" aria-expanded="true" aria-checked="false"></div>
</main>
`;

const SAMPLE_CSS = `
  #page { color: red; }
  #styled { color: blue; }
  .card { padding: 0; }
  .from-css,
  .badge { color: green; }
  .row { color: black; }
  .cell { color: gray; }
  [data-role="panel"] { color: pink; }
`;

/** Lo mínimo que escribe la vista: un id, una clase y una plantilla. */
const SAMPLE_SOURCES = [
  {
    file: 'browser/main.ts',
    source: [
      "const field = byId<HTMLInputElement>('field');",
      "const banks = byId<HTMLElement>('banks');",
      "const template = byId<HTMLTemplateElement>('row-template');",
      "field.classList.add('from-view');",
      "row.classList.toggle('batch-running', installed);",
      'el.className = `status ${kind}`;',
      "query(row, '[data-field=\"title\"]');",
      "query(row, '[data-action=\"save\"]');",
      "query(row, '[aria-expanded=\"true\"]');",
      "el.getAttribute('aria-busy');",
      "if (el.dataset['flag'] === 'true') return;",
      // Una escritura no prueba que el atributo del HTML se lea.
      "el.dataset['unused'] = '1';",
    ].join('\n'),
  },
];

test('elementClasses lee las clases del documento y de la plantilla', () => {
  const classes = elementClasses(parseHtml(SAMPLE_HTML));

  assert.equal(classes.get('card'), 1);
  assert.equal(classes.get('from-css'), 1);
  assert.equal(classes.get('row'), 1, 'la plantilla de filas también cuenta');
  assert.equal(classes.get('cell'), 1);
  assert.equal(classes.get('inexistente'), undefined);
});

test('el escáner de clases entiende classList, className y los selectores', () => {
  const classes = classNamesInSource([
    {
      file: 'browser/main.ts',
      source: [
        "row.classList.add('danger', 'primary');",
        "node.classList.toggle('batch-done', state === 'done');",
        "node.classList.remove('is-default');",
        "node.className = 'badge on';",
        'node.className = `import-result ${status}`;',
        "node.setAttribute('class', 'note');",
        "node.querySelector('.from-selector');",
      ].join('\n'),
    },
  ]);

  assert.deepEqual(
    [...classes.keys()].sort(),
    [
      'badge',
      'batch-done',
      'danger',
      'from-selector',
      'import-result',
      'is-default',
      'note',
      'on',
      'primary',
    ],
    '`state === \'done\'` es un valor de estado, no una clase',
  );
});

test('la auditoría marca id y clase sin uso y respeta CSS, vista y ARIA', () => {
  const audit = auditMarkup(parseHtml(SAMPLE_HTML), SAMPLE_CSS, SAMPLE_SOURCES);

  assert.deepEqual(audit.deadIds, ['ghost'], 'page/styled los pinta el CSS, field y banks la vista');
  assert.deepEqual(
    audit.deadClasses,
    ['ghost', 'orphan'],
    'from-view lo pone la vista; from-css, card, badge, row y cell tienen regla',
  );
  assert.deepEqual(
    audit.deadAria,
    ['aria-checked="false"', 'aria-expanded="false"'],
    'role, aria-live, aria-label y aria-busy los consume la accesibilidad; ' +
      'aria-expanded=true lo exige un selector y los otros estados nadie los toca',
  );
  assert.equal(audit.ids, 7);
  assert.equal(audit.classes, 8);
  assert.equal(audit.aria, 8);
});

test('elementAriaAttributes recoge role y aria-* del documento y de la plantilla', () => {
  const attributes = elementAriaAttributes(parseHtml(SAMPLE_HTML));

  assert.deepEqual(
    attributes.filter((entry) => entry.attribute === 'aria-expanded'),
    [
      { attribute: 'aria-expanded', value: 'false' },
      { attribute: 'aria-expanded', value: 'true' },
    ],
  );
  assert.equal(attributes.length, 8);
  assert.equal(attributes[0]?.attribute, 'role');
});

test('elementDataAttributes recoge los data-* del documento y de la plantilla', () => {
  const attributes = elementDataAttributes(parseHtml(SAMPLE_HTML));

  assert.deepEqual(
    attributes.filter((entry) => entry.attribute === 'data-field'),
    [
      { attribute: 'data-field', value: 'title' },
      { attribute: 'data-field', value: 'unused' },
    ],
  );
  assert.ok(attributes.some((entry) => entry.attribute === 'data-flag' && entry.value === ''));
  assert.equal(attributes.length, 6);
});

test('el escáner entiende selectores data-* y lecturas de dataset', () => {
  const references = scanUiSource(
    [
      "query(row, '[data-field=\"name\"]');",
      "query<HTMLButtonElement>(row, '[data-action=\"banks\"]');",
      "if (button.dataset['blocked'] === 'true') return;",
      "el.dataset.default === 'true';",
      "row.getAttribute('data-role');",
      // Una escritura no es una lectura del marcado.
      "name.dataset['field'] = 'bank-name';",
      "use.dataset.default = 'true';",
    ].join('\n'),
    'browser/main.ts',
  ).data;

  assert.deepEqual(
    references.map(
      (reference) => `${reference.attribute}${reference.value === null ? '' : `=${reference.value}`}`,
    ),
    [
      'data-field=name',
      'data-action=banks',
      'data-blocked',
      'data-default',
      'data-role',
    ],
    'las asignaciones a dataset no cuentan como lectura',
  );
});

test('el escáner entiende selectores ARIA y lecturas o escrituras del DOM', () => {
  const references = scanUiSource(
    [
      "query(row, '[aria-live=\"polite\"]');",
      "query(row, '[role=\"status\"]');",
      "el.getAttribute('aria-expanded');",
      "el.setAttribute('aria-expanded', 'true');",
      "el.removeAttribute('aria-busy');",
      "el.toggleAttribute('aria-pressed', true);",
      "el.dataset.role;",
    ].join('\n'),
    'browser/main.ts',
  ).aria;

  assert.deepEqual(
    references.map(
      (reference) => `${reference.attribute}${reference.value === null ? '' : `=${reference.value}`}`,
    ),
    [
      'aria-live=polite',
      'role=status',
      'aria-expanded',
      'aria-expanded',
      'aria-busy',
      'aria-pressed',
    ],
    'las escrituras cuentan para un estado ARIA; `dataset.role` no es ARIA',
  );
});

test('la auditoría marca los data-* que ningún selector ni lectura usa', () => {
  const audit = auditMarkup(parseHtml(SAMPLE_HTML), SAMPLE_CSS, SAMPLE_SOURCES);

  assert.deepEqual(
    audit.deadData,
    ['data-field="unused"', 'data-ghost="1"'],
    'title y action los lee la vista, flag por dataset, role por el CSS y unused solo se escribe',
  );
  assert.equal(audit.data, 6);
});

test('la auditoría distingue ARIA declarativo, consultado y estado congelado', () => {
  const declarative = auditMarkup(
    parseHtml('<p role="status" aria-live="polite" aria-label="Estado"></p>'),
    '',
    [],
  );
  assert.deepEqual(declarative.deadAria, [], 'lo consume el árbol de accesibilidad');

  const css = auditMarkup(
    parseHtml('<button aria-expanded="false"></button>'),
    '[aria-expanded="false"] { color: red; }',
    [],
  );
  assert.deepEqual(css.deadAria, [], 'el CSS mantiene el estado con ese valor');

  const mismatch = auditMarkup(
    parseHtml('<button aria-expanded="false"></button>'),
    '[aria-expanded="true"] { color: red; }',
    [],
  );
  assert.deepEqual(
    mismatch.deadAria,
    ['aria-expanded="false"'],
    'un selector para otro valor no mantiene este estado',
  );

  const empty = auditMarkup(parseHtml('<p role="" aria-label=""></p>'), '', []);
  assert.deepEqual(empty.deadAria, ['aria-label', 'role'], 'un ARIA sin valor no lo lee nadie');
});

test('un id usado solo por aria-labelledby no es marcado muerto', () => {
  const audit = auditMarkup(parseHtml(SAMPLE_HTML), SAMPLE_CSS, SAMPLE_SOURCES);

  assert.equal(audit.deadIds.includes('banks-title'), false, 'lo referencia el HTML, no la vista');
});

/** La página real y las fuentes de la vista, como las lee la auditoría. */
async function realMarkup(): Promise<{
  html: string;
  css: string;
  sources: { file: string; source: string }[];
}> {
  const html = await readFile(path.join(PUBLIC, 'index.html'), 'utf8');
  const css = await readFile(path.join(PUBLIC, 'styles.css'), 'utf8');
  const files = (await readdir(UI, { recursive: true }))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => path.join(UI, file));

  return {
    html,
    css,
    sources: await Promise.all(
      files.map(async (file) => ({
        file: path.relative(UI, file).replace(/\\/g, '/'),
        source: await readFile(file, 'utf8'),
      })),
    ),
  };
}

test('index.html no tiene ids, clases, data-* ni estados ARIA que no use nadie', async () => {
  const { html, css, sources } = await realMarkup();

  const audit = auditMarkup(parseHtml(html), css, sources);

  assert.deepEqual(
    audit.deadIds,
    [],
    `ids sin uso en index.html: ${audit.deadIds.map((id) => `#${id}`).join(', ')}`,
  );
  assert.deepEqual(
    audit.deadClasses,
    [],
    `clases sin uso en index.html: ${audit.deadClasses.map((name) => `.${name}`).join(', ')}`,
  );
  assert.deepEqual(
    audit.deadData,
    [],
    `data-* sin uso en index.html: ${audit.deadData.join(', ')}`,
  );
  assert.deepEqual(
    audit.deadAria,
    [],
    `ARIA de estado sin uso en index.html: ${audit.deadAria.join(', ')}`,
  );

  // Sin estos mínimos, un cambio en el escáner dejaría el test comparando nada.
  assert.ok(audit.ids >= 40, `solo se auditaron ${audit.ids} ids`);
  assert.ok(audit.classes >= 25, `solo se auditaron ${audit.classes} clases`);
  assert.ok(audit.data >= 7, `solo se auditaron ${audit.data} atributos data-*`);
  assert.ok(audit.aria >= 8, `solo se auditaron ${audit.aria} atributos ARIA`);
});

test('la auditoría detecta id, clase, data-* y ARIA muertos añadidos a index.html', async () => {
  const { html, css, sources } = await realMarkup();
  const marker =
    '<p id="fxb-id-fantasma" class="fxb-clase-fantasma" data-field="fxb-campo-fantasma" ' +
    'aria-expanded="false">x</p>';
  const mutated = html.replace('</main>', `${marker}\n    </main>`);
  assert.notEqual(mutated, html, 'la mutación debe llegar al documento');

  const audit = auditMarkup(parseHtml(mutated), css, sources);

  assert.deepEqual(audit.deadIds, ['fxb-id-fantasma']);
  assert.deepEqual(audit.deadClasses, ['fxb-clase-fantasma']);
  assert.deepEqual(
    audit.deadData,
    ['data-field="fxb-campo-fantasma"'],
    'la vista lee otros valores de data-field, pero no este',
  );
  assert.deepEqual(
    audit.deadAria,
    ['aria-expanded="false"'],
    'nadie mantiene ese estado aria-expanded en la vista real',
  );
});
