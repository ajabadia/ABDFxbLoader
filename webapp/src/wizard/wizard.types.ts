/**
 * Tipos de datos para el módulo de Wizards de VFX / V-Machine.
 */

export interface WizardRecord {
  /** VST Unique ID (identificador numérico en formato cadena). */
  id: string;
  /** Nombre del plugin en el wizard. */
  name: string;
  /** Abreviatura de 3-4 caracteres para pantalla LCD de hardware. */
  nameAbbreviation: string;
  /** Versión del wizard. */
  version: string;
  /** Ruta relativa del DLL configurada en el wizard (ej. "SuperWave P8/P8.dll"). */
  dllName: string;
  /** Versión del DLL si está anotada. */
  dllVersion: string;
  /** Indica si es un instrumento/sinte (true) o un efecto (false). */
  isSynth: boolean;
  /** Indica si el plugin dispone de interfaz gráfica propia. */
  hasEditor: boolean;
  /** Número de parámetros accesibles. */
  parameterCount: number;
  /** Número de programas/presets internos. */
  programCount: number;
  /** Ancho de la ventana del editor gráfico en píxeles. */
  editorWidth: number;
  /** Alto de la ventana del editor gráfico en píxeles. */
  editorHeight: number;
  /** Fabricante / desarrollador del plugin. */
  vendor: string;
  /** Sitio web o URL de referencia del fabricante. */
  vendorUrl: string;
  /** Tipo de distribución: 'Free', 'Commercial', 'Demo', etc. */
  vendorType: string;
  /** Género o categoría (ej. 'Synth', 'Effect', 'Delay', 'Filter'). */
  genre: string;
  /** Notas de uso, rendimiento y problemas conocidos. */
  notes: string;
  /** Notas descriptivas del fabricante. */
  vendorNotes: string;
  /** Fecha de creación o revisión del wizard (si existe). */
  created: string;
  /** Lista de archivos adicionales que deben copiarse a la carpeta del plugin. */
  filesToCopy: string[];
  /** Lista de carpetas adicionales que deben copiarse (muestras, presets). */
  dirsToCopy: string[];
  /** Archivos de configuración a generar dentro del plugin (nombre -> contenido). */
  filesToCreate: Record<string, string>;
  /** Enlaces simbólicos de sistema para el entorno Wine de V-Machine. */
  symlinks: string[];
  /** Bloque REGEDIT4 con las claves del registro de Windows necesarias. */
  registryKeys: string;
  /** Banderas o parámetros técnicos adicionales del wizard. */
  flags: Record<string, string | boolean>;
  /** Ruta relativa de origen del archivo del wizard dentro del repositorio. */
  sourcePath: string;
  /** Contenido del archivo de instrucciones readme.txt si acompaña al wizard. */
  readme: string | null;
}

/** Resumen ligero para listados, búsquedas y autocompletados. */
export interface WizardSummary {
  id: string;
  name: string;
  vendor: string;
  genre: string;
  nameAbbreviation: string;
  isSynth: boolean;
  dllName: string;
  hasRegistryKeys: boolean;
  hasFilesToCopy: boolean;
  hasDirsToCopy: boolean;
  hasReadme: boolean;
  sourcePath: string;
}

export interface WizardListResult {
  total: number;
  offset: number;
  limit: number;
  items: WizardSummary[];
}

export interface WizardMatchQuery {
  id?: string;
  name?: string;
  dllName?: string;
}

export interface WizardApplyMetaInput {
  pluginDir: string;
  wizardId?: string;
  overwriteNotes?: boolean;
}

export interface WizardCreateVfxinfoInput {
  pluginDir: string;
  wizardId?: string;
  force?: boolean;
}

export interface WizardInstallPluginInput {
  wizardId: string;
  libraryRoot: string;
  dllSourcePath: string;
  pluginFolderName?: string;
  overwrite?: boolean;
  initializeBank?: boolean;
}

export interface WizardInstallPluginResult {
  pluginName: string;
  pluginDir: string;
  dllName: string;
  dllPath: string;
  isCompatible32Bit: boolean;
  vfxinfoCreated: boolean;
  metaCreated: boolean;
  registryFileCreated: boolean;
  registryFilePath: string | null;
  requiredFiles: string[];
  requiredDirs: string[];
  warnings: string[];
  readme: string | null;
}
