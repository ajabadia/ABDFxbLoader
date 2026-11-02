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
