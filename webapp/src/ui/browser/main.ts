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
  LibraryAuditResponse,
  LibraryBanksImportResponse,
  LibraryBanksListResponse,
  LibraryCreateCustomPluginResponse,
  LibraryInspectDllResponse,
  LibraryInspectPackageResponse,
  LibraryScanResponse,
  PluginLogSnapshotResponse,
  PluginMetaSnapshotResponse,
  RequestBody,
  SystemCapabilitiesResponse,
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
import {
  classifyStagingFiles,
  formatPreExistingSummary,
  formatRemovePreExistingResult,
  formatRestorePreExistingResult,
  formatRestoreStagedFileResult,
  formatRevealPreExistingResult,
  preExistingListLabel,
  removedStagingNote,
  removePreExistingLabel,
  restorePreExistingLabel,
  restoreStagedFileLabel,
  revealPreExistingLabel,
} from '../capture.js';
import { client, describeError, isFxbApiError } from './api.js';
import { byId } from './dom.js';
import { mountTable, closeAllRowMenus, type TableController, type TableView } from '../table.js';

import {
  applyI18n,
  getLocale,
  initAppI18n,
  onLocaleChange,
  setLocale,
  syncDocumentLang,
  t,
  type Locale,
} from '../i18n/index.js';

const STORAGE_ROOT = 'fxbLoader.libraryRoot';
const STORAGE_DLL = 'fxbLoader.dllSource';
const STORAGE_RECENT_ROOTS = 'fxbLoader.recentLibraryRoots';
const STORAGE_RECENT_DLLS = 'fxbLoader.recentDlls';
const STORAGE_RECENT_BANKS = 'fxbLoader.recentBanks';
const STORAGE_CAPTURE_TASK = 'fxbLoader.captureTask';

type ScanPlugin = LibraryScanResponse['plugins'][number];
type ImportResults = LibraryBanksImportResponse['results'];
type ImportResult = ImportResults[number];
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
  rootRecentWrap: byId<HTMLElement>('library-root-recent-wrap'),
  rootRecentSelect: byId<HTMLSelectElement>('library-root-recent-select'),
  rootWarning: byId<HTMLParagraphElement>('root-warning'),
  rootBrowse: byId<HTMLButtonElement>('root-browse'),
  dll: byId<HTMLInputElement>('dll-source'),
  dllRecents: byId<HTMLDataListElement>('dll-source-recents'),
  dllRecentWrap: byId<HTMLElement>('dll-source-recent-wrap'),
  dllRecentSelect: byId<HTMLSelectElement>('dll-source-recent-select'),
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
  batchErrorList: byId<HTMLElement>('batch-error-list'),
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
  importResults: byId<HTMLElement>('import-results'),
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
  pluginWizardCreateWrap: byId<HTMLElement>('plugin-wizard-create-wrap'),
  pluginWizardCreateBtn: byId<HTMLButtonElement>('plugin-wizard-create-btn'),
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
  settingsNavBtn: byId<HTMLButtonElement>('settings-nav-btn'),
  settingsDrawer: byId<HTMLElement>('settings-drawer'),
  settingsClose: byId<HTMLButtonElement>('settings-close'),
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
  auditPath: byId<HTMLElement>('audit-path'),
  auditSummary: byId<HTMLElement>('audit-summary'),
  auditTable: byId<HTMLElement>('audit-table'),
  auditStatus: byId<HTMLParagraphElement>('audit-status'),
  auditDetail: byId<HTMLElement>('audit-record-detail'),
  auditDetailTitle: byId<HTMLElement>('audit-record-detail-title'),
  auditDetailFields: byId<HTMLElement>('audit-record-detail-fields'),
  auditDetailClose: byId<HTMLButtonElement>('audit-record-detail-close'),
  dataAuditNavBtn: byId<HTMLButtonElement>('data-audit-nav-btn'),
  dataAuditDrawer: byId<HTMLElement>('data-audit-drawer'),
  dataAuditClose: byId<HTMLButtonElement>('data-audit-close'),
  dataAuditRefresh: byId<HTMLButtonElement>('data-audit-refresh'),
  dataAuditPath: byId<HTMLElement>('data-audit-path'),
  dataAuditSummary: byId<HTMLElement>('data-audit-summary'),
  dataAuditTable: byId<HTMLElement>('data-audit-table'),
  dataAuditStatus: byId<HTMLParagraphElement>('data-audit-status'),
  dataAuditDetail: byId<HTMLElement>('data-audit-detail'),
  dataAuditDetailTitle: byId<HTMLElement>('data-audit-detail-title'),
  dataAuditDetailFields: byId<HTMLElement>('data-audit-detail-fields'),
  dataAuditDetailGaps: byId<HTMLElement>('data-audit-detail-gaps'),
  dataAuditDetailProposals: byId<HTMLElement>('data-audit-detail-proposals'),
  dataAuditDetailClose: byId<HTMLButtonElement>('data-audit-detail-close'),
  dataAuditApply: byId<HTMLButtonElement>('data-audit-apply'),
  dataAuditApplyConfirm: byId<HTMLElement>('data-audit-apply-confirm'),
  dataAuditApplyNote: byId<HTMLElement>('data-audit-apply-note'),
  dataAuditApplyList: byId<HTMLElement>('data-audit-apply-list'),
  dataAuditApplyConfirmBtn: byId<HTMLButtonElement>('data-audit-apply-confirm-btn'),
  dataAuditApplyCancel: byId<HTMLButtonElement>('data-audit-apply-cancel'),
  dataAuditApplyStatus: byId<HTMLParagraphElement>('data-audit-apply-status'),
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
  // Capture
  captureNavBtn: byId<HTMLButtonElement>('capture-nav-btn'),
  captureDrawer: byId<HTMLElement>('capture-drawer'),
  captureClose: byId<HTMLButtonElement>('capture-close'),
  captureStartBtn: byId<HTMLButtonElement>('capture-start-btn'),
  captureStopBtn: byId<HTMLButtonElement>('capture-stop-btn'),
  captureLiveIndicator: byId<HTMLElement>('capture-live-indicator'),
  captureLiveMessage: byId<HTMLElement>('capture-live-message'),
  captureProgressWrap: byId<HTMLElement>('capture-progress-wrap'),
  captureProgressBar: byId<HTMLElement>('capture-progress-bar'),
  captureProgressCount: byId<HTMLElement>('capture-progress-count'),
  captureProgressRoot: byId<HTMLElement>('capture-progress-root'),
  captureProgressNative: byId<HTMLProgressElement>('capture-progress-native'),
  captureLogState: byId<HTMLElement>('capture-log-state'),
  captureFinishBtn: byId<HTMLButtonElement>('capture-finish-btn'),
  capturePackageBtn: byId<HTMLButtonElement>('capture-package-btn'),
  captureVmachineBtn: byId<HTMLButtonElement>('capture-vmachine-btn'),
  captureIncludeExisting: byId<HTMLInputElement>('capture-include-existing'),
  capturePreExistingSummary: byId<HTMLElement>('capture-pre-existing-summary'),
  capturePreExistingDetails: byId<HTMLDetailsElement>('capture-pre-existing-details'),
  capturePreExistingDetailsLabel: byId<HTMLElement>('capture-pre-existing-details-label'),
  capturePreExistingList: byId<HTMLUListElement>('capture-pre-existing-list'),
  captureRefreshStagingBtn: byId<HTMLButtonElement>('capture-refresh-staging-btn'),
  captureRemovePreExistingBtn: byId<HTMLButtonElement>('capture-remove-pre-existing-btn'),
  captureRemovePreExistingLabel: byId<HTMLElement>('capture-remove-pre-existing-label'),
  captureRestorePreExistingBtn: byId<HTMLButtonElement>('capture-restore-pre-existing-btn'),
  captureRestorePreExistingLabel: byId<HTMLElement>('capture-restore-pre-existing-label'),
  captureStep1Status: byId<HTMLElement>('capture-step1-status'),
  captureStep2Status: byId<HTMLElement>('capture-step2-status'),
  captureStep3Status: byId<HTMLElement>('capture-step3-status'),
  captureStep4Status: byId<HTMLElement>('capture-step4-status'),
  captureStartInfo: byId<HTMLElement>('capture-start-info'),
  captureSnapshotBefore: byId<HTMLElement>('capture-snapshot-before'),
  captureSnapshotSummary: byId<HTMLElement>('capture-snapshot-summary'),
  captureViewSnapshotBtn: byId<HTMLButtonElement>('capture-view-snapshot-btn'),
  captureDownloadSnapshotBtn: byId<HTMLButtonElement>('capture-download-snapshot-btn'),
  captureSnapshotDialog: byId<HTMLDialogElement>('capture-snapshot-dialog'),
  captureSnapshotDialogClose: byId<HTMLButtonElement>('capture-snapshot-dialog-close'),
  captureSnapshotDialogSummary: byId<HTMLElement>('capture-snapshot-dialog-summary'),
  captureSnapshotContent: byId<HTMLPreElement>('capture-snapshot-content'),
  captureFinishInfo: byId<HTMLElement>('capture-finish-info'),
  captureDiffId: byId<HTMLElement>('capture-diff-id'),
  captureFilesAdded: byId<HTMLElement>('capture-files-added'),
  captureFilesModified: byId<HTMLElement>('capture-files-modified'),
  captureFilesDeleted: byId<HTMLElement>('capture-files-deleted'),
  captureRegistryCount: byId<HTMLElement>('capture-registry-count'),
  captureStagingInfo: byId<HTMLElement>('capture-staging-info'),
  captureStagingCount: byId<HTMLElement>('capture-staging-count'),
  captureStagingList: byId<HTMLElement>('capture-staging-list'),
  capturePluginName: byId<HTMLInputElement>('capture-plugin-name'),
  capturePluginVendor: byId<HTMLInputElement>('capture-plugin-vendor'),
  captureVmachineInfo: byId<HTMLElement>('capture-vmachine-info'),
  captureVmachinePath: byId<HTMLElement>('capture-vmachine-path'),
  captureWizardPath: byId<HTMLElement>('capture-wizard-path'),
  captureLog: byId<HTMLElement>('capture-log'),
  captureStatus: byId<HTMLParagraphElement>('capture-status'),
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
/** Tabla de los fallos del lote, montada sobre `mountTable`. */
let batchErrorsTableController: TableController<BatchFailure> | null = null;
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
/** Tabla de los resultados de importación, montada sobre `mountTable`. */
let importResultsTableController: TableController<ImportResult> | null = null;
let metaState: MetaState | null = null;
let logTableController: TableController<PluginLogSnapshotResponse['entries'][number]> | null = null;
let logDetailOpener: HTMLButtonElement | null = null;
let metaBusy = false;
let wizardsTableController: TableController<WizardListResponse['items'][number]> | null = null;

/** Orden actual del repositorio de wizards: el servidor ordena, la tabla lo replica. */
let wizardsSort: { columnId: string; direction: 'asc' | 'desc' } = { columnId: 'name', direction: 'asc' };
/** Última búsqueda enviada al servidor; el reordenar sobre ella lanza una recarga. */
let wizardsQuery = '';

// Capture state
let captureSnapshotBeforeId: string | null = null;
let captureDiffId: string | null = null;
let captureTaskId: string | null = readStorage(STORAGE_CAPTURE_TASK) || null;
let captureTaskPoll: ReturnType<typeof setInterval> | null = null;
let capturePollInFlight = false;
let captureLastProgressLogAt = 0;
let captureLastProgressMessage = '';
let captureLastProgressEntries = -1;
let captureLastPollErrorAt = 0;
let captureTaskKind: 'start' | 'finish' | null = null;
let captureSessionInitialized = false;
let captureSnapshotText = '';
let captureStagingLoaded = false;
/** Archivos previos del snapshot inicial que entrarían en el paquete; `null` hasta consultarlo. */
let capturePreExistingCount: number | null = null;
/** Aviso del servidor al contar los previos (snapshot inicial perdido, por ejemplo). */
let capturePreExistingWarning = '';
/** Rutas de esos archivos previos, para marcarlos en el staging. */
let capturePreExistingFiles: string[] = [];
/** De los anteriores, los que siguen en el staging: es lo que quita «Quitar previos». */
let captureStagedPreExisting: string[] = [];
/** De los anteriores, los que se quitaron y aún se pueden devolver con «Recuperar previos». */
let captureRestorablePreExisting = 0;
/** Rutas de esos previos quitados, para poder devolver uno solo desde su fila. */
let captureRestorableFiles: string[] = [];

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
 * Desplegable de rutas usadas: la alternativa de selección al campo de texto.
 * Sin historial no se enseña nada, y la opción de cabecera deja el campo como
 * esté: elegir una ruta del historial la escribe en el campo y la usa.
 */
function renderRecentSelect(
  wrap: HTMLElement,
  select: HTMLSelectElement,
  values: readonly string[],
  current: string,
  placeholder: string,
): void {
  wrap.hidden = values.length === 0;
  select.replaceChildren();
  if (values.length === 0) return;

  const head = document.createElement('option');
  head.value = '';
  head.textContent = placeholder;
  select.append(head);

  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.append(option);
  }

  select.value = values.includes(current) ? current : '';
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
          ? t('ui.recents.alreadyInList')
          : t('ui.recents.added', { 0: chip.textContent }),
        els.importPaths.value === before ? 'info' : 'ok',
      );
      els.importPaths.focus();
    });

    // Quita solo esta sugerencia; el resto de la fila no se toca.
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'recent-chip-remove';
    forget.textContent = '×';
    forget.title = t('ui.recents.forgetTitle', { 0: name });
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
  clear.title = t('ui.recents.forgetAllTitle');
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
  setBanksStatus(t('ui.recents.forgotten', { 0: bankName(bankPath) }), 'ok');
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
  setBanksStatus(t('ui.recents.allForgotten'), 'ok');
}

function renderRecents(): void {
  renderDatalist(els.rootRecents, recentRoots);
  renderDatalist(els.dllRecents, recentDlls);
  renderRecentSelect(
    els.rootRecentWrap,
    els.rootRecentSelect,
    recentRoots,
    els.root.value.trim(),
    t('ui.recents.chooseRoot'),
  );
  renderRecentSelect(
    els.dllRecentWrap,
    els.dllRecentSelect,
    recentDlls,
    els.dll.value.trim(),
    t('ui.recents.chooseDll'),
  );
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
      t('msg.recentsClearConfirm'),
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
  setStatus(t('ui.recents.cleared'), 'ok');
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
      ? t('ui.batch.installAll')
      : t('ui.batch.installAllCount', { 0: installable }),
  );
  els.installAll.disabled = busy || installable === 0;
  setButtonLabel(
    els.uninstallAll,
    installed === 0
      ? t('ui.batch.uninstallAll')
      : t('ui.batch.uninstallAllCount', { 0: installed }),
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
      : t('ui.batch.resumeTitle', { 0: resume.plugins.length }) +
        ' al cortarse el lote';
  els.batchResume.disabled = busy || resume === null;

  // Reintentar todos aparece solo mientras queden fallos del lote; el texto
  // lleva la cuenta para no tener que abrir el desplegable de errores.
  els.retryAll.hidden = batchFailures.length === 0;
  setButtonLabel(els.retryAll, t('ui.batch.retryFailedCount', { 0: batchFailures.length }));
  els.retryAll.disabled = busy || batchFailures.length === 0;
  els.retryAll.title =
    batchFailures.length === 0
      ? ''
      : t('msg.retryTitle', { 0: batchFailures.length });

  els.batchErrors.hidden = batchFailures.length === 0;
  // El texto va en su propio nodo: el chevrón del summary no se puede pisar.
  els.batchErrorsLabel.textContent =
    batchFailures.length === 1 ? t('ui.batch.errorOne') : t('ui.batch.errorMany', { 0: batchFailures.length });
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

function captureLog(message: string, kind: 'info' | 'ok' | 'error' | 'busy' = 'info'): void {
  const entry = document.createElement('div');
  entry.className = `capture-log-entry ${kind}`;
  const time = document.createElement('span');
  time.className = 'capture-log-time';
  time.textContent = new Date().toLocaleTimeString();
  const text = document.createElement('span');
  text.textContent = message;
  entry.append(time, text);
  if (els.captureLogState) {
    els.captureLogState.textContent = kind === 'busy' ? t('ui.capture.logInProgress') : kind === 'error' ? t('ui.capture.logNeedsAttention') : kind === 'ok' ? 'Actualizado' : 'Actividad';
    els.captureLogState.className = `capture-log-state ${kind}`;
  }
  if (els.captureLog) {
    els.captureLog.prepend(entry);
    // El registro es una consola viva: conservar más contexto en escaneos largos.
    while (els.captureLog.children.length > 120) {
      els.captureLog.removeChild(els.captureLog.lastChild!);
    }
  }
}

function setCaptureStatus(message: string, kind = 'info'): void {
  if (els.captureStatus) {
    els.captureStatus.textContent = message;
    els.captureStatus.className = `status ${kind}`;
  }
}

function setCaptureBusy(message: string, busy: boolean, stopping = false): void {
  if (els.captureLiveMessage) els.captureLiveMessage.textContent = message;
  if (els.captureLiveIndicator) els.captureLiveIndicator.hidden = !busy;
  if (els.captureStopBtn) els.captureStopBtn.hidden = !busy;
  if (els.captureStartBtn) els.captureStartBtn.disabled = busy;
  if (els.captureFinishBtn) els.captureFinishBtn.disabled = busy || captureSnapshotBeforeId === null || captureDiffId !== null;
  if (els.captureStopBtn) els.captureStopBtn.disabled = !busy || stopping || captureTaskId === null;
}

function stopCaptureTaskPolling(hideProgress = true): void {
  if (captureTaskPoll !== null) clearInterval(captureTaskPoll);
  captureTaskPoll = null;
  capturePollInFlight = false;
  if (hideProgress && els.captureProgressWrap) els.captureProgressWrap.hidden = true;
  if (hideProgress && els.captureProgressNative) els.captureProgressNative.removeAttribute('value');
}

function renderCaptureTask(task: {
  status: string; phase: string; message: string; rootsTotal: number; rootsCompleted: number;
  currentRoot: string | null; currentPath: string | null; entriesVisited: number; filesFound: number;
  registryRootsTotal: number; registryRootsCompleted: number; currentRegistryRoot: string | null;
}): void {
  const isBusy = task.status === 'running' || task.status === 'cancelling';
  setCaptureBusy(task.status === 'cancelling' ? 'Deteniendo…' : task.message, isBusy, task.status === 'cancelling');
  if (els.captureProgressWrap) {
    els.captureProgressWrap.hidden = false;
    els.captureProgressWrap.setAttribute('aria-valuemin', '0');
  }
  if (els.captureProgressCount) {
    els.captureProgressCount.textContent = task.phase === 'registry'
      ? t('ui.capture.progressRegistry', { 0: task.registryRootsCompleted, 1: task.registryRootsTotal, 2: task.message })
      : t('ui.capture.progressFiles', { 0: task.filesFound.toLocaleString(), 1: task.entriesVisited.toLocaleString() });
  }
  if (els.captureProgressRoot) {
    const path = task.phase === 'registry' ? task.currentRegistryRoot : (task.currentPath || task.currentRoot);
    els.captureProgressRoot.textContent = path || '';
    els.captureProgressRoot.title = path || '';
  }
  if (els.captureProgressBar) {
    const total = task.phase === 'registry' ? task.registryRootsTotal : task.rootsTotal;
    const done = task.phase === 'registry' ? task.registryRootsCompleted : task.rootsCompleted;
    const ratio = total > 0 ? Math.min(100, Math.round(done * 100 / total)) : 0;
    const finished = task.status === 'completed';
    const isIndeterminate = isBusy && (task.phase === 'registry' || total === 0);
    els.captureProgressBar.classList.toggle('indeterminate', isIndeterminate);
    els.captureProgressBar.style.width = isIndeterminate ? '35%' : finished ? '100%' : `${Math.max(4, ratio)}%`;
    els.captureProgressWrap?.setAttribute('aria-valuemax', String(Math.max(total, 1)));
    els.captureProgressWrap?.setAttribute('aria-valuenow', String(finished ? Math.max(total, 1) : done));
    els.captureProgressWrap?.setAttribute('aria-busy', String(isBusy));
  }
  if (els.captureProgressNative) {
    const total = task.phase === 'registry' ? task.registryRootsTotal : task.rootsTotal;
    const done = task.phase === 'registry' ? task.registryRootsCompleted : task.rootsCompleted;
    els.captureProgressNative.max = Math.max(total, 1);
    els.captureProgressNative.value = task.status === 'completed' ? Math.max(total, 1) : done;
  }
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
  batchErrorsTableController?.destroy();
  batchErrorsTableController = null;
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
    ? t('ui.loader.okTitle', { 0: loader.machine ?? '', 1: loader.bitness ?? '' })
    : t('ui.loader.incompatibleTitle', { 0: loader.issues.join('; ') });
  els.loaderStatus.className = `loader-status ${loader.valid ? 'ok' : 'error'}`;
  els.loaderStatus.title = loader.path;
}

/** Nombres que se listan en el tooltip de la pastilla de bancos. */
const MAX_BANK_NAMES_IN_TITLE = 12;

/** t('ui.banks.countOne'), t('ui.banks.countMany') o t('ui.banks.countNone'). */
function bankCountLabel(count: number): string {
  if (count === 0) return 'sin bancos';
  return count === 1 ? t('ui.banks.countOne') : t('ui.banks.countMany', { 0: count });
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
  badge.setAttribute('aria-label', t('ui.banks.rowTitle', { 0: pluginName, 1: label }));

  if (count === 0) {
    badge.title = t('ui.banks.rowTitleEmpty', { 0: pluginName });
    return;
  }

  const names = banks?.names ?? [];
  const shown = names.slice(0, MAX_BANK_NAMES_IN_TITLE);
  const rest = count - shown.length;
  const list = rest > 0 ? [...shown, t('ui.banks.moreNames', { 0: rest })].join('\n') : shown.join('\n');
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
      getValue: (plugin) => (plugin.hasLoader ? t('ui.table.withLoader') : t('ui.table.noLoader')),
      renderNode: (plugin) => {
        const badge = document.createElement('span');
        badge.className = plugin.hasLoader ? 'badge on' : 'badge';
        badge.dataset['field'] = 'status';
        badge.textContent = plugin.hasLoader ? t('ui.table.withLoader') : t('ui.table.noLoader');
        return badge;
      },
    },
    {
      id: 'compatibility',
      label: 'Compatibilidad',
      sortType: 'text',
      getValue: (plugin) =>
        plugin.compatible === true ? 'compatible' : plugin.compatible === false ? 'incompatible' : t('ui.table.unverified'),
      renderNode: (plugin) => {
        const badge = document.createElement('span');
        badge.className = plugin.compatible === true ? 'badge on' : plugin.compatible === false ? 'badge bad' : 'badge';
        badge.dataset['field'] = 'compatibility';
        badge.textContent =
          plugin.compatible === true ? 'compatible' : plugin.compatible === false ? 'incompatible' : t('ui.table.unverified');
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
          ? t('ui.wizard.badgeTitle', { 0: plugin.wizardId ?? '' })
          : t('ui.wizard.badgeTitleNone', { 0: plugin.name });
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
      label: t('ui.table.catalogBadge'),
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
          ? t('ui.meta.openTitle', { 0: plugin.name })
          : t('ui.meta.createTitle', { 0: plugin.name });
        badge.setAttribute(
          'aria-label',
          t('msg.metaPanelLabel', {
            0: plugin.name,
            1: plugin.hasMeta ? t('msg.metaPresent') : t('msg.metaMissing'),
          }),
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
  searchId: 'plugin-filter',
  // El texto de fila cubre lo que buscaba antes el filtro a mano: nombre,
  // `pluginName` y la ruta de la carpeta.
  searchText: (plugin) => [plugin.name, plugin.pluginName ?? '', plugin.path].join('\n'),
  emptyText: t('ui.table.emptyFilter'),
  filters: [
    {
      id: 'install',
      label: t('ui.filter.loaderTitle'),
      columnId: 'status',
      type: 'chip',
      icon: 'check',
      options: [
        { value: 'installed', label: t('ui.filter.withLoader'), tone: 'positive', predicate: (plugin) => plugin.hasLoader },
        { value: 'uninstalled', label: t('ui.filter.withoutLoader'), tone: 'negative', predicate: (plugin) => !plugin.hasLoader },
        { value: 'all', label: t('ui.filter.anyLoader'), tone: 'neutral' },
      ],
    },
    {
      id: 'banks',
      label: t('ui.filter.banksTitle'),
      columnId: 'banks',
      type: 'chip',
      icon: 'banks',
      options: [
        {
          value: 'with-banks',
          label: t('ui.filter.withBanks'),
          tone: 'positive',
          predicate: (plugin) => (plugin.banks?.count ?? 0) > 0,
        },
        {
          value: 'without-banks',
          label: t('ui.filter.withoutBanks'),
          tone: 'negative',
          predicate: (plugin) => (plugin.banks?.count ?? 0) === 0,
        },
        { value: 'all', label: t('ui.filter.anyBanks'), tone: 'neutral' },
      ],
    },
    {
      id: 'wizard',
      label: t('ui.filter.wizardTitle'),
      columnId: 'wizard',
      type: 'chip',
      icon: 'tag',
      options: [
        { value: 'with-wizard', label: t('ui.filter.withWizard'), tone: 'positive', predicate: (plugin) => plugin.hasWizard },
        { value: 'without-wizard', label: t('ui.filter.withoutWizard'), tone: 'negative', predicate: (plugin) => !plugin.hasWizard },
        { value: 'all', label: t('ui.filter.anyWizard'), tone: 'neutral' },
      ],
    },
    {
      id: 'compat',
      label: t('ui.filter.compatTitle'),
      columnId: 'compatibility',
      type: 'chip',
      icon: 'ban',
      options: [
        {
          value: 'compatible',
          label: t('ui.filter.noIncompatible'),
          tone: 'positive',
          predicate: (plugin) => plugin.compatible !== false,
        },
        {
          value: 'incompatible',
          label: t('ui.filter.onlyIncompatible'),
          tone: 'negative',
          predicate: (plugin) => plugin.compatible === false,
        },
        { value: 'all', label: t('ui.filter.anyCompat'), tone: 'neutral' },
      ],
    },
  ],
  rowActions: {
    actions: (plugin) => [
      {
        id: 'toggle',
        label: plugin.hasLoader ? t('ui.table.actionUninstall') : t('ui.table.actionInstall'),
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
        label: t('ui.table.catalogBadge'),
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
      ? t('ui.table.range', { 0: info.total, 1: scanData?.plugins.length ?? info.total })
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
      ? t('ui.table.emptyLibrary')
      : `${installed} de ${data.plugins.length} con el cargador${
          incompatible === 0 ? '' : t('ui.table.incompatibleSuffix', { 0: incompatible })
        }`;
  els.plugsPath.textContent = data.plugsPath;
  renderLoader(data.loader);

  // El aviso vacío distingue «no hay plugins» de «no pasa el filtro».
  catalogTableView.emptyText =
    data.plugins.length === 0
      ? 'La carpeta plugs\\ no contiene subdirectorios.'
      : t('ui.table.emptyFilter');

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

async function scan(): Promise<boolean> {
  if (busy) return false;
  if (!libraryRoot) {
    setRootWarning(true);
    setStatus(t('ui.settings.needRoot'), 'error');
    els.root.focus();
    return false;
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
    return true;
  } catch (error) {
    scanData = null;
    updateBatchControls();
    els.results.hidden = true;
    renderLoader(null);
    // Un 400 al escanear es siempre el `libraryRoot`: no es una ruta válida o
    // no contiene `plugs\`, que es justo lo que explica el aviso.
    setRootWarning(isFxbApiError(error) && error.status === 400);
    setStatus(describeError(error), 'error');
    return false;
  } finally {
    setBusy(false);
  }
}

/**
 * Escanea desde la pestaña de Ajustes y la cierra solo si la librería vale: con
 * un error (ruta relativa, carpeta sin `plugs\`) la pestaña se queda abierta
 * porque el aviso que lo explica vive dentro.
 */
async function scanFromSettings(): Promise<void> {
  const ok = await scan();
  if (ok) hidePanel(els.settingsDrawer);
}

/**
 * Abre el diálogo nativo del servidor. Devuelve `null` si no se pudo abrir (ya
 * dejó el motivo en el estado) y `[]` si la persona canceló, que no es un
 * error: el servidor no toca nada y la vista deja los campos como estaban.
 */
let appCapabilities: SystemCapabilitiesResponse = {
  mode: 'web-local',
  canCaptureRegistry: true,
  canTrash: true,
  canRevealInExplorer: true,
  canNativePick: true,
  canFileSystemAccess: false,
};

async function initCapabilities(): Promise<void> {
  try {
    appCapabilities = await client.system.capabilities();
  } catch {
    appCapabilities = {
      mode: 'web-remote',
      canCaptureRegistry: false,
      canTrash: false,
      canRevealInExplorer: false,
      canNativePick: false,
      canFileSystemAccess: typeof window !== 'undefined' && 'showDirectoryPicker' in window,
    };
  }

  if (!appCapabilities.canCaptureRegistry && els.captureNavBtn) {
    els.captureNavBtn.disabled = true;
    els.captureNavBtn.title = 'Función de captura de registro solo disponible en Windows (.exe o local)';
  }
}

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
  setStatus(t('ui.picker.choosingRoot'), 'busy');
  try {
    const body: RequestBody<'/system/pick', 'post'> = {
      kind: 'folder',
      title: t('ui.picker.chooseRoot'),
    };
    if (libraryRoot !== '') body.initialDir = libraryRoot;

    const picked = await pickPaths(body, 'library');
    if (picked === null) return; // El motivo ya está en el estado.
    const chosen = picked[0];
    if (chosen === undefined) {
      setStatus(t('ui.picker.cancelled'), 'info');
      return;
    }

    els.root.value = chosen;
    libraryRoot = chosen;
    writeStorage(STORAGE_ROOT, chosen);
    rememberRoot(chosen);
    await scanFromSettings();
  } finally {
    els.rootBrowse.disabled = busy;
  }
}

/** Botón «Elegir DLL…»: rellena la opción avanzada y revalida con `scan`. */
async function chooseDll(): Promise<void> {
  if (busy) return;

  els.dllBrowse.disabled = true;
  setStatus(t('ui.picker.choosingDll'), 'busy');
  try {
    const body: RequestBody<'/system/pick', 'post'> = {
      kind: 'file',
      title: t('ui.picker.chooseDll'),
      extensions: ['dll'],
    };
    const start = parentDir(currentDll() || recentDlls[0] || '');
    if (start !== null) body.initialDir = start;

    const picked = await pickPaths(body, 'library');
    if (picked === null) return; // El motivo ya está en el estado.
    const chosen = picked[0];
    if (chosen === undefined) {
      setStatus(t('ui.picker.cancelled'), 'info');
      return;
    }

    els.dll.value = chosen;
    writeStorage(STORAGE_DLL, chosen);
    rememberDll(chosen);
    if (libraryRoot === '') {
      setStatus(t('ui.settings.dllChosenNeedRoot'), 'ok');
      return;
    }
    await scanFromSettings();
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
  setBanksStatus(t('ui.picker.choosingBanks'), 'busy');
  try {
    const body: RequestBody<'/system/pick', 'post'> = {
      kind: 'files',
      title: t('ui.picker.chooseBanks'),
      extensions: ['fxb'],
    };
    const start = parentDir(readImportPaths().at(-1) ?? recentBanks[0] ?? '');
    if (start !== null) body.initialDir = start;

    const picked = await pickPaths(body, 'banks');
    if (picked === null) return; // El motivo ya está en el estado.
    if (picked.length === 0) {
      setBanksStatus(t('ui.picker.cancelled'), 'info');
      return;
    }

    const before = readImportPaths().length;
    els.importPaths.value = appendPaths(els.importPaths.value, picked);
    rememberBanks(picked);
    const total = readImportPaths().length;
    setBanksStatus(
      total === before
        ? t('ui.banks.alreadyInList', { 0: total })
        : t('ui.banks.addedToList', { 0: total - before, 1: total }),
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

/* ------------------------------------------------------------------ */
/* Lotes: instalar/desinstalar todos los plugins escaneados            */
/* ------------------------------------------------------------------ */

/** Etiqueta legible de la acción que el lote intentaba aplicar. */
function batchActionLabel(failure: BatchFailure): string {
  return failure.action === 'add' ? 'poner el cargador' : 'quitar el cargador';
}

/**
 * Los fallos del lote como tabla estándar (`mountTable`): el badge de acción,
 * el mensaje del servidor y el botón «Reintentar» en celdas propias, con la
 * búsqueda común para cuando el lote deja media docena de errores.
 */
const batchErrorsTableView: TableView<BatchFailure> = {
  columns: [
    {
      id: 'name',
      label: 'Plugin',
      sortType: 'text',
      getValue: (failure) => failure.plugin.name,
    },
    {
      id: 'action',
      label: t('ui.table.action'),
      sortType: 'text',
      getValue: batchActionLabel,
      renderNode: (failure) => {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = batchActionLabel(failure);
        return badge;
      },
    },
    {
      id: 'message',
      label: 'Error',
      sortType: 'text',
      getValue: (failure) => failure.message,
    },
    {
      id: 'retry',
      label: '',
      sortable: false,
      searchable: false,
      getValue: () => '',
      renderNode: (failure) => {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Reintentar';
        retry.prepend(createIcon('refresh'));
        retry.title = `Reintentar ${batchActionLabel(failure)} en ${failure.plugin.name}`;
        retry.addEventListener('click', () => {
          void retryFailure(failure);
        });
        return retry;
      },
    },
  ],
  getRowId: (failure) => failure.plugin.name,
  initialSort: { columnId: 'name', direction: 'asc' },
  rowClass: () => 'batch-error',
  emptyText: t('ui.batch.noneFailed'),
};

function renderBatchErrors(): void {
  if (batchErrorsTableController === null) {
    batchErrorsTableController = mountTable(els.batchErrorList, batchErrorsTableView, batchFailures);
  } else {
    batchErrorsTableController.setRows(batchFailures);
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
        ? t('ui.batch.noInstallTargets')
        : t('ui.batch.noUninstallTargets'),
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
      t('ui.batch.finishedNoRefresh', { 0: describeError(error) }),
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
    const message = t('ui.batch.aborted', { 0: describeError(run.error), 1: summarize(run), 2: pending });
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
        t('ui.batch.retrying', { 0: index + 1, 1: total, 2: failure.plugin.name }),
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
        ? t('ui.batch.retryDone', { 0: resolved, 1: total })
        : t('ui.batch.retryPending', { 0: resolved, 1: total, 2: pending });
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
  setBatchStatus(t('ui.batch.retryingOne', { 0: failure.plugin.name }), 'busy');

  try {
    await callAction(failure.plugin, failure.action);
    batchFailures = batchFailures.filter((item) => item !== failure);

    const data = await fetchPlugins();
    render(data);
    renderBatchErrors();

    const message = `${failure.plugin.name} ${
      failure.action === 'add' ? t('ui.table.withLoader') : t('ui.table.noLoader')
    } tras reintentar.`;
    setStatus(message, 'ok');
    setBatchStatus(
      batchFailures.length === 0
        ? t('ui.batch.noErrorsLeft')
        : t('ui.batch.errorsLeft', { 0: batchFailures.length }),
      batchFailures.length === 0 ? 'ok' : 'error',
    );
  } catch (error) {
    failure.message = describeError(error);
    renderBatchErrors();
    setBatchStatus(t('ui.batch.stillFailing', { 0: failure.plugin.name }), 'error');
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
  clearImportResults();
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
  // El cajón de datos no se apila con los demás: al abrir otro panel se retira
  // para que no queden dos cajones visibles a la vez.
  if (openPanel === els.dataAuditDrawer) closeDataAuditDrawer();

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
    els.customPluginDrawer.hidden &&
    els.settingsDrawer.hidden
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
            t('msg.bankTitleFbch'),
            t('msg.bankTitleFormat', { 0: entry.bank.version }),
            t('msg.bankTitleChunk', { 0: entry.bank.chunkSize ?? 0 }),
            entry.bank.version >= 2 && entry.bank.currentProgram !== null
              ? t('msg.bankTitleActiveProgram', { 0: entry.bank.currentProgram })
              : undefined,
            t('msg.bankTitleInfoPrograms', { 0: entry.bank.numPrograms }),
          ]
            .filter((part) => part !== undefined)
            .join('\n')
          : [
            t('msg.bankTitleFxbk'),
            t('msg.bankTitleOrder', {
              0:
                entry.bank.endianness === 'little'
                  ? t('msg.bankTitleLittle')
                  : t('msg.bankTitleBig'),
            }),
            t('msg.bankTitleFormat', { 0: entry.bank.version }),
            t('msg.bankTitlePrograms', { 0: entry.bank.numPrograms }),
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
      label: t('ui.banks.size'),
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
        use.title = t('ui.banks.chooseDefault', { 0: entry.fileName });
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
  searchColumns: ['fileName', 'kind', 'uniqueId'],
  tbodyId: 'banks-rows',
  rowClass: (entry) => {
    const current = banks?.data.config.config.defaultFxbName;
    return entry.fileName === current ? 'is-default' : undefined;
  },
  emptyText: t('ui.banks.emptyFolder'),
};

function renderBankRows(data: LibraryBanksListResponse): void {
  const emptyMessage = data.presetsDirExists
    ? t('ui.banks.emptyFolder')
    : t('ui.banks.missingFolder');
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
  none.textContent = t('ui.banks.noneOption');
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
    missing.textContent = t('ui.banks.notInFolder', { 0: current });
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
    empty.textContent = t('ui.banks.noBanksInFolder');
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
    : t('ui.banks.folderNotCreated');

  renderDefaultOptions(data, keepSelection);
  renderExportOptions(data, keepSelection);
  renderBankRows(data);
  syncBanksBadge(pluginName, data.banks.map((entry) => entry.fileName));

  const backup = data.defaultBackup;
  const defaultName = data.config.config.defaultFxbName.trim();
  els.defaultRestore.title =
    backup === null
      ? t('ui.banks.noOrigBackup')
      : t('msg.bankRestoreTitle', { 0: defaultName, 1: backup.fileName, 2: formatBytes(backup.size) });
  els.defaultDiscard.title =
    backup === null
      ? t('ui.banks.noOrigToDiscard')
      : t('msg.bankDiscardTrashTitle', {
          0: backup.fileName,
          1: formatBytes(backup.size),
          2: defaultName,
        });

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
  setBanksStatus(t('ui.banks.reading'), 'busy');

  try {
    await fetchBanks(plugin.name);
    setBanksStatus(
      plugin.hasLoader
        ? ''
        : t('ui.banks.noLoaderNote'),
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
  setBanksStatus(t('ui.banks.savingDefault'), 'busy');

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
        ? t('ui.banks.noDefault')
        : t('ui.banks.defaultSet', { 0: pluginName, 1: fileName }),
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
    setBanksStatus(t('ui.banks.noDefaultToConvert'), 'error');
    return;
  }
  if (
    !window.confirm(
      t('msg.bankConvertConfirm', { 0: fileName }),
    )
  ) {
    return;
  }

  setBanksBusy(true);
  setBanksStatus(t('ui.banks.converting', { 0: fileName }), 'busy');

  try {
    const result = await client.library.convertDefaultBank({ libraryRoot, plugin: pluginName });
    await fetchBanks(pluginName, { keepSelection: true });

    const order = result.target.bank.endianness === 'little' ? 'little-endian' : 'big-endian';
    if (!result.changed) {
      setBanksStatus(t('ui.banks.alreadyOrder', { 0: result.fileName, 1: order }), 'ok');
      return;
    }

    const backup = result.backup === null ? '' : t('ui.banks.backupSuffix', { 0: result.backup.fileName });
    setBanksStatus(
      t('ui.banks.converted', { 0: result.fileName, 1: result.fields, 2: order, 3: backup }) +
        t('ui.banks.backupNote', { 0: result.backupCreated ? '.' : ' (respaldo anterior).' }),
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
      t('ui.banks.noBackupToRestore'),
      'error',
    );
    return;
  }
  if (
    !window.confirm(
      t('msg.bankRestoreConfirm', { 0: fileName, 1: backup.fileName }),
    )
  ) {
    return;
  }

  setBanksBusy(true);
  setBanksStatus(t('ui.banks.restoring', { 0: fileName, 1: backup.fileName }), 'busy');

  try {
    const result = await client.library.restoreDefaultBank({ libraryRoot, plugin: pluginName });
    await fetchBanks(pluginName, { keepSelection: true });

    setBanksStatus(
      result.changed
        ? t('ui.banks.restored', { 0: result.fileName, 1: result.backup.fileName })
        : t('ui.banks.alreadyBackup', { 0: result.fileName }),
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
    setBanksStatus(t('ui.banks.noBackupToDiscard'), 'error');
    return;
  }
  if (
    !window.confirm(
      t('msg.bankDiscardConfirm', { 0: backup.fileName, 1: formatBytes(backup.size) }),
    )
  ) {
    return;
  }

  setBanksBusy(true);
  setBanksStatus(t('ui.banks.sendingToTrash', { 0: backup.fileName }), 'busy');

  try {
    const result = await client.library.discardDefaultBankBackup({
      libraryRoot,
      plugin: pluginName,
    });
    await fetchBanks(pluginName, { keepSelection: true });
    setBanksStatus(
      t('msg.bankDiscarded', {
        0: result.discarded.fileName,
        1: result.trash.label,
        2: formatBytes(result.discarded.size),
        3: result.fileName,
        4: result.trash.hint,
      }),
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

/** Etiqueta legible del estado de un archivo importado. */
function importStatusLabel(result: ImportResult): string {
  return result.status === 'imported'
    ? 'importado'
    : result.status === 'overwritten'
      ? 'sobrescrito'
      : 'rechazado';
}

/** Etiqueta legible de la compatibilidad técnica de un archivo. */
function importCompatibilityLabel(result: ImportResult): string {
  return result.compatibility === 'compatible'
    ? 'compatible'
    : result.compatibility === 'incompatible'
      ? 'incompatible'
      : t('ui.table.unverified');
}

/** Motivo del rechazo o los defectos de formato; `''` si no hay nada que contar. */
function importDetailText(result: ImportResult): string {
  const issues = result.issues ?? [];
  return result.reason ?? (issues.length > 0 ? issues.join('; ') : '');
}

/**
 * Los resultados de la importación como tabla estándar (`mountTable`): una
 * fila por archivo con su estado en badge y el motivo del rechazo. Las filas
 * conservan `import-result <status>` para que el estado siga pintándose (y
 * localizándose) igual que con la antigua lista.
 */
const importResultsTableView: TableView<ImportResult> = {
  columns: [
    {
      id: 'fileName',
      label: 'Archivo',
      sortType: 'text',
      getValue: (result) => result.fileName,
    },
    {
      id: 'status',
      label: 'Estado',
      sortType: 'text',
      getValue: importStatusLabel,
      renderNode: (result) => {
        const badge = document.createElement('span');
        badge.className = result.status === 'rejected' ? 'badge' : t('ui.table.installedBadge');
        badge.textContent = importStatusLabel(result);
        return badge;
      },
    },
    {
      id: 'compatibility',
      label: 'Compatibilidad',
      sortType: 'text',
      getValue: importCompatibilityLabel,
      renderNode: (result) => {
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = importCompatibilityLabel(result);
        return note;
      },
    },
    {
      id: 'detail',
      label: 'Detalle',
      sortable: false,
      cellClass: 'import-detail',
      getValue: importDetailText,
    },
  ],
  getRowId: (result) => result.source,
  initialSort: { columnId: 'fileName', direction: 'asc' },
  // Concatenación y no plantilla: el escáner de clases del test de estilos
  // empareja literales y un apóstrofo anterior desplaza los backticks.
  rowClass: (result) => 'import-result ' + result.status,
  emptyText: t('ui.banks.noImportResults'),
};

function renderImportResults(results: ImportResults): void {
  if (importResultsTableController === null) {
    importResultsTableController = mountTable(els.importResults, importResultsTableView, results);
  } else {
    importResultsTableController.setRows(results);
  }
}

/** Vacía la lista de resultados y suelta la tabla para no dejarla huérfana. */
function clearImportResults(): void {
  importResultsTableController?.destroy();
  importResultsTableController = null;
  els.importResults.replaceChildren();
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
    setBanksStatus(t('ui.banks.needPath'), 'error');
    els.importPaths.focus();
    return;
  }

  const { pluginName } = banks;
  rememberBanks(sourcePaths);
  setBanksBusy(true);
  setBanksStatus(t('ui.banks.importingCount', { 0: sourcePaths.length }), 'busy');
  clearImportResults();
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

    if (run.error !== null && !(run.error instanceof Error && run.error.message === t('ui.banks.cancelledByUser'))) {
      setBanksStatus(
        t('msg.importAborted', {
          0: run.results.length,
          1: sourcePaths.length,
          2: describeError(run.error),
          3: imported,
          4: rejected,
        }),
        'error',
      );
      return;
    }

    if (run.error instanceof Error && run.error.message === t('ui.banks.cancelledByUser')) {
      setBanksStatus(
        t('msg.importCancelled', {
          0: run.results.length,
          1: sourcePaths.length - run.results.length,
        }),
        'info',
      );
      return;
    }

    setBanksStatus(
      rejected === 0
        ? t('ui.banks.importedCount', { 0: imported })
        : t('ui.banks.importedRejected', { 0: imported, 1: rejected }),
      rejected === 0 ? 'ok' : 'error',
    );
  } catch (error) {
    // Falló el refresco de la lista o algo anterior al primer trozo.
    if (!(error instanceof Error && error.message === t('ui.banks.cancelledByUser'))) {
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
    setBanksStatus(t('ui.banks.noBanksToExport'), 'error');
    return;
  }

  const { pluginName } = banks;
  const order = endianness === 'little' ? 'little-endian' : 'big-endian';
  setBanksBusy(true);
  setBanksStatus(t('ui.banks.exporting', { 0: fileName, 1: order }), 'busy');

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
        ? t('ui.banks.exportedFields', { 0: result.target.fileName, 1: result.fields, 2: order }) +
            `${result.chunks === 0 ? '' : ` y ${result.chunks} chunk(s)`}.`
        : t('ui.banks.alreadyOrder', { 0: result.source.fileName, 1: order }),
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
      setBanksStatus(t('ui.banks.needChunkHex'), 'error');
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
      setBanksStatus(t('ui.banks.needProgramNames'), 'error');
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
      t('ui.banks.created', { 0: result.bank.kind, 1: result.target }),
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
    return t('ui.meta.idFromVfxinfo');
  }
  if (snapshot.source?.vfxinfo === true) {
    return t('ui.meta.missingFields', { 0: missing.join(' ni ') });
  }
  return t('ui.meta.noVfxinfoData');
}

function renderMeta(snapshot: PluginMetaSnapshotResponse): void {
  els.metaPath.textContent = snapshot.metaPath;
  els.metaExists.textContent = snapshot.exists ? '' : t('ui.meta.notCreatedYet');
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
  els.metaDllNote.textContent = dllPrefDraft === null ? '' : t('ui.meta.dllDraft');
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
      ? t('ui.meta.dllDraftInvalid')
      : t('ui.meta.dllNotDeclared');
    return;
  }
  if (dirty) {
    els.metaDllNote.textContent = t('ui.meta.dllDraftShown');
    return;
  }
  els.metaDllNote.textContent = t('ui.meta.dllPreferenceSaved', { 0: dllPrefSaved });
}

/** Cancelar restaura el valor guardado y descarta el borrador en memoria. */
function cancelDllPreferenceDraft(): void {
  if (dllPrefSaved === null) return;
  dllPrefDraft = null;
  els.metaDll.value = dllPrefSaved;
  updateDllPreferenceNote();
  setMetaStatus(t('ui.meta.dllPreferenceReset'));
}

async function saveDllPreference(): Promise<void> {
  if (metaState === null || dllPrefBusy || !dllPreferenceDirty()) return;

  const value = dllPreferenceInput();
  const { plugin, dir } = metaState;
  dllPrefBusy = true;
  updateDllPreferenceNote();
  setMetaStatus(t('ui.meta.dllSaving'), 'busy');

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
      setMetaStatus(t('ui.meta.dllSaved', { 0: result.dllName }), 'ok');
    } else {
      setMetaStatus(t('ui.meta.dllAlready', { 0: result.dllName }));
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
      t('msg.dllDraftText', { 0: pluginName });
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
    { id: 'action', label: t('ui.log.action'), getValue: entry => entry.action, sortType: 'text', cellClass: 'table-action', cellTitle: entry => entry.raw },
    { id: 'summary', label: 'Resumen', getValue: entry => entry.summary, sortType: 'text', cellTitle: entry => entry.raw },
    { id: 'detail', label: 'Detalle', getValue: entry => entry.detail ?? '', sortType: 'text', cellTitle: entry => entry.raw },
  ],
  getRowId: entry => `${entry.timestamp}-${entry.action}-${entry.raw}`,
  initialSort: { columnId: 'timestamp', direction: 'desc' },
  searchColumns: ['timestamp', 'action', 'summary', 'detail'],
  filters: [
    { id: 'actions', label: t('ui.log.action'), columnId: 'action', type: 'multi-select' },
    { id: 'period', label: 'Fecha', columnId: 'timestamp', type: 'date-range' },
  ],
  emptyText: t('ui.log.noMatches'),
  rowActions: {
    actions: [{ id: 'view-record', label: t('ui.log.viewRecord'), icon: 'file', onSelect: (entry, trigger) => openLogRecordDetail(entry, trigger) }],
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
  els.logDetailTitle.textContent = t('ui.log.recordHead', { 0: entry.action || 'sin acción' });
  const timestamp = logTimestamp(entry.timestamp) || entry.timestamp || '—';
  els.logDetailFields.replaceChildren(
    renderLogDetailField(t('ui.log.timestamp'), timestamp),
    renderLogDetailField(t('ui.log.action'), entry.action),
    renderLogDetailField('Resumen', entry.summary),
    renderLogDetailField('Detalle', entry.detail ?? ''),
    renderLogDetailField(t('ui.log.rawLine'), entry.raw, 'log-record-raw'),
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
  els.logExists.textContent = snapshot.exists ? '' : t('ui.log.notYet');
  els.logSummary.textContent = `${snapshot.totalEntries} entrada(s) · ${formatBytes(
    snapshot.size,
  )} en el archivo activo`;
  els.logRotated.textContent =
    snapshot.rotatedFiles.length === 0
      ? t('ui.log.noRotated')
      : t('ui.log.rotated', { 0: snapshot.rotatedFiles.length, 1: snapshot.rotatedFiles.join(', ') });

  // Estado vacío unificado: como en el catálogo, se fija el `emptyText` de la
  // vista y quien pinta el aviso es `mountTable` (su párrafo y su fila vacía),
  // no un `<p class="table-empty">` escrito a mano en el contenedor.
  pluginHistoryTableView.emptyText =
    snapshot.entries.length > 0
      ? t('ui.log.noMatches')
      : snapshot.exists
        ? t('ui.log.noReadable')
        : t('ui.log.emptyLog');
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
    els.logSummary.textContent = t('ui.log.readError', { 0: describeError(error) });
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
  els.logSummary.textContent = t('ui.log.reading');
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
  setMetaStatus(t('ui.meta.reading'), 'busy');

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
  // La preferencia de DLL ya se conoce por el escaneo: se pinta antes de pedir
  // el catálogo para que escribir en el campo mientras tanto no quede como un
  // borrador sin comparar (con la base en `null` los botones seguían apagados).
  renderDllPreference(plugin, plugin.path);
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
    setMetaStatus(t('ui.meta.extendedInvalidJson'), 'error');
    els.metaExtended.focus();
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    setMetaStatus(t('ui.meta.extendedNotObject'), 'error');
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
    setMetaStatus(t('ui.meta.idNameRequired'), 'error');
    (id === '' ? els.metaId : els.metaName).focus();
    return;
  }

  const extended = readExtended();
  if (extended === null) return;

  const { pluginName, dir, plugin, snapshot } = metaState;
  setMetaBusy(true);
  setMetaStatus(t('ui.meta.saving'), 'busy');

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
    setMetaStatus(t('ui.meta.saved'), 'ok');
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
      els.metaWizardTitle.textContent = t('ui.wizard.matchSummary', { 0: match.name, 1: match.vendor || 'Desconocido', 2: match.genre || 'VST', 3: match.id });
      els.metaWizardBanner.hidden = false;
    }
  } catch {
    // Si no coincide o falla, se mantiene oculto.
  }
}

async function applyWizardToMeta(): Promise<void> {
  if (metaState === null || metaBusy) return;
  setMetaBusy(true);
  setMetaStatus(t('ui.wizard.applyingMeta'), 'busy');
  try {
    const updated = await client.wizards.applyMeta({
      pluginDir: metaState.dir,
      wizardId: matchedWizard?.id,
      overwriteNotes: false,
    });
    metaState.snapshot = updated;
    renderMeta(updated);
    markPluginHasMeta(metaState.dir);
    setMetaStatus(t('ui.wizard.metaApplied'), 'ok');
  } catch (error) {
    setMetaStatus(describeError(error), 'error');
  } finally {
    setMetaBusy(false);
  }
}

function closeWizards(): void {
  if (els.wizards.hidden) return;
  els.wizards.hidden = true;
  // Igual que el resto de cajones: al cerrar se destruye la tabla para que la
  // próxima apertura monte una nueva sin arrastrar estado (orden/página).
  wizardsTableController?.destroy();
  wizardsTableController = null;
  els.wizardsTable.replaceChildren();
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
  closeDataAuditDrawer();
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
  els.wizardsStatus.textContent = t('ui.wizard.loading');
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
    els.wizardsStatus.textContent = t('ui.wizard.loadError', { 0: describeError(error) });
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
    const msg = t('ui.wizard.needLibrary');
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

  setTargetStatus(t('ui.wizard.choosingDll'), 'status busy');

  const body: RequestBody<'/system/pick', 'post'> = {
    kind: 'file',
    title: t('ui.wizard.chooseDllFor', { 0: wizardName }),
    extensions: ['dll'],
  };
  const start = parentDir(currentDll() || recentDlls[0] || '');
  if (start !== null) body.initialDir = start;

  const picked = await pickPaths(body, 'library');
  if (picked === null) return;
  const chosenDll = picked[0];
  if (!chosenDll) {
    setTargetStatus(t('ui.wizard.installCancelled'), 'status');
    return;
  }

  setTargetStatus(t('ui.wizard.installing', { 0: wizardName }), 'status busy');

  try {
    const res = await client.wizards.install({
      wizardId,
      libraryRoot,
      dllSourcePath: chosenDll,
      pluginFolderName: folderName,
      overwrite: true,
      initializeBank: true,
      // El alta desde el catálogo no toca el registro de Windows: importar el
      // .reg es una acción explícita de la pestaña de Ajustes.
      autoImportRegistry: false,
    });

    const warnText = res.warnings.length > 0 ? ` [Aviso: ${res.warnings.join('; ')}]` : '';
    const regText = res.registryFileCreated ? t('ui.wizard.registrySaved') : '';
    const successMsg = t('ui.wizard.installed', { 0: res.pluginName, 1: warnText, 2: regText });

    setTargetStatus(successMsg, 'status ok');

    // Refrescar el escaneo para ver el plugin en la tabla
    const plugins = await fetchPlugins();
    render(plugins);
  } catch (error) {
    setTargetStatus(t('ui.wizard.installError', { 0: describeError(error) }), 'status error');
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
 * las acciones (Instalar… e Historial) van en el menú «···» de la fila, y
 * «Historial» es la misma acción (`log` + `list`) que en el catálogo: los dos
 * abren el cajón del historial.
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
      label: t('ui.wizard.genre'),
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
      label: t('ui.wizard.configuration'),
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
          .join(', ') || t('ui.wizard.standard'),
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
        // Misma «Historial» que el catálogo: id `log` con icono `list` y el
        // mismo destino, el cajón del historial. Aquí no hay entrada que
        // mostrar todavía, así que `openWizardLog` abre con la ruta candidata.
        id: 'log',
        label: 'Historial',
        icon: 'list',
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
  searchColumns: [],
  emptyText: t('ui.wizard.noneMatch'),
};

function renderWizardsList(items: WizardListResponse['items'], total: number): void {
  els.wizardsCount.textContent = t('ui.wizard.countOf', { 0: items.length, 1: total });

  if (wizardsTableController === null) {
    wizardsTableController = mountTable(els.wizardsTable, wizardsTableView, items);
  } else {
    wizardsTableController.setRows(items);
  }
}

/**
 * Historial de un wizard desde su fila (acción «Historial», la misma que el
 * catálogo): si el plugin ya está escaneado en la librería se abre con su
 * carpeta real; si aún no existe, con la ruta candidata bajo `plugs\` para
 * que el cajón diga que todavía no hay log.
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
  els.pluginWizardStatus.textContent = t('ui.wizard.searching');
  els.pluginWizardStatus.className = 'status busy';
  els.pluginWizardEmpty.hidden = true;
  els.pluginWizardContent.hidden = true;
  els.pluginWizardCreateWrap.hidden = true;

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
      // Sin wizard oficial, el usuario puede generar uno desde el propio plugin.
      els.pluginWizardCreateWrap.hidden = false;
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
    els.pluginWizardId.textContent = t('ui.wizard.vstIdLine', { 0: match.id, 1: fourCcFromId(match.id) });
    els.pluginWizardDll.textContent = match.dllName || '—';
    els.pluginWizardDimensions.textContent = `${match.editorWidth} × ${match.editorHeight} px (${match.hasEditor ? 'Con GUI' : 'Sin GUI'})`;
    els.pluginWizardParams.textContent = t('ui.wizard.paramsLine', { 0: match.parameterCount, 1: match.programCount });

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
      fileParts.push(t('msg.wizardSymlinks') + '\n  ' + match.symlinks.join('\n  '));
    }
    if (match.filesToCreate && Object.keys(match.filesToCreate).length > 0) {
      fileParts.push(t('ui.wizard.filesCreated') + Object.keys(match.filesToCreate).join(', '));
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
      ? t('ui.wizard.recreateVfxinfo')
      : t('ui.wizard.createVfxinfo');

    els.pluginWizardStatus.textContent = '';
    els.pluginWizardStatus.className = 'status';
  } catch (error) {
    els.pluginWizardStatus.textContent = t('ui.wizard.searchError', { 0: describeError(error) });
    els.pluginWizardStatus.className = 'status error';
  }
}

function closePluginWizard(): void {
  if (els.pluginWizard.hidden) return;
  hidePanel(els.pluginWizard);
  pluginWizardState = null;
}

/**
 * Genera un `.vfxwizard` desde el plugin abierto (vfxinfo + meta + DLL interno)
 * y vuelve a resolver la coincidencia para pintar el wizard recién creado.
 */
async function createWizardFromPlugin(): Promise<void> {
  const state = pluginWizardState;
  if (state === null) return;
  const plugin = state.plugin;
  const pluginDir = (plugin.path ?? '').trim();
  if (pluginDir === '') {
    els.pluginWizardStatus.textContent = t('ui.wizard.unknownFolder');
    els.pluginWizardStatus.className = 'status error';
    return;
  }

  els.pluginWizardCreateBtn.disabled = true;
  els.pluginWizardStatus.textContent = t('ui.wizard.creating');
  els.pluginWizardStatus.className = 'status busy';
  try {
    const result = await client.wizards.createFromPlugin({ pluginDir });
    // Fijar el id recién creado evita depender del emparejamiento por nombre/DLL
    // en la recarga: el panel muestra ya el wizard que acaba de generarse.
    plugin.wizardId = result.record.id;
    await openPluginWizard(plugin);
    const warnings = result.warnings.length > 0 ? ` Avisos: ${result.warnings.join(' · ')}` : '';
    els.pluginWizardStatus.textContent = t('ui.wizard.created', { 0: result.wizardPath, 1: warnings });
    els.pluginWizardStatus.className = 'status ok';
  } catch (error) {
    els.pluginWizardStatus.textContent = t('ui.wizard.createError', { 0: describeError(error) });
    els.pluginWizardStatus.className = 'status error';
  } finally {
    els.pluginWizardCreateBtn.disabled = false;
  }
}

els.pluginWizardCreateBtn.addEventListener('click', () => {
  void createWizardFromPlugin();
});

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  libraryRoot = els.root.value.trim();
  writeStorage(STORAGE_ROOT, libraryRoot);
  rememberRoot(libraryRoot);
  const dll = currentDll();
  if (dll !== '') rememberDll(dll);
  void scanFromSettings();
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

// Elegir una carpeta del desplegable la pone en el campo y escanea con ella.
els.rootRecentSelect.addEventListener('change', () => {
  const chosen = els.rootRecentSelect.value;
  if (chosen === '') return;
  els.root.value = chosen;
  libraryRoot = chosen;
  writeStorage(STORAGE_ROOT, chosen);
  rememberRoot(chosen);
  void scanFromSettings();
});

// Elegir una DLL del desplegable la pone en el campo y revalida con `scan`.
els.dllRecentSelect.addEventListener('change', () => {
  const chosen = els.dllRecentSelect.value;
  if (chosen === '') return;
  els.dll.value = chosen;
  writeStorage(STORAGE_DLL, chosen);
  rememberDll(chosen);
  void scanFromSettings();
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
  setBatchStatus(t('ui.batch.cancelling'), 'busy');
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

els.settingsNavBtn.addEventListener('click', () => {
  showPanel(els.settingsDrawer, els.settingsNavBtn);
});

els.settingsClose.addEventListener('click', () => {
  hidePanel(els.settingsDrawer);
});

els.pluginWizardClose.addEventListener('click', () => {
  closePluginWizard();
});

els.pluginWizardVfxinfoBtn.addEventListener('click', async () => {
  if (!pluginWizardState) return;
  const { plugin, wizard } = pluginWizardState;
  const confirmed = plugin.hasVfxinfo
    ? window.confirm(
        t('ui.wizard.replaceVfxinfo', { 0: plugin.name }),
      )
    : true;
  if (!confirmed) return;

  els.pluginWizardStatus.textContent = t('ui.wizard.generatingVfxinfo');
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
    els.pluginWizardStatus.textContent = t('ui.wizard.vfxinfoGenerated', { 0: res.backedUp ? ' (respaldo .tx_ creado)' : '' });
    els.pluginWizardStatus.className = 'status ok';
  } catch (error) {
    els.pluginWizardStatus.textContent = t('ui.wizard.vfxinfoError', { 0: describeError(error) });
    els.pluginWizardStatus.className = 'status error';
  }
});

els.pluginWizardApplyBtn.addEventListener('click', async () => {
  if (!pluginWizardState) return;
  const { plugin, wizard } = pluginWizardState;
  els.pluginWizardStatus.textContent = t('ui.wizard.applyingMetaShort');
  els.pluginWizardStatus.className = 'status busy';
  try {
    await client.wizards.applyMeta({
      pluginDir: plugin.path,
      wizardId: wizard?.id,
      overwriteNotes: false,
    });
    markPluginHasMeta(plugin.path);
    els.pluginWizardStatus.textContent =
      t('ui.wizard.metaAppliedFile');
    els.pluginWizardStatus.className = 'status ok';
  } catch (error) {
    els.pluginWizardStatus.textContent = t('ui.wizard.metaApplyError', { 0: describeError(error) });
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
els.auditDetailClose.addEventListener('click', closeAuditRecordDetail);

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
  importController.abort(new Error(t('ui.banks.cancelledByUser')));
  els.importCancel.disabled = true;
  setBanksStatus(t('ui.banks.cancellingImport'), 'busy');
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
// Los radios de Ajustes son otra vista del mismo estado, no un segundo tema.
const themeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="theme-mode"]')];
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(mode: ThemeMode): void {
  if (mode === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    els.themeToggle.title = t('title.themeDark');
  } else if (mode === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    els.themeToggle.title = t('title.themeLight');
  } else {
    document.documentElement.removeAttribute('data-theme');
    els.themeToggle.title = t('title.themeAuto');
  }

  // Sol y luna son excluyentes. En «Sistema» se enseña el dibujo del tema que
  // esté aplicando el SO, para que el botón diga siempre lo que se ve.
  const shown = mode === 'auto' ? (prefersDark.matches ? 'dark' : 'light') : mode;
  for (const icon of themeIcons) {
    icon.toggleAttribute('hidden', icon.dataset['icon'] !== shown);
  }

  // Ajustes enseña siempre el modo vigente, también al recargar.
  for (const input of themeInputs) input.checked = input.value === mode;
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

function setTheme(mode: ThemeMode): void {
  localStorage.setItem(STORAGE_THEME, mode);
  applyTheme(mode);
}

function cycleTheme(): void {
  const current = readTheme();
  setTheme(current === 'auto' ? 'dark' : current === 'dark' ? 'light' : 'auto');
}

applyTheme(readTheme());

// Con «Sistema», si el SO cambia de claro a oscuro hay que cambiar el dibujo.
prefersDark.addEventListener('change', () => {
  if (readTheme() === 'auto') applyTheme('auto');
});

els.themeToggle.addEventListener('click', cycleTheme);

for (const input of themeInputs) {
  input.addEventListener('change', () => {
    if (input.checked) setTheme(input.value as ThemeMode);
  });
}

let importPackageInspection: LibraryInspectPackageResponse | null = null;
let importPackageBusy = false;
let selectedImportPlugins = new Set<string>();
let selectedImportWizards = new Map<string, string>();
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
  selectedImportWizards.clear();
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

/**
 * Las cuatro listas de resultados del asistente (símbolos, incidencias,
 * rutas creadas y advertencias) son monocolonnas: una sola columna sin orden
 * ni búsqueda, para que el orden escrito por el servidor se conserve tal cual.
 */
function customPluginListView(emptyText: string): TableView<string> {
  return {
    columns: [
      {
        // Sin cabecera: una lista de una columna no necesita etiqueta.
        id: 'text',
        label: '',
        sortable: false,
        searchable: false,
        getValue: (line) => line,
      },
    ],
    getRowId: (line) => line,
    initialSort: { columnId: 'text', direction: 'asc' },
    emptyText,
  };
}

const customPluginExportsView = customPluginListView(t('ui.wizard.noExports'));
const customPluginIssuesView = customPluginListView(t('ui.wizard.noIssues'));
const customPluginCreatedPathsView = customPluginListView(t('ui.wizard.noPaths'));
const customPluginCreatedWarningsView = customPluginListView(t('ui.wizard.noWarnings'));

/** Tablas montadas de esas listas, por su contenedor. */
const customPluginLists = new Map<HTMLElement, TableController<string>>();

/** Monta la tabla en la primera llamada y reutiliza la existente después. */
function setCustomPluginList(
  root: HTMLElement,
  view: TableView<string>,
  rows: readonly string[],
): void {
  const existing = customPluginLists.get(root);
  if (existing === undefined) {
    customPluginLists.set(root, mountTable(root, view, [...rows]));
  } else {
    existing.setRows(rows);
  }
}

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
  els.customPluginResult.hidden = true;
  els.customPluginCreated.hidden = true;
  els.customPluginBitnessWarning.hidden = true;
  els.customPluginStatus.textContent = '';
  els.customPluginStatus.className = 'status';
}

function openCaptureDrawer(opener?: HTMLElement): void {
  closeBanks();
  closeMeta();
  closeWizards();
  closePluginWizard();
  closeLogDrawer();
  closeImportPackageDrawer();
  closeCustomPluginDrawer();
  closeAuditDrawer();
  showPanel(els.captureDrawer, opener);

  if (!captureSessionInitialized) {
    els.captureStartBtn.disabled = false;
    els.captureFinishBtn.disabled = true;
    els.capturePackageBtn.disabled = true;
    els.captureVmachineBtn.disabled = true;
    els.captureStartInfo.hidden = true;
    els.captureFinishInfo.hidden = true;
    els.captureStagingInfo.hidden = true;
    els.captureVmachineInfo.hidden = true;
    els.captureStep1Status.textContent = 'Pendiente';
    els.captureStep1Status.className = 'capture-step-badge';
    els.captureStep2Status.textContent = 'Pendiente';
    els.captureStep2Status.className = 'capture-step-badge';
    els.captureStep3Status.textContent = 'Pendiente';
    els.captureStep3Status.className = 'capture-step-badge';
    els.captureStep4Status.textContent = 'Pendiente';
    els.captureStep4Status.className = 'capture-step-badge';
    captureSnapshotBeforeId = null;
    captureDiffId = null;
    captureSnapshotText = '';
    if (els.captureSnapshotSummary) els.captureSnapshotSummary.textContent = '';
    if (els.captureSnapshotContent) els.captureSnapshotContent.textContent = '';
    if (els.captureViewSnapshotBtn) els.captureViewSnapshotBtn.disabled = true;
    if (els.captureDownloadSnapshotBtn) els.captureDownloadSnapshotBtn.disabled = true;
    captureStagingLoaded = false;
    capturePreExistingCount = null;
    capturePreExistingWarning = '';
    capturePreExistingFiles = [];
    captureStagedPreExisting = [];
    captureRestorablePreExisting = 0;
    captureRestorableFiles = [];
    renderPreExistingButtons();
    if (els.capturePreExistingSummary) {
      els.capturePreExistingSummary.textContent = '';
      els.capturePreExistingSummary.hidden = true;
    }
    captureSessionInitialized = true;
    if (els.captureLog) els.captureLog.replaceChildren();
    setCaptureStatus('');
  }

  if (captureTaskId) {
    setCaptureBusy(t('ui.capture.recovering'), true);
    if (captureTaskPoll === null) {
      captureTaskPoll = setInterval(() => void pollCaptureTask(), 700);
    }
    void pollCaptureTask();
  }
}

function closeCaptureDrawer(): void {
  if (els.captureDrawer.hidden) return;
  hidePanel(els.captureDrawer);
  setCaptureStatus('');
}

function startCaptureTaskPolling(taskId: string, kind: 'start' | 'finish'): void {
  captureTaskId = taskId;
  captureTaskKind = kind;
  writeStorage(STORAGE_CAPTURE_TASK, taskId);
  captureLastProgressLogAt = 0;
  captureLastPollErrorAt = 0;
  captureLastProgressMessage = '';
  captureLastProgressEntries = -1;
  if (captureTaskPoll !== null) clearInterval(captureTaskPoll);
  captureTaskPoll = null;
  if (els.captureProgressWrap) els.captureProgressWrap.hidden = false;
  if (els.captureProgressNative) els.captureProgressNative.removeAttribute('value');
  setCaptureBusy(t('ui.capture.starting'), true);
  if (els.captureStartBtn) els.captureStartBtn.disabled = true;
  if (els.captureFinishBtn) els.captureFinishBtn.disabled = true;
  captureTaskPoll = setInterval(() => void pollCaptureTask(), 700);
  void pollCaptureTask();
}

async function pollCaptureTask(): Promise<void> {
  const taskId = captureTaskId;
  if (!taskId || capturePollInFlight) return;
  capturePollInFlight = true;
  try {
    const response = await fetch(`/capture/tasks/${encodeURIComponent(taskId)}`);
    if (!response.ok) throw new Error(await response.text());
    const task = await response.json();
    captureTaskKind ??= task.kind === 'start' || task.kind === 'finish' ? task.kind : null;
    renderCaptureTask(task);
    const now = Date.now();
    const scannedEntries = Number(task.entriesVisited) || 0;
    const progressThreshold = task.phase === 'registry' ? 1 : 1000;
    const progressChanged = task.message !== captureLastProgressMessage || scannedEntries - captureLastProgressEntries >= progressThreshold;
    if (progressChanged && (now - captureLastProgressLogAt >= 1200 || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')) {
      const location = task.phase === 'registry' ? task.currentRegistryRoot : (task.currentPath || task.currentRoot);
      const detail = task.phase === 'registry'
        ? t('msg.captureProgressRoots', {
            0: task.registryRootsCompleted,
            1: task.registryRootsTotal,
            2: task.message,
          })
        : `${Number(task.filesFound).toLocaleString()} archivos · ${scannedEntries.toLocaleString()} entradas · ${task.message}`;
      captureLog(location ? `${detail} · ${location}` : detail, task.status === 'running' || task.status === 'cancelling' ? 'busy' : 'info');
      captureLastProgressLogAt = now;
      captureLastProgressMessage = task.message;
      captureLastProgressEntries = scannedEntries;
    }
    if (task.status === 'running' || task.status === 'cancelling') return;

    const kind = captureTaskKind;
    stopCaptureTaskPolling(false);
    captureTaskId = null;
    captureTaskKind = null;
    writeStorage(STORAGE_CAPTURE_TASK, '');
    setCaptureBusy('', false);
    if (task.status === 'completed' && kind === 'start') {
      captureSnapshotBeforeId = task.result?.snapshotId ?? null;
      if (!captureSnapshotBeforeId) {
        captureLog(t('ui.capture.noSnapshotId'), 'error');
        setCaptureStatus(t('ui.capture.noSnapshotId2'), 'error');
        return;
      }
      if (els.captureSnapshotBefore) els.captureSnapshotBefore.textContent = captureSnapshotBeforeId;
      els.captureStartInfo.hidden = false;
      if (els.captureViewSnapshotBtn) els.captureViewSnapshotBtn.disabled = true;
      if (els.captureDownloadSnapshotBtn) els.captureDownloadSnapshotBtn.disabled = true;
      els.captureStep1Status.textContent = 'Completado';
      els.captureStep1Status.className = 'capture-step-badge ok';
      els.captureFinishBtn.disabled = false;
      captureLog(t('ui.capture.snapshotSaved', { 0: captureSnapshotBeforeId, 1: task.filesFound.toLocaleString() }), 'ok');
      setCaptureStatus(t('ui.capture.snapshotLoading'), 'busy');
      void loadCaptureSnapshot(captureSnapshotBeforeId).then(() => {
        if (captureSnapshotText) {
          setCaptureStatus(t('ui.capture.snapshotReady'), 'ok');
        }
      });
    } else if (task.status === 'completed' && kind === 'finish') {
      captureDiffId = task.result?.diffId ?? null;
      if (els.captureDiffId) els.captureDiffId.textContent = captureDiffId ?? '';
      if (els.captureFilesAdded) els.captureFilesAdded.textContent = String(task.result?.filesAdded ?? 0);
      if (els.captureFilesModified) els.captureFilesModified.textContent = String(task.result?.filesModified ?? 0);
      if (els.captureFilesDeleted) els.captureFilesDeleted.textContent = String(task.result?.filesRemoved ?? 0);
      if (els.captureRegistryCount) els.captureRegistryCount.textContent = String((task.result?.registryAdded ?? 0) + (task.result?.registryModified ?? 0));
      els.captureFinishInfo.hidden = false;
      els.captureStep2Status.textContent = 'Completado';
      els.captureStep2Status.className = 'capture-step-badge ok';
      els.      capturePackageBtn.disabled = false;
      void refreshCapturePreExisting();
      captureLog(t('ui.capture.diffReady', { 0: task.result?.filesAdded ?? 0, 1: task.result?.filesModified ?? 0, 2: (task.result?.registryAdded ?? 0) + (task.result?.registryModified ?? 0) }), 'ok');
      setCaptureStatus(t('ui.capture.finished'), 'ok');
    } else if (task.status === 'cancelled') {
      if (kind === 'start') {
        els.captureStartBtn.disabled = false;
        els.captureStep1Status.textContent = 'Detenido';
        els.captureStep1Status.className = 'capture-step-badge';
      } else {
        els.captureFinishBtn.disabled = captureSnapshotBeforeId === null;
      }
      captureLog(t('ui.capture.stopped'), 'info');
      setCaptureStatus(t('ui.capture.stoppedRetry'), 'info');
    } else {
      if (kind === 'start') els.captureStartBtn.disabled = false;
      else els.captureFinishBtn.disabled = captureSnapshotBeforeId === null;
      const message = task.error || t('ui.capture.failed');
      captureLog(t('ui.capture.error', { 0: message }), 'error');
      setCaptureStatus(t('ui.capture.errorShort', { 0: message }), 'error');
    }
  } catch (error) {
    const message = describeError(error);
    const now = Date.now();
    if (now - captureLastPollErrorAt > 5000) {
      captureLog(t('ui.capture.progressRetry', { 0: message }), 'error');
      captureLastPollErrorAt = now;
    }
    setCaptureStatus(t('ui.capture.progressOffline'), 'error');
    setCaptureBusy(t('ui.capture.waitingServer'), true);
  } finally {
    capturePollInFlight = false;
  }
}

async function stopCaptureTask(): Promise<void> {
  if (!captureTaskId) return;
  const taskId = captureTaskId;
  setCaptureBusy(t('ui.capture.stopping'), true, true);
  captureLog(t('ui.capture.stopSent'), 'info');
  try {
    const response = await fetch(`/capture/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
    renderCaptureTask(await response.json());
  } catch (error) {
    if (els.captureStopBtn) els.captureStopBtn.disabled = false;
    captureLog(t('ui.capture.stopError', { 0: describeError(error) }), 'error');
    setCaptureStatus(t('ui.capture.stopErrorShort', { 0: describeError(error) }), 'error');
  }
}

async function captureStart(): Promise<void> {
  try {
    captureLog(t('ui.capture.requestingSnapshot'), 'busy');
    setCaptureStatus(t('ui.capture.preparingScan'), 'busy');
    setCaptureBusy(t('ui.capture.creatingTask'), true);
    const response = await fetch('/capture/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(await response.text());
    const task = await response.json();
    startCaptureTaskPolling(task.taskId, 'start');
  } catch (error) {
    const message = describeError(error);
    captureLog(t('ui.capture.startError', { 0: message }), 'error');
    setCaptureStatus(t('ui.capture.errorShort', { 0: message }), 'error');
    setCaptureBusy('', false);
    els.captureStartBtn.disabled = false;
  }
}

async function captureFinish(): Promise<void> {
  if (!captureSnapshotBeforeId) {
    setCaptureStatus(t('ui.capture.noInitialSnapshot'), 'error');
    return;
  }
  try {
    captureLog(t('ui.capture.requestingFinal'), 'busy');
    setCaptureStatus(t('ui.capture.preparingFinal'), 'busy');
    setCaptureBusy(t('ui.capture.preparingFinal2'), true);
    const response = await fetch('/capture/finish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotIdBefore: captureSnapshotBeforeId }),
    });
    if (!response.ok) throw new Error(await response.text());
    const task = await response.json();
    startCaptureTaskPolling(task.taskId, 'finish');
  } catch (error) {
    const message = describeError(error);
    captureLog(t('ui.capture.finishError', { 0: message }), 'error');
    setCaptureStatus(t('ui.capture.errorShort', { 0: message }), 'error');
    setCaptureBusy('', false);
    els.captureFinishBtn.disabled = false;
  }
}

async function capturePackage(): Promise<void> {
  if (!captureDiffId) {
    setCaptureStatus(t('ui.capture.noDiff'), 'error');
    return;
  }
  try {
    captureLog(t('ui.capture.copyingStaging'), 'busy');
    setCaptureStatus(t('ui.capture.preparingStaging'), 'busy');
    els.capturePackageBtn.disabled = true;
    const res = await fetch('/capture/package', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diffId: captureDiffId, targetDir: '' }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    els.captureStep3Status.textContent = 'Completado';
    els.captureStep3Status.className = 'capture-step-badge ok';
    els.captureVmachineBtn.disabled = false;
    await captureRefreshStaging();
    const preExisting = Number(data.preExistingFiles ?? 0);
    captureLog(
      preExisting > 0
        ? t('ui.capture.stagingReadyPre', { 0: data.filesCopied || 0, 1: preExisting })
        : t('ui.capture.stagingReady', { 0: data.filesCopied || 0 }),
      'ok',
    );
    // Sin snapshot inicial el staging puede venir incompleto: no es un error,
    // pero conviene verlo antes de empaquetar.
    for (const warning of (data.warnings ?? []) as string[]) captureLog(warning, 'info');
    setCaptureStatus(t('ui.capture.stagingReview'), 'ok');
  } catch (error) {
    els.capturePackageBtn.disabled = false;
    const msg = describeError(error);
    captureLog(t('ui.capture.stagingError', { 0: msg }), 'error');
    setCaptureStatus(t('ui.capture.errorShort', { 0: msg }), 'error');
  }
}

/** Pinta el recuento del paso 4 con el estado actual de la casilla. */
function renderCapturePreExistingSummary(): void {
  if (!els.capturePreExistingSummary) return;
  const include = els.captureIncludeExisting.checked;
  const text = formatPreExistingSummary({
    count: capturePreExistingCount,
    include,
    warning: capturePreExistingWarning,
  });
  els.capturePreExistingSummary.textContent = text;
  els.capturePreExistingSummary.hidden = text === '';
  renderCapturePreExistingList(include);
}

/** Tope de filas del desplegable: más que eso no se lee, se dice cuántas faltan. */
const PRE_EXISTING_LIST_LIMIT = 200;

/**
 * Despliega, en el paso 4, qué archivos previos van a entrar además del
 * recuento. La lista sale del mismo `GET /capture/pre-existing/:diffId` que el
 * número, así que no puede decir algo distinto de lo que se empaquetaría, y ya
 * descuenta lo que se haya quitado del staging. Con la casilla desmarcada se
 * esconde: lo que se enseña es lo que se incluye.
 */
function renderCapturePreExistingList(include: boolean): void {
  const details = els.capturePreExistingDetails;
  if (!details) return;
  const files = capturePreExistingFiles;
  const show = include && files.length > 0 && capturePreExistingWarning === '';
  details.hidden = !show;
  if (!show) {
    els.capturePreExistingList?.replaceChildren();
    return;
  }
  if (els.capturePreExistingDetailsLabel) {
    els.capturePreExistingDetailsLabel.textContent = preExistingListLabel(files.length);
  }
  const list = els.capturePreExistingList;
  if (!list) return;
  list.replaceChildren();
  const shown = files.slice(0, PRE_EXISTING_LIST_LIMIT);
  for (const file of shown) {
    const item = document.createElement('li');
    item.className = 'capture-pre-existing-item';
    // Relativa a la unidad de origen (`Program Files/VstPlugins/P8.dll`): se
    // enseña tal cual llega, sin recortar, para poder buscarla en el disco.
    const name = document.createElement('span');
    name.className = 'capture-pre-existing-path';
    name.textContent = file;
    name.title = file;
    item.append(name);
    // Cada fila se puede abrir en el Explorador: la ruta relativa no le dice
    // nada al navegador, así que la resuelve el servidor contra el snapshot.
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'capture-pre-existing-open';
    open.textContent = 'Abrir';
    open.title = revealPreExistingLabel(file);
    open.setAttribute('aria-label', open.title);
    open.addEventListener('click', async () => {
      await captureRevealPreExisting(file);
    });
    item.append(open);
    list.append(item);
  }
  if (files.length > shown.length) {
    const rest = document.createElement('li');
    rest.className = 'note';
    rest.textContent = t('ui.capture.moreFiles', { 0: files.length - shown.length });
    list.append(rest);
  }
}

/**
 * Abre un previo del paso 4 en el Explorador de Windows con el archivo
 * resaltado (`POST /capture/pre-existing/:diffId/reveal?path=`). El servidor
 * resuelve la ruta relativa contra el snapshot y la valida antes de abrir nada.
 */
async function captureRevealPreExisting(file: string): Promise<void> {
  if (captureDiffId === null) return;
  const diffId = captureDiffId;
  try {
    const res = await fetch(
      `/capture/pre-existing/${encodeURIComponent(diffId)}/reveal?path=${encodeURIComponent(file)}`,
      { method: 'POST' },
    );
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { opened?: unknown };
    if (captureDiffId !== diffId) return;
    const opened = typeof data.opened === 'string' ? data.opened : '';
    captureLog(formatRevealPreExistingResult(file, opened), 'ok');
  } catch (error) {
    captureLog(t('ui.capture.revealError', { 0: file, 1: describeError(error) }), 'error');
  }
}

/**
 * Abre en el Explorador un archivo del staging (`POST
 * /capture/staging/:diffId/reveal?path=`). El servidor comprueba que la ruta
 * siga dentro del staging y que el archivo exista antes de abrir la ventana.
 */
async function captureRevealStagingFile(file: string): Promise<void> {
  if (captureDiffId === null) return;
  const diffId = captureDiffId;
  try {
    const res = await fetch(
      `/capture/staging/${encodeURIComponent(diffId)}/reveal?path=${encodeURIComponent(file)}`,
      { method: 'POST' },
    );
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { opened?: unknown };
    if (captureDiffId !== diffId) return;
    const opened = typeof data.opened === 'string' ? data.opened : '';
    captureLog(formatRevealPreExistingResult(file, opened), 'ok');
  } catch (error) {
    captureLog(t('ui.capture.revealError', { 0: file, 1: describeError(error) }), 'error');
  }
}

/**
 * Consulta cuántos archivos previos del snapshot inicial entrarían en el
 * paquete. Se hace antes de generar y se repite al revisar el staging, porque
 * lo que se quite de ahí tampoco llega al banco.
 */
async function refreshCapturePreExisting(): Promise<void> {
  if (captureDiffId === null) return;
  const diffId = captureDiffId;
  try {
    const res = await fetch(`/capture/pre-existing/${encodeURIComponent(diffId)}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    // Si mientras tanto llegó otro diff, su recuento no se puede pisar.
    if (captureDiffId !== diffId) return;
    const count = Number(data.count);
    capturePreExistingCount = Number.isFinite(count) ? count : null;
    capturePreExistingFiles = Array.isArray(data.files)
      ? (data.files as unknown[]).filter((file): file is string => typeof file === 'string')
      : [];
    const restorable = Number(data.restorable);
    captureRestorablePreExisting = Number.isFinite(restorable) && restorable > 0 ? restorable : 0;
    captureRestorableFiles = Array.isArray(data.restorableFiles)
      ? (data.restorableFiles as unknown[]).filter((file): file is string => typeof file === 'string')
      : [];
    const warnings = Array.isArray(data.warnings) ? (data.warnings as unknown[]) : [];
    capturePreExistingWarning = warnings.length > 0 ? String(warnings[0]) : '';
    renderCapturePreExistingSummary();
    renderPreExistingButtons();
  } catch (error) {
    if (captureDiffId !== diffId) return;
    capturePreExistingCount = null;
    capturePreExistingWarning = '';
    capturePreExistingFiles = [];
    captureRestorablePreExisting = 0;
    captureRestorableFiles = [];
    renderCapturePreExistingSummary();
    renderPreExistingButtons();
    captureLog(t('ui.capture.snapshotQueryError', { 0: describeError(error) }), 'error');
  }
}

async function captureRefreshStaging(): Promise<void> {
  if (!captureDiffId) return;
  try {
    // Primero el snapshot inicial: el listado marca qué archivos ya existían
    // antes de la captura, y ese dato manda también para el recuento del paso 4.
    await refreshCapturePreExisting();
    const res = await fetch(`/capture/staging/${captureDiffId}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const files: string[] = data.files || [];
    const entries = classifyStagingFiles(files, capturePreExistingFiles);
    captureStagedPreExisting = entries.filter((entry) => entry.preExisting).map((entry) => entry.path);
    if (els.captureStagingCount) els.captureStagingCount.textContent = String(files.length);
    renderPreExistingButtons();
    els.captureStagingInfo.hidden = false;
    if (els.captureStagingList) {
      els.captureStagingList.replaceChildren();
      if (files.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'note';
        empty.textContent = t('ui.capture.stagingEmpty');
        els.captureStagingList.append(empty);
      } else {
        const shown = entries.slice(0, 150);
        for (const entry of shown) {
          const item = document.createElement('div');
          item.className = 'capture-staging-item';
          if (entry.preExisting) item.classList.add('is-pre-existing');
          const name = document.createElement('span');
          name.className = 'capture-staging-name';
          name.textContent = entry.path;
          name.title = entry.path;
          item.append(name);
          if (entry.preExisting) {
            const badge = document.createElement('span');
            badge.className = 'capture-staging-badge';
            badge.textContent = t('ui.capture.preExistingBadge');
            badge.title = t('ui.capture.preExistingTitle');
            item.append(badge);
          }
          // Cada archivo del staging se puede abrir en el Explorador para
          // revisarlo antes de generar el banco, igual que los previos del
          // paso 4. El servidor resuelve la ruta dentro del staging.
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'capture-staging-open';
          open.textContent = 'Abrir';
          open.title = revealPreExistingLabel(entry.path);
          open.setAttribute('aria-label', open.title);
          open.addEventListener('click', async () => {
            await captureRevealStagingFile(entry.path);
          });
          item.append(open);
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'capture-staging-remove';
          remove.textContent = '×';
          remove.title = t('ui.capture.removeFromStaging');
          remove.setAttribute('aria-label', t('ui.capture.removeFromStagingPath', { 0: entry.path }));
          remove.addEventListener('click', async () => {
            try {
              const response = await fetch(`/capture/staging/${captureDiffId}?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' });
              if (!response.ok) throw new Error(await response.text());
              captureLog(t('ui.capture.removedFromStaging', { 0: entry.path }), 'info');
              await captureRefreshStaging();
            } catch (error) {
              captureLog(t('ui.capture.removeError', { 0: describeError(error) }), 'error');
            }
          });
          item.append(remove);
          els.captureStagingList.append(item);
        }
        // El recorte de la lista no puede ocultar archivos que sí se van a
        // empaquetar: si sobran, se dicen.
        if (entries.length > shown.length) {
          const rest = document.createElement('div');
          rest.className = 'note';
          rest.textContent = t('ui.capture.moreStaging', { 0: entries.length - shown.length });
          els.captureStagingList.append(rest);
        }
      }
      renderRestorableStagingEntries();
    }
  } catch (error) {
    captureLog(t('ui.capture.stagingLoadError', { 0: describeError(error) }), 'error');
  }
}

/**
 * Filas de los previos que se quitaron con la ×: siguen en el manifiesto y el
 * snapshot los tiene, así que cada una se puede devolver por separado sin
 * recuperar las demás. Van al final de la lista, atenuadas y tachadas, para no
 * confundirlas con lo que el paquete sí llevaría.
 */
function renderRestorableStagingEntries(): void {
  const list = els.captureStagingList;
  if (!list || captureRestorableFiles.length === 0) return;
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = removedStagingNote(captureRestorableFiles.length);
  list.append(note);
  for (const file of captureRestorableFiles) {
    const item = document.createElement('div');
    item.className = 'capture-staging-item is-removed';
    const name = document.createElement('span');
    name.className = 'capture-staging-name';
    name.textContent = file;
    name.title = file;
    item.append(name);
    const badge = document.createElement('span');
    badge.className = 'capture-staging-badge';
    badge.textContent = 'quitado';
    badge.title = t('ui.capture.removedPackage');
    item.append(badge);
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'capture-staging-restore';
    restore.textContent = '↺';
    restore.title = t('ui.capture.restoreFile', { 0: file });
    restore.setAttribute('aria-label', restoreStagedFileLabel(file));
    restore.addEventListener('click', async () => {
      await captureRestoreStagedFile(file);
    });
    item.append(restore);
    list.append(item);
  }
}

/**
 * Devuelve al staging un único previo quitado con la ×, sin tocar los demás:
 * `POST /capture/staging/:diffId/restore?path=` y refresco del listado.
 */
async function captureRestoreStagedFile(file: string): Promise<void> {
  if (captureDiffId === null) return;
  const diffId = captureDiffId;
  setCaptureStatus(t('ui.capture.restoringFile', { 0: file }), 'busy');
  try {
    const response = await fetch(
      `/capture/staging/${encodeURIComponent(diffId)}/restore?path=${encodeURIComponent(file)}`,
      { method: 'POST' },
    );
    if (!response.ok) throw new Error(await response.text());
    const data = (await response.json()) as { restored?: unknown; missing?: unknown };
    if (captureDiffId !== diffId) return;
    const missing = Array.isArray(data.missing) ? data.missing.map(String) : [];
    const outcome =
      Number(data.restored) === 1
        ? 'restored'
        : missing.some((entry) => entry.replaceAll('\\', '/') === file.replaceAll('\\', '/'))
          ? 'missing'
          : 'present';
    const summary = formatRestoreStagedFileResult(file, outcome);
    captureLog(summary, outcome === 'missing' ? 'error' : 'ok');
    setCaptureStatus(
      outcome === 'restored' ? t('ui.capture.restoredCounts', { 0: summary }) : summary,
      outcome === 'missing' ? 'error' : 'ok',
    );
  } catch (error) {
    captureLog(t('ui.capture.restoreError', { 0: file, 1: describeError(error) }), 'error');
    setCaptureStatus(t('ui.capture.restoreFailed', { 0: file }), 'error');
  }
  await captureRefreshStaging();
}

/**
 * Los dos botones de previos son independientes: «Quitar» aparece mientras
 * queden previos en el staging y «Recuperar» siempre que el snapshot pueda
 * devolver alguno de los quitados, aunque otros sigan ahí. Así se recupera lo
 * borrado sin tener que vaciar el staging entero.
 */
function renderPreExistingButtons(): void {
  const remove = els.captureRemovePreExistingBtn;
  const total = captureStagedPreExisting.length;
  if (remove) {
    remove.hidden = total === 0;
    remove.disabled = total === 0;
    if (els.captureRemovePreExistingLabel) {
      els.captureRemovePreExistingLabel.textContent = total === 0 ? t('ui.capture.removePrevious') : removePreExistingLabel(total);
    }
    remove.title =
      total === 0
        ? t('ui.capture.noPrevLeft')
        : t('ui.capture.removePrevTitle', { 0: total });
    remove.setAttribute('aria-label', remove.title);
  }

  const restore = els.captureRestorePreExistingBtn;
  if (!restore) return;
  const restorable = captureRestorablePreExisting;
  restore.hidden = restorable === 0;
  restore.disabled = restorable === 0;
  if (els.captureRestorePreExistingLabel) {
    els.captureRestorePreExistingLabel.textContent =
      restorable === 0 ? t('ui.capture.restorePrevious') : restorePreExistingLabel(restorable);
  }
  restore.title =
    restorable === 0
      ? t('ui.capture.noPrevToRestore')
      : t('ui.capture.restorePrevTitle', { 0: restorable });
  restore.setAttribute('aria-label', restore.title);
}

/**
 * Quita del staging todos los archivos previos a la captura de una vez. Se
 * borra uno a uno con el mismo `DELETE` que el × de cada fila, así que si uno
 * falla los demás siguen y el fallo queda en el registro.
 */
async function captureRemovePreExisting(): Promise<void> {
  if (captureDiffId === null || captureStagedPreExisting.length === 0) return;
  const diffId = captureDiffId;
  const targets = [...captureStagedPreExisting];
  if (els.captureRemovePreExistingBtn) els.captureRemovePreExistingBtn.disabled = true;
  setCaptureStatus(t('ui.capture.removingPrev'), 'busy');
  let removed = 0;
  const failures: string[] = [];
  for (const file of targets) {
    try {
      const response = await fetch(
        `/capture/staging/${encodeURIComponent(diffId)}?path=${encodeURIComponent(file)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) throw new Error(await response.text());
      removed += 1;
    } catch (error) {
      failures.push(t('ui.capture.fileError', { 0: file, 1: describeError(error) }));
    }
  }
  if (captureDiffId !== diffId) return;
  const summary = formatRemovePreExistingResult(removed, targets.length);
  for (const failure of failures) captureLog(t('ui.capture.removePrevFailed', { 0: failure }), 'error');
  captureLog(summary, failures.length === 0 ? 'ok' : 'error');
  setCaptureStatus(
    failures.length === 0
      ? t('ui.capture.prevRemovedSummary', { 0: summary })
      : t('ui.capture.prevRemovedPartial', { 0: summary, 1: failures.length }),
    failures.length === 0 ? 'ok' : 'error',
  );
  await captureRefreshStaging();
}

/**
 * Devuelve al staging los previos quitados sin repetir «Preparar staging»: el
 * servidor vuelve a copiarlos del snapshot inicial y deja el resto intacto.
 */
async function captureRestorePreExisting(): Promise<void> {
  if (captureDiffId === null || captureRestorablePreExisting === 0) return;
  const diffId = captureDiffId;
  if (els.captureRestorePreExistingBtn) els.captureRestorePreExistingBtn.disabled = true;
  setCaptureStatus(t('ui.capture.recoveringPrev'), 'busy');
  try {
    const response = await fetch(`/capture/staging/${encodeURIComponent(diffId)}/restore`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error(await response.text());
    const data = (await response.json()) as { restored?: unknown; missing?: unknown; warnings?: unknown };
    if (captureDiffId !== diffId) return;
    const restored = Number(data.restored);
    const missing = Array.isArray(data.missing) ? (data.missing as unknown[]).map(String) : [];
    const warnings = Array.isArray(data.warnings) ? (data.warnings as unknown[]).map(String) : [];
    for (const warning of warnings) captureLog(warning, 'error');
    for (const file of missing) captureLog(t('ui.capture.recoverFailed', { 0: file }), 'error');
    const summary = formatRestorePreExistingResult(Number.isFinite(restored) ? restored : 0, missing.length);
    captureLog(summary, missing.length === 0 && warnings.length === 0 ? 'ok' : 'error');
    setCaptureStatus(
      missing.length === 0
        ? t('ui.capture.prevRestoredSummary', { 0: summary })
        : t('ui.capture.prevRestoredPartial', { 0: summary }),
      missing.length === 0 ? 'ok' : 'error',
    );
  } catch (error) {
    captureLog(t('ui.capture.recoverPrevError', { 0: describeError(error) }), 'error');
    setCaptureStatus(t('ui.capture.recoverPrevFailed'), 'error');
  }
  await captureRefreshStaging();
}

async function captureVmachine(): Promise<void> {
  if (!captureDiffId) {
    setCaptureStatus('No hay diff generado', 'error');
    return;
  }
  const pluginName = els.capturePluginName?.value.trim() || 'CapturedPlugin';
  const vendor = els.capturePluginVendor?.value.trim() || '';
  const includePreExisting = els.captureIncludeExisting.checked;
  try {
    captureLog(t('ui.capture.generatingBank', { 0: pluginName }), 'busy');
    setCaptureStatus('Generando...', 'busy');
    els.captureVmachineBtn.disabled = true;
    const res = await fetch(`/capture/vmachine/${captureDiffId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pluginName,
        vendor,
        generateBank: true,
        generateWizard: true,
        includePreExisting,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    els.captureStep4Status.textContent = 'Completado';
    els.captureStep4Status.className = 'capture-step-badge ok';
    if (els.captureVmachinePath) els.captureVmachinePath.textContent = data.bankDir || '';
    if (els.captureWizardPath) els.captureWizardPath.textContent = data.wizardPath || '';
    els.captureVmachineInfo.hidden = false;
    captureLog(t('ui.capture.generatedOk'), 'ok');
    setCaptureStatus(t('ui.capture.bankWizardReady'), 'ok');
  } catch (error) {
    els.captureVmachineBtn.disabled = false;
    const msg = describeError(error);
    captureLog(t('ui.capture.generateError', { 0: msg }), 'error');
    setCaptureStatus(t('ui.capture.errorShort', { 0: msg }), 'error');
  }
}

/** Pinta el resultado de `/library/inspect-dll` y, con lo detectado, rellena el
 * nombre y el id sugeridos. */
function renderCustomPluginInspection(result: LibraryInspectDllResponse): void {
  els.customPluginResult.hidden = false;
  els.customPluginCreated.hidden = true;

  els.customPluginValidPe.textContent = result.validPe ? t('ui.customPlugin.validPe') : t('ui.customPlugin.notPe');
  els.customPluginValidPe.className = `badge ${result.validPe ? 'on' : 'off'}`;
  els.customPluginBitness.textContent = result.bitness === null ? 'bits ?' : t('ui.customPlugin.bits', { 0: result.bitness });
  els.customPluginBitness.className = `badge ${result.is32BitCompatible ? 'on' : 'off'}`;
  if (result.vstEntrypoint !== null) {
    els.customPluginVst.textContent = t('ui.customPlugin.vstEntry', { 0: result.vstEntrypoint });
    els.customPluginVst.className = 'badge on';
  } else {
    els.customPluginVst.textContent = t('ui.customPlugin.noVstEntry');
    els.customPluginVst.className = 'badge off';
  }

  const suggestionParts = [t('ui.customPlugin.suggested', { 0: result.suggestedName, 1: result.suggestedId })];
  if (result.internalDllName !== null) {
    suggestionParts.push(t('ui.customPlugin.internalDll', { 0: result.internalDllName }));
  }
  els.customPluginSuggestion.textContent = suggestionParts.join('');
  els.customPluginName.value = result.suggestedName;
  els.customPluginFolder.value = result.suggestedName;
  if (!els.customPluginId.value.trim()) els.customPluginId.value = result.suggestedId;

  const wizard = result.matchingWizard;
  if (wizard !== null) {
    els.customPluginWizard.textContent =
      t('ui.customPlugin.wizardAvailable') +
      t('ui.customPlugin.wizardAvailableLine', { 0: wizard.name, 1: wizard.id, 2: wizard.vendor });
    els.customPluginWizard.hidden = false;
  } else {
    els.customPluginWizard.hidden = true;
  }

  setCustomPluginList(els.customPluginExports, customPluginExportsView, result.exportedNames);
  els.customPluginExports.hidden = result.exportedNames.length === 0;

  setCustomPluginList(els.customPluginIssues, customPluginIssuesView, result.issues);
  els.customPluginIssues.hidden = result.issues.length === 0;

  // Advertencia persistente si el binario no es apto para el host de 32 bits:
  // se puede seguir creando, pero el plugin no cargará en la V-Machine / VFX Host.
  if (!result.is32BitCompatible) {
    els.customPluginBitnessWarning.textContent =
      `El binario no es apto para el host de 32 bits: ${result.validPe ? `es ${result.bitness} bits` : 'ni siquiera es un PE valido'}. ` +
      t('ui.customPlugin.not32Bit');
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
    setCustomPluginStatus(t('ui.customPlugin.needDllPath'), 'error');
    return;
  }

  els.customPluginResult.hidden = true;
  els.customPluginBitnessWarning.hidden = true;
  setCustomPluginBusy(true);
  setCustomPluginStatus(t('ui.customPlugin.analyzing'), 'busy');
  try {
    const body: RequestBody<'/library/inspect-dll', 'post'> = { dllPath };
    const result = await client.library.inspectDll(body);
    renderCustomPluginInspection(result);
    setCustomPluginStatus(t('ui.customPlugin.analyzed'), 'info');
  } catch (error) {
    setCustomPluginStatus(t('ui.customPlugin.analyzeError', { 0: describeError(error) }), 'error');
  } finally {
    setCustomPluginBusy(false);
  }
}

/** Botón «Crear plugin en la librería»: alta a partir de lo ya analizado. */
async function createCustomPlugin(): Promise<void> {
  if (customPluginBusy) return;
  const libraryRootPath = els.customPluginRoot.value.trim();
  if (libraryRootPath === '') {
    setCustomPluginStatus(t('ui.customPlugin.needRoot'), 'error');
    return;
  }
  const folderName = els.customPluginFolder.value.trim();
  if (folderName === '') {
    setCustomPluginStatus(t('ui.customPlugin.needFolder'), 'error');
    return;
  }
  const name = els.customPluginName.value.trim();
  if (name === '') {
    setCustomPluginStatus(t('ui.customPlugin.needName'), 'error');
    return;
  }
  const id = els.customPluginId.value.trim();
  if (id === '') {
    setCustomPluginStatus(t('ui.customPlugin.needId'), 'error');
    return;
  }
  const sourceDllPath = els.customPluginPath.value.trim();
  if (sourceDllPath === '') {
    setCustomPluginStatus(t('ui.customPlugin.needDll'), 'error');
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
  setCustomPluginStatus(t('ui.customPlugin.creating'), 'busy');
  try {
    const result: LibraryCreateCustomPluginResponse = await client.library.createCustomPlugin(body);
    els.customPluginCreated.hidden = false;
    setCustomPluginList(els.customPluginCreatedPaths, customPluginCreatedPathsView, [
      t('ui.customPlugin.folderPath', { 0: result.pluginDir }),
      t('ui.customPlugin.dllPath', { 0: result.dllRelativePath }),
      t('ui.customPlugin.vfxinfoPath', { 0: result.vfxinfoPath }),
      t('ui.customPlugin.metaPath', { 0: result.metaPath }),
      ...(result.wizardPath !== null ? [t('ui.customPlugin.wizardPath', { 0: result.wizardPath })] : []),
    ]);
    setCustomPluginList(els.customPluginCreatedWarnings, customPluginCreatedWarningsView, result.warnings);
    els.customPluginCreatedWarnings.hidden = result.warnings.length === 0;
    setCustomPluginStatus(result.created ? t('ui.customPlugin.created') : 'No se creó el plugin.', 'info');
  } catch (error) {
    setCustomPluginStatus(t('ui.customPlugin.createError', { 0: describeError(error) }), 'error');
  } finally {
    setCustomPluginBusy(false);
  }
}

/**
 * «Crear plugin» agrupa las dos altas en un desplegable: elegir una opción tiene
 * que cerrarlo, o el menú se queda abierto por encima del cajón que acaba de
 * abrir.
 */
function closeCreationMenu(): void {
  const menu = els.customPluginNavBtn?.closest('details');
  if (menu instanceof HTMLDetailsElement) menu.open = false;
}

els.customPluginNavBtn.addEventListener('click', () => {
  closeCreationMenu();
  openCustomPluginDrawer(els.customPluginNavBtn);
});

if (els.captureNavBtn) {
  els.captureNavBtn.addEventListener('click', () => {
    closeCreationMenu();
    openCaptureDrawer(els.captureNavBtn);
  });
}

if (els.captureClose) {
  els.captureClose.addEventListener('click', () => {
    closeCaptureDrawer();
  });
}  if (els.captureStartBtn) {
    els.captureStartBtn.addEventListener('click', () => {
      void captureStart();
    });
  }

if (els.captureStopBtn) {
  els.captureStopBtn.addEventListener('click', () => {
    void stopCaptureTask();
  });
}

async function loadCaptureSnapshot(snapshotId: string): Promise<void> {
  if (els.captureViewSnapshotBtn) els.captureViewSnapshotBtn.disabled = true;
  if (els.captureDownloadSnapshotBtn) els.captureDownloadSnapshotBtn.disabled = true;
  try {
    const response = await fetch(`/capture/snapshots/${encodeURIComponent(snapshotId)}`);
    if (!response.ok) throw new Error(await response.text());
    const snapshot = await response.json();
    const files = Array.isArray(snapshot.files) ? snapshot.files : [];
    const registry = Array.isArray(snapshot.registry) ? snapshot.registry : [];
    const summary = `${files.length.toLocaleString()} elementos de archivo · ${registry.length.toLocaleString()} valores de registro · ${snapshot.scanRoots?.length ?? 0} rutas examinadas`;
    const lines = [
      'SNAPSHOT INICIAL DE CAPTURA',
      `ID: ${snapshot.id}`,
      `Fecha: ${snapshot.createdAt}`,
      `Plataforma: ${snapshot.platform}`,
      `Archivos y carpetas: ${files.length}`,
      `Valores de registro: ${registry.length}`,
      '',
      'RUTAS EXAMINADAS',
      ...(snapshot.scanRoots ?? []).map((root: string) => `- ${root}`),
      '',
      'ARCHIVOS Y CARPETAS',
      ...files.map((file: { path: string; isDir: boolean; size: number; mtimeMs: number; hash?: string }) =>
        `${file.isDir ? '[DIR] ' : '[FILE]'} ${file.path}${file.isDir ? '' : ` | ${Number(file.size).toLocaleString()} bytes | modificado: ${new Date(file.mtimeMs).toISOString()}${file.hash ? ` | SHA-256: ${file.hash}` : ''}`}`),
      '',
      'RAÍCES DE REGISTRO EXAMINADAS',
      ...(snapshot.registryRoots ?? []).map((root: string) => `- ${root}`),
      '',
      'VALORES DE REGISTRO',
      ...registry.map((entry: { key: string; valueName: string; valueType: string; valueData: string }) =>
        `[${entry.key}] ${entry.valueName} | ${entry.valueType} | ${entry.valueData}`),
      '',
    ];
    captureSnapshotText = lines.join('\n');
    if (els.captureSnapshotSummary) els.captureSnapshotSummary.textContent = summary;
    if (els.captureSnapshotDialogSummary) els.captureSnapshotDialogSummary.textContent = summary;
    if (els.captureSnapshotContent) els.captureSnapshotContent.textContent = captureSnapshotText;
    if (els.captureViewSnapshotBtn) els.captureViewSnapshotBtn.disabled = false;
    if (els.captureDownloadSnapshotBtn) els.captureDownloadSnapshotBtn.disabled = false;
    captureLog(t('ui.capture.reportReady', { 0: summary }), 'ok');
  } catch (error) {
    const message = describeError(error);
    captureLog(t('ui.capture.snapshotLoadError', { 0: message }), 'error');
    setCaptureStatus(t('ui.capture.snapshotLoadedError', { 0: message }), 'error');
  }
}

function viewCaptureSnapshot(): void {
  if (!captureSnapshotText || !els.captureSnapshotDialog) return;
  els.captureSnapshotDialog.showModal();
  els.captureSnapshotContent.focus();
}

function downloadCaptureSnapshot(): void {
  if (!captureSnapshotText || !captureSnapshotBeforeId) return;
  const blob = new Blob([captureSnapshotText], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `snapshot-${captureSnapshotBeforeId}.txt`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

if (els.captureViewSnapshotBtn) {
  els.captureViewSnapshotBtn.addEventListener('click', viewCaptureSnapshot);
}
if (els.captureDownloadSnapshotBtn) {
  els.captureDownloadSnapshotBtn.addEventListener('click', downloadCaptureSnapshot);
}
if (els.captureSnapshotDialogClose) {
  els.captureSnapshotDialogClose.addEventListener('click', () => els.captureSnapshotDialog.close());
}
if (els.captureSnapshotDialog) {
  els.captureSnapshotDialog.addEventListener('click', (event) => {
    if (event.target === els.captureSnapshotDialog) els.captureSnapshotDialog.close();
  });
}

if (els.captureFinishBtn) {
  els.captureFinishBtn.addEventListener('click', () => {
    void captureFinish();
  });
}

if (els.capturePackageBtn) {
  els.capturePackageBtn.addEventListener('click', () => {
    void capturePackage();
  });
}

if (els.captureRefreshStagingBtn) {
  els.captureRefreshStagingBtn.addEventListener('click', () => {
    void captureRefreshStaging();
  });
}

if (els.captureRemovePreExistingBtn) {
  els.captureRemovePreExistingBtn.addEventListener('click', () => {
    void captureRemovePreExisting();
  });
}

if (els.captureRestorePreExistingBtn) {
  els.captureRestorePreExistingBtn.addEventListener('click', () => {
    void captureRestorePreExisting();
  });
}

if (els.captureIncludeExisting) {
  els.captureIncludeExisting.addEventListener('change', () => {
    renderCapturePreExistingSummary();
  });
}

if (els.captureVmachineBtn) {
  els.captureVmachineBtn.addEventListener('click', () => {
    void captureVmachine();
  });
}

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
      title: t('ui.picker.choosePluginDll'),
      extensions: ['dll'],
      initialDir: start,
    });
    const chosen = res.paths?.[0];
    if (chosen) {
      els.customPluginPath.value = chosen;
      void inspectCustomPlugin();
    }
  } catch (error) {
    setCustomPluginStatus(t('ui.picker.openError', { 0: describeError(error) }), 'error');
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
        chk.title = t('ui.importPackage.selectPlugin', { 0: plug.name });
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
          wizardSubtitle.textContent = t('ui.importPackage.wizard', { 0: plugWizard.vendor, 1: plugWizard.name });
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
      getValue: (plug) => (plug.hasVfxinfo ? (plug.vfxinfoId ? t('ui.importPackage.idLabel', { 0: plug.vfxinfoId }) : t('ui.common.yes')) : 'No'),
      renderNode: (plug) => {
        const badgeVfx = document.createElement('span');
        badgeVfx.className = plug.hasVfxinfo ? 'badge on' : 'badge off';
        badgeVfx.textContent = plug.hasVfxinfo ? (plug.vfxinfoId ? `ID ${plug.vfxinfoId}` : t('ui.common.yes')) : 'No';
        return badgeVfx;
      },
    },
    {
      id: 'size',
      label: t('ui.table.size'),
      sortType: 'number',
      getValue: (plug) => plug.totalSizeBytes,
      renderCell: (plug) => formatBytes(plug.totalSizeBytes),
    },
    {
      id: 'target',
      label: t('ui.importPackage.inTarget'),
      sortType: 'text',
      getValue: (plug) => (plug.alreadyExistsInTarget ? t('ui.importPackage.exists') : 'Nuevo'),
      renderNode: (plug) => {
        const badgeTarget = document.createElement('span');
        if (plug.alreadyExistsInTarget) {
          badgeTarget.className = 'badge';
          badgeTarget.textContent = t('ui.importPackage.exists');
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
  searchColumns: ['name', 'dllName'],
  tbodyId: 'import-package-plugins-rows',
  emptyText: t('ui.importPackage.noPlugins'),
  filters: [
    {
      id: 'targetFilter',
      label: 'Destino',
      columnId: 'target',
      options: [
        { value: 'all', label: t('ui.importPackage.allPlugins'), tone: 'neutral' },
        { value: 'new', label: t('ui.importPackage.newPlugins'), tone: 'positive', predicate: (p) => !p.alreadyExistsInTarget },
        { value: 'exists', label: t('ui.importPackage.existingPlugins'), tone: 'negative', predicate: (p) => p.alreadyExistsInTarget },
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
        chk.title = t('ui.importPackage.selectBank', { 0: bank.name });
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
      renderCell: (bank) => t('ui.importPackage.presets', { 0: bank.presetCount }),
    },
    {
      id: 'concordance',
      label: 'Concordancia',
      sortType: 'text',
      getValue: (bank) => {
        const state = bankConcordance(bank);
        if (state === 'concordant') return 'Concordante';
        if (state === 'repairable') return t('ui.importPackage.gaps');
        if (state === 'deficient') return 'Carencias';
        return t('ui.importPackage.noData');
      },
      renderNode: (bank) => {
        const state = bankConcordance(bank);
        if (state === 'concordant') {
          const badge = document.createElement('span');
          badge.className = 'badge on';
          const label = bank.chunkPluginFourCc || (bank.chunkPluginId ? t('ui.importPackage.chunkId', { 0: bank.chunkPluginId }) : 'OK');
          badge.textContent = t('ui.importPackage.matching', { 0: label });
          if (bank.matchedWizardName) {
            badge.title = t('ui.importPackage.wizardCompatible', { 0: bank.matchedWizardName });
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
      label: t('ui.table.size'),
      sortType: 'number',
      getValue: (bank) => bank.totalSizeBytes,
      renderCell: (bank) => formatBytes(bank.totalSizeBytes),
    },
    {
      id: 'target',
      label: t('ui.importPackage.inTarget'),
      sortType: 'text',
      getValue: (bank) => (bank.alreadyExistsInTarget ? t('ui.importPackage.exists') : 'Nuevo'),
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
  searchColumns: ['name'],
  tbodyId: 'import-package-banks-rows',
  emptyText: t('ui.importPackage.noBanks'),
  filters: [
    {
      id: 'concordanceFilter',
      label: 'Concordancia',
      columnId: 'concordance',
      options: [
        { value: 'all', label: t('ui.importPackage.fullMatch'), tone: 'neutral' },
        { value: 'concordant', label: 'Concordante', tone: 'positive', predicate: (bank) => bankConcordance(bank) === 'concordant' },
        { value: 'repairable', label: t('ui.importPackage.gaps'), tone: 'neutral', predicate: (bank) => bankConcordance(bank) === 'repairable' },
        { value: 'deficient', label: 'Carencias', tone: 'negative', predicate: (bank) => bankConcordance(bank) === 'deficient' },
        { value: 'unknown', label: t('ui.importPackage.noData'), tone: 'neutral', predicate: (bank) => bankConcordance(bank) === 'unknown' },
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
  els.importPackageKind.textContent = result.resolvedKind === 'vfxlibrary' ? t('ui.importPackage.kindPackage') : t('ui.importPackage.kindFolder');
  els.importPackageSource.textContent = result.sourcePath;

  currentInspectionPlugins = result.plugins;
  selectedImportPlugins = new Set(result.plugins.map((p) => p.sourceDir || p.name));
  selectedImportWizards = new Map(result.plugins.map((plugin) => {
    const wizard = plugin.matchedWizard;
    return [plugin.sourceDir || plugin.name, wizard && wizard.matchReason !== 'suggestion' ? wizard.id : ''];
  }));
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
  els.importPackageStatus.textContent = t('ui.importPackage.inspected', { 0: result.plugins.length, 1: result.banks.length });
  els.importPackageStatus.className = 'status ok';
}

async function inspectPackage(): Promise<void> {
  const pkgPath = els.importPackagePath.value.trim();
  if (!pkgPath) {
    els.importPackageStatus.textContent = t('ui.importPackage.needPath');
    els.importPackageStatus.className = 'status error';
    els.importPackagePath.focus();
    return;
  }
  if (!libraryRoot) {
    els.importPackageStatus.textContent = t('ui.importPackage.needLibrary');
    els.importPackageStatus.className = 'status error';
    return;
  }

  setImportPackageBusy(true);
  els.importPackageStatus.textContent = t('ui.importPackage.inspecting');
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
    selectedImportWizards.clear();
    importPackageBanksTableController?.destroy();
    importPackageBanksTableController = null;
    els.importPackageBanksTable.replaceChildren();
    selectedImportBanks.clear();
    currentInspectionBanks = [];
    els.importPackageStatus.textContent = t('ui.importPackage.inspectError', { 0: describeError(error) });
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
    els.importPackageStatus.textContent = t('ui.importPackage.needSelection');
    els.importPackageStatus.className = 'status error';
    return;
  }

  const collisionPolicy = els.importPackagePolicy.value as 'skip' | 'overwrite';

  setImportPackageBusy(true);
  els.importPackageStatus.textContent = t('ui.importPackage.importing');
  els.importPackageStatus.className = 'status busy';

  try {
    const result = await client.library.importPackage({
      packagePath: pkgPath,
      targetLibraryRoot: libraryRoot,
      selectedPlugins,
      selectedBanks,
      selectedWizards: Object.fromEntries(
        currentInspectionPlugins.map((plugin) => {
          const key = plugin.sourceDir || plugin.name;
          return [key, selectedImportWizards.get(key) ?? ''];
        }),
      ),
      collisionPolicy,
      repairBanks: els.importPackageRepair.checked,
    });

    const repairedMsg =
      (result as { repairedBanks?: string[] }).repairedBanks &&
      (result as { repairedBanks?: string[] }).repairedBanks!.length > 0
        ? ` Reparados: ${(result as { repairedBanks?: string[] }).repairedBanks!.length} banco(s).`
        : '';

    const msg =
      t('ui.importPackage.done') +
      t('ui.importPackage.doneCounts', { 0: result.importedPlugins.length, 1: result.importedBanks.length, 2: formatBytes(result.totalCopiedBytes) }) +
      repairedMsg +
      ((result as { preparedPlugins?: string[] }).preparedPlugins?.length
        ? t('msg.preparedWithWizard', {
            0: (result as { preparedPlugins?: string[] }).preparedPlugins!.join(', '),
          })
        : '') +
      ((result as { wizardWarnings?: { plugin: string; message: string }[] }).wizardWarnings?.length
        ? t('msg.prepareWarnings', {
            0: (result as { wizardWarnings?: { plugin: string; message: string }[] }).wizardWarnings!.map((warning) => `${warning.plugin}: ${warning.message}`).join(' · '),
          })
        : '') +
      (result.skippedPlugins.length > 0 || result.skippedBanks.length > 0
        ? t('ui.importPackage.skipped', { 0: result.skippedPlugins.length, 1: result.skippedBanks.length })
        : '');

    els.importPackageStatus.textContent = msg;
    els.importPackageStatus.className = 'status ok';

    // Refrescar plugins principales
    const scanResult = await fetchPlugins();
    render(scanResult);

    // Re-inspeccionar para actualizar estados
    await inspectPackage();
  } catch (error) {
    els.importPackageStatus.textContent = t('ui.importPackage.importError', { 0: describeError(error) });
    els.importPackageStatus.className = 'status error';
  } finally {
    setImportPackageBusy(false);
  }
}

/** Entrada de la auditoría durable: los cuatro `kind` que registra el servidor. */
type AssociationAuditEntry = AssociationAuditSnapshotResponse['entries'][number];

/** Etiqueta legible de cada tipo de evento; el valor crudo es el que filtra. */
const AUDIT_KIND_LABELS: Record<string, string> = {
  'association-change': t('ui.audit.kindAssociation'),
  import: t('ui.audit.kindImport'),
  reimport: t('ui.audit.kindReimport'),
  collision: t('ui.audit.kindCollision'),
};

/**
 * Visor de la auditoría durable de asociaciones: monta el snapshot de solo
 * lectura de `POST /library/association-audit/list` sobre `mountTable`, con el
 * rango de fechas por `ts` y el multiselección por `kind` que trae el sistema
 * de tablas. El orden, la búsqueda y la paginación se resuelven en cliente
 * sobre los hasta 200 eventos del snapshot.
 */
/** Botón que abrió el detalle del evento: para devolverle el foco al cerrar. */
let auditDetailOpener: HTMLButtonElement | null = null;

/**
 * «Ver registro» de la tabla de auditoría: el evento completo, con todos los
 * campos del JSONL —también los que la tabla no pinta, como la librería—, en
 * el mismo bloque de solo lectura que el detalle del historial.
 */
function openAuditRecordDetail(entry: AssociationAuditEntry, trigger: HTMLButtonElement): void {
  auditDetailOpener = trigger;
  els.auditDetailTitle.textContent = t('ui.audit.eventHead', { 0: AUDIT_KIND_LABELS[entry.kind] ?? entry.kind });
  const fields: HTMLElement[] = [
    renderLogDetailField(t('ui.audit.timestamp'), logTimestamp(entry.ts) || entry.ts),
    renderLogDetailField('Tipo', AUDIT_KIND_LABELS[entry.kind] ?? entry.kind),
    renderLogDetailField('Plugin', entry.plugin ?? ''),
    renderLogDetailField(t('ui.audit.library'), entry.libraryRoot ?? ''),
    renderLogDetailField('Campo', entry.field ?? ''),
    renderLogDetailField(t('ui.audit.previousValue'), entry.previousValue ?? ''),
    renderLogDetailField(t('ui.audit.newValue'), entry.newValue ?? ''),
    renderLogDetailField('Origen', entry.packageSource ?? ''),
  ];
  if (entry.collisionPolicy) fields.push(renderLogDetailField(t('ui.audit.policy'), entry.collisionPolicy));
  if (entry.collisionNames && entry.collisionNames.length > 0) {
    fields.push(renderLogDetailField('Omitidos', entry.collisionNames.join(', ')));
  }
  if (entry.repairedBanks && entry.repairedBanks.length > 0) {
    fields.push(renderLogDetailField(t('ui.audit.repairedBanks'), entry.repairedBanks.join(', ')));
  }
  els.auditDetailFields.replaceChildren(...fields);
  els.auditDetail.hidden = false;
  els.auditDetailClose.focus({ preventScroll: true });
}

function closeAuditRecordDetail(): void {
  if (els.auditDetail.hidden) return;
  els.auditDetail.hidden = true;
  els.auditDetailFields.replaceChildren();
  const opener = auditDetailOpener;
  auditDetailOpener = null;
  if (opener?.isConnected && opener.getClientRects().length > 0) {
    opener.focus({ preventScroll: true });
  }
}

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
          ? t('ui.audit.fieldChange', { 0: entry.field, 1: entry.previousValue ?? '—', 2: entry.newValue ?? '—' })
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
        from.textContent = entry.previousValue ?? t('ui.audit.emptyValue');
        const to = document.createElement('code');
        to.textContent = entry.newValue ?? t('ui.audit.emptyValue');
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
          entry.collisionPolicy ? t('ui.audit.policyName', { 0: entry.collisionPolicy }) : '',
          ...(entry.collisionNames ?? []),
          ...(entry.repairedBanks ?? []),
        ]
          .filter(Boolean)
          .join(' '),
      renderNode: (entry) => {
        const parts: string[] = [];
        if (entry.collisionPolicy) {
          parts.push(t('ui.audit.policyShort', { 0: entry.collisionPolicy === 'skip' ? 'omitir' : 'sobrescribir' }));
        }
        if (entry.collisionNames && entry.collisionNames.length > 0) {
          parts.push(t('ui.audit.skippedNames', { 0: entry.collisionNames.join(', ') }));
        }
        if (entry.repairedBanks && entry.repairedBanks.length > 0) {
          parts.push(t('ui.audit.repairedNames', { 0: entry.repairedBanks.join(', ') }));
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
  emptyText: t('ui.audit.noEvents'),
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
  rowActions: {
    actions: [{ id: 'view-record', label: t('ui.log.viewRecord'), icon: 'file', onSelect: (entry, trigger) => openAuditRecordDetail(entry, trigger) }],
  },
  onSearchChange: (query) => onAuditSearchChange(query),
};

/**
 * Tope del snapshot que pide el visor. El servidor no impone máximo (entero
 * positivo; sin parámetro usa 200) y devuelve los últimos `limit` eventos que
 * pasan los filtros —`q` incluido, que estrecha antes de cortar—: el tope
 * cubre el histórico para que la tabla pinte todas las filas que la búsqueda
 * deja. El mismo valor en la carga y en el sondeo para que la huella no
 * provoque recargas en bucle.
 */
const AUDIT_SNAPSHOT_LIMIT = 1_000_000;

let auditTableController: TableController<AssociationAuditEntry> | null = null;
let auditBusy = false;
/** Huella del último snapshot pintado: cambia cuando el almacén crece. */
let auditFingerprint = '';
let auditPollTimer: ReturnType<typeof setInterval> | null = null;
/** Búsqueda vigente del visor: la manda el servidor como `q` en carga y sondeo. */
let auditQuery = '';
/** Recarga en cola mientras el usuario escribe en la búsqueda de la tabla. */
let auditSearchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * La búsqueda de la tabla se manda al servidor con 300 ms de espera: el
 * snapshot vuelve estrechado por `q` y, mientras llega, el filtro local se
 * aplica sobre las filas ya cargadas para que la respuesta sea inmediata. El
 * mismo texto en el sondeo es obligatorio: si uno mandara `q` y el otro no, las
 * huellas `size:total:length` no coincidirían y el cajón entraría en bucle de
 * recargas.
 */
function onAuditSearchChange(query: string): void {
  const next = query.trim();
  if (auditSearchTimer !== null) clearTimeout(auditSearchTimer);
  auditSearchTimer = setTimeout(() => {
    auditSearchTimer = null;
    if (next === auditQuery) return;
    auditQuery = next;
    void loadAssociationAudit();
  }, 300);
}

/** Cierra la búsqueda pendiente y la deja vacía (al abrir o cerrar el cajón). */
function resetAuditSearch(): void {
  if (auditSearchTimer !== null) clearTimeout(auditSearchTimer);
  auditSearchTimer = null;
  auditQuery = '';
}

function destroyAssociationAuditTable(): void {
  closeAuditRecordDetail();
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
    setAuditStatus(t('ui.audit.needRoot'), 'error');
    return;
  }

  auditBusy = true;
  els.auditRefresh.disabled = true;
  if (!silent) setAuditStatus(t('ui.audit.reading'), 'busy');
  try {
    const snapshot = await client.associationAudit.list({
      libraryRoot,
      limit: AUDIT_SNAPSHOT_LIMIT,
      q: auditQuery,
    });
    els.auditPath.textContent = snapshot.auditPath;
    els.auditSummary.textContent = snapshot.exists
      ? t('ui.audit.summary', { 0: snapshot.total, 1: formatBytes(snapshot.size) })
      : t('ui.audit.notCreated');
    if (auditTableController === null) {
      auditTableController = mountTable(els.auditTable, associationAuditTableView, snapshot.entries);
    } else {
      auditTableController.setRows(snapshot.entries);
    }
    // Las filas se rehacen: si el detalle estaba abierto desde un botón que ya
    // no existe, se cierra (como el del historial en cada pintado).
    if (els.auditDetail.hidden === false && auditDetailOpener?.isConnected !== true) {
      closeAuditRecordDetail();
    }
    auditFingerprint = `${snapshot.size}:${snapshot.total}:${snapshot.entries.length}`;
    setAuditStatus('');
  } catch (error) {
    if (!silent) {
      destroyAssociationAuditTable();
      els.auditPath.textContent = '';
      els.auditSummary.textContent = '';
    }
    setAuditStatus(t('ui.audit.readError', { 0: describeError(error) }), 'error');
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
  let fingerprint: string;
  try {
    const snapshot = await client.associationAudit.list({
      libraryRoot,
      limit: AUDIT_SNAPSHOT_LIMIT,
      q: auditQuery,
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
  destroyAssociationAuditTable();
  setAuditStatus('');
  auditFingerprint = '';
  resetAuditSearch();
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
  auditFingerprint = '';
  resetAuditSearch();
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
    const res = await client.system.pick({ kind: 'folder', title: t('ui.importPackage.choosePath'), initialDir: start });
    if (res.paths && res.paths.length > 0 && res.paths[0]) {
      els.importPackagePath.value = res.paths[0];
      void inspectPackage();
    }
  } catch (error) {
    els.importPackageStatus.textContent = t('ui.picker.openError', { 0: describeError(error) });
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

/** Entrada de la auditoría de datos: un plugin con sus huecos y propuestas. */
type DataAuditPlugin = LibraryAuditResponse['plugins'][number];

/** Cómo se nombra cada origen de un valor propuesto. */
const DATA_AUDIT_SOURCE_LABELS: Record<string, string> = {
  vfxinfo: 'vfxinfo',
  meta: 'meta',
  dll: 'DLL',
  derived: 'deducido',
  wizard: 'wizard',
};

/** Gravedad de un hueco en una palabra, para el badge del detalle. */
const DATA_AUDIT_SEVERITY_LABELS: Record<string, string> = {
  missing: 'falta',
  invalid: t('ui.dataAudit.notValid'),
  note: 'nota',
};

/** Un plugin está completo cuando ninguno de sus huecos es `missing`/`invalid`. */
function dataAuditHasGaps(plugin: DataAuditPlugin): boolean {
  return plugin.issues.some((issue) => issue.severity !== 'note');
}

function dataAuditHeading(text: string): HTMLElement {
  const heading = document.createElement('h4');
  heading.textContent = text;
  return heading;
}

function dataAuditEmpty(text: string): HTMLElement {
  const line = document.createElement('p');
  line.className = 'note';
  line.textContent = text;
  return line;
}

function dataAuditItem(field: string, text: string, badgeText: string, badgeClass: string): HTMLElement {
  const item = document.createElement('li');
  item.className = 'data-audit-item';
  const badge = document.createElement('span');
  badge.className = badgeClass;
  badge.textContent = badgeText;
  const code = document.createElement('code');
  code.textContent = field;
  const note = document.createElement('span');
  note.className = 'data-audit-item-note';
  note.textContent = text;
  item.append(badge, code, note);
  return item;
}

function dataAuditList(items: HTMLElement[]): HTMLElement {
  const list = document.createElement('ul');
  list.className = 'data-audit-list';
  list.append(...items);
  return list;
}

const dataAuditTableView: TableView<DataAuditPlugin> = {
  columns: [
    {
      id: 'name',
      label: 'Plugin',
      sortType: 'text',
      getValue: (plugin) => plugin.name,
      cellTitle: (plugin) => plugin.path,
    },
    {
      id: 'state',
      label: 'Estado',
      sortType: 'text',
      getValue: (plugin) => (dataAuditHasGaps(plugin) ? t('ui.dataAudit.withGaps') : 'completo'),
      renderNode: (plugin) => {
        const badge = document.createElement('span');
        badge.className = dataAuditHasGaps(plugin) ? 'badge off' : 'badge on';
        badge.textContent = dataAuditHasGaps(plugin) ? t('ui.dataAudit.withGaps') : 'Completo';
        return badge;
      },
    },
    {
      id: 'gaps',
      label: 'Huecos',
      sortType: 'number',
      getValue: (plugin) => plugin.issues.length,
      cellTitle: (plugin) =>
        plugin.issues.map((issue) => t('ui.dataAudit.issueLine', { 0: issue.field, 1: issue.message })).join('\n'),
    },
    {
      id: 'fillable',
      label: 'Rellenables',
      sortType: 'number',
      getValue: (plugin) => plugin.proposals.length,
      cellTitle: (plugin) =>
        plugin.proposals.map((proposal) => t('ui.dataAudit.proposalLine', { 0: proposal.field, 1: proposal.value })).join('\n'),
    },
    {
      id: 'dll',
      label: 'DLL',
      sortType: 'text',
      getValue: (plugin) => plugin.dll.resolved ?? '',
      renderCell: (plugin) => plugin.dll.resolved ?? '—',
      cellTitle: (plugin) =>
        [
          plugin.dll.bitness === null ? '' : t('ui.dataAudit.bits', { 0: plugin.dll.bitness }),
          plugin.dll.vstEntrypoint ?? '',
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
    },
  ],
  getRowId: (plugin) => plugin.path,
  initialSort: { columnId: 'gaps', direction: 'desc' },
  emptyText: 'Sin plugins que auditar en plugs\\.',
  filters: [
    {
      id: 'stateFilter',
      label: 'Estado',
      columnId: 'state',
      type: 'single',
      options: [
        { value: '', label: 'Todos', tone: 'neutral' },
        { value: 'incomplete', label: t('ui.dataAudit.withGaps'), tone: 'negative', predicate: dataAuditHasGaps },
        {
          value: 'complete',
          label: 'Completos',
          tone: 'positive',
          predicate: (plugin) => !dataAuditHasGaps(plugin),
        },
      ],
    },
  ],
  rowActions: {
    actions: [
      {
        id: 'view-data-detail',
        label: t('ui.dataAudit.viewDetail'),
        icon: 'file',
        onSelect: (plugin, trigger) => openDataAuditDetail(plugin, trigger),
      },
    ],
  },
};

let dataAuditTableController: TableController<DataAuditPlugin> | null = null;
let dataAuditBusy = false;
/** Botón que abrió el detalle del plugin: para devolverle el foco al cerrar. */
let dataAuditDetailOpener: HTMLButtonElement | null = null;
/** Plugin cuyo detalle está abierto; es a quien se le aplican las propuestas. */
let dataAuditDetailPlugin: DataAuditPlugin | null = null;
let dataAuditApplyBusy = false;

/**
 * Detalle de un plugin: los datos que la tabla no pinta (ruta, estado del DLL)
 * y las dos listas que pide la auditoría —qué falta y qué se puede rellenar—
 * con el origen de cada valor propuesto.
 */
function openDataAuditDetail(plugin: DataAuditPlugin, trigger: HTMLButtonElement): void {
  dataAuditDetailOpener = trigger;
  dataAuditDetailPlugin = plugin;
  closeDataAuditApplyConfirm();
  els.dataAuditApply.disabled = plugin.proposals.length === 0;
  els.dataAuditApply.title =
    plugin.proposals.length === 0
      ? t('ui.dataAudit.nothingToApply')
      : t('ui.dataAudit.applyTitle', { 0: plugin.proposals.length });
  els.dataAuditDetailTitle.textContent = t('ui.dataAudit.pluginHead', { 0: plugin.name });
  els.dataAuditDetailFields.replaceChildren(
    renderLogDetailField('Carpeta', plugin.path),
    renderLogDetailField('vfxinfo.txt', plugin.hasVfxinfo ? 'presente' : 'ausente'),
    renderLogDetailField('fxbLoader.meta.json', plugin.hasMeta ? 'presente' : 'ausente'),
    renderLogDetailField(t('ui.dataAudit.declaredDll'), plugin.dll.declared ?? t('ui.dataAudit.noDllName')),
    renderLogDetailField(
      t('ui.dataAudit.foundDll'),
      plugin.dll.resolved === null ? '(ninguno)' : `plugs/${plugin.dll.resolved}`,
    ),
    renderLogDetailField(
      'Arquitectura',
      plugin.dll.bitness === null ? '—' : t('ui.dataAudit.bits', { 0: plugin.dll.bitness }),
    ),
    renderLogDetailField(t('ui.dataAudit.vstEntry'), plugin.dll.vstEntrypoint ?? '—'),
  );

  const gaps = plugin.issues.map((issue) =>
    dataAuditItem(
      issue.field,
      issue.message,
      DATA_AUDIT_SEVERITY_LABELS[issue.severity] ?? issue.severity,
      issue.severity === 'note' ? 'badge' : 'badge off',
    ),
  );
  els.dataAuditDetailGaps.replaceChildren(
    dataAuditHeading(t('ui.dataAudit.gapsHead', { 0: plugin.issues.length })),
    ...(gaps.length === 0
      ? [dataAuditEmpty(t('ui.dataAudit.noGaps'))]
      : [dataAuditList(gaps)]),
  );

  const proposals = plugin.proposals.map((proposal) =>
    dataAuditItem(
      proposal.field,
      `= ${proposal.value}${proposal.note === undefined ? '' : ` · ${proposal.note}`}`,
      DATA_AUDIT_SOURCE_LABELS[proposal.source] ?? proposal.source,
      'badge on',
    ),
  );
  els.dataAuditDetailProposals.replaceChildren(
    dataAuditHeading(t('ui.dataAudit.fillable', { 0: plugin.proposals.length })),
    ...(proposals.length === 0
      ? [dataAuditEmpty(t('ui.dataAudit.nothingToPropose'))]
      : [dataAuditList(proposals)]),
  );

  els.dataAuditDetail.hidden = false;
  els.dataAuditDetailClose.focus({ preventScroll: true });
}

function closeDataAuditDetail(): void {
  if (els.dataAuditDetail.hidden) return;
  dataAuditDetailPlugin = null;
  closeDataAuditApplyConfirm();
  els.dataAuditApply.disabled = true;
  els.dataAuditDetail.hidden = true;
  els.dataAuditDetailFields.replaceChildren();
  els.dataAuditDetailGaps.replaceChildren();
  els.dataAuditDetailProposals.replaceChildren();
  const opener = dataAuditDetailOpener;
  dataAuditDetailOpener = null;
  if (opener?.isConnected && opener.getClientRects().length > 0) {
    opener.focus({ preventScroll: true });
  }
}

function setDataAuditApplyStatus(message: string, kind = ''): void {
  els.dataAuditApplyStatus.textContent = message;
  els.dataAuditApplyStatus.className = kind ? `status ${kind}` : 'status';
}

function closeDataAuditApplyConfirm(): void {
  els.dataAuditApplyConfirm.hidden = true;
  els.dataAuditApplyList.replaceChildren();
  els.dataAuditApplyNote.textContent = '';
  setDataAuditApplyStatus('');
  els.dataAuditApplyConfirmBtn.disabled = false;
  els.dataAuditApplyCancel.disabled = false;
}

/** Confirmación previa: qué se escribe y qué se respalda, antes de tocar nada. */
function renderDataAuditApplyConfirm(plugin: DataAuditPlugin): void {
  els.dataAuditApplyNote.textContent =
    t('msg.dataAuditApplyNote', { 0: plugin.proposals.length });
  els.dataAuditApplyList.replaceChildren(
    ...plugin.proposals.map((proposal) =>
      dataAuditItem(
        proposal.field,
        `= ${proposal.value}${proposal.note === undefined ? '' : ` · ${proposal.note}`}`,
        DATA_AUDIT_SOURCE_LABELS[proposal.source] ?? proposal.source,
        'badge on',
      ),
    ),
  );
  setDataAuditApplyStatus('');
  els.dataAuditApplyConfirm.hidden = false;
  els.dataAuditApplyConfirmBtn.focus({ preventScroll: true });
}

async function applyDataAuditProposals(): Promise<void> {
  const plugin = dataAuditDetailPlugin;
  if (plugin === null || dataAuditApplyBusy) return;
  if (!libraryRoot) {
    setDataAuditApplyStatus(t('ui.dataAudit.needRoot'), 'error');
    return;
  }

  dataAuditApplyBusy = true;
  els.dataAuditApplyConfirmBtn.disabled = true;
  els.dataAuditApplyCancel.disabled = true;
  setDataAuditApplyStatus(t('ui.dataAudit.writing'), 'busy');
  try {
    const result = await client.library.auditApply({
      libraryRoot,
      plugin: plugin.name,
      fields: plugin.proposals.map((proposal) => proposal.field),
    });
    const written = [
      result.vfxinfoPath === null ? null : 'vfxinfo.txt',
      result.metaPath === null ? null : 'fxbLoader.meta.json',
    ].filter((file): file is string => file !== null);
    const backups = result.backups.map((file) => file.split(/[\\/]/).pop() ?? file);
    const summary = [
      `Aplicado ${result.applied.length} valor(es)${written.length === 0 ? '' : ` en ${written.join(' y ')}`}.`,
      backups.length === 0 ? t('ui.dataAudit.noFilesToBackup') : t('ui.dataAudit.backup', { 0: backups.join(', ') }),
      result.skipped.length === 0 ? '' : t('ui.dataAudit.skippedProposals', { 0: result.skipped.length }),
      ...result.warnings,
    ]
      .filter(Boolean)
      .join(' ');
    closeDataAuditDetail();
    await loadDataAudit();
    setDataAuditStatus(summary, result.applied.length === 0 ? 'error' : 'ok');
  } catch (error) {
    setDataAuditApplyStatus(t('ui.dataAudit.applyError', { 0: describeError(error) }), 'error');
  } finally {
    dataAuditApplyBusy = false;
    if (els.dataAuditApplyConfirm.hidden === false) {
      els.dataAuditApplyConfirmBtn.disabled = false;
      els.dataAuditApplyCancel.disabled = false;
    }
  }
}

function destroyDataAuditTable(): void {
  closeDataAuditDetail();
  dataAuditTableController?.destroy();
  dataAuditTableController = null;
  els.dataAuditTable.replaceChildren();
}

function setDataAuditStatus(message: string, kind = ''): void {
  els.dataAuditStatus.textContent = message;
  els.dataAuditStatus.className = kind ? `status ${kind}` : 'status';
}

/**
 * `POST /library/audit` en modo lectura: la tabla es el detalle por plugin y el
 * resumen de arriba los totales. La auditoría no sondea —los datos solo
 * cambian cuando el usuario instala, importa o edita—, así que se relee con
 * «Actualizar» o al volver a abrir el cajón.
 */
async function loadDataAudit(): Promise<void> {
  if (dataAuditBusy) return;
  if (!libraryRoot) {
    destroyDataAuditTable();
    els.dataAuditPath.textContent = '';
    els.dataAuditSummary.textContent = '';
    setDataAuditStatus(t('ui.dataAudit.needRootAudit'), 'error');
    return;
  }

  dataAuditBusy = true;
  els.dataAuditRefresh.disabled = true;
  setDataAuditStatus(t('ui.dataAudit.auditing'), 'busy');
  try {
    const result = await client.library.audit({ libraryRoot });
    els.dataAuditPath.textContent = result.plugsPath;
    els.dataAuditSummary.textContent =
      t('msg.dataAuditSummary', {
        0: result.total,
        1: result.complete,
        2: result.incomplete,
        3: result.issueCount,
        4: result.proposalCount,
        5: result.scannedAt,
      });
    if (dataAuditTableController === null) {
      dataAuditTableController = mountTable(els.dataAuditTable, dataAuditTableView, result.plugins);
    } else {
      dataAuditTableController.setRows(result.plugins);
    }
    // Las filas se rehacen: si el detalle estaba abierto desde un botón que ya
    // no existe, se cierra (como en el resto de tablas de la vista).
    if (els.dataAuditDetail.hidden === false && dataAuditDetailOpener?.isConnected !== true) {
      closeDataAuditDetail();
    }
    setDataAuditStatus('');
  } catch (error) {
    destroyDataAuditTable();
    els.dataAuditPath.textContent = '';
    els.dataAuditSummary.textContent = '';
    setDataAuditStatus(t('ui.dataAudit.auditError', { 0: describeError(error) }), 'error');
  } finally {
    dataAuditBusy = false;
    els.dataAuditRefresh.disabled = false;
  }
}

function openDataAuditDrawer(opener?: HTMLElement): void {
  closeBanks();
  closeMeta();
  closeWizards();
  closePluginWizard();
  closeLogDrawer();
  closeImportPackageDrawer();
  closeCustomPluginDrawer();
  closeAuditDrawer();
  closeCaptureDrawer();
  showPanel(els.dataAuditDrawer, opener);
  els.dataAuditPath.textContent = '';
  els.dataAuditSummary.textContent = '';
  destroyDataAuditTable();
  setDataAuditStatus('');
  void loadDataAudit();
}

function closeDataAuditDrawer(): void {
  if (els.dataAuditDrawer.hidden) return;
  hidePanel(els.dataAuditDrawer);
  destroyDataAuditTable();
  els.dataAuditPath.textContent = '';
  els.dataAuditSummary.textContent = '';
  setDataAuditStatus('');
}

els.dataAuditNavBtn.addEventListener('click', () => {
  openDataAuditDrawer(els.dataAuditNavBtn);
});

els.dataAuditClose.addEventListener('click', () => {
  closeDataAuditDrawer();
});

els.dataAuditRefresh.addEventListener('click', () => {
  void loadDataAudit();
});

els.dataAuditDetailClose.addEventListener('click', closeDataAuditDetail);

els.dataAuditApply.addEventListener('click', () => {
  const plugin = dataAuditDetailPlugin;
  if (plugin === null || plugin.proposals.length === 0) return;
  renderDataAuditApplyConfirm(plugin);
});

els.dataAuditApplyCancel.addEventListener('click', () => {
  closeDataAuditApplyConfirm();
  els.dataAuditApply.focus({ preventScroll: true });
});

els.dataAuditApplyConfirmBtn.addEventListener('click', () => {
  void applyDataAuditProposals();
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
  closeDataAuditDrawer();
  closeCaptureDrawer();
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
    closeDataAuditDrawer();
    closeCaptureDrawer();
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

// ---------------------------------------------------------------- idioma
const localeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="ui-locale"]')];

function syncLocaleInputs(locale: Locale): void {
  for (const input of localeInputs) input.checked = input.value === locale;
}

/** Cambia el idioma de toda la interfaz sin recargar ni perder el estado. */
function applyLocale(locale: Locale): void {
  setLocale(locale);
  syncDocumentLang(locale);
  syncLocaleInputs(locale);
  applyI18n();
  if (scanData !== null) render(scanData);
}

for (const input of localeInputs) {
  input.addEventListener('change', () => {
    if (input.checked) applyLocale(input.value as Locale);
  });
}

onLocaleChange((locale) => {
  syncDocumentLang(locale);
  syncLocaleInputs(locale);
  applyI18n();
  if (scanData !== null) render(scanData);
});

initAppI18n();
applyI18n();
syncLocaleInputs(getLocale());

void initCapabilities();
void pruneRecents();

if (libraryRoot) {
  void scan();
} else {
  setStatus(t('ui.app.needRoot'), 'info');
}
