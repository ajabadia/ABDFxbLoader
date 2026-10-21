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

import { querySelectorAll, type HtmlNode } from './ui-dom';

export interface CssRule {
  /** Preludio completo de la regla, tal cual (puede ser una lista con comas). */
  selector: string;
  /** Línea (1-based) donde empieza el selector. */
  line: number;
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
 * Selectores de las reglas de un CSS, en orden y con su línea. Ignora los
 * preludios de at-rules (`@media`, `@supports`) y el interior de `@keyframes`,
 * cuyos pasos (`from`, `50%`) no son selectores de elementos.
 */
export function parseCssSelectors(css: string): CssRule[] {
  // Los comentarios se sustituyen por espacios conservando los saltos de línea
  // para que los números de línea sigan siendo los del archivo.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  const rules: CssRule[] = [];
  const blocks: ('at' | 'style' | 'skip')[] = [];
  let preludeStart = 0;

  const lineAt = (offset: number): number => text.slice(0, offset).split('\n').length;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') {
      const raw = text.slice(preludeStart, index);
      const prelude = raw.trim();
      const parent = blocks[blocks.length - 1];

      if (prelude.startsWith('@')) {
        blocks.push(AT_RULE_WITHOUT_SELECTORS.test(prelude) ? 'skip' : 'at');
      } else {
        // Solo los bloques de declaraciones de una regla (o de una regla dentro
        // de un at-rule) son selectores; el resto es cuerpo de declaraciones.
        if (prelude !== '' && (parent === undefined || parent === 'at')) {
          const offset = preludeStart + (raw.length - raw.trimStart().length);
          rules.push({ selector: prelude, line: lineAt(offset) });
        }
        blocks.push('style');
      }

      preludeStart = index + 1;
      continue;
    }

    if (character === '}') {
      blocks.pop();
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
 * Nombres que puede crear la vista: clases y valores escritos en un literal de
 * `src/ui`. Los literales con interpolación también aportan sus trozos
 * (`status ${kind}` → `status`), que es lo que se busca aquí.
 */
export function sourceNames(sources: Iterable<string>): Set<string> {
  const names = new Set<string>();

  for (const source of sources) {
    for (const match of source.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const value = match[1] ?? match[2] ?? match[3] ?? '';
      for (const token of value.match(/[A-Za-z][\w-]*/g) ?? []) names.add(token);
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
        (name) => !staticNames.has(name) && !fromSource.has(name),
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
