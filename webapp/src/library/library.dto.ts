import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  FXB_CONFIG_SNAPSHOT_EXAMPLE,
  FxbConfigSnapshotDto,
} from '../fxb-config/fxb-config.dto';
import { MAX_PLUGINS_PER_BATCH } from '../client/batch-stream';
import { MAX_BANKS_PER_REQUEST } from './library.service';

/**
 * Ejemplos de los endpoints de librería. Las rutas son las de una instalación
 * típica; el módulo acepta cualquier raíz absoluta con `plugs\`.
 */
const LIBRARY_ROOT = 'C:\\VFX\\Library';
const PLUGS_PATH = 'C:\\VFX\\Library\\plugs';
const PLUGIN_DIR = 'C:\\VFX\\Library\\plugs\\MySynth';
const PRESETS_DIR = 'C:\\VFX\\Library\\plugs\\MySynth\\presets';
const REPO_DLL = 'C:\\fxbLoader\\vst\\fxbLoader.dll';

/** Resultado de validar el `fxbLoader.dll` que se instalaría. */
export const LIBRARY_LOADER_EXAMPLE = {
  path: REPO_DLL,
  valid: true,
  bitness: 32,
  machine: 'i386',
  issues: [],
};

/** Plugin instalado, tal como lo devuelve `scan`. */
export const LIBRARY_INSTALLED_PLUGIN_EXAMPLE = {
  name: 'MySynth',
  path: PLUGIN_DIR,
  installed: true,
  hasVfxinfo: true,
  pluginName: 'MySynth.dll',
  warnings: [],
  compatible: true,
  compatibilityIssues: [],
};

/** Plugin sin el cargador instalado (`pluginName` es `null`). */
export const LIBRARY_PENDING_PLUGIN_EXAMPLE = {
  name: 'GrandPiano',
  path: 'C:\\VFX\\Library\\plugs\\GrandPiano',
  installed: false,
  hasVfxinfo: true,
  pluginName: null,
  warnings: [],
  compatible: true,
  compatibilityIssues: [],
};

export const LIBRARY_SCAN_EXAMPLE = {
  libraryRoot: LIBRARY_ROOT,
  plugsPath: PLUGS_PATH,
  loader: LIBRARY_LOADER_EXAMPLE,
  plugins: [LIBRARY_INSTALLED_PLUGIN_EXAMPLE, LIBRARY_PENDING_PLUGIN_EXAMPLE],
};

export const LIBRARY_INSTALL_EXAMPLE = {
  plugin: LIBRARY_INSTALLED_PLUGIN_EXAMPLE,
  actions: [
    {
      kind: 'backup',
      path: 'C:\\VFX\\Library\\plugs\\MySynth\\vfxinfo.tx_',
      detail: 'copia del vfxinfo.txt original',
    },
    { kind: 'copy', path: 'C:\\VFX\\Library\\plugs\\MySynth\\fxbLoader.dll', detail: REPO_DLL },
    {
      kind: 'patch',
      path: 'C:\\VFX\\Library\\plugs\\MySynth\\vfxinfo.txt',
      detail: 'dll_name: MySynth/fxbLoader.dll',
    },
    {
      kind: 'write-config',
      path: 'C:\\VFX\\Library\\plugs\\MySynth\\fxbLoader.config',
      detail: 'pluginName = MySynth.dll',
    },
    { kind: 'create-dir', path: PRESETS_DIR },
  ],
  dryRun: false,
};

export const LIBRARY_INSTALL_DRY_RUN_EXAMPLE = {
  plugin: LIBRARY_PENDING_PLUGIN_EXAMPLE,
  actions: [
    {
      kind: 'backup',
      path: 'C:\\VFX\\Library\\plugs\\GrandPiano\\vfxinfo.tx_',
      detail: 'copia del vfxinfo.txt original',
    },
    {
      kind: 'copy',
      path: 'C:\\VFX\\Library\\plugs\\GrandPiano\\fxbLoader.dll',
      detail: REPO_DLL,
    },
    {
      kind: 'patch',
      path: 'C:\\VFX\\Library\\plugs\\GrandPiano\\vfxinfo.txt',
      detail: 'dll_name: GrandPiano/fxbLoader.dll',
    },
    {
      kind: 'write-config',
      path: 'C:\\VFX\\Library\\plugs\\GrandPiano\\fxbLoader.config',
      detail: 'pluginName = GrandPiano.dll',
    },
    { kind: 'create-dir', path: 'C:\\VFX\\Library\\plugs\\GrandPiano\\presets' },
  ],
  dryRun: true,
};

export const LIBRARY_UNINSTALL_EXAMPLE = {
  plugin: {
    name: 'MySynth',
    path: PLUGIN_DIR,
    installed: false,
    hasVfxinfo: true,
    pluginName: null,
    warnings: [],
    compatible: true,
    compatibilityIssues: [],
  },
  actions: [
    {
      kind: 'restore',
      path: 'C:\\VFX\\Library\\plugs\\MySynth\\vfxinfo.loader',
      detail: 'se conserva el vfxinfo.txt modificado',
    },
    {
      kind: 'restore',
      path: 'C:\\VFX\\Library\\plugs\\MySynth\\vfxinfo.txt',
      detail: 'desde vfxinfo.tx_',
    },
    { kind: 'delete', path: 'C:\\VFX\\Library\\plugs\\MySynth\\fxbLoader.config' },
  ],
  dryRun: false,
};

/** Lote de instalación: un plugin bien y otro que ya estaba instalado. */
export const LIBRARY_BATCH_EXAMPLE = {
  action: 'install',
  dryRun: false,
  total: 2,
  succeeded: 1,
  failed: 1,
  results: [
    {
      name: 'MySynth',
      status: 'installed',
      message: null,
      entry: LIBRARY_INSTALLED_PLUGIN_EXAMPLE,
      actions: LIBRARY_INSTALL_EXAMPLE.actions,
    },
    {
      name: 'GrandPiano',
      status: 'failed',
      message: 'GrandPiano ya tiene fxbLoader instalado (usa force para reinstalar)',
      entry: null,
      actions: [],
    },
  ],
};

/** Lote en `dryRun`: solo el plan de cada plugin, sin tocar el disco. */
export const LIBRARY_BATCH_DRY_RUN_EXAMPLE = {
  action: 'install',
  dryRun: true,
  total: 1,
  succeeded: 1,
  failed: 0,
  results: [
    {
      name: 'GrandPiano',
      status: 'planned',
      message: null,
      entry: LIBRARY_PENDING_PLUGIN_EXAMPLE,
      actions: LIBRARY_INSTALL_DRY_RUN_EXAMPLE.actions,
    },
  ],
};

/**
 * Cuerpo de `POST /library/batch/stream`: el mismo lote que `LIBRARY_BATCH_EXAMPLE`,
 * una línea JSON por evento y en el orden en que los escribe el servidor.
 */
export const LIBRARY_BATCH_STREAM_EXAMPLE = [
  { type: 'start', action: 'install', dryRun: false, total: 2, plugins: ['MySynth', 'GrandPiano'] },
  { type: 'plugin', index: 0, total: 2, name: 'MySynth', status: 'running', message: null },
  { type: 'step', index: 0, total: 2, name: 'MySynth', step: 'backup', stepIndex: 0, steps: 5 },
  { type: 'step', index: 0, total: 2, name: 'MySynth', step: 'copy', stepIndex: 1, steps: 5 },
  { type: 'step', index: 0, total: 2, name: 'MySynth', step: 'patch', stepIndex: 2, steps: 5 },
  {
    type: 'step',
    index: 0,
    total: 2,
    name: 'MySynth',
    step: 'write-config',
    stepIndex: 3,
    steps: 5,
  },
  { type: 'step', index: 0, total: 2, name: 'MySynth', step: 'create-dir', stepIndex: 4, steps: 5 },
  { type: 'plugin', index: 0, total: 2, name: 'MySynth', status: 'installed', message: null },
  { type: 'plugin', index: 1, total: 2, name: 'GrandPiano', status: 'running', message: null },
  {
    type: 'plugin',
    index: 1,
    total: 2,
    name: 'GrandPiano',
    status: 'failed',
    message: 'GrandPiano ya tiene fxbLoader instalado (usa force para reinstalar)',
  },
  { type: 'end', result: LIBRARY_BATCH_EXAMPLE },
]
  .map((event) => JSON.stringify(event))
  .join('\n');

/** SHA-256 con forma válida para los ejemplos (no corresponde a un archivo real). */
const LIBRARY_INSPECT_SHA256 =
  '9f2c1d6e4b0a8c7d5e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d';

/** Cabecera VST2 del banco, ya interpretada por el parser. */
export const LIBRARY_BANK_EXAMPLE = {
  kind: 'FxBk',
  endianness: 'little',
  // 156 de cabecera + 8 de chunk + 48 de programa + 4 por un parámetro = 216;
  // byteSize excluye los 8 primeros bytes.
  byteSize: 208,
  version: 1,
  uniqueId: 'MySy',
  uniqueIdValue: 1299796857,
  fxVersion: 1000,
  numPrograms: 1,
  currentProgram: null,
  chunkSize: null,
};

export const LIBRARY_IMPORT_EXAMPLE = {
  plugin: LIBRARY_INSTALLED_PLUGIN_EXAMPLE,
  presetsDir: PRESETS_DIR,
  reference: {
    source: 'explicit',
    uniqueId: 'MySy',
    uniqueIdValue: 1299796857,
    fxVersion: 1000,
    file: null,
  },
  results: [
    {
      source: 'C:\\Banks\\Rhodes.fxb',
      fileName: 'Rhodes.fxb',
      target: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Rhodes.fxb',
      status: 'imported',
      compatibility: 'compatible',
      warnings: [],
      bank: LIBRARY_BANK_EXAMPLE,
    },
    {
      source: 'C:\\Banks\\Strings.fxb',
      fileName: 'Strings.fxb',
      target: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Strings.fxb',
      status: 'overwritten',
      compatibility: 'compatible',
      warnings: [],
      // Tres programas de un parámetro: 156 + 3 × 60 = 336; byteSize = 328.
      bank: { ...LIBRARY_BANK_EXAMPLE, byteSize: 328, numPrograms: 3 },
    },
  ],
};

export class LoaderDllDto {
  @ApiProperty({ description: 'Ruta del `fxbLoader.dll` validado.', example: REPO_DLL })
  path!: string;

  @ApiProperty({
    description: 'El archivo es un PE32 i386 válido y puede hospedar un plugin VST2 de 32 bits.',
    example: true,
  })
  valid!: boolean;

  @ApiProperty({
    description: '32 o 64 según el optional header; `null` si no se pudo leer.',
    type: Number,
    nullable: true,
    enum: [32, 64],
    example: 32,
  })
  bitness!: 32 | 64 | null;

  @ApiProperty({
    description: 'Arquitectura del `IMAGE_FILE_HEADER` (`i386`, `AMD64`, `ARM64`…).',
    type: String,
    nullable: true,
    example: 'i386',
  })
  machine!: string | null;

  @ApiProperty({
    description: 'Motivos por los que el DLL no es un cargador PE32 i386 utilizable.',
    type: [String],
    example: [],
  })
  issues!: string[];
}

export class PluginEntryDto {
  @ApiProperty({
    description: 'Nombre de la carpeta dentro de `plugs\\`; es el identificador que aceptan los demás endpoints.',
    example: 'MySynth',
  })
  name!: string;

  @ApiProperty({ description: 'Ruta absoluta del directorio del plugin.', example: PLUGIN_DIR })
  path!: string;

  @ApiProperty({
    description: 'El escaneo del binario marca instalado si existe `fxbLoader.config`.',
    example: true,
  })
  installed!: boolean;

  @ApiProperty({
    description: 'Existe `vfxinfo.txt`; sin él, instalar responde 422.',
    example: true,
  })
  hasVfxinfo!: boolean;

  @ApiProperty({
    description: '`pluginName` de `fxbLoader.config`, o `null` si no está instalado.',
    type: String,
    nullable: true,
    example: 'MySynth.dll',
  })
  pluginName!: string | null;

  @ApiProperty({
    description: 'Avisos al describir el plugin; no abortan el escaneo.',
    type: [String],
    example: [],
  })
  warnings!: string[];

  @ApiProperty({
    description:
      '`true` si el binario del plugin y el `fxbLoader.dll` instalado son PE32 i386; ' +
      '`false` si es incompatible de forma comprobable (otra arquitectura, archivo ' +
      'vacío, truncado o sin cabecera PE); `null` si el DLL no existe o no se pudo leer.',
    type: Boolean,
    nullable: true,
    example: true,
  })
  compatible!: boolean | null;

  @ApiProperty({
    description: 'Motivos de incompatibilidad o de la falta de verificación.',
    type: [String],
    example: [],
  })
  compatibilityIssues!: string[];
}

export class LibraryScanRequestDto {
  @ApiProperty({
    description: 'Carpeta que contiene `plugs\\` (la que el binario abre con «open vfxLibrary»). Debe ser absoluta.',
    example: LIBRARY_ROOT,
  })
  libraryRoot!: string;

  @ApiPropertyOptional({
    description:
      'DLL a validar como cargador. Si se omite se usa `FXB_LOADER_DLL` y, en último ' +
      'término, `vst\\fxbLoader.dll` del repositorio.',
    example: REPO_DLL,
  })
  dllSourcePath?: string;
}

export class LibraryScanResponseDto {
  @ApiProperty({ description: 'Raíz resuelta.', example: LIBRARY_ROOT })
  libraryRoot!: string;

  @ApiProperty({ description: 'Carpeta `plugs\\` que se ha enumerado.', example: PLUGS_PATH })
  plugsPath!: string;

  @ApiProperty({
    description: 'Validación del cargador que se instalaría; si no es PE32 i386, los plugins quedan incompatibles.',
    type: () => LoaderDllDto,
  })
  loader!: LoaderDllDto;

  @ApiProperty({
    description: 'Solo directorios, ordenados por nombre.',
    type: () => PluginEntryDto,
    isArray: true,
  })
  plugins!: PluginEntryDto[];
}

export class LibraryInstallRequestDto {
  @ApiProperty({ description: 'Raíz absoluta de la librería.', example: LIBRARY_ROOT })
  libraryRoot!: string;

  @ApiProperty({ description: 'Nombre de la carpeta del plugin dentro de `plugs\\`.', example: 'MySynth' })
  plugin!: string;

  @ApiPropertyOptional({
    description:
      'DLL a copiar. Si se omite se usa `FXB_LOADER_DLL` y, en último término, ' +
      '`vst\\fxbLoader.dll` del repositorio.',
    example: REPO_DLL,
  })
  dllSourcePath?: string;

  @ApiPropertyOptional({
    description: 'Reinstalar aunque `fxbLoader.config` ya exista (409 sin esto).',
    example: false,
  })
  force?: boolean;

  @ApiPropertyOptional({
    description: 'Devuelve el plan de `actions` sin tocar el disco.',
    example: false,
  })
  dryRun?: boolean;
}

export class LibraryBatchRequestDto {
  @ApiProperty({ description: 'Raíz absoluta de la librería.', example: LIBRARY_ROOT })
  libraryRoot!: string;

  @ApiProperty({
    description: 'Acción aplicada a todos los plugins indicados.',
    enum: ['install', 'uninstall'],
    example: 'install',
  })
  action!: 'install' | 'uninstall';

  @ApiProperty({
    description:
      'Carpetas de `plugs\\`, en el orden de procesado (en serie). Un fallo no ' +
      `detiene el lote: cada uno lleva su resultado. Como máximo ${MAX_PLUGINS_PER_BATCH} ` +
      'por petición.',
    type: [String],
    example: ['MySynth', 'GrandPiano'],
  })
  plugins!: string[];

  @ApiPropertyOptional({
    description: 'DLL a copiar en la instalación; como en `install`, si se omite se usa la del repositorio.',
    example: REPO_DLL,
  })
  dllSourcePath?: string;

  @ApiPropertyOptional({
    description: 'Reinstalar los que ya tengan `fxbLoader.config`; sin esto, cada uno falla con 409.',
    example: false,
  })
  force?: boolean;

  @ApiPropertyOptional({
    description:
      'Devuelve el plan de `actions` de cada plugin sin tocar el disco y con `status: "planned"`.',
    example: false,
  })
  dryRun?: boolean;
}

export class LibraryUninstallRequestDto {
  @ApiProperty({ description: 'Raíz absoluta de la librería.', example: LIBRARY_ROOT })
  libraryRoot!: string;

  @ApiProperty({ description: 'Nombre de la carpeta del plugin dentro de `plugs\\`.', example: 'MySynth' })
  plugin!: string;

  @ApiPropertyOptional({
    description: 'Devuelve el plan de `actions` sin tocar el disco.',
    example: false,
  })
  dryRun?: boolean;
}

export class LibraryBanksListRequestDto {
  @ApiProperty({ description: 'Raíz absoluta de la librería.', example: LIBRARY_ROOT })
  libraryRoot!: string;

  @ApiProperty({
    description: 'Nombre de la carpeta del plugin dentro de `plugs\\`.',
    example: 'MySynth',
  })
  plugin!: string;
}

export class LibraryBanksImportRequestDto {
  @ApiProperty({ description: 'Raíz absoluta de la librería.', example: LIBRARY_ROOT })
  libraryRoot!: string;

  @ApiProperty({ description: 'Nombre de la carpeta del plugin dentro de `plugs\\`.', example: 'MySynth' })
  plugin!: string;

  @ApiProperty({
    description:
      `Rutas absolutas de los \`.fxb\` a copiar; como máximo ${MAX_BANKS_PER_REQUEST} por petición. ` +
      'Se validan una a una: un archivo rechazado no cancela el resto.',
    type: [String],
    example: ['C:\\Banks\\Rhodes.fxb', 'C:\\Banks\\Strings.fxb'],
  })
  sourcePaths!: string[];

  @ApiPropertyOptional({
    description:
      'uniqueID esperado del plugin: 4 caracteres (`MySy`) o el entero `CCONST`. ' +
      'Es la única referencia que exige compatibilidad estricta.',
    oneOf: [{ type: 'string', minLength: 4, maxLength: 4 }, { type: 'integer' }],
    example: 'MySy',
  })
  expectedUniqueId?: string | number;

  @ApiPropertyOptional({
    description:
      '`fxVersion` esperada; solo se exige si el cliente la envía (la DLL no la compara).',
    example: 1000,
  })
  expectedFxVersion?: number;

  @ApiPropertyOptional({
    description: 'Sobrescribir un banco con el mismo nombre. Por defecto `true`, como el original.',
    example: true,
  })
  overwrite?: boolean;
}

export class LibraryActionDto {
  @ApiProperty({
    description: 'Tipo de efecto sobre el disco.',
    enum: ['backup', 'copy', 'patch', 'write-config', 'create-dir', 'delete', 'restore'],
    example: 'copy',
  })
  kind!: 'backup' | 'copy' | 'patch' | 'write-config' | 'create-dir' | 'delete' | 'restore';

  @ApiProperty({
    description: 'Ruta absoluta afectada.',
    example: 'C:\\VFX\\Library\\plugs\\MySynth\\fxbLoader.dll',
  })
  path!: string;

  @ApiPropertyOptional({
    description: 'Detalle del paso: origen de la copia, línea escrita, etc.',
    example: REPO_DLL,
  })
  detail?: string;
}

/** Resultado del lote para un único plugin. */
export class LibraryBatchPluginResultDto {
  @ApiProperty({ description: 'Carpeta del plugin dentro de `plugs\\`.', example: 'MySynth' })
  name!: string;

  @ApiProperty({
    description:
      '`installed`/`uninstalled` si se aplicó, `planned` si solo se calculó el plan con ' +
      '`dryRun`, `failed` si ese plugin no se pudo operar.',
    enum: ['installed', 'uninstalled', 'planned', 'failed'],
    example: 'installed',
  })
  status!: 'installed' | 'uninstalled' | 'planned' | 'failed';

  @ApiProperty({
    description: 'Motivo del fallo; `null` si la operación fue correcta.',
    type: String,
    nullable: true,
    example: null,
  })
  message!: string | null;

  @ApiProperty({
    description: 'Estado del plugin tras la operación; `null` si no se pudo operar.',
    nullable: true,
    type: () => PluginEntryDto,
  })
  entry!: PluginEntryDto | null;

  @ApiProperty({
    description: 'Pasos aplicados o, con `dryRun`, el plan. Vacío si falló antes de planificar.',
    type: () => LibraryActionDto,
    isArray: true,
  })
  actions!: LibraryActionDto[];
}

export class LibraryBatchResponseDto {
  @ApiProperty({ enum: ['install', 'uninstall'], example: 'install' })
  action!: 'install' | 'uninstall';

  @ApiProperty({ description: '`true` si solo se calcularon los planes.', example: false })
  dryRun!: boolean;

  @ApiProperty({ description: 'Plugins pedidos en la petición.', example: 2 })
  total!: number;

  @ApiProperty({ description: 'Plugins con `status` distinto de `failed`.', example: 1 })
  succeeded!: number;

  @ApiProperty({ description: 'Plugins con `status: "failed"`.', example: 1 })
  failed!: number;

  @ApiProperty({
    description: 'Resultado de cada plugin, en el orden pedido.',
    type: () => LibraryBatchPluginResultDto,
    isArray: true,
  })
  results!: LibraryBatchPluginResultDto[];
}

/** Misma forma para `install` y `uninstall`. */
export class LibraryOperationResponseDto {
  @ApiProperty({
    description: 'Estado del plugin después de la operación (`dryRun` no lo cambia).',
    type: () => PluginEntryDto,
  })
  plugin!: PluginEntryDto;

  @ApiProperty({
    description: 'Pasos ejecutados, en orden. Con `dryRun` son el plan, sin ejecutar.',
    type: () => LibraryActionDto,
    isArray: true,
  })
  actions!: LibraryActionDto[];

  @ApiProperty({ description: '`true` si solo se calculó el plan.', example: false })
  dryRun!: boolean;
}

export class BankInfoDto {
  @ApiProperty({ description: 'Tipo de banco.', enum: ['FxBk', 'FBCh'], example: 'FxBk' })
  kind!: 'FxBk' | 'FBCh';

  @ApiProperty({
    description: 'Orden de bytes detectado por el `chunkMagic`.',
    enum: ['little', 'big'],
    example: 'little',
  })
  endianness!: 'little' | 'big';

  @ApiProperty({ description: '`byteSize` de la cabecera (sin los 8 primeros bytes).', example: 208 })
  byteSize!: number;

  @ApiProperty({ description: 'Versión del formato de banco (1 o 2).', example: 1 })
  version!: number;

  @ApiProperty({
    description: 'uniqueID legible, o `0x…` si no es imprimible.',
    example: 'MySy',
  })
  uniqueId!: string;

  @ApiProperty({ description: 'Valor canónico `CCONST(a,b,c,d)`.', example: 1299796857 })
  uniqueIdValue!: number;

  @ApiProperty({ description: '`fxVersion` grabada en el banco.', example: 1000 })
  fxVersion!: number;

  @ApiProperty({
    description: 'Programas del banco; en `FBCh` solo es informativo.',
    example: 1,
  })
  numPrograms!: number;

  @ApiProperty({
    description: 'Solo en la versión 2 del formato de banco.',
    type: Number,
    nullable: true,
    example: null,
  })
  currentProgram!: number | null;

  @ApiProperty({
    description: 'Tamaño del chunk opaco, solo en `FBCh`.',
    type: Number,
    nullable: true,
    example: null,
  })
  chunkSize!: number | null;
}

export class BankReferenceDto {
  @ApiProperty({
    description:
      'De dónde salió la identidad del plugin: petición, un banco ya presente ' +
      '(solo al añadir), el primer banco del lote, o ninguna.',
    enum: ['explicit', 'existing-bank', 'batch', 'none'],
    example: 'explicit',
  })
  source!: 'explicit' | 'existing-bank' | 'batch' | 'none';

  @ApiProperty({ description: 'uniqueID de referencia.', type: String, nullable: true, example: 'MySy' })
  uniqueId!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 1299796857 })
  uniqueIdValue!: number | null;

  @ApiProperty({ description: '`fxVersion` de referencia.', type: Number, nullable: true, example: 1000 })
  fxVersion!: number | null;

  @ApiProperty({
    description: 'Banco del que se tomó la referencia, si aplica.',
    type: String,
    nullable: true,
    example: null,
  })
  file!: string | null;
}

export class BankImportResultDto {
  @ApiProperty({ description: 'Ruta de origen tal como se envió.', example: 'C:\\Banks\\Rhodes.fxb' })
  source!: string;

  @ApiProperty({ description: 'Nombre del archivo.', example: 'Rhodes.fxb' })
  fileName!: string;

  @ApiProperty({
    description: 'Destino dentro de `<plugin>\\<programDirName>\\`.',
    example: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Rhodes.fxb',
  })
  target!: string;

  @ApiProperty({
    description: 'Resultado por archivo.',
    enum: ['imported', 'overwritten', 'rejected'],
    example: 'imported',
  })
  status!: 'imported' | 'overwritten' | 'rejected';

  @ApiProperty({
    description:
      '`compatible` si el uniqueID coincide (y la versión, si se pidió), ' +
      '`incompatible` si no, `unverified` si no hay referencia.',
    enum: ['compatible', 'incompatible', 'unverified'],
    example: 'compatible',
  })
  compatibility!: 'compatible' | 'incompatible' | 'unverified';

  @ApiPropertyOptional({
    description: 'Motivo del rechazo. Solo con `rejected`.',
    example: 'la extensión debe ser .fxb',
  })
  reason?: string;

  @ApiPropertyOptional({
    description: 'Defectos de formato que impiden usar el banco.',
    type: [String],
    example: ['byteSize 200 no coincide con el tamaño del archivo (196 sin cabecera de chunk)'],
  })
  issues?: string[];

  @ApiPropertyOptional({
    description: 'Rarezas que no impiden la importación.',
    type: [String],
    example: [],
  })
  warnings?: string[];

  @ApiProperty({
    description: 'Cabecera interpretada, o `null` si ni siquiera se pudo leer.',
    type: () => BankInfoDto,
    nullable: true,
  })
  bank!: BankInfoDto | null;
}

export class LibraryBankInspectRequestDto {
  @ApiProperty({
    description: 'Ruta absoluta del `.fxb` a inspeccionar. Solo se lee: no se copia ni se modifica.',
    example: 'C:\\Banks\\Rhodes.fxb',
  })
  sourcePath!: string;

  @ApiPropertyOptional({
    description:
      'Raíz de la librería. Sin `libraryRoot` y `plugin` el endpoint solo valida el archivo.',
    example: LIBRARY_ROOT,
  })
  libraryRoot?: string;

  @ApiPropertyOptional({
    description: 'Plugin con cuyos bancos comparar el archivo (exige `libraryRoot`).',
    example: 'MySynth',
  })
  plugin?: string;

  @ApiPropertyOptional({
    description: 'uniqueID esperado: 4 caracteres (`MySy`) o el entero `CCONST`.',
    oneOf: [{ type: 'string', minLength: 4, maxLength: 4 }, { type: 'integer' }],
    example: 'MySy',
  })
  expectedUniqueId?: string | number;

  @ApiPropertyOptional({
    description: '`fxVersion` esperada; solo se compara si se envía.',
    example: 1000,
  })
  expectedFxVersion?: number;
}

export class LibraryBankExportRequestDto {
  @ApiProperty({ description: 'Raíz absoluta de la librería.', example: LIBRARY_ROOT })
  libraryRoot!: string;

  @ApiProperty({ description: 'Nombre de la carpeta del plugin dentro de `plugs\\`.', example: 'MySynth' })
  plugin!: string;

  @ApiProperty({
    description:
      'Nombre de un `.fxb` ya importado en `<plugin>\\<programDirName>\\`. Solo se lee: el ' +
      'archivo exportado se crea al lado, con el sufijo del orden pedido.',
    example: 'Legacy.fxb',
  })
  fileName!: string;

  @ApiProperty({
    description:
      'Orden de bytes del archivo de salida. `little` es el que escribe un plugin de ' +
      'Windows que guarda su struct nativo; `big` es el estándar VST2.',
    enum: ['big', 'little'],
    example: 'little',
  })
  endianness!: 'big' | 'little';

  @ApiPropertyOptional({
    description: 'Reemplazar el archivo de salida si ya existe. Por defecto `false`.',
    example: false,
  })
  overwrite?: boolean;
}

/** Banco ya presente en la carpeta de presets del plugin. */
export class PluginBankEntryDto {
  @ApiProperty({ example: 'Warm Rhodes.fxb' })
  fileName!: string;

  @ApiProperty({ example: 216 })
  size!: number;

  @ApiProperty({ type: () => BankInfoDto })
  bank!: BankInfoDto;
}

/** Banco del plugin comparado con el archivo inspeccionado. */
export class PluginBankDto extends PluginBankEntryDto {
  @ApiProperty({
    description: 'Coincide el uniqueID con el del banco inspeccionado.',
    example: true,
  })
  sameUniqueId!: boolean;

  @ApiProperty({
    description: 'Coincide la `fxVersion` con la del banco inspeccionado.',
    example: true,
  })
  sameFxVersion!: boolean;
}

export class LibraryBankInspectResponseDto {
  @ApiProperty({ example: 'C:\\Banks\\Rhodes.fxb' })
  source!: string;

  @ApiProperty({ example: 'Rhodes.fxb' })
  fileName!: string;

  @ApiProperty({ example: 216 })
  size!: number;

  @ApiProperty({
    description: 'SHA-256 del archivo inspeccionado.',
    example: LIBRARY_INSPECT_SHA256,
  })
  sha256!: string;

  @ApiProperty({
    description: '`false` si el archivo no es un banco VST2 usable; el detalle va en `issues`.',
    example: true,
  })
  valid!: boolean;

  @ApiProperty({
    description: 'Cabecera interpretada, o `null` si ni siquiera se pudo leer.',
    type: () => BankInfoDto,
    nullable: true,
  })
  bank!: BankInfoDto | null;

  @ApiProperty({ type: [String], example: [] })
  issues!: string[];

  @ApiProperty({ type: [String], example: [] })
  warnings!: string[];

  @ApiProperty({
    description:
      'Referencia con la que se comparó: la explícita, el primer banco del plugin o ninguna.',
    type: () => BankReferenceDto,
  })
  reference!: BankReferenceDto;

  @ApiProperty({
    enum: ['compatible', 'incompatible', 'unverified'],
    example: 'compatible',
  })
  compatibility!: 'compatible' | 'incompatible' | 'unverified';

  @ApiProperty({
    description: 'Motivo de la incompatibilidad, si la hay.',
    type: String,
    nullable: true,
    example: null,
  })
  reason!: string | null;

  @ApiProperty({
    description: 'Dónde acabaría al importarlo; `null` si no se indicó plugin.',
    type: String,
    nullable: true,
    example: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Rhodes.fxb',
  })
  target!: string | null;

  @ApiProperty({
    description: 'Carpeta de presets del plugin; `null` sin plugin.',
    type: String,
    nullable: true,
    example: PRESETS_DIR,
  })
  presetsDir!: string | null;

  @ApiProperty({
    description: 'Ya existe un archivo con ese nombre en el destino (no se ha tocado).',
    example: false,
  })
  targetExists!: boolean;

  @ApiProperty({
    description: 'Bancos válidos del plugin, en orden de nombre. Solo se lee su cabecera.',
    type: () => PluginBankDto,
    isArray: true,
  })
  existingBanks!: PluginBankDto[];
}

/** Un banco implicado en la exportación, con su hash y su cabecera. */
export class BankExportFileDto {
  @ApiProperty({ example: 'Legacy.fxb' })
  fileName!: string;

  @ApiProperty({ example: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Legacy.fxb' })
  path!: string;

  @ApiProperty({ example: 216 })
  size!: number;

  @ApiProperty({
    description: 'SHA-256 del archivo.',
    example: LIBRARY_INSPECT_SHA256,
  })
  sha256!: string;

  @ApiProperty({ type: () => BankInfoDto })
  bank!: BankInfoDto;
}

export class LibraryBankExportResponseDto {
  @ApiProperty({ type: () => PluginEntryDto })
  plugin!: PluginEntryDto;

  @ApiProperty({ example: PRESETS_DIR })
  presetsDir!: string;

  @ApiProperty({
    description: 'Banco leído, en el orden en que estaba. No se modifica.',
    type: () => BankExportFileDto,
  })
  source!: BankExportFileDto;

  @ApiProperty({
    description: 'Archivo escrito en el orden pedido.',
    type: () => BankExportFileDto,
  })
  target!: BankExportFileDto;

  @ApiProperty({
    description: '`false` si ya estaba en ese orden y no hubo nada que invertir.',
    example: true,
  })
  changed!: boolean;

  @ApiProperty({
    description: 'Campos de 32 bits cuyo orden de bytes se invirtió.',
    example: 16,
  })
  fields!: number;

  @ApiProperty({ description: 'Programas recorridos; `0` en un `FBCh`.', example: 1 })
  programs!: number;

  @ApiProperty({
    description: 'Tamaños de chunk reescritos: uno por programa `FPCh`, más el del `FBCh`.',
    example: 0,
  })
  chunks!: number;
}

export class LibraryBankConvertRequestDto {
  @ApiProperty({ description: 'Raíz absoluta de la librería.', example: LIBRARY_ROOT })
  libraryRoot!: string;

  @ApiProperty({ description: 'Nombre de la carpeta del plugin dentro de `plugs\\`.', example: 'MySynth' })
  plugin!: string;

  @ApiPropertyOptional({
    description:
      'Orden de bytes de destino. Sin él se invierte el que tiene el banco por defecto, ' +
      'que es la conversión natural de un banco legacy guardado por un plugin de Windows.',
    enum: ['big', 'little'],
    example: 'big',
  })
  endianness?: 'big' | 'little';
}

export class LibraryBankRestoreRequestDto {
  @ApiProperty({ description: 'Raíz absoluta de la librería.', example: LIBRARY_ROOT })
  libraryRoot!: string;

  @ApiProperty({ description: 'Nombre de la carpeta del plugin dentro de `plugs\\`.', example: 'MySynth' })
  plugin!: string;
}

/** Nombre y tamaño del respaldo del banco por defecto, sin leerlo entero. */
export class BankBackupSummaryDto {
  @ApiProperty({ example: 'Warm Rhodes.fxb.orig' })
  fileName!: string;

  @ApiProperty({ example: 216 })
  size!: number;
}

/** Copia byte a byte del banco antes de convertirlo en el sitio. */
export class BankBackupFileDto {
  @ApiProperty({ example: 'Warm Rhodes.fxb.orig' })
  fileName!: string;

  @ApiProperty({ example: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Warm Rhodes.fxb.orig' })
  path!: string;

  @ApiProperty({ example: 216 })
  size!: number;

  @ApiProperty({ description: 'SHA-256 del respaldo.', example: LIBRARY_INSPECT_SHA256 })
  sha256!: string;
}

export class LibraryBankConvertResponseDto {
  @ApiProperty({ type: () => PluginEntryDto })
  plugin!: PluginEntryDto;

  @ApiProperty({ example: PRESETS_DIR })
  presetsDir!: string;

  @ApiProperty({
    description: 'Banco por defecto tomado de `fxbLoader.config` (`defaultFxbName`).',
    example: 'Warm Rhodes.fxb',
  })
  fileName!: string;

  @ApiProperty({
    description: 'El archivo tal como estaba antes de convertirlo.',
    type: () => BankExportFileDto,
  })
  source!: BankExportFileDto;

  @ApiProperty({
    description: 'El mismo archivo, ya en el orden pedido: mismo nombre y misma ruta.',
    type: () => BankExportFileDto,
  })
  target!: BankExportFileDto;

  @ApiProperty({
    description:
      'Respaldo del original (`<banco>.orig`), o `null` si el banco ya estaba en ese orden ' +
      'y no se escribió nada.',
    type: () => BankBackupFileDto,
    nullable: true,
  })
  backup!: BankBackupFileDto | null;

  @ApiProperty({
    description:
      '`true` si el respaldo se creó en esta llamada. Si ya existía se conserva el primero, ' +
      'que es el original de verdad.',
    example: true,
  })
  backupCreated!: boolean;

  @ApiProperty({
    description: '`false` si ya estaba en ese orden y no hubo nada que invertir.',
    example: true,
  })
  changed!: boolean;

  @ApiProperty({
    description: 'Campos de 32 bits cuyo orden de bytes se invirtió.',
    example: 16,
  })
  fields!: number;

  @ApiProperty({
    description: 'Programas recorridos; `0` en un `FBCh` o si no hubo nada que convertir.',
    example: 1,
  })
  programs!: number;

  @ApiProperty({
    description: 'Tamaños de chunk reescritos: uno por programa `FPCh`, más el del `FBCh`.',
    example: 0,
  })
  chunks!: number;
}

export class LibraryBankRestoreResponseDto {
  @ApiProperty({ type: () => PluginEntryDto })
  plugin!: PluginEntryDto;

  @ApiProperty({ example: PRESETS_DIR })
  presetsDir!: string;

  @ApiProperty({
    description: 'Banco por defecto tomado de `fxbLoader.config` (`defaultFxbName`).',
    example: 'Warm Rhodes.fxb',
  })
  fileName!: string;

  @ApiProperty({
    description:
      'El banco tal como queda en disco: mismo nombre y ruta, contenido del respaldo. Se ' +
      'vuelve a parsear antes de darlo por restaurado.',
    type: () => BankExportFileDto,
  })
  restored!: BankExportFileDto;

  @ApiProperty({
    description:
      'Respaldo `<banco>.orig` usado. Solo se lee: conserva su tamaño y su hash, así que se ' +
      'puede restaurar varias veces.',
    type: () => BankBackupFileDto,
  })
  backup!: BankBackupFileDto;

  @ApiProperty({
    description: '`false` si el banco ya era byte a byte el respaldo y no se escribió nada.',
    example: true,
  })
  changed!: boolean;
}

export class LibraryBanksListResponseDto {
  @ApiProperty({ type: () => PluginEntryDto })
  plugin!: PluginEntryDto;

  @ApiProperty({
    description: 'Carpeta de bancos del plugin (`programDirName`).',
    example: PRESETS_DIR,
  })
  presetsDir!: string;

  @ApiProperty({
    description: '`false` si la carpeta aún no existe; se crea al importar.',
    example: true,
  })
  presetsDirExists!: boolean;

  @ApiProperty({
    description: 'Bancos válidos, ordenados por nombre. Solo se lee su cabecera.',
    type: () => PluginBankEntryDto,
    isArray: true,
  })
  banks!: PluginBankEntryDto[];

  @ApiProperty({
    description:
      'Respaldo `<banco>.orig` del banco por defecto, o `null` si no hay ninguno. Se lee solo ' +
      'su tamaño: sirve para habilitar «Restaurar original» sin pedir una restauración que ' +
      'vaya a fallar.',
    type: () => BankBackupSummaryDto,
    nullable: true,
  })
  defaultBackup!: BankBackupSummaryDto | null;

  @ApiProperty({
    description:
      'Snapshot de `fxbLoader.config` (con `mtimeMs` para el control optimista). ' +
      'Con el archivo ausente devuelve los valores por defecto y `exists: false`.',
    type: () => FxbConfigSnapshotDto,
  })
  config!: FxbConfigSnapshotDto;
}

export class LibraryBanksImportResponseDto {
  @ApiProperty({ description: 'Estado del plugin tras la importación.', type: () => PluginEntryDto })
  plugin!: PluginEntryDto;

  @ApiProperty({
    description: 'Carpeta de destino: `<plugin>\\<programDirName>\\`.',
    example: PRESETS_DIR,
  })
  presetsDir!: string;

  @ApiProperty({
    description: 'Referencia usada para decidir la compatibilidad.',
    type: () => BankReferenceDto,
  })
  reference!: BankReferenceDto;

  @ApiProperty({
    description: 'Un elemento por archivo enviado, en el mismo orden.',
    type: () => BankImportResultDto,
    isArray: true,
  })
  results!: BankImportResultDto[];
}

export class LibraryErrorDto {
  @ApiProperty({
    description: 'Explicación del error.',
    example: 'libraryRoot debe ser una ruta absoluta: "plugs"',
  })
  message!: string;
}

export class LibraryConflictErrorDto {
  @ApiProperty({
    description: 'Estado que impide la operación.',
    example: 'MySynth ya tiene fxbLoader instalado (usa force para reinstalar)',
  })
  message!: string;

  @ApiPropertyOptional({
    description:
      'Solo si `fxbLoader.config` cambió entre la lectura y la escritura: snapshot vigente.',
    type: () => FxbConfigSnapshotDto,
  })
  current?: FxbConfigSnapshotDto;
}

/** Cuerpo del 422 de `banks/import`: el resultado completo más el motivo global. */
export class LibraryBanksImportErrorDto {
  @ApiProperty({ example: 'Ningún banco se pudo importar' })
  message!: string;

  @ApiProperty({ type: () => PluginEntryDto })
  plugin!: PluginEntryDto;

  @ApiProperty({ example: PRESETS_DIR })
  presetsDir!: string;

  @ApiProperty({ type: () => BankReferenceDto })
  reference!: BankReferenceDto;

  @ApiProperty({ type: () => BankImportResultDto, isArray: true })
  results!: BankImportResultDto[];
}

export const LIBRARY_SCAN_PATH_ERROR_EXAMPLE = {
  message: 'libraryRoot debe ser una ruta absoluta: "plugs"',
};

export const LIBRARY_LIBRARY_MISSING_ERROR_EXAMPLE = {
  message: 'la librería no contiene una carpeta "plugs": C:\\VFX\\Library',
};

export const LIBRARY_DLL_ERROR_EXAMPLE = {
  message: 'dllSourcePath debe ser una ruta absoluta: "vst/fxbLoader.dll"',
};

export const LIBRARY_PLUGIN_NOT_FOUND_EXAMPLE = {
  message: 'no existe el plugin "NoExiste" en C:\\VFX\\Library\\plugs',
};

export const LIBRARY_INSTALL_CONFLICT_EXAMPLE = {
  message: 'MySynth ya tiene fxbLoader instalado (usa force para reinstalar)',
};

export const LIBRARY_UNINSTALL_CONFLICT_EXAMPLE = {
  message: 'MySynth no tiene fxbLoader instalado',
};

export const LIBRARY_BATCH_ACTION_ERROR_EXAMPLE = {
  message: 'action debe ser "install" o "uninstall"',
};

export const LIBRARY_BATCH_PLUGINS_ERROR_EXAMPLE = {
  message: 'plugins debe ser un array con al menos un nombre',
};

/** Lote más grande que el tope: se rechaza entero, sin procesar ningún plugin. */
export const LIBRARY_BATCH_TOO_MANY_ERROR_EXAMPLE = {
  message: `como máximo ${MAX_PLUGINS_PER_BATCH} plugins por petición`,
};

/** El cargador se valida una vez para todo el lote, antes de tocar nada. */
export const LIBRARY_BATCH_LOADER_ERROR_EXAMPLE = {
  message:
    'fxbLoader.dll no es un PE32 i386 válido: es PE32+ AMD64 (64 bits); fxbLoader.dll debe ' +
    'ser PE32 i386',
};

export const LIBRARY_VFXINFO_ERROR_EXAMPLE = {
  message:
    'vfxinfo.txt no contiene ninguna línea "dll_name"; el instalador original dejaría una ' +
    'configuración vacía, así que se rechaza la operación',
};

export const LIBRARY_MISSING_PLUGIN_DLL_ERROR_EXAMPLE = {
  message:
    'MySynth no es compatible con fxbLoader.dll de 32 bits: no existe el binario declarado ' +
    'en dll_name: MySynth/MySynth.dll',
};

export const LIBRARY_INCOMPATIBLE_ERROR_EXAMPLE = {
  message:
    'MySynth no es compatible con fxbLoader.dll de 32 bits: el binario del plugin es ' +
    'PE32+ AMD64 (64 bits); fxbLoader.dll requiere PE32 i386',
};

export const LIBRARY_IMPORT_REJECTED_EXAMPLE = {
  message: 'Ningún banco se pudo importar',
  plugin: LIBRARY_INSTALLED_PLUGIN_EXAMPLE,
  presetsDir: PRESETS_DIR,
  reference: {
    source: 'explicit',
    uniqueId: 'MySy',
    uniqueIdValue: 1299796857,
    fxVersion: null,
    file: null,
  },
  results: [
    {
      source: 'C:\\Banks\\Otro.fxb',
      fileName: 'Otro.fxb',
      target: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Otro.fxb',
      status: 'rejected',
      compatibility: 'incompatible',
      reason: 'uniqueID OtSy (0x4f745379) distinto del esperado MySy',
      // Un banco incompatible sí se parsea: la DLL devuelve `warnings`, no `issues`.
      warnings: [],
      bank: {
        ...LIBRARY_BANK_EXAMPLE,
        uniqueId: 'OtSy',
        uniqueIdValue: 1333023609,
      },
    },
  ],
};

/** Vista de bancos: lista el contenido y el estado de la configuración. */
export const LIBRARY_BANKS_LIST_EXAMPLE = {
  plugin: LIBRARY_INSTALLED_PLUGIN_EXAMPLE,
  presetsDir: PRESETS_DIR,
  presetsDirExists: true,
  banks: [
    {
      fileName: 'Warm Rhodes.fxb',
      size: 216,
      bank: LIBRARY_BANK_EXAMPLE,
    },
  ],
  defaultBackup: {
    fileName: 'Warm Rhodes.fxb.orig',
    size: 216,
  },
  config: {
    ...FXB_CONFIG_SNAPSHOT_EXAMPLE,
    configPath: 'C:\\VFX\\Library\\plugs\\MySynth\\fxbLoader.config',
    config: { ...FXB_CONFIG_SNAPSHOT_EXAMPLE.config, defaultFxbName: 'Warm Rhodes.fxb' },
  },
};

/** Inspección de un banco compatible con uno ya presente en el plugin. */
export const LIBRARY_INSPECT_EXAMPLE = {
  source: 'C:\\Banks\\Rhodes.fxb',
  fileName: 'Rhodes.fxb',
  size: 216,
  sha256: LIBRARY_INSPECT_SHA256,
  valid: true,
  bank: LIBRARY_BANK_EXAMPLE,
  issues: [],
  warnings: [],
  reference: {
    source: 'existing-bank',
    uniqueId: 'MySy',
    uniqueIdValue: 1299796857,
    fxVersion: 1000,
    file: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Warm Rhodes.fxb',
  },
  compatibility: 'compatible',
  reason: null,
  target: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Rhodes.fxb',
  presetsDir: PRESETS_DIR,
  targetExists: false,
  existingBanks: [
    {
      fileName: 'Warm Rhodes.fxb',
      size: 216,
      bank: LIBRARY_BANK_EXAMPLE,
      sameUniqueId: true,
      sameFxVersion: true,
    },
  ],
};

/** Sin `libraryRoot`/`plugin`: solo se valida el archivo. */
export const LIBRARY_INSPECT_WITHOUT_PLUGIN_EXAMPLE = {
  ...LIBRARY_INSPECT_EXAMPLE,
  reference: { source: 'none', uniqueId: null, uniqueIdValue: null, fxVersion: null, file: null },
  compatibility: 'unverified',
  reason: null,
  target: null,
  presetsDir: null,
  targetExists: false,
  existingBanks: [],
};

/** Archivo que no es un banco VST2: 200 con `valid: false` y los `issues`. */
export const LIBRARY_INSPECT_INVALID_EXAMPLE = {
  ...LIBRARY_INSPECT_WITHOUT_PLUGIN_EXAMPLE,
  source: 'C:\\Banks\\Roto.fxb',
  fileName: 'Roto.fxb',
  size: 120,
  valid: false,
  bank: null,
  issues: ['archivo de 120 bytes; un .fxb necesita al menos 156'],
  warnings: [],
};

export const LIBRARY_INSPECT_PATH_ERROR_EXAMPLE = {
  message: 'no existe el archivo: C:\\Banks\\Rhodes.fxb',
};

export const LIBRARY_INSPECT_EXTENSION_ERROR_EXAMPLE = {
  message: 'la extensión debe ser .fxb',
};

/** Exportación de un banco big-endian a little-endian. */
export const LIBRARY_EXPORT_EXAMPLE = {
  plugin: LIBRARY_INSTALLED_PLUGIN_EXAMPLE,
  presetsDir: PRESETS_DIR,
  source: {
    fileName: 'Legacy.fxb',
    path: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Legacy.fxb',
    size: 216,
    sha256: LIBRARY_INSPECT_SHA256,
    bank: { ...LIBRARY_BANK_EXAMPLE, endianness: 'big' },
  },
  target: {
    fileName: 'Legacy-le.fxb',
    path: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Legacy-le.fxb',
    size: 216,
    sha256: '1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071',
    bank: LIBRARY_BANK_EXAMPLE,
  },
  changed: true,
  // 8 de la cabecera + 7 del programa + 1 parámetro.
  fields: 16,
  programs: 1,
  chunks: 0,
};

/**
 * Conversión en el sitio del banco por defecto, con el respaldo del original.
 * El archivo conserva su nombre y su ruta; solo cambia el orden de sus campos.
 */
export const LIBRARY_CONVERT_EXAMPLE = {
  plugin: LIBRARY_INSTALLED_PLUGIN_EXAMPLE,
  presetsDir: PRESETS_DIR,
  fileName: 'Warm Rhodes.fxb',
  source: {
    fileName: 'Warm Rhodes.fxb',
    path: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Warm Rhodes.fxb',
    size: 216,
    sha256: LIBRARY_INSPECT_SHA256,
    bank: LIBRARY_BANK_EXAMPLE,
  },
  target: {
    fileName: 'Warm Rhodes.fxb',
    path: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Warm Rhodes.fxb',
    size: 216,
    sha256: '1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071',
    bank: { ...LIBRARY_BANK_EXAMPLE, endianness: 'big' },
  },
  backup: {
    fileName: 'Warm Rhodes.fxb.orig',
    path: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Warm Rhodes.fxb.orig',
    size: 216,
    sha256: LIBRARY_INSPECT_SHA256,
  },
  backupCreated: true,
  changed: true,
  // 8 de la cabecera + 7 del programa + 1 parámetro.
  fields: 16,
  programs: 1,
  chunks: 0,
};

export const LIBRARY_CONVERT_NO_DEFAULT_EXAMPLE = {
  message: 'el plugin no tiene un banco por defecto configurado en fxbLoader.config',
};

export const LIBRARY_CONVERT_MISSING_BANK_EXAMPLE = {
  message:
    'el banco por defecto "Rhodes.fxb" no está en la carpeta del plugin: ' +
    'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Rhodes.fxb',
};

/**
 * Restauración del banco por defecto desde su `.orig`. El respaldo se conserva
 * intacto: mismo tamaño y mismo hash que antes de restaurar.
 */
export const LIBRARY_RESTORE_EXAMPLE = {
  plugin: LIBRARY_INSTALLED_PLUGIN_EXAMPLE,
  presetsDir: PRESETS_DIR,
  fileName: 'Warm Rhodes.fxb',
  restored: {
    fileName: 'Warm Rhodes.fxb',
    path: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Warm Rhodes.fxb',
    size: 216,
    sha256: LIBRARY_INSPECT_SHA256,
    bank: LIBRARY_BANK_EXAMPLE,
  },
  backup: {
    fileName: 'Warm Rhodes.fxb.orig',
    path: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Warm Rhodes.fxb.orig',
    size: 216,
    sha256: LIBRARY_INSPECT_SHA256,
  },
  changed: true,
};

/** Restaurar dos veces seguidas: el banco ya es el respaldo y no se escribe nada. */
export const LIBRARY_RESTORE_UNCHANGED_EXAMPLE = {
  ...LIBRARY_RESTORE_EXAMPLE,
  changed: false,
};

export const LIBRARY_RESTORE_NO_BACKUP_EXAMPLE = {
  message:
    'no hay respaldo Warm Rhodes.fxb.orig en la carpeta del plugin; solo se puede restaurar ' +
    'un banco que se convirtió antes',
};

export const LIBRARY_RESTORE_INVALID_BACKUP_EXAMPLE = {
  message: 'el respaldo Warm Rhodes.fxb.orig no es un .fxb válido: archivo de 12 bytes; ' +
    'un .fxb necesita al menos 156',
};

export const LIBRARY_EXPORT_TARGET_EXISTS_EXAMPLE = {
  message:
    'ya existe C:\\VFX\\Library\\plugs\\MySynth\\presets\\Legacy-le.fxb; marca overwrite ' +
    'para reemplazarlo',
};
