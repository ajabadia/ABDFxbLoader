/**
 * Auditoría de `styles.css` contra la página: extrae los selectores de cada
 * regla (incluidas las de dentro de `@media`) y comprueba con el matcher de
 * `ui-dom.ts` si apuntan a algún elemento real.
 *
 * Un selector puede no coincidir con el HTML estático y seguir siendo válido:
 * la vista crea filas, badges y estados (`tr.batch-running`, `.status.busy`…) al
 * vuelo. Por eso se distinguen tres casos:
 *
 * - **estructural**: el selector pelado (`:hover`, `::before` y `:root` fuera)
 *   coincide con un elemento de `index.html`;
 * - **dinámico**: no coincide, pero todos sus nombres existen en el JS de la
 *   vista, que los añade en tiempo de ejecución;
 * - **muerto**: algún nombre (clase, id, etiqueta, atributo o valor de
 *   `data-*`) no aparece ni en el HTML ni en el JS, o todos existen en el HTML
 *   y aun así la estructura no coincide. Ninguno de los dos casos puede llegar
 *   a pintar nada.
 *
 * Los selectores con combinadores que el matcher no soporta (`+`, `~`, `*`) no
 * se pueden comprobar estructuralmente: se quedan en la comprobación de nombres.
 */

import {
  ariaReferencesInSelector,
  dataReferencesInSelector,
  elementAriaAttributes,
  elementClasses,
  elementDataAttributes,
  elementIds,
  htmlIdReferences,
  querySelectorAll,
  scanUiSource,
  type HtmlNode,
  type UiAriaReference,
  type UiDataReference,
} from './ui-dom';

export interface CssRule {
  /** Preludio completo de la regla, tal cual (puede ser una lista con comas). */
  selector: string;
  /** Línea (1-based) donde empieza el selector. */
  line: number;
  /** Propiedad (en minúsculas) → valor, sin `!important`. */
  declarations: Map<string, string>;
}

export interface DeadSelector {
  selector: string;
  line: number;
  /** Nombres que no existen en ningún sitio; vacío si el fallo es estructural. */
  unknown: string[];
}

export interface CssAudit {
  dead: DeadSelector[];
  /** Selectores comprobados contra el HTML. */
  structural: number;
  /** Selectores que dependen de elementos creados por la vista. */
  dynamic: number;
  /** Selectores cuyo combinador el matcher no soporta. */
  unverified: number;
  /** Selectores revisados (una regla con comas cuenta por separado). */
  total: number;
}

const AT_RULE_WITHOUT_SELECTORS = /^@(?:keyframes|-webkit-keyframes|font-face)\b/;

/**
 * Declaraciones de un bloque (`property: value; …`), partiendo por `;` fuera de
 * paréntesis y comillas: los valores con `min(88vh, 900px)` o una fuente con
 * comas no deben romper la lectura. La última declaración de una propiedad gana,
 * como en el navegador.
 */
function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  let current = '';
  let parens = 0;
  let quote: string | null = null;

  const commit = (chunk: string): void => {
    const colon = chunk.indexOf(':');
    if (colon === -1) return;
    const property = chunk.slice(0, colon).trim().toLowerCase();
    const value = chunk
      .slice(colon + 1)
      .trim()
      .replace(/\s*!important$/i, '');
    if (property !== '') declarations.set(property, value);
  };

  for (const character of body) {
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === '(') parens += 1;
    if (character === ')') parens -= 1;
    if (character === ';' && parens === 0) {
      commit(current);
      current = '';
      continue;
    }
    current += character;
  }

  commit(current);
  return declarations;
}

/**
 * Atributos booleanos que el navegador mantiene sin que estén en el marcado:
 * al abrir un `<details>` aparece `open` y al cerrarlo desaparece. Un selector
 * que los usa no se puede comprobar contra el HTML estático, pero tampoco es
 * una regla muerta.
 */
const NATIVE_STATE_ATTRIBUTES = new Set(['open']);
const DYNAMIC_DATA_ATTRIBUTES = new Set(['data-direction']);

/**
 * Selectores de las reglas de un CSS, en orden y con su línea. Ignora los
 * preludios de at-rules (`@media`, `@supports`) y el interior de `@keyframes`,
 * cuyos pasos (`from`, `50%`) no son selectores de elementos.
 */
export function parseCssSelectors(css: string): CssRule[] {
  // Los comentarios se sustituyen por espacios conservando los saltos de línea
  // para que los números de línea sigan siendo los del archivo.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  const rules: CssRule[] = [];
  const blocks: { kind: 'at' | 'style' | 'skip'; bodyStart: number; rule: CssRule | null }[] = [];
  let preludeStart = 0;

  const lineAt = (offset: number): number => text.slice(0, offset).split('\n').length;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') {
      const raw = text.slice(preludeStart, index);
      const prelude = raw.trim();
      const parent = blocks[blocks.length - 1];

      if (prelude.startsWith('@')) {
        blocks.push({
          kind: AT_RULE_WITHOUT_SELECTORS.test(prelude) ? 'skip' : 'at',
          bodyStart: index + 1,
          rule: null,
        });
      } else {
        // Solo los bloques de declaraciones de una regla (o de una regla dentro
        // de un at-rule) son selectores; el resto es cuerpo de declaraciones.
        let rule: CssRule | null = null;
        if (prelude !== '' && (parent === undefined || parent.kind === 'at')) {
          const offset = preludeStart + (raw.length - raw.trimStart().length);
          rule = { selector: prelude, line: lineAt(offset), declarations: new Map() };
          rules.push(rule);
        }
        blocks.push({ kind: 'style', bodyStart: index + 1, rule });
      }

      preludeStart = index + 1;
      continue;
    }

    if (character === '}') {
      const block = blocks.pop();
      if (block?.rule != null) {
        block.rule.declarations = parseDeclarations(text.slice(block.bodyStart, index));
      }
      preludeStart = index + 1;
      continue;
    }

    if (character === ';') preludeStart = index + 1;
  }

  return rules;
}

/** Divide una lista de selectores por comas, respetando corchetes y paréntesis. */
export function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let current = '';
  let brackets = 0;
  let parens = 0;
  let quote: string | null = null;

  for (const character of selector) {
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === '[') brackets += 1;
    if (character === ']') brackets -= 1;
    if (character === '(') parens += 1;
    if (character === ')') parens -= 1;
    if (character === ',' && brackets === 0 && parens === 0) {
      if (current.trim() !== '') parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }

  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/**
 * Selector sin pseudoclases ni pseudoelementos (`:hover`, `:last-child`,
 * `::-webkit-progress-value`, `:not(:disabled)`), o `null` si usa un combinador
 * que el matcher no soporta. `:root` se traduce a `html`, el elemento raíz.
 */
export function baseSelector(selector: string): string | null {
  const withoutPseudos = selector
    .replace(/:root\b/g, 'html')
    .replace(/::?[a-zA-Z-]+(?:\([^()]*\))?/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (withoutPseudos === '') return null;
  // `*` es universal (siempre pinta algo) y `+`/`~` no los resuelve el matcher.
  if (/[*+~]/.test(withoutPseudos)) return null;
  return withoutPseudos;
}

/**
 * Nombres que un selector necesita para poder aplicar: ids, clases, etiquetas,
 * atributos y valores de atributo. Las pseudoclases no cuentan.
 */
export function selectorNames(selector: string): string[] {
  const names = new Set<string>();
  const cleaned = selector.replace(/:root\b/g, 'html');

  for (const match of cleaned.matchAll(/#([\w-]+)/g)) names.add(match[1]!);
  for (const match of cleaned.matchAll(/\.([\w-]+)/g)) names.add(match[1]!);

  for (const match of cleaned.matchAll(
    /\[\s*([\w-]+)\s*(?:[*^$|~]?=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/g,
  )) {
    names.add(match[1]!);
    const value = match[2] ?? match[3] ?? match[4];
    if (value !== undefined && value !== '') names.add(value);
  }

  for (const match of cleaned.matchAll(/(?:^|[\s>])([a-zA-Z][\w-]*)/g)) names.add(match[1]!);

  return [...names];
}

/** `dataset.tone` y `dataset['tone']`: atributos `data-*` que escribe la vista. */
const DATASET_ACCESS =
  /\bdataset\s*(?:\.\s*([A-Za-z][\w]*)|\[\s*'((?:[^'\\]|\\.)*)'\s*\]|\[\s*"((?:[^"\\]|\\.)*)"\s*\])/g;

/** Nombres que existen en el HTML: etiquetas, clases, ids, atributos y valores. */
export function htmlNames(root: HtmlNode): Set<string> {
  const names = new Set<string>();

  const visit = (node: HtmlNode): void => {
    if (node.tagName !== '#document') names.add(node.tagName);

    for (const [attribute, value] of Object.entries(node.attributes)) {
      names.add(attribute);
      if (attribute === 'class' || attribute === 'id' || attribute === 'for' || attribute.startsWith('data-')) {
        for (const token of value.split(/\s+/)) {
          if (token !== '') names.add(token);
        }
      }
    }

    for (const child of node.children) visit(child);
  };

  visit(root);
  return names;
}

/**
 * Quita los comentarios sin tocar los literales: `'http://x'` no es un
 * comentario. Se hace antes de emparejar comillas porque un apóstrofo suelto en
 * un comentario (o un `//` dentro de una plantilla) descuadra el emparejado y
 * esconde los literales que vienen detrás: con `main.ts` pasaba, y la clase
 * `capture-log-entry` que la vista escribe se daba por muerta.
 */
export function stripComments(source: string): string {
  let out = '';
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      out += ' ';
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      out += char;
      index += 1;
      while (index < source.length) {
        const current = source[index]!;
        out += current;
        index += 1;
        if (current === '\\') {
          out += source[index] ?? '';
          index += 1;
          continue;
        }
        if (current === quote) break;
      }
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/**
 * Nombres que puede crear la vista: clases y valores escritos en un literal de
 * `src/ui`. Los literales con interpolación también aportan sus trozos
 * (`status ${kind}` → `status`), que es lo que se busca aquí. Los comentarios no
 * cuentan: no pintan nada y descolocan el emparejado de comillas.
 */
export function sourceNames(sources: Iterable<string>): Set<string> {
  const names = new Set<string>();

  for (const original of sources) {
    const source = stripComments(original);
    for (const match of source.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const value = match[1] ?? match[2] ?? match[3] ?? '';
      for (const token of value.match(/[A-Za-z][\w-]*/g) ?? []) names.add(token);
    }
    // `dataset.tone` y `dataset['tone']` escriben `data-tone`, que el CSS puede
    // seleccionar; sin esto el atributo solo sería visible si se nombrara en un
    // literal, y las reglas de tono quedarían como muertas.
    for (const match of source.matchAll(DATASET_ACCESS)) {
      const attribute = match[1] ?? match[2] ?? match[3] ?? '';
      if (attribute !== '') names.add(`data-${attribute}`);
    }
  }

  return names;
}

/**última parte del selector: el elemento que la regla pinta. */
function subjectSelector(selector: string): string | null {
  const parts = selector.split(/[\s>]+/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? null;
}

/** `<template>` del documento: la vista clona su contenido dentro de la tabla. */
function templateRoots(root: HtmlNode): HtmlNode[] {
  const templates: HtmlNode[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.tagName === 'template') templates.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return templates;
}

/** Fuente de la vista, con su ruta relativa a `src/ui` para los mensajes. */
export interface UiSource {
  file: string;
  source: string;
}

export interface MarkupAudit {
  /** Ids de `index.html` que no usa ni el CSS, ni la vista, ni otro atributo. */
  deadIds: string[];
  /** Clases de `index.html` sin regla de CSS y sin uso en la vista. */
  deadClasses: string[];
  /**
   * Atributos `data-*` del marcado que no lee nadie (`data-field="name"`), con
   * el valor incluido: es lo que distingue un campo o una acción de la plantilla
   * que la vista ya no consulta de otro que sí.
   */
  deadData: string[];
  /**
   * Estados ARIA (`aria-expanded`, `aria-pressed`…) que el marcado declara y
   * ni el CSS ni la vista mantienen, con el valor incluido. Los roles, nombres,
   * regiones vivas, relaciones y propiedades fijas no se auditan aquí: los
   * consume el árbol de accesibilidad y una declaración estática ya es su uso.
   */
  deadAria: string[];
  /** Totales revisados, para que un escáner roto no pase por vacuidad. */
  ids: number;
  classes: number;
  data: number;
  aria: number;
}

/**
 * Atributos `data-*` puramente declarativos que consume el motor transversal
 * de internacionalización de `@abdsynths/shared/i18n` (`applyI18n()`).
 */
const DECLARATIVE_DATA_ATTRIBUTES = new Set([
  'data-i18n',
  'data-i18n-title',
  'data-i18n-placeholder',
  'data-i18n-label',
]);

/**
 * Estados ARIA que la interfaz tiene que mantener al día. El resto de ARIA
 * (roles, nombres accesibles, descripciones, live regions, relaciones y
 * propiedades fijas) lo consume el árbol de accesibilidad sin que haga falta
 * consultarlo desde el código: una declaración estática ya es su uso. Estos,
 * en cambio, quedan congelados si nadie los lee o actualiza.
 */
const STATEFUL_ARIA = new Set([
  'aria-busy',
  'aria-checked',
  'aria-expanded',
  'aria-pressed',
  'aria-selected',
]);

/** `classList.add(...)` y compañía: la lista de argumentos, sin paréntesis. */
const CLASS_LIST_CALL = /\bclassList\.(add|remove|toggle|replace|contains)\s*\(([^()]*)\)/g;
const CLASS_ASSIGNMENT =
  /\bclassName\s*=\s*(?:`([^`]*)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
const CLASS_ATTRIBUTE =
  /\bsetAttribute\s*\(\s*['"]class['"]\s*,\s*(?:`([^`]*)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*\)/g;
const STRING_IN_ARGUMENT = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
/** Comparaciones: `state === 'done'` es un valor de estado, no una clase. */
const COMPARISON = /[=!]==?/;

/** Palabras de un valor de `class`: la interpolación no se puede leer estática. */
function classTokens(value: string): string[] {
  return value
    .replace(/\$\{[^}]*\}/g, ' ')
    .split(/\s+/)
    .filter((token) => /^[A-Za-z][\w-]*$/.test(token));
}

/**
 * Clases que la vista escribe o consulta, con el primer sitio donde aparecen:
 *
 * - `classList.add/remove/toggle/replace/contains(...)`, todos sus argumentos
 *   menos los que son comparaciones (`toggle('on', plugin.hasLoader)`);
 * - `className = …`, también con plantilla (`\`status ${kind}\`` aporta
 *   `status` y deja la variable sin resolver);
 * - `setAttribute('class', …)`;
 * - las clases de los selectores literales (`querySelector('.badge.on')`).
 *
 * Los nombres que solo llegan por una variable (`kind`) no se pueden atribuir a
 * una clase concreta sin ejecutar el código, así que no cuentan: si un elemento
 * del HTML depende de ellos, la clase debe estar también en el CSS.
 */
export function classNamesInSource(sources: Iterable<UiSource>): Map<string, string> {
  const classes = new Map<string, string>();
  const add = (name: string, origin: string): void => {
    if (name !== '' && !classes.has(name)) classes.set(name, origin);
  };

  for (const { file, source } of sources) {
    const lineAt = (index: number): number => source.slice(0, index).split('\n').length;

    for (const match of source.matchAll(CLASS_LIST_CALL)) {
      const origin = `${file}:${lineAt(match.index)}`;
      for (const argument of splitSelectorList(match[2] ?? '')) {
        if (COMPARISON.test(argument)) continue;
        for (const literal of argument.matchAll(STRING_IN_ARGUMENT)) {
          for (const token of classTokens(literal[1] ?? literal[2] ?? '')) add(token, origin);
        }
      }
    }

    for (const pattern of [CLASS_ASSIGNMENT, CLASS_ATTRIBUTE]) {
      for (const match of source.matchAll(pattern)) {
        const origin = `${file}:${lineAt(match.index)}`;
        for (const token of classTokens(match[1] ?? match[2] ?? match[3] ?? '')) add(token, origin);
      }
    }

    // Un selector literal también nombra clases que la vista consulta.
    for (const reference of scanUiSource(source, file).selectors) {
      for (const match of reference.value.matchAll(/\.([\w-]+)/g)) {
        add(match[1]!, `${file}:${reference.line}`);
      }
    }
  }

  return classes;
}

/**
 * Auditoría inversa de `index.html`: qué ids, clases, atributos `data-*` y
 * estados ARIA del marcado no usa nadie.
 *
 * Un id vale si lo pinta el CSS (`#id`), lo busca la vista (`byId`,
 * `getElementById`, `#id` en un selector) o lo referencia otro atributo del
 * propio HTML (`for`, `aria-labelledby`, `href="#…"`). Una clase vale si tiene
 * regla en `styles.css` o si la vista la escribe o la consulta
 * (`classNamesInSource`). Un `data-*` vale si un selector del CSS o de la vista
 * lo exige con ese valor (`[data-field="name"]`), o si la vista lee el atributo
 * entero con `dataset`; una escritura (`dataset.x = …`) no cuenta, porque no
 * prueba que ese atributo del HTML se consulte. Un ARIA vale si es declarativo
 * (rol, nombre, live region, relación o propiedad fija) o si es uno de los
 * estados de `STATEFUL_ARIA` y el CSS o la vista lo consultan o actualizan, con
 * el valor exigido cuando el selector lo fija. Lo que no cumpla nada es
 * marcado muerto: o sobra, o hay que documentar por qué se queda.
 */
export function auditMarkup(
  root: HtmlNode,
  css: string,
  sources: Iterable<UiSource>,
): MarkupAudit {
  const allSources = [...sources];
  const cssNames = new Set<string>();
  for (const rule of parseCssSelectors(css)) {
    for (const selector of splitSelectorList(rule.selector)) {
      for (const name of selectorNames(selector)) cssNames.add(name);
    }
  }

  const usedIds = new Set<string>();
  for (const { file, source } of allSources) {
    for (const reference of scanUiSource(source, file).ids) usedIds.add(reference.value);
  }
  for (const reference of htmlIdReferences(root)) usedIds.add(reference.id);

  const ids = elementIds(root);
  const deadIds = [...ids].filter((id) => !usedIds.has(id) && !cssNames.has(id)).sort();

  const usedClasses = classNamesInSource(allSources);
  const classes = elementClasses(root);
  const deadClasses = [...classes.keys()]
    .filter((name) => !usedClasses.has(name) && !cssNames.has(name))
    .sort();

  const dataReferences: UiDataReference[] = allSources.flatMap(
    ({ file, source }) => scanUiSource(source, file).data,
  );
  const ariaReferences: UiAriaReference[] = allSources.flatMap(
    ({ file, source }) => scanUiSource(source, file).aria,
  );
  for (const rule of parseCssSelectors(css)) {
    for (const selector of splitSelectorList(rule.selector)) {
      dataReferences.push(...dataReferencesInSelector(selector, 'styles.css', rule.line));
      ariaReferences.push(...ariaReferencesInSelector(selector, 'styles.css', rule.line));
    }
  }

  const attributes = elementDataAttributes(root);
  const deadData = [
    ...new Set(
      attributes
        .filter(({ attribute, value }) => {
          if (DECLARATIVE_DATA_ATTRIBUTES.has(attribute)) return false;
          const references = dataReferences.filter(
            (reference) => reference.attribute === attribute,
          );
          // Sin valor (`<div data-open>`) basta con que alguien nombre el
          // atributo; con valor, la referencia tiene que ser genérica o pedir
          // justo ese valor.
          return value === ''
            ? references.length === 0
            : !references.some(
                (reference) => reference.value === null || reference.value === value,
              );
        })
        .map(({ attribute, value }) => (value === '' ? attribute : `${attribute}="${value}"`)),
    ),
  ].sort();

  const ariaAttributes = elementAriaAttributes(root);
  const deadAria = [
    ...new Set(
      ariaAttributes
        .filter(({ attribute, value }) => {
          // Un ARIA sin valor no lo consume nadie, ni siquiera un rol o un
          // nombre accesible: el árbol de accesibilidad necesita el valor.
          if (value === '') return true;
          if (!STATEFUL_ARIA.has(attribute)) return false;
          const references = ariaReferences.filter(
            (reference) => reference.attribute === attribute,
          );
          return !references.some(
            (reference) => reference.value === null || reference.value === value,
          );
        })
        .map(({ attribute, value }) => (value === '' ? attribute : `${attribute}="${value}"`)),
    ),
  ].sort();

  return {
    deadIds,
    deadClasses,
    deadData,
    deadAria,
    ids: ids.size,
    classes: classes.size,
    data: attributes.length,
    aria: ariaAttributes.length,
  };
}

function matches(root: HtmlNode, selector: string): boolean {
  try {
    return querySelectorAll(root, selector).length > 0;
  } catch {
    return false;
  }
}

/** Comprueba `css` contra el HTML y los nombres que puede crear la vista. */
export function auditCss(
  root: HtmlNode,
  css: string,
  dynamicNames: Iterable<string> = [],
): CssAudit {
  const staticNames = htmlNames(root);
  const fromSource = new Set(dynamicNames);
  const templates = templateRoots(root);
  const audit: CssAudit = { dead: [], structural: 0, dynamic: 0, unverified: 0, total: 0 };

  for (const rule of parseCssSelectors(css)) {
    for (const selector of splitSelectorList(rule.selector)) {
      audit.total += 1;
      const names = selectorNames(selector);
      const unknown = names.filter(
        (name) =>
          !NATIVE_STATE_ATTRIBUTES.has(name) && !DYNAMIC_DATA_ATTRIBUTES.has(name) && !staticNames.has(name) && !fromSource.has(name),
      );

      if (unknown.length > 0) {
        audit.dead.push({ selector, line: rule.line, unknown });
        continue;
      }

      const base = baseSelector(selector);
      if (base === null) {
        audit.unverified += 1;
        continue;
      }

      let found: number;
      try {
        found = querySelectorAll(root, base).length;
      } catch {
        audit.unverified += 1;
        continue;
      }
      if (found > 0) {
        audit.structural += 1;
        continue;
      }

      // Un estado nativo (`details[open]`) solo existe cuando el usuario abre el
      // desplegable: el HTML de partida no puede demostrarlo ni desmentirlo.
      if (names.some((name) => NATIVE_STATE_ATTRIBUTES.has(name))) {
        audit.unverified += 1;
        continue;
      }

      // Todos los nombres existen y aun así no hay coincidencia. Antes de darla
      // por muerta, dos salidas legítimas: que el JS escriba alguno de esos
      // nombres (clases de estado, `className` con plantilla) o que el elemento
      // final salga de la plantilla de filas, que la vista clona dentro del
      // `tbody` y por eso no cuelga de él en el HTML estático.
      const fromTemplate = templates.some((template) => {
        const subject = subjectSelector(base);
        return subject !== null && matches(template, subject);
      });
      if (fromTemplate || names.some((name) => fromSource.has(name))) {
        audit.dynamic += 1;
      } else {
        audit.dead.push({ selector, line: rule.line, unknown: [] });
      }
    }
  }

  return audit;
}

/**
 * Alto compartido de los controles de formulario.
 *
 * `input`, `select` y `button` tienen que sacar el `height` de la misma
 * variable: con valores propios, el mismo botón mide distinto según la fila y
 * el campo de al lado se desalinea. Se resuelve la cascada para un control
 * "a secas" —sin clases ni atributos que lo especialicen—, que es el caso de
 * los formularios; los controles compactos (chips, × de fila, filtros de la
 * tabla) fijan su alto con reglas propias y quedan fuera a propósito.
 */

/** Controles cuyo alto comparten formularios y filas de acciones. */
const CONTROL_TAGS = ['input', 'select', 'button'] as const;

export type ControlTag = (typeof CONTROL_TAGS)[number];

/** Motivo por el que un control no comparte el alto de la variable. */
export type ControlHeightProblem = 'variable-undefined' | 'missing-height' | 'fixed-height';

export interface ControlHeightOffender {
  control: ControlTag;
  problem: ControlHeightProblem;
  /** `height` que gana para ese control; `null` si ninguna regla lo fija. */
  value: string | null;
  /** Línea de la regla que fija ese `height`. */
  line: number | null;
}

export interface ControlHeightAudit {
  /** Definición de la variable, o `null` si nadie la declara. */
  variable: { value: string; line: number } | null;
  /** `height` que gana para cada control, con o sin desalineación. */
  controls: { control: ControlTag; value: string | null; line: number | null }[];
  offenders: ControlHeightOffender[];
}

/**
 * Comprueba que `input`, `select` y `button` llevan `height: var(<variable>)`.
 *
 * Solo cuentan las reglas que pintan el control a secas: un `height` dentro de
 * `.fila button` o `input[type='date']` es un override contextual legítimo y no
 * cambia el alto de un control normal. Entre las reglas que sí aplican gana la
 * de más especificidad y, a igualdad, la última, como en el navegador.
 */
export function auditControlHeight(
  css: string,
  variable = '--control-height',
): ControlHeightAudit {
  const name = variable.trim().toLowerCase();
  const rules = parseCssSelectors(css);

  let definition: { value: string; line: number } | null = null;
  for (const rule of rules) {
    const value = rule.declarations.get(name);
    if (value !== undefined && value.trim() !== '') definition = { value: value.trim(), line: rule.line };
  }

  // `var(--control-height)` con o sin valor de reserva: las dos formas dejan el
  // alto en manos de la misma variable.
  const usesVariable = new RegExp(`^var\\(\\s*${name}\\s*(?:,[\\s\\S]*)?\\)$`, 'i');

  const controls = CONTROL_TAGS.map((control) => {
    let best: { value: string; weight: number; order: number; line: number } | null = null;
    for (const [order, rule] of rules.entries()) {
      for (const selector of splitSelectorList(rule.selector)) {
        if (baseSelector(selector) !== control) continue;
        const height = rule.declarations.get('height');
        if (height === undefined) continue;
        const weight = specificity(selector);
        if (
          best === null ||
          weight > best.weight ||
          (weight === best.weight && order >= best.order)
        ) {
          best = { value: height.trim(), weight, order, line: rule.line };
        }
      }
    }
    return { control, value: best?.value ?? null, line: best?.line ?? null };
  });

  const offenders: ControlHeightOffender[] = [];
  for (const entry of controls) {
    if (definition === null) {
      offenders.push({
        control: entry.control,
        problem: 'variable-undefined',
        value: entry.value,
        line: entry.line,
      });
    } else if (entry.value === null) {
      offenders.push({
        control: entry.control,
        problem: 'missing-height',
        value: null,
        line: null,
      });
    } else if (!usesVariable.test(entry.value)) {
      offenders.push({
        control: entry.control,
        problem: 'fixed-height',
        value: entry.value,
        line: entry.line,
      });
    }
  }

  return { variable: definition, controls, offenders };
}

/**
 * Auditoría del scroll interno de las tablas paginadas.
 *
 * Un cajón se desplaza solo (`.drawer { overflow-y: auto }`), y por eso la
 * regla genérica `.drawer .table-wrap` recorta cualquier tabla a 260 px. Una
 * tabla que pagina ya limita su alto con el paginador: recortarla además deja
 * dos barras verticales y esconde filas que el usuario no puede ver de otra
 * forma. Aquí se recorre el CSS que gana para el `.table-wrap` de cada tabla
 * paginada que vive dentro de un cajón y se falla si vuelve a recortarse o a
 * desplazarse por dentro.
 *
 * La cascada se resuelve de forma mínima pero suficiente para estas reglas:
 * especificidad y orden del archivo, y el emparejamiento de los compuestos del
 * selector contra el contenedor y sus ancestros en el HTML.
 */

/** Contenedor de tabla: la clase con la que `mountTable` monta cada vista. */
const TABLE_CONTAINER = /-table$/;

/** Valores que no limitan el alto ni crean caja de desplazamiento. */
const NEUTRAL_VALUES = new Set(['none', 'initial', 'unset', 'revert', 'revert-layer', 'visible']);

interface ElementFacts {
  tag: string;
  id: string;
  classes: Set<string>;
}

function facts(node: HtmlNode): ElementFacts {
  return {
    tag: node.tagName.toLowerCase(),
    id: node.attributes['id'] ?? '',
    classes: new Set(
      (node.attributes['class'] ?? '').split(/\s+/).filter((token) => token !== ''),
    ),
  };
}

/** ¿El compuesto (`div`, `.card`, `#audit-table`) describe a este elemento? */
function matchesCompound(compound: string, element: ElementFacts): boolean {
  const tokens = compound.match(/[#.]?[\w-]+/g);
  if (tokens === null) return false;
  return tokens.every((token) => {
    const name = token.slice(1);
    if (token.startsWith('#')) return element.id === name;
    if (token.startsWith('.')) return element.classes.has(name);
    return element.tag === name.toLowerCase();
  });
}

/** Ancestros del `.table-wrap` que la vista inserta dentro del contenedor. */
function wrapAncestors(container: HtmlNode): ElementFacts[] {
  const ancestors: ElementFacts[] = [];
  for (let node: HtmlNode | null = container; node !== null; node = node.parent) {
    ancestors.push(facts(node));
  }
  return ancestors;
}

/**
 * ¿La regla pinta el `.table-wrap` de este contenedor? La parte derecha del
 * selector tiene que ser exactamente `.table-wrap`; el resto se empareja contra
 * los ancestros, de derecha a izquierda y con combinador de descendiente.
 */
function targetsWrap(selector: string, ancestors: ElementFacts[]): boolean {
  const base = baseSelector(selector);
  if (base === null) return false;

  const compounds = base.split(/\s*>\s*|\s+/).filter((part) => part !== '');
  if (compounds[compounds.length - 1] !== '.table-wrap') return false;

  let index = 0;
  for (let position = compounds.length - 2; position >= 0; position -= 1) {
    const compound = compounds[position]!;
    let found = false;
    while (index < ancestors.length) {
      const element = ancestors[index]!;
      index += 1;
      if (matchesCompound(compound, element)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }

  return true;
}

/** Especificidad aproximada: ids > clases/atributos > etiquetas. */
function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes =
    (selector.match(/\.[\w-]+/g) ?? []).length + (selector.match(/\[[^\]]*\]/g) ?? []).length;
  const tags = (selector.match(/(?:^|[\s>])[a-zA-Z][\w-]*/g) ?? []).length;
  return ids * 100 + classes * 10 + tags;
}

export interface TableScrollOffender {
  /** Contenedor de la tabla, por su id (`#audit-table`). */
  table: string;
  /** `max-height`, `overflow-y` o `overflow`. */
  property: string;
  value: string;
  /** Línea de la regla que gana en `styles.css`. */
  line: number;
}

export interface TableScrollAudit {
  /** Tablas paginadas que viven dentro de un cajón: las auditadas. */
  tables: string[];
  offenders: TableScrollOffender[];
}

/** Contenedores `*-table` del marcado, que son los que monta `mountTable`. */
function tableContainers(root: HtmlNode): HtmlNode[] {
  const found: HtmlNode[] = [];
  const visit = (node: HtmlNode): void => {
    const classes = (node.attributes['class'] ?? '').split(/\s+/);
    if (classes.some((name) => TABLE_CONTAINER.test(name))) found.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return found;
}

function label(container: HtmlNode): string {
  const id = container.attributes['id'];
  if (id !== undefined && id !== '') return `#${id}`;
  return `.${(container.attributes['class'] ?? '').split(/\s+/)[0] ?? container.tagName}`;
}

/**
 * Comprueba que ninguna tabla paginada de un cajón recupere scroll propio.
 * Devuelve las tablas auditadas (para que el test no pase por vacuidad) y las
 * declaraciones que las recortan o las desplazan.
 */
export function auditPaginatedTableScroll(root: HtmlNode, css: string): TableScrollAudit {
  const rules = parseCssSelectors(css);
  const tables: string[] = [];
  const offenders: TableScrollOffender[] = [];

  for (const container of tableContainers(root)) {
    const ancestors = wrapAncestors(container);
    if (!ancestors.some((element) => element.classes.has('drawer'))) continue;

    const name = label(container);
    tables.push(name);

    // Reglas que pueden aplicar al `.table-wrap`, con su peso en la cascada.
    const candidates: { property: string; value: string; specificity: number; order: number; line: number }[] = [];
    rules.forEach((rule, order) => {
      for (const selector of splitSelectorList(rule.selector)) {
        if (!targetsWrap(selector, ancestors)) continue;
        const weight = specificity(selector);
        for (const [property, value] of rule.declarations) {
          candidates.push({ property, value, specificity: weight, order, line: rule.line });
        }
      }
    });

    /** La declaración que gana para una propiedad, o `null` si nadie la fija. */
    const winner = (
      property: string,
    ): { value: string; line: number } | null => {
      let best: (typeof candidates)[number] | null = null;
      for (const candidate of candidates) {
        if (candidate.property !== property) continue;
        if (
          best === null ||
          candidate.specificity > best.specificity ||
          (candidate.specificity === best.specificity && candidate.order >= best.order)
        ) {
          best = candidate;
        }
      }
      return best === null ? null : { value: best.value.toLowerCase(), line: best.line };
    };

    const height = winner('max-height');
    if (height !== null && !NEUTRAL_VALUES.has(height.value)) {
      offenders.push({ table: name, property: 'max-height', value: height.value, line: height.line });
    }

    // `overflow-y` manda; si nadie la escribe, vale el eje vertical del atajo
    // `overflow` (segundo valor, o el primero si es único).
    const vertical = winner('overflow-y');
    if (vertical !== null) {
      if (vertical.value !== 'visible' && vertical.value !== 'initial' && vertical.value !== 'unset' && vertical.value !== 'revert' && vertical.value !== 'revert-layer') {
        offenders.push({ table: name, property: 'overflow-y', value: vertical.value, line: vertical.line });
      }
    } else {
      const shorthand = winner('overflow');
      if (shorthand !== null) {
        const parts = shorthand.value.split(/\s+/);
        const value = (parts[1] ?? parts[0] ?? '').toLowerCase();
        if (!NEUTRAL_VALUES.has(value)) {
          offenders.push({ table: name, property: 'overflow', value: shorthand.value, line: shorthand.line });
        }
      }
    }
  }

  return { tables, offenders };
}
