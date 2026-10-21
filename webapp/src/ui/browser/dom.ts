/** Helpers de DOM: fallan pronto si el HTML y la UI dejan de coincidir. */

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`La UI no tiene el elemento #${id}`);
  return element as T;
}

export function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`La UI no tiene el elemento ${selector}`);
  return element;
}

/** Primera fila de la plantilla, clonada y convertida a `<tr>`. */
export function cloneRow(template: HTMLTemplateElement): HTMLTableRowElement {
  const row = template.content.firstElementChild?.cloneNode(true);
  if (!(row instanceof HTMLTableRowElement)) {
    throw new Error('La plantilla de fila no empieza con un <tr>');
  }
  return row;
}

export function cell(span: number, text: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.colSpan = span;
  td.className = 'empty';
  td.textContent = text;
  return td;
}
