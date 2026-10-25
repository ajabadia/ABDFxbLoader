import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTableState, processTableRows, type TableState, type TableView } from '../src/ui/table';

interface Row { name: string; amount: number | null; date: string; active: boolean; group: string }
const rows: Row[] = [
  { name: 'Beta', amount: 5, date: '2024-02-01T00:00:00Z', active: true, group: 'yes' },
  { name: 'alfa', amount: 2, date: '2024-01-01T00:00:00Z', active: false, group: 'no' },
  { name: 'Gamma', amount: null, date: 'bad-date', active: true, group: 'yes' },
];
const view: TableView<Row> = {
  columns: [
    { id: 'name', label: 'Nombre', getValue: row => row.name, sortType: 'text' },
    { id: 'amount', label: 'Cantidad', getValue: row => row.amount, sortType: 'number' },
    { id: 'date', label: 'Fecha', getValue: row => row.date, sortType: 'date' },
    { id: 'active', label: 'Activo', getValue: row => row.active, sortType: 'boolean' },
    { id: 'group', label: 'Grupo', getValue: row => row.group, sortable: false },
  ],
  getRowId: row => row.name,
  initialSort: { columnId: 'name', direction: 'asc' },
  searchColumns: ['name'],
  filters: [{ id: 'group', label: 'Grupo', columnId: 'group', options: [
    { value: 'all', label: 'Todos', tone: 'neutral' },
    { value: 'yes', label: 'Sí', tone: 'positive', predicate: row => row.group === 'yes' },
    { value: 'no', label: 'No', tone: 'negative', predicate: row => row.group !== 'yes' },
  ] }],
};
const baseState: TableState = { sort: { columnId: 'name', direction: 'asc' }, query: '', filters: {}, page: 1, pageSize: 100 };

test('processTableRows sorts localized text both directions and preserves stable ties', () => {
  const result = processTableRows(rows, view, { ...baseState, sort: { columnId: 'name', direction: 'asc' } });
  assert.deepEqual(result.rows.map(row => row.name), ['alfa', 'Beta', 'Gamma']);
  assert.deepEqual(processTableRows(rows, view, { ...baseState, sort: { columnId: 'name', direction: 'desc' } }).rows.map(row => row.name), ['Gamma', 'Beta', 'alfa']);
});

test('processTableRows compares numbers and dates by type and keeps invalid values deterministic', () => {
  assert.deepEqual(processTableRows(rows, view, { ...baseState, sort: { columnId: 'amount', direction: 'asc' } }).rows.map(row => row.amount), [2, 5, null]);
  assert.deepEqual(processTableRows(rows, view, { ...baseState, sort: { columnId: 'date', direction: 'asc' } }).rows.map(row => row.name), ['alfa', 'Beta', 'Gamma']);
});

test('processTableRows ignores sorting for non-sortable columns and searches only declared fields', () => {
  assert.deepEqual(processTableRows(rows, view, { ...baseState, sort: { columnId: 'group', direction: 'desc' } }).rows.map(row => row.name), ['Beta', 'alfa', 'Gamma']);
  assert.equal(processTableRows(rows, view, { ...baseState, query: 'yes' }).total, 0);
  assert.equal(processTableRows(rows, { ...view, searchColumns: ['name', 'group'] }, { ...baseState, query: 'yes' }).total, 2);
});

test('processTableRows supports positive, negative and neutral filter options', () => {
  assert.deepEqual(processTableRows(rows, view, { ...baseState, filters: { group: 'yes' } }).rows.map(row => row.name), ['Beta', 'Gamma']);
  assert.deepEqual(processTableRows(rows, view, { ...baseState, filters: { group: 'no' } }).rows.map(row => row.name), ['alfa']);
  assert.equal(processTableRows(rows, view, { ...baseState, filters: { group: 'all' } }).total, 3);
});

test('multi-select filters default to all distinct values and support selecting several values', () => {
  const actions = [
    { action: 'install', timestamp: '2024-02-01T00:00:00Z' },
    { action: 'import-banks', timestamp: '2024-02-02T00:00:00Z' },
    { action: 'install', timestamp: '2024-02-03T00:00:00Z' },
    { action: 'remove', timestamp: '2024-02-04T00:00:00Z' },
  ];
  const actionView: TableView<(typeof actions)[number]> = {
    columns: [
      { id: 'action', label: 'Acción', getValue: row => row.action },
      { id: 'timestamp', label: 'Fecha', getValue: row => row.timestamp },
    ],
    getRowId: row => row.timestamp,
    initialSort: { columnId: 'timestamp', direction: 'desc' },
    filters: [
      { id: 'actions', label: 'Acción', columnId: 'action', type: 'multi-select' },
      { id: 'period', label: 'Fecha', columnId: 'timestamp', type: 'date-range' },
    ],
  };
  const state = createTableState(actionView, actions);
  assert.deepEqual(state.filters.actions, ['import-banks', 'install', 'remove']);
  assert.deepEqual(processTableRows(actions, actionView, state).rows, actions.slice().reverse());
  const selected = { ...state, filters: { ...state.filters, actions: ['install', 'remove'] } };
  assert.deepEqual(processTableRows(actions, actionView, selected).rows.map(row => row.action), ['remove', 'install', 'install']);
});

test('date-range filters include both selected calendar dates', () => {
  const actionView: TableView<Row> = {
    ...view,
    filters: [{ id: 'period', label: 'Fecha', columnId: 'date', type: 'date-range' }],
  };
  const state: TableState = {
    ...baseState,
    filters: { period: { from: '2024-01-01', to: '2024-01-01' } },
  };
  assert.deepEqual(processTableRows(rows, actionView, state).rows.map(row => row.name), ['alfa']);
});

test('processTableRows defaults to 100 rows and clamps the requested page after filtering', () => {
  const result = processTableRows(rows, { ...view, pageSize: undefined }, { ...baseState, page: 8 });
  assert.equal(result.pageSize, 100);
  assert.equal(result.page, 1);
  assert.equal(result.totalPages, 1);
});

test('processTableRows returns an empty page consistently when no row matches', () => {
  const result = processTableRows(rows, view, { ...baseState, query: 'missing' });
  assert.deepEqual(result.rows, []);
  assert.equal(result.total, 0);
  assert.equal(result.totalPages, 0);
  assert.equal(result.page, 1);
});
