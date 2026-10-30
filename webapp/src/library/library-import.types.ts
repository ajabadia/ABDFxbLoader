/**
 * Tipos para la inspección e importación de paquetes externos (.vfxlibrary o
 * carpetas de plugins con sus bancos) hacia la librería VFX activa.
 */

export interface PackageWizardSummary {
  id: string;
  name: string;
  vendor: string;
  isSynth: boolean;
  matchReason: 'id' | 'dll' | 'name' | 'suggestion' | 'selected';
  dllName: string;
  filesToCopy: string[];
  missingFilesToCopy: string[];
  dirsToCopy: string[];
  missingDirsToCopy: string[];
  filesToCreate: string[];
  missingFilesToCreate: string[];
  hasRegistryKeys: boolean;
  registryFilePresent: boolean;
  hasReadme: boolean;
  readme: string | null;
  notes: string;
  symlinks: string[];
  registryKeys: string;
}

export interface PackagePluginSummary {
  /** Nombre de la carpeta del plugin (ej. "V-Station Demo"). */
  name: string;
  /** Ruta absoluta a la carpeta del plugin de origen. */
  sourceDir: string;
  /** Subruta relativa o nombre del paquete contenedor de origen. */
  packageSource?: string;
  /** Nombre del archivo DLL detectado, o `null`. */
  dllName: string | null;
  /** Tiene archivo vfxinfo.txt. */
  hasVfxinfo: boolean;
  /** Identificador VST numérico si se leyó de vfxinfo.txt. */
  vfxinfoId: number | null;
  /** Nombre interno del plugin según vfxinfo.txt. */
  vfxinfoName: string | null;
  /** Número de archivos en la carpeta del plugin. */
  fileCount: number;
  /** Tamaño total en bytes de la carpeta del plugin. */
  totalSizeBytes: number;
  /** Ya existe una carpeta homónima en `<targetLibraryRoot>/plugs/<name>`. */
  alreadyExistsInTarget: boolean;
  /** Wizard oficial de SM Pro Audio / VFX que coincide con este plugin, si existe. */
  matchedWizard?: PackageWizardSummary | null;
  /** Opciones candidatas para confirmar una coincidencia dudosa. */
  wizardCandidates?: PackageWizardSummary[];
}

export interface PackageBankSummary {
  /** Nombre de la carpeta del banco (ej. "000_Novation V-Station demo.vfxbank"). */
  name: string;
  /** Ruta absoluta al banco de origen. */
  sourceDir: string;
  /** Subruta relativa o nombre del paquete contenedor de origen. */
  packageSource?: string;
  /** Número de carpetas .vfxpreset detectadas dentro del banco. */
  presetCount: number;
  /** Tamaño total en bytes de la carpeta del banco. */
  totalSizeBytes: number;
  /** Ya existe un banco homónimo en `<targetLibraryRoot>/banks/<name>`. */
  alreadyExistsInTarget: boolean;
  /** ID de plugin numérico detectado en los chunks del banco. */
  chunkPluginId?: number | null;
  /** FourCC textual del plugin detectado en los chunks (ej. "NvS0"). */
  chunkPluginFourCc?: string | null;
  /** Nombre del plugin oficial o wizard con el que concuerda el banco. */
  matchedWizardName?: string | null;
  /** El banco es completamente concordante y no tiene carencias estructurales. */
  isConcordant?: boolean;
  /** Las carencias detectadas son reparables (desalineación de IDs o falta de preset.vfx). */
  canRepair?: boolean;
  /** Carencias o advertencias detectadas en los presets del banco. */
  deficiencies?: string[];
}

export interface InspectPackageInput {
  /** Ruta absoluta a la carpeta de la librería o paquete externo a inspeccionar. */
  packagePath: string;
  /** Ruta de la librería activa de destino (para detectar colisiones). */
  targetLibraryRoot: string;
}

export interface InspectPackageResult {
  /** Ruta canónica resuelta del paquete (donde residen plugs/ o el plugin). */
  sourcePath: string;
  /** Tipo de estructura detectada: librería completa o carpeta de un plugin. */
  resolvedKind: 'vfxlibrary' | 'plugin-folder';
  /** Plugins encontrados listos para importar. */
  plugins: PackagePluginSummary[];
  /** Bancos encontrados listos para importar. */
  banks: PackageBankSummary[];
}

export type ImportCollisionPolicy = 'skip' | 'overwrite';

export interface ImportPackageInput {
  /** Ruta al paquete de origen. */
  packagePath: string;
  /** Ruta de la librería de destino donde se copiarán plugins y bancos. */
  targetLibraryRoot: string;
  /** Lista opcional de nombres de plugins a importar. Si se omite, importa todos. */
  selectedPlugins?: string[];
  /** Lista opcional de nombres de bancos a importar. Si se omite, importa todos. */
  selectedBanks?: string[];
  /** Wizard confirmado por el usuario para cada plugin, indexado por nombre o sourceDir. */
  selectedWizards?: Record<string, string>;
  /** Política si la carpeta ya existe en destino: 'skip' (omite) o 'overwrite' (sobrescribe). */
  collisionPolicy?: ImportCollisionPolicy;
  /** Si es true, repara y sincroniza automáticamente los IDs y descriptores del banco con el plugin destino al importar. */
  repairBanks?: boolean;
}

export interface ImportPackageSkippedItem {
  name: string;
  reason: string;
}

export interface ImportPackageResult {
  targetLibraryRoot: string;
  /** Plugins que se copiaron exitosamente. */
  importedPlugins: string[];
  /** Plugins que se omitieron (ej. ya existían con policy='skip'). */
  skippedPlugins: ImportPackageSkippedItem[];
  /** Bancos que se copiaron exitosamente. */
  importedBanks: string[];
  /** Bancos que se omitieron. */
  skippedBanks: ImportPackageSkippedItem[];
  /** Bancos que fueron reparados durante la importación. */
  repairedBanks?: string[];
  /** Plugins cuyo wizard se aplicó de forma segura tras importar. */
  preparedPlugins?: string[];
  /** Requisitos de wizard que siguen faltando o necesitan atención manual. */
  wizardWarnings?: { plugin: string; message: string }[];
  /** Total de bytes copiados durante la importación. */
  totalCopiedBytes: number;
}
