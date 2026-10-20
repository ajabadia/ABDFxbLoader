'use strict';

const STORAGE_ROOT = 'fxbLoader.libraryRoot';
const STORAGE_DLL = 'fxbLoader.dllSource';

const els = {
  form: document.getElementById('scan-form'),
  root: document.getElementById('library-root'),
  dll: document.getElementById('dll-source'),
  scanButton: document.getElementById('scan-button'),
  status: document.getElementById('status'),
  results: document.getElementById('results'),
  summary: document.getElementById('summary-text'),
  plugsPath: document.getElementById('plugs-path'),
  loaderStatus: document.getElementById('loader-status'),
  tbody: document.getElementById('plugins'),
  template: document.getElementById('row-template'),
  installAll: document.getElementById('install-all'),
  uninstallAll: document.getElementById('uninstall-all'),
  batchStatus: document.getElementById('batch-status'),
  batchErrors: document.getElementById('batch-errors'),
  batchErrorsSummary: document.getElementById('batch-errors-summary'),
  batchErrorList: document.getElementById('batch-error-list'),
  banks: document.getElementById('banks'),
  banksTitle: document.getElementById('banks-plugin'),
  banksClose: document.getElementById('banks-close'),
  banksPresets: document.getElementById('banks-presets'),
  banksExists: document.getElementById('banks-exists'),
  banksStatus: document.getElementById('banks-status'),
  banksRows: document.getElementById('banks-rows'),
  defaultBank: document.getElementById('default-bank'),
  loadFxb: document.getElementById('load-fxb'),
  defaultSave: document.getElementById('default-save'),
  importPaths: document.getElementById('import-paths'),
  importOverwrite: document.getElementById('import-overwrite'),
  importButton: document.getElementById('import-button'),
  importResults: document.getElementById('import-results'),
};

function readStorage(key) {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeStorage(key, value) {
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
let scanData = null;
/** Fallos del último lote: `{ plugin, action, message }`. */
let batchFailures = [];
/** `{ pluginName, data }` del panel de bancos abierto, o `null`. */
let banks = null;

els.root.value = libraryRoot;
els.dll.value = readStorage(STORAGE_DLL);

function setStatus(message, kind = 'info') {
  els.status.textContent = message;
  els.status.className = `status ${kind}`;
}

function setBanksStatus(message, kind = 'info') {
  els.banksStatus.textContent = message;
  els.banksStatus.className = `status ${kind}`;
}

function setBusy(value) {
  busy = value;
  els.scanButton.disabled = value;
  els.form.setAttribute('aria-busy', String(value));
  for (const button of els.tbody.querySelectorAll('button')) {
    button.disabled = value || button.dataset.blocked === 'true';
  }
  updateBatchControls();
}

function setBatchStatus(message, kind = 'info') {
  els.batchStatus.textContent = message;
  els.batchStatus.className = `status ${kind}`;
}

function updateBatchControls() {
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

  els.batchErrors.hidden = batchFailures.length === 0;
  els.batchErrorsSummary.textContent =
    batchFailures.length === 1 ? '1 error' : `${batchFailures.length} errores`;
  for (const button of els.batchErrorList.querySelectorAll('button')) {
    button.disabled = busy;
  }
}

function clearBatchErrors() {
  batchFailures = [];
  els.batchErrorList.replaceChildren();
  els.batchErrors.hidden = true;
  els.batchErrors.open = false;
  setBatchStatus('');
  updateBatchControls();
}

/**
 * Deshabilita el panel mientras hay una petición en curso. Guardar la
 * configuración exige un plugin instalado: escribir `fxbLoader.config` a mano
 * haría que el escaneo lo marcase como instalado sin tener el DLL.
 */
function syncBanksDisabled() {
  const locked = banksBusy || banks === null || !banks.data.plugin.installed;
  els.banksClose.disabled = banksBusy;
  els.defaultBank.disabled = locked;
  els.loadFxb.disabled = locked;
  els.defaultSave.disabled = locked;
  els.importPaths.disabled = banksBusy;
  els.importOverwrite.disabled = banksBusy;
  els.importButton.disabled = banksBusy;
  for (const button of els.banksRows.querySelectorAll('button')) {
    button.disabled = locked || button.dataset.default === 'true';
  }
}

function setBanksBusy(value) {
  banksBusy = value;
  els.banks.setAttribute('aria-busy', String(value));
  syncBanksDisabled();
}

async function api(route, body, method = 'POST') {
  let response;
  try {
    response = await fetch(route, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`No se pudo contactar con el servidor: ${error.message}`);
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message =
      data && typeof data.message === 'string' ? data.message : `Error HTTP ${response.status}`;
    const issues = data && Array.isArray(data.issues) ? `\n${data.issues.join('\n')}` : '';
    const error = new Error(`${message}${issues}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function renderLoader(loader) {
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

function render(data) {
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
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'empty';
    cell.textContent = 'La carpeta plugs\\ no contiene subdirectorios.';
    row.append(cell);
    els.tbody.append(row);
    return;
  }

  for (const plugin of data.plugins) {
    const row = els.template.content.firstElementChild.cloneNode(true);
    const name = row.querySelector('[data-field="name"]');
    name.textContent = plugin.name;
    if (plugin.warnings && plugin.warnings.length > 0) {
      name.title = plugin.warnings.join('\n');
    }

    const badge = row.querySelector('[data-field="status"]');
    badge.textContent = plugin.installed ? 'instalado' : 'no instalado';
    badge.classList.toggle('on', plugin.installed);

    const compatibility = row.querySelector('[data-field="compatibility"]');
    compatibility.textContent =
      plugin.compatible === true
        ? 'compatible'
        : plugin.compatible === false
          ? 'incompatible'
          : 'sin verificar';
    compatibility.classList.toggle('on', plugin.compatible === true);
    compatibility.classList.toggle('bad', plugin.compatible === false);
    compatibility.title = (plugin.compatibilityIssues ?? []).join('\n');

    row.querySelector('[data-field="pluginName"]').textContent = plugin.pluginName ?? '—';
    row.querySelector('[data-field="vfxinfo"]').textContent = plugin.hasVfxinfo
      ? 'presente'
      : 'falta';

    const banksButton = row.querySelector('[data-action="banks"]');
    banksButton.title = `Ver los bancos de ${plugin.name}`;
    banksButton.addEventListener('click', () => {
      void openBanks(plugin);
    });

    const action = row.querySelector('[data-action="toggle"]');
    const blocked = !plugin.installed && plugin.compatible === false;
    action.textContent = plugin.installed ? 'Desinstalar' : 'Instalar';
    action.classList.add(plugin.installed ? 'danger' : 'primary');
    action.disabled = blocked;
    action.dataset.blocked = String(blocked);
    if (blocked) {
      action.title = (plugin.compatibilityIssues ?? []).join('\n');
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

function currentDll() {
  return els.dll.value.trim();
}

async function fetchPlugins() {
  const body = { libraryRoot };
  if (currentDll()) body.dllSourcePath = currentDll();
  return api('/library/scan', body);
}

async function scan() {
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
    setStatus(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function callAction(plugin, action) {
  if (action === 'uninstall') {
    return api('/library/uninstall', { libraryRoot, plugin: plugin.name });
  }

  const body = { libraryRoot, plugin: plugin.name };
  if (currentDll()) body.dllSourcePath = currentDll();
  return api('/library/install', body);
}

async function runAction(plugin, isInstalled) {
  if (busy) return;

  setBusy(true);
  setStatus(`${isInstalled ? 'Desinstalando' : 'Instalando'} ${plugin.name}…`, 'busy');

  try {
    await callAction(plugin, isInstalled ? 'uninstall' : 'install');

    if (banks && banks.pluginName === plugin.name) closeBanks();
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
    setStatus(
      `${isInstalled ? 'Desinstalado de' : 'Instalado en'} ${plugin.name}.`,
      'ok',
    );
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ */
/* Lotes: instalar/desinstalar todos los plugins escaneados            */
/* ------------------------------------------------------------------ */

function renderBatchErrors() {
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
    retry.title = `Reintentar ${failure.action === 'install' ? 'la instalación' : 'la desinstalación'} de ${failure.plugin.name}`;
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

async function runBatch(action) {
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
  setBusy(true);

  const verb = isInstall ? 'Instalando' : 'Desinstalando';

  // Secuencial a propósito: el instalador escribe en el mismo árbol y así el
  // progreso y el resumen son deterministas. Cada plugin tiene su reintento.
  const result = await FxbBatch.runBatch({
    action,
    plugins: eligible,
    callAction,
    onProgress: ({ index, total, plugin }) => {
      setBatchStatus(`${verb} ${index + 1}/${total}: ${plugin.name}…`, 'busy');
    },
  });
  batchFailures = result.failures;

  try {
    const data = await fetchPlugins();
    render(data);
  } catch (error) {
    setBatchStatus(`Terminó el lote, pero no se pudo refrescar la lista: ${error.message}`, 'error');
    renderBatchErrors();
    setBusy(false);
    return;
  }

  const failed = result.failures.length;
  const summary = FxbBatch.summarize(result);
  setBatchStatus(summary, failed === 0 ? 'ok' : 'error');
  setStatus(summary, failed === 0 ? 'ok' : 'error');
  renderBatchErrors();
  setBusy(false);
}

async function retryFailure(failure) {
  if (busy) return;

  setBusy(true);
  setBatchStatus(`Reintentando ${failure.plugin.name}…`, 'busy');

  try {
    await FxbBatch.callWithRetry(callAction, failure.plugin, failure.action);
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
    failure.message = error.message;
    renderBatchErrors();
    setBatchStatus(`Sigue fallando ${failure.plugin.name}.`, 'error');
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ */
/* Bancos por plugin                                                   */
/* ------------------------------------------------------------------ */

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function clearBanksView(pluginName) {
  els.banksTitle.textContent = pluginName;
  els.banksPresets.textContent = '';
  els.banksExists.textContent = '';
  els.defaultBank.replaceChildren();
  els.banksRows.replaceChildren();
  els.importResults.replaceChildren();
  els.loadFxb.checked = false;
}

function closeBanks() {
  if (els.banks.hidden) return;
  els.banks.hidden = true;
  banks = null;
  setBanksStatus('');
  syncBanksDisabled();
}

function renderBankRows(data) {
  els.banksRows.replaceChildren();
  const current = data.config.config.defaultFxbName;

  if (data.banks.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.className = 'empty';
    cell.textContent = data.presetsDirExists
      ? 'La carpeta de bancos está vacía; importa un .fxb.'
      : 'La carpeta de bancos aún no existe; se crea al importar un .fxb.';
    row.append(cell);
    els.banksRows.append(row);
    return;
  }

  for (const entry of data.banks) {
    const bank = entry.bank;
    const row = document.createElement('tr');
    if (entry.fileName === current) row.classList.add('is-default');

    const name = document.createElement('td');
    name.dataset.field = 'bank-name';
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
    if (entry.fileName === current) use.dataset.default = 'true';
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

function renderDefaultOptions(data, keepSelection) {
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
  if (current && !names.includes(current)) {
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

function renderBanks(options = {}) {
  const { keepSelection = false } = options;
  if (banks === null) return;

  const { pluginName, data } = banks;
  els.banksTitle.textContent = pluginName;
  els.banksPresets.textContent = data.presetsDir;
  els.banksExists.textContent = data.presetsDirExists
    ? ''
    : '(aún no existe: se crea al importar)';

  renderDefaultOptions(data, keepSelection);
  renderBankRows(data);
  syncBanksDisabled();
}

async function fetchBanks(pluginName, options = {}) {
  const data = await api('/library/banks/list', { libraryRoot, plugin: pluginName });
  banks = { pluginName, data };
  renderBanks(options);
  return data;
}

async function openBanks(plugin) {
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
    setBanksStatus(error.message, 'error');
  } finally {
    setBanksBusy(false);
  }
}

async function saveDefault(fileName) {
  if (banks === null || banksBusy) return;

  const { pluginName, data } = banks;
  setBanksBusy(true);
  setBanksStatus('Guardando el banco por defecto…', 'busy');

  try {
    const snapshot = await api(
      '/fxb-config',
      {
        pluginDir: data.plugin.path,
        expectedMtimeMs: data.config.mtimeMs,
        config: { defaultFxbName: fileName, loadFxbBank: els.loadFxb.checked },
      },
      'PUT',
    );
    data.config = snapshot;
    renderBanks();
    setBanksStatus(
      fileName === ''
        ? 'Sin banco por defecto.'
        : `Banco por defecto de ${pluginName}: ${fileName}.`,
      'ok',
    );
  } catch (error) {
    if (error.status === 409 && error.data && error.data.current) {
      data.config = error.data.current;
      renderBanks();
      setBanksStatus(
        'La configuración cambió en disco (quizá la DLL la reescribió). Revisa los valores y vuelve a guardar.',
        'error',
      );
    } else {
      setBanksStatus(error.message, 'error');
    }
  } finally {
    setBanksBusy(false);
  }
}

function readImportPaths() {
  const seen = new Set();
  const paths = [];
  for (const line of els.importPaths.value.split('\n')) {
    let value = line.trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    paths.push(value);
  }
  return paths;
}

function renderImportResults(results) {
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

    const detail = result.reason ?? (result.issues && result.issues.join('; '));
    if (detail) {
      const text = document.createElement('p');
      text.className = 'import-detail';
      text.textContent = detail;
      item.append(text);
    }

    els.importResults.append(item);
  }
}

async function importBanks() {
  if (banks === null || banksBusy) return;

  const sourcePaths = readImportPaths();
  if (sourcePaths.length === 0) {
    setBanksStatus('Escribe al menos una ruta absoluta de un .fxb.', 'error');
    els.importPaths.focus();
    return;
  }

  const { pluginName, data } = banks;
  setBanksBusy(true);
  setBanksStatus(`Importando ${sourcePaths.length} archivo(s)…`, 'busy');
  els.importResults.replaceChildren();

  try {
    const response = await api('/library/banks/import', {
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
    setBanksStatus(error.message, 'error');
    if (error.data && Array.isArray(error.data.results)) {
      renderImportResults(error.data.results);
    }
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

els.banksClose.addEventListener('click', () => {
  closeBanks();
});

els.defaultSave.addEventListener('click', () => {
  void saveDefault(els.defaultBank.value);
});

els.importButton.addEventListener('click', () => {
  void importBanks();
});

if (libraryRoot) {
  void scan();
} else {
  setStatus('Elige la carpeta de la librería VFX para empezar.', 'info');
}
