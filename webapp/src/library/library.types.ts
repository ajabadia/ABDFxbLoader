import type { FxbConfigSnapshot } from '../fxb-config/fxb-config.types';
import type { BankCompatibility, BankReference, FxbBankInfo, FxbEndianness } from './fxb-bank';

/** Modelo del módulo de librería VFX (carpeta raíz con `plugs\<plugin>\`). */

export interface PluginEntry {
  /** Nombre de la carpeta del plugin dentro de `plugs\`. */
  name: string;
  /** Ruta absoluta del directorio del plugin. */
  path: string;
  /** El escaneo del binario usa la presencia de `fxbLoader.config`. */
  installed: boolean;
  hasVfxinfo: boolean;
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

/** Estado del `fxbLoader.dll` que se instalaría. */
export interface LoaderDllInfo {
  path: string;
  /** El archivo es un PE32 i386 válido. */
  valid: boolean;
  bitness: 32 | 64 | null;
  machine: string | null;
  issues: string[];
}

export interface LibraryScanResult {
  libraryRoot: string;
  plugsPath: string;
  /** DLL validada al escanear; el lote y las instalaciones la exigen PE32. */
  loader: LoaderDllInfo;
  plugins: PluginEntry[];
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
 * Aviso de cada paso interno de `install`/`uninstall`. `runBatch` lo usa para
 * emitir un evento `step` por paso sin que la vista espere al resultado final.
 */
export type StepListener = (step: LibraryStep) => void;

export interface InstallInput {
  libraryRoot: string;
  plugin: string;
  /** Ruta del `fxbLoader.dll` a instalar; debe ser PE32 i386. */
  dllSourcePath: string;
  /** Reinstalar aunque `fxbLoader.config` ya exista. */
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

/** Operación de lote: instalar o desinstalar varios plugins de una vez. */
export type BatchAction = 'install' | 'uninstall';

export interface BatchInput {
  libraryRoot: string;
  action: BatchAction;
  /** Carpetas de `plugs\\`, en el orden en que se deben procesar. */
  plugins: string[];
  /** Ruta del cargador; solo se usa con `action: 'install'`. */
  dllSourcePath: string;
  /** Reinstalar los que ya tengan `fxbLoader.config`. */
  force?: boolean;
  /** Calcular el plan de cada plugin sin escribir nada. */
  dryRun?: boolean;
}

export type BatchPluginStatus =
  /** Operación aplicada, o plan calculado si la petición era un `dryRun`. */
  | 'installed'
  | 'uninstalled'
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

export class LibraryPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryPathError';
  }
}

export class PluginNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginNotFoundError';
  }
}

/** Conflicto de estado: ya instalado, no instalado, sin respaldo, etc. */
export class PluginStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginStateError';
  }
}

/** La operación no se puede completar con el contenido actual de los archivos. */
export class LibraryOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryOperationError';
  }
}
