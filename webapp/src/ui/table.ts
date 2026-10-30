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

/**
 * Chip de tres estados (positivo → negativo → «todos») con su menú
 * `role="menuitemradio"`: el sistema de tablas lo pinta, lo abre y lo cierra
 * con la misma ARIA que tenía el marcado estático del catálogo
 * (`#filter-<id>`, `#filter-<id>-menu`, `data-tone`, `aria-pressed`). La
 * opción con `tone: 'neutral'` es la que arranca elegida y la que no filtra.
 */
export interface TableChipFilter<T> {
  /** Eje del filtro: compone el id del chip y de su menú. */
  id: string;
  /** Nombre accesible del menú y prefijo del tooltip del chip. */
  label: string;
  columnId: string;
  type: 'chip';
  /** Icono del sprite (`icon-*`) a la izquierda de la etiqueta. */
  icon?: string;
  options: readonly TableFilterOption<T>[];
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

export type TableFilterDefinition<T> = TableFilter<T> | TableMultiSelectFilter<T> | TableDateRangeFilter | TableChipFilter<T>;
export type TableFilterValue = string | string[] | { from: string; to: string };

export interface TableView<T> {
  columns: readonly TableColumn<T>[];
  getRowId: (row: T) => string;
  emptyText?: string;
  initialSort: { columnId: string; direction: TableDirection };
  pageSize?: number;
  searchColumns?: readonly string[];
  /** Búsqueda propia: texto por fila que sustituye a la de las columnas (p. ej. campos que no son columna). */
  searchText?: (row: T) => string;
  /** Id del input de búsqueda, si la vista lo necesita con nombre propio. */
  searchId?: string;
  filters?: readonly TableFilterDefinition<T>[];
  rowActions?: TableRowActions<T>;
  rowClass?: (row: T) => string | undefined;
  tbodyId?: string;
  /** Aviso de que el usuario quiere cambiar el orden (para tablas que resuelven el orden en el servidor y recargan). */
  onSortChange?: (sort: { columnId: string; direction: TableDirection }) => void;
  /** Aviso de que cambió el texto de búsqueda (para tablas que resuelven la búsqueda en el servidor y recargan). */
  onSearchChange?: (query: string) => void;
  /** Se llama tras cada render con el resultado procesado (recuentos de la vista). */
  onProcessed?: (info: TableProcessInfo<T>) => void;
}

/** Resultado de procesar las filas: lo que la vista puede necesitar pintar fuera de la tabla. */
export interface TableProcessInfo<T> {
  rows: readonly T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  query: string;
  filters: Record<string, TableFilterValue>;
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
      if (filter.type === 'chip') {
        // El estado «todos» (el neutro) es el que arranca elegido.
        const neutral = filter.options.find(option => option.tone === 'neutral') ?? filter.options[0];
        return [filter.id, neutral?.value ?? ''];
      }
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
    if (view.searchText) return view.searchText(row).toLocaleLowerCase().includes(query);
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

export interface TableController<T> {
  /** Reemplaza las filas; `keepPage` conserva la página vigente (recortando si hace falta). */
  setRows(rows: readonly T[], options?: { keepPage?: boolean }): void;
  destroy(): void;
  /** El `<tbody>` que pinta la tabla: permite parchear una fila sin re-render. */
  readonly tbody: HTMLTableSectionElement;
}

/** Tablas montadas, para cerrar sus menús de fila desde cualquier sitio. */
const mountedTables = new Set<{ closeRowMenus(): void }>();

/** Cierra los menús «···» abiertos en cualquier tabla montada. */
export function closeAllRowMenus(): void {
  for (const table of mountedTables) table.closeRowMenus();
}

export function mountTable<T>(root: HTMLElement, view: TableView<T>, initialRows: readonly T[]): TableController<T> {
  let rows = [...initialRows]; const state = createTableState(view, rows);
  const listeners: Array<() => void> = [];
  /** Menús «···» vivos de la página actual; se repueblan en cada render. */
  let rowMenus: Array<{ dropdown: HTMLElement; button: HTMLButtonElement }> = [];
  const closeRowMenus = (): void => {
    for (const entry of rowMenus) {
      entry.dropdown.hidden = true;
      entry.dropdown.classList.remove('drop-up');
      entry.button.setAttribute('aria-expanded', 'false');
    }
  };
  const listen = (element: Element, type: string, listener: EventListener): void => {
    element.addEventListener(type, listener); listeners.push(() => element.removeEventListener(type, listener));
  };
  const shell = document.createElement('div'); shell.className = 'table-view';
  shell.setAttribute('data-table-empty-text', view.emptyText ?? 'No hay registros.');
  const toolbar = document.createElement('div'); toolbar.className = 'table-toolbar';
  let search: HTMLInputElement | null = null;
  if (
    view.searchText !== undefined ||
    (view.searchColumns ?? view.columns.filter(column => column.searchable !== false).map(column => column.id)).length
  ) {
    search = document.createElement('input'); search.type = 'search'; search.className = 'table-search';
    if (view.searchId) search.id = view.searchId;
    search.setAttribute('aria-label', 'Buscar en la tabla'); search.placeholder = 'Buscar…';
    listen(search, 'input', () => { state.query = search!.value; state.page = 1; view.onSearchChange?.(state.query); render(); }); toolbar.append(search);
  }
  /** Chips de tres estados: se agrupan en su barra y se repintan en cada render. */
  const chipPaints: Array<() => void> = [];
  const openChips: Array<{ close: (focusTrigger: boolean) => void }> = [];
  let chipGroup: HTMLElement | null = null;
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
    } else if (filter.type === 'chip') {
      if (chipGroup === null) {
        chipGroup = document.createElement('div');
        chipGroup.className = 'filter-chips';
        chipGroup.setAttribute('role', 'group');
        chipGroup.setAttribute('aria-label', 'Filtros de la tabla');
        toolbar.append(chipGroup);
      }
      chipGroup.append(buildChip(filter));
    } else {
      const label = document.createElement('label'); label.className = 'table-filter'; label.append(document.createTextNode(`${filter.label}: `));
      const select = document.createElement('select'); select.setAttribute('aria-label', filter.label);
      for (const option of filter.options ?? []) { const item = document.createElement('option'); item.value = option.value; item.textContent = option.label; select.append(item); }
      listen(select, 'change', () => { state.filters[filter.id] = select.value; state.page = 1; render(); }); label.append(select); toolbar.append(label);
    }
  }
  if (toolbar.childElementCount) shell.append(toolbar);
  // Un clic fuera de la tabla cierra los chips abiertos y los menús «···»,
  // como hacía el marcado estático del catálogo: no se quedan huérfanos.
  const onDocumentClick = (event: Event): void => {
    const target = event.target as Node | null;
    const inside = target !== null && shell.contains(target);
    if (!inside) for (const chip of openChips) chip.close(false);
    if (!inside || !insideRowMenu(target)) closeRowMenus();
  };
  // El stub de `document` de los tests unitarios no tiene listeners; sin
  // guardia la tabla ni siquiera se monta fuera del navegador.
  const canListen = typeof document.addEventListener === 'function';
  if (canListen) document.addEventListener('click', onDocumentClick);

  /** Sube por los ancestros viendo si el clic cayó dentro del menú de una fila. */
  function insideRowMenu(target: Node | null): boolean {
    let node = target as HTMLElement | null;
    while (node !== null && node !== shell) {
      if (node.classList?.contains('row-menu') === true) return true;
      node = node.parentElement;
    }
    return false;
  }
  const wrap = document.createElement('div'); wrap.className = 'table-wrap';
  const table = document.createElement('table'); const thead = document.createElement('thead'); const header = document.createElement('tr');
  for (const column of view.columns) {
    const th = document.createElement('th'); th.scope = 'col';
    if (column.sortable === false) th.textContent = column.label;
    else {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'table-sort'; button.textContent = column.label;
      button.setAttribute('aria-label', `Ordenar por ${column.label}`);
      button.addEventListener('click', () => { state.sort = { columnId: column.id, direction: state.sort.columnId === column.id && state.sort.direction === 'asc' ? 'desc' : 'asc' }; state.page = 1; view.onSortChange?.({ ...state.sort }); render(); }); th.append(button);
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
  /**
   * Chip de tres estados: abre un menú `role="menu"` con `menuitemradio`,
   * anuncia si filtra (`aria-pressed`) y si está abierto (`aria-expanded`), y
   * devuelve el foco al chip al elegir o con Escape.
   */
  function buildChip(filter: TableChipFilter<T>): HTMLElement {
    const group = document.createElement('div'); group.className = 'filter-menu';
    const trigger = document.createElement('button');
    trigger.type = 'button'; trigger.className = 'filter-btn';
    trigger.id = `filter-${filter.id}`;
    trigger.dataset['axis'] = filter.id;
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `filter-${filter.id}-menu`);
    trigger.setAttribute('aria-pressed', 'false');
    if (filter.icon) {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.classList.add('icon'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#icon-${filter.icon}`);
      icon.append(use); trigger.append(icon);
    }
    const text = document.createElement('span'); text.className = 'filter-btn-text'; trigger.append(text);
    const menu = document.createElement('div');
    menu.className = 'filter-menu-list'; menu.id = `filter-${filter.id}-menu`; menu.hidden = true;
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', filter.label);

    const items: HTMLButtonElement[] = [];
    for (const option of filter.options) {
      const item = document.createElement('button');
      item.type = 'button'; item.setAttribute('role', 'menuitemradio');
      item.dataset['axis'] = filter.id; item.dataset['value'] = option.value; item.dataset['tone'] = option.tone;
      item.textContent = option.label;
      listen(item, 'click', () => {
        state.filters[filter.id] = option.value;
        state.page = 1;
        closeChip(true);
        render();
      });
      menu.append(item); items.push(item);
    }

    const neutral = filter.options.find(option => option.tone === 'neutral')?.value ?? filter.options[0]?.value ?? '';

    function paintChip(): void {
      const value = String(state.filters[filter.id] ?? neutral);
      const option = filter.options.find(entry => entry.value === value) ?? filter.options[0];
      if (option === undefined) return;
      const filtering = option.value !== neutral;
      trigger.dataset['tone'] = option.tone;
      trigger.classList.toggle('active', filtering);
      trigger.setAttribute('aria-pressed', String(filtering));
      trigger.title = `${filter.label}: ${option.label.toLowerCase()}. Abrir las opciones`;
      text.textContent = option.label;
      for (const item of items) {
        const checked = item.dataset['value'] === option.value;
        item.classList.toggle('selected', checked);
        item.setAttribute('aria-checked', String(checked));
      }
    }

    function closeChip(focusTrigger: boolean): void {
      menu.hidden = true;
      trigger.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      if (focusTrigger) trigger.focus({ preventScroll: true });
    }

    function openChip(): void {
      for (const other of openChips) other.close(false);
      menu.hidden = false;
      trigger.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      // El foco entra en la opción vigente: Intro la deja tal cual y las
      // flechas recorren las otras dos.
      (items.find(item => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus({ preventScroll: true });
    }

    function moveFocus(step: number): void {
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(current + step + items.length) % items.length]?.focus();
    }

    listen(trigger, 'click', () => { if (menu.hidden) openChip(); else closeChip(true); });
    listen(menu, 'keydown', (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === 'ArrowDown') { event.preventDefault(); moveFocus(1); }
      else if (key === 'ArrowUp') { event.preventDefault(); moveFocus(-1); }
      else if (key === 'Home') { event.preventDefault(); items[0]?.focus(); }
      else if (key === 'End') { event.preventDefault(); items[items.length - 1]?.focus(); }
      else if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeChip(true); }
      // Tab sale del menú y lo cierra: el chip recupera su estado cerrado.
      else if (key === 'Tab') { closeChip(false); }
    });

    chipPaints.push(paintChip);
    openChips.push({ close: closeChip });
    paintChip();
    group.append(trigger, menu);
    return group;
  }

  function render(): void {
    const result = processTableRows(rows, view, state); state.page = result.page; tbody.replaceChildren(); rowMenus = [];
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
          button.dataset['action'] = 'menu';
          button.title = 'Acciones del registro';
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
          listen(button, 'click', event => { event.stopPropagation(); const opening = dropdown.hidden; closeRowMenus(); dropdown.hidden = !opening; button.setAttribute('aria-expanded', String(opening)); });
          rowMenus.push({ dropdown, button });
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
    for (const paintChip of chipPaints) paintChip();
    view.onProcessed?.({
      rows: result.rows,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
      query: state.query,
      filters: { ...state.filters },
    });
  }
  render();
  const registry = { closeRowMenus };
  mountedTables.add(registry);
  return {
    setRows(nextRows, options) { rows = [...nextRows]; if (options?.keepPage !== true) state.page = 1; render(); },
    destroy() {
      for (const remove of listeners) remove();
      if (canListen) document.removeEventListener('click', onDocumentClick);
      mountedTables.delete(registry);
      root.replaceChildren();
    },
    tbody,
  };
}
