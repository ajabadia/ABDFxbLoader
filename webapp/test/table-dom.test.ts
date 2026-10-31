import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mountTable, type TableView } from '../src/ui/table';

class FakeElement {
  children: FakeElement[] = [];
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = { toggle: (_name: string, _value: boolean) => undefined, add: (_name: string) => undefined, remove: (_name: string) => undefined };
  hidden = false; disabled = false; value = ''; textContent = '';
  type = ''; className = ''; scope = ''; placeholder = '';
  listeners: Record<string, Array<() => void>> = {};
  append(...items: FakeElement[]) { this.children.push(...items); }
  appendChild(item: FakeElement) { this.children.push(item); return item; }
  replaceChildren(...items: FakeElement[]) { this.children = items; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(type: string, listener: () => void) { (this.listeners[type] ??= []).push(listener); }
  removeEventListener() {}
  focus() {}
  click() { for (const listener of this.listeners.click ?? []) (listener as unknown as (event: { stopPropagation(): void }) => void)({ stopPropagation() {} }); }
  querySelectorAll<T extends FakeElement>(selector: string): T[] {
    const matches: FakeElement[] = [];
    const visit = (node: FakeElement) => { for (const child of node.children) { if (selector === '.row-menu-dropdown' && child.className === 'row-menu-dropdown' || selector === '.row-menu-btn' && child.className === 'row-menu-btn') matches.push(child); visit(child); } };
    visit(this); return matches as T[];
  }
  get isConnected() { return true; }
  find(predicate: (element: FakeElement) => boolean): FakeElement | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) { const found = child.find(predicate); if (found) return found; }
    return undefined;
  }
  get childElementCount() { return this.children.length; }
  querySelector(selector: string): FakeElement | null {
    if (selector === 'button') return this.children.find(child => child.tagName === 'button') ?? null;
    return null;
  }
  get tagName() { return this.attributes['tag'] ?? ''; }
}
const fakeDocument = {
  createElement(tag: string) { const el = new FakeElement(); el.attributes['tag'] = tag; return el; },
  createTextNode(text: string) { const el = new FakeElement(); el.textContent = text; return el; },
};

// The pure processing tests exercise data semantics; this deliberately small DOM
// harness only asserts that headers and controls are emitted from the view.
test('mountTable emits an unlabeled actions column and runs row menu actions', () => {
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = fakeDocument;
  try {
    const root = new FakeElement();
    const invoked: string[] = [];
    const view: TableView<{ name: string }> = {
      columns: [{ id: 'name', label: 'Nombre', getValue: row => row.name }],
      getRowId: row => row.name,
      initialSort: { columnId: 'name', direction: 'asc' },
      rowActions: { actions: [{ id: 'inspect', label: 'Inspeccionar', onSelect: row => invoked.push(row.name) }] },
    };
    mountTable(root as unknown as HTMLElement, view, [{ name: 'uno' }]);
    const rootTree = root.children[0]!;
    assert.ok(JSON.stringify(rootTree).includes('table-actions-heading'));
    const menuButton = rootTree.find(element => element.className === 'row-menu-btn');
    const dropdown = rootTree.find(element => element.className === 'row-menu-dropdown');
    const actionButton = rootTree.find(element => element.dataset['action'] === 'inspect');
    assert.ok(menuButton);
    assert.ok(dropdown);
    assert.ok(actionButton);
    assert.equal(menuButton.textContent, '···');
    assert.equal(dropdown.hidden, true);
    menuButton.click();
    assert.equal(dropdown.hidden, false);
    assert.equal(menuButton.attributes['aria-expanded'], 'true');
    actionButton.click();
    assert.equal(dropdown.hidden, true);
    assert.deepEqual(invoked, ['uno']);
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
});

test('setRows conserva abierto el menú «···» de la fila que sigue en la tabla', () => {
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = fakeDocument;
  try {
    const root = new FakeElement();
    const view: TableView<{ name: string }> = {
      columns: [{ id: 'name', label: 'Nombre', getValue: row => row.name }],
      getRowId: row => row.name,
      initialSort: { columnId: 'name', direction: 'asc' },
      rowActions: { actions: [{ id: 'inspect', label: 'Inspeccionar', onSelect: () => undefined }] },
    };
    const table = mountTable(root as unknown as HTMLElement, view, [
      { name: 'alfa' },
      { name: 'beta' },
    ]);
    const rootTree = root.children[0]!;
    const menuButton = rootTree.find((element) => element.className === 'row-menu-btn')!;
    const dropdown = rootTree.find((element) => element.className === 'row-menu-dropdown')!;
    menuButton.click();
    assert.equal(dropdown.hidden, false);

    // El sondeo repinta con una fila más: el menú de «alfa» sigue abierto.
    table.setRows([{ name: 'alfa' }, { name: 'beta' }, { name: 'gamma' }]);
    const reopenedButton = rootTree.find((element) => element.className === 'row-menu-btn')!;
    const reopenedDropdown = rootTree.find((element) => element.className === 'row-menu-dropdown')!;
    assert.equal(reopenedDropdown.hidden, false, 'la recarga no cierra el menú abierto');
    assert.equal(reopenedButton.attributes['aria-expanded'], 'true');

    // Sin su fila no se abre el menú de otra: se cierra.
    table.setRows([{ name: 'beta' }]);
    const otherDropdown = rootTree.find((element) => element.className === 'row-menu-dropdown')!;
    assert.equal(otherDropdown.hidden, true, 'el menú de una fila que ya no está se cierra');
    table.destroy();
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
});

test('mountTable emits search, sortable headers and a default 10-row pager', () => {
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = fakeDocument;
  try {
    const root = new FakeElement();
    const view: TableView<{ name: string }> = {
      columns: [{ id: 'name', label: 'Nombre', getValue: row => row.name }],
      getRowId: row => row.name,
      initialSort: { columnId: 'name', direction: 'asc' },
    };
    const table = mountTable(root as unknown as HTMLElement, view, [{ name: 'uno' }]);
    assert.equal(root.children.length, 1);
    assert.ok(JSON.stringify(root.children[0]).includes('Buscar en la tabla'));
    assert.ok(JSON.stringify(root.children[0]).includes('Ordenar por Nombre'));
    const sizeSelect = root.children[0]!.find((element) => element.className === 'pagination-select')!;
    assert.deepEqual(sizeSelect.children.map((option) => option.value), ['10', '25', '50', '100', '200']);
    assert.equal(sizeSelect.value, '10', 'el paginador arranca en 10 filas por página');
    table.destroy();
    assert.equal(root.children.length, 0);
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
});

test('mountTable avisa de cada cambio de búsqueda con el texto actual', () => {
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = fakeDocument;
  try {
    const root = new FakeElement();
    const seen: string[] = [];
    const view: TableView<{ name: string }> = {
      columns: [{ id: 'name', label: 'Nombre', getValue: row => row.name }],
      getRowId: row => row.name,
      initialSort: { columnId: 'name', direction: 'asc' },
      onSearchChange: query => seen.push(query),
    };
    const table = mountTable(root as unknown as HTMLElement, view, [{ name: 'uno' }, { name: 'dos' }]);
    const search = root.children[0]!.find(element => element.className === 'table-search');
    assert.ok(search, 'la vista monta su caja de búsqueda');

    const type = (value: string): void => {
      search.value = value;
      for (const listener of search.listeners['input'] ?? []) listener();
    };
    type('ob-');
    type('ob-xd');
    type('');

    assert.deepEqual(
      seen,
      ['ob-', 'ob-xd', ''],
      'cada pulsación avisa con el texto completo de la caja',
    );
    table.destroy();
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
});
