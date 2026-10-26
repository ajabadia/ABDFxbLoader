/**
 * UI web de fxbLoader.
 *
 * Todo pasa por el cliente tipado de `src/client` (derivado de `openapi.json`),
 * así que un cambio de DTO rompe la compilación aquí. Este archivo solo maneja
 * el DOM y el estado de la vista: el lote de instalación/desinstalación lo
 * ejecuta el servidor (`POST /library/batch/stream`) y la vista pinta el
 * progreso que le llega (`start`, `plugin`, `step`, `end`) y el resultado final.
 */
import type {
  AssociationAuditSnapshotResponse,
  LibraryBanksImportResponse,
  LibraryBanksListResponse,
  LibraryCreateCustomPluginResponse,
  LibraryInspectDllResponse,
  LibraryInspectPackageResponse,
  LibraryImportPackageResponse,
  LibraryScanResponse,
  PluginLogSnapshotResponse,
  PluginMetaSnapshotResponse,
  RequestBody,
  WizardListResponse,
  WizardMatchResponse,
} from '../../client/fxb-client.js';
import { appendPaths, parentDir } from '../picker.js';
// Cada módulo de la vista se importa con su extensión `.js` y desde su propio
// archivo: el navegador resuelve el grafo tal cual, sin bundler. El barril
// `src/client/index.ts` es para Node (tests y scripts); si la página lo
// importara, el navegador se quedaría con sus reexportaciones sin extensión.
import {
  BatchClock,
  cancelledSummary,
  failuresOf,
  progressLabel,
  resumablePlugins,
  resumeLabel,
  retryProgress,
  runBatchInChunks,
  stepLabel,
  summarize,
  timingLabel,
  type BatchAction,
  type BatchFailure,
  type BatchPlugin,
  type BatchProgress,
} from '../batch.js';
import {
  importProgressLabel,
  runImportInChunks,
  type BankImportProgress,
} from '../bank-import.js';
import {
  existingRecents,
  parseRecents,
  pathKey,
  rememberRecent,
  rememberRecentPaths,
} from '../recents.js';
import type {
  BankImportStreamEvent,
  BankImportStreamResult,
} from '../../client/bank-import-stream.js';
import type { BatchStreamEvent, BatchStreamResult } from '../../client/batch-stream.js';
import { client, describeError, isFxbApiError } from './api.js';
import { byId, cell, cloneRow, query } from './dom.js';
import { mountTable, closeAllRowMenus, type TableController, type TableView } from '../table.js';

const STORAGE_ROOT = 'fxbLoader.libraryRoot';
const STORAGE_DLL = 'fxbLoader.dllSource';
const STORAGE_RECENT_ROOTS = 'fxbLoader.recentLibraryRoots';
const STORAGE_RECENT_DLLS = 'fxbLoader.recentDlls';
const STORAGE_RECENT_BANKS = 'fxbLoader.recentBanks';

type ScanPlugin = LibraryScanResponse['plugins'][number];
type ImportResults = LibraryBanksImportResponse['results'];
type ConfigSnapshot = LibraryBanksListResponse['config'];
type ExportOrder = RequestBody<'/library/banks/export', 'post'>['endianness'];

function fourCcFromId(id: string | number | undefined): string {
  if (id === undefined || id === '') return '—';
  const num = typeof id === 'number' ? id : Number.parseInt(String(id), 10);
  if (Number.isNaN(num) || num <= 0) return String(id);
  const chars = [
    String.fromCharCode((num >> 24) & 0xff),
    String.fromCharCode((num >> 16) & 0xff),
    String.fromCharCode((num >> 8) & 0xff),
    String.fromCharCode(num & 0xff),
  ].map((c) => (/[\x20-\x7e]/.test(c) ? c : '.'));
  return chars.join('');
}

const els = {
  themeToggle: byId<HTMLButtonElement>('theme-toggle'),
  form: byId<HTMLFormElement>('scan-form'),
  root: byId<HTMLInputElement>('library-root'),
  rootRecents: byId<HTMLDataListElement>('library-root-recents'),
  rootWarning: byId<HTMLParagraphElement>('root-warning'),
  rootBrowse: byId<HTMLButtonElement>('root-browse'),
  dll: byId<HTMLInputElement>('dll-source'),
  dllRecents: byId<HTMLDataListElement>('dll-source-recents'),
  dllBrowse: byId<HTMLButtonElement>('dll-browse'),
  recentsClear: byId<HTMLButtonElement>('recents-clear'),
  scanButton: byId<HTMLButtonElement>('scan-button'),
  status: byId<HTMLParagraphElement>('status'),
  results: byId<HTMLElement>('results'),
  summary: byId<HTMLSpanElement>('summary-text'),
  plugsPath: byId<HTMLElement>('plugs-path'),
  loaderStatus: byId<HTMLParagraphElement>('loader-status'),
  pluginsTable: byId<HTMLElement>('plugins-table'),
  filterCount: byId<HTMLElement>('filter-count'),
  installAll: byId<HTMLButtonElement>('install-all'),
  uninstallAll: byId<HTMLButtonElement>('uninstall-all'),
  batchCancel: byId<HTMLButtonElement>('batch-cancel'),
  batchResume: byId<HTMLButtonElement>('batch-resume'),
  retryAll: byId<HTMLButtonElement>('retry-all'),
  batchStatus: byId<HTMLParagraphElement>('batch-status'),
  batchProgress: byId<HTMLProgressElement>('batch-progress'),
  batchStep: byId<HTMLElement>('batch-step'),
  batchClock: byId<HTMLParagraphElement>('batch-clock'),
  batchErrors: byId<HTMLDetailsElement>('batch-errors'),
  batchErrorsLabel: byId<HTMLElement>('batch-errors-label'),
  batchErrorList: byId<HTMLUListElement>('batch-error-list'),
  banks: byId<HTMLElement>('banks'),
  banksTitle: byId<HTMLElement>('banks-plugin'),
  banksClose: byId<HTMLButtonElement>('banks-close'),
  banksPresets: byId<HTMLElement>('banks-presets'),
  banksExists: byId<HTMLElement>('banks-exists'),
  banksStatus: byId<HTMLParagraphElement>('banks-status'),
  banksTable: byId<HTMLElement>('banks-table'),
  defaultBank: byId<HTMLSelectElement>('default-bank'),
  loadFxb: byId<HTMLInputElement>('load-fxb'),
  defaultSave: byId<HTMLButtonElement>('default-save'),
  defaultConvert: byId<HTMLButtonElement>('default-convert'),
  defaultRestore: byId<HTMLButtonElement>('default-restore'),
  defaultDiscard: byId<HTMLButtonElement>('default-discard'),
  importPaths: byId<HTMLTextAreaElement>('import-paths'),
  recentBanks: byId<HTMLElement>('recent-banks'),
  importBrowse: byId<HTMLButtonElement>('import-browse'),
  importOverwrite: byId<HTMLInputElement>('import-overwrite'),
  importButton: byId<HTMLButtonElement>('import-button'),
  importCancel: byId<HTMLButtonElement>('import-cancel'),
  importProgress: byId<HTMLProgressElement>('import-progress'),
  importResults: byId<HTMLUListElement>('import-results'),
  exportBank: byId<HTMLSelectElement>('export-bank'),
  exportOrder: byId<HTMLSelectElement>('export-order'),
  exportOverwrite: byId<HTMLInputElement>('export-overwrite'),
  exportButton: byId<HTMLButtonElement>('export-button'),
  createMode: byId<HTMLSelectElement>('create-mode'),
  createBankName: byId<HTMLInputElement>('create-bank-name'),
  createOrder: byId<HTMLSelectElement>('create-order'),
  createProgramRows: byId<HTMLElement>('create-program-rows'),
  createProgramNames: byId<HTMLTextAreaElement>('create-program-names'),
  createFxVersion: byId<HTMLInputElement>('create-fx-version'),
  createNumParams: byId<HTMLInputElement>('create-num-params'),
  createChunkRows: byId<HTMLElement>('create-chunk-rows'),
  createChunkHex: byId<HTMLTextAreaElement>('create-chunk-hex'),
  createChunkVersion: byId<HTMLSelectElement>('create-chunk-version'),
  createCurrentProgram: byId<HTMLInputElement>('create-current-program'),
  createChunkPrograms: byId<HTMLInputElement>('create-chunk-programs'),
  createOverwrite: byId<HTMLInputElement>('create-overwrite'),
  createBankButton: byId<HTMLButtonElement>('create-bank-button'),
  drawerBackdrop: byId<HTMLElement>('drawer-backdrop'),
  meta: byId<HTMLElement>('meta'),
  metaPlugin: byId<HTMLElement>('meta-plugin'),
  metaClose: byId<HTMLButtonElement>('meta-close'),
  metaPath: byId<HTMLElement>('meta-path'),
  metaExists: byId<HTMLElement>('meta-exists'),
  metaOrigin: byId<HTMLElement>('meta-origin'),
  metaId: byId<HTMLInputElement>('meta-id'),
  metaName: byId<HTMLInputElement>('meta-name'),
  metaVendor: byId<HTMLInputElement>('meta-vendor'),
  metaVendorUrl: byId<HTMLInputElement>('meta-vendor-url'),
  metaGenre: byId<HTMLInputElement>('meta-genre'),
  metaAbbreviation: byId<HTMLInputElement>('meta-abbreviation'),
  metaCreated: byId<HTMLInputElement>('meta-created'),
  metaNotes: byId<HTMLTextAreaElement>('meta-notes'),
  metaExtended: byId<HTMLTextAreaElement>('meta-extended'),
  metaSave: byId<HTMLButtonElement>('meta-save'),
  metaReload: byId<HTMLButtonElement>('meta-reload'),
  metaStatus: byId<HTMLParagraphElement>('meta-status'),
  metaDll: byId<HTMLInputElement>('meta-dll'),
  metaDllNote: byId<HTMLElement>('meta-dll-note'),
  metaDllSave: byId<HTMLButtonElement>('meta-dll-save'),
  metaDllCancel: byId<HTMLButtonElement>('meta-dll-cancel'),
  metaDllActions: byId<HTMLElement>('meta-dll-actions'),
  dialogDllDraft: byId<HTMLDialogElement>('dialog-dll-draft'),
  dialogDllDraftText: byId<HTMLElement>('dialog-dll-draft-text'),
  dialogDllDraftContinue: byId<HTMLButtonElement>('dialog-dll-draft-continue'),
  dialogDllDraftCancel: byId<HTMLButtonElement>('dialog-dll-draft-cancel'),
  metaWizardBanner: byId<HTMLElement>('meta-wizard-banner'),
  metaWizardTitle: byId<HTMLElement>('meta-wizard-title'),
  metaWizardApply: byId<HTMLButtonElement>('meta-wizard-apply'),
  pluginWizard: byId<HTMLElement>('plugin-wizard'),
  pluginWizardPlugin: byId<HTMLElement>('plugin-wizard-plugin'),
  pluginWizardClose: byId<HTMLButtonElement>('plugin-wizard-close'),
  pluginWizardEmpty: byId<HTMLElement>('plugin-wizard-empty'),
  pluginWizardContent: byId<HTMLElement>('plugin-wizard-content'),
  pluginWizardName: byId<HTMLElement>('plugin-wizard-name'),
  pluginWizardSource: byId<HTMLElement>('plugin-wizard-source'),
  pluginWizardVendor: byId<HTMLElement>('plugin-wizard-vendor'),
  pluginWizardGenre: byId<HTMLElement>('plugin-wizard-genre'),
  pluginWizardId: byId<HTMLElement>('plugin-wizard-id'),
  pluginWizardDll: byId<HTMLElement>('plugin-wizard-dll'),
  pluginWizardDimensions: byId<HTMLElement>('plugin-wizard-dimensions'),
  pluginWizardParams: byId<HTMLElement>('plugin-wizard-params'),
  pluginWizardFlags: byId<HTMLElement>('plugin-wizard-flags'),
  pluginWizardFilesWrap: byId<HTMLElement>('plugin-wizard-files-wrap'),
  pluginWizardFiles: byId<HTMLElement>('plugin-wizard-files'),
  pluginWizardRegistryWrap: byId<HTMLElement>('plugin-wizard-registry-wrap'),
  pluginWizardRegistry: byId<HTMLElement>('plugin-wizard-registry'),
  pluginWizardNotesWrap: byId<HTMLElement>('plugin-wizard-notes-wrap'),
  pluginWizardNotes: byId<HTMLElement>('plugin-wizard-notes'),
  pluginWizardReadmeWrap: byId<HTMLElement>('plugin-wizard-readme-wrap'),
  pluginWizardReadme: byId<HTMLElement>('plugin-wizard-readme'),
  pluginWizardVfxinfoBtn: byId<HTMLButtonElement>('plugin-wizard-vfxinfo-btn'),
  pluginWizardVfxinfoLabel: byId<HTMLElement>('plugin-wizard-vfxinfo-label'),
  pluginWizardApplyBtn: byId<HTMLButtonElement>('plugin-wizard-apply-btn'),
  pluginWizardInstallBtn: byId<HTMLButtonElement>('plugin-wizard-install-btn'),
  pluginWizardStatus: byId<HTMLParagraphElement>('plugin-wizard-status'),
  logDrawer: byId<HTMLElement>('log-drawer'),
  logPlugin: byId<HTMLElement>('log-plugin'),
  logClose: byId<HTMLButtonElement>('log-close'),
  logPath: byId<HTMLElement>('log-path'),
  logExists: byId<HTMLElement>('log-exists'),
  logSummary: byId<HTMLElement>('log-summary'),
  logTable: byId<HTMLElement>('log-table'),
  logDetail: byId<HTMLElement>('log-record-detail'),
  logDetailTitle: byId<HTMLElement>('log-record-detail-title'),
  logDetailFields: byId<HTMLElement>('log-record-detail-fields'),
  logDetailClose: byId<HTMLButtonElement>('log-record-detail-close'),
  logRotated: byId<HTMLElement>('log-rotated'),
  logStatus: byId<HTMLParagraphElement>('log-status'),
  wizardsNavBtn: byId<HTMLButtonElement>('wizards-nav-btn'),
  wizards: byId<HTMLElement>('wizards'),
  wizardsClose: byId<HTMLButtonElement>('wizards-close'),
  wizardsFilter: byId<HTMLInputElement>('wizards-filter'),
  wizardsCount: byId<HTMLElement>('wizards-count'),
  wizardsTable: byId<HTMLDivElement>('wizards-table'),
  wizardsStatus: byId<HTMLParagraphElement>('wizards-status'),
  importPkgNavBtn: byId<HTMLButtonElement>('import-pkg-nav-btn'),
  importPackageDrawer: byId<HTMLElement>('import-package-drawer'),
  importPackageClose: byId<HTMLButtonElement>('import-package-close'),
  importPackagePath: byId<HTMLInputElement>('import-package-path'),
  importPackageBrowse: byId<HTMLButtonElement>('import-package-browse'),
  importPackageInspectBtn: byId<HTMLButtonElement>('import-package-inspect-btn'),
  importPackagePreview: byId<HTMLElement>('import-package-preview'),
  importPackageKind: byId<HTMLElement>('import-package-kind'),
  importPackageSource: byId<HTMLElement>('import-package-source'),
  importPackagePluginsWrap: byId<HTMLElement>('import-package-plugins-wrap'),
  importPackageAllPlugs: byId<HTMLInputElement>('import-package-all-plugs'),
  importPackagePluginsTable: byId<HTMLElement>('import-package-plugins-table'),
  importPackageBanksWrap: byId<HTMLElement>('import-package-banks-wrap'),
  importPackageAllBanks: byId<HTMLInputElement>('import-package-all-banks'),
  importPackageBanksTable: byId<HTMLElement>('import-package-banks-table'),
  importPackagePolicy: byId<HTMLSelectElement>('import-package-policy'),
  importPackageRepair: byId<HTMLInputElement>('import-package-repair'),
  importPackageExecuteBtn: byId<HTMLButtonElement>('import-package-execute-btn'),
  importPackageStatus: byId<HTMLParagraphElement>('import-package-status'),
  auditNavBtn: byId<HTMLButtonElement>('audit-nav-btn'),
  auditDrawer: byId<HTMLElement>('audit-drawer'),
  auditClose: byId<HTMLButtonElement>('audit-close'),
  auditRefresh: byId<HTMLButtonElement>('audit-refresh'),
  auditPluginFilter: byId<HTMLInputElement>('audit-plugin-filter'),
  auditPath: byId<HTMLElement>('audit-path'),
  auditSummary: byId<HTMLElement>('audit-summary'),
  auditTable: byId<HTMLElement>('audit-table'),
  auditStatus: byId<HTMLParagraphElement>('audit-status'),
  customPluginNavBtn: byId<HTMLButtonElement>('custom-plugin-nav-btn'),
  customPluginDrawer: byId<HTMLElement>('custom-plugin-drawer'),
  customPluginClose: byId<HTMLButtonElement>('custom-plugin-close'),
  customPluginPath: byId<HTMLInputElement>('custom-plugin-path'),
  customPluginBrowse: byId<HTMLButtonElement>('custom-plugin-browse'),
  customPluginInspectBtn: byId<HTMLButtonElement>('custom-plugin-inspect-btn'),
  customPluginResult: byId<HTMLElement>('custom-plugin-result'),
  customPluginValidPe: byId<HTMLElement>('custom-plugin-valid-pe'),
  customPluginBitness: byId<HTMLElement>('custom-plugin-bitness'),
  customPluginVst: byId<HTMLElement>('custom-plugin-vst'),
  customPluginSuggestion: byId<HTMLElement>('custom-plugin-suggestion'),
  customPluginWizard: byId<HTMLElement>('custom-plugin-wizard'),
  customPluginExports: byId<HTMLElement>('custom-plugin-exports'),
  customPluginIssues: byId<HTMLElement>('custom-plugin-issues'),
  customPluginBitnessWarning: byId<HTMLElement>('custom-plugin-bitness-warning'),
  customPluginRoot: byId<HTMLInputElement>('custom-plugin-root'),
  customPluginFolder: byId<HTMLInputElement>('custom-plugin-folder'),
  customPluginName: byId<HTMLInputElement>('custom-plugin-name'),
  customPluginId: byId<HTMLInputElement>('custom-plugin-id'),
  customPluginVendor: byId<HTMLInputElement>('custom-plugin-vendor'),
  customPluginGenre: byId<HTMLInputElement>('custom-plugin-genre'),
  customPluginParams: byId<HTMLInputElement>('custom-plugin-params'),
  customPluginPrograms: byId<HTMLInputElement>('custom-plugin-programs'),
  customPluginSynth: byId<HTMLInputElement>('custom-plugin-synth'),
  customPluginEditor: byId<HTMLInputElement>('custom-plugin-editor'),
  customPluginEditorRow: byId<HTMLElement>('custom-plugin-editor-row'),
  customPluginWidth: byId<HTMLInputElement>('custom-plugin-width'),
  customPluginHeight: byId<HTMLInputElement>('custom-plugin-height'),
  customPluginSaveWizard: byId<HTMLInputElement>('custom-plugin-save-wizard'),
  customPluginOverwrite: byId<HTMLInputElement>('custom-plugin-overwrite'),
  customPluginCreateBtn: byId<HTMLButtonElement>('custom-plugin-create-btn'),
  customPluginCreated: byId<HTMLElement>('custom-plugin-created'),
  customPluginCreatedPaths: byId<HTMLElement>('custom-plugin-created-paths'),
  customPluginCreatedWarnings: byId<HTMLElement>('custom-plugin-created-warnings'),
  customPluginStatus: byId<HTMLParagraphElement>('custom-plugin-status'),
};

interface BanksState {
  pluginName: string;
  data: LibraryBanksListResponse;
}

/** Panel de catálogo abierto y el `mtimeMs` con el que se puede escribir. */
interface MetaState {
  pluginName: string;
  dir: string;
  plugin: ScanPlugin;
  snapshot: PluginMetaSnapshotResponse;
}

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    // localStorage puede estar bloqueado; la UI sigue funcionando.
    return '';
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* localStorage puede estar bloqueado; la UI sigue funcionando. */
  }
}

function readRecentList(key: string): string[] {
  return parseRecents(readStorage(key));
}

function writeRecentList(key: string, values: readonly string[]): void {
  writeStorage(key, values.length === 0 ? '' : JSON.stringify(values));
}

let libraryRoot = readStorage(STORAGE_ROOT);
const lastDll = readStorage(STORAGE_DLL);
let recentRoots = readRecentList(STORAGE_RECENT_ROOTS);
let recentDlls = readRecentList(STORAGE_RECENT_DLLS);
let recentBanks = readRecentList(STORAGE_RECENT_BANKS);
// Migración: las versiones anteriores solo guardaban el último valor. Si aún
// no hay historial, ese valor pasa a ser la primera sugerencia.
if (recentRoots.length === 0 && libraryRoot !== '') {
  recentRoots = [libraryRoot];
  writeRecentList(STORAGE_RECENT_ROOTS, recentRoots);
}
if (recentDlls.length === 0 && lastDll !== '') {
  recentDlls = [lastDll];
  writeRecentList(STORAGE_RECENT_DLLS, recentDlls);
}
let busy = false;
let banksBusy = false;
/** Último resultado de `/library/scan`, o `null` si aún no hay lista. */
let scanData: LibraryScanResponse | null = null;
/** Fallos del último lote, con su reintento individual. */
let batchFailures: BatchFailure[] = [];
/**
 * Plugins del último lote que quedaron sin confirmar (cancelado o cortado),
 * con la acción que había que aplicarles. Alimenta el botón «Reanudar».
 */
let batchPending: { action: BatchAction; plugins: string[] } | null = null;
/** Corta el lote en curso; `null` cuando no hay ninguno. */
let batchController: AbortController | null = null;
/** Corta la importación de bancos en curso; `null` cuando no hay ninguna. */
let importController: AbortController | null = null;
/** Reloj del lote en curso, o `null` si no hay ninguno. */
let batchClock: BatchClock | null = null;
/** Último progreso pintado: el reloj lo necesita para estimar entre eventos. */
let batchProgress: BatchProgress | null = null;
/** Refresco periódico del reloj para que los segundos corran sin eventos. */
let batchTicker: ReturnType<typeof setInterval> | null = null;
/** Panel de bancos abierto, o `null`. */
let banks: BanksState | null = null;
let banksTableController: TableController<LibraryBanksListResponse['banks'][number]> | null = null;
let metaState: MetaState | null = null;
let logTableController: TableController<PluginLogSnapshotResponse['entries'][number]> | null = null;
let logDetailOpener: HTMLButtonElement | null = null;
let metaBusy = false;
let wizardsTableController: TableController<WizardListResponse['items'][number]> | null = null;

/** Orden actual del repositorio de wizards: el servidor ordena, la tabla lo replica. */
let wizardsSort: { columnId: string; direction: 'asc' | 'desc' } = { columnId: 'name', direction: 'asc' };
/** Última búsqueda enviada al servidor; el reordenar sobre ella lanza una recarga. */
let wizardsQuery = '';

els.root.value = libraryRoot;
els.dll.value = lastDll;
renderRecents();
setRootWarning(libraryRoot === '');

function setStatus(message: string, kind = 'info'): void {
  els.status.textContent = message;
  els.status.className = `status ${kind}`;
}

/**
 * La explicación de qué necesita la carpeta solo se enseña cuando hace falta:
 * el campo vacío o una ruta que el servidor rechaza por no contener `plugs\`.
 */
function setRootWarning(visible: boolean): void {
  els.rootWarning.hidden = !visible;
  // `hidden` no quita el texto de la descripción accesible del campo: el
  // enlace se pone solo mientras el aviso se ve, para no leerlo siempre.
  if (visible) els.root.setAttribute('aria-describedby', 'root-warning');
  else els.root.removeAttribute('aria-describedby');
}

function setBanksStatus(message: string, kind = 'info'): void {
  els.banksStatus.textContent = message;
  els.banksStatus.className = `status ${kind}`;
}

function setBatchStatus(message: string, kind = 'info'): void {
  els.batchStatus.textContent = message;
  els.batchStatus.className = `status ${kind}`;
}

/** Rellena un `<datalist>`: el navegador lo usa como autocompletado del campo. */
function renderDatalist(list: HTMLDataListElement, values: readonly string[]): void {
  list.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement('option');
      option.value = value;
      return option;
    }),
  );
}

/**
 * Sugerencias de bancos junto al cuadro de texto. Un `<datalist>` no funciona
 * con un `<textarea>`, así que se pintan como botones: al pulsar uno se suma la
 * ruta a la lista sin borrar lo escrito ni repetirla.
 */
function renderRecentBanks(): void {
  els.recentBanks.replaceChildren();
  els.recentBanks.hidden = recentBanks.length === 0;
  if (recentBanks.length === 0) return;

  const label = document.createElement('span');
  label.className = 'recents-label';
  label.textContent = 'Recientes:';
  els.recentBanks.append(label);

  for (const bankPath of recentBanks) {
    const name = bankName(bankPath);
    const item = document.createElement('span');
    item.className = 'recent-item';

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'recent-chip';
    chip.textContent = name;
    chip.title = bankPath;
    chip.addEventListener('click', () => {
      const before = els.importPaths.value;
      els.importPaths.value = appendPaths(before, [bankPath]);
      setBanksStatus(
        els.importPaths.value === before
          ? 'Ese banco ya está en la lista.'
          : `Añadido ${chip.textContent} a la lista.`,
        els.importPaths.value === before ? 'info' : 'ok',
      );
      els.importPaths.focus();
    });

    // Quita solo esta sugerencia; el resto de la fila no se toca.
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'recent-chip-remove';
    forget.textContent = '×';
    forget.title = `Olvidar ${name} de los recientes`;
    forget.setAttribute('aria-label', `Olvidar ${name} de los recientes`);
    forget.addEventListener('click', () => forgetRecentBank(bankPath));

    item.append(chip, forget);
    els.recentBanks.append(item);
  }

  // Acceso directo para olvidar solo estos bancos: no toca el historial de
  // carpetas ni de DLL, ni lo escrito en el cuadro de rutas.
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'recent-clear';
  clear.textContent = 'Olvidar';
  clear.prepend(createIcon('trash'));
  clear.title = 'Olvidar los bancos recientes; la lista escrita no cambia';
  clear.addEventListener('click', () => clearRecentBanks());
  els.recentBanks.append(clear);
}

/** Último segmento de una ruta, para nombrar un banco en los mensajes. */
function bankName(bankPath: string): string {
  return bankPath.split(/[\\/]/).at(-1) ?? bankPath;
}

/**
 * Quita una sola sugerencia de banco, sin tocar las demás ni lo escrito en el
 * cuadro. Se compara como el historial (`pathKey`), así que la misma ruta con
 * otras mayúsculas o barras también sale.
 */
function forgetRecentBank(bankPath: string): void {
  const key = pathKey(bankPath);
  const remaining = recentBanks.filter((entry) => pathKey(entry) !== key);
  if (remaining.length === recentBanks.length) return;

  recentBanks = remaining;
  writeRecentList(STORAGE_RECENT_BANKS, recentBanks);
  renderRecents();
  setBanksStatus(`Olvidado ${bankName(bankPath)} de los recientes.`, 'ok');
}

/**
 * Olvida solo el historial del cuadro «Importar bancos .fxb». Las sugerencias
 * de la librería y del DLL se conservan, y el banco vuelve a aparecer aquí en
 * cuanto se importa otra vez.
 */
function clearRecentBanks(): void {
  if (recentBanks.length === 0) return;

  recentBanks = [];
  writeRecentList(STORAGE_RECENT_BANKS, recentBanks);
  renderRecents();
  setBanksStatus('Bancos recientes olvidados.', 'ok');
}

function renderRecents(): void {
  renderDatalist(els.rootRecents, recentRoots);
  renderDatalist(els.dllRecents, recentDlls);
  renderRecentBanks();
  els.recentsClear.disabled = recentRoots.length + recentDlls.length + recentBanks.length === 0;
}

/**
 * Olvida las tres listas de sugerencias. Los campos conservan lo que tengan
 * escrito: se borra el historial, no la selección actual, y basta con volver a
 * usar una ruta para que `rememberRoot` o `rememberDll` la anoten de nuevo.
 */
function clearRecents(): void {
  if (recentRoots.length + recentDlls.length + recentBanks.length === 0) return;
  if (
    !window.confirm(
      'Se olvidarán las rutas sugeridas en esta página: carpetas de librería, ' +
        'DLL y bancos recientes. Lo escrito en los campos no cambia. ¿Vaciar el historial?',
    )
  ) {
    return;
  }

  recentRoots = [];
  recentDlls = [];
  recentBanks = [];
  writeRecentList(STORAGE_RECENT_ROOTS, recentRoots);
  writeRecentList(STORAGE_RECENT_DLLS, recentDlls);
  writeRecentList(STORAGE_RECENT_BANKS, recentBanks);
  renderRecents();
  setStatus('Historial de rutas recientes vaciado.', 'ok');
}

function rememberRoot(value: string): void {
  recentRoots = rememberRecent(recentRoots, value);
  writeRecentList(STORAGE_RECENT_ROOTS, recentRoots);
  renderRecents();
}

function rememberDll(value: string): void {
  recentDlls = rememberRecent(recentDlls, value);
  writeRecentList(STORAGE_RECENT_DLLS, recentDlls);
  renderRecents();
}

function rememberBanks(values: readonly string[]): void {
  if (values.length === 0) return;
  recentBanks = rememberRecentPaths(recentBanks, values);
  writeRecentList(STORAGE_RECENT_BANKS, recentBanks);
  renderRecentBanks();
}

/**
 * Poda el historial con lo que hay ahora en el disco: el navegador no puede
 * saber si una carpeta o un `.fxb` siguen ahí, así que lo pregunta al servidor
 * y descarta las sugerencias caducadas (una carpeta renombrada, un banco
 * borrado, un DLL desinstalado). Se hace al cargar la vista, antes de escanear,
 * para que los `<datalist>` y los botones de bancos no ofrezcan rutas muertas.
 */
async function pruneRecents(): Promise<void> {
  const paths = [...new Set([...recentRoots, ...recentDlls, ...recentBanks])];
  if (paths.length === 0) return;

  try {
    const { results } = await client.system.paths({ paths });
    const roots = existingRecents(recentRoots, results, 'directory');
    const dlls = existingRecents(recentDlls, results, 'file');
    const banks = existingRecents(recentBanks, results, 'file');
    // El filtro solo quita: si ninguna lista se acortó, no hay nada que guardar.
    if (
      roots.length === recentRoots.length &&
      dlls.length === recentDlls.length &&
      banks.length === recentBanks.length
    ) {
      return;
    }

    recentRoots = roots;
    recentDlls = dlls;
    recentBanks = banks;
    writeRecentList(STORAGE_RECENT_ROOTS, recentRoots);
    writeRecentList(STORAGE_RECENT_DLLS, recentDlls);
    writeRecentList(STORAGE_RECENT_BANKS, recentBanks);
    renderRecents();
  } catch {
    // Sin servidor o sin permisos se conservan las sugerencias: una ruta de más
    // es mejor que perder el historial por un fallo de la comprobación.
  }
}

function setBusy(value: boolean): void {
  busy = value;
  els.scanButton.disabled = value;
  els.rootBrowse.disabled = value;
  els.dllBrowse.disabled = value;
  els.form.setAttribute('aria-busy', String(value));
  for (const row of catalogRows()) {
    const plugin = scanData?.plugins.find((entry) => entry.name === row.dataset['rowId']);
    const blocked = plugin !== undefined && !plugin.hasLoader && plugin.compatible === false;
    for (const button of row.querySelectorAll<HTMLButtonElement>('button')) {
      button.disabled = value || (button.dataset['action'] === 'toggle' && blocked);
    }
  }
  updateBatchControls();
}

function updateBatchControls(): void {
  const plugins = scanData?.plugins ?? [];
  const installable = plugins.filter(
    (plugin) => !plugin.hasLoader && plugin.compatible === true,
  ).length;
  const installed = plugins.filter((plugin) => plugin.hasLoader).length;

  setButtonLabel(
    els.installAll,
    installable === 0
      ? 'Poner cargador a todos'
      : `Poner cargador a todos (${installable})`,
  );
  els.installAll.disabled = busy || installable === 0;
  setButtonLabel(
    els.uninstallAll,
    installed === 0
      ? 'Quitar cargador a todos'
      : `Quitar cargador a todos (${installed})`,
  );
  els.uninstallAll.disabled = busy || installed === 0;

  // Cancelar solo tiene sentido mientras corre un lote: el mismo `busy` lo
  // comparten el escaneo y los reintentos, que no se pueden cancelar así.
  els.batchCancel.hidden = batchController === null;
  els.batchCancel.disabled = batchController === null || batchController.signal.aborted;

  // Reanudar aparece cuando el lote se cortó y quedó algo sin confirmar. El
  // escaneo posterior dice si ese plugin acabó de todos modos: lo que ya está
  // en el estado buscado no se repite.
  const resume = pendingResume();
  els.batchResume.hidden = resume === null;
  setButtonLabel(els.batchResume, resume === null ? '' : resumeLabel(resume.plugins.length));
  els.batchResume.title =
    resume === null
      ? ''
      : `Reanudar solo los ${resume.plugins.length} plugin(s) que quedaron sin confirmar` +
        ' al cortarse el lote';
  els.batchResume.disabled = busy || resume === null;

  // Reintentar todos aparece solo mientras queden fallos del lote; el texto
  // lleva la cuenta para no tener que abrir el desplegable de errores.
  els.retryAll.hidden = batchFailures.length === 0;
  setButtonLabel(els.retryAll, `Reintentar fallidos (${batchFailures.length})`);
  els.retryAll.disabled = busy || batchFailures.length === 0;
  els.retryAll.title =
    batchFailures.length === 0
      ? ''
      : `Reintenta en orden los ${batchFailures.length} plugin(s) que fallaron, ` +
        'cada uno con su acción';

  els.batchErrors.hidden = batchFailures.length === 0;
  // El texto va en su propio nodo: el chevrón del summary no se puede pisar.
  els.batchErrorsLabel.textContent =
    batchFailures.length === 1 ? '1 error' : `${batchFailures.length} errores`;
  for (const button of els.batchErrorList.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = busy;
  }
}

/** Oculta la barra de progreso del lote, su reloj y el paso en curso. */
function hideBatchProgress(): void {
  els.batchProgress.hidden = true;
  els.batchProgress.value = 0;
  els.batchProgress.max = 1;
  els.batchStep.hidden = true;
  els.batchStep.textContent = '';
  stopBatchClock();
  els.batchClock.hidden = true;
  els.batchClock.textContent = '';
}

/** Barra, texto, paso interno y reloj del progreso en caliente. */
function showBatchProgress(progress: BatchProgress): void {
  els.batchProgress.hidden = false;
  els.batchProgress.max = Math.max(progress.total, 1);
  els.batchProgress.value = progress.done;

  const step = stepLabel(progress);
  els.batchStep.hidden = step === null;
  els.batchStep.textContent = step ?? '';

  batchProgress = progress;
  els.batchClock.hidden = false;
  renderBatchClock();

  if (!progress.finished) setBatchStatus(progressLabel(progress), 'busy');
}

/**
 * Arranca el reloj del lote y su refresco. El tiempo se mide en la vista, así
 * que corre aunque el servidor tarde en mandar el siguiente evento; el reloj
 * se para y se oculta al terminar, con la barra.
 */
function startBatchClock(): BatchClock {
  stopBatchClock();
  const clock = new BatchClock();
  batchClock = clock;
  batchProgress = null;
  els.batchClock.hidden = false;
  els.batchClock.textContent = '';
  batchTicker = setInterval(renderBatchClock, 250);
  return clock;
}

function stopBatchClock(): void {
  if (batchTicker !== null) {
    clearInterval(batchTicker);
    batchTicker = null;
  }
  batchClock = null;
  batchProgress = null;
}

/** Tiempo transcurrido, estimación de lo que falta y tiempo del paso actual. */
function renderBatchClock(): void {
  if (batchClock === null || batchProgress === null) return;
  els.batchClock.textContent = timingLabel(batchClock.snapshot(batchProgress), batchProgress);
}

/** Icono del sprite para un botón que la vista crea sobre la marcha. */
function createIcon(name: string): SVGSVGElement {
  // El espacio de nombres va literal: `renderRecentBanks` corre antes de que se
  // inicialicen las constantes de la mitad del archivo (zona muerta temporal).
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}

/**
 * Cambia el texto de un botón sin borrar su icono: el marcado pone el texto en
 * `.label`; un botón sin icono sigue aceptando `textContent` tal cual.
 */
function setButtonLabel(button: HTMLButtonElement, text: string): void {
  const label = button.querySelector<HTMLElement>('.label');
  if (label === null) {
    button.textContent = text;
    return;
  }
  label.textContent = text;
}

/** Fila de la tabla para ese plugin, si sigue visible. */
function rowForPlugin(name: string): HTMLTableRowElement | null {
  for (const row of catalogRows()) {
    if (fieldCell(row, 'name')?.textContent === name) return row;
  }
  return null;
}

/**
 * Marca la fila del plugin en curso y, al terminar, si salió bien o mal. El
 * resultado definitivo llega con el refresco posterior del escaneo.
 */
function markBatchRow(name: string, state: 'running' | 'done' | 'failed'): void {
  const row = rowForPlugin(name);
  if (row === null) return;
  row.classList.toggle('batch-running', state === 'running');
  row.classList.toggle('batch-done', state === 'done');
  row.classList.toggle('batch-failed', state === 'failed');
  row.setAttribute('aria-busy', String(state === 'running'));
}

function clearBatchMarks(): void {
  for (const row of catalogRows()) {
    row.classList.remove('batch-running', 'batch-done', 'batch-failed');
    row.removeAttribute('aria-busy');
  }
}

/**
 * Lo que queda por reanudar, ya contrastado con el último escaneo: `null` si no
 * hay nada pendiente o si lo pendiente ya está en el estado buscado.
 */
function pendingResume(): { action: BatchAction; plugins: string[] } | null {
  if (batchPending === null) return null;
  const plugins = resumablePlugins(
    batchPending.plugins,
    scanData?.plugins ?? [],
    batchPending.action,
  );
  return plugins.length === 0 ? null : { action: batchPending.action, plugins };
}

function clearBatchErrors(): void {
  batchFailures = [];
  batchPending = null;
  els.batchErrorList.replaceChildren();
  els.batchErrors.hidden = true;
  els.batchErrors.open = false;
  clearBatchMarks();
  hideBatchProgress();
  setBatchStatus('');
  updateBatchControls();
}

/**
 * Deshabilita el panel mientras hay una petición en curso. Guardar la
 * configuración exige un plugin instalado: escribir `fxbLoader.config` a mano
 * haría que el escaneo lo marcase como instalado sin tener el DLL.
 */
function syncBanksDisabled(): void {
  const locked = banksBusy || banks === null || !banks.data.plugin.hasLoader;
  els.banksClose.disabled = banksBusy;
  els.defaultBank.disabled = locked;
  els.loadFxb.disabled = locked;
  els.defaultSave.disabled = locked;
  els.defaultConvert.disabled =
    locked || banks === null || banks.data.config.config.defaultFxbName.trim() === '';
  // Sin respaldo no hay nada que restaurar ni descartar: el servidor devolvería un 409.
  const noBackup = locked || banks === null || banks.data.defaultBackup === null;
  els.defaultRestore.disabled = noBackup;
  els.defaultDiscard.disabled = noBackup;
  els.importPaths.disabled = banksBusy;
  els.importBrowse.disabled = banksBusy;
  els.importOverwrite.disabled = banksBusy;
  els.importButton.disabled = banksBusy;
  els.exportBank.disabled = banksBusy;
  els.exportOrder.disabled = banksBusy;
  els.exportOverwrite.disabled = banksBusy;
  els.exportButton.disabled = banksBusy || els.exportBank.value === '';
  for (const button of els.banksTable.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = locked || button.dataset['default'] === 'true';
  }
}

function setBanksBusy(value: boolean): void {
  banksBusy = value;
  els.banks.setAttribute('aria-busy', String(value));
  syncBanksDisabled();
}

function renderLoader(loader: LibraryScanResponse['loader'] | null): void {
  if (!loader) {
    els.loaderStatus.textContent = '';
    els.loaderStatus.className = 'loader-status';
    els.loaderStatus.title = '';
    return;
  }

  els.loaderStatus.textContent = loader.valid
    ? `fxbLoader.dll: PE32 ${loader.machine} (${loader.bitness} bits)`
    : `fxbLoader.dll incompatible: ${loader.issues.join('; ')}`;
  els.loaderStatus.className = `loader-status ${loader.valid ? 'ok' : 'error'}`;
  els.loaderStatus.title = loader.path;
}

/** Nombres que se listan en el tooltip de la pastilla de bancos. */
const MAX_BANK_NAMES_IN_TITLE = 12;

/** `1 banco`, `N bancos` o `sin bancos`. */
function bankCountLabel(count: number): string {
  if (count === 0) return 'sin bancos';
  return count === 1 ? '1 banco' : `${count} bancos`;
}

/**
 * La pastilla de bancos lleva el recuento del último escaneo y, al pasar el
 * ratón, los nombres: el mismo listado que abre el panel.
 */
function paintBanksBadge(
  badge: HTMLButtonElement,
  pluginName: string,
  banks: ScanPlugin['banks'] | undefined,
): void {
  const count = banks?.count ?? 0;
  const label = bankCountLabel(count);
  badge.textContent = label;
  badge.classList.toggle('on', count > 0);
  badge.setAttribute('aria-label', `Bancos de ${pluginName}: ${label}. Abrir el panel`);

  if (count === 0) {
    badge.title = `Abrir el panel de bancos de ${pluginName} (sin bancos)`;
    return;
  }

  const names = banks?.names ?? [];
  const shown = names.slice(0, MAX_BANK_NAMES_IN_TITLE);
  const rest = count - shown.length;
  const list = rest > 0 ? [...shown, `… y ${rest} más`].join('\n') : shown.join('\n');
  badge.title = `Bancos de ${pluginName}:\n${list}\n\nAbrir el panel de bancos`;
}

/**
 * Refresca la pastilla de la fila con lo que acaba de leer el panel de bancos.
 * También guarda el recuento en el último escaneo: los filtros «con bancos» y
 * «sin bancos» leen de ahí y, si uno está activo, la tabla se repinta para que
 * el plugin no siga en una lista a la que ya no pertenece.
 */
function syncBanksBadge(pluginName: string, names: string[]): void {
  const plugin = scanData?.plugins.find((entry) => entry.name === pluginName);
  if (plugin !== undefined) plugin.banks = { count: names.length, names: [...names] };

  const row = rowForPlugin(pluginName);
  if (row !== null) {
    const banksCell = fieldCell(row, 'banks') as HTMLButtonElement | undefined;
    if (banksCell !== undefined) paintBanksBadge(banksCell, pluginName, {
      count: names.length,
      names,
    });
  }

  if (scanData !== null && catalogFilters['banks'] !== 'all') render(scanData);
}

/**
 * El Catálogo General monta sobre `mountTable`: sus columnas con badges, los
 * cuatro ejes de tres estados como chips del sistema de tablas, la búsqueda por
 * nombre/`pluginName`/ruta y la paginación común. El orden, los filtros y la
 * página viven dentro de la tabla; aquí solo se pinta el snapshot del escaneo
 * y se actualiza el recuento de `#filter-count`.
 */
let catalogTable: TableController<ScanPlugin> | null = null;
/** Filtros vigentes de la tabla, para que el resto del código sepa qué mira. */
let catalogFilters: Record<string, string> = {};

const catalogTableView: TableView<ScanPlugin> = {
  columns: [
    {
      id: 'name',
      label: 'Plugin',
      sortType: 'text',
      getValue: (plugin) => plugin.name,
      cellDataset: () => ({ field: 'name' }),
      cellTitle: (plugin) => (plugin.warnings.length > 0 ? plugin.warnings.join('\n') : undefined),
    },
    {
      id: 'status',
      label: 'Estado',
      sortType: 'text',
      getValue: (plugin) => (plugin.hasLoader ? 'con cargador' : 'sin cargador'),
      renderNode: (plugin) => {
        const badge = document.createElement('span');
        badge.className = plugin.hasLoader ? 'badge on' : 'badge';
        badge.dataset['field'] = 'status';
        badge.textContent = plugin.hasLoader ? 'con cargador' : 'sin cargador';
        return badge;
      },
    },
    {
      id: 'compatibility',
      label: 'Compatibilidad',
      sortType: 'text',
      getValue: (plugin) =>
        plugin.compatible === true ? 'compatible' : plugin.compatible === false ? 'incompatible' : 'sin verificar',
      renderNode: (plugin) => {
        const badge = document.createElement('span');
        badge.className = plugin.compatible === true ? 'badge on' : plugin.compatible === false ? 'badge bad' : 'badge';
        badge.dataset['field'] = 'compatibility';
        badge.textContent =
          plugin.compatible === true ? 'compatible' : plugin.compatible === false ? 'incompatible' : 'sin verificar';
        badge.title = plugin.compatibilityIssues.join('\n');
        return badge;
      },
    },
    {
      id: 'pluginName',
      label: 'pluginName',
      sortType: 'text',
      sortable: false,
      getValue: (plugin) => plugin.pluginName ?? '',
      cellDataset: () => ({ field: 'pluginName' }),
      renderCell: (plugin) => plugin.pluginName || '—',
    },
    {
      id: 'vfxinfo',
      label: 'vfxinfo.txt',
      sortType: 'text',
      sortable: false,
      getValue: (plugin) => (plugin.hasVfxinfo ? 'presente' : 'falta'),
      renderNode: (plugin) => {
        const badge = document.createElement('span');
        badge.className = plugin.hasVfxinfo ? 'badge on' : 'badge';
        badge.dataset['field'] = 'vfxinfo';
        badge.textContent = plugin.hasVfxinfo ? 'presente' : 'falta';
        return badge;
      },
    },
    {
      id: 'wizard',
      label: 'Wizard',
      sortType: 'text',
      sortable: false,
      getValue: (plugin) => (plugin.hasWizard ? 'disponible' : '—'),
      renderNode: (plugin) => {
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = plugin.hasWizard ? 'badge badge-action on' : 'badge badge-action';
        badge.dataset['field'] = 'wizard';
        badge.textContent = plugin.hasWizard ? 'disponible' : '—';
        badge.title = plugin.hasWizard
          ? `Wizard oficial disponible (${plugin.wizardId}). Abrir panel del wizard`
          : `Sin wizard oficial para ${plugin.name}. Abrir panel del wizard`;
        badge.setAttribute(
          'aria-label',
          `Wizard de ${plugin.name}: ${plugin.hasWizard ? 'disponible' : 'no disponible'}. Abrir el panel`,
        );
        badge.addEventListener('click', () => {
          closeAllRowMenus();
          void openPluginWizard(plugin, badge);
        });
        return badge;
      },
    },
    {
      // La pastilla cuenta los bancos del último escaneo y abre el cajón con
      // el listado completo, validado, que se refresca al importar o borrar.
      id: 'banks',
      label: 'Bancos',
      sortType: 'text',
      sortable: false,
      getValue: (plugin) => bankCountLabel(plugin.banks?.count ?? 0),
      renderNode: (plugin) => {
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'badge badge-action';
        badge.dataset['field'] = 'banks';
        paintBanksBadge(badge, plugin.name, plugin.banks);
        badge.addEventListener('click', () => {
          closeAllRowMenus();
          void openBanks(plugin, badge);
        });
        return badge;
      },
    },
    {
      id: 'meta',
      label: 'Catálogo',
      sortType: 'text',
      sortable: false,
      getValue: (plugin) => (plugin.hasMeta ? 'presente' : 'falta'),
      renderNode: (plugin) => {
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = plugin.hasMeta ? 'badge badge-action on' : 'badge badge-action';
        badge.dataset['field'] = 'meta';
        badge.textContent = plugin.hasMeta ? 'presente' : 'falta';
        badge.title = plugin.hasMeta
          ? `Abrir el catálogo de ${plugin.name}`
          : `Crear el catálogo de ${plugin.name}`;
        badge.setAttribute(
          'aria-label',
          `Catálogo de ${plugin.name}: ${plugin.hasMeta ? 'presente' : 'falta'}. Abrir el panel`,
        );
        badge.addEventListener('click', () => {
          closeAllRowMenus();
          void openMeta(plugin, badge);
        });
        return badge;
      },
    },
  ],
  getRowId: (plugin) => plugin.name,
  initialSort: { columnId: 'name', direction: 'asc' },
  pageSize: 25,
  searchId: 'plugin-filter',
  // El texto de fila cubre lo que buscaba antes el filtro a mano: nombre,
  // `pluginName` y la ruta de la carpeta.
  searchText: (plugin) => [plugin.name, plugin.pluginName ?? '', plugin.path].join('\n'),
  emptyText: 'Ningún plugin coincide con el filtro.',
  filters: [
    {
      id: 'install',
      label: 'Filtro del cargador',
      columnId: 'status',
      type: 'chip',
      icon: 'check',
      options: [
        { value: 'installed', label: 'Con cargador', tone: 'positive', predicate: (plugin) => plugin.hasLoader },
        { value: 'uninstalled', label: 'Sin cargador', tone: 'negative', predicate: (plugin) => !plugin.hasLoader },
        { value: 'all', label: 'Con y sin cargador', tone: 'neutral' },
      ],
    },
    {
      id: 'banks',
      label: 'Filtro de bancos',
      columnId: 'banks',
      type: 'chip',
      icon: 'banks',
      options: [
        {
          value: 'with-banks',
          label: 'Con bancos',
          tone: 'positive',
          predicate: (plugin) => (plugin.banks?.count ?? 0) > 0,
        },
        {
          value: 'without-banks',
          label: 'Sin bancos',
          tone: 'negative',
          predicate: (plugin) => (plugin.banks?.count ?? 0) === 0,
        },
        { value: 'all', label: 'Con y sin bancos', tone: 'neutral' },
      ],
    },
    {
      id: 'wizard',
      label: 'Filtro de wizard',
      columnId: 'wizard',
      type: 'chip',
      icon: 'tag',
      options: [
        { value: 'with-wizard', label: 'Con wizard', tone: 'positive', predicate: (plugin) => plugin.hasWizard },
        { value: 'without-wizard', label: 'Sin wizard', tone: 'negative', predicate: (plugin) => !plugin.hasWizard },
        { value: 'all', label: 'Con y sin wizard', tone: 'neutral' },
      ],
    },
    {
      id: 'compat',
      label: 'Filtro de compatibilidad',
      columnId: 'compatibility',
      type: 'chip',
      icon: 'ban',
      options: [
        {
          value: 'compatible',
          label: 'Ningún incompatible',
          tone: 'positive',
          predicate: (plugin) => plugin.compatible !== false,
        },
        {
          value: 'incompatible',
          label: 'Solo incompatibles',
          tone: 'negative',
          predicate: (plugin) => plugin.compatible === false,
        },
        { value: 'all', label: 'Compatibles e incompatibles', tone: 'neutral' },
      ],
    },
  ],
  rowActions: {
    actions: (plugin) => [
      {
        id: 'toggle',
        label: plugin.hasLoader ? 'Quitar cargador' : 'Poner cargador',
        icon: plugin.hasLoader ? 'trash' : 'download',
        tone: plugin.hasLoader ? 'danger' : 'primary',
        disabled: () => !plugin.hasLoader && plugin.compatible === false,
        onSelect: () => void runAction(plugin, plugin.hasLoader),
      },
      {
        id: 'banks',
        label: 'Bancos',
        icon: 'folder',
        onSelect: (_plugin, trigger) => void openBanks(plugin, trigger),
      },
      {
        id: 'meta',
        label: 'Catálogo',
        icon: 'tag',
        onSelect: (_plugin, trigger) => void openMeta(plugin, trigger),
      },
      {
        id: 'wizard',
        label: 'Wizard',
        icon: 'file',
        onSelect: (_plugin, trigger) => void openPluginWizard(plugin, trigger),
      },
      {
        id: 'log',
        label: 'Historial',
        icon: 'list',
        onSelect: (_plugin, trigger) => void openLogDrawer(plugin, trigger),
      },
    ],
  },
  onProcessed: (info) => {
    catalogFilters = info.filters as Record<string, string>;
    // El recuento solo aparece cuando algo filtra, como hasta ahora.
    const filtering =
      info.query.trim() !== '' || Object.values(info.filters).some((value) => value !== 'all');
    els.filterCount.textContent = filtering
      ? `${info.total} de ${scanData?.plugins.length ?? info.total} plugin(s)`
      : '';
  },
};

/** Filas pintadas ahora mismo en el catálogo (las de la página vigente). */
function catalogRows(): HTMLTableRowElement[] {
  return catalogTable === null ? [] : [...catalogTable.tbody.rows];
}

/** Celda con ese `data-field` dentro de una fila, o `undefined`. */
function fieldCell(row: HTMLTableRowElement, field: string): HTMLElement | undefined {
  for (const cellElement of row.cells) {
    for (const child of [cellElement, ...cellElement.children] as HTMLElement[]) {
      if (child.dataset['field'] === field) return child;
    }
  }
  return undefined;
}

function render(data: LibraryScanResponse, options?: { resetPage?: boolean }): void {
  scanData = data;
  for (const plugin of data.plugins) {
    if (!plugin.banks) {
      plugin.banks = { count: 0, names: [] };
    }
  }
  updateBatchControls();
  els.results.hidden = false;

  const installed = data.plugins.filter((plugin) => plugin.hasLoader).length;
  const incompatible = data.plugins.filter((plugin) => plugin.compatible === false).length;
  els.summary.textContent =
    data.plugins.length === 0
      ? 'No hay plugins en la librería'
      : `${installed} de ${data.plugins.length} con el cargador${
          incompatible === 0 ? '' : ` · ${incompatible} incompatible(s)`
        }`;
  els.plugsPath.textContent = data.plugsPath;
  renderLoader(data.loader);

  // El aviso vacío distingue «no hay plugins» de «no pasa el filtro».
  catalogTableView.emptyText =
    data.plugins.length === 0
      ? 'La carpeta plugs\\ no contiene subdirectorios.'
      : 'Ningún plugin coincide con el filtro.';

  if (catalogTable === null) {
    catalogTable = mountTable(els.pluginsTable, catalogTableView, data.plugins);
  } else {
    // Un escaneo nuevo vuelve a la primera página; los refrescos de badges y
    // bancos no mueven la página que estuviera mirando la persona.
    catalogTable.setRows(data.plugins, { keepPage: options?.resetPage !== true });
  }
}

function currentDll(): string {
  return els.dll.value.trim();
}

function scanBody(): RequestBody<'/library/scan', 'post'> {
  const body: RequestBody<'/library/scan', 'post'> = { libraryRoot };
  const dll = currentDll();
  if (dll !== '') body.dllSourcePath = dll;
  return body;
}

async function fetchPlugins(): Promise<LibraryScanResponse> {
  return client.library.scan(scanBody());
}

async function scan(): Promise<void> {
  if (busy) return;
  if (!libraryRoot) {
    setRootWarning(true);
    setStatus('Introduce la carpeta de la librería.', 'error');
    els.root.focus();
    return;
  }

  setBusy(true);
  setStatus('Escaneando…', 'busy');
  closeBanks();
  closeMeta();
  clearBatchErrors();
  scanData = null;
  updateBatchControls();
  try {
    const data = await fetchPlugins();
    render(data, { resetPage: true });
    setRootWarning(false);
    const incompatible = data.plugins.filter((plugin) => plugin.compatible === false).length;
    setStatus(
      data.plugins.length === 0
        ? 'No se encontraron plugins en plugs\\.'
        : `${data.plugins.length} plugin(s) encontrados${
            incompatible === 0 ? '.' : `; ${incompatible} incompatible(s).`
          }`,
      'ok',
    );
  } catch (error) {
    scanData = null;
    updateBatchControls();
    els.results.hidden = true;
    renderLoader(null);
    // Un 400 al escanear es siempre el `libraryRoot`: no es una ruta válida o
    // no contiene `plugs\`, que es justo lo que explica el aviso.
    setRootWarning(isFxbApiError(error) && error.status === 400);
    setStatus(describeError(error), 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * Abre el diálogo nativo del servidor. Devuelve `null` si no se pudo abrir (ya
 * dejó el motivo en el estado) y `[]` si la persona canceló, que no es un
 * error: el servidor no toca nada y la vista deja los campos como estaban.
 */
async function pickPaths(
  body: RequestBody<'/system/pick', 'post'>,
  where: 'library' | 'banks',
): Promise<string[] | null> {
  const show = where === 'library' ? setStatus : setBanksStatus;
  try {
    const response = await client.system.pick(body);
    return response.paths;
  } catch (error) {
    show(describeError(error), 'error');
    return null;
  }
}

/** Botón «Elegir carpeta…»: escribe la ruta elegida y escanea con ella. */
async function chooseLibraryRoot(): Promise<void> {
  if (busy) return;

  els.rootBrowse.disabled = true;
  setStatus('Elige la carpeta de la librería en el diálogo…', 'busy');
  try {
    const body: RequestBody<'/system/pick', 'post'> = {
      kind: 'folder',
      title: 'Elige la carpeta de la librería VFX (la que contiene plugs)',
    };
    if (libraryRoot !== '') body.initialDir = libraryRoot;

    const picked = await pickPaths(body, 'library');
    if (picked === null) return; // El motivo ya está en el estado.
    const chosen = picked[0];
    if (chosen === undefined) {
      setStatus('No se cambió nada: el diálogo se canceló.', 'info');
      return;
    }

    els.root.value = chosen;
    libraryRoot = chosen;
    writeStorage(STORAGE_ROOT, chosen);
    rememberRoot(chosen);
    await scan();
  } finally {
    els.rootBrowse.disabled = busy;
  }
}

/** Botón «Elegir DLL…»: rellena la opción avanzada y revalida con `scan`. */
async function chooseDll(): Promise<void> {
  if (busy) return;

  els.dllBrowse.disabled = true;
  setStatus('Elige el fxbLoader.dll en el diálogo…', 'busy');
  try {
    const body: RequestBody<'/system/pick', 'post'> = {
      kind: 'file',
      title: 'Elige el fxbLoader.dll',
      extensions: ['dll'],
    };
    const start = parentDir(currentDll() || recentDlls[0] || '');
    if (start !== null) body.initialDir = start;

    const picked = await pickPaths(body, 'library');
    if (picked === null) return; // El motivo ya está en el estado.
    const chosen = picked[0];
    if (chosen === undefined) {
      setStatus('No se cambió nada: el diálogo se canceló.', 'info');
      return;
    }

    els.dll.value = chosen;
    writeStorage(STORAGE_DLL, chosen);
    rememberDll(chosen);
    if (libraryRoot === '') {
      setStatus('DLL elegido. Falta la carpeta de la librería para validarlo.', 'ok');
      return;
    }
    await scan();
  } finally {
    els.dllBrowse.disabled = busy;
  }
}

/**
 * Botón «Añadir archivos…» del panel de bancos: suma los `.fxb` elegidos al
 * cuadro de texto sin borrar lo que ya hubiera escrito y sin repetir rutas.
 */
async function chooseImportFiles(): Promise<void> {
  if (banks === null || banksBusy) return;

  els.importBrowse.disabled = true;
  setBanksStatus('Elige los bancos .fxb en el diálogo…', 'busy');
  try {
    const body: RequestBody<'/system/pick', 'post'> = {
      kind: 'files',
      title: 'Elige los bancos .fxb para importar',
      extensions: ['fxb'],
    };
    const start = parentDir(readImportPaths().at(-1) ?? recentBanks[0] ?? '');
    if (start !== null) body.initialDir = start;

    const picked = await pickPaths(body, 'banks');
    if (picked === null) return; // El motivo ya está en el estado.
    if (picked.length === 0) {
      setBanksStatus('No se cambió nada: el diálogo se canceló.', 'info');
      return;
    }

    const before = readImportPaths().length;
    els.importPaths.value = appendPaths(els.importPaths.value, picked);
    rememberBanks(picked);
    const total = readImportPaths().length;
    setBanksStatus(
      total === before
        ? `Esos archivo(s) ya estaban en la lista (${total}).`
        : `${total - before} archivo(s) añadidos; ${total} en la lista.`,
      'ok',
    );
    els.importPaths.focus();
  } finally {
    els.importBrowse.disabled = banksBusy;
  }
}

async function callAction(plugin: BatchPlugin, action: BatchAction): Promise<unknown> {
  if (action === 'remove') {
    return client.library.removeLoader({ libraryRoot, plugin: plugin.name });
  }

  const body: RequestBody<'/library/loader/add', 'post'> = {
    libraryRoot,
    plugin: plugin.name,
  };
  const dll = currentDll();
  if (dll !== '') body.dllSourcePath = dll;
  return client.library.addLoader(body);
}

async function runAction(plugin: ScanPlugin, isInstalled: boolean): Promise<void> {
  if (busy) return;

  setBusy(true);
  setStatus(
    `${isInstalled ? 'Quitando el cargador de' : 'Poniendo el cargador en'} ${plugin.name}…`,
    'busy',
  );

  try {
    await callAction(plugin, isInstalled ? 'remove' : 'add');

    if (banks?.pluginName === plugin.name) closeBanks();
    if (metaState?.pluginName === plugin.name) closeMeta();
    if (batchFailures.some((item) => item.plugin.name === plugin.name)) {
      batchFailures = batchFailures.filter((item) => item.plugin.name !== plugin.name);
      renderBatchErrors();
      setBatchStatus(
        batchFailures.length === 0
          ? 'Sin errores pendientes.'
          : `${batchFailures.length} error(es) pendientes.`,
        batchFailures.length === 0 ? 'ok' : 'error',
      );
    }

    const data = await fetchPlugins();
    render(data);
    setStatus(`${isInstalled ? 'Cargador quitado de' : 'Cargador puesto en'} ${plugin.name}.`, 'ok');
  } catch (error) {
    setStatus(describeError(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function createVfxinfoFromWizard(plugin: ScanPlugin): Promise<void> {
  const confirmed = plugin.hasVfxinfo
    ? window.confirm(
        `¿Reemplazar vfxinfo.txt existente en "${plugin.name}" usando datos del wizard? Se creará respaldo vfxinfo.tx_.`,
      )
    : true;
  if (!confirmed) return;

  setStatus(`Generando vfxinfo.txt desde wizard para ${plugin.name}…`, 'busy');
  try {
    const res = await client.wizards.createVfxinfo({
      pluginDir: plugin.path,
      force: true,
    });
    const data = await fetchPlugins();
    render(data);
    setStatus(
      `Creado vfxinfo.txt para ${plugin.name}${res.backedUp ? ' (con respaldo .tx_)' : ''}.`,
      'ok',
    );
  } catch (error) {
    setStatus(`No se pudo crear vfxinfo.txt: ${describeError(error)}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Lotes: instalar/desinstalar todos los plugins escaneados            */
/* ------------------------------------------------------------------ */

function renderBatchErrors(): void {
  els.batchErrorList.replaceChildren();

  for (const failure of batchFailures) {
    const item = document.createElement('li');
    item.className = 'batch-error';

    const name = document.createElement('strong');
    name.textContent = failure.plugin.name;

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent =
      failure.action === 'add' ? 'poner el cargador' : 'quitar el cargador';

    const message = document.createElement('p');
    message.textContent = failure.message;

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Reintentar';
    retry.prepend(createIcon('refresh'));
    retry.title = `Reintentar ${
      failure.action === 'add' ? 'poner el cargador' : 'quitar el cargador'
    } en ${failure.plugin.name}`;
    retry.addEventListener('click', () => {
      void retryFailure(failure);
    });

    item.append(name, badge, message, retry);
    els.batchErrorList.append(item);
  }

  els.batchErrors.hidden = batchFailures.length === 0;
  els.batchErrors.open = batchFailures.length > 0;
  updateBatchControls();
}

/**
 * Fallos del lote actualizados por nombre: el de un plugin sustituye al que
 * hubiera de un intento anterior, y los de plugins que no se han vuelto a
 * tocar siguen a la vista con su «Reintentar».
 */
function mergeFailures(
  previous: readonly BatchFailure[],
  next: readonly BatchFailure[],
): BatchFailure[] {
  const names = new Set(next.map((failure) => failure.plugin.name));
  return [...previous.filter((failure) => !names.has(failure.plugin.name)), ...next];
}

/**
 * Ejecuta el lote. Con `resume` no recalcula quién es elegible ni borra los
 * fallos anteriores: opera exactamente esa lista, que es la de los plugins que
 * quedaron sin confirmar al cancelar o cortarse el lote.
 */
async function runBatch(
  action: BatchAction,
  resume: readonly string[] | null = null,
): Promise<void> {
  if (busy || scanData === null) return;

  const isInstall = action === 'add';
  const eligible = scanData.plugins.filter((plugin) =>
    isInstall ? !plugin.hasLoader && plugin.compatible === true : plugin.hasLoader,
  );
  const plugins = resume === null ? eligible.map((plugin) => plugin.name) : [...resume];
  if (plugins.length === 0) {
    setBatchStatus(
      isInstall
        ? 'No hay plugins a los que poner el cargador.'
        : 'No hay plugins con cargador que quitar.',
      'info',
    );
    return;
  }

  closeBanks();
  closeMeta();
  if (resume === null) {
    clearBatchErrors();
  } else {
    // El botón desaparece en cuanto arranca: si se vuelve a cortar, el estado
    // final del nuevo lote decide qué queda por reanudar.
    batchPending = null;
    updateBatchControls();
  }
  const controller = new AbortController();
  batchController = controller;
  const clock = startBatchClock();
  setBusy(true);

  const dll = currentDll();
  // El servidor recorre cada petición en serie y va contando qué plugin procesa
  // (`start`, `plugin`, `end`); un fallo individual no detiene al resto. Como
  // rechaza más plugins por petición que el tope, el lote se manda troceado y
  // el avance de todos los trozos se pinta en la misma barra.
  const run = await runBatchInChunks({
    action,
    plugins,
    signal: controller.signal,
    send: (plugins, onEvent) => {
      const body: RequestBody<'/library/batch/stream', 'post'> = { libraryRoot, action, plugins };
      if (isInstall && dll !== '') body.dllSourcePath = dll;
      // La señal aborta el `fetch` en curso; el servidor deja de procesar en
      // cuanto se cierra la respuesta (acaba el plugin que tenía entre manos).
      return client.library.batchStream(body, {
        // El reloj ve los eventos antes que el progreso: así mide el paso y el
        // plugin con la hora de llegada, no la del siguiente repintado.
        onEvent: (event) => {
          clock.event(event);
          onEvent(event);
        },
        signal: controller.signal,
      });
    },
    onProgress: showBatchProgress,
    onPlugin: (event) => {
      markBatchRow(
        event.name,
        event.status === 'running' ? 'running' : event.status === 'failed' ? 'failed' : 'done',
      );
    },
  });
  batchController = null;
  els.batchCancel.disabled = true;
  hideBatchProgress();

  batchFailures = mergeFailures(batchFailures, failuresOf(run));
  // Se guarda antes de refrescar para que el botón se pinte con el escaneo
  // nuevo: si el servidor terminó el plugin en curso, ya no hay nada que hacer.
  batchPending = run.pending.length === 0 ? null : { action, plugins: run.pending };

  try {
    const data = await fetchPlugins();
    render(data);
  } catch (error) {
    setBatchStatus(
      `Terminó el lote, pero no se pudo refrescar la lista: ${describeError(error)}`,
      'error',
    );
    clearBatchMarks();
    renderBatchErrors();
    setBusy(false);
    return;
  }

  if (run.cancelled) {
    // Cancelado por la persona: lo confirmado está hecho en disco y el resto
    // puede seguir sin hacerlo, así que el resumen separa ambas cosas.
    const message = cancelledSummary(run);
    setBatchStatus(message, 'info');
    setStatus(message, 'info');
  } else if (run.error !== null) {
    // Una petición se cortó: lo anterior ya está hecho en disco, así que se
    // resume lo confirmado, se marcan los pendientes y se deja el motivo.
    const pending = run.unreported === 0 ? '' : ` ${run.unreported} plugin(s) sin confirmar.`;
    const message = `El lote se cortó: ${describeError(run.error)} ${summarize(run)}${pending}`;
    setBatchStatus(message, 'error');
    setStatus(message, 'error');
  } else {
    const summary = summarize(run);
    setBatchStatus(summary, run.failed === 0 ? 'ok' : 'error');
    setStatus(summary, run.failed === 0 ? 'ok' : 'error');
  }

  renderBatchErrors();
  setBusy(false);
}

/**
 * Reintenta de una vez todos los fallos pendientes, en orden y con la acción de
 * cada uno (un lote puede mezclar instalar y desinstalar). Usa los endpoints
 * individuales: si un plugin vuelve a fallar se queda en la lista con el nuevo
 * mensaje y el resto sigue probándose. El escaneo se refresca una sola vez, al
 * final.
 */
async function retryAllFailures(): Promise<void> {
  if (busy || batchFailures.length === 0) return;

  const failures = [...batchFailures];
  const total = failures.length;
  let resolved = 0;
  let retryFailed = 0;
  // Mismo reloj, barra y línea de paso que el lote normal. El paso es el plugin
  // que se está reintentando: el endpoint individual no informa de los pasos
  // internos, pero el tiempo de cada reintento sí se mide.
  const clock = startBatchClock();
  setBusy(true);

  try {
    for (const [index, failure] of failures.entries()) {
      clock.event({
        type: 'plugin',
        index,
        total,
        name: failure.plugin.name,
        status: 'running',
        message: null,
      });
      clock.startStep();
      showBatchProgress(retryProgress(failure, index, total, retryFailed));
      setBatchStatus(
        `Reintentando ${index + 1} de ${total}: ${failure.plugin.name}…`,
        'busy',
      );

      let retried = false;
      try {
        await callAction(failure.plugin, failure.action);
        batchFailures = batchFailures.filter((item) => item !== failure);
        resolved += 1;
        retried = true;
      } catch (error) {
        failure.message = describeError(error);
        retryFailed += 1;
      }

      clock.event({
        type: 'plugin',
        index,
        total,
        name: failure.plugin.name,
        status: retried ? (failure.action === 'add' ? 'added' : 'removed') : 'failed',
        message: retried ? null : failure.message,
      });
      renderBatchErrors();
    }

    hideBatchProgress();
    const data = await fetchPlugins();
    render(data);

    const pending = batchFailures.length;
    const message =
      pending === 0
        ? `${resolved} de ${total} reintentado(s); sin errores pendientes.`
        : `${resolved} de ${total} reintentado(s); ${pending} sigue(n) fallando.`;
    setBatchStatus(message, pending === 0 ? 'ok' : 'error');
    setStatus(message, pending === 0 ? 'ok' : 'error');
  } catch (error) {
    // Lo que ya respondió está hecho en disco aunque falle el refresco final.
    const message =
      `Se reintentaron ${resolved} de ${total}, pero no se pudo refrescar la ` +
      `lista: ${describeError(error)}`;
    setBatchStatus(message, 'error');
    setStatus(message, 'error');
  } finally {
    hideBatchProgress();
    renderBatchErrors();
    setBusy(false);
  }
}

async function retryFailure(failure: BatchFailure): Promise<void> {
  if (busy) return;

  setBusy(true);
  setBatchStatus(`Reintentando ${failure.plugin.name}…`, 'busy');

  try {
    await callAction(failure.plugin, failure.action);
    batchFailures = batchFailures.filter((item) => item !== failure);

    const data = await fetchPlugins();
    render(data);
    renderBatchErrors();

    const message = `${failure.plugin.name} ${
      failure.action === 'add' ? 'con cargador' : 'sin cargador'
    } tras reintentar.`;
    setStatus(message, 'ok');
    setBatchStatus(
      batchFailures.length === 0
        ? 'Sin errores pendientes.'
        : `${batchFailures.length} error(es) pendientes.`,
      batchFailures.length === 0 ? 'ok' : 'error',
    );
  } catch (error) {
    failure.message = describeError(error);
    renderBatchErrors();
    setBatchStatus(`Sigue fallando ${failure.plugin.name}.`, 'error');
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ */
/* Bancos por plugin                                                   */
/* ------------------------------------------------------------------ */

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Oculta la barra de la importación y la deja lista para el próximo lote. */
function hideImportProgress(): void {
  els.importProgress.hidden = true;
  els.importProgress.value = 0;
  els.importProgress.max = 1;
}

/** Barra de la importación: un archivo resuelto por cada paso de `value`. */
function showImportProgress(progress: BankImportProgress): void {
  els.importProgress.hidden = false;
  els.importProgress.max = Math.max(progress.total, 1);
  els.importProgress.value = progress.done;
}

function clearBanksView(pluginName: string): void {
  els.banksTitle.textContent = pluginName;
  els.banksPresets.textContent = '';
  els.banksExists.textContent = '';
  els.defaultBank.replaceChildren();
  banksTableController?.destroy();
  banksTableController = null;
  els.banksTable.replaceChildren();
  els.importResults.replaceChildren();
  hideImportProgress();
  els.exportBank.replaceChildren();
  els.loadFxb.checked = false;
}

/** Cajón abierto (bancos o catálogo) y el control que lo abrió. */
let openPanel: HTMLElement | null = null;
let panelOpener: HTMLElement | null = null;

/** Controles que reciben Tab dentro del cajón, en orden de documento. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function isFocusableByTab(element: HTMLElement): boolean {
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
  }
  // Sin `checkVisibility`, el contenido de un `<details>` cerrado conserva
  // rectángulos aunque el navegador no lo tabule; solo su `summary` entra.
  if (element.getClientRects().length === 0) return false;
  const details = element.closest('details');
  return details === null || details.open || element.matches('summary');
}

function panelFocusables(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isFocusableByTab);
}

/**
 * Abre un cajón como diálogo modal: recuerda quién lo abrió, le da el foco al
 * panel para que el lector anuncie su nombre (`aria-labelledby`) y deja el Tab
 * encerrado dentro mientras siga abierto.
 */
function showPanel(panel: HTMLElement, opener?: HTMLElement): void {
  panel.scrollTop = 0;
  if (openPanel === panel) return;

  const active = document.activeElement;
  panelOpener = opener ?? (active instanceof HTMLElement && active !== panel ? active : null);
  openPanel = panel;
  panel.hidden = false;
  els.drawerBackdrop.hidden = false;
  document.body.classList.add('drawer-open');
  panel.focus({ preventScroll: true });
}

function hidePanel(panel: HTMLElement): void {
  panel.hidden = true;
  if (openPanel !== panel) return;

  openPanel = null;
  if (
    els.banks.hidden &&
    els.meta.hidden &&
    els.wizards.hidden &&
    els.pluginWizard.hidden &&
    els.logDrawer.hidden &&
    els.importPackageDrawer.hidden &&
    els.auditDrawer.hidden &&
    els.customPluginDrawer.hidden
  ) {
    els.drawerBackdrop.hidden = true;
    document.body.classList.remove('drawer-open');
  }

  const opener = panelOpener;
  panelOpener = null;
  // El menú de fila se cierra al abrir el cajón: si el control quedó oculto no
  // se le puede devolver el foco, y no es un error.
  if (opener !== null && opener.isConnected && opener.getClientRects().length > 0) {
    opener.focus({ preventScroll: true });
  }
}

function closeBanks(): void {
  if (els.banks.hidden) return;
  hidePanel(els.banks);
  banks = null;
  banksTableController?.destroy();
  banksTableController = null;
  els.banksTable.replaceChildren();
  hideImportProgress();
  setBanksStatus('');
  syncBanksDisabled();
}

const banksTableView: TableView<LibraryBanksListResponse['banks'][number]> = {
  columns: [
    {
      id: 'fileName',
      label: 'Banco',
      sortType: 'text',
      cellDataset: () => ({ field: 'bank-name' }),
      getValue: (entry) => entry.fileName,
      renderNode: (entry) => {
        const span = document.createElement('span');
        span.textContent = entry.fileName;
        const current = banks?.data.config.config.defaultFxbName;
        if (entry.fileName === current) {
          const badge = document.createElement('span');
          badge.className = 'badge on';
          badge.textContent = 'por defecto';
          span.append(' ', badge);
        }
        return span;
      },
    },
    {
      id: 'kind',
      label: 'Tipo',
      sortType: 'text',
      getValue: (entry) => (entry.bank.kind === 'FBCh' ? 'FBCh (opaco)' : 'FxBk'),
      cellTitle: (entry) =>
        entry.bank.kind === 'FBCh'
          ? [
            `Banco CcnK/FBCh con chunk opaco`,
            `versión del formato ${entry.bank.version}`,
            `chunk de ${entry.bank.chunkSize ?? 0} bytes`,
            entry.bank.version >= 2 && entry.bank.currentProgram !== null
              ? `programa activo ${entry.bank.currentProgram}`
              : undefined,
            `numPrograms informativo: ${entry.bank.numPrograms}`,
          ]
            .filter((part) => part !== undefined)
            .join('\n')
          : [
            `Banco CcnK/FxBk con programas`,
            `orden de bytes ${
              entry.bank.endianness === 'little'
                ? 'little-endian (legacy de Windows)'
                : 'big-endian (estándar VST2)'
            }`,
            `versión del formato ${entry.bank.version}`,
            `${entry.bank.numPrograms} programa(s)`,
          ].join('\n'),
    },
    {
      id: 'programs',
      label: 'Programas',
      sortType: 'number',
      getValue: (entry) => entry.bank.numPrograms,
      renderCell: (entry) =>
        entry.bank.kind === 'FBCh' ? `${entry.bank.numPrograms} (informativo)` : String(entry.bank.numPrograms),
    },
    {
      id: 'chunk',
      label: 'Chunk',
      sortType: 'number',
      getValue: (entry) => entry.bank.chunkSize ?? 0,
      renderCell: (entry) => (entry.bank.chunkSize !== null ? formatBytes(entry.bank.chunkSize) : '—'),
    },
    {
      id: 'uniqueId',
      label: 'uniqueID',
      sortType: 'text',
      getValue: (entry) => entry.bank.uniqueId,
    },
    {
      id: 'fxVersion',
      label: 'fxVersion',
      sortType: 'number',
      getValue: (entry) => entry.bank.fxVersion,
    },
    {
      id: 'size',
      label: 'Tamaño',
      sortType: 'number',
      getValue: (entry) => entry.size,
      renderCell: (entry) => formatBytes(entry.size),
    },
    {
      id: 'actions',
      label: '',
      sortable: false,
      searchable: false,
      cellClass: 'actions',
      getValue: () => '',
      renderNode: (entry) => {
        const use = document.createElement('button');
        use.type = 'button';
        use.textContent = 'Usar';
        use.prepend(createIcon('check'));
        const current = banks?.data.config.config.defaultFxbName;
        if (entry.fileName === current) use.dataset['default'] = 'true';
        use.title = `Elegir ${entry.fileName} como banco por defecto`;
        use.addEventListener('click', () => {
          els.defaultBank.value = entry.fileName;
          void saveDefault(entry.fileName);
        });
        return use;
      },
    },
  ],
  getRowId: (entry) => entry.fileName,
  initialSort: { columnId: 'fileName', direction: 'asc' },
  pageSize: 100,
  searchColumns: ['fileName', 'kind', 'uniqueId'],
  tbodyId: 'banks-rows',
  rowClass: (entry) => {
    const current = banks?.data.config.config.defaultFxbName;
    return entry.fileName === current ? 'is-default' : undefined;
  },
  emptyText: 'La carpeta de bancos está vacía; importa un .fxb.',
};

function renderBankRows(data: LibraryBanksListResponse): void {
  const emptyMessage = data.presetsDirExists
    ? 'La carpeta de bancos está vacía; importa un .fxb.'
    : 'La carpeta de bancos aún no existe; se crea al importar un .fxb.';
  banksTableView.emptyText = emptyMessage;

  if (banksTableController === null) {
    banksTableController = mountTable(els.banksTable, banksTableView, data.banks);
  } else {
    banksTableController.setRows(data.banks);
  }
}

function renderDefaultOptions(data: LibraryBanksListResponse, keepSelection: boolean): void {
  const previous = keepSelection ? els.defaultBank.value : null;
  const current = data.config.config.defaultFxbName;
  const names = data.banks.map((entry) => entry.fileName);

  els.defaultBank.replaceChildren();

  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— Ninguno —';
  els.defaultBank.append(none);

  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    els.defaultBank.append(option);
  }

  // El banco configurado puede haber desaparecido de la carpeta: no lo perdemos.
  if (current !== '' && !names.includes(current)) {
    const missing = document.createElement('option');
    missing.value = current;
    missing.textContent = `${current} (no está en la carpeta)`;
    els.defaultBank.append(missing);
  }

  els.defaultBank.value =
    previous !== null && (previous === '' || names.includes(previous) || previous === current)
      ? previous
      : current;

  els.loadFxb.checked = data.config.config.loadFxbBank;
}

/**
 * Opciones del selector de exportación: los bancos ya importados. Sin
 * ninguno, deja el botón deshabilitado hasta que exista un `.fxb`.
 */
function renderExportOptions(data: LibraryBanksListResponse, keepSelection: boolean): void {
  const previous = keepSelection ? els.exportBank.value : '';
  const names = data.banks.map((entry) => entry.fileName);

  els.exportBank.replaceChildren();
  if (names.length === 0) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '— Sin bancos en la carpeta —';
    els.exportBank.append(empty);
    return;
  }

  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    els.exportBank.append(option);
  }

  els.exportBank.value = names.includes(previous) ? previous : names[0]!;
}

function renderBanks(options: { keepSelection?: boolean } = {}): void {
  const keepSelection = options.keepSelection === true;
  if (banks === null) return;

  const { pluginName, data } = banks;
  els.banksTitle.textContent = pluginName;
  els.banksPresets.textContent = data.presetsDir;
  els.banksExists.textContent = data.presetsDirExists
    ? ''
    : '(aún no existe: se crea al importar)';

  renderDefaultOptions(data, keepSelection);
  renderExportOptions(data, keepSelection);
  renderBankRows(data);
  syncBanksBadge(pluginName, data.banks.map((entry) => entry.fileName));

  const backup = data.defaultBackup;
  const defaultName = data.config.config.defaultFxbName.trim();
  els.defaultRestore.title =
    backup === null
      ? 'No hay respaldo .orig del banco por defecto: solo se puede restaurar un banco convertido antes'
      : `Devuelve ${defaultName} al contenido de ${backup.fileName} (${formatBytes(backup.size)}); ` +
        'el respaldo se conserva';
  els.defaultDiscard.title =
    backup === null
      ? 'No hay respaldo .orig que descartar: solo existe si el banco se convirtió antes'
      : `Envía ${backup.fileName} (${formatBytes(backup.size)}) a la papelera; ` +
        `${defaultName} queda como está y podrás recuperarlo`;

  syncBanksDisabled();
}

async function fetchBanks(
  pluginName: string,
  options: { keepSelection?: boolean } = {},
): Promise<LibraryBanksListResponse> {
  const data = await client.library.listBanks({ libraryRoot, plugin: pluginName });
  banks = { pluginName, data };
  renderBanks(options);
  return data;
}

async function openBanks(plugin: ScanPlugin, opener?: HTMLElement): Promise<void> {
  if (banksBusy) return;

  closeMeta();
  closeWizards();
  closePluginWizard();
  closeLogDrawer();
  closeImportPackageDrawer();
  closeCustomPluginDrawer();
  closeAuditDrawer();
  showPanel(els.banks, opener);
  clearBanksView(plugin.name);
  setBanksBusy(true);
  setBanksStatus('Leyendo los bancos…', 'busy');

  try {
    await fetchBanks(plugin.name);
    setBanksStatus(
      plugin.hasLoader
        ? ''
        : 'El plugin no tiene cargador: puedes importar bancos, pero no fijar el banco por defecto hasta ponérselo.',
      plugin.hasLoader ? 'info' : 'busy',
    );
  } catch (error) {
    banks = null;
    clearBanksView(plugin.name);
    setBanksStatus(describeError(error), 'error');
  } finally {
    setBanksBusy(false);
  }
}

async function saveDefault(fileName: string): Promise<void> {
  if (banks === null || banksBusy) return;

  const { pluginName, data } = banks;
  setBanksBusy(true);
  setBanksStatus('Guardando el banco por defecto…', 'busy');

  try {
    const snapshot: ConfigSnapshot = await client.config.write({
      pluginDir: data.plugin.path,
      expectedMtimeMs: data.config.mtimeMs,
      config: { defaultFxbName: fileName, loadFxbBank: els.loadFxb.checked },
    });
    data.config = snapshot;
    renderBanks();
    setBanksStatus(
      fileName === ''
        ? 'Sin banco por defecto.'
        : `Banco por defecto de ${pluginName}: ${fileName}.`,
      'ok',
    );
  } catch (error) {
    const conflict = isFxbApiError(error) && error.status === 409 ? error.body : null;
    const current = (conflict as { current?: ConfigSnapshot } | null)?.current;
    if (current !== undefined) {
      data.config = current;
      renderBanks();
      setBanksStatus(
        `${describeError(error)} Puede que la DLL la reescribiera; revisa los valores ` +
          'actualizados y vuelve a guardar.',
        'error',
      );
    } else {
      setBanksStatus(describeError(error), 'error');
    }
  } finally {
    setBanksBusy(false);
  }
}

/**
 * Convierte en el sitio el banco por defecto (`defaultFxbName`) invirtiendo su
 * orden de bytes. El servidor deja el original como `<banco>.orig`, así que la
 * vista solo refresca la lista: el nombre y la selección no cambian.
 */
async function convertDefaultBank(): Promise<void> {
  if (banks === null || banksBusy) return;

  const { pluginName, data } = banks;
  const fileName = data.config.config.defaultFxbName.trim();
  if (fileName === '') {
    setBanksStatus('No hay un banco por defecto configurado para convertir.', 'error');
    return;
  }
  if (
    !window.confirm(
      `Se reescribirá ${fileName} con el orden de bytes contrario. ` +
        `El original se conserva como ${fileName}.orig. ¿Continuar?`,
    )
  ) {
    return;
  }

  setBanksBusy(true);
  setBanksStatus(`Convirtiendo ${fileName} en el sitio…`, 'busy');

  try {
    const result = await client.library.convertDefaultBank({ libraryRoot, plugin: pluginName });
    await fetchBanks(pluginName, { keepSelection: true });

    const order = result.target.bank.endianness === 'little' ? 'little-endian' : 'big-endian';
    if (!result.changed) {
      setBanksStatus(`${result.fileName} ya estaba en ${order}; no había nada que convertir.`, 'ok');
      return;
    }

    const backup = result.backup === null ? '' : ` y el original en ${result.backup.fileName}`;
    setBanksStatus(
      `${result.fileName}: ${result.fields} campo(s) a ${order}${backup}` +
        `${result.backupCreated ? '.' : ' (respaldo anterior).'}`,
      'ok',
    );
  } catch (error) {
    setBanksStatus(describeError(error), 'error');
  } finally {
    setBanksBusy(false);
  }
}

/**
 * Devuelve el banco por defecto al contenido de su respaldo `.orig`.
 *
 * El respaldo solo se lee: no se renombra ni se reescribe, así que la
 * restauración se puede repetir. Se pide confirmación porque sustituye el
 * banco que la DLL carga al abrir el plugin.
 */
async function restoreDefaultBank(): Promise<void> {
  if (banks === null || banksBusy) return;

  const { pluginName, data } = banks;
  const fileName = data.config.config.defaultFxbName.trim();
  const backup = data.defaultBackup;
  if (fileName === '' || backup === null) {
    setBanksStatus(
      'No hay respaldo .orig del banco por defecto; convierte el banco antes de restaurarlo.',
      'error',
    );
    return;
  }
  if (
    !window.confirm(
      `Se reemplazará ${fileName} con el contenido de ${backup.fileName}. ` +
        `El respaldo se conserva y no se toca. ¿Continuar?`,
    )
  ) {
    return;
  }

  setBanksBusy(true);
  setBanksStatus(`Restaurando ${fileName} desde ${backup.fileName}…`, 'busy');

  try {
    const result = await client.library.restoreDefaultBank({ libraryRoot, plugin: pluginName });
    await fetchBanks(pluginName, { keepSelection: true });

    setBanksStatus(
      result.changed
        ? `${result.fileName} restaurado desde ${result.backup.fileName}; el respaldo sigue intacto.`
        : `${result.fileName} ya era el respaldo; no había nada que restaurar.`,
      'ok',
    );
  } catch (error) {
    setBanksStatus(describeError(error), 'error');
  } finally {
    setBanksBusy(false);
  }
}

/**
 * Envía a la papelera el respaldo `.orig` del banco por defecto.
 *
 * El banco que carga la DLL se queda como está y el respaldo sale de la
 * carpeta del plugin, pero no se destruye: queda en la Papelera de reciclaje y
 * se puede recuperar. Se pide confirmación nombrando el archivo y su tamaño.
 */
async function discardDefaultBackup(): Promise<void> {
  if (banks === null || banksBusy) return;

  const { pluginName, data } = banks;
  const backup = data.defaultBackup;
  if (backup === null) {
    setBanksStatus('No hay respaldo .orig del banco por defecto que descartar.', 'error');
    return;
  }
  if (
    !window.confirm(
      `Se enviará ${backup.fileName} (${formatBytes(backup.size)}) a la papelera del sistema. ` +
        'El banco por defecto no cambia: el respaldo sale de su carpeta, pero podrás ' +
        'recuperarlo desde la papelera. ¿Enviarlo a la papelera?',
    )
  ) {
    return;
  }

  setBanksBusy(true);
  setBanksStatus(`Enviando ${backup.fileName} a la papelera…`, 'busy');

  try {
    const result = await client.library.discardDefaultBankBackup({
      libraryRoot,
      plugin: pluginName,
    });
    await fetchBanks(pluginName, { keepSelection: true });
    setBanksStatus(
      `${result.discarded.fileName} enviado a la ${result.trash.label} ` +
        `(${formatBytes(result.discarded.size)}). ${result.fileName} queda como está, sin ` +
        `respaldo. ${result.trash.hint}`,
      'ok',
    );
  } catch (error) {
    setBanksStatus(describeError(error), 'error');
  } finally {
    setBanksBusy(false);
  }
}

function readImportPaths(): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const line of els.importPaths.value.split('\n')) {
    let value = line.trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    paths.push(value);
  }
  return paths;
}

function renderImportResults(results: ImportResults): void {
  els.importResults.replaceChildren();

  for (const result of results) {
    const item = document.createElement('li');
    item.className = 'import-result';
    item.classList.add(result.status);

    const name = document.createElement('strong');
    name.textContent = result.fileName;
    item.append(name);

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent =
      result.status === 'imported'
        ? 'importado'
        : result.status === 'overwritten'
          ? 'sobrescrito'
          : 'rechazado';
    if (result.status !== 'rejected') badge.classList.add('on');
    item.append(' ', badge);

    const compatibility = document.createElement('span');
    compatibility.className = 'note';
    compatibility.textContent =
      result.compatibility === 'compatible'
        ? 'compatible'
        : result.compatibility === 'incompatible'
          ? 'incompatible'
          : 'sin verificar';
    item.append(' · ', compatibility);

    const issues = result.issues ?? [];
    const detail = result.reason ?? (issues.length > 0 ? issues.join('; ') : null);
    if (detail) {
      const text = document.createElement('p');
      text.className = 'import-detail';
      text.textContent = detail;
      item.append(text);
    }

    els.importResults.append(item);
  }
}

/**
 * Importa los bancos del cuadro de texto. El servidor manda NDJSON y la vista
 * recibe el resultado de cada banco en cuanto se procesa: la barra avanza banco
 * a banco, también dentro del último trozo. Por encima de
 * `MAX_BANKS_PER_REQUEST` la lista se manda en peticiones consecutivas y el
 * resultado de todas se acumula en una sola lista, que no se pierde si un trozo
 * posterior falla. El botón Cancelar corta el flujo NDJSON: lo ya confirmado se
 * conserva.
 */
async function importBanks(): Promise<void> {
  if (banks === null || banksBusy) return;

  const sourcePaths = readImportPaths();
  if (sourcePaths.length === 0) {
    setBanksStatus('Escribe al menos una ruta absoluta de un .fxb.', 'error');
    els.importPaths.focus();
    return;
  }

  const { pluginName } = banks;
  rememberBanks(sourcePaths);
  setBanksBusy(true);
  setBanksStatus(`Importando ${sourcePaths.length} archivo(s)…`, 'busy');
  els.importResults.replaceChildren();
  showImportProgress({ done: 0, total: sourcePaths.length, requests: 0 });
  els.importCancel.hidden = false;
  els.importCancel.disabled = false;

  const controller = new AbortController();
  importController = controller;

  try {
    const run = await runImportInChunks<ImportResults[number]>({
      paths: sourcePaths,
      send: async (paths, onResult) => {
        await client.library.importBanksStream(
          {
            libraryRoot,
            plugin: pluginName,
            sourcePaths: paths,
            overwrite: els.importOverwrite.checked,
          },
          {
            onEvent: (event) => {
              if (event.type === 'bank') onResult(event.result);
            },
            signal: controller.signal,
          },
        );
        // Los resultados ya se entregaron uno a uno por el flujo.
        return [];
      },
      onResults: (results, progress) => {
        renderImportResults([...results]);
        showImportProgress(progress);
        if (progress.done < progress.total) {
          setBanksStatus(importProgressLabel(progress), 'busy');
        }
      },
    });

    renderImportResults(run.results);
    const imported = run.results.filter((item) => item.status !== 'rejected').length;
    const rejected = run.results.length - imported;

    await fetchBanks(pluginName, { keepSelection: true });

    if (run.error !== null && !(run.error instanceof Error && run.error.message === 'Cancelado por el usuario')) {
      setBanksStatus(
        `La importación se cortó tras ${run.results.length} de ${sourcePaths.length} archivo(s): ` +
          `${describeError(run.error)} ${imported} importado(s), ${rejected} rechazado(s).`,
        'error',
      );
      return;
    }

    if (run.error instanceof Error && run.error.message === 'Cancelado por el usuario') {
      setBanksStatus(
        `Importación cancelada: ${run.results.length} archivo(s) importados, ${sourcePaths.length - run.results.length} pendiente(s).`,
        'info',
      );
      return;
    }

    setBanksStatus(
      rejected === 0
        ? `${imported} banco(s) importados.`
        : `${imported} importado(s), ${rejected} rechazado(s).`,
      rejected === 0 ? 'ok' : 'error',
    );
  } catch (error) {
    // Falló el refresco de la lista o algo anterior al primer trozo.
    if (!(error instanceof Error && error.message === 'Cancelado por el usuario')) {
      setBanksStatus(describeError(error), 'error');
    }
  } finally {
    hideImportProgress();
    importController = null;
    els.importCancel.hidden = true;
    setBanksBusy(false);
  }
}

/**
 * Exporta el banco elegido en el orden pedido. El servidor escribe un archivo
 * nuevo (`-le`/`-be`) y revuelve el origen intacto, así que la vista solo
 * refresca la lista para que aparezca el convertido.
 */
async function exportBank(): Promise<void> {
  if (banks === null || banksBusy) return;

  const fileName = els.exportBank.value;
  const endianness = els.exportOrder.value as ExportOrder;
  if (fileName === '') {
    setBanksStatus('No hay ningún banco en la carpeta del plugin para exportar.', 'error');
    return;
  }

  const { pluginName } = banks;
  const order = endianness === 'little' ? 'little-endian' : 'big-endian';
  setBanksBusy(true);
  setBanksStatus(`Exportando ${fileName} a ${order}…`, 'busy');

  try {
    const result = await client.library.exportBank({
      libraryRoot,
      plugin: pluginName,
      fileName,
      endianness,
      overwrite: els.exportOverwrite.checked,
    });

    await fetchBanks(pluginName, { keepSelection: true });
    setBanksStatus(
      result.changed
        ? `${result.target.fileName}: ${result.fields} campo(s) en ${order}` +
            `${result.chunks === 0 ? '' : ` y ${result.chunks} chunk(s)`}.`
        : `${result.source.fileName} ya estaba en ${order}; no había nada que convertir.`,
      'ok',
    );
  } catch (error) {
    setBanksStatus(describeError(error), 'error');
  } finally {
    setBanksBusy(false);
  }
}

/**
 * La creación de bancos cambia de payload según el modo: los dos bloques de
 * campos se muestran y ocultan al vuelo y el selector little/big aplica a los
 * dos modos, igual que en el endpoint.
 */
function syncCreateMode(): void {
  const chunk = els.createMode.value === 'chunk';
  els.createProgramRows.hidden = chunk;
  els.createChunkRows.hidden = !chunk;
}

/**
 * Crea un banco `.fxb` desde cero con el contenido del formulario: modo
 * `programNames` (un `FxBk` con los nombres dados) o modo `chunk` (un `FBCh`
 * con el chunk opaco en hexadecimal). `endianness` se manda tal cual la elige
 * el selector de orden de bytes, común a los dos modos; el `uniqueID` lo toma
 * el servidor de `vfxinfo.txt`. Tras crear, se refresca el listado para que el
 * banco nuevo aparezca con su tipo.
 */
async function createBank(): Promise<void> {
  if (banks === null || banksBusy) return;

  const { pluginName } = banks;
  const body: RequestBody<'/library/banks/create', 'post'> = {
    libraryRoot,
    plugin: pluginName,
    endianness: els.createOrder.value as 'big' | 'little',
    overwrite: els.createOverwrite.checked,
  };

  const fileName = els.createBankName.value.trim();
  if (fileName !== '') body.bankName = fileName;

  const fxVersion = parseInt(els.createFxVersion.value, 10);
  if (Number.isInteger(fxVersion)) body.fxVersion = fxVersion;

  if (els.createMode.value === 'chunk') {
    const chunkHex = els.createChunkHex.value.trim();
    if (chunkHex === '') {
      setBanksStatus('Escribe el contenido del chunk en hexadecimal para crear un banco FBCh.', 'error');
      return;
    }
    body.mode = 'chunk';
    body.chunkHex = chunkHex;
    const chunkVersion = parseInt(els.createChunkVersion.value, 10);
    if (chunkVersion === 1 || chunkVersion === 2) body.chunkVersion = chunkVersion;
    if (chunkVersion === 2) {
      const currentProgram = parseInt(els.createCurrentProgram.value, 10);
      if (Number.isInteger(currentProgram)) body.currentProgram = currentProgram;
    }
    const chunkNumPrograms = parseInt(els.createChunkPrograms.value, 10);
    if (Number.isInteger(chunkNumPrograms)) body.chunkNumPrograms = chunkNumPrograms;
  } else {
    const names = els.createProgramNames.value
      .split('\n')
      .map((name) => name.trim())
      .filter((name) => name !== '');
    if (names.length === 0) {
      setBanksStatus('Escribe al menos un nombre de programa para crear un banco FxBk.', 'error');
      return;
    }
    body.programNames = names;
    const numParams = parseInt(els.createNumParams.value, 10);
    if (Number.isInteger(numParams) && numParams >= 0) body.numParams = numParams;
  }

  setBanksBusy(true);
  const kind = body.mode === 'chunk' ? 'FBCh' : 'FxBk';
  const order = body.endianness === 'big' ? 'big-endian' : 'little-endian';
  setBanksStatus(
    `Creando ${body.bankName ?? '<plugin>.fxb'} (${kind}) en ${order}…`,
    'busy',
  );

  try {
    const result = await client.library.createBank(body);
    await fetchBanks(pluginName, { keepSelection: true });
    setBanksStatus(
      `Banco ${result.bank.kind} creado en ${result.target}.`,
      'ok',
    );
  } catch (error) {
    setBanksStatus(describeError(error), 'error');
  } finally {
    setBanksBusy(false);
  }
}

function setMetaStatus(message: string, kind = 'info'): void {
  els.metaStatus.textContent = message;
  els.metaStatus.className = message === '' ? 'status' : `status ${kind}`;
}

/** Guardar y descartar solo viven con un catálogo cargado y sin operación en curso. */
function syncMetaDisabled(): void {
  const disabled = metaBusy || metaState === null;
  els.metaSave.disabled = disabled;
  els.metaReload.disabled = disabled;
  els.metaWizardApply.disabled = disabled;
}

function setMetaBusy(value: boolean): void {
  metaBusy = value;
  syncMetaDisabled();
}

function clearMetaView(pluginName: string): void {
  els.metaPlugin.textContent = pluginName;
  els.metaPath.textContent = '';
  els.metaExists.textContent = '';
  els.metaOrigin.textContent = '';
  els.metaId.value = '';
  els.metaName.value = '';
  els.metaVendor.value = '';
  els.metaVendorUrl.value = '';
  els.metaGenre.value = '';
  els.metaAbbreviation.value = '';
  els.metaCreated.value = '';
  els.metaNotes.value = '';
  els.metaExtended.value = '';
  resetDllPreference();
  els.metaWizardBanner.hidden = true;
  els.metaWizardTitle.textContent = '';
  matchedWizard = null;
}

function metaOriginText(snapshot: PluginMetaSnapshotResponse): string {
  if (snapshot.exists) return '';

  const missing = [
    snapshot.common.id === '' ? 'id' : null,
    snapshot.common.name === '' ? 'nombre' : null,
  ].filter((field): field is string => field !== null);

  if (missing.length === 0) {
    return 'Id y nombre tomados de vfxinfo.txt; al guardar se crea fxbLoader.meta.json.';
  }
  if (snapshot.source?.vfxinfo === true) {
    return `vfxinfo.txt no trae ${missing.join(' ni ')}; el catálogo necesita id y nombre.`;
  }
  return 'Sin datos de vfxinfo.txt: escribe el id y el nombre para poder guardar el catálogo.';
}

function renderMeta(snapshot: PluginMetaSnapshotResponse): void {
  els.metaPath.textContent = snapshot.metaPath;
  els.metaExists.textContent = snapshot.exists ? '' : '(aún no existe: se crea al guardar)';
  els.metaOrigin.textContent = metaOriginText(snapshot);
  els.metaId.value = snapshot.common.id;
  els.metaName.value = snapshot.common.name;
  els.metaVendor.value = snapshot.common.vendor;
  els.metaVendorUrl.value = snapshot.common.vendor_url;
  els.metaGenre.value = snapshot.common.genre;
  els.metaAbbreviation.value = snapshot.common.name_abbreviation;
  els.metaCreated.value = snapshot.common.created;
  els.metaNotes.value = snapshot.common.notes;
  els.metaExtended.value = JSON.stringify(snapshot.extended, null, 2);
  syncMetaDisabled();
}

function closeMeta(): void {
  if (els.meta.hidden) return;
  hidePanel(els.meta);
  metaState = null;
  matchedWizard = null;
  els.metaWizardBanner.hidden = true;
  setMetaStatus('');
  syncMetaDisabled();
}

/* ------------------------------------------------------------------ */
/* Preferencia local de DLL por plugin                                */
/* ------------------------------------------------------------------ */

/** Valor guardado en `vfxinfo.txt` del plugin cargado; `''` si no declara. */
let dllPrefSaved: string | null = null;
/** Borrador sin guardar; sobrevive al cierre del panel del catálogo. */
let dllPrefDraft: string | null = null;
/** Plugin al que la preferencia abierta corresponde. */
let dllPrefPluginName: string | null = null;
let dllPrefBusy = false;

/** Deja la sección sin plugin, sin borrador y sin textos. */
function resetDllPreference(): void {
  dllPrefSaved = null;
  dllPrefPluginName = null;
  els.metaDll.value = dllPrefDraft ?? '';
  els.metaDllSave.disabled = true;
  els.metaDllCancel.disabled = true;
  els.metaDllNote.textContent = dllPrefDraft === null ? '' : 'Borrador sin guardar.';
  els.metaDllActions.classList.toggle('draft', dllPrefDraft !== null);
}

/** Rellena la preferencia tras leer el catálogo del plugin. */
function renderDllPreference(plugin: ScanPlugin, dir: string): void {
  if (dllPrefDraft !== null && dllPrefPluginName !== plugin.name) {
    // Borrador de otro plugin: no puede sobrevivir a un cambio de plugin.
    dllPrefDraft = null;
  }
  dllPrefSaved = plugin.pluginName ?? '';
  dllPrefPluginName = plugin.name;
  void dir;
  els.metaDll.value = dllPrefDraft ?? dllPrefSaved;
  updateDllPreferenceNote();
}

function dllPreferenceInput(): string {
  return els.metaDll.value.trim();
}

function dllPreferenceDirty(): boolean {
  return dllPrefSaved !== null && dllPreferenceInput() !== dllPrefSaved;
}

/** Texto de la nota y estado de los botones según haya o no borrador. */
function updateDllPreferenceNote(): void {
  if (dllPrefSaved === null) return;

  const dirty = dllPreferenceDirty();
  els.metaDllActions.classList.toggle('draft', dirty);
  els.metaDllCancel.disabled = !dirty || dllPrefBusy;
  els.metaDllSave.disabled = !dirty || dllPrefBusy;

  const current = dllPreferenceInput();
  if (current === '') {
    els.metaDllNote.textContent = dirty
      ? 'Borrador sin guardar: un valor vacío no es válida preferencia.'
      : 'vfxinfo.txt no declara dll_name. Indica la DLL del plugin y guarda la preferencia.';
    return;
  }
  if (dirty) {
    els.metaDllNote.textContent = 'Borrador sin guardar del valor mostrado.';
    return;
  }
  els.metaDllNote.textContent = `Preferencia guardada en vfxinfo.txt: ${dllPrefSaved}`;
}

/** Cancelar restaura el valor guardado y descarta el borrador en memoria. */
function cancelDllPreferenceDraft(): void {
  if (dllPrefSaved === null) return;
  dllPrefDraft = null;
  els.metaDll.value = dllPrefSaved;
  updateDllPreferenceNote();
  setMetaStatus('Preferencia de DLL restablecida al valor guardado.');
}

async function saveDllPreference(): Promise<void> {
  if (metaState === null || dllPrefBusy || !dllPreferenceDirty()) return;

  const value = dllPreferenceInput();
  const { plugin, dir } = metaState;
  dllPrefBusy = true;
  updateDllPreferenceNote();
  setMetaStatus('Guardando la preferencia de DLL…', 'busy');

  try {
    const result = await client.library.updateDllPreference({
      pluginDir: dir,
      dllName: value,
    });
    dllPrefSaved = value;
    dllPrefDraft = null;
    dllPrefPluginName = plugin.name;
    els.metaDll.value = value;
    // El pluginName del escaneo apunta a la DLL del vfxinfo: se alinea con el
    // valor guardado para que «Catálogo» y la tabla digan lo mismo.
    plugin.pluginName = value.includes('/') || value.includes('\\')
      ? (value.split(/[\\/]/).pop() ?? value)
      : value;
    updateDllPreferenceNote();
    if (result.changed) {
      setMetaStatus(`Preferencia de DLL guardada: ${result.dllName}`, 'ok');
    } else {
      setMetaStatus(`La preferencia de DLL ya era "${result.dllName}".`);
    }
  } catch (error) {
    setMetaStatus(describeError(error), 'error');
  } finally {
    dllPrefBusy = false;
    updateDllPreferenceNote();
  }
}

/**
 * Aviso de borrador al abrir el importador: no guarda nada desde aquí;
 * «Continuar sin cambios» descarta el borrador y «Cancelar» lo conserva.
 */
let pendingImportOpener: HTMLElement | null = null;

function dllPreferenceHasDraft(): boolean {
  return dllPrefDraft !== null && dllPrefDraft !== dllPrefSaved;
}

function continueWithoutChanges(): void {
  const opener = pendingImportOpener;
  pendingImportOpener = null;
  dllPrefDraft = null;
  els.metaDll.value = dllPrefSaved ?? '';
  updateDllPreferenceNote();
  els.dialogDllDraft.close();
  requestOpenImportPackageDrawer(opener ?? undefined);
}

function declareDraftImportCancelled(): void {
  pendingImportOpener = null;
  els.dialogDllDraft.close();
}

/** Abre el importador; con borrador activo pregunta antes de continuar. */
function requestOpenImportPackageDrawer(opener?: HTMLElement): void {
  if (dllPreferenceHasDraft()) {
    const pluginName = dllPrefPluginName ?? 'el plugin';
    els.dialogDllDraftText.textContent =
      `El catálogo de ${pluginName} tiene una preferencia de DLL modificada que todavía no está guardada. ` +
      '«Continuar sin cambios» la descarta y usa la preferencia guardada; «Cancelar» conserva el borrador. ' +
      'Desde aquí no se guarda: vuelve al catálogo y usa Guardar preferencia.';
    pendingImportOpener = opener ?? null;
    els.dialogDllDraft.showModal();
    return;
  }
  openImportPackageDrawer(opener);
}

/**
 * El log trae marcas de tiempo ISO que nadie lee de corrido: se pasan a la hora
 * local y, si el archivo trae algo raro, se deja el texto tal cual.
 */
function logTimestamp(timestamp: string): string {
  if (timestamp === '') return '';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

const pluginHistoryTableView: TableView<PluginLogSnapshotResponse['entries'][number]> = {
  columns: [
    { id: 'timestamp', label: 'Fecha', getValue: entry => entry.timestamp, sortType: 'date', cellClass: 'table-date', cellTitle: entry => entry.raw, renderCell: entry => logTimestamp(entry.timestamp) || '—' },
    { id: 'action', label: 'Acción', getValue: entry => entry.action, sortType: 'text', cellClass: 'table-action', cellTitle: entry => entry.raw },
    { id: 'summary', label: 'Resumen', getValue: entry => entry.summary, sortType: 'text', cellTitle: entry => entry.raw },
    { id: 'detail', label: 'Detalle', getValue: entry => entry.detail ?? '', sortType: 'text', cellTitle: entry => entry.raw },
  ],
  getRowId: entry => `${entry.timestamp}-${entry.action}-${entry.raw}`,
  initialSort: { columnId: 'timestamp', direction: 'desc' },
  pageSize: 100,
  searchColumns: ['timestamp', 'action', 'summary', 'detail'],
  filters: [
    { id: 'actions', label: 'Acción', columnId: 'action', type: 'multi-select' },
    { id: 'period', label: 'Fecha', columnId: 'timestamp', type: 'date-range' },
  ],
  emptyText: 'No hay entradas que coincidan con la búsqueda.',
  rowActions: {
    actions: [{ id: 'view-record', label: 'Ver registro', icon: 'file', onSelect: (entry, trigger) => openLogRecordDetail(entry, trigger) }],
  },
};

/**
 * Historial del plugin: la ruta del archivo, cuánto ocupa, sus entradas y los
 * rotados que dejó la rotación por tamaño.
 */
function renderLogDetailField(label: string, value: string, className = ''): HTMLElement {
  const field = document.createElement('div');
  field.className = 'log-record-field';
  const title = document.createElement('dt');
  title.textContent = label;
  const data = document.createElement('dd');
  if (className) data.className = className;
  data.textContent = value === '' ? '—' : value;
  field.append(title, data);
  return field;
}

function openLogRecordDetail(
  entry: PluginLogSnapshotResponse['entries'][number],
  trigger: HTMLButtonElement,
): void {
  logDetailOpener = trigger;
  els.logDetailTitle.textContent = `Registro · ${entry.action || 'sin acción'}`;
  const timestamp = logTimestamp(entry.timestamp) || entry.timestamp || '—';
  els.logDetailFields.replaceChildren(
    renderLogDetailField('Fecha y hora', timestamp),
    renderLogDetailField('Acción', entry.action),
    renderLogDetailField('Resumen', entry.summary),
    renderLogDetailField('Detalle', entry.detail ?? ''),
    renderLogDetailField('Línea original', entry.raw, 'log-record-raw'),
  );
  els.logDetail.hidden = false;
  els.logDetailClose.focus({ preventScroll: true });
}

function closeLogRecordDetail(): void {
  if (els.logDetail.hidden) return;
  els.logDetail.hidden = true;
  els.logDetailFields.replaceChildren();
  const opener = logDetailOpener;
  logDetailOpener = null;
  if (opener?.isConnected && opener.getClientRects().length > 0) {
    opener.focus({ preventScroll: true });
  }
}

function renderPluginLog(snapshot: PluginLogSnapshotResponse): void {
  if (els.logDetail.hidden === false && logDetailOpener?.isConnected !== true) closeLogRecordDetail();
  els.logPath.textContent = snapshot.logPath;
  els.logExists.textContent = snapshot.exists ? '' : '(todavía no existe)';
  els.logSummary.textContent = `${snapshot.totalEntries} entrada(s) · ${formatBytes(
    snapshot.size,
  )} en el archivo activo`;
  els.logRotated.textContent =
    snapshot.rotatedFiles.length === 0
      ? 'Sin archivos rotados.'
      : `Rotados (${snapshot.rotatedFiles.length}): ${snapshot.rotatedFiles.join(', ')}`;

  if (snapshot.entries.length === 0) {
    logTableController?.destroy();
    logTableController = null;
    els.logTable.replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'table-empty';
    empty.textContent = snapshot.exists ? 'El log no tiene entradas legibles.' : 'El plugin todavía no ha escrito nada en su log.';
    els.logTable.append(empty);
    return;
  }
  if (logTableController === null) {
    logTableController = mountTable(els.logTable, pluginHistoryTableView, snapshot.entries);
  } else {
    logTableController.setRows(snapshot.entries);
  }
}

async function readPluginLog(pluginName: string, dir: string): Promise<void> {
  try {
    renderPluginLog(await client.plugins.log.read({ id: pluginName, dir }));
    els.logStatus.textContent = '';
    els.logStatus.className = 'status';
  } catch (error) {
    els.logPath.textContent = '';
    els.logExists.textContent = '';
    els.logSummary.textContent = `No se pudo leer el log: ${describeError(error)}`;
    logTableController?.destroy();
    logTableController = null;
    els.logTable.replaceChildren();
    els.logRotated.textContent = '';
    els.logStatus.textContent = describeError(error);
    els.logStatus.className = 'status error';
  }
}

async function openLogDrawer(plugin: ScanPlugin, opener?: HTMLElement): Promise<void> {
  closeBanks();
  closeMeta();
  closeWizards();
  closePluginWizard();
  closeImportPackageDrawer();
  closeCustomPluginDrawer();
  closeAuditDrawer();
  showPanel(els.logDrawer, opener);

  els.logPlugin.textContent = plugin.name;
  els.logPath.textContent = '';
  els.logExists.textContent = '';
  els.logSummary.textContent = 'Leyendo historial…';
  logTableController?.destroy();
  logTableController = null;
  els.logTable.replaceChildren();
  els.logRotated.textContent = '';
  els.logStatus.textContent = '';

  await readPluginLog(plugin.name, plugin.path);
}

function closeLogDrawer(): void {
  if (els.logDrawer.hidden) return;
  closeLogRecordDetail();
  hidePanel(els.logDrawer);
}

/** Lee el catálogo de `dir` y deja el panel listo para guardar con ese `mtimeMs`. */
async function readMeta(plugin: ScanPlugin): Promise<void> {
  setMetaBusy(true);
  setMetaStatus('Leyendo el catálogo…', 'busy');

  try {
    const snapshot = await client.plugins.meta.read({ id: plugin.name, dir: plugin.path });
    metaState = { pluginName: plugin.name, dir: plugin.path, plugin, snapshot };
    renderMeta(snapshot);
    renderDllPreference(plugin, plugin.path);

    await checkWizardMatch(plugin, snapshot);

    setMetaStatus('');
  } catch (error) {
    metaState = null;
    clearMetaView(plugin.name);
    setMetaStatus(describeError(error), 'error');
  } finally {
    setMetaBusy(false);
  }
}

async function openMeta(plugin: ScanPlugin, opener?: HTMLElement): Promise<void> {
  if (metaBusy) return;

  closeBanks();
  closeWizards();
  closePluginWizard();
  closeLogDrawer();
  closeImportPackageDrawer();
  closeCustomPluginDrawer();
  closeAuditDrawer();
  showPanel(els.meta, opener);
  metaState = null;
  clearMetaView(plugin.name);
  syncMetaDisabled();
  await readMeta(plugin);
}

async function reloadMeta(): Promise<void> {
  if (metaState === null) return;
  await readMeta(metaState.plugin);
}

/**
 * `extended` se edita como JSON porque el formato admite claves y anidamientos
 * libres; `null` devuelve `null` y el llamador distingue el error del objeto
 * vacío.
 */
function readExtended(): Record<string, unknown> | null {
  const text = els.metaExtended.value.trim();
  if (text === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    setMetaStatus('Los campos propios deben ser JSON válido.', 'error');
    els.metaExtended.focus();
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    setMetaStatus('Los campos propios deben ser un objeto JSON.', 'error');
    els.metaExtended.focus();
    return null;
  }

  return parsed as Record<string, unknown>;
}

async function saveMeta(): Promise<void> {
  if (metaState === null || metaBusy) return;

  const id = els.metaId.value.trim();
  const name = els.metaName.value.trim();
  if (id === '' || name === '') {
    setMetaStatus('El id y el nombre no pueden quedar vacíos.', 'error');
    (id === '' ? els.metaId : els.metaName).focus();
    return;
  }

  const extended = readExtended();
  if (extended === null) return;

  const { pluginName, dir, plugin, snapshot } = metaState;
  setMetaBusy(true);
  setMetaStatus('Guardando el catálogo…', 'busy');

  try {
    const written = await client.plugins.meta.write({
      id: pluginName,
      pluginDir: dir,
      expectedMtimeMs: snapshot.mtimeMs,
      common: {
        id,
        name,
        vendor: els.metaVendor.value,
        vendor_url: els.metaVendorUrl.value,
        genre: els.metaGenre.value,
        name_abbreviation: els.metaAbbreviation.value,
        notes: els.metaNotes.value,
        created: els.metaCreated.value,
      },
      extended,
    });
    metaState = { pluginName, dir, plugin, snapshot: written };
    renderMeta(written);
    markPluginHasMeta(dir);
    setMetaStatus('Catálogo guardado.', 'ok');
  } catch (error) {
    if (isFxbApiError(error) && error.status === 409) {
      // Otra escritura (otra pestaña o el propio plugin) adelantó el archivo:
      // se relee para no seguir guardando con un `mtimeMs` viejo. El texto
      // empieza por el mensaje del API y solo añade qué hacer ahora.
      await readMeta(plugin);
      setMetaStatus(
        `${describeError(error)} Se muestra el estado actual del disco; vuelve a guardar.`,
        'error',
      );
      return;
    }
    setMetaStatus(describeError(error), 'error');
  } finally {
    setMetaBusy(false);
  }
}

function markPluginHasMeta(dir: string): void {
  if (scanData === null) return;
  const entry = scanData.plugins.find((plugin) => plugin.path === dir);
  if (entry === undefined || entry.hasMeta) return;
  entry.hasMeta = true;
  render(scanData);
}

/* ------------------------------------------------------------------ */
/* Wizards y asistente VFX                                            */
/* ------------------------------------------------------------------ */

let matchedWizard: WizardMatchResponse | null = null;

async function checkWizardMatch(
  plugin: ScanPlugin,
  snapshot: PluginMetaSnapshotResponse,
): Promise<void> {
  els.metaWizardBanner.hidden = true;
  matchedWizard = null;
  try {
    const match = await client.wizards.match({
      id: snapshot.common.id || undefined,
      name: snapshot.common.name || plugin.name,
      dllName: plugin.pluginName || undefined,
    });
    if (match && metaState && metaState.dir === plugin.path) {
      matchedWizard = match;
      els.metaWizardTitle.textContent = `${match.name} · ${match.vendor || 'Desconocido'} (${match.genre || 'VST'}, ID: ${match.id})`;
      els.metaWizardBanner.hidden = false;
    }
  } catch {
    // Si no coincide o falla, se mantiene oculto.
  }
}

async function applyWizardToMeta(): Promise<void> {
  if (metaState === null || metaBusy) return;
  setMetaBusy(true);
  setMetaStatus('Aplicando metadatos del wizard…', 'busy');
  try {
    const updated = await client.wizards.applyMeta({
      pluginDir: metaState.dir,
      wizardId: matchedWizard?.id,
      overwriteNotes: false,
    });
    metaState.snapshot = updated;
    renderMeta(updated);
    markPluginHasMeta(metaState.dir);
    setMetaStatus('Metadatos del wizard aplicados correctamente al catálogo.', 'ok');
  } catch (error) {
    setMetaStatus(describeError(error), 'error');
  } finally {
    setMetaBusy(false);
  }
}

function closeWizards(): void {
  if (els.wizards.hidden) return;
  els.wizards.hidden = true;
  if (
    els.banks.hidden &&
    els.meta.hidden &&
    els.pluginWizard.hidden &&
    els.logDrawer.hidden
  ) {
    els.drawerBackdrop.hidden = true;
    document.body.classList.remove('drawer-open');
  }
}

async function openWizards(): Promise<void> {
  closeBanks();
  closeMeta();
  closePluginWizard();
  closeLogDrawer();
  closeImportPackageDrawer();
  closeCustomPluginDrawer();
  closeAuditDrawer();
  els.wizards.hidden = false;
  els.wizards.scrollTop = 0;
  els.drawerBackdrop.hidden = false;
  document.body.classList.add('drawer-open');
  els.wizardsFilter.value = '';
  wizardsQuery = '';
  await loadWizards('');
}

let wizardsLoading = false;

async function loadWizards(query: string): Promise<void> {
  if (wizardsLoading) return;
  wizardsLoading = true;
  els.wizardsStatus.textContent = 'Cargando wizards…';
  els.wizardsStatus.className = 'status busy';
  try {
    // El servidor ordena y filtra: `sort`/`dir` van de la mano del orden que el
    // usuario pulsó en la tabla. La paginación es en cliente, así que releemos
    // por offset hasta completar el total con ese mismo orden del servidor.
    const first = await client.wizards.list({
      query: query || undefined,
      limit: 100,
      sort: wizardsSort.columnId,
      dir: wizardsSort.direction,
    });
    const items: WizardListResponse['items'] = [...first.items];
    while (items.length < first.total && first.items.length > 0) {
      const next = await client.wizards.list({
        query: query || undefined,
        limit: 100,
        offset: items.length,
        sort: wizardsSort.columnId,
        dir: wizardsSort.direction,
      });
      if (next.items.length === 0) break;
      items.push(...next.items);
    }
    renderWizardsList(items, first.total);
    els.wizardsStatus.textContent = '';
    els.wizardsStatus.className = 'status';
  } catch (error) {
    els.wizardsStatus.textContent = `Error cargando wizards: ${describeError(error)}`;
    els.wizardsStatus.className = 'status error';
  } finally {
    wizardsLoading = false;
  }
}

async function promptAndInstallFromWizard(
  wizardId: string,
  wizardName: string,
  folderName?: string,
): Promise<void> {
  if (!libraryRoot) {
    const msg = 'Debes seleccionar y escanear primero una librería VFX activa para instalar instrumentos.';
    setStatus(msg, 'error');
    if (!els.wizards.hidden) {
      els.wizardsStatus.textContent = msg;
      els.wizardsStatus.className = 'status error';
    }
    if (!els.pluginWizard.hidden) {
      els.pluginWizardStatus.textContent = msg;
      els.pluginWizardStatus.className = 'status error';
    }
    return;
  }

  const setTargetStatus = (msg: string, cls: string) => {
    if (!els.wizards.hidden) {
      els.wizardsStatus.textContent = msg;
      els.wizardsStatus.className = cls;
    }
    if (!els.pluginWizard.hidden) {
      els.pluginWizardStatus.textContent = msg;
      els.pluginWizardStatus.className = cls;
    }
  };

  setTargetStatus('Elige el DLL original en el diálogo del explorador…', 'status busy');

  const body: RequestBody<'/system/pick', 'post'> = {
    kind: 'file',
    title: `Elige el archivo DLL original para "${wizardName}"`,
    extensions: ['dll'],
  };
  const start = parentDir(currentDll() || recentDlls[0] || '');
  if (start !== null) body.initialDir = start;

  const picked = await pickPaths(body, 'library');
  if (picked === null) return;
  const chosenDll = picked[0];
  if (!chosenDll) {
    setTargetStatus('Instalación cancelada: no se seleccionó ningún archivo DLL.', 'status');
    return;
  }

  setTargetStatus(`Instalando "${wizardName}" desde wizard certificado…`, 'status busy');

  try {
    const res = await client.wizards.install({
      wizardId,
      libraryRoot,
      dllSourcePath: chosenDll,
      pluginFolderName: folderName,
      overwrite: true,
      initializeBank: true,
    });

    const warnText = res.warnings.length > 0 ? ` [Aviso: ${res.warnings.join('; ')}]` : '';
    const regText = res.registryFileCreated ? ' Claves de registro guardadas.' : '';
    const successMsg = `Instrumento "${res.pluginName}" instalado con éxito desde Wizard certificado.${warnText}${regText}`;

    setTargetStatus(successMsg, 'status ok');

    // Refrescar el escaneo para ver el plugin en la tabla
    const plugins = await fetchPlugins();
    render(plugins);
  } catch (error) {
    setTargetStatus(`Error al instalar instrumento: ${describeError(error)}`, 'status error');
  }
}

/**
 * Tabla estándar del repositorio de wizards (`mountTable`): mismo modelo de
 * columnas, orden, paginación y estado vacío que el resto de tablas.
 *
 * La búsqueda del cajón sigue siendo el filtro del servidor (`wizards-filter`):
 * no se duplica en la tabla, así que ninguna columna marca `searchable: false`
 * de más y el toolbar no añade su propio cuadro.
 *
 * El orden también lo resuelve el servidor (`sort`/`dir` de `GET /wizards`):
 * pulsar una cabecera ordenable recarga el listado con ese orden antes de
 * renderizar. Configuración no tiene campo en el servidor y queda sin orden;
 * las acciones (Instalar… y Ver registro) van en el menú «···» de la fila,
 * con los mismos `rowActions` que el historial y el resto de tablas.
 */
const wizardsTableView: TableView<WizardListResponse['items'][number]> = {
  columns: [
    {
      id: 'name',
      label: 'Plugin',
      getValue: (w) => w.name,
      searchable: false,
    },
    {
      id: 'vendor',
      label: 'Fabricante',
      getValue: (w) => w.vendor,
      searchable: false,
    },
    {
      id: 'genre',
      label: 'Género',
      getValue: (w) => w.genre || 'VST',
      searchable: false,
    },
    {
      id: 'dllName',
      label: 'DLL',
      getValue: (w) => w.dllName,
      searchable: false,
      renderNode: (w) => {
        const code = document.createElement('code');
        code.textContent = w.dllName;
        return code;
      },
    },
    {
      id: 'id',
      label: 'ID',
      getValue: (w) => w.id,
      searchable: false,
      renderNode: (w) => {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = w.id;
        return badge;
      },
    },
    {
      id: 'config',
      label: 'Configuración',
      sortable: false,
      searchable: false,
      getValue: (w) =>
        [
          w.hasRegistryKeys ? 'Registro' : null,
          w.hasFilesToCopy || w.hasDirsToCopy ? 'Archivos' : null,
          w.hasReadme ? 'Readme' : null,
          w.isSynth ? 'Sinte' : null,
        ]
          .filter((flag): flag is string => flag !== null)
          .join(', ') || 'Estándar',
    },
  ],
  rowActions: {
    actions: (w) => [
      {
        id: 'install',
        label: 'Instalar…',
        icon: 'download',
        tone: 'primary',
        onSelect: () => void promptAndInstallFromWizard(w.id, w.name),
      },
      {
        // Mismo «Ver registro» que el historial: `view-record` con icono
        // `file`. Aquí no hay entrada que mostrar, así que abre el cajón del
        // log del plugin que representa el wizard.
        id: 'view-record',
        label: 'Ver registro',
        icon: 'file',
        onSelect: (_w, trigger) => openWizardLog(w, trigger),
      },
    ],
  },
  getRowId: (w) => w.id,
  onSortChange: (sort) => {
    wizardsSort = sort;
    void loadWizards(wizardsQuery);
  },
  initialSort: { columnId: 'name', direction: 'asc' },
  pageSize: 100,
  searchColumns: [],
  emptyText: 'No se encontraron wizards coincidentes.',
};

function renderWizardsList(items: WizardListResponse['items'], total: number): void {
  els.wizardsCount.textContent = `${items.length} de ${total}`;

  if (wizardsTableController === null) {
    wizardsTableController = mountTable(els.wizardsTable, wizardsTableView, items);
  } else {
    wizardsTableController.setRows(items);
  }
}

/**
 * Registro de un wizard desde su fila: si el plugin ya está escaneado en la
 * librería se abre con su carpeta real; si aún no existe, con la ruta
 * candidata bajo `plugs\` para que el cajón diga que todavía no hay log.
 */
function openWizardLog(w: WizardListResponse['items'][number], opener?: HTMLElement): void {
  const scanned = scanData?.plugins.find((plugin) => plugin.name === w.name);
  const plugs = scanData?.plugsPath ?? (libraryRoot === '' ? '' : `${libraryRoot}/plugs`);
  const target: ScanPlugin = scanned ?? ({ name: w.name, path: `${plugs}/${w.name}` } as ScanPlugin);
  void openLogDrawer(target, opener);
}

interface PluginWizardState {
  plugin: ScanPlugin;
  wizard: WizardMatchResponse | null;
}

let pluginWizardState: PluginWizardState | null = null;

async function openPluginWizard(plugin: ScanPlugin, opener?: HTMLElement): Promise<void> {
  closeBanks();
  closeMeta();
  closeWizards();
  closeLogDrawer();
  closeImportPackageDrawer();
  closeCustomPluginDrawer();
  closeAuditDrawer();
  showPanel(els.pluginWizard, opener);

  els.pluginWizardPlugin.textContent = plugin.name;
  els.pluginWizardStatus.textContent = 'Buscando wizard…';
  els.pluginWizardStatus.className = 'status busy';
  els.pluginWizardEmpty.hidden = true;
  els.pluginWizardContent.hidden = true;

  try {
    const match = await client.wizards.match({
      id: plugin.wizardId ?? undefined,
      name: plugin.name,
      dllName: plugin.pluginName ?? undefined,
    });

    if (match === null) {
      pluginWizardState = { plugin, wizard: null };
      els.pluginWizardEmpty.hidden = false;
      els.pluginWizardContent.hidden = true;
      els.pluginWizardStatus.textContent = '';
      els.pluginWizardStatus.className = 'status';
      return;
    }

    pluginWizardState = { plugin, wizard: match };
    els.pluginWizardEmpty.hidden = true;
    els.pluginWizardContent.hidden = false;

    els.pluginWizardName.textContent = match.name;
    els.pluginWizardSource.textContent = match.sourcePath;
    els.pluginWizardVendor.textContent = match.vendor || '—';
    els.pluginWizardGenre.textContent = match.genre || '—';
    els.pluginWizardId.textContent = `${match.id} (FourCC: ${fourCcFromId(match.id)})`;
    els.pluginWizardDll.textContent = match.dllName || '—';
    els.pluginWizardDimensions.textContent = `${match.editorWidth} × ${match.editorHeight} px (${match.hasEditor ? 'Con GUI' : 'Sin GUI'})`;
    els.pluginWizardParams.textContent = `${match.parameterCount} parámetros · ${match.programCount} programas`;

    const flagsKeys = Object.keys(match.flags ?? {});
    els.pluginWizardFlags.textContent = flagsKeys.length > 0 ? JSON.stringify(match.flags) : '—';

    const fileParts: string[] = [];
    if (match.filesToCopy && match.filesToCopy.length > 0) {
      fileParts.push('Archivos:\n  ' + match.filesToCopy.join('\n  '));
    }
    if (match.dirsToCopy && match.dirsToCopy.length > 0) {
      fileParts.push('Directorios:\n  ' + match.dirsToCopy.join('\n  '));
    }
    if (match.symlinks && match.symlinks.length > 0) {
      fileParts.push('Enlaces simbólicos:\n  ' + match.symlinks.join('\n  '));
    }
    if (match.filesToCreate && Object.keys(match.filesToCreate).length > 0) {
      fileParts.push('Archivos creados: ' + Object.keys(match.filesToCreate).join(', '));
    }
    if (fileParts.length > 0) {
      els.pluginWizardFilesWrap.hidden = false;
      els.pluginWizardFiles.textContent = fileParts.join('\n\n');
    } else {
      els.pluginWizardFilesWrap.hidden = true;
    }

    if (match.registryKeys && match.registryKeys.trim() !== '') {
      els.pluginWizardRegistryWrap.hidden = false;
      els.pluginWizardRegistry.textContent = match.registryKeys.trim();
    } else {
      els.pluginWizardRegistryWrap.hidden = true;
    }

    const noteParts = [match.notes, match.vendorNotes].filter((n) => Boolean(n && n.trim()));
    if (noteParts.length > 0) {
      els.pluginWizardNotesWrap.hidden = false;
      els.pluginWizardNotes.textContent = noteParts.join('\n\n');
    } else {
      els.pluginWizardNotesWrap.hidden = true;
    }

    const rawReadme = (match as { readme?: unknown }).readme;
    const readmeText = typeof rawReadme === 'string' ? rawReadme.trim() : '';
    if (readmeText !== '') {
      els.pluginWizardReadmeWrap.hidden = false;
      els.pluginWizardReadme.textContent = readmeText;
    } else {
      els.pluginWizardReadmeWrap.hidden = true;
    }

    els.pluginWizardVfxinfoLabel.textContent = plugin.hasVfxinfo
      ? 'Recrear vfxinfo.txt desde Wizard'
      : 'Crear vfxinfo.txt desde Wizard';

    els.pluginWizardStatus.textContent = '';
    els.pluginWizardStatus.className = 'status';
  } catch (error) {
    els.pluginWizardStatus.textContent = `Error al buscar wizard: ${describeError(error)}`;
    els.pluginWizardStatus.className = 'status error';
  }
}

function closePluginWizard(): void {
  if (els.pluginWizard.hidden) return;
  hidePanel(els.pluginWizard);
  pluginWizardState = null;
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  libraryRoot = els.root.value.trim();
  writeStorage(STORAGE_ROOT, libraryRoot);
  rememberRoot(libraryRoot);
  const dll = currentDll();
  if (dll !== '') rememberDll(dll);
  void scan();
});

els.dll.addEventListener('input', () => {
  writeStorage(STORAGE_DLL, currentDll());
});

// Al escribir una ruta el aviso se retira; el siguiente escaneo lo repone si no vale.
els.root.addEventListener('input', () => {
  setRootWarning(els.root.value.trim() === '');
});

// Al salir del campo se recuerda la DLL escrita, aunque no se haya escaneado.
els.dll.addEventListener('change', () => {
  const dll = currentDll();
  if (dll !== '') rememberDll(dll);
});

els.rootBrowse.addEventListener('click', () => {
  void chooseLibraryRoot();
});

els.dllBrowse.addEventListener('click', () => {
  void chooseDll();
});

els.recentsClear.addEventListener('click', () => {
  clearRecents();
});

els.importBrowse.addEventListener('click', () => {
  void chooseImportFiles();
});

els.installAll.addEventListener('click', () => {
  void runBatch('add');
});

els.uninstallAll.addEventListener('click', () => {
  void runBatch('remove');
});

els.batchCancel.addEventListener('click', () => {
  if (batchController === null || batchController.signal.aborted) return;
  batchController.abort();
  els.batchCancel.disabled = true;
  setBatchStatus('Cancelando el lote…', 'busy');
});

els.batchResume.addEventListener('click', () => {
  const resume = pendingResume();
  if (resume === null) return;
  void runBatch(resume.action, resume.plugins);
});

els.retryAll.addEventListener('click', () => {
  void retryAllFailures();
});

els.banksClose.addEventListener('click', () => {
  closeBanks();
});

els.metaClose.addEventListener('click', () => {
  closeMeta();
});

els.metaSave.addEventListener('click', () => {
  void saveMeta();
});

els.metaReload.addEventListener('click', () => {
  void reloadMeta();
});

els.metaDll.addEventListener('input', () => {
  // Cada edición es un borrador en memoria; nada se escribe sin Guardar.
  const value = dllPreferenceInput();
  dllPrefDraft = value === dllPrefSaved ? null : value;
  updateDllPreferenceNote();
});

els.metaDllSave.addEventListener('click', () => {
  void saveDllPreference();
});

els.metaDllCancel.addEventListener('click', () => {
  cancelDllPreferenceDraft();
});

els.dialogDllDraftContinue.addEventListener('click', () => {
  continueWithoutChanges();
});

els.dialogDllDraftCancel.addEventListener('click', () => {
  // Solo conserva el borrador: no se guarda nada desde el aviso.
  declareDraftImportCancelled();
});

els.metaWizardApply.addEventListener('click', () => {
  void applyWizardToMeta();
});

els.wizardsNavBtn.addEventListener('click', () => {
  void openWizards();
});

els.wizardsClose.addEventListener('click', () => {
  closeWizards();
});

els.pluginWizardClose.addEventListener('click', () => {
  closePluginWizard();
});

els.pluginWizardVfxinfoBtn.addEventListener('click', async () => {
  if (!pluginWizardState) return;
  const { plugin, wizard } = pluginWizardState;
  const confirmed = plugin.hasVfxinfo
    ? window.confirm(
        `¿Reemplazar vfxinfo.txt existente en "${plugin.name}" usando datos del wizard? Se creará respaldo vfxinfo.tx_.`,
      )
    : true;
  if (!confirmed) return;

  els.pluginWizardStatus.textContent = 'Generando vfxinfo.txt…';
  els.pluginWizardStatus.className = 'status busy';
  try {
    const res = await client.wizards.createVfxinfo({
      pluginDir: plugin.path,
      wizardId: wizard?.id,
      force: true,
    });
    plugin.hasVfxinfo = true;
    els.pluginWizardVfxinfoLabel.textContent = 'Recrear vfxinfo.txt desde Wizard';
    const data = await fetchPlugins();
    render(data);
    els.pluginWizardStatus.textContent = `vfxinfo.txt generado correctamente${res.backedUp ? ' (respaldo .tx_ creado)' : ''}.`;
    els.pluginWizardStatus.className = 'status ok';
  } catch (error) {
    els.pluginWizardStatus.textContent = `No se pudo generar vfxinfo.txt: ${describeError(error)}`;
    els.pluginWizardStatus.className = 'status error';
  }
});

els.pluginWizardApplyBtn.addEventListener('click', async () => {
  if (!pluginWizardState) return;
  const { plugin, wizard } = pluginWizardState;
  els.pluginWizardStatus.textContent = 'Aplicando metadatos al catálogo…';
  els.pluginWizardStatus.className = 'status busy';
  try {
    await client.wizards.applyMeta({
      pluginDir: plugin.path,
      wizardId: wizard?.id,
      overwriteNotes: false,
    });
    markPluginHasMeta(plugin.path);
    els.pluginWizardStatus.textContent =
      'Metadatos del wizard aplicados correctamente al catálogo (fxbLoader.meta.json).';
    els.pluginWizardStatus.className = 'status ok';
  } catch (error) {
    els.pluginWizardStatus.textContent = `No se pudieron aplicar metadatos: ${describeError(error)}`;
    els.pluginWizardStatus.className = 'status error';
  }
});

els.pluginWizardInstallBtn.addEventListener('click', () => {
  if (!pluginWizardState?.wizard) return;
  void promptAndInstallFromWizard(
    pluginWizardState.wizard.id,
    pluginWizardState.wizard.name,
    pluginWizardState.plugin.name,
  );
});

els.logClose.addEventListener('click', () => {
  closeLogDrawer();
});
els.logDetailClose.addEventListener('click', closeLogRecordDetail);

let filterTimeout: ReturnType<typeof setTimeout> | null = null;
els.wizardsFilter.addEventListener('input', () => {
  if (filterTimeout) clearTimeout(filterTimeout);
  filterTimeout = setTimeout(() => {
    wizardsQuery = els.wizardsFilter.value.trim();
    void loadWizards(wizardsQuery);
  }, 200);
});

els.defaultSave.addEventListener('click', () => {
  void saveDefault(els.defaultBank.value);
});

els.defaultConvert.addEventListener('click', () => {
  void convertDefaultBank();
});

els.defaultRestore.addEventListener('click', () => {
  void restoreDefaultBank();
});

els.defaultDiscard.addEventListener('click', () => {
  void discardDefaultBackup();
});

els.importButton.addEventListener('click', () => {
  void importBanks();
});

els.importCancel.addEventListener('click', () => {
  if (importController === null || importController.signal.aborted) return;
  importController.abort(new Error('Cancelado por el usuario'));
  els.importCancel.disabled = true;
  setBanksStatus('Cancelando la importación…', 'busy');
});

els.exportButton.addEventListener('click', () => {
  void exportBank();
});

els.createBankButton.addEventListener('click', () => {
  void createBank();
});

els.createMode.addEventListener('change', syncCreateMode);
syncCreateMode();



const STORAGE_THEME = 'fxbLoader.theme';
type ThemeMode = 'auto' | 'dark' | 'light';

const themeIcons = [...els.themeToggle.querySelectorAll<SVGElement>('[data-icon]')];
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(mode: ThemeMode): void {
  if (mode === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    els.themeToggle.title = 'Tema: Oscuro (clic para cambiar a Claro)';
  } else if (mode === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    els.themeToggle.title = 'Tema: Claro (clic para cambiar a Sistema)';
  } else {
    document.documentElement.removeAttribute('data-theme');
    els.themeToggle.title = 'Tema: Sistema (clic para cambiar a Oscuro)';
  }

  // Sol y luna son excluyentes. En «Sistema» se enseña el dibujo del tema que
  // esté aplicando el SO, para que el botón diga siempre lo que se ve.
  const shown = mode === 'auto' ? (prefersDark.matches ? 'dark' : 'light') : mode;
  for (const icon of themeIcons) {
    icon.toggleAttribute('hidden', icon.dataset['icon'] !== shown);
  }
}

/**
 * Modo guardado en este navegador. «Sistema» se guarda como `auto` igual que
 * los otros dos: cualquier valor ausente o desconocido también cae en `auto`,
 * que es lo que había antes de existir la clave.
 */
function readTheme(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_THEME);
  return stored === 'dark' || stored === 'light' ? stored : 'auto';
}

function cycleTheme(): void {
  const current = readTheme();
  const next: ThemeMode = current === 'auto' ? 'dark' : current === 'dark' ? 'light' : 'auto';
  localStorage.setItem(STORAGE_THEME, next);
  applyTheme(next);
}

applyTheme(readTheme());

// Con «Sistema», si el SO cambia de claro a oscuro hay que cambiar el dibujo.
prefersDark.addEventListener('change', () => {
  if (readTheme() === 'auto') applyTheme('auto');
});

els.themeToggle.addEventListener('click', cycleTheme);

let importPackageInspection: LibraryInspectPackageResponse | null = null;
let importPackageBusy = false;
let selectedImportPlugins = new Set<string>();
let currentInspectionPlugins: LibraryInspectPackageResponse['plugins'] = [];
let importPackagePluginsTableController: TableController<LibraryInspectPackageResponse['plugins'][number]> | null = null;
let selectedImportBanks = new Set<string>();
let currentInspectionBanks: LibraryInspectPackageResponse['banks'] = [];
let importPackageBanksTableController: TableController<LibraryInspectPackageResponse['banks'][number]> | null = null;

function setImportPackageBusy(busy: boolean): void {
  importPackageBusy = busy;
  els.importPackageInspectBtn.disabled = busy;
  els.importPackageBrowse.disabled = busy;
  els.importPackageExecuteBtn.disabled = busy;
  els.importPackagePolicy.disabled = busy;
  els.importPackageRepair.disabled = busy;
}

function openImportPackageDrawer(opener?: HTMLElement): void {
  closeBanks();
  closeMeta();
  closeWizards();
  closePluginWizard();
  closeLogDrawer();
  closeCustomPluginDrawer();
  closeAuditDrawer();
  showPanel(els.importPackageDrawer, opener);
  if (!els.importPackagePath.value.trim() && libraryRoot) {
    const parent = parentDir(libraryRoot);
    if (parent) {
      els.importPackagePath.value = parent;
    }
  }
  els.importPackagePath.focus();
}

function closeImportPackageDrawer(): void {
  if (els.importPackageDrawer.hidden) return;
  hidePanel(els.importPackageDrawer);
  importPackageInspection = null;
  importPackagePluginsTableController?.destroy();
  importPackagePluginsTableController = null;
  els.importPackagePluginsTable.replaceChildren();
  selectedImportPlugins.clear();
  currentInspectionPlugins = [];
  importPackageBanksTableController?.destroy();
  importPackageBanksTableController = null;
  els.importPackageBanksTable.replaceChildren();
  selectedImportBanks.clear();
  currentInspectionBanks = [];
  els.importPackagePreview.hidden = true;
  els.importPackageStatus.textContent = '';
  els.importPackageStatus.className = 'status';
}

/** Asistente de creación de plugins nuevos sin wizard. */
let customPluginBusy = false;
/** Última inspección mostrada, para no releer la DLL al crear. */
let customPluginInspection: LibraryInspectDllResponse | null = null;

/** Número entero del campo o `undefined` si está vacío o es inválido. */
function optionalInt(input: HTMLInputElement): number | undefined {
  const text = input.value.trim();
  if (text === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function setCustomPluginBusy(busy: boolean): void {
  customPluginBusy = busy;
  els.customPluginInspectBtn.disabled = busy;
  els.customPluginBrowse.disabled = busy;
  els.customPluginCreateBtn.disabled = busy;
}

function setCustomPluginStatus(message: string, kind = 'info'): void {
  els.customPluginStatus.textContent = message;
  els.customPluginStatus.className = `status ${kind}`;
}

function openCustomPluginDrawer(opener?: HTMLElement): void {
  closeBanks();
  closeMeta();
  closeWizards();
  closePluginWizard();
  closeLogDrawer();
  closeImportPackageDrawer();
  closeAuditDrawer();
  showPanel(els.customPluginDrawer, opener);
  if (!els.customPluginRoot.value.trim() && libraryRoot) {
    els.customPluginRoot.value = libraryRoot;
  }
  els.customPluginPath.focus();
}

function closeCustomPluginDrawer(): void {
  if (els.customPluginDrawer.hidden) return;
  hidePanel(els.customPluginDrawer);
  customPluginInspection = null;
  els.customPluginResult.hidden = true;
  els.customPluginCreated.hidden = true;
  els.customPluginBitnessWarning.hidden = true;
  els.customPluginStatus.textContent = '';
  els.customPluginStatus.className = 'status';
}

/** Pinta el resultado de `/library/inspect-dll` y, con lo detectado, rellena el
 * nombre y el id sugeridos. */
function renderCustomPluginInspection(result: LibraryInspectDllResponse): void {
  customPluginInspection = result;
  els.customPluginResult.hidden = false;
  els.customPluginCreated.hidden = true;

  els.customPluginValidPe.textContent = result.validPe ? 'PE válido' : 'No es un PE';
  els.customPluginValidPe.className = `badge ${result.validPe ? 'on' : 'off'}`;
  els.customPluginBitness.textContent = result.bitness === null ? 'bits ?' : `${result.bitness} bits`;
  els.customPluginBitness.className = `badge ${result.is32BitCompatible ? 'on' : 'off'}`;
  if (result.vstEntrypoint !== null) {
    els.customPluginVst.textContent = `VST: ${result.vstEntrypoint}`;
    els.customPluginVst.className = 'badge on';
  } else {
    els.customPluginVst.textContent = 'sin VSTPluginMain/main';
    els.customPluginVst.className = 'badge off';
  }

  const suggestionParts = [`Sugerido: ${result.suggestedName} · id ${result.suggestedId}`];
  if (result.internalDllName !== null) {
    suggestionParts.push(` · DLL interno ${result.internalDllName}`);
  }
  els.customPluginSuggestion.textContent = suggestionParts.join('');
  els.customPluginName.value = result.suggestedName;
  els.customPluginFolder.value = result.suggestedName;
  if (!els.customPluginId.value.trim()) els.customPluginId.value = result.suggestedId;

  const wizard = result.matchingWizard;
  if (wizard !== null) {
    els.customPluginWizard.textContent =
      `Hay un wizard oficial en el catálogo que coincide con este binario: ` +
      `${wizard.name} (id ${wizard.id}, ${wizard.vendor}). Revisar «Wizards» antes de crear otro aparte.`;
    els.customPluginWizard.hidden = false;
  } else {
    els.customPluginWizard.hidden = true;
  }

  els.customPluginExports.replaceChildren();
  for (const name of result.exportedNames) {
    const item = document.createElement('li');
    item.textContent = name;
    els.customPluginExports.append(item);
  }
  els.customPluginExports.hidden = result.exportedNames.length === 0;

  els.customPluginIssues.replaceChildren();
  for (const issue of result.issues) {
    const item = document.createElement('li');
    item.textContent = issue;
    els.customPluginIssues.append(item);
  }
  els.customPluginIssues.hidden = result.issues.length === 0;

  // Advertencia persistente si el binario no es apto para el host de 32 bits:
  // se puede seguir creando, pero el plugin no cargará en la V-Machine / VFX Host.
  if (!result.is32BitCompatible) {
    els.customPluginBitnessWarning.textContent =
      `El binario no es apto para el host de 32 bits: ${result.validPe ? `es ${result.bitness} bits` : 'ni siquiera es un PE valido'}. ` +
      'Puedes crear el plugin igualmente, pero fxbLoader no cargara este DLL en una V-Machine / VFX Host de 32 bits.';
    els.customPluginBitnessWarning.hidden = false;
  } else {
    els.customPluginBitnessWarning.hidden = true;
  }
}

/** Botón «Analizar binario»: inspección estática de la DLL. */
async function inspectCustomPlugin(): Promise<void> {
  if (customPluginBusy) return;
  const dllPath = els.customPluginPath.value.trim();
  if (dllPath === '') {
    setCustomPluginStatus('Indica la ruta del DLL a analizar.', 'error');
    return;
  }

  els.customPluginResult.hidden = true;
  els.customPluginBitnessWarning.hidden = true;
  setCustomPluginBusy(true);
  setCustomPluginStatus('Analizando el binario…', 'busy');
  try {
    const body: RequestBody<'/library/inspect-dll', 'post'> = { dllPath };
    const result = await client.library.inspectDll(body);
    renderCustomPluginInspection(result);
    setCustomPluginStatus('Binario analizado.', 'info');
  } catch (error) {
    customPluginInspection = null;
    setCustomPluginStatus(`No se pudo analizar el DLL: ${describeError(error)}`, 'error');
  } finally {
    setCustomPluginBusy(false);
  }
}

/** Botón «Crear plugin en la librería»: alta a partir de lo ya analizado. */
async function createCustomPlugin(): Promise<void> {
  if (customPluginBusy) return;
  const libraryRootPath = els.customPluginRoot.value.trim();
  if (libraryRootPath === '') {
    setCustomPluginStatus('Indica la carpeta de la librería VFX.', 'error');
    return;
  }
  const folderName = els.customPluginFolder.value.trim();
  if (folderName === '') {
    setCustomPluginStatus('Indica el nombre de la carpeta del plugin.', 'error');
    return;
  }
  const name = els.customPluginName.value.trim();
  if (name === '') {
    setCustomPluginStatus('Indica el nombre interno del plugin (vfxinfo).', 'error');
    return;
  }
  const id = els.customPluginId.value.trim();
  if (id === '') {
    setCustomPluginStatus('Indica el identificador VST (id).', 'error');
    return;
  }
  const sourceDllPath = els.customPluginPath.value.trim();
  if (sourceDllPath === '') {
    setCustomPluginStatus('Indica la ruta del DLL origen.', 'error');
    return;
  }

  const body: RequestBody<'/library/create-custom-plugin', 'post'> = {
    libraryRoot: libraryRootPath,
    sourceDllPath,
    folderName,
    name,
    id,
    isSynth: els.customPluginSynth.checked,
    overwrite: els.customPluginOverwrite.checked,
    saveAsWizard: els.customPluginSaveWizard.checked,
  };
  const params = optionalInt(els.customPluginParams);
  if (params !== undefined) body.parameterCount = params;
  const programs = optionalInt(els.customPluginPrograms);
  if (programs !== undefined) body.programCount = programs;
  if (els.customPluginVendor.value.trim() !== '') body.vendor = els.customPluginVendor.value.trim();
  if (els.customPluginGenre.value.trim() !== '') body.genre = els.customPluginGenre.value.trim();
  // Se envía siempre: el servidor asume editor por defecto, así que omitirlo
  // al desmarcar la casilla dejaría el plugin con editor igualmente.
  body.hasEditor = els.customPluginEditor.checked;
  if (els.customPluginEditor.checked) {
    const width = optionalInt(els.customPluginWidth);
    if (width !== undefined) body.editorWidth = width;
    const height = optionalInt(els.customPluginHeight);
    if (height !== undefined) body.editorHeight = height;
  }

  setCustomPluginBusy(true);
  setCustomPluginStatus('Creando el plugin en la librería…', 'busy');
  try {
    const result: LibraryCreateCustomPluginResponse = await client.library.createCustomPlugin(body);
    els.customPluginCreated.hidden = false;
    els.customPluginCreatedPaths.replaceChildren();
    for (const line of [
      `Carpeta: ${result.pluginDir}`,
      `DLL: ${result.dllRelativePath}`,
      `vfxinfo.txt: ${result.vfxinfoPath}`,
      `fxbLoader.meta.json: ${result.metaPath}`,
      ...(result.wizardPath !== null ? [`Wizard: ${result.wizardPath}`] : []),
    ]) {
      const item = document.createElement('li');
      item.textContent = line;
      els.customPluginCreatedPaths.append(item);
    }
    els.customPluginCreatedWarnings.replaceChildren();
    for (const warning of result.warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      els.customPluginCreatedWarnings.append(item);
    }
    els.customPluginCreatedWarnings.hidden = result.warnings.length === 0;
    setCustomPluginStatus(result.created ? 'Plugin creado.' : 'No se creó el plugin.', 'info');
  } catch (error) {
    setCustomPluginStatus(`No se pudo crear el plugin: ${describeError(error)}`, 'error');
  } finally {
    setCustomPluginBusy(false);
  }
}

els.customPluginNavBtn.addEventListener('click', () => {
  openCustomPluginDrawer(els.customPluginNavBtn);
});

els.customPluginClose.addEventListener('click', () => {
  closeCustomPluginDrawer();
});

els.customPluginInspectBtn.addEventListener('click', () => {
  void inspectCustomPlugin();
});

els.customPluginCreateBtn.addEventListener('click', () => {
  void createCustomPlugin();
});

els.customPluginEditor.addEventListener('change', () => {
  els.customPluginEditorRow.hidden = !els.customPluginEditor.checked;
});

els.customPluginBrowse.addEventListener('click', async () => {
  try {
    const current = els.customPluginPath.value.trim();
    const start =
      current !== ''
        ? (parentDir(current) ?? undefined)
        : (libraryRoot ? (parentDir(libraryRoot) ?? undefined) : undefined);
    const res = await client.system.pick({
      kind: 'file',
      title: 'Elige el DLL del plugin VST',
      extensions: ['dll'],
      initialDir: start,
    });
    const chosen = res.paths?.[0];
    if (chosen) {
      els.customPluginPath.value = chosen;
      void inspectCustomPlugin();
    }
  } catch (error) {
    setCustomPluginStatus(`No se pudo abrir el selector: ${describeError(error)}`, 'error');
  }
});

const importPackagePluginsTableView: TableView<LibraryInspectPackageResponse['plugins'][number]> = {
  columns: [
    {
      id: 'select',
      label: '',
      sortable: false,
      searchable: false,
      cellClass: 'table-check',
      getValue: (plug) => selectedImportPlugins.has(plug.sourceDir || plug.name),
      renderNode: (plug) => {
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        const key = plug.sourceDir || plug.name;
        chk.checked = selectedImportPlugins.has(key);
        chk.title = `Seleccionar ${plug.name}`;
        chk.addEventListener('change', () => {
          if (chk.checked) selectedImportPlugins.add(key);
          else selectedImportPlugins.delete(key);
          els.importPackageAllPlugs.checked =
            currentInspectionPlugins.length > 0 &&
            currentInspectionPlugins.every((p) => selectedImportPlugins.has(p.sourceDir || p.name));
        });
        return chk;
      },
    },
    {
      id: 'name',
      label: 'Plugin',
      sortType: 'text',
      getValue: (plug) => plug.name,
      renderNode: (plug) => {
        const wrap = document.createElement('div');
        const nameTitle = document.createElement('div');
        nameTitle.textContent = plug.name;
        wrap.append(nameTitle);

        const plugWizard = (plug as { matchedWizard?: { name: string; vendor: string } }).matchedWizard;
        if (plugWizard) {
          const wizardSubtitle = document.createElement('div');
          wizardSubtitle.className = 'note';
          wizardSubtitle.style.color = 'var(--accent)';
          wizardSubtitle.textContent = `Wizard: ${plugWizard.vendor} ${plugWizard.name}`;
          wrap.append(wizardSubtitle);
        }

        if ((plug as { packageSource?: string }).packageSource) {
          const srcSubtitle = document.createElement('div');
          srcSubtitle.className = 'note';
          srcSubtitle.style.fontSize = '0.75rem';
          srcSubtitle.textContent = (plug as { packageSource?: string }).packageSource!;
          wrap.append(srcSubtitle);
        }
        return wrap;
      },
    },
    {
      id: 'dllName',
      label: 'DLL',
      sortType: 'text',
      getValue: (plug) => plug.dllName ?? '—',
    },
    {
      id: 'vfxinfo',
      label: 'vfxinfo.txt',
      sortType: 'text',
      getValue: (plug) => (plug.hasVfxinfo ? (plug.vfxinfoId ? `ID ${plug.vfxinfoId}` : 'Sí') : 'No'),
      renderNode: (plug) => {
        const badgeVfx = document.createElement('span');
        badgeVfx.className = plug.hasVfxinfo ? 'badge on' : 'badge off';
        badgeVfx.textContent = plug.hasVfxinfo ? (plug.vfxinfoId ? `ID ${plug.vfxinfoId}` : 'Sí') : 'No';
        return badgeVfx;
      },
    },
    {
      id: 'size',
      label: 'Tamaño',
      sortType: 'number',
      getValue: (plug) => plug.totalSizeBytes,
      renderCell: (plug) => formatBytes(plug.totalSizeBytes),
    },
    {
      id: 'target',
      label: 'En destino',
      sortType: 'text',
      getValue: (plug) => (plug.alreadyExistsInTarget ? 'Ya existe' : 'Nuevo'),
      renderNode: (plug) => {
        const badgeTarget = document.createElement('span');
        if (plug.alreadyExistsInTarget) {
          badgeTarget.className = 'badge';
          badgeTarget.textContent = 'Ya existe';
        } else {
          badgeTarget.className = 'badge on';
          badgeTarget.textContent = 'Nuevo';
        }
        return badgeTarget;
      },
    },
  ],
  getRowId: (plug) => plug.sourceDir || plug.name,
  initialSort: { columnId: 'name', direction: 'asc' },
  pageSize: 50,
  searchColumns: ['name', 'dllName'],
  tbodyId: 'import-package-plugins-rows',
  emptyText: 'No se detectaron plugins en el origen.',
  filters: [
    {
      id: 'targetFilter',
      label: 'Destino',
      columnId: 'target',
      options: [
        { value: 'all', label: 'Todos los plugins', tone: 'neutral' },
        { value: 'new', label: 'Solo nuevos', tone: 'positive', predicate: (p) => !p.alreadyExistsInTarget },
        { value: 'exists', label: 'Solo ya existentes', tone: 'negative', predicate: (p) => p.alreadyExistsInTarget },
      ],
    },
  ],
};

/**
 * Tabla estándar de los bancos detectados en la inspección (`mountTable`):
 * orden por presets, concordancia o tamaño, filtros de concordancia técnica y
 * la casilla de selección por fila enlazada con «Seleccionar todos».
 */
const importPackageBanksTableView: TableView<LibraryInspectPackageResponse['banks'][number]> = {
  columns: [
    {
      id: 'select',
      label: '',
      sortable: false,
      searchable: false,
      cellClass: 'table-check',
      getValue: (bank) => selectedImportBanks.has(bankSelectionKey(bank)),
      renderNode: (bank) => {
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = selectedImportBanks.has(bankSelectionKey(bank));
        chk.title = `Seleccionar ${bank.name}`;
        chk.addEventListener('change', () => {
          const key = bankSelectionKey(bank);
          if (chk.checked) selectedImportBanks.add(key);
          else selectedImportBanks.delete(key);
          els.importPackageAllBanks.checked =
            currentInspectionBanks.length > 0 &&
            currentInspectionBanks.every((item) => selectedImportBanks.has(bankSelectionKey(item)));
        });
        return chk;
      },
    },
    {
      id: 'name',
      label: 'Banco',
      sortType: 'text',
      getValue: (bank) => bank.name,
      renderNode: (bank) => {
        const wrap = document.createElement('div');
        const nameTitle = document.createElement('div');
        nameTitle.textContent = bank.name;
        wrap.append(nameTitle);
        if (bank.packageSource) {
          const srcSubtitle = document.createElement('div');
          srcSubtitle.className = 'note';
          srcSubtitle.style.fontSize = '0.75rem';
          srcSubtitle.textContent = bank.packageSource;
          wrap.append(srcSubtitle);
        }
        return wrap;
      },
    },
    {
      id: 'presets',
      label: 'Presets',
      sortType: 'number',
      getValue: (bank) => bank.presetCount,
      renderCell: (bank) => `${bank.presetCount} presets`,
    },
    {
      id: 'concordance',
      label: 'Concordancia',
      sortType: 'text',
      getValue: (bank) => {
        const state = bankConcordance(bank);
        if (state === 'concordant') return 'Concordante';
        if (state === 'repairable') return 'Carencias (reparable)';
        if (state === 'deficient') return 'Carencias';
        return 'Sin datos';
      },
      renderNode: (bank) => {
        const state = bankConcordance(bank);
        if (state === 'concordant') {
          const badge = document.createElement('span');
          badge.className = 'badge on';
          const label = bank.chunkPluginFourCc || (bank.chunkPluginId ? `ID ${bank.chunkPluginId}` : 'OK');
          badge.textContent = `Concordante (${label})`;
          if (bank.matchedWizardName) {
            badge.title = `Compatible con wizard: ${bank.matchedWizardName}`;
          }
          return badge;
        }
        if (state === 'repairable' || state === 'deficient') {
          const badge = document.createElement('span');
          badge.className = 'badge off';
          badge.textContent = state === 'repairable' ? 'Carencias (reparable)' : 'Carencias';
          badge.title = (bank.deficiencies ?? []).join('; ');
          return badge;
        }
        return null;
      },
    },
    {
      id: 'size',
      label: 'Tamaño',
      sortType: 'number',
      getValue: (bank) => bank.totalSizeBytes,
      renderCell: (bank) => formatBytes(bank.totalSizeBytes),
    },
    {
      id: 'target',
      label: 'En destino',
      sortType: 'text',
      getValue: (bank) => (bank.alreadyExistsInTarget ? 'Ya existe' : 'Nuevo'),
      renderNode: (bank) => {
        const badge = document.createElement('span');
        badge.className = bank.alreadyExistsInTarget ? 'badge' : 'badge on';
        badge.textContent = bank.alreadyExistsInTarget ? 'Ya existe' : 'Nuevo';
        return badge;
      },
    },
  ],
  getRowId: bankSelectionKey,
  initialSort: { columnId: 'name', direction: 'asc' },
  pageSize: 50,
  searchColumns: ['name'],
  tbodyId: 'import-package-banks-rows',
  emptyText: 'No se detectaron bancos en el origen.',
  filters: [
    {
      id: 'concordanceFilter',
      label: 'Concordancia',
      columnId: 'concordance',
      options: [
        { value: 'all', label: 'Toda la concordancia', tone: 'neutral' },
        { value: 'concordant', label: 'Concordante', tone: 'positive', predicate: (bank) => bankConcordance(bank) === 'concordant' },
        { value: 'repairable', label: 'Carencias (reparable)', tone: 'neutral', predicate: (bank) => bankConcordance(bank) === 'repairable' },
        { value: 'deficient', label: 'Carencias', tone: 'negative', predicate: (bank) => bankConcordance(bank) === 'deficient' },
        { value: 'unknown', label: 'Sin datos', tone: 'neutral', predicate: (bank) => bankConcordance(bank) === 'unknown' },
      ],
    },
  ],
};

/** Clave de selección de un banco: su carpeta de origen, o su nombre. */
function bankSelectionKey(bank: LibraryInspectPackageResponse['banks'][number]): string {
  return bank.sourceDir || bank.name;
}

/** Concordancia técnica de un banco, con los cuatro estados que pinta la tabla. */
function bankConcordance(
  bank: LibraryInspectPackageResponse['banks'][number],
): 'concordant' | 'repairable' | 'deficient' | 'unknown' {
  if (bank.isConcordant) return 'concordant';
  if (bank.deficiencies && bank.deficiencies.length > 0) {
    return bank.canRepair ? 'repairable' : 'deficient';
  }
  return 'unknown';
}

function renderImportPackageInspection(result: LibraryInspectPackageResponse): void {
  importPackageInspection = result;
  els.importPackagePreview.hidden = false;
  els.importPackageKind.textContent = result.resolvedKind === 'vfxlibrary' ? 'Paquete .vfxlibrary' : 'Carpeta de plugin';
  els.importPackageSource.textContent = result.sourcePath;

  currentInspectionPlugins = result.plugins;
  selectedImportPlugins = new Set(result.plugins.map((p) => p.sourceDir || p.name));
  els.importPackageAllPlugs.checked = true;

  if (importPackagePluginsTableController === null) {
    importPackagePluginsTableController = mountTable(
      els.importPackagePluginsTable,
      importPackagePluginsTableView,
      result.plugins,
    );
  } else {
    importPackagePluginsTableController.setRows(result.plugins);
  }

  currentInspectionBanks = result.banks;
  selectedImportBanks = new Set(result.banks.map(bankSelectionKey));

  if (importPackageBanksTableController === null) {
    importPackageBanksTableController = mountTable(
      els.importPackageBanksTable,
      importPackageBanksTableView,
      result.banks,
    );
  } else {
    importPackageBanksTableController.setRows(result.banks);
  }

  els.importPackageAllPlugs.checked = true;
  els.importPackageAllBanks.checked = true;
  els.importPackageStatus.textContent = `Inspección completada: ${result.plugins.length} plugin(s), ${result.banks.length} banco(s) detectados.`;
  els.importPackageStatus.className = 'status ok';
}

async function inspectPackage(): Promise<void> {
  const pkgPath = els.importPackagePath.value.trim();
  if (!pkgPath) {
    els.importPackageStatus.textContent = 'Escribe o elige la ruta del paquete o instrumento a importar.';
    els.importPackageStatus.className = 'status error';
    els.importPackagePath.focus();
    return;
  }
  if (!libraryRoot) {
    els.importPackageStatus.textContent = 'Debes tener seleccionada una librería activa de destino.';
    els.importPackageStatus.className = 'status error';
    return;
  }

  setImportPackageBusy(true);
  els.importPackageStatus.textContent = 'Inspeccionando origen…';
  els.importPackageStatus.className = 'status busy';

  try {
    const result = await client.library.inspectPackage({
      packagePath: pkgPath,
      targetLibraryRoot: libraryRoot,
    });
    renderImportPackageInspection(result);
  } catch (error) {
    els.importPackagePreview.hidden = true;
    importPackagePluginsTableController?.destroy();
    importPackagePluginsTableController = null;
    els.importPackagePluginsTable.replaceChildren();
    selectedImportPlugins.clear();
    currentInspectionPlugins = [];
    importPackageBanksTableController?.destroy();
    importPackageBanksTableController = null;
    els.importPackageBanksTable.replaceChildren();
    selectedImportBanks.clear();
    currentInspectionBanks = [];
    els.importPackageStatus.textContent = `Error al inspeccionar: ${describeError(error)}`;
    els.importPackageStatus.className = 'status error';
  } finally {
    setImportPackageBusy(false);
  }
}

async function executeImportPackage(): Promise<void> {
  if (!importPackageInspection || importPackageBusy) return;
  if (!libraryRoot) return;

  const pkgPath = els.importPackagePath.value.trim();
  const selectedPlugins = [...selectedImportPlugins];
  const selectedBanks = [...selectedImportBanks];

  if (selectedPlugins.length === 0 && selectedBanks.length === 0) {
    els.importPackageStatus.textContent = 'Selecciona al menos un plugin o un banco para importar.';
    els.importPackageStatus.className = 'status error';
    return;
  }

  const collisionPolicy = els.importPackagePolicy.value as 'skip' | 'overwrite';

  setImportPackageBusy(true);
  els.importPackageStatus.textContent = 'Importando elementos seleccionados a la librería…';
  els.importPackageStatus.className = 'status busy';

  try {
    const result = await client.library.importPackage({
      packagePath: pkgPath,
      targetLibraryRoot: libraryRoot,
      selectedPlugins,
      selectedBanks,
      collisionPolicy,
      repairBanks: els.importPackageRepair.checked,
    });

    const repairedMsg =
      (result as { repairedBanks?: string[] }).repairedBanks &&
      (result as { repairedBanks?: string[] }).repairedBanks!.length > 0
        ? ` Reparados: ${(result as { repairedBanks?: string[] }).repairedBanks!.length} banco(s).`
        : '';

    const msg =
      `Importación finalizada con éxito: ` +
      `${result.importedPlugins.length} plugins y ${result.importedBanks.length} bancos importados (${formatBytes(result.totalCopiedBytes)}).` +
      repairedMsg +
      (result.skippedPlugins.length > 0 || result.skippedBanks.length > 0
        ? ` Omitidos: ${result.skippedPlugins.length} plugins, ${result.skippedBanks.length} bancos.`
        : '');

    els.importPackageStatus.textContent = msg;
    els.importPackageStatus.className = 'status ok';

    // Refrescar plugins principales
    const scanResult = await fetchPlugins();
    render(scanResult);

    // Re-inspeccionar para actualizar estados
    await inspectPackage();
  } catch (error) {
    els.importPackageStatus.textContent = `Error durante la importación: ${describeError(error)}`;
    els.importPackageStatus.className = 'status error';
  } finally {
    setImportPackageBusy(false);
  }
}

/** Entrada de la auditoría durable: los cuatro `kind` que registra el servidor. */
type AssociationAuditEntry = AssociationAuditSnapshotResponse['entries'][number];

/** Etiqueta legible de cada tipo de evento; el valor crudo es el que filtra. */
const AUDIT_KIND_LABELS: Record<string, string> = {
  'association-change': 'Cambio de asociación',
  import: 'Importación',
  reimport: 'Reimportación',
  collision: 'Colisión',
};

/**
 * Visor de la auditoría durable de asociaciones: monta el snapshot de solo
 * lectura de `POST /library/association-audit/list` sobre `mountTable`, con el
 * rango de fechas por `ts` y el multiselección por `kind` que trae el sistema
 * de tablas. El orden, la búsqueda y la paginación se resuelven en cliente
 * sobre los hasta 200 eventos del snapshot.
 */
const associationAuditTableView: TableView<AssociationAuditEntry> = {
  columns: [
    {
      id: 'ts',
      label: 'Fecha',
      sortType: 'date',
      cellClass: 'table-date',
      getValue: (entry) => entry.ts,
      cellTitle: (entry) => entry.ts,
      renderCell: (entry) => logTimestamp(entry.ts) || '—',
    },
    {
      id: 'kind',
      label: 'Tipo',
      sortType: 'text',
      getValue: (entry) => entry.kind,
      cellTitle: (entry) => AUDIT_KIND_LABELS[entry.kind] ?? entry.kind,
      renderNode: (entry) => {
        const badge = document.createElement('span');
        badge.className =
          entry.kind === 'import'
            ? 'badge on'
            : entry.kind === 'collision'
              ? 'badge off'
              : 'badge';
        badge.textContent = AUDIT_KIND_LABELS[entry.kind] ?? entry.kind;
        return badge;
      },
    },
    {
      id: 'plugin',
      label: 'Plugin',
      sortType: 'text',
      getValue: (entry) => entry.plugin ?? '',
      cellTitle: (entry) => entry.plugin,
      renderCell: (entry) => entry.plugin || '—',
    },
    {
      id: 'change',
      label: 'Cambio',
      sortType: 'text',
      cellTitle: (entry) =>
        entry.field
          ? `${entry.field}: ${entry.previousValue ?? '—'} → ${entry.newValue ?? '—'}`
          : undefined,
      getValue: (entry) =>
        [entry.field, entry.previousValue, entry.newValue].filter(Boolean).join(' '),
      renderNode: (entry) => {
        if (!entry.field) return null;
        const wrap = document.createElement('div');
        const field = document.createElement('div');
        field.className = 'note';
        field.textContent = entry.field;
        const line = document.createElement('div');
        const from = document.createElement('code');
        from.textContent = entry.previousValue ?? '(vacío)';
        const to = document.createElement('code');
        to.textContent = entry.newValue ?? '(vacío)';
        line.append(from, document.createTextNode(' → '), to);
        wrap.append(field, line);
        return wrap;
      },
    },
    {
      id: 'source',
      label: 'Origen',
      sortType: 'text',
      getValue: (entry) => entry.packageSource ?? '',
      cellTitle: (entry) => entry.packageSource,
      renderCell: (entry) => entry.packageSource || '—',
    },
    {
      id: 'detail',
      label: 'Detalle',
      sortable: false,
      getValue: (entry) =>
        [
          entry.collisionPolicy ? `Política ${entry.collisionPolicy}` : '',
          ...(entry.collisionNames ?? []),
          ...(entry.repairedBanks ?? []),
        ]
          .filter(Boolean)
          .join(' '),
      renderNode: (entry) => {
        const parts: string[] = [];
        if (entry.collisionPolicy) {
          parts.push(`Política: ${entry.collisionPolicy === 'skip' ? 'omitir' : 'sobrescribir'}`);
        }
        if (entry.collisionNames && entry.collisionNames.length > 0) {
          parts.push(`Omitidos: ${entry.collisionNames.join(', ')}`);
        }
        if (entry.repairedBanks && entry.repairedBanks.length > 0) {
          parts.push(`Bancos reparados: ${entry.repairedBanks.join(', ')}`);
        }
        if (parts.length === 0) return null;
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = parts.join(' · ');
        return note;
      },
    },
  ],
  getRowId: (entry) =>
    `${entry.ts}|${entry.kind}|${entry.plugin ?? ''}|${entry.packageSource ?? ''}`,
  initialSort: { columnId: 'ts', direction: 'desc' },
  pageSize: 25,
  emptyText: 'Sin eventos de auditoría que cumplan los filtros.',
  filters: [
    {
      id: 'kindFilter',
      label: 'Tipo',
      columnId: 'kind',
      type: 'multi-select',
      getOptions: () =>
        (['association-change', 'import', 'reimport', 'collision'] as const).map((value) => ({
          value,
          label: AUDIT_KIND_LABELS[value] ?? value,
        })),
    },
    { id: 'tsFilter', label: 'Fecha', columnId: 'ts', type: 'date-range' },
  ],
};

let auditTableController: TableController<AssociationAuditEntry> | null = null;
let auditBusy = false;
/** Huella del último snapshot pintado: cambia cuando el almacén crece. */
let auditFingerprint = '';
let auditPollTimer: ReturnType<typeof setInterval> | null = null;

function destroyAssociationAuditTable(): void {
  auditTableController?.destroy();
  auditTableController = null;
  els.auditTable.replaceChildren();
}

function setAuditStatus(message: string, kind = ''): void {
  els.auditStatus.textContent = message;
  els.auditStatus.className = kind ? `status ${kind}` : 'status';
}

async function loadAssociationAudit(options?: { silent?: boolean }): Promise<void> {
  // La recarga silenciosa viene del sondeo con el cajón abierto: no pone el
  // estado «leyendo» ni vacía la tabla si el servidor falla un momento.
  const silent = options?.silent === true;
  if (auditBusy) return;
  if (!libraryRoot) {
    destroyAssociationAuditTable();
    els.auditPath.textContent = '';
    els.auditSummary.textContent = '';
    setAuditStatus('Elige la carpeta de la librería activa para leer su auditoría.', 'error');
    return;
  }

  auditBusy = true;
  els.auditRefresh.disabled = true;
  if (!silent) setAuditStatus('Leyendo el almacén de auditoría…', 'busy');
  try {
    // El filtro por plugin se manda al servidor: el snapshot trae los últimos
    // 200 eventos del fichero completo, así que estrecharlo en el navegador
    // solo vería esa cola y no el histórico.
    const plugin = els.auditPluginFilter.value.trim();
    const snapshot = await client.associationAudit.list({
      libraryRoot,
      limit: 200,
      ...(plugin === '' ? {} : { plugin }),
    });
    els.auditPath.textContent = snapshot.auditPath;
    els.auditSummary.textContent = snapshot.exists
      ? `${snapshot.total} evento(s) · ${formatBytes(snapshot.size)} en el almacén${
          plugin === '' ? '' : ` · filtrado por «${plugin}»`
        }`
      : 'Todavía no existe el almacén: lo creará la primera operación que audite.';
    if (auditTableController === null) {
      auditTableController = mountTable(els.auditTable, associationAuditTableView, snapshot.entries);
    } else {
      auditTableController.setRows(snapshot.entries);
    }
    auditFingerprint = `${snapshot.size}:${snapshot.total}:${snapshot.entries.length}`;
    setAuditStatus('');
  } catch (error) {
    if (!silent) {
      destroyAssociationAuditTable();
      els.auditPath.textContent = '';
      els.auditSummary.textContent = '';
    }
    setAuditStatus(`No se pudo leer la auditoría: ${describeError(error)}`, 'error');
  } finally {
    auditBusy = false;
    els.auditRefresh.disabled = false;
  }
}

/**
 * Con el cajón abierto, mira cada 2 s si el almacén ha crecido: el fichero es
 * un apéndice, así que basta comparar tamaño y total para detectar un evento
 * nuevo sin rehacer nada. Al cambiar la huella se recarga en silencio, y
 * `setRows` conserva el orden, los filtros y la página elegidos por el usuario.
 */
async function pollAssociationAudit(): Promise<void> {
  if (auditBusy || els.auditDrawer.hidden || !libraryRoot) return;
  const plugin = els.auditPluginFilter.value.trim();
  let fingerprint: string;
  try {
    const snapshot = await client.associationAudit.list({
      libraryRoot,
      limit: 200,
      ...(plugin === '' ? {} : { plugin }),
    });
    fingerprint = `${snapshot.size}:${snapshot.total}:${snapshot.entries.length}`;
  } catch {
    // El sondeo no interrumpe lo que se esté haciendo: el siguiente tic
    // reintenta, y si el fallo persiste lo dirá una recarga normal.
    return;
  }
  if (fingerprint === auditFingerprint) return;
  await loadAssociationAudit({ silent: true });
}

function startAuditPolling(): void {
  if (auditPollTimer !== null) return;
  auditPollTimer = setInterval(() => void pollAssociationAudit(), 2000);
}

function stopAuditPolling(): void {
  if (auditPollTimer === null) return;
  clearInterval(auditPollTimer);
  auditPollTimer = null;
}

function openAuditDrawer(opener?: HTMLElement): void {
  closeBanks();
  closeMeta();
  closeWizards();
  closePluginWizard();
  closeLogDrawer();
  closeImportPackageDrawer();
  closeCustomPluginDrawer();
  showPanel(els.auditDrawer, opener);
  els.auditPath.textContent = '';
  els.auditSummary.textContent = '';
  els.auditPluginFilter.value = '';
  destroyAssociationAuditTable();
  setAuditStatus('');
  auditFingerprint = '';
  startAuditPolling();
  void loadAssociationAudit();
}

function closeAuditDrawer(): void {
  if (els.auditDrawer.hidden) return;
  stopAuditPolling();
  hidePanel(els.auditDrawer);
  destroyAssociationAuditTable();
  els.auditPath.textContent = '';
  els.auditSummary.textContent = '';
  els.auditPluginFilter.value = '';
  auditFingerprint = '';
  setAuditStatus('');
}

els.auditNavBtn.addEventListener('click', () => {
  openAuditDrawer(els.auditNavBtn);
});

els.auditClose.addEventListener('click', () => {
  closeAuditDrawer();
});

els.auditRefresh.addEventListener('click', () => {
  void loadAssociationAudit();
});

// El filtro por plugin estrecha el snapshot en el servidor, tecleando: el
// mismo rebote que el filtro de wizards, y solo cuando el cajón está abierto.
let auditFilterTimeout: ReturnType<typeof setTimeout> | null = null;
els.auditPluginFilter.addEventListener('input', () => {
  if (auditFilterTimeout) clearTimeout(auditFilterTimeout);
  auditFilterTimeout = setTimeout(() => {
    auditFilterTimeout = null;
    if (!els.auditDrawer.hidden) void loadAssociationAudit();
  }, 300);
});

els.importPkgNavBtn.addEventListener('click', () => {
  requestOpenImportPackageDrawer(els.importPkgNavBtn);
});

els.importPackageClose.addEventListener('click', () => {
  closeImportPackageDrawer();
});

els.importPackageBrowse.addEventListener('click', async () => {
  try {
    const current = els.importPackagePath.value.trim();
    const start = current || (libraryRoot ? (parentDir(libraryRoot) ?? undefined) : undefined);
    const res = await client.system.pick({ kind: 'folder', title: 'Elegir carpeta o paquete a importar', initialDir: start });
    if (res.paths && res.paths.length > 0 && res.paths[0]) {
      els.importPackagePath.value = res.paths[0];
      void inspectPackage();
    }
  } catch (error) {
    els.importPackageStatus.textContent = `No se pudo abrir el selector: ${describeError(error)}`;
    els.importPackageStatus.className = 'status error';
  }
});

els.importPackageInspectBtn.addEventListener('click', () => {
  void inspectPackage();
});

els.importPackageExecuteBtn.addEventListener('click', () => {
  void executeImportPackage();
});

els.importPackageAllPlugs.addEventListener('change', () => {
  if (els.importPackageAllPlugs.checked) {
    for (const item of currentInspectionPlugins) {
      selectedImportPlugins.add(item.sourceDir || item.name);
    }
  } else {
    selectedImportPlugins.clear();
  }
  if (importPackagePluginsTableController) {
    importPackagePluginsTableController.setRows(currentInspectionPlugins);
  }
});

els.importPackageAllBanks.addEventListener('change', () => {
  if (els.importPackageAllBanks.checked) {
    for (const item of currentInspectionBanks) {
      selectedImportBanks.add(bankSelectionKey(item));
    }
  } else {
    selectedImportBanks.clear();
  }
  importPackageBanksTableController?.setRows(currentInspectionBanks);
});

els.drawerBackdrop.addEventListener('click', () => {
  closeBanks();
  closeMeta();
  closeWizards();
  closePluginWizard();
  closeLogDrawer();
  closeImportPackageDrawer();
  closeCustomPluginDrawer();
  closeAuditDrawer();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeBanks();
    closeMeta();
    closeWizards();
    closePluginWizard();
    closeLogDrawer();
    closeImportPackageDrawer();
    closeCustomPluginDrawer();
    closeAuditDrawer();
    closeAllRowMenus();
  }
});

// Diálogo modal: el Tab da la vuelta dentro del cajón abierto en vez de saltar
// a la página que queda tapada por el fondo.
window.addEventListener('keydown', (event) => {
  const panel = openPanel;
  if (event.key !== 'Tab' || panel === null) return;

  const items = panelFocusables(panel);
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) {
    event.preventDefault();
    panel.focus({ preventScroll: true });
    return;
  }

  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === panel || !panel.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
});

// El clic fuera de una tabla cierra sus menús «···» y los chips: lo lleva
// `mountTable`, que es quien los crea.

void pruneRecents();

if (libraryRoot) {
  void scan();
} else {
  setStatus('Elige la carpeta de la librería VFX para empezar.', 'info');
}
