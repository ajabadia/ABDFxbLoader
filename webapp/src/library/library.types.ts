import type { FxbConfigSnapshot } from '../fxb-config/fxb-config.types';
import type { BankCompatibility, BankReference, FxbBankInfo } from './fxb-bank';

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
   * forma comprobable; `null` si el binario no se pudo inspeccionar.
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
