import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  driveRoot,
  librariesIn,
  parseDrives,
  type DriveRunner,
  type RawDrive,
} from './drives';
import { CodedError } from '../common/api-errors';
import { VFXINFO_FILENAME } from '../library/vfxinfo';
import { readStickPlugin } from './inventory';
import { planSync, readLibraryPlugins } from './sync';
import {
  VMachineError,
  type VMachineDrive,
  type VMachineDrives,
  type VMachineInstallOptions,
  type VMachineInstallResult,
  type VMachineCopyOptions,
  type VMachineCopyOutcome,
  type VMachineCopyResult,
  type VMachineInventory,
  type VMachineInventoryLibrary,
  type VMachineInventoryPlugin,
  type VMachineSync,
  type WizardLookup,
} from './vmachine.types';

/**
 * Detección del medio de la v-machine y copia verificada del paquete.
 *
 * Dos pasos, en este orden: `GET /vmachine/drives` enseña qué hay conectado y
 * cuáles de esas unidades ya tienen una biblioteca; `POST /vmachine/install`
 * envuelve el paquete en `<Nombre>.vfxlibrary\plugs\<Plugin>\` —la forma que la
 * máquina reconoce en la raíz del medio— y comprueba archivo por archivo que lo
 * copiado es idéntico a lo generado.
 *
 * La copia nunca escribe fuera de la biblioteca, y no borra nada: pisar una
 * versión anterior del mismo plugin se informa en `replaced`, no se hace en
 * silencio.
 */

const LIBRARY_SUFFIX = '.vfxlibrary';

/**
 * Tope para hashear. Por encima solo se compara el tamaño: un sample de cientos
 * de megas se leería dos veces más para detectar un bit perdido que el propio
 * sistema de archivos ya detecta al escribir.
 */
const HASH_LIMIT_BYTES = 32 * 1024 * 1024;

/** Caracteres que Windows no admite en un nombre de carpeta. */
const INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f]/;

interface SourceFile {
  absolute: string;
  relative: string;
  size: number;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function sha256(target: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      resolve();
    });
  });
  return hash.digest('hex');
}

/** «1,2 GB» para el mensaje; los números exactos van en los parámetros. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded).replace('.', ',')} ${units[unit] ?? 'B'}`;
}

/**
 * Nombre de biblioteca admisible. Rechaza separadores, caracteres prohibidos y
 * los nombres que Windows no puede crear; devuelve el mensaje del fallo para
 * que el código de error lo traduzca la vista.
 */
export function libraryNameProblem(name: string): string | null {
  if (name === '') return 'el nombre de la biblioteca está vacío';
  if (name === '.' || name === '..') return 'el nombre de la biblioteca no puede ser «.» ni «..»';
  if (INVALID_NAME.test(name)) return 'el nombre de la biblioteca no admite «< > : " / \\ | ? *»';
  if (name.endsWith('.') || name.endsWith(' ')) {
    return 'el nombre de la biblioteca no puede terminar en punto ni en espacio';
  }
  // El nombre completo incluye el sufijo: 100 deja margen para `\plugs\<Plugin>`.
  if (name.length > 100) return 'el nombre de la biblioteca es demasiado largo';
  return null;
}

/** Añade `.vfxlibrary` si falta; con sufijo repetido no lo duplica. */
export function withLibrarySuffix(name: string): string {
  return name.toLowerCase().endsWith(LIBRARY_SUFFIX) ? name : `${name}${LIBRARY_SUFFIX}`;
}

/**
 * Recorre el paquete generado. Los enlaces simbólicos no se siguen: la máquina
 * lee un medio FAT y copiar el destino dejaría archivos duplicados sin avisar.
 */
async function collectFiles(root: string): Promise<{ files: SourceFile[]; warnings: string[] }> {
  const files: SourceFile[] = [];
  const warnings: string[] = [];

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        warnings.push(`Se omite el enlace simbólico ${relative}: la máquina no lo resolvería.`);
      } else if (entry.isFile()) {
        const stats = await fs.stat(absolute);
        files.push({ absolute, relative, size: stats.size });
      }
    }
  };

  await walk(root, '');
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  return { files, warnings };
}

/** Bytes libres del medio, o `null` si el sistema no los informa. */
async function freeBytes(root: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(root);
    return stats.bsize * stats.bavail;
  } catch {
    return null;
  }
}

export class VMachineService {
  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly readDriveTable: DriveRunner,
    /**
     * Catálogo de wizards. Se inyecta como función para que el servicio no
     * dependa del módulo de wizards y las pruebas lo resuelvan sin disco.
     */
    private readonly matchWizard: WizardLookup = () => null,
  ) {}

  async listDrives(): Promise<VMachineDrives> {
    if (this.platform !== 'win32') {
      return {
        supported: false,
        drives: [],
        warnings: [
          'Enumerar unidades requiere Windows; escribe la ruta de la unidad a mano.',
        ],
      };
    }

    let table: string;
    try {
      table = await this.readDriveTable();
    } catch (error) {
      throw new VMachineError(`No se pudieron leer las unidades: ${(error as Error).message}`);
    }

    let parsed: RawDrive[];
    try {
      parsed = parseDrives(table);
    } catch (error) {
      throw new VMachineError(
        `La tabla de unidades llegó ilegible: ${(error as Error).message}`,
      );
    }

    const drives: VMachineDrive[] = [];
    const warnings: string[] = [];
    for (const raw of parsed) {
      let libraries: string[] = [];
      try {
        libraries = await librariesIn(driveRoot(raw.id));
      } catch (error) {
        // Una unidad sin medio (lector vacío, letra reservada) no se puede leer:
        // se lista igual, para no ocultar que existe, y se dice por qué.
        warnings.push(`No se pudo leer ${raw.id}: ${(error as Error).message}`);
      }
      drives.push({ ...raw, libraries });
    }

    return { supported: true, drives, warnings };
  }

  async install(options: VMachineInstallOptions): Promise<VMachineInstallResult> {
    const drive = path.resolve(options.drive);
    let driveStats;
    try {
      driveStats = await fs.stat(drive);
    } catch {
      throw new VMachineError(
        `La unidad "${options.drive}" no existe o no es una carpeta.`,
        'driveNotFound',
        { 0: options.drive },
      );
    }
    if (!driveStats.isDirectory()) {
      throw new VMachineError(
        `La unidad "${options.drive}" no existe o no es una carpeta.`,
        'driveNotFound',
        { 0: options.drive },
      );
    }

    const pluginDir = path.resolve(options.pluginDir);
    if (!(await exists(pluginDir))) {
      throw new VMachineError(
        `No existe la carpeta del plugin "${options.pluginDir}".`,
        'pluginFolderMissing',
        { 0: options.pluginDir },
      );
    }
    // Sin `vfxinfo.txt` no hay plugin que la máquina reconozca: se rechaza antes
    // de copiar nada, no después de llenar el medio.
    if (!(await exists(path.join(pluginDir, 'vfxinfo.txt')))) {
      throw new VMachineError(
        `No hay vfxinfo.txt en ${pluginDir}.`,
        'vfxinfoMissing',
        { 0: pluginDir },
      );
    }

    const requested = (options.libraryName ?? '').trim();
    const name = withLibrarySuffix(
      requested !== '' ? requested : ((await librariesIn(drive))[0] ?? 'V-MACHINE'),
    );
    const problem = libraryNameProblem(name);
    if (problem !== null) {
      throw new VMachineError(
        `El nombre de la biblioteca no es válido: "${name}".`,
        'libraryNameInvalid',
        { 0: name },
      );
    }

    const { files, warnings } = await collectFiles(pluginDir);
    const total = files.reduce((sum, file) => sum + file.size, 0);

    const free = options.spaceAvailable
      ? await options.spaceAvailable(drive)
      : await freeBytes(drive);
    if (free === null) {
      warnings.push(
        'El sistema no informa del espacio libre: la copia puede quedarse a medias si el medio se llena.',
      );
    } else if (total > free) {
      throw new VMachineError(
        `No cabe en "${options.drive}": hacen falta ${formatBytes(total)} y quedan ${formatBytes(free)}.`,
        'notEnoughSpace',
        { 0: formatBytes(total), 1: formatBytes(free) },
      );
    }

    const libraryDir = path.join(drive, name);
    const pluginTarget = path.join(libraryDir, 'plugs', path.basename(pluginDir));

    let copied = 0;
    let replaced = 0;
    let bytes = 0;
    let verified = 0;
    const sizeOnly: string[] = [];

    for (const file of files) {
      const destination = path.join(pluginTarget, ...file.relative.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      if (await exists(destination)) replaced += 1;
      await fs.copyFile(file.absolute, destination);

      // Lo copiado tiene que ser lo generado: un stick que se expulsa a mitad,
      // un sector malo o un antivirus que bloquea dejan un archivo corto, y la
      // máquina no lo diría — cargaría el plugin y fallaría al abrirlo.
      const stats = await fs.stat(destination);
      if (stats.size !== file.size) {
        throw new VMachineError(
          `La copia de ${file.relative} no llegó íntegra a la unidad (${stats.size} de ${file.size} bytes).`,
          'copyMismatch',
          { 0: file.relative },
        );
      }
      if (file.size <= HASH_LIMIT_BYTES) {
        const [origin, target] = await Promise.all([
          sha256(file.absolute),
          sha256(destination),
        ]);
        if (origin !== target) {
          throw new VMachineError(
            `La copia de ${file.relative} no llegó íntegra a la unidad.`,
            'copyMismatch',
            { 0: file.relative },
          );
        }
        verified += 1;
      } else {
        sizeOnly.push(file.relative);
      }

      copied += 1;
      bytes += file.size;
    }

    return {
      drive,
      libraryDir,
      pluginDir: pluginTarget,
      copied,
      replaced,
      bytes,
      verified,
      sizeOnly,
      warnings,
    };
  }

  /**
   * Inventario del medio, en modo lectura: qué plugins hay en cada biblioteca y
   * cómo se comparan con el catálogo. No escribe nada, así que la vista puede
   * pedirlo cada vez que se elige una unidad.
   */
  async inventory(driveInput: string): Promise<VMachineInventory> {
    const drive = path.resolve(driveInput);
    let stats;
    try {
      stats = await fs.stat(drive);
    } catch {
      throw this.driveMissing(driveInput);
    }
    if (!stats.isDirectory()) throw this.driveMissing(driveInput);

    let names: string[];
    try {
      names = await librariesIn(drive);
    } catch (error) {
      throw new VMachineError(
        `No se pudo leer la raíz de "${driveInput}": ${(error as Error).message}`,
      );
    }

    const warnings: string[] = [];
    if (names.length === 0) {
      warnings.push(
        'La unidad no tiene ninguna biblioteca en la raíz: la máquina no verá ningún plugin hasta que se copie uno.',
      );
    }

    const libraries: VMachineInventoryLibrary[] = [];
    let plugins = 0;
    for (const name of names) {
      const libraryDir = path.join(drive, name);
      const list: VMachineInventoryPlugin[] = [];
      let folders: string[] = [];
      try {
        const entries = await fs.readdir(path.join(libraryDir, 'plugs'), {
          withFileTypes: true,
        });
        folders = entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort((left, right) => left.localeCompare(right));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          warnings.push(`No se pudo leer ${name}\\plugs: ${(error as Error).message}`);
        }
      }

      for (const folder of folders) {
        const read = await readStickPlugin(
          name,
          path.join(libraryDir, 'plugs', folder),
          this.matchWizard,
        );
        list.push(read.plugin);
        warnings.push(...read.warnings);
      }

      plugins += list.length;
      libraries.push({ name, path: libraryDir, plugins: list });
    }

    return { drive, libraries, plugins, warnings };
  }


  /**
   * Compara la librería del equipo con el medio. Es de solo lectura: la vista lo
   * pide al abrir la unidad y antes de copiar, y no cambia nada.
   */
  async sync(driveInput: string, libraryInput: string): Promise<VMachineSync> {
    const library = path.resolve(libraryInput);
    const inventory = await this.inventory(driveInput);
    const plugins = await readLibraryPlugins(library);
    const plan = planSync(
      plugins,
      inventory.libraries.flatMap((entry) => entry.plugins),
    );

    let targetLibrary: string;
    try {
      targetLibrary = withLibrarySuffix((await librariesIn(inventory.drive))[0] ?? 'V-MACHINE');
    } catch {
      targetLibrary = withLibrarySuffix('V-MACHINE');
    }

    return {
      drive: inventory.drive,
      library,
      targetLibrary,
      ...plan,
      warnings: inventory.warnings,
    };
  }

  /**
   * Copia en lote los plugins de la librería que la vista ha elegido.
   *
   * El espacio se comprueba antes de escribir el primero: quedarse a medias por
   * falta de sitio es justo lo que deja un stick que la máquina lee a trozos. Un
   * fallo posterior —un archivo que no llega íntegro— no cancela el resto: se
   * informa en `results` y el medio queda con lo que sí se copió bien.
   */
  async copyToStick(options: VMachineCopyOptions): Promise<VMachineCopyResult> {
    const libraryRoot = path.resolve(options.libraryRoot);
    const plugsDir = path.join(libraryRoot, 'plugs');
    if (!(await exists(plugsDir))) {
      throw new VMachineError(
        `No existe la carpeta plugs de la librería "${libraryRoot}".`,
        'plugsMissing',
        { 0: libraryRoot },
      );
    }

    const folders = [
      ...new Set(options.folders.map((folder) => folder.trim()).filter((folder) => folder !== '')),
    ];
    if (folders.length === 0) {
      throw new VMachineError('No hay plugins que copiar.', 'batchPluginsEmpty');
    }

    const sources: { folder: string; dir: string }[] = [];
    let total = 0;
    for (const folder of folders) {
      if (path.basename(folder) !== folder || folder === '.' || folder === '..') {
        throw new VMachineError(
          `El nombre de carpeta "${folder}" no es un plugin de la librería.`,
          'pluginFolderMissing',
          { 0: folder },
        );
      }
      const dir = path.join(plugsDir, folder);
      if (!(await exists(dir))) {
        throw new VMachineError(
          `No existe la carpeta del plugin "${folder}" en la librería.`,
          'pluginFolderMissing',
          { 0: folder },
        );
      }
      if (!(await exists(path.join(dir, VFXINFO_FILENAME)))) {
        throw new VMachineError(
          `El plugin "${folder}" no tiene vfxinfo.txt; la máquina no lo reconocería.`,
          'vfxinfoMissing',
          { 0: folder },
        );
      }
      sources.push({ folder, dir });
      total += (await collectFiles(dir)).files.reduce((sum, file) => sum + file.size, 0);
    }

    const drive = path.resolve(options.drive);
    let stats;
    try {
      stats = await fs.stat(drive);
    } catch {
      throw this.driveMissing(options.drive);
    }
    if (!stats.isDirectory()) throw this.driveMissing(options.drive);

    const warnings: string[] = [];
    const free = options.spaceAvailable
      ? await options.spaceAvailable(drive)
      : await freeBytes(drive);
    if (free === null) {
      warnings.push(
        'El sistema no informa del espacio libre: el lote puede quedarse a medias si el medio se llena.',
      );
    } else if (total > free) {
      throw new VMachineError(
        `No cabe en "${options.drive}": hacen falta ${formatBytes(total)} y quedan ${formatBytes(free)}.`,
        'notEnoughSpace',
        { 0: formatBytes(total), 1: formatBytes(free) },
      );
    }

    const results: VMachineCopyOutcome[] = [];
    let libraryDir = '';
    let copied = 0;
    let bytes = 0;
    let verified = 0;
    let failed = 0;

    for (const source of sources) {
      try {
        const result = await this.install({
          drive: options.drive,
          pluginDir: source.dir,
          ...(options.libraryName === undefined ? {} : { libraryName: options.libraryName }),
        });
        libraryDir = result.libraryDir;
        copied += result.copied;
        bytes += result.bytes;
        verified += result.verified;
        warnings.push(...result.warnings);
        results.push({
          folder: source.folder,
          ok: true,
          copied: result.copied,
          replaced: result.replaced,
          bytes: result.bytes,
          verified: result.verified,
          sizeOnly: result.sizeOnly,
          warnings: result.warnings,
        });
      } catch (error) {
        failed += 1;
        const coded = error instanceof CodedError ? error : null;
        results.push({
          folder: source.folder,
          ok: false,
          copied: 0,
          replaced: 0,
          bytes: 0,
          verified: 0,
          sizeOnly: [],
          warnings: [],
          error: {
            message: (error as Error).message,
            ...(coded?.apiCode === undefined ? {} : { code: coded.apiCode }),
            ...(coded?.apiParams === undefined ? {} : { params: coded.apiParams }),
          },
        });
      }
    }

    return { drive, libraryDir, results, copied, bytes, verified, failed, warnings };
  }

  /** La unidad que se pidió no está montada o no es una carpeta. */
  private driveMissing(drive: string): VMachineError {
    return new VMachineError(
      `La unidad "${drive}" no existe o no es una carpeta.`,
      'driveNotFound',
      { 0: drive },
    );
  }
}
