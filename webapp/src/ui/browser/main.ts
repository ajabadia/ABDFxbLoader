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
import {
  cancelledSummary,
  failuresOf,
  progressLabel,
  runBatchInChunks,
  stepLabel,
  summarize,
  type BatchAction,
  type BatchFailure,
  type BatchPlugin,
  type BatchProgress,
} from '../batch.js';
import { client, describeError, isFxbApiError } from './api.js';
import { byId, cell, cloneRow, query } from './dom.js';

const STORAGE_ROOT = 'fxbLoader.libraryRoot';
const STORAGE_DLL = 'fxbLoader.dllSource';

type ScanPlugin = LibraryScanResponse['plugins'][number];
type ImportResults = LibraryBanksImportResponse['results'];
type ConfigSnapshot = LibraryBanksListResponse['config'];
type ExportOrder = RequestBody<'/library/banks/export', 'post'>['endianness'];

const els = {
  form: byId<HTMLFormElement>('scan-form'),
  root: byId<HTMLInputElement>('library-root'),
  dll: byId<HTMLInputElement>('dll-source'),
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
  batchStatus: byId<HTMLParagraphElement>('batch-status'),
  batchProgress: byId<HTMLProgressElement>('batch-progress'),
  batchStep: byId<HTMLElement>('batch-step'),
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
  importPaths: byId<HTMLTextAreaElement>('import-paths'),
  importOverwrite: byId<HTMLInputElement>('import-overwrite'),
  importButton: byId<HTMLButtonElement>('import-button'),
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

let libraryRoot = readStorage(STORAGE_ROOT);
let busy = false;
let banksBusy = false;
/** Último resultado de `/library/scan`, o `null` si aún no hay lista. */
let scanData: LibraryScanResponse | null = null;
/** Fallos del último lote, con su reintento individual. */
let batchFailures: BatchFailure[] = [];
/** Corta el lote en curso; `null` cuando no hay ninguno. */
let batchController: AbortController | null = null;
/** Panel de bancos abierto, o `null`. */
let banks: BanksState | null = null;

els.root.value = libraryRoot;
els.dll.value = readStorage(STORAGE_DLL);

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

function setBusy(value: boolean): void {
  busy = value;
  els.scanButton.disabled = value;
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

  els.batchErrors.hidden = batchFailures.length === 0;
  els.batchErrorsSummary.textContent =
    batchFailures.length === 1 ? '1 error' : `${batchFailures.length} errores`;
  for (const button of els.batchErrorList.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = busy;
  }
}

/** Oculta la barra de progreso del lote y la deja a cero. */
function hideBatchProgress(): void {
  els.batchProgress.hidden = true;
  els.batchProgress.value = 0;
  els.batchProgress.max = 1;
  els.batchStep.hidden = true;
  els.batchStep.textContent = '';
}

/** Barra, texto y paso interno del progreso en caliente. */
function showBatchProgress(progress: BatchProgress): void {
  els.batchProgress.hidden = false;
  els.batchProgress.max = Math.max(progress.total, 1);
  els.batchProgress.value = progress.done;

  const step = stepLabel(progress);
  els.batchStep.hidden = step === null;
  els.batchStep.textContent = step ?? '';

  if (!progress.finished) setBatchStatus(progressLabel(progress), 'busy');
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

function clearBatchErrors(): void {
  batchFailures = [];
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
  // Sin respaldo no hay nada que restaurar: el servidor devolvería un 409.
  els.defaultRestore.disabled = locked || banks === null || banks.data.defaultBackup === null;
  els.importPaths.disabled = banksBusy;
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

async function runBatch(action: BatchAction): Promise<void> {
  if (busy || scanData === null) return;

  const isInstall = action === 'install';
  const eligible = scanData.plugins.filter((plugin) =>
    isInstall ? !plugin.installed && plugin.compatible === true : plugin.installed,
  );
  if (eligible.length === 0) {
    setBatchStatus(
      isInstall ? 'No hay plugins por instalar.' : 'No hay plugins instalados que desinstalar.',
      'info',
    );
    return;
  }

  closeBanks();
  clearBatchErrors();
  const controller = new AbortController();
  batchController = controller;
  setBusy(true);

  const dll = currentDll();
  // El servidor recorre cada petición en serie y va contando qué plugin procesa
  // (`start`, `plugin`, `end`); un fallo individual no detiene al resto. Como
  // rechaza más plugins por petición que el tope, el lote se manda troceado y
  // el avance de todos los trozos se pinta en la misma barra.
  const run = await runBatchInChunks({
    action,
    plugins: eligible.map((plugin) => plugin.name),
    signal: controller.signal,
    send: (plugins, onEvent) => {
      const body: RequestBody<'/library/batch/stream', 'post'> = { libraryRoot, action, plugins };
      if (isInstall && dll !== '') body.dllSourcePath = dll;
      // La señal aborta el `fetch` en curso; el servidor deja de procesar en
      // cuanto se cierra la respuesta (acaba el plugin que tenía entre manos).
      return client.library.batchStream(body, { onEvent, signal: controller.signal });
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

  batchFailures = failuresOf(run);

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

function clearBanksView(pluginName: string): void {
  els.banksTitle.textContent = pluginName;
  els.banksPresets.textContent = '';
  els.banksExists.textContent = '';
  els.defaultBank.replaceChildren();
  els.banksRows.replaceChildren();
  els.importResults.replaceChildren();
  els.exportBank.replaceChildren();
  els.loadFxb.checked = false;
}

function closeBanks(): void {
  if (els.banks.hidden) return;
  els.banks.hidden = true;
  banks = null;
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

async function importBanks(): Promise<void> {
  if (banks === null || banksBusy) return;

  const sourcePaths = readImportPaths();
  if (sourcePaths.length === 0) {
    setBanksStatus('Escribe al menos una ruta absoluta de un .fxb.', 'error');
    els.importPaths.focus();
    return;
  }

  const { pluginName } = banks;
  setBanksBusy(true);
  setBanksStatus(`Importando ${sourcePaths.length} archivo(s)…`, 'busy');
  els.importResults.replaceChildren();

  try {
    const response = await client.library.importBanks({
      libraryRoot,
      plugin: pluginName,
      sourcePaths,
      overwrite: els.importOverwrite.checked,
    });

    renderImportResults(response.results);
    const imported = response.results.filter((item) => item.status !== 'rejected');
    const rejected = response.results.length - imported.length;

    await fetchBanks(pluginName, { keepSelection: true });
    setBanksStatus(
      rejected === 0
        ? `${imported.length} banco(s) importados.`
        : `${imported.length} importado(s), ${rejected} rechazado(s).`,
      rejected === 0 ? 'ok' : 'error',
    );
  } catch (error) {
    setBanksStatus(describeError(error), 'error');
    const body = isFxbApiError(error) ? (error.body as { results?: ImportResults } | null) : null;
    if (body !== null && Array.isArray(body.results)) {
      renderImportResults(body.results);
    }
  } finally {
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
  void scan();
});

els.dll.addEventListener('input', () => {
  writeStorage(STORAGE_DLL, currentDll());
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

els.importButton.addEventListener('click', () => {
  void importBanks();
});

els.exportButton.addEventListener('click', () => {
  void exportBank();
});

if (libraryRoot) {
  void scan();
} else {
  setStatus('Elige la carpeta de la librería VFX para empezar.', 'info');
}
