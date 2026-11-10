import type { TrashInfo } from '../common/trash';
import type { FxbConfigSnapshot } from '../fxb-config/fxb-config.types';
import type { BankCompatibility, BankReference, FxbBankInfo, FxbEndianness } from './fxb-bank';

/** Modelo del módulo de librería VFX (carpeta raíz con `plugs\<plugin>\`). */

export interface PluginEntry {
  /** Nombre de la carpeta del plugin dentro de `plugs\`. */
  name: string;
  /** Ruta absoluta del directorio del plugin. */
  path: string;
  /** El escaneo del binario usa la presencia de `fxbLoader.config`. */
  hasLoader: boolean;
  hasVfxinfo: boolean;
  /** Existe un wizard compatible en la base de datos de wizards. */
  hasWizard: boolean;
  /** Identificador del wizard correspondiente si existe match, o `null`. */
  wizardId: string | null;
  /** Existe `fxbLoader.meta.json`: el plugin ya tiene catálogo propio. */
  hasMeta: boolean;
  /** `pluginName` leído de `fxbLoader.config`, o `null` si no está instalado. */
  pluginName: string | null;
  warnings: string[];
  /**
   * Compatibilidad con el cargador de 32 bits: `true` si el binario del plugin
   * (y el cargador ya instalado) es PE32 i386; `false` si es incompatible de
   * forma comprobable, incluido un archivo que existe y no es un PE; `null` si
   * el DLL no existe o no se pudo leer.
   */
  compatible: boolean | null;
  /** Motivos de `compatible: false` o de por qué no se pudo verificar. */
  compatibilityIssues: string[];
}

/**
 * Resumen de bancos de un plugin para la tabla del escaneo, tomado de la misma
 * lista que devuelve el panel de bancos: solo cuentan los `.fxb` válidos y se
 * respeta el tope de `MAX_REFERENCE_SCAN` archivos.
 */
export interface PluginBanksSummary {
  /** Bancos encontrados en la carpeta de presets. */
  count: number;
  /** Nombres de esos bancos, en el mismo orden que el panel. */
  names: string[];
}

/** Estado del `fxbLoader.dll` que se instalaría. */
export interface LoaderDllInfo {
  path: string;
  /** El archivo es un PE32 i386 válido. */
  valid: boolean;
  bitness: 32 | 64 | null;
  machine: string | null;
  issues: string[];
}

/** Entrada del escaneo: el plugin y el resumen de bancos que pinta la tabla. */
export interface ScanPluginEntry extends PluginEntry {
  banks: PluginBanksSummary;
}

export interface LibraryScanResult {
  libraryRoot: string;
  plugsPath: string;
  /** DLL validada al escanear; el lote y las instalaciones la exigen PE32. */
  loader: LoaderDllInfo;
  plugins: ScanPluginEntry[];
}

export type LibraryActionKind =
  | 'backup'
  | 'copy'
  | 'patch'
  | 'write-config'
  | 'create-dir'
  | 'delete'
  | 'restore';

export interface LibraryAction {
  kind: LibraryActionKind;
  path: string;
  detail?: string;
}

/** Un paso interno, avisado justo antes de ejecutarlo. */
export interface LibraryStep {
  action: LibraryAction;
  /** Posición 0-based dentro de los pasos del plugin. */
  index: number;
  /** Pasos que hará el plugin. */
  total: number;
}

/**
 * Aviso de cada paso interno de `addLoader`/`removeLoader`. `runBatch` lo usa
 * para emitir un evento `step` por paso sin que la vista espere al resultado.
 */
export type StepListener = (step: LibraryStep) => void;

export interface InstallInput {
  libraryRoot: string;
  plugin: string;
  /** Ruta del `fxbLoader.dll` a copiar; debe ser PE32 i386. */
  dllSourcePath: string;
  /** Volver a ponerlo aunque `fxbLoader.config` ya exista. */
  force?: boolean;
  /** Calcular el plan sin escribir nada. */
  dryRun?: boolean;
}

export interface InstallResult {
  plugin: PluginEntry;
  actions: LibraryAction[];
  dryRun: boolean;
}

export interface UninstallInput {
  libraryRoot: string;
  plugin: string;
  dryRun?: boolean;
}

export interface UninstallResult {
  plugin: PluginEntry;
  actions: LibraryAction[];
  dryRun: boolean;
}

/** Operación de lote: poner o quitar el cargador en varios plugins de una vez. */
export type BatchAction = 'add' | 'remove';

export interface BatchInput {
  libraryRoot: string;
  action: BatchAction;
  /** Carpetas de `plugs\\`, en el orden en que se deben procesar. */
  plugins: string[];
  /** Ruta del cargador; solo se usa con `action: 'add'`. */
  dllSourcePath: string;
  /** Volver a ponerlo en los que ya tengan `fxbLoader.config`. */
  force?: boolean;
  /** Calcular el plan de cada plugin sin escribir nada. */
  dryRun?: boolean;
}

export type BatchPluginStatus =
  /** Operación aplicada, o plan calculado si la petición era un `dryRun`. */
  | 'added'
  | 'removed'
  | 'planned'
  /** El plugin no se pudo operar; el motivo va en `message`. */
  | 'failed';

/** Resultado de un único plugin; un fallo no cancela el resto del lote. */
export interface BatchPluginResult {
  name: string;
  status: BatchPluginStatus;
  /** Motivo del fallo; `null` cuando la operación fue correcta. */
  message: string | null;
  /** Estado del plugin tras la operación; `null` si no se pudo operar. */
  entry: PluginEntry | null;
  /** Pasos aplicados o, con `dryRun`, el plan. Vacío si falló antes. */
  actions: LibraryAction[];
}

export interface BatchResult {
  action: BatchAction;
  dryRun: boolean;
  total: number;
  succeeded: number;
  failed: number;
  results: BatchPluginResult[];
}

/**
 * El contrato del flujo NDJSON vive en `src/client/batch-stream.ts`, junto al
 * resto del contrato que consume el navegador; el servidor lo reexporta para
 * emitir exactamente los mismos eventos.
 */
export type { BatchStreamEvent, BatchStreamStepKind } from '../client/batch-stream';

export interface BankImportInput {
  libraryRoot: string;
  plugin: string;
  /** Rutas absolutas de los `.fxb` a copiar. */
  sourcePaths: string[];
  /** uniqueID esperado del plugin: 4 caracteres (`MySy`) o entero. */
  expectedUniqueId?: string | number;
  /** `fxVersion` esperada del plugin. */
  expectedFxVersion?: number;
  /** Sobrescribir un banco con el mismo nombre (por defecto sí, como el original). */
  overwrite?: boolean;
}

export interface BankImportResult {
  source: string;
  fileName: string;
  target: string;
  status: 'imported' | 'overwritten' | 'rejected';
  compatibility: BankCompatibility;
  /** Motivo del rechazo, si lo hay. */
  reason?: string;
  issues?: string[];
  warnings?: string[];
  bank: FxbBankInfo | null;
}

export interface BankImportResponse {
  plugin: PluginEntry;
  /** Carpeta de destino: `<plugin>\<programDirName>\`. */
  presetsDir: string;
  reference: BankReference;
  results: BankImportResult[];
}

export interface BankCreateInput {
  libraryRoot: string;
  plugin: string;
  /** Nombre del archivo, sin `.fxb` si falta. */
  bankName?: string;
  /**
   * Nombres de programa, en orden. Cada uno genera un `FxCk` con
   * `numParams` parámetros a cero; los nombres vacíos se sustituyen
   * por `Program <n>`. Solo se admiten en modo `programNames`;
   * el modo `chunk` los rechaza.
   */
  programNames?: string[];
  /** Parámetros por programa; por defecto 0. */
  numParams?: number;
  /** Sobrescribir si ya existe ese archivo (por defecto no). */
  overwrite?: boolean;
  /** Reemplaza el `fxVersion` del fichero; por defecto 0. */
  fxVersion?: number;
  /** Orden de bytes del archivo: little en Windows (por defecto) o el estándar big de Steinberg. */
  endianness?: FxbEndianness;
  /**
   * Modo de creación: `programNames` (por defecto) genera programas
   * `FxCk`; `chunk` genera un banco `CcnK/FBCh` con contenido opaco.
   */
  mode?: 'programNames' | 'chunk';
  /**
   * Solo en modo `chunk`: contenido opaco del plugin en hexadecimal (sin
   * `0x`), sin la cabecera del banco; genera un banco `CcnK/FBCh`.
   */
  chunkHex?: string;
  /** Solo en modo `chunk`: versión del formato (1 o 2); por defecto 1. */
  chunkVersion?: 1 | 2;
  /** Solo en modo `chunk` con `chunkVersion: 2`: programa activo; por defecto 0. */
  currentProgram?: number;
  /** Solo en modo `chunk`: número de programas informativo; por defecto 0. */
  chunkNumPrograms?: number;
}

export interface BankCreateResult {
  plugin: PluginEntry;
  presetsDir: string;
  /** Ruta absoluta del `.fxb` creado. */
  target: string;
  status: 'created' | 'overwritten';
  /** FourCC del plugin objetivo, sacado del `id` de `vfxinfo.txt`. */
  fourCc: string;
  /** Copia del banco ya revalidado tras escribirlo. */
  bank: FxbBankInfo;
}

export interface BankInspectInput {
  /** Ruta absoluta del `.fxb` a inspeccionar. No se copia. */
  sourcePath: string;
  /** Sin `libraryRoot`/`plugin` solo se valida el archivo. */
  libraryRoot?: string;
  plugin?: string;
  expectedUniqueId?: string | number;
  expectedFxVersion?: number;
}

/** Banco ya presente en la carpeta de presets del plugin. */
export interface PluginBankEntry {
  fileName: string;
  size: number;
  bank: FxbBankInfo;
}

/** Banco del plugin comparado con el archivo inspeccionado. */
export interface PluginBankSummary extends PluginBankEntry {
  /** Mismo uniqueID que el banco inspeccionado. */
  sameUniqueId: boolean;
  /** Misma `fxVersion` que el banco inspeccionado. */
  sameFxVersion: boolean;
}

export interface BankListInput {
  libraryRoot: string;
  plugin: string;
}

/**
 * Estado de la carpeta de bancos de un plugin y de su `fxbLoader.config`.
 * No crea nada: con la carpeta ausente devuelve `banks: []`.
 */
export interface BankListResult {
  plugin: PluginEntry;
  presetsDir: string;
  /** `false` si la carpeta todavía no existe (se crea al importar). */
  presetsDirExists: boolean;
  /** Bancos válidos, ordenados por nombre; solo se lee su cabecera. */
  banks: PluginBankEntry[];
  /**
   * Respaldo `<banco>.orig` del banco por defecto, si existe. La vista lo usa
   * para habilitar «Restaurar original» sin lanzar una petición que vaya a
   * fallar; no se lee el contenido, solo el tamaño.
   */
  defaultBackup: BankBackupSummary | null;
  /** Snapshot de la configuración, para el control optimista al guardar. */
  config: FxbConfigSnapshot;
}

export interface BankInspectResult {
  source: string;
  fileName: string;
  size: number;
  sha256: string;
  /** `false` si el archivo no es un banco VST2 usable; el detalle va en `issues`. */
  valid: boolean;
  bank: FxbBankInfo | null;
  issues: string[];
  warnings: string[];
  /** Referencia usada para comparar (explícita o el primer banco del plugin). */
  reference: BankReference;
  compatibility: BankCompatibility;
  reason: string | null;
  /** Destino que tendría al importarlo; `null` si no se pasó plugin. */
  target: string | null;
  presetsDir: string | null;
  targetExists: boolean;
  /** Bancos válidos que ya están en la carpeta del plugin. */
  existingBanks: PluginBankSummary[];
}

export interface BankExportInput {
  libraryRoot: string;
  plugin: string;
  /** Nombre del banco ya importado en la carpeta de presets del plugin. */
  fileName: string;
  /** Orden de bytes del archivo de salida. */
  endianness: FxbEndianness;
  /** Reemplazar el destino si ya existe (por defecto no). */
  overwrite?: boolean;
}

/** Un banco implicado en la exportación, con su hash y su cabecera. */
export interface BankExportFile {
  fileName: string;
  path: string;
  size: number;
  sha256: string;
  bank: FxbBankInfo;
}

export interface BankExportResult {
  plugin: PluginEntry;
  presetsDir: string;
  source: BankExportFile;
  target: BankExportFile;
  /** `false` si el banco ya estaba en el orden pedido (no se invirtió nada). */
  changed: boolean;
  /** Campos de 32 bits reescritos. */
  fields: number;
  /** Programas recorridos; 0 en un `FBCh`. */
  programs: number;
  /** Tamaños de chunk reescritos (programas `FPCh` más el del `FBCh`). */
  chunks: number;
}

export interface BankConvertInput {
  libraryRoot: string;
  plugin: string;
  /**
   * Orden de bytes de destino. Sin él se invierte el que tiene el banco: la
   * conversión natural de un banco legacy guardado por un plugin de Windows.
   */
  endianness?: FxbEndianness;
}

/** Copia byte a byte del banco antes de convertirlo en el sitio. */
export interface BankBackupFile {
  fileName: string;
  path: string;
  size: number;
  sha256: string;
}

/** Nombre y tamaño del respaldo del banco por defecto, sin leerlo entero. */
export interface BankBackupSummary {
  fileName: string;
  size: number;
}

export interface BankConvertResult {
  plugin: PluginEntry;
  presetsDir: string;
  /** Banco por defecto tomado de `fxbLoader.config`. */
  fileName: string;
  /** El archivo tal como estaba antes de convertirlo. */
  source: BankExportFile;
  /** El mismo archivo (mismo nombre y ruta) ya en el orden pedido. */
  target: BankExportFile;
  /** Respaldo del original; `null` si no había nada que convertir. */
  backup: BankBackupFile | null;
  /** `true` si el respaldo se creó ahora; si ya existía, se conserva el primero. */
  backupCreated: boolean;
  /** `false` si el banco ya estaba en el orden pedido (no se escribió nada). */
  changed: boolean;
  /** Campos de 32 bits reescritos. */
  fields: number;
  /** Programas recorridos; 0 en un `FBCh`. */
  programs: number;
  /** Tamaños de chunk reescritos (programas `FPCh` más el del `FBCh`). */
  chunks: number;
}

export interface BankRestoreInput {
  libraryRoot: string;
  plugin: string;
}

/** Resultado de devolver el banco por defecto al contenido de su respaldo. */
export interface BankRestoreResult {
  plugin: PluginEntry;
  presetsDir: string;
  /** Banco por defecto tomado de `fxbLoader.config` (`defaultFxbName`). */
  fileName: string;
  /** El banco ya restaurado: mismo nombre y ruta, contenido del respaldo. */
  restored: BankExportFile;
  /** Respaldo usado. Solo se lee: queda igual, con su mismo hash y tamaño. */
  backup: BankBackupFile;
  /** `false` si el banco ya era byte a byte el respaldo (no se escribió nada). */
  changed: boolean;
}

export interface BankDiscardBackupInput {
  libraryRoot: string;
  plugin: string;
}

/**
 * Resultado de enviar el respaldo `<banco>.orig` del banco por defecto a la
 * papelera. El banco en sí no se toca: lo único que cambia es que el respaldo
 * ya no está en la carpeta del plugin, aunque sigue recuperable desde la
 * papelera del sistema.
 */
export interface BankDiscardBackupResult {
  plugin: PluginEntry;
  presetsDir: string;
  /** Banco por defecto tomado de `fxbLoader.config` (`defaultFxbName`). */
  fileName: string;
  /** Respaldo que se envió a la papelera, con el tamaño y el hash que tenía. */
  discarded: BankBackupFile;
  /** Papelera donde quedó y cómo recuperarlo. */
  trash: TrashInfo;
}

export interface BankRenameInput {
  libraryRoot: string;
  plugin: string;
  /** Banco ya importado en la carpeta de presets del plugin. */
  fileName: string;
  /** Nombre nuevo, con extensión `.fxb` y sin separadores de ruta. */
  newName: string;
}

/** Resultado de renombrar un banco dentro de la carpeta de presets. */
export interface BankRenameResult {
  plugin: PluginEntry;
  presetsDir: string;
  /** El archivo tal como estaba antes (con su hash y su cabecera). */
  previous: BankExportFile;
  /** El mismo contenido, ya en su nombre nuevo. */
  renamed: BankExportFile;
  /**
   * `true` si el banco era el `defaultFxbName` del plugin y la configuración se
   * actualizó para que la DLL lo siga cargando.
   */
  defaultUpdated: boolean;
  /** Respaldo `<banco>.orig` renombrado junto al banco, si existía. */
  backupRenamed: string | null;
}

export interface BankClearInput {
  libraryRoot: string;
  plugin: string;
  fileName: string;
}

/**
 * Resultado de vaciar un banco: se reescribe en su sitio con cero programas,
 * conservando su `uniqueID`, su versión y su orden de bytes.
 */
export interface BankClearResult {
  plugin: PluginEntry;
  presetsDir: string;
  /** El banco tal como estaba, antes de vaciarlo. */
  previous: BankExportFile;
  /** El banco ya vacío (mismo nombre y ruta). */
  cleared: BankExportFile;
  /** Programas que tenía antes de vaciarlo. */
  programs: number;
  /** Copia byte a byte del original; `null` si no se creó. */
  backup: BankBackupFile | null;
  /** `true` si el respaldo se creó ahora; el primero que exista se conserva. */
  backupCreated: boolean;
}

export interface BankDeleteInput {
  libraryRoot: string;
  plugin: string;
  fileName: string;
}

/** Resultado de enviar un banco a la papelera del sistema. */
export interface BankDeleteResult {
  plugin: PluginEntry;
  presetsDir: string;
  /** Banco enviado a la papelera, con el tamaño y el hash que tenía. */
  deleted: { fileName: string; path: string; size: number; sha256: string };
  /** Papelera donde quedó y cómo recuperarlo. */
  trash: TrashInfo;
  /** Bancos que quedan en la carpeta del plugin después del borrado. */
  remaining: number;
  /** `true` si el banco borrado era el `defaultFxbName` del plugin. */
  wasDefault: boolean;
}

import { CodedError, type ApiErrorCode } from '../common/api-errors';

/**
 * Base de los errores de dominio de la biblioteca. Comparte el constructor de
 * `CodedError` y toma el nombre de la clase concreta (`new.target`) para que
 * los logs sigan distinguiendo cada fallo sin repetir el constructor cinco veces.
 */
export abstract class LibraryDomainError extends CodedError {
  constructor(
    message: string,
    apiCode?: ApiErrorCode,
    apiParams?: Record<string, string | number>,
  ) {
    super(message, apiCode, apiParams);
    this.name = new.target.name;
  }
}

export class LibraryPathError extends LibraryDomainError {}

export class PluginNotFoundError extends LibraryDomainError {}

/** Conflicto de estado: ya instalado, no instalado, sin respaldo, etc. */
export class PluginStateError extends LibraryDomainError {}

/** Entrada para la preferencia local de DLL de un plugin. */
export interface DllPreferenceInput {
  pluginDir: string;
  /** Valor nuevo de `dll_name`; relativo al plugin y siempre dentro de él. */
  dllName: string;
}

/** Resultado de guardar la preferencia local de DLL en `vfxinfo.txt`. */
export interface DllPreferenceResult {
  pluginDir: string;
  /** Valor que tenía la línea `dll_name` antes de guardar; `null` si ya apuntaba al cargador. */
  previousDllName: string | null;
  /** Valor guardado. */
  dllName: string;
  /** Respaldo `vfxinfo.tx_` creado o conservado, si procede. */
  backupFile: string | null;
  /** `false` si el archivo no cambió porque ya era el valor pedido. */
  changed: boolean;
  actions: readonly LibraryAction[];
}

export class DllPreferenceError extends LibraryDomainError {}

/** La operación no se puede completar con el contenido actual de los archivos. */
export class LibraryOperationError extends LibraryDomainError {}

export interface LibraryInspectDllInput {
  dllPath: string;
}

export interface LibraryInspectDllResult {
  validPe: boolean;
  bitness: number | null;
  is32BitCompatible: boolean;
  isVstPlugin: boolean;
  vstEntrypoint: 'VSTPluginMain' | 'main' | null;
  internalDllName: string | null;
  suggestedName: string;
  suggestedId: string;
  exportedNames: string[];
  issues: string[];
  matchingWizard: {
    id: string;
    name: string;
    vendor: string;
    genre: string;
    dllName: string;
    isSynth: boolean;
  } | null;
}

export interface LibraryCreateCustomPluginInput {
  libraryRoot: string;
  sourceDllPath: string;
  folderName: string;
  name: string;
  id: string;
  isSynth: boolean;
  parameterCount?: number;
  programCount?: number;
  hasEditor?: boolean;
  editorWidth?: number;
  editorHeight?: number;
  vendor?: string;
  genre?: string;
  saveAsWizard?: boolean;
  overwrite?: boolean;
}

export interface LibraryCreateCustomPluginResult {
  created: boolean;
  pluginDir: string;
  dllRelativePath: string;
  vfxinfoPath: string;
  metaPath: string;
  wizardPath: string | null;
  warnings: string[];
}

