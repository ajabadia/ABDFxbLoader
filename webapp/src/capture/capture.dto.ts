import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Contrato del módulo de captura: una captura compara dos snapshots del sistema
 * (archivos y registro) y produce un diff que se empaqueta en staging para
 * revisarlo antes de copiarlo al destino final.
 *
 * Cada respuesta publica un ejemplo con la misma forma que el DTO con el que se
 * declara; las pruebas de `openapi.examples` validan ambos.
 */

/* ------------------------------------------------------------------ *
 * Errores
 * ------------------------------------------------------------------ */

/** Cuerpo de error cuando la captura referencia un recurso que no existe. */
export class CaptureErrorDto {
  @ApiProperty({
    description: 'Descripción legible del recurso ausente, con el ID pedido.',
    example: 'No existe el snapshot "6f1b4c1e-4a1a-4d2b-9f0e-6b3f3f8d9c11".',
  })
  message!: string;
}

export const CAPTURE_NOT_FOUND_TASK_EXAMPLE = {
  message: 'No existe la tarea de captura "6f1b4c1e-4a1a-4d2b-9f0e-6b3f3f8d9c11".',
};

export const CAPTURE_NOT_FOUND_SNAPSHOT_EXAMPLE = {
  message: 'No existe el snapshot "6f1b4c1e-4a1a-4d2b-9f0e-6b3f3f8d9c11".',
};

export const CAPTURE_NOT_FOUND_DIFF_EXAMPLE = {
  message: 'No existe el diff "5c9a2b7e-2f6d-4b1f-8f6e-1a2b3c4d5e6f".',
};

export const CAPTURE_NOT_FOUND_SNAPSHOT_BEFORE_EXAMPLE = {
  message: 'No existe el snapshot inicial "6f1b4c1e-4a1a-4d2b-9f0e-6b3f3f8d9c11" para cerrar la captura.',
};

export const CAPTURE_NOT_FOUND_STAGING_EXAMPLE = {
  message:
    'No existe el staging del diff "5c9a2b7e-2f6d-4b1f-8f6e-1a2b3c4d5e6f". ' +
    'Ejecuta POST /capture/package para prepararlo.',
};

export const CAPTURE_NOT_FOUND_STAGING_FILE_EXAMPLE = {
  message:
    'No existe "Program Files\\VstPlugins\\P8.dll" en el staging del diff ' +
    '"5c9a2b7e-2f6d-4b1f-8f6e-1a2b3c4d5e6f".',
};

/* ------------------------------------------------------------------ *
 * Peticiones
 * ------------------------------------------------------------------ */

export const CAPTURE_START_REQUEST_EXAMPLE = {
  scanRoots: ['C:\\Program Files\\VstPlugins'],
  registryRoots: ['HKCU\\Software\\VFX'],
  computeHashes: false,
};

export const CAPTURE_FINISH_REQUEST_EXAMPLE = {
  snapshotIdBefore: '6f1b4c1e-4a1a-4d2b-9f0e-6b3f3f8d9c11',
  scanRoots: ['C:\\Program Files\\VstPlugins'],
  filterJunk: true,
};

export const CAPTURE_PACKAGE_REQUEST_EXAMPLE = {
  diffId: '5c9a2b7e-2f6d-4b1f-8f6e-1a2b3c4d5e6f',
  targetDir: 'D:\\_banks\\paquetes',
  packageName: 'SuperWave P8',
};

export const CAPTURE_VMACHINE_REQUEST_EXAMPLE = {
  pluginName: 'SuperWave P8',
  uniqueId: '1316377392',
  dllName: 'P8.dll',
  isSynth: true,
  vendor: 'SuperWave',
  generateBank: true,
  generateWizard: true,
  includePreExisting: true,
};

export class StartSnapshotDto {
  @ApiPropertyOptional({
    description: 'Rutas a escanear (por defecto las rutas comunes de plugins)',
    type: [String],
    example: CAPTURE_START_REQUEST_EXAMPLE.scanRoots,
  })
  scanRoots?: string[];

  @ApiPropertyOptional({
    description: 'Raíces de registro a escanear (por defecto HKCU\\Software y HKLM\\SOFTWARE)',
    type: [String],
    example: CAPTURE_START_REQUEST_EXAMPLE.registryRoots,
  })
  registryRoots?: string[];

  @ApiPropertyOptional({
    description: 'Calcular hashes de archivos; es más lento pero detecta cambios de contenido',
    default: false,
    example: false,
  })
  computeHashes?: boolean;
}

export class FinishCaptureDto {
  @ApiProperty({
    description: 'ID del snapshot inicial devuelto al empezar la captura',
    example: CAPTURE_FINISH_REQUEST_EXAMPLE.snapshotIdBefore,
  })
  snapshotIdBefore!: string;

  @ApiPropertyOptional({
    description: 'Rutas a escanear (por defecto, las del snapshot inicial)',
    type: [String],
    example: CAPTURE_START_REQUEST_EXAMPLE.scanRoots,
  })
  scanRoots?: string[];

  @ApiPropertyOptional({
    description: 'Raíces de registro a escanear',
    type: [String],
    example: CAPTURE_START_REQUEST_EXAMPLE.registryRoots,
  })
  registryRoots?: string[];

  @ApiPropertyOptional({ description: 'Calcular hashes de archivos', default: false, example: false })
  computeHashes?: boolean;

  @ApiPropertyOptional({
    description: 'Filtrar archivos temporales y basura del diff',
    default: true,
    example: true,
  })
  filterJunk?: boolean;
}

export class PackageDiffDto {
  @ApiProperty({
    description: 'ID del diff que se quiere empaquetar',
    example: CAPTURE_PACKAGE_REQUEST_EXAMPLE.diffId,
  })
  diffId!: string;

  @ApiProperty({
    description: 'Carpeta destino donde crear el paquete',
    example: CAPTURE_PACKAGE_REQUEST_EXAMPLE.targetDir,
  })
  targetDir!: string;

  @ApiPropertyOptional({
    description: 'Nombre del paquete; si se omite se usa el del diff',
    example: CAPTURE_PACKAGE_REQUEST_EXAMPLE.packageName,
  })
  packageName?: string;
}

export class VMachineRequestDto {
  @ApiProperty({ description: 'Nombre del plugin tal como debe aparecer en la v-machine', example: 'SuperWave P8' })
  pluginName!: string;

  @ApiPropertyOptional({ description: 'ID único del plugin de 32 bits', example: '1316377392' })
  uniqueId?: string;

  @ApiPropertyOptional({
    description:
      'DLL principal dentro del staging. Se empareja por nombre de archivo, ignorando la carpeta; si se omite se usa el primer DLL capturado.',
    example: 'P8.dll',
  })
  dllName?: string;

  @ApiPropertyOptional({ description: 'Si el plugin es un sintetizador', example: true })
  isSynth?: boolean;

  @ApiPropertyOptional({ description: 'Fabricante del plugin', example: 'SuperWave' })
  vendor?: string;

  @ApiPropertyOptional({
    description:
      'Generar el árbol del plugin (`plugs/<pluginName>/`) con el DLL en la raíz, `vfxinfo.txt` y `presets/`, listo para escanear e importar.',
    example: true,
  })
  generateBank?: boolean;

  @ApiPropertyOptional({
    description:
      'Sumar al paquete los archivos del plugin que ya existían antes de iniciar la captura ' +
      '(se leen del snapshot inicial), acotados al tallo del DLL y a las carpetas donde la ' +
      'captura puso archivos. Por defecto `true`; con `false` el paquete se queda solo con lo ' +
      'que cambió durante la captura.',
    example: true,
  })
  includePreExisting?: boolean;

  @ApiPropertyOptional({ description: 'Generar el wizard para el software original', example: true })
  generateWizard?: boolean;

  @ApiPropertyOptional({
    description: 'Carpeta de salida; por defecto `<almacén>/vmachine`',
    example: 'D:\\_banks\\paquetes\\vmachine',
  })
  outputDir?: string;
}

/* ------------------------------------------------------------------ *
 * Respuestas
 * ------------------------------------------------------------------ */

export const CAPTURE_FILE_ENTRY_EXAMPLE = {
  path: 'C:\\Program Files\\VstPlugins\\P8.dll',
  size: 1548288,
  mtimeMs: 1730419200000,
  isDir: false,
  hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
};

export const CAPTURE_REGISTRY_ENTRY_EXAMPLE = {
  // `reg query` devuelve siempre el nombre completo de la raíz del registro.
  key: 'HKEY_CURRENT_USER\\Software\\VFX\\P8',
  valueName: 'InstallPath',
  valueType: 'REG_SZ',
  valueData: 'C:\\Program Files\\VstPlugins',
};

export const CAPTURE_SNAPSHOT_EXAMPLE = {
  id: '6f1b4c1e-4a1a-4d2b-9f0e-6b3f3f8d9c11',
  createdAt: '2026-10-30T09:12:44.120Z',
  platform: 'win32',
  files: [CAPTURE_FILE_ENTRY_EXAMPLE],
  registry: [CAPTURE_REGISTRY_ENTRY_EXAMPLE],
  scanRoots: ['C:\\Program Files\\VstPlugins'],
  registryRoots: ['HKCU\\Software\\VFX'],
};

export const CAPTURE_TASK_EXAMPLE = {
  taskId: '3c2f8a90-5b7e-4f1a-9c3d-2e4f6a8b0c1d',
  kind: 'start',
  status: 'running',
  phase: 'files',
  message: 'Recorriendo archivos…',
  rootsTotal: 1,
  rootsCompleted: 0,
  currentRoot: 'C:\\Program Files\\VstPlugins',
  currentPath: 'C:\\Program Files\\VstPlugins\\P8.dll',
  entriesVisited: 1240,
  filesFound: 812,
  registryRootsTotal: 1,
  registryRootsCompleted: 0,
  currentRegistryRoot: 'HKCU\\Software\\VFX',
  startedAt: '2026-10-30T09:12:40.002Z',
  updatedAt: '2026-10-30T09:12:44.120Z',
};

export const CAPTURE_TASK_FINISHED_EXAMPLE = {
  ...CAPTURE_TASK_EXAMPLE,
  kind: 'finish',
  status: 'completed',
  phase: 'completed',
  message: 'Captura completada.',
  rootsCompleted: 1,
  registryRootsCompleted: 1,
  currentRoot: null,
  currentPath: null,
  currentRegistryRoot: null,
  result: {
    snapshotId: 'a1b2c3d4-0000-4000-8000-000000000001',
    diffId: '5c9a2b7e-2f6d-4b1f-8f6e-1a2b3c4d5e6f',
    filesAdded: 12,
    filesModified: 2,
    filesRemoved: 0,
    registryAdded: 3,
    registryModified: 1,
    registryRemoved: 0,
  },
};

export const CAPTURE_DIFF_EXAMPLE = {
  diffId: '5c9a2b7e-2f6d-4b1f-8f6e-1a2b3c4d5e6f',
  snapshotIdBefore: '6f1b4c1e-4a1a-4d2b-9f0e-6b3f3f8d9c11',
  snapshotIdAfter: 'a1b2c3d4-0000-4000-8000-000000000001',
  createdAt: '2026-10-30T09:20:11.480Z',
  addedFiles: [CAPTURE_FILE_ENTRY_EXAMPLE],
  modifiedFiles: [{ before: CAPTURE_FILE_ENTRY_EXAMPLE, after: CAPTURE_FILE_ENTRY_EXAMPLE }],
  removedFiles: [],
  addedRegistry: [CAPTURE_REGISTRY_ENTRY_EXAMPLE],
  modifiedRegistry: [
    { before: CAPTURE_REGISTRY_ENTRY_EXAMPLE, after: CAPTURE_REGISTRY_ENTRY_EXAMPLE },
  ],
  removedRegistry: [],
  filteredOut: 0,
};

export const CAPTURE_PACKAGE_RESULT_EXAMPLE = {
  packageDir: 'D:\\_banks\\paquetes\\SuperWave P8',
  stagingDir: 'C:\\Users\\ajaba\\.fxbloader\\capture\\staging\\5c9a2b7e-2f6d-4b1f-8f6e-1a2b3c4d5e6f',
  filesCopied: 12,
  preExistingFiles: 3,
  registryEntries: 3,
  warnings: [],
};

export const CAPTURE_PRE_EXISTING_EXAMPLE = {
  count: 3,
  files: ['P8.dll', 'P8\\wavetables\\table.wav', 'presets\\legacy.fxb'],
  restorable: 0,
  restorableFiles: [],
  warnings: [],
};

export const CAPTURE_PRE_EXISTING_REVEAL_EXAMPLE = {
  ok: true,
  file: 'Program Files/VstPlugins/P8.dll',
  opened: 'C:\\Program Files\\VstPlugins\\P8.dll',
};

export const CAPTURE_STAGING_REVEAL_EXAMPLE = {
  ok: true,
  file: 'Program Files\\VstPlugins\\P8.dll',
  opened: 'C:\\Program Files\\VstPlugins\\P8.dll',
};

export const CAPTURE_STAGING_EXAMPLE = {
  stagingDir: 'C:\\Users\\ajaba\\.fxbloader\\capture\\staging\\5c9a2b7e-2f6d-4b1f-8f6e-1a2b3c4d5e6f',
  // El staging conserva la ruta relativa a la unidad de origen.
  files: ['Program Files\\VstPlugins\\P8.dll', 'Program Files\\VstPlugins\\P8\\presets\\factory.fxb'],
};

export const CAPTURE_STAGING_RESTORE_EXAMPLE = {
  restored: 2,
  // El manifiesto guarda la ruta relativa a la unidad de origen, con `/`.
  files: [
    'Users/tester/Program Files/VstPlugins/P8/wavetables/table.wav',
    'Users/tester/Program Files/VstPlugins/P8/presets/legacy.fxb',
  ],
  missing: [],
  warnings: [],
};

export const CAPTURE_FINALIZE_RESULT_EXAMPLE = {
  packageDir: 'D:\\_banks\\paquetes\\SuperWave P8',
};

export const CAPTURE_OK_EXAMPLE = { ok: true };

export const CAPTURE_VMACHINE_RESULT_EXAMPLE = {
  bankDir: 'D:\\_banks\\paquetes\\vmachine\\plugs\\SuperWave P8',
  wizardPath: 'D:\\_banks\\paquetes\\vmachine\\SuperWave P8.vfxwizard',
  warnings: [],
};

export class CaptureFileEntryDto {
  @ApiProperty({ description: 'Ruta absoluta del archivo o carpeta.', example: CAPTURE_FILE_ENTRY_EXAMPLE.path })
  path!: string;

  @ApiProperty({ description: 'Tamaño en bytes.', example: CAPTURE_FILE_ENTRY_EXAMPLE.size })
  size!: number;

  @ApiProperty({
    description: 'Fecha de modificación en milisegundos desde la época.',
    example: CAPTURE_FILE_ENTRY_EXAMPLE.mtimeMs,
  })
  mtimeMs!: number;

  @ApiProperty({ description: 'Indica si la entrada es una carpeta.', example: false })
  isDir!: boolean;

  @ApiPropertyOptional({
    description: 'Hash SHA-256 del contenido; solo cuando la captura calcula hashes.',
    example: CAPTURE_FILE_ENTRY_EXAMPLE.hash,
  })
  hash?: string;
}

export class CaptureRegistryEntryDto {
  @ApiProperty({ description: 'Clave del registro.', example: CAPTURE_REGISTRY_ENTRY_EXAMPLE.key })
  key!: string;

  @ApiProperty({ description: 'Nombre del valor dentro de la clave.', example: CAPTURE_REGISTRY_ENTRY_EXAMPLE.valueName })
  valueName!: string;

  @ApiProperty({ description: 'Tipo del valor (`REG_SZ`, `REG_DWORD`…).', example: CAPTURE_REGISTRY_ENTRY_EXAMPLE.valueType })
  valueType!: string;

  @ApiProperty({ description: 'Datos del valor tal cual los devuelve el registro.', example: CAPTURE_REGISTRY_ENTRY_EXAMPLE.valueData })
  valueData!: string;
}

export class CaptureSnapshotDto {
  @ApiProperty({ description: 'ID del snapshot.', example: CAPTURE_SNAPSHOT_EXAMPLE.id })
  id!: string;

  @ApiProperty({ description: 'Momento en que se tomó el snapshot (ISO-8601).', example: CAPTURE_SNAPSHOT_EXAMPLE.createdAt })
  createdAt!: string;

  @ApiProperty({ description: 'Plataforma donde corrió la captura.', example: CAPTURE_SNAPSHOT_EXAMPLE.platform })
  platform!: string;

  @ApiProperty({ description: 'Archivos y carpetas encontrados.', type: [CaptureFileEntryDto] })
  files!: CaptureFileEntryDto[];

  @ApiProperty({ description: 'Valores de registro encontrados.', type: [CaptureRegistryEntryDto] })
  registry!: CaptureRegistryEntryDto[];

  @ApiProperty({ description: 'Raíces de archivos recorridas.', type: [String], example: CAPTURE_SNAPSHOT_EXAMPLE.scanRoots })
  scanRoots!: string[];

  @ApiProperty({ description: 'Raíces de registro recorridas.', type: [String], example: CAPTURE_SNAPSHOT_EXAMPLE.registryRoots })
  registryRoots!: string[];
}

export class CaptureFileChangeDto {
  @ApiProperty({ description: 'Estado previo de la entrada.', type: CaptureFileEntryDto })
  before!: CaptureFileEntryDto;

  @ApiProperty({ description: 'Estado posterior de la entrada.', type: CaptureFileEntryDto })
  after!: CaptureFileEntryDto;
}

export class CaptureRegistryChangeDto {
  @ApiProperty({ description: 'Valor previo.', type: CaptureRegistryEntryDto })
  before!: CaptureRegistryEntryDto;

  @ApiProperty({ description: 'Valor posterior.', type: CaptureRegistryEntryDto })
  after!: CaptureRegistryEntryDto;
}

export class CaptureDiffDto {
  @ApiProperty({ description: 'ID del diff, el que se pasa a `/capture/package`.', example: CAPTURE_DIFF_EXAMPLE.diffId })
  diffId!: string;

  @ApiProperty({ description: 'Snapshot de partida.', example: CAPTURE_DIFF_EXAMPLE.snapshotIdBefore })
  snapshotIdBefore!: string;

  @ApiProperty({ description: 'Snapshot final.', example: CAPTURE_DIFF_EXAMPLE.snapshotIdAfter })
  snapshotIdAfter!: string;

  @ApiProperty({ description: 'Momento del cálculo (ISO-8601).', example: CAPTURE_DIFF_EXAMPLE.createdAt })
  createdAt!: string;

  @ApiProperty({ description: 'Archivos que aparecieron.', type: [CaptureFileEntryDto] })
  addedFiles!: CaptureFileEntryDto[];

  @ApiProperty({ description: 'Archivos que cambiaron.', type: [CaptureFileChangeDto] })
  modifiedFiles!: CaptureFileChangeDto[];

  @ApiProperty({ description: 'Archivos que desaparecieron.', type: [CaptureFileEntryDto] })
  removedFiles!: CaptureFileEntryDto[];

  @ApiProperty({ description: 'Valores de registro que aparecieron.', type: [CaptureRegistryEntryDto] })
  addedRegistry!: CaptureRegistryEntryDto[];

  @ApiProperty({ description: 'Valores de registro que cambiaron.', type: [CaptureRegistryChangeDto] })
  modifiedRegistry!: CaptureRegistryChangeDto[];

  @ApiProperty({ description: 'Valores de registro que desaparecieron.', type: [CaptureRegistryEntryDto] })
  removedRegistry!: CaptureRegistryEntryDto[];

  @ApiProperty({
    description:
      'Reservado: el escaneo ya descarta la basura antes del diff, así que normalmente es 0.',
    example: 0,
  })
  filteredOut!: number;
}

export class CaptureTaskResultDto {
  @ApiPropertyOptional({ description: 'Snapshot creado por la tarea.', example: CAPTURE_TASK_FINISHED_EXAMPLE.result.snapshotId })
  snapshotId?: string;

  @ApiPropertyOptional({ description: 'Diff calculado al terminar.', example: CAPTURE_TASK_FINISHED_EXAMPLE.result.diffId })
  diffId?: string;

  @ApiPropertyOptional({ description: 'Archivos añadidos.', example: 12 })
  filesAdded?: number;

  @ApiPropertyOptional({ description: 'Archivos modificados.', example: 2 })
  filesModified?: number;

  @ApiPropertyOptional({ description: 'Archivos eliminados.', example: 0 })
  filesRemoved?: number;

  @ApiPropertyOptional({ description: 'Valores de registro añadidos.', example: 3 })
  registryAdded?: number;

  @ApiPropertyOptional({ description: 'Valores de registro modificados.', example: 1 })
  registryModified?: number;

  @ApiPropertyOptional({ description: 'Valores de registro eliminados.', example: 0 })
  registryRemoved?: number;
}

export class CaptureTaskDto {
  @ApiProperty({ description: 'ID con el que se consulta la tarea.', example: CAPTURE_TASK_EXAMPLE.taskId })
  taskId!: string;

  @ApiProperty({ description: 'Tipo de captura: `start` toma el snapshot, `finish` lo compara.', example: 'start' })
  kind!: string;

  @ApiProperty({ description: 'Estado: running, cancelling, completed, cancelled o failed.', example: 'running' })
  status!: string;

  @ApiProperty({ description: 'Fase actual de la captura.', example: 'files' })
  phase!: string;

  @ApiProperty({ description: 'Mensaje legible del progreso.', example: CAPTURE_TASK_EXAMPLE.message })
  message!: string;

  @ApiProperty({ description: 'Raíces de archivos a recorrer.', example: 1 })
  rootsTotal!: number;

  @ApiProperty({ description: 'Raíces ya recorridas.', example: 0 })
  rootsCompleted!: number;

  @ApiProperty({
    description: 'Raíz en curso; null cuando la tarea ya terminó.',
    type: 'string',
    nullable: true,
    example: CAPTURE_TASK_EXAMPLE.currentRoot,
  })
  currentRoot!: string | null;

  @ApiProperty({
    description: 'Ruta en curso; null cuando la tarea ya terminó.',
    type: 'string',
    nullable: true,
    example: CAPTURE_TASK_EXAMPLE.currentPath,
  })
  currentPath!: string | null;

  @ApiProperty({ description: 'Entradas visitadas hasta ahora.', example: 1240 })
  entriesVisited!: number;

  @ApiProperty({ description: 'Archivos encontrados hasta ahora.', example: 812 })
  filesFound!: number;

  @ApiProperty({ description: 'Raíces de registro a recorrer.', example: 1 })
  registryRootsTotal!: number;

  @ApiProperty({ description: 'Raíces de registro ya recorridas.', example: 0 })
  registryRootsCompleted!: number;

  @ApiProperty({
    description: 'Raíz de registro en curso; null cuando la tarea ya terminó.',
    type: 'string',
    nullable: true,
    example: CAPTURE_TASK_EXAMPLE.currentRegistryRoot,
  })
  currentRegistryRoot!: string | null;

  @ApiProperty({ description: 'Inicio de la tarea (ISO-8601).', example: CAPTURE_TASK_EXAMPLE.startedAt })
  startedAt!: string;

  @ApiProperty({ description: 'Última actualización (ISO-8601).', example: CAPTURE_TASK_EXAMPLE.updatedAt })
  updatedAt!: string;

  @ApiPropertyOptional({ description: 'Motivo del fallo, solo cuando la tarea falla.', example: 'EPERM: acceso denegado' })
  error?: string;

  @ApiPropertyOptional({
    description: 'Resumen del resultado, solo cuando la tarea termina.',
    type: CaptureTaskResultDto,
  })
  result?: CaptureTaskResultDto;
}

export class CapturePackageResultDto {
  @ApiProperty({ description: 'Carpeta del paquete creado.', example: CAPTURE_PACKAGE_RESULT_EXAMPLE.packageDir })
  packageDir!: string;

  @ApiProperty({ description: 'Carpeta de staging donde revisar los archivos.', example: CAPTURE_PACKAGE_RESULT_EXAMPLE.stagingDir })
  stagingDir!: string;

  @ApiProperty({ description: 'Archivos copiados al staging.', example: CAPTURE_PACKAGE_RESULT_EXAMPLE.filesCopied })
  filesCopied!: number;

  @ApiProperty({
    description:
      'De esos archivos, cuántos ya existían antes de la captura (DLL, presets, datos del plugin) y se añadieron al staging para poder revisarlos antes de empaquetar.',
    example: CAPTURE_PACKAGE_RESULT_EXAMPLE.preExistingFiles,
  })
  preExistingFiles!: number;

  @ApiProperty({ description: 'Valores de registro preparados.', example: CAPTURE_PACKAGE_RESULT_EXAMPLE.registryEntries })
  registryEntries!: number;

  @ApiProperty({
    description:
      'Avisos no bloqueantes; por ejemplo, que no se pudo recuperar el snapshot inicial y faltan archivos previos del plugin.',
    type: [String],
    example: CAPTURE_PACKAGE_RESULT_EXAMPLE.warnings,
  })
  warnings!: string[];
}

export class CapturePreExistingDto {
  @ApiProperty({
    description:
      'Archivos que ya existían antes de la captura y se sumarían al paquete con «incluir archivos previos» marcado. Ya descuenta los que se hayan quitado del staging.',
    example: CAPTURE_PRE_EXISTING_EXAMPLE.count,
  })
  count!: number;

  @ApiProperty({
    description: 'Rutas relativas de esos archivos, tal como aparecen en el staging.',
    type: [String],
    example: CAPTURE_PRE_EXISTING_EXAMPLE.files,
  })
  files!: string[];

  @ApiProperty({
    description:
      'Archivos previos que se quitaron del staging y todavía se pueden devolver con `POST /capture/staging/:diffId/restore`. Es lo que enciende el botón «Recuperar previos».',
    example: CAPTURE_PRE_EXISTING_EXAMPLE.restorable,
  })
  restorable!: number;

  @ApiProperty({
    description:
      'Rutas relativas de esos archivos, en el orden del manifiesto. La vista lista cada una con su propio botón para devolverla con `POST /capture/staging/:diffId/restore?path=` sin recuperar las demás.',
    type: [String],
    example: CAPTURE_PRE_EXISTING_EXAMPLE.restorableFiles,
  })
  restorableFiles!: string[];

  @ApiProperty({
    description:
      'Avisos no bloqueantes; por ejemplo, que no se pudo recuperar el snapshot inicial y no hay forma de saber qué archivos previos faltan.',
    type: [String],
    example: CAPTURE_PRE_EXISTING_EXAMPLE.warnings,
  })
  warnings!: string[];
}

export class CaptureRevealPreExistingDto {
  @ApiProperty({ description: 'El archivo se ha abierto en el Explorador.', example: true })
  ok!: boolean;

  @ApiProperty({
    description: 'Ruta del archivo previo, relativa a la unidad de origen y con `/`.',
    example: CAPTURE_PRE_EXISTING_REVEAL_EXAMPLE.file,
  })
  file!: string;

  @ApiProperty({
    description: 'Ruta absoluta que se ha abierto: la misma que el recuento tiene en el snapshot.',
    example: CAPTURE_PRE_EXISTING_REVEAL_EXAMPLE.opened,
  })
  opened!: string;
}

export class CaptureRevealStagingDto {
  @ApiProperty({ description: 'El archivo se ha abierto en el Explorador.', example: true })
  ok!: boolean;

  @ApiProperty({
    description:
      'Ruta del archivo en el staging, tal como la devuelve `GET /capture/staging/:diffId` (con el separador de la plataforma).',
    example: CAPTURE_STAGING_REVEAL_EXAMPLE.file,
  })
  file!: string;

  @ApiProperty({
    description: 'Ruta absoluta que se ha abierto, dentro de la carpeta del staging.',
    example: CAPTURE_STAGING_REVEAL_EXAMPLE.opened,
  })
  opened!: string;
}

export class CaptureStagingRestoreDto {
  @ApiProperty({
    description: 'Archivos previos devueltos al staging en esta llamada.',
    example: CAPTURE_STAGING_RESTORE_EXAMPLE.restored,
  })
  restored!: number;

  @ApiProperty({
    description: 'Rutas relativas de los archivos recuperados, desde la unidad de origen y con `/`.',
    type: [String],
    example: CAPTURE_STAGING_RESTORE_EXAMPLE.files,
  })
  files!: string[];

  @ApiProperty({
    description:
      'Previos que el manifiesto da por anteriores a la captura y no se han podido recuperar: el origen ya no está en disco o la ruta del manifiesto no es válida.',
    type: [String],
    example: CAPTURE_STAGING_RESTORE_EXAMPLE.missing,
  })
  missing!: string[];

  @ApiProperty({
    description:
      'Avisos no bloqueantes; por ejemplo, que no se pudo recuperar el snapshot inicial y por eso no hay previos que devolver.',
    type: [String],
    example: CAPTURE_STAGING_RESTORE_EXAMPLE.warnings,
  })
  warnings!: string[];
}

export class CaptureStagingListDto {
  @ApiProperty({ description: 'Carpeta de staging del diff.', example: CAPTURE_STAGING_EXAMPLE.stagingDir })
  stagingDir!: string;

  @ApiProperty({
    description: 'Rutas relativas de los archivos en staging.',
    type: [String],
    example: CAPTURE_STAGING_EXAMPLE.files,
  })
  files!: string[];
}

export class CaptureFinalizeResultDto {
  @ApiProperty({ description: 'Carpeta final con el paquete copiado.', example: CAPTURE_FINALIZE_RESULT_EXAMPLE.packageDir })
  packageDir!: string;
}

export class CaptureOkDto {
  @ApiProperty({ description: 'La operación se aplicó.', example: true })
  ok!: boolean;
}

export class CaptureVMachineResultDto {
  @ApiPropertyOptional({ description: 'Carpeta del banco generado.', example: CAPTURE_VMACHINE_RESULT_EXAMPLE.bankDir })
  bankDir?: string;

  @ApiPropertyOptional({ description: 'Ruta del wizard generado.', example: CAPTURE_VMACHINE_RESULT_EXAMPLE.wizardPath })
  wizardPath?: string;

  @ApiProperty({
    description: 'Avisos de la generación; vacío cuando todo salió bien.',
    type: [String],
    example: CAPTURE_VMACHINE_RESULT_EXAMPLE.warnings,
  })
  warnings!: string[];
}
