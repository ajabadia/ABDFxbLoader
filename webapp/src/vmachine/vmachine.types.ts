import { CodedError, type ApiErrorCode } from '../common/api-errors';

/**
 * Gestión de la unidad extraíble de la v-machine.
 *
 * La máquina no habla el mismo idioma que el disco duro: espera una carpeta
 * `*.vfxlibrary` en la **raíz** del medio y, dentro, `plugs\<Plugin>\` con su
 * `vfxinfo.txt` (manual de operación, §2.14 y §3.7.1.7). Lo que ya generaba
 * `POST /capture/vmachine/:diffId` es justo el contenido del plugin, pero suelto
 * en una carpeta de trabajo; aquí se detecta el medio y se copia envuelto en la
 * biblioteca, comprobando que lo copiado es lo mismo que lo generado.
 */

/** Una unidad de almacenamiento tal como la ve el sistema operativo. */
export interface VMachineDrive {
  /** Letra con dos puntos («E:») o punto de montaje fuera de Windows. */
  id: string;
  /** Etiqueta del volumen; cadena vacía si no tiene. */
  label: string;
  fileSystem: string;
  totalBytes: number | null;
  /** Bytes libres, o `null` si el sistema no los informa. */
  freeBytes: number | null;
  /** La máquina lee de un medio extraíble; `false` es un disco fijo. */
  removable: boolean;
  /** Bibliotecas `*.vfxlibrary` que ya viven en la raíz de la unidad. */
  libraries: string[];
}

export interface VMachineDrives {
  /**
   * `false` fuera de Windows: enumerar unidades necesita la tabla de discos
   * lógicos del sistema, y el resto de plataformas no la expone igual.
   */
  supported: boolean;
  drives: VMachineDrive[];
  warnings: string[];
}

export interface VMachineInstallOptions {
  /** Raíz del medio, tal como la devuelve `GET /vmachine/drives` (`E:`, `E:\`). */
  drive: string;
  /** Carpeta del plugin generada por `/capture/vmachine/:diffId` (`bankDir`). */
  pluginDir: string;
  /**
   * Nombre de la biblioteca sin la extensión o con ella. Si se omite se reusa
   * la única `*.vfxlibrary` que ya esté en la raíz —el caso normal: el stick que
   * la máquina ya usa— y, si no hay ninguna, se crea `V-MACHINE`.
   */
  libraryName?: string;
  /** Inyectable para las pruebas: bytes libres del medio. */
  spaceAvailable?: (root: string) => Promise<number | null>;
}

export interface VMachineInstallResult {
  drive: string;
  /** Carpeta `<raíz>\<Nombre>.vfxlibrary` que la máquina leerá. */
  libraryDir: string;
  /** Carpeta del plugin dentro de la biblioteca. */
  pluginDir: string;
  /** Archivos copiados. */
  copied: number;
  /** De los copiados, cuántos pisaron una versión anterior. */
  replaced: number;
  bytes: number;
  /** Archivos con SHA-256 comprobado en origen y destino. */
  verified: number;
  /**
   * Archivos grandes (más de 32 MiB) que solo se comprobaron por tamaño: leer
   * dos veces un sample de cientos de megas cuesta más de lo que aporta.
   */
  sizeOnly: string[];
  warnings: string[];
}

/** Entrada del catálogo de wizards con la que se compara lo que hay en el medio. */
export interface VMachineCatalogEntry {
  id: string;
  name: string;
  version: string;
}

/** Consulta al catálogo. Inyectable: las pruebas no cargan el repositorio real. */
export type WizardLookup = (query: {
  id?: string;
  name?: string;
  dllName?: string;
}) => VMachineCatalogEntry | null;

/** Plugin que ya vive en una biblioteca del medio. */
export interface VMachineInventoryPlugin {
  /** Biblioteca a la que pertenece (`<Nombre>.vfxlibrary`). */
  library: string;
  /** Carpeta dentro de `plugs\`. */
  folder: string;
  path: string;
  hasVfxinfo: boolean;
  /** `name` del vfxinfo, o `null` si no lo declara. */
  name: string | null;
  /** `id` VST del vfxinfo, la clave con la que el catálogo reconoce el plugin. */
  id: string | null;
  /** `version` del vfxinfo; puede faltar aunque el plugin esté bien. */
  version: string | null;
  dll: string | null;
  files: number;
  bytes: number;
  /** Wizard con el que se corresponde, o `null` si el catálogo no lo conoce. */
  catalog: VMachineCatalogEntry | null;
  /**
   * `match` si coincide con el catálogo, `differs` si el catálogo tiene otra
   * versión —el medio va por detrás o por delante— y `unknown` si no hay
   * ninguna entrada que lo reconozca.
   */
  status: 'match' | 'differs' | 'unknown';
}

export interface VMachineInventoryLibrary {
  name: string;
  path: string;
  plugins: VMachineInventoryPlugin[];
}

export interface VMachineInventory {
  drive: string;
  libraries: VMachineInventoryLibrary[];
  /** Total de plugins entre todas las bibliotecas. */
  plugins: number;
  warnings: string[];
}


/** Plugin de la librería del equipo y cómo se compara con el medio. */
export interface VMachineSyncEntry {
  folder: string;
  path: string;
  name: string | null;
  id: string | null;
  version: string | null;
  files: number;
  bytes: number;
  /** Carpeta del mismo plugin en el medio, o `null` si no está. */
  stickFolder: string | null;
  /** Versión que declara el medio, si la declara. */
  stickVersion: string | null;
  /**
   * `missing` si solo está en la librería, `differs` si el medio tiene otra
   * versión y `same` si coinciden o no hay versiones que comparar.
   */
  state: 'missing' | 'differs' | 'same';
}

/** Plugin que el medio tiene y la librería no: se informa, no se borra. */
export interface VMachineSyncExtra {
  library: string;
  folder: string;
  name: string | null;
  version: string | null;
  bytes: number;
}

/** Resultado puro de comparar librería y medio. */
export interface VMachineSyncPlan {
  entries: VMachineSyncEntry[];
  extra: VMachineSyncExtra[];
  missing: number;
  differs: number;
  same: number;
  /** Bytes de lo que habría que copiar para igualar el medio. */
  pendingBytes: number;
}

export interface VMachineSync extends VMachineSyncPlan {
  drive: string;
  /** Raíz de la librería comparada. */
  library: string;
  /** Biblioteca del medio en la que se copiaría. */
  targetLibrary: string;
  warnings: string[];
}

export interface VMachineCopyOptions {
  drive: string;
  /** Raíz de la librería (la que contiene `plugs\\`). */
  libraryRoot: string;
  /** Carpetas de `plugs\\` a copiar, tal como las devuelve `sync`. */
  folders: string[];
  /** Biblioteca de destino; si se omite se reusa la única de la raíz. */
  libraryName?: string;
  /** Inyectable para las pruebas: bytes libres del medio. */
  spaceAvailable?: (root: string) => Promise<number | null>;
}

/** Lo que pasó con un plugin del lote. Un fallo no cancela los siguientes. */
export interface VMachineCopyOutcome {
  folder: string;
  ok: boolean;
  copied: number;
  replaced: number;
  bytes: number;
  verified: number;
  sizeOnly: string[];
  warnings: string[];
  /** Motivo del fallo, con el código que la vista traduce. */
  error?: { message: string; code?: ApiErrorCode; params?: Record<string, string | number> };
}

export interface VMachineCopyResult {
  drive: string;
  /** Biblioteca del medio en la que se copió; vacía si no se copió nada. */
  libraryDir: string;
  results: VMachineCopyOutcome[];
  copied: number;
  bytes: number;
  verified: number;
  /** Plugins que no se copiaron. */
  failed: number;
  warnings: string[];
}

/**
 * Fallo de la gestión de la unidad extraíble. Lleva `apiCode` para que la vista
 * lo traduzca y el mensaje quede para los logs, igual que los errores de
 * biblioteca.
 */
export class VMachineError extends CodedError {
  constructor(
    message: string,
    apiCode?: ApiErrorCode,
    apiParams?: Record<string, string | number>,
  ) {
    super(message, apiCode, apiParams);
    this.name = new.target.name;
  }
}
