/**
 * Contrato de `fxbLoader.config`, reconstruido por ingeniería inversa.
 * Ver `fxbLoaderConfig.spec.md` en la raíz del repositorio.
 */
export interface FxbConfig {
  /** Nombre del DLL original del plugin (no una ruta). */
  pluginName: string;
  /** Nombre del `.fxb` preseleccionado en el diálogo, sin ruta. */
  defaultFxbName: string;
  /** Nombre de la subcarpeta de bancos, relativa al directorio del plugin. */
  programDirName: string;
  /** Activa o desactiva la carga del banco al abrir el plugin. */
  loadFxbBank: boolean;
}

/** Estado del archivo tal como lo ve el cliente, para control optimista. */
export interface FxbConfigSnapshot {
  configPath: string;
  exists: boolean;
  /** `null` cuando el archivo no existe. */
  mtimeMs: number | null;
  size: number;
  config: FxbConfig;
  warnings: string[];
}

export interface FxbConfigWriteInput {
  pluginDir: string;
  /**
   * `mtimeMs` que el cliente leyó, o `null` si el archivo no existía.
   * Si ya no coincide, la escritura se rechaza con conflicto.
   */
  expectedMtimeMs: number | null;
  /** Solo las claves a cambiar; el resto se conserva de disco. */
  config: Partial<FxbConfig>;
}

export class FxbConfigValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Configuración no válida: ${issues.join('; ')}`);
    this.name = 'FxbConfigValidationError';
    this.issues = issues;
  }
}

export class FxbConfigConflictError extends Error {
  readonly current: FxbConfigSnapshot;

  constructor(current: FxbConfigSnapshot) {
    super('El archivo cambió en disco desde la última lectura');
    this.name = 'FxbConfigConflictError';
    this.current = current;
  }
}

export class FxbConfigPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FxbConfigPathError';
  }
}
