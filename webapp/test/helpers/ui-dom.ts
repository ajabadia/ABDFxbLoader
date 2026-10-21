/**
 * Comprobación estática de la UI: parsea `public/index.html` y resuelve los ids
 * y selectores que el código escribe a mano, para que un `#id`, un
 * `[data-field="…"]` o un `for="…"` mal escrito falle en los tests en vez de al
 * abrir la página.
 *
 * No es un navegador: cubre el subconjunto de CSS que usa la UI (etiqueta, `#id`,
 * `.clase`, `[atributo]`/`[atributo="valor"]`, descendiente, hijo `>` y grupos
 * separados por comas). Un selector fuera de ese subconjunto lanza, para que el
 * test no lo ignore en silencio.
 */

export interface HtmlNode {
  tagName: string;
  attributes: Record<string, string>;
  children: HtmlNode[];
  parent: HtmlNode | null;
}

/** Elementos sin cierre: no se apilan al parsear. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const COMMENT_RE = /<!--[\s\S]*?-->/g;
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^<>"'])*?)(\/?)>/g;
const ATTRIBUTE_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE_RE)) {
    const name = match[1]!.toLowerCase();
    attributes[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

/**
 * Árbol del HTML. Tolera etiquetas sin cerrar (pop hasta la que coincide) y
 * trata el contenido de `<template>` como hijos normales, que es donde vive la
 * plantilla de filas de la tabla.
 */
export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tagName: '#document', attributes: {}, children: [], parent: null };
  const stack: HtmlNode[] = [root];

  for (const match of html.replace(COMMENT_RE, '').matchAll(TAG_RE)) {
    const closing = match[1] === '/';
    const tagName = match[2]!.toLowerCase();

    if (closing) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index]!.tagName === tagName) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const parent = stack[stack.length - 1]!;
    const node: HtmlNode = {
      tagName,
      attributes: parseAttributes(match[3] ?? ''),
      children: [],
      parent,
    };
    parent.children.push(node);
    if (!VOID_TAGS.has(tagName) && match[4] !== '/') stack.push(node);
  }

  return root;
}

/** Todos los `id="…"` del documento. */
export function elementIds(root: HtmlNode): Set<string> {
  const ids = new Set<string>();
  const visit = (node: HtmlNode): void => {
    const id = node.attributes['id'];
    if (id !== undefined && id !== '') ids.add(id);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return ids;
}

interface Compound {
  tag: string | null;
  ids: string[];
  classes: string[];
  attributes: { name: string; value: string | null }[];
}

interface SelectorPart {
  /** Relación con la parte anterior: descendiente o hijo directo. */
  combinator: ' ' | '>';
  compound: Compound;
}

/** Divide sin romper por comas que estén dentro de corchetes o comillas. */
function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let brackets = 0;
  let quote: string | null = null;

  for (const character of value) {
    if (quote !== null) {
      if (character === quote) quote = null;
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === '[') brackets += 1;
    if (character === ']') brackets -= 1;
    if (character === separator && brackets === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

function parseCompound(text: string): Compound {
  const compound: Compound = { tag: null, ids: [], classes: [], attributes: [] };
  let rest = text;

  const tag = /^([a-zA-Z][\w-]*|\*)/.exec(rest);
  if (tag !== null) {
    if (tag[1] !== '*') compound.tag = tag[1]!.toLowerCase();
    rest = rest.slice(tag[0].length);
  }

  while (rest !== '') {
    if (rest.startsWith('#')) {
      const id = /^#([\w-]+)/.exec(rest);
      if (id === null) throw new Error(`selector no soportado: "${text}"`);
      compound.ids.push(id[1]!);
      rest = rest.slice(id[0].length);
      continue;
    }
    if (rest.startsWith('.')) {
      const cls = /^\.([\w-]+)/.exec(rest);
      if (cls === null) throw new Error(`selector no soportado: "${text}"`);
      compound.classes.push(cls[1]!);
      rest = rest.slice(cls[0].length);
      continue;
    }
    if (rest.startsWith('[')) {
      const attribute = /^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/.exec(
        rest,
      );
      if (attribute === null) throw new Error(`selector no soportado: "${text}"`);
      compound.attributes.push({
        name: attribute[1]!.toLowerCase(),
        value: attribute[2] ?? attribute[3] ?? attribute[4] ?? null,
      });
      rest = rest.slice(attribute[0].length);
      continue;
    }
    throw new Error(`selector no soportado: "${text}"`);
  }

  if (compound.tag === null && compound.ids.length === 0 && compound.classes.length === 0) {
    if (compound.attributes.length === 0) throw new Error(`selector no soportado: "${text}"`);
  }
  return compound;
}

function parseGroup(group: string): SelectorPart[] {
  const parts: SelectorPart[] = [];
  let index = 0;

  while (index < group.length) {
    let child = false;
    while (index < group.length && /[\s>]/.test(group[index]!)) {
      if (group[index] === '>') child = true;
      index += 1;
    }
    if (index >= group.length) break;

    const start = index;
    let brackets = 0;
    while (index < group.length) {
      const character = group[index]!;
      if (character === '[') brackets += 1;
      else if (character === ']') brackets -= 1;
      else if (brackets === 0 && /[\s>]/.test(character)) break;
      index += 1;
    }

    const combinator: ' ' | '>' = parts.length === 0 ? ' ' : child ? '>' : ' ';
    parts.push({ combinator, compound: parseCompound(group.slice(start, index)) });
  }

  if (parts.length === 0) throw new Error(`selector vacío: "${group}"`);
  return parts;
}

/** Grupos del selector; cada grupo es una cadena de partes con su combinador. */
function parseSelector(selector: string): SelectorPart[][] {
  const groups = splitTopLevel(selector, ',')
    .map((group) => group.trim())
    .filter((group) => group !== '');
  if (groups.length === 0) throw new Error(`selector vacío: "${selector}"`);
  return groups.map(parseGroup);
}

function matchesCompound(node: HtmlNode, compound: Compound): boolean {
  if (node.tagName === '#document') return false;
  if (compound.tag !== null && node.tagName !== compound.tag) return false;

  for (const id of compound.ids) {
    if (node.attributes['id'] !== id) return false;
  }

  const classes = (node.attributes['class'] ?? '').split(/\s+/).filter((name) => name !== '');
  for (const name of compound.classes) {
    if (!classes.includes(name)) return false;
  }

  for (const attribute of compound.attributes) {
    if (!(attribute.name in node.attributes)) return false;
    if (attribute.value !== null && node.attributes[attribute.name] !== attribute.value) return false;
  }
  return true;
}

function matchesPart(node: HtmlNode, parts: SelectorPart[], index: number): boolean {
  if (!matchesCompound(node, parts[index]!.compound)) return false;
  if (index === 0) return true;

  if (parts[index]!.combinator === '>') {
    return node.parent !== null && matchesPart(node.parent, parts, index - 1);
  }
  for (let ancestor = node.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (matchesPart(ancestor, parts, index - 1)) return true;
  }
  return false;
}

/** Todos los elementos del árbol que cumplen el selector. */
export function querySelectorAll(root: HtmlNode, selector: string): HtmlNode[] {
  const groups = parseSelector(selector);
  const found: HtmlNode[] = [];

  const visit = (node: HtmlNode): void => {
    for (const child of node.children) {
      if (groups.some((group) => matchesPart(child, group, group.length - 1))) found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

export interface UiReference {
  value: string;
  /** Archivo relativo a `src/ui`, para el mensaje de error. */
  file: string;
  line: number;
}

export interface UiReferences {
  /** Ids pedidos por `byId`, `getElementById` y `#id` dentro de un selector. */
  ids: UiReference[];
  /** Selectores literales pasados a las APIs de DOM. */
  selectors: UiReference[];
  /** Selectores con plantilla (`` `#${x}` ``): no se pueden comprobar. */
  dynamic: UiReference[];
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * Literal de cadena con comillas simples o dobles. Admite la otra comilla
 * dentro (`'[data-field="name"]'`) y los escapes (`\'`).
 */
const STRING_LITERAL = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")`;

const BY_ID_CALL = new RegExp(
  String.raw`\b(?:byId|getElementById)\s*(?:<[^>]*>)?\s*\(\s*${STRING_LITERAL}`,
  'g',
);
const SELECTOR_CALLS = [
  new RegExp(
    String.raw`\bquerySelector(?:All)?\s*(?:<[^>]*>)?\s*\(\s*${STRING_LITERAL}`,
    'g',
  ),
  new RegExp(String.raw`\b(?:closest|matches)\s*(?:<[^>]*>)?\s*\(\s*${STRING_LITERAL}`, 'g'),
  // `query(raíz, 'selector')` de `dom.ts`.
  new RegExp(String.raw`\bquery\s*(?:<[^>]*>)?\s*\(\s*[^,]+,\s*${STRING_LITERAL}`, 'g'),
];

/** Valor del literal capturado (grupo 1 o 2, según el tipo de comilla). */
function literalValue(match: RegExpMatchArray): string {
  return match[1] ?? match[2] ?? '';
}
const DYNAMIC_CALLS = [
  /\b(?:byId|getElementById|querySelector(?:All)?|closest|matches)\s*(?:<[^>]*>)?\s*\(\s*`/g,
  /\bquery\s*(?:<[^>]*>)?\s*\(\s*[^,]+,\s*`/g,
];

/**
 * Extrae de un fuente de la UI los ids y selectores literales que usa. Los
 * selectores dinámicos se devuelven aparte para que el test pueda rechazarlos.
 */
export function scanUiSource(source: string, file: string): UiReferences {
  const references: UiReferences = { ids: [], selectors: [], dynamic: [] };

  for (const match of source.matchAll(BY_ID_CALL)) {
    references.ids.push({ value: literalValue(match), file, line: lineAt(source, match.index) });
  }

  for (const pattern of SELECTOR_CALLS) {
    for (const match of source.matchAll(pattern)) {
      const selector = literalValue(match);
      const line = lineAt(source, match.index);
      references.selectors.push({ value: selector, file, line });
      for (const id of selector.matchAll(/#([\w-]+)/g)) {
        references.ids.push({ value: id[1]!, file, line });
      }
    }
  }

  for (const pattern of DYNAMIC_CALLS) {
    for (const match of source.matchAll(pattern)) {
      references.dynamic.push({
        value: source.slice(match.index, match.index + 80).split('\n')[0]!,
        file,
        line: lineAt(source, match.index),
      });
    }
  }

  // Cada patrón recorre la fuente por su cuenta; se ordena por línea para que
  // los mensajes sigan el orden del archivo.
  const byLine = (a: UiReference, b: UiReference): number => a.line - b.line;
  references.ids.sort(byLine);
  references.selectors.sort(byLine);
  references.dynamic.sort(byLine);
  return references;
}

export interface HtmlIdReference {
  id: string;
  /** Etiqueta y atributo que lo referencia, para el mensaje de error. */
  origin: string;
}

/**
 * Ids que `index.html` referencia desde atributos: `for` de las etiquetas,
 * `aria-labelledby`/`aria-describedby`/`aria-controls` y enlaces internos.
 */
export function htmlIdReferences(root: HtmlNode): HtmlIdReference[] {
  const references: HtmlIdReference[] = [];
  const attributes = ['for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns'];

  const visit = (node: HtmlNode): void => {
    for (const name of attributes) {
      const value = node.attributes[name];
      if (value === undefined) continue;
      for (const id of value.split(/\s+/).filter((token) => token !== '')) {
        references.push({ id, origin: `<${node.tagName} ${name}="${value}">` });
      }
    }

    const href = node.attributes['href'];
    if (href !== undefined && href.startsWith('#') && href.length > 1) {
      references.push({ id: href.slice(1), origin: `<${node.tagName} href="${href}">` });
    }

    for (const child of node.children) visit(child);
  };
  visit(root);
  return references;
}
