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
  LibraryBanksImportResponse,
  LibraryBanksListResponse,
  LibraryScanResponse,
  RequestBody,
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

const STORAGE_ROOT = 'fxbLoader.libraryRoot';
const STORAGE_DLL = 'fxbLoader.dllSource';
const STORAGE_RECENT_ROOTS = 'fxbLoader.recentLibraryRoots';
const STORAGE_RECENT_DLLS = 'fxbLoader.recentDlls';
const STORAGE_RECENT_BANKS = 'fxbLoader.recentBanks';

type ScanPlugin = LibraryScanResponse['plugins'][number];
type ImportResults = LibraryBanksImportResponse['results'];
type ConfigSnapshot = LibraryBanksListResponse['config'];
type ExportOrder = RequestBody<'/library/banks/export', 'post'>['endianness'];

const els = {
  form: byId<HTMLFormElement>('scan-form'),
  root: byId<HTMLInputElement>('library-root'),
  rootRecents: byId<HTMLDataListElement>('library-root-recents'),
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
  tbody: byId<HTMLTableSectionElement>('plugins'),
  template: byId<HTMLTemplateElement>('row-template'),
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
  batchErrorsSummary: byId<HTMLElement>('batch-errors-summary'),
  batchErrorList: byId<HTMLUListElement>('batch-error-list'),
  banks: byId<HTMLElement>('banks'),
  banksTitle: byId<HTMLElement>('banks-plugin'),
  banksClose: byId<HTMLButtonElement>('banks-close'),
  banksPresets: byId<HTMLElement>('banks-presets'),
  banksExists: byId<HTMLElement>('banks-exists'),
  banksStatus: byId<HTMLParagraphElement>('banks-status'),
  banksRows: byId<HTMLTableSectionElement>('banks-rows'),
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
};

interface BanksState {
  pluginName: string;
  data: LibraryBanksListResponse;
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

els.root.value = libraryRoot;
els.dll.value = lastDll;
renderRecents();

function setStatus(message: string, kind = 'info'): void {
  els.status.textContent = message;
  els.status.className = `status ${kind}`;
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
  for (const button of els.tbody.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = value || button.dataset['blocked'] === 'true';
  }
  updateBatchControls();
}

function updateBatchControls(): void {
  const plugins = scanData?.plugins ?? [];
  const installable = plugins.filter(
    (plugin) => !plugin.installed && plugin.compatible === true,
  ).length;
  const installed = plugins.filter((plugin) => plugin.installed).length;

  els.installAll.textContent =
    installable === 0 ? 'Instalar todos' : `Instalar todos (${installable})`;
  els.installAll.disabled = busy || installable === 0;
  els.uninstallAll.textContent =
    installed === 0 ? 'Desinstalar todos' : `Desinstalar todos (${installed})`;
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
  els.batchResume.textContent = resume === null ? '' : resumeLabel(resume.plugins.length);
  els.batchResume.title =
    resume === null
      ? ''
      : `Reanudar solo los ${resume.plugins.length} plugin(s) que quedaron sin confirmar` +
        ' al cortarse el lote';
  els.batchResume.disabled = busy || resume === null;

  // Reintentar todos aparece solo mientras queden fallos del lote; el texto
  // lleva la cuenta para no tener que abrir el desplegable de errores.
  els.retryAll.hidden = batchFailures.length === 0;
  els.retryAll.textContent = `Reintentar fallidos (${batchFailures.length})`;
  els.retryAll.disabled = busy || batchFailures.length === 0;
  els.retryAll.title =
    batchFailures.length === 0
      ? ''
      : `Reintenta en orden los ${batchFailures.length} plugin(s) que fallaron, ` +
        'cada uno con su acción';

  els.batchErrors.hidden = batchFailures.length === 0;
  els.batchErrorsSummary.textContent =
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

/** Fila del plugin que el servidor está procesando, si sigue en la tabla. */
function batchRow(name: string): HTMLTableRowElement | null {
  for (const row of els.tbody.querySelectorAll<HTMLTableRowElement>('tr')) {
    if (query<HTMLElement>(row, '[data-field="name"]').textContent === name) return row;
  }
  return null;
}

/**
 * Marca la fila del plugin en curso y, al terminar, si salió bien o mal. El
 * resultado definitivo llega con el refresco posterior del escaneo.
 */
function markBatchRow(name: string, state: 'running' | 'done' | 'failed'): void {
  const row = batchRow(name);
  if (row === null) return;
  row.classList.toggle('batch-running', state === 'running');
  row.classList.toggle('batch-done', state === 'done');
  row.classList.toggle('batch-failed', state === 'failed');
  row.setAttribute('aria-busy', String(state === 'running'));
}

function clearBatchMarks(): void {
  for (const row of els.tbody.querySelectorAll<HTMLTableRowElement>('tr')) {
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
  const locked = banksBusy || banks === null || !banks.data.plugin.installed;
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
  for (const button of els.banksRows.querySelectorAll<HTMLButtonElement>('button')) {
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

function render(data: LibraryScanResponse): void {
  scanData = data;
  updateBatchControls();
  els.tbody.replaceChildren();
  els.results.hidden = false;

  const installed = data.plugins.filter((plugin) => plugin.installed).length;
  const incompatible = data.plugins.filter((plugin) => plugin.compatible === false).length;
  els.summary.textContent =
    data.plugins.length === 0
      ? 'No hay plugins en la librería'
      : `${installed} de ${data.plugins.length} con el cargador${
          incompatible === 0 ? '' : ` · ${incompatible} incompatible(s)`
        }`;
  els.plugsPath.textContent = data.plugsPath;
  renderLoader(data.loader);

  if (data.plugins.length === 0) {
    const row = document.createElement('tr');
    row.append(cell(6, 'La carpeta plugs\\ no contiene subdirectorios.'));
    els.tbody.append(row);
    return;
  }

  for (const plugin of data.plugins) {
    const row = cloneRow(els.template);
    const name = query<HTMLElement>(row, '[data-field="name"]');
    name.textContent = plugin.name;
    if (plugin.warnings.length > 0) name.title = plugin.warnings.join('\n');

    const badge = query<HTMLElement>(row, '[data-field="status"]');
    badge.textContent = plugin.installed ? 'instalado' : 'no instalado';
    badge.classList.toggle('on', plugin.installed);

    const compatibility = query<HTMLElement>(row, '[data-field="compatibility"]');
    compatibility.textContent =
      plugin.compatible === true
        ? 'compatible'
        : plugin.compatible === false
          ? 'incompatible'
          : 'sin verificar';
    compatibility.classList.toggle('on', plugin.compatible === true);
    compatibility.classList.toggle('bad', plugin.compatible === false);
    compatibility.title = plugin.compatibilityIssues.join('\n');

    query<HTMLElement>(row, '[data-field="pluginName"]').textContent = plugin.pluginName ?? '—';
    query<HTMLElement>(row, '[data-field="vfxinfo"]').textContent = plugin.hasVfxinfo
      ? 'presente'
      : 'falta';

    const banksButton = query<HTMLButtonElement>(row, '[data-action="banks"]');
    banksButton.title = `Ver los bancos de ${plugin.name}`;
    banksButton.addEventListener('click', () => {
      void openBanks(plugin);
    });

    const action = query<HTMLButtonElement>(row, '[data-action="toggle"]');
    const blocked = !plugin.installed && plugin.compatible === false;
    action.textContent = plugin.installed ? 'Desinstalar' : 'Instalar';
    action.classList.add(plugin.installed ? 'danger' : 'primary');
    action.disabled = blocked;
    action.dataset['blocked'] = String(blocked);
    if (blocked) {
      action.title = plugin.compatibilityIssues.join('\n');
    } else {
      action.title = plugin.installed
        ? `Desinstalar fxbLoader de ${plugin.name}`
        : `Instalar fxbLoader en ${plugin.name}`;
    }
    action.addEventListener('click', () => {
      void runAction(plugin, plugin.installed);
    });

    els.tbody.append(row);
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
    setStatus('Introduce la carpeta de la librería (debe contener plugs\\).', 'error');
    els.root.focus();
    return;
  }

  setBusy(true);
  setStatus('Escaneando…', 'busy');
  closeBanks();
  clearBatchErrors();
  scanData = null;
  updateBatchControls();
  try {
    const data = await fetchPlugins();
    render(data);
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
  if (action === 'uninstall') {
    return client.library.uninstall({ libraryRoot, plugin: plugin.name });
  }

  const body: RequestBody<'/library/install', 'post'> = {
    libraryRoot,
    plugin: plugin.name,
  };
  const dll = currentDll();
  if (dll !== '') body.dllSourcePath = dll;
  return client.library.install(body);
}

async function runAction(plugin: ScanPlugin, isInstalled: boolean): Promise<void> {
  if (busy) return;

  setBusy(true);
  setStatus(`${isInstalled ? 'Desinstalando' : 'Instalando'} ${plugin.name}…`, 'busy');

  try {
    await callAction(plugin, isInstalled ? 'uninstall' : 'install');

    if (banks?.pluginName === plugin.name) closeBanks();
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
    setStatus(`${isInstalled ? 'Desinstalado de' : 'Instalado en'} ${plugin.name}.`, 'ok');
  } catch (error) {
    setStatus(describeError(error), 'error');
  } finally {
    setBusy(false);
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
    badge.textContent = failure.action === 'install' ? 'instalar' : 'desinstalar';

    const message = document.createElement('p');
    message.textContent = failure.message;

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Reintentar';
    retry.title = `Reintentar ${
      failure.action === 'install' ? 'la instalación' : 'la desinstalación'
    } de ${failure.plugin.name}`;
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

  const isInstall = action === 'install';
  const eligible = scanData.plugins.filter((plugin) =>
    isInstall ? !plugin.installed && plugin.compatible === true : plugin.installed,
  );
  const plugins = resume === null ? eligible.map((plugin) => plugin.name) : [...resume];
  if (plugins.length === 0) {
    setBatchStatus(
      isInstall ? 'No hay plugins por instalar.' : 'No hay plugins instalados que desinstalar.',
      'info',
    );
    return;
  }

  closeBanks();
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
        status: retried
          ? failure.action === 'install'
            ? 'installed'
            : 'uninstalled'
          : 'failed',
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
      failure.action === 'install' ? 'instalado' : 'desinstalado'
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
  els.banksRows.replaceChildren();
  els.importResults.replaceChildren();
  hideImportProgress();
  els.exportBank.replaceChildren();
  els.loadFxb.checked = false;
}

function closeBanks(): void {
  if (els.banks.hidden) return;
  els.banks.hidden = true;
  banks = null;
  hideImportProgress();
  setBanksStatus('');
  syncBanksDisabled();
}

function renderBankRows(data: LibraryBanksListResponse): void {
  els.banksRows.replaceChildren();
  const current = data.config.config.defaultFxbName;

  if (data.banks.length === 0) {
    const row = document.createElement('tr');
    row.append(
      cell(
        7,
        data.presetsDirExists
          ? 'La carpeta de bancos está vacía; importa un .fxb.'
          : 'La carpeta de bancos aún no existe; se crea al importar un .fxb.',
      ),
    );
    els.banksRows.append(row);
    return;
  }

  for (const entry of data.banks) {
    const bank = entry.bank;
    const row = document.createElement('tr');
    if (entry.fileName === current) row.classList.add('is-default');

    const name = document.createElement('td');
    name.dataset['field'] = 'bank-name';
    name.textContent = entry.fileName;
    if (entry.fileName === current) {
      const badge = document.createElement('span');
      badge.className = 'badge on';
      badge.textContent = 'por defecto';
      name.append(' ', badge);
    }

    const kind = document.createElement('td');
    kind.textContent = bank.kind === 'FBCh' ? 'FBCh (opaco)' : 'FxBk';

    const programs = document.createElement('td');
    programs.textContent = String(bank.numPrograms);

    const uniqueId = document.createElement('td');
    uniqueId.textContent = bank.uniqueId;

    const version = document.createElement('td');
    version.textContent = String(bank.fxVersion);

    const size = document.createElement('td');
    size.textContent = formatBytes(entry.size);

    const actions = document.createElement('td');
    actions.className = 'actions';
    const use = document.createElement('button');
    use.type = 'button';
    use.textContent = 'Usar';
    if (entry.fileName === current) use.dataset['default'] = 'true';
    use.title = `Elegir ${entry.fileName} como banco por defecto`;
    use.addEventListener('click', () => {
      els.defaultBank.value = entry.fileName;
      void saveDefault(entry.fileName);
    });
    actions.append(use);

    row.append(name, kind, programs, uniqueId, version, size, actions);
    els.banksRows.append(row);
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

async function openBanks(plugin: ScanPlugin): Promise<void> {
  if (banksBusy) return;

  els.banks.hidden = false;
  clearBanksView(plugin.name);
  setBanksBusy(true);
  setBanksStatus('Leyendo los bancos…', 'busy');

  try {
    await fetchBanks(plugin.name);
    setBanksStatus(
      plugin.installed
        ? ''
        : 'El plugin no está instalado: puedes importar bancos, pero no fijar el banco por defecto hasta instalarlo.',
      plugin.installed ? 'info' : 'busy',
    );
    els.banks.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
        'La configuración cambió en disco (quizá la DLL la reescribió). Revisa los valores y vuelve a guardar.',
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
    item.className = `import-result ${result.status}`;

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
  void runBatch('install');
});

els.uninstallAll.addEventListener('click', () => {
  void runBatch('uninstall');
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

void pruneRecents();

if (libraryRoot) {
  void scan();
} else {
  setStatus('Elige la carpeta de la librería VFX para empezar.', 'info');
}
