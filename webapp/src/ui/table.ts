export type TableSortType = 'text' | 'number' | 'date' | 'boolean';
export type TableDirection = 'asc' | 'desc';
export type TableFilterTone = 'neutral' | 'positive' | 'negative';

export interface TableColumn<T> {
  id: string;
  label: string;
  getValue: (row: T) => unknown;
  sortable?: boolean;
  sortType?: TableSortType;
  searchable?: boolean;
  renderCell?: (row: T, value: unknown) => string | number | null | undefined;
  renderNode?: (row: T, value: unknown) => Node | null | undefined;
  cellClass?: string | ((row: T, value: unknown) => string);
  cellTitle?: (row: T, value: unknown) => string | undefined;
  cellHref?: (row: T, value: unknown) => string | undefined;
  cellDataset?: (row: T, value: unknown) => Record<string, string>;
}

export interface TableFilterOption<T> {
  value: string;
  label: string;
  tone: TableFilterTone;
  predicate?: (row: T) => boolean;
}

export interface TableFilter<T> {
  id: string;
  label: string;
  columnId: string;
  type?: 'single';
  options?: readonly TableFilterOption<T>[];
}

export interface TableMultiSelectFilter<T> {
  id: string;
  label: string;
  columnId: string;
  type: 'multi-select';
  getOptions?: (rows: readonly T[]) => readonly { value: string; label: string }[];
}

export interface TableDateRangeFilter {
  id: string;
  label: string;
  columnId: string;
  type: 'date-range';
}

export type TableFilterDefinition<T> = TableFilter<T> | TableMultiSelectFilter<T> | TableDateRangeFilter;
export type TableFilterValue = string | string[] | { from: string; to: string };

export interface TableView<T> {
  columns: readonly TableColumn<T>[];
  getRowId: (row: T) => string;
  emptyText?: string;
  initialSort: { columnId: string; direction: TableDirection };
  pageSize?: number;
  searchColumns?: readonly string[];
  filters?: readonly TableFilterDefinition<T>[];
  rowActions?: TableRowActions<T>;
  rowClass?: (row: T) => string | undefined;
  tbodyId?: string;
}

export interface TableState {
  sort: { columnId: string; direction: TableDirection };
  query: string;
  filters: Record<string, TableFilterValue>;
  page: number;
  pageSize: number;
}

export interface ProcessedTable<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function compareValues(a: unknown, b: unknown, type: TableSortType): number {
  const aMissing = a === null || a === undefined || a === '';
  const bMissing = b === null || b === undefined || b === '';
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  if (type === 'number') {
    const left = Number(a); const right = Number(b);
    const leftInvalid = Number.isNaN(left); const rightInvalid = Number.isNaN(right);
    return leftInvalid || rightInvalid ? (leftInvalid === rightInvalid ? 0 : leftInvalid ? 1 : -1) : left - right;
  }
  if (type === 'date') {
    const left = Date.parse(String(a)); const right = Date.parse(String(b));
    const leftInvalid = Number.isNaN(left); const rightInvalid = Number.isNaN(right);
    return leftInvalid || rightInvalid ? (leftInvalid === rightInvalid ? 0 : leftInvalid ? 1 : -1) : left - right;
  }
  if (type === 'boolean') return Number(Boolean(a)) - Number(Boolean(b));
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
}

export function createTableState<T>(view: TableView<T>, rows: readonly T[] = []): TableState {
  return {
    sort: { ...view.initialSort }, query: '',
    filters: Object.fromEntries((view.filters ?? []).map(filter => {
      if (filter.type === 'multi-select') {
        const options: readonly { value: string; label: string }[] = filter.getOptions?.(rows) ?? [...new Set(rows.map(row => String(view.columns.find(column => column.id === filter.columnId)?.getValue(row) ?? '')))].filter(Boolean).sort((a, b) => a.localeCompare(b)).map(value => ({ value, label: value }));
        return [filter.id, options.map(option => option.value)];
      }
      if (filter.type === 'date-range') return [filter.id, { from: '', to: '' }];
      return [filter.id, filter.options?.[0]?.value ?? ''];
    })),
    page: 1, pageSize: Math.max(1, view.pageSize ?? 100),
  };
}

export function processTableRows<T>(rows: readonly T[], view: TableView<T>, state: TableState): ProcessedTable<T> {
  const searchable = view.searchColumns ?? view.columns.filter(column => column.searchable !== false).map(column => column.id);
  const query = state.query.trim().toLocaleLowerCase();
  let result = rows.filter(row => {
    for (const filter of view.filters ?? []) {
      const value = state.filters[filter.id];
      if (filter.type === 'multi-select') {
        const selected = Array.isArray(value) ? value : [];
        if (!selected.includes(String(view.columns.find(column => column.id === filter.columnId)?.getValue(row) ?? ''))) return false;
      } else if (filter.type === 'date-range') {
        const range = typeof value === 'object' && !Array.isArray(value) ? value : { from: '', to: '' };
        const timestamp = Date.parse(String(view.columns.find(column => column.id === filter.columnId)?.getValue(row) ?? ''));
        if (range.from) { const from = Date.parse(`${range.from}T00:00:00`); if (!Number.isNaN(from) && (Number.isNaN(timestamp) || timestamp < from)) return false; }
        if (range.to) { const to = Date.parse(`${range.to}T23:59:59.999`); if (!Number.isNaN(to) && (Number.isNaN(timestamp) || timestamp > to)) return false; }
      } else {
        const option = filter.options?.find(item => item.value === value);
        if (option?.predicate && !option.predicate(row)) return false;
      }
    }
    if (!query) return true;
    return searchable.some(id => {
      const value = view.columns.find(item => item.id === id)?.getValue(row);
      return value !== null && value !== undefined && String(value).toLocaleLowerCase().includes(query);
    });
  });
  const column = view.columns.find(item => item.id === state.sort.columnId);
  if (column && column.sortable !== false) {
    const sign = state.sort.direction === 'asc' ? 1 : -1;
    result = result.map((row, index) => ({ row, index })).sort((a, b) => {
      const left = column.getValue(a.row);
      const right = column.getValue(b.row);
      const leftMissing = left === null || left === undefined || left === '';
      const rightMissing = right === null || right === undefined || right === '';
      if (leftMissing || rightMissing) {
        return leftMissing === rightMissing ? a.index - b.index : leftMissing ? 1 : -1;
      }
      return compareValues(left, right, column.sortType ?? 'text') * sign || a.index - b.index;
    }).map(item => item.row);
  }
  const pageSize = Math.max(1, state.pageSize || view.pageSize || 100);
  const total = result.length; const totalPages = Math.ceil(total / pageSize);
  const page = totalPages === 0 ? 1 : Math.min(Math.max(1, state.page), totalPages);
  return { rows: result.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, totalPages };
}

export interface TableRowAction<T> {
  id: string;
  label: string;
  icon?: string;
  tone?: 'primary' | 'danger';
  disabled?: (row: T) => boolean;
  onSelect: (row: T, trigger: HTMLButtonElement) => void;
}

export interface TableRowActions<T> {
  actions: readonly TableRowAction<T>[] | ((row: T) => readonly TableRowAction<T>[]);
}

export interface TableController<T> { setRows(rows: readonly T[]): void; destroy(): void }

export function mountTable<T>(root: HTMLElement, view: TableView<T>, initialRows: readonly T[]): TableController<T> {
  let rows = [...initialRows]; const state = createTableState(view, rows);
  const listeners: Array<() => void> = [];
  const listen = (element: Element, type: string, listener: EventListener): void => {
    element.addEventListener(type, listener); listeners.push(() => element.removeEventListener(type, listener));
  };
  const shell = document.createElement('div'); shell.className = 'table-view';
  shell.setAttribute('data-table-empty-text', view.emptyText ?? 'No hay registros.');
  const toolbar = document.createElement('div'); toolbar.className = 'table-toolbar';
  let search: HTMLInputElement | null = null;
  if ((view.searchColumns ?? view.columns.filter(column => column.searchable !== false).map(column => column.id)).length) {
    search = document.createElement('input'); search.type = 'search'; search.className = 'table-search';
    search.setAttribute('aria-label', 'Buscar en la tabla'); search.placeholder = 'Buscar…';
    listen(search, 'input', () => { state.query = search!.value; state.page = 1; render(); }); toolbar.append(search);
  }
  for (const filter of view.filters ?? []) {
    if (filter.type === 'date-range') {
      const group = document.createElement('div'); group.className = 'table-filter table-date-range';
      const legend = document.createElement('span'); legend.className = 'table-filter-label'; legend.textContent = filter.label; group.append(legend);
      const range = state.filters[filter.id] as { from: string; to: string };
      for (const [key, text] of [['from', 'Desde'], ['to', 'Hasta']] as const) {
        const label = document.createElement('label'); label.textContent = text;
        const input = document.createElement('input'); input.type = 'date'; input.setAttribute('aria-label', `${filter.label} ${text.toLowerCase()}`); input.value = range[key];
        listen(input, 'change', () => { range[key] = input.value; state.page = 1; render(); }); label.append(input); group.append(label);
      }
      toolbar.append(group);
    } else if (filter.type === 'multi-select') {
      const group = document.createElement('div'); group.className = 'table-filter table-multi-filter';
      const selected = state.filters[filter.id] as string[];
      const options: readonly { value: string; label: string }[] = filter.getOptions?.(rows) ?? [...new Set(rows.map(row => String(view.columns.find(column => column.id === filter.columnId)?.getValue(row) ?? '')))].filter(Boolean).sort((a, b) => a.localeCompare(b)).map(value => ({ value, label: value }));
      const toggle = document.createElement('div'); toggle.className = 'filter-menu table-multi-menu';
      const summary = document.createElement('button'); summary.type = 'button'; summary.className = 'filter-btn table-multi-trigger';
      summary.setAttribute('aria-haspopup', 'true'); summary.setAttribute('aria-expanded', 'false');
      const updateTrigger = () => { const count = (state.filters[filter.id] as string[]).length; summary.textContent = `${filter.label} (${count})`; summary.dataset['tone'] = count === options.length ? 'neutral' : 'positive'; };
      const menu = document.createElement('div'); menu.className = 'filter-menu-list table-multi-menu-list'; menu.hidden = true; menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', filter.label);
      listen(summary, 'click', () => { menu.hidden = !menu.hidden; summary.setAttribute('aria-expanded', String(!menu.hidden)); summary.classList.toggle('open', !menu.hidden); });
      for (const option of options) {
        const label = document.createElement('label'); label.setAttribute('role', 'menuitemcheckbox');
        const input = document.createElement('input'); input.type = 'checkbox'; input.value = option.value; input.checked = selected.includes(option.value);
        input.setAttribute('aria-label', option.label);
        listen(input, 'change', () => { const current = state.filters[filter.id] as string[]; state.filters[filter.id] = options.filter(item => item.value === input.value ? input.checked : current.includes(item.value)).map(item => item.value); state.page = 1; updateTrigger(); render(); });
        label.append(input, document.createTextNode(option.label)); menu.append(label);
      }
      updateTrigger(); toggle.append(summary, menu); group.append(toggle); toolbar.append(group);
    } else {
      const label = document.createElement('label'); label.className = 'table-filter'; label.append(document.createTextNode(`${filter.label}: `));
      const select = document.createElement('select'); select.setAttribute('aria-label', filter.label);
      for (const option of filter.options ?? []) { const item = document.createElement('option'); item.value = option.value; item.textContent = option.label; select.append(item); }
      listen(select, 'change', () => { state.filters[filter.id] = select.value; state.page = 1; render(); }); label.append(select); toolbar.append(label);
    }
  }
  if (toolbar.childElementCount) shell.append(toolbar);
  const wrap = document.createElement('div'); wrap.className = 'table-wrap';
  const table = document.createElement('table'); const thead = document.createElement('thead'); const header = document.createElement('tr');
  for (const column of view.columns) {
    const th = document.createElement('th'); th.scope = 'col';
    if (column.sortable === false) th.textContent = column.label;
    else {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'table-sort'; button.textContent = column.label;
      button.setAttribute('aria-label', `Ordenar por ${column.label}`);
      button.addEventListener('click', () => { state.sort = { columnId: column.id, direction: state.sort.columnId === column.id && state.sort.direction === 'asc' ? 'desc' : 'asc' }; state.page = 1; render(); }); th.append(button);
    }
    header.append(th);
  }
  if (view.rowActions) { const th = document.createElement('th'); th.scope = 'col'; th.className = 'table-actions-heading'; th.setAttribute('aria-label', 'Acciones'); header.append(th); }
  thead.append(header); table.append(thead); const tbody = document.createElement('tbody');
  if (view.tbodyId) tbody.id = view.tbodyId;
  table.append(tbody); wrap.append(table); shell.append(wrap);
  const empty = document.createElement('p'); empty.className = 'table-empty'; empty.hidden = true; empty.textContent = view.emptyText ?? 'No hay registros.'; shell.append(empty);
  const pager = document.createElement('div'); pager.className = 'pagination table-pagination';
  const sizeLabel = document.createElement('label'); sizeLabel.className = 'pagination-size'; sizeLabel.append(document.createTextNode('Mostrar: '));
  const sizeSelect = document.createElement('select'); sizeSelect.className = 'pagination-select'; sizeSelect.setAttribute('aria-label', 'Registros por página');
  for (const size of [25, 50, 100, 200]) { const option = document.createElement('option'); option.value = String(size); option.textContent = String(size); sizeSelect.append(option); }
  sizeLabel.append(sizeSelect, document.createTextNode(' por página'));
  const prev = document.createElement('button'); prev.type = 'button'; prev.className = 'pagination-btn'; prev.textContent = 'Anterior';
  const info = document.createElement('span'); info.className = 'pagination-info'; info.setAttribute('aria-live', 'polite');
  const next = document.createElement('button'); next.type = 'button'; next.className = 'pagination-btn'; next.textContent = 'Siguiente';
  listen(sizeSelect, 'change', () => { state.pageSize = Number(sizeSelect.value); state.page = 1; render(); });
  listen(prev, 'click', () => { state.page -= 1; render(); }); listen(next, 'click', () => { state.page += 1; render(); });
  pager.append(sizeLabel, prev, info, next); shell.append(pager); root.replaceChildren(shell);
  function render(): void {
    const result = processTableRows(rows, view, state); state.page = result.page; tbody.replaceChildren();
    if (result.rows.length === 0) {
      const emptyTr = document.createElement('tr'); emptyTr.className = 'table-empty-row';
      const emptyTd = document.createElement('td');
      emptyTd.colSpan = view.columns.length + (view.rowActions ? 1 : 0);
      emptyTd.textContent = view.emptyText ?? 'No hay registros.';
      emptyTr.append(emptyTd);
      tbody.append(emptyTr);
    } else {
      for (const row of result.rows) {
        const tr = document.createElement('tr'); tr.dataset['rowId'] = view.getRowId(row);
        const rClass = view.rowClass?.(row); if (rClass) tr.className = rClass;
        for (const column of view.columns) {
          const td = document.createElement('td'); const value = column.getValue(row);
          const className = typeof column.cellClass === 'function' ? column.cellClass(row, value) : column.cellClass; if (className) td.className = className;
          const title = column.cellTitle?.(row, value); if (title) td.title = title;
          if (column.cellDataset) {
            const ds = column.cellDataset(row, value);
            for (const [k, v] of Object.entries(ds)) td.dataset[k] = v;
          }
          if (column.renderNode) {
            const node = column.renderNode(row, value);
            if (node) td.append(node);
            else td.textContent = '—';
          } else {
            const text = column.renderCell ? String(column.renderCell(row, value) ?? '—') : value === null || value === undefined || value === '' ? '—' : String(value);
            const href = column.cellHref?.(row, value);
            if (href) { const link = document.createElement('a'); link.href = href; link.textContent = text; td.append(link); }
            else td.textContent = text;
          }
          tr.append(td);
        }
        if (view.rowActions) {
          const td = document.createElement('td'); td.className = 'actions table-actions';
          const menu = document.createElement('div'); menu.className = 'row-menu';
          const button = document.createElement('button'); button.type = 'button'; button.className = 'row-menu-btn'; button.textContent = '···';
          button.setAttribute('aria-label', 'Acciones del registro'); button.setAttribute('aria-expanded', 'false');
          const dropdown = document.createElement('div'); dropdown.className = 'row-menu-dropdown'; dropdown.hidden = true;
          const actions = typeof view.rowActions.actions === 'function' ? view.rowActions.actions(row) : view.rowActions.actions;
          for (const action of actions) {
            const item = document.createElement('button'); item.type = 'button'; item.dataset['action'] = action.id; item.className = action.tone ? `${action.tone} row-menu-action` : 'row-menu-action';
            item.disabled = action.disabled?.(row) ?? false;
            if (action.icon) { const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.classList.add('icon'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#icon-${action.icon}`); icon.append(use); item.append(icon); }
            item.append(document.createTextNode(action.label));
            listen(item, 'click', () => { dropdown.hidden = true; button.setAttribute('aria-expanded', 'false'); action.onSelect(row, button); }); dropdown.append(item);
          }
          listen(button, 'click', event => { event.stopPropagation(); const opening = dropdown.hidden; for (const other of root.querySelectorAll<HTMLElement>('.row-menu-dropdown')) other.hidden = true; for (const other of root.querySelectorAll<HTMLButtonElement>('.row-menu-btn')) other.setAttribute('aria-expanded', 'false'); dropdown.hidden = !opening; button.setAttribute('aria-expanded', String(opening)); });
          menu.append(button, dropdown); td.append(menu); tr.append(td);
        }
        tbody.append(tr);
      }
    }
    for (const [index, column] of view.columns.entries()) {
      const th = header.children[index] as HTMLTableCellElement; const active = state.sort.columnId === column.id && column.sortable !== false;
      th.classList.toggle('table-sorted', active);
      if (column.sortable !== false) { th.setAttribute('aria-sort', active ? state.sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'); th.querySelector('button')!.dataset['direction'] = active ? state.sort.direction : 'none'; }
    }
    sizeSelect.value = String(result.pageSize); pager.hidden = result.total === 0; empty.hidden = result.total !== 0;
    info.textContent = result.total === 0 ? '' : `${(result.page - 1) * result.pageSize + 1}–${Math.min(result.page * result.pageSize, result.total)} de ${result.total}`;
    prev.disabled = result.page <= 1; next.disabled = result.page >= result.totalPages;
  }
  render();
  return { setRows(nextRows) { rows = [...nextRows]; state.page = 1; render(); }, destroy() { for (const remove of listeners) remove(); root.replaceChildren(); } };
}
