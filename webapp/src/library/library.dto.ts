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
export const LIBRARY_PLUGIN_WITH_LOADER_EXAMPLE = {
  name: 'MySynth',
  path: PLUGIN_DIR,
  hasLoader: true,
  hasVfxinfo: true,
  hasWizard: true,
  wizardId: 'MySynth',
  hasMeta: true,
  pluginName: 'MySynth.dll',
  warnings: [],
  compatible: true,
  compatibilityIssues: [],
};

/** Plugin sin el cargador instalado (`pluginName` es `null`). */
export const LIBRARY_PLUGIN_WITHOUT_LOADER_EXAMPLE = {
  name: 'GrandPiano',
  path: 'C:\\VFX\\Library\\plugs\\GrandPiano',
  hasLoader: false,
  hasVfxinfo: true,
  hasWizard: false,
  wizardId: null,
  hasMeta: false,
  pluginName: null,
  warnings: [],
  compatible: true,
  compatibilityIssues: [],
};

export const LIBRARY_SCAN_EXAMPLE = {
  libraryRoot: LIBRARY_ROOT,
  plugsPath: PLUGS_PATH,
  loader: LIBRARY_LOADER_EXAMPLE,
  plugins: [
    { ...LIBRARY_PLUGIN_WITH_LOADER_EXAMPLE, banks: { count: 2, names: ['Rhodes.fxb', 'Strings.fxb'] } },
    { ...LIBRARY_PLUGIN_WITHOUT_LOADER_EXAMPLE, banks: { count: 0, names: [] } },
  ],
};

export const LIBRARY_LOADER_ADD_EXAMPLE = {
  plugin: LIBRARY_PLUGIN_WITH_LOADER_EXAMPLE,
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

export const LIBRARY_LOADER_ADD_DRY_RUN_EXAMPLE = {
  plugin: LIBRARY_PLUGIN_WITHOUT_LOADER_EXAMPLE,
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

export const LIBRARY_LOADER_REMOVE_EXAMPLE = {
  plugin: {
    name: 'MySynth',
    path: PLUGIN_DIR,
    hasLoader: false,
    hasVfxinfo: true,
    hasMeta: true,
    hasWizard: true,
    wizardId: 'MySynth',
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
  action: 'add',
  dryRun: false,
  total: 2,
  succeeded: 1,
  failed: 1,
  results: [
    {
      name: 'MySynth',
      status: 'added',
      message: null,
      entry: LIBRARY_PLUGIN_WITH_LOADER_EXAMPLE,
      actions: LIBRARY_LOADER_ADD_EXAMPLE.actions,
    },
    {
      name: 'GrandPiano',
      status: 'failed',
      message: 'GrandPiano ya tiene el cargador (usa force para volver a ponerlo)',
      entry: null,
      actions: [],
    },
  ],
};

/** Lote en `dryRun`: solo el plan de cada plugin, sin tocar el disco. */
export const LIBRARY_BATCH_DRY_RUN_EXAMPLE = {
  action: 'add',
  dryRun: true,
  total: 1,
  succeeded: 1,
  failed: 0,
  results: [
    {
      name: 'GrandPiano',
      status: 'planned',
      message: null,
      entry: LIBRARY_PLUGIN_WITHOUT_LOADER_EXAMPLE,
      actions: LIBRARY_LOADER_ADD_DRY_RUN_EXAMPLE.actions,
    },
  ],
};

/**
 * Cuerpo de `POST /library/batch/stream`: el mismo lote que `LIBRARY_BATCH_EXAMPLE`,
 * una línea JSON por evento y en el orden en que los escribe el servidor.
 */
export const LIBRARY_BATCH_STREAM_EXAMPLE = [
  { type: 'start', action: 'add', dryRun: false, total: 2, plugins: ['MySynth', 'GrandPiano'] },
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
  { type: 'plugin', index: 0, total: 2, name: 'MySynth', status: 'added', message: null },
  { type: 'plugin', index: 1, total: 2, name: 'GrandPiano', status: 'running', message: null },
  {
    type: 'plugin',
    index: 1,
    total: 2,
    name: 'GrandPiano',
    status: 'failed',
    message: 'GrandPiano ya tiene el cargador (usa force para volver a ponerlo)',
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
  plugin: LIBRARY_PLUGIN_WITH_LOADER_EXAMPLE,
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

/**
 * `POST /library/banks/import/stream`: los mismos resultados que
 * `LIBRARY_IMPORT_EXAMPLE`, una línea JSON por evento. El `end` llega también
 * cuando todos los bancos se rechazan; la vista cuenta los `rejected`.
 */
export const LIBRARY_BANKS_IMPORT_STREAM_EXAMPLE = [
  {
    type: 'start',
    total: 2,
    sourcePaths: ['C:\\Banks\\Rhodes.fxb', 'C:\\Banks\\Strings.fxb'],
  },
  { type: 'bank', index: 0, total: 2, result: LIBRARY_IMPORT_EXAMPLE.results[0] },
  { type: 'bank', index: 1, total: 2, result: LIBRARY_IMPORT_EXAMPLE.results[1] },
  { type: 'end', result: LIBRARY_IMPORT_EXAMPLE },
]
  .map((event) => JSON.stringify(event))
  .join('\n');

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
    description: 'El cargador está puesto si existe `fxbLoader.config`.',
    example: true,
  })
  hasLoader!: boolean;

  @ApiProperty({
    description: 'Existe `vfxinfo.txt`; sin él, poner el cargador responde 422.',
    example: true,
  })
  hasVfxinfo!: boolean;

  @ApiProperty({
    description: 'Existe un wizard oficial coincidente en la base de datos de wizards.',
    example: true,
  })
  hasWizard!: boolean;

  @ApiProperty({
    description: 'Identificador del wizard coincidente si existe, o `null`.',
    type: String,
    nullable: true,
    example: 'MySynth',
  })
  wizardId!: string | null;

  @ApiProperty({
    description:
      'Existe `fxbLoader.meta.json`: el plugin ya tiene catálogo propio, aunque no tenga bancos configurados.',
    example: false,
  })
  hasMeta!: boolean;

  @ApiProperty({
    description: '`pluginName` de `fxbLoader.config`, o `null` si no tiene el cargador.',
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
      '`true` si el binario del plugin y el `fxbLoader.dll` copiado son PE32 i386; ' +
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

/** Resumen de bancos que el escaneo añade a cada plugin. */
export class PluginBanksSummaryDto {
  @ApiProperty({
    description:
      'Bancos válidos de la carpeta de presets, con el mismo tope que el panel de bancos ' +
      '(`MAX_REFERENCE_SCAN` archivos).',
    example: 2,
  })
  count!: number;

  @ApiProperty({
    description: 'Nombres de esos bancos, en el mismo orden que el panel.',
    type: [String],
    example: ['Rhodes.fxb', 'Strings.fxb'],
  })
  names!: string[];
}

/** Entrada del escaneo: el plugin más su resumen de bancos. */
export class LibraryScanPluginDto extends PluginEntryDto {
  @ApiProperty({
    description:
      'Bancos del plugin en `plugs\\<plugin>\\<programDirName>\\`. Si la carpeta o el ' +
      '`programDirName` no son utilizables, queda a cero y el motivo aparece en `warnings`.',
    type: () => PluginBanksSummaryDto,
  })
  banks!: PluginBanksSummaryDto;
}

export class LibraryScanResponseDto {
  @ApiProperty({ description: 'Raíz resuelta.', example: LIBRARY_ROOT })
  libraryRoot!: string;

  @ApiProperty({ description: 'Carpeta `plugs\\` que se ha enumerado.', example: PLUGS_PATH })
  plugsPath!: string;

  @ApiProperty({
    description:
      'Validación del cargador que se copiaría al plugin; si no es PE32 i386, los plugins quedan incompatibles.',
    type: () => LoaderDllDto,
  })
  loader!: LoaderDllDto;

  @ApiProperty({
    description: 'Solo directorios, ordenados por nombre.',
    type: () => LibraryScanPluginDto,
    isArray: true,
  })
  plugins!: LibraryScanPluginDto[];
}

export class LibraryLoaderAddRequestDto {
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
    description: 'Volver a poner el cargador aunque `fxbLoader.config` ya exista (409 sin esto).',
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
    enum: ['add', 'remove'],
    example: 'add',
  })
  action!: 'add' | 'remove';

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
    description:
      'DLL que se copia con el cargador; como en `POST /library/loader/add`, si se omite se usa el del repositorio.',
    example: REPO_DLL,
  })
  dllSourcePath?: string;

  @ApiPropertyOptional({
    description:
      'Volver a poner el cargador en los que ya tengan `fxbLoader.config`; sin esto, cada uno falla con 409.',
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

export class LibraryLoaderRemoveRequestDto {
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
      '`added`/`removed` si se aplicó, `planned` si solo se calculó el plan con ' +
      '`dryRun`, `failed` si ese plugin no se pudo operar.',
    enum: ['added', 'removed', 'planned', 'failed'],
    example: 'added',
  })
  status!: 'added' | 'removed' | 'planned' | 'failed';

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
  @ApiProperty({ enum: ['add', 'remove'], example: 'add' })
  action!: 'add' | 'remove';

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

/** Papelera a la que se envió el respaldo y cómo recuperarlo. */
export class TrashInfoDto {
  @ApiProperty({
    description:
      'Nombre de la papelera del sistema: la de reciclaje en Windows, la del escritorio en ' +
      'Linux y macOS.',
    example: 'Papelera de reciclaje de Windows',
  })
  label!: string;

  @ApiProperty({
    description:
      'Carpeta donde quedó el archivo, o `null` si el sistema no expone una ruta (Windows).',
    type: String,
    nullable: true,
    example: null,
  })
  path!: string | null;

  @ApiProperty({
    description: 'Qué hacer para recuperar el archivo desde la papelera.',
    example:
      'Abre la Papelera de reciclaje de Windows y pulsa «Restaurar» para devolverlo a su ' +
      'carpeta.',
  })
  hint!: string;
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

export class LibraryBankDiscardBackupRequestDto {
  @ApiProperty({ description: 'Raíz absoluta de la librería.', example: LIBRARY_ROOT })
  libraryRoot!: string;

  @ApiProperty({ description: 'Nombre de la carpeta del plugin dentro de `plugs\\`.', example: 'MySynth' })
  plugin!: string;
}

export class LibraryBankDiscardBackupResponseDto {
  @ApiProperty({ type: () => PluginEntryDto })
  plugin!: PluginEntryDto;

  @ApiProperty({ example: PRESETS_DIR })
  presetsDir!: string;

  @ApiProperty({
    description:
      'Banco por defecto tomado de `fxbLoader.config` (`defaultFxbName`). No se modifica: ' +
      'solo se borra su respaldo.',
    example: 'Warm Rhodes.fxb',
  })
  fileName!: string;

  @ApiProperty({
    description:
      'Respaldo `<banco>.orig` que se envió a la papelera: nombre, ruta original, tamaño y ' +
      'SHA-256 que tenía. Ya no está en la carpeta del plugin, pero sigue recuperable desde ' +
      'la papelera.',
    type: () => BankBackupFileDto,
  })
  discarded!: BankBackupFileDto;

  @ApiProperty({
    description: 'Papelera donde quedó el respaldo y cómo recuperarlo.',
    type: () => TrashInfoDto,
  })
  trash!: TrashInfoDto;
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
    example: 'MySynth ya tiene el cargador (usa force para volver a ponerlo)',
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

export const LIBRARY_LOADER_ADD_CONFLICT_EXAMPLE = {
  message: 'MySynth ya tiene el cargador (usa force para volver a ponerlo)',
};

export const LIBRARY_LOADER_REMOVE_CONFLICT_EXAMPLE = {
  message: 'MySynth no tiene el cargador',
};

export const LIBRARY_BATCH_ACTION_ERROR_EXAMPLE = {
  message: 'action debe ser "add" o "remove"',
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
  plugin: LIBRARY_PLUGIN_WITH_LOADER_EXAMPLE,
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

/** Cuerpo de `POST /library/banks/create`: crea un banco .fxb desde cero. */
export class LibraryBanksCreateRequestDto {
  @ApiProperty({ description: 'Raíz absoluta de la librería.', example: LIBRARY_ROOT })
  libraryRoot!: string;

  @ApiProperty({ description: 'Nombre de la carpeta del plugin dentro de `plugs\\`.', example: 'MySynth' })
  plugin!: string;

  @ApiPropertyOptional({
    description: 'Nombre del archivo, con o sin `.fxb`. Por defecto `<plugin>.fxb`.',
    example: 'Init Bank.fxb',
  })
  bankName?: string;

  @ApiPropertyOptional({
    description:
      'Nombres de programa, en orden; cada uno genera un `FxCk` con `numParams` ' +
      'parámetros a cero. Un nombre vacío se sustituye por `Program <n>`.',
    type: [String],
    example: ['Init', 'Bright Rhodes', 'Dark Rhodes'],
  })
  programNames?: string[];

  @ApiPropertyOptional({
    description: 'Parámetros por programa; por defecto 0 (solo el nombre).',
    example: 12,
  })
  numParams?: number;

  @ApiPropertyOptional({
    description: 'Reemplazar el archivo si ya existe. Por defecto `false`.',
    example: false,
  })
  overwrite?: boolean;

  @ApiPropertyOptional({
    description: '`fxVersion` declarada por el banco; por defecto 0.',
    example: 1000,
  })
  fxVersion?: number;

  @ApiPropertyOptional({
    description:
      'Orden de bytes del archivo: `little` es lo que escribe un plugin de Windows ' +
      '(por defecto) y `big` el estándar de Steinberg. Aplica a los dos modos.',
    enum: ['big', 'little'],
    example: 'little',
  })
  endianness?: 'big' | 'little';

  @ApiPropertyOptional({
    description:
      'Modo de creación: `programNames` (por defecto) genera un banco `FxBk` con programas; ' +
      '`chunk` genera un banco `FBCh` con el contenido opaco del plugin. Obliga a ' +
      '`chunkHex` si se fija en `chunk`.',
    enum: ['programNames', 'chunk'],
    example: 'programNames',
  })
  mode?: 'programNames' | 'chunk';

  @ApiPropertyOptional({
    description:
      'Solo en modo `chunk`: contenido opaco del chunk del plugin en hexadecimal, sin ' +
      '`0x`. Crea un banco `CcnK/FBCh` con esos bytes íntegros tal cual los devuelve ' +
      '`getChunk`.',
    example: 'beef cafe',
  })
  chunkHex?: string;

  @ApiPropertyOptional({
    description: 'Solo en modo `chunk`: versión del formato del banco, 1 o 2. Por defecto 1.',
    example: 2,
  })
  chunkVersion?: 1 | 2;

  @ApiPropertyOptional({
    description:
      'Solo en modo `chunk` con `chunkVersion: 2`: programa activo del banco. ' +
      'Por defecto 0.',
    example: 0,
  })
  currentProgram?: number;

  @ApiPropertyOptional({
    description:
      'Solo en modo `chunk`: número de programas informativo que declara la ' +
      'cabecera del banco FBCh. Por defecto 0.',
    example: 0,
  })
  chunkNumPrograms?: number;
}

export class LibraryBanksCreateResponseDto {
  @ApiProperty({ description: 'Estado del plugin tras la creación.', type: () => PluginEntryDto })
  plugin!: PluginEntryDto;

  @ApiProperty({
    description: 'Carpeta de destino: `<plugin>\\<programDirName>\\`.',
    example: PRESETS_DIR,
  })
  presetsDir!: string;

  @ApiProperty({
    description: 'Ruta absoluta del `.fxb` creado.',
    example: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Init Bank.fxb',
  })
  target!: string;

  @ApiProperty({
    description: '`created` si el archivo no existía, `overwritten` si se reemplazó.',
    enum: ['created', 'overwritten'],
    example: 'created',
  })
  status!: 'created' | 'overwritten';

  @ApiProperty({
    description: 'FourCC del plugin objetivo, del `id` de `vfxinfo.txt`.',
    example: 'MySy',
  })
  fourCc!: string;

  @ApiProperty({
    description: 'Cabecera del banco ya revalidada tras la escritura.',
    type: () => BankInfoDto,
  })
  bank!: BankInfoDto;
}

export const LIBRARY_BANK_CREATE_EXAMPLE = {
  plugin: LIBRARY_PLUGIN_WITH_LOADER_EXAMPLE,
  presetsDir: PRESETS_DIR,
  target: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Init Bank.fxb',
  status: 'created',
  fourCc: 'MySy',
  bank: {
    ...LIBRARY_BANK_EXAMPLE,
    numPrograms: 3,
    fxVersion: 0,
  },
};

/** Sin línea `id` en `vfxinfo.txt` no hay FourCC que usar. */
export const LIBRARY_BANK_CREATE_NO_ID_ERROR_EXAMPLE = {
  message: 'el `vfxinfo.txt` del plugin no tiene línea `id` con el FourCC',
};

/** Vista de bancos: lista el contenido y el estado de la configuración. */
export const LIBRARY_BANKS_LIST_EXAMPLE = {
  plugin: LIBRARY_PLUGIN_WITH_LOADER_EXAMPLE,
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
  plugin: LIBRARY_PLUGIN_WITH_LOADER_EXAMPLE,
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
  plugin: LIBRARY_PLUGIN_WITH_LOADER_EXAMPLE,
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
  plugin: LIBRARY_PLUGIN_WITH_LOADER_EXAMPLE,
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

/** Respaldo en la papelera: el banco sigue en su sitio y el `.orig` es recuperable. */
export const LIBRARY_DISCARD_BACKUP_EXAMPLE = {
  plugin: LIBRARY_PLUGIN_WITH_LOADER_EXAMPLE,
  presetsDir: PRESETS_DIR,
  fileName: 'Warm Rhodes.fxb',
  discarded: {
    fileName: 'Warm Rhodes.fxb.orig',
    path: 'C:\\VFX\\Library\\plugs\\MySynth\\presets\\Warm Rhodes.fxb.orig',
    size: 216,
    sha256: LIBRARY_INSPECT_SHA256,
  },
  trash: {
    label: 'Papelera de reciclaje de Windows',
    path: null,
    hint:
      'Abre la Papelera de reciclaje de Windows y pulsa «Restaurar» para devolverlo a su ' +
      'carpeta.',
  },
};

export const LIBRARY_DISCARD_NO_BACKUP_EXAMPLE = {
  message:
    'no hay respaldo Warm Rhodes.fxb.orig en la carpeta del plugin; no queda nada que ' +
    'descartar',
};

export const LIBRARY_DISCARD_TRASH_ERROR_EXAMPLE = {
  message:
    'no se pudo enviar Warm Rhodes.fxb.orig a la papelera: la Papelera de reciclaje ' +
    'terminó con 1',
};

export const LIBRARY_EXPORT_TARGET_EXISTS_EXAMPLE = {
  message:
    'ya existe C:\\VFX\\Library\\plugs\\MySynth\\presets\\Legacy-le.fxb; marca overwrite ' +
    'para reemplazarlo',
};

/** Cuerpo de `POST /library/plugin-dll-preference`. */
export class LibraryDllPreferenceRequestDto {
  @ApiProperty({
    description: 'Carpeta absoluta del plugin.',
    example: 'C:\\VFX\\Library\\plugs\\MySynth',
  })
  pluginDir!: string;

  @ApiProperty({
    description:
      'Valor nuevo de `dll_name`: ruta relativa al plugin de la DLL a usar, siempre ' +
      'dentro de la carpeta del plugin.',
    example: 'Synth64.dll',
  })
  dllName!: string;
}

/** Resultado de `POST /library/plugin-dll-preference`. */
export class LibraryDllPreferenceResponseDto {
  @ApiProperty({ example: 'C:\\VFX\\Library\\plugs\\MySynth' })
  pluginDir!: string;

  @ApiProperty({
    description: 'Valor de `dll_name` antes de guardar; `null` si ya apuntaba al cargador.',
    type: String,
    nullable: true,
    example: 'MySynth/fxbLoader.dll',
  })
  previousDllName!: string | null;

  @ApiProperty({ example: 'Synth64.dll' })
  dllName!: string;

  @ApiProperty({
    description: 'Respaldo `vfxinfo.tx_` creado en esta operación, si procede.',
    type: String,
    nullable: true,
    example: 'C:\\VFX\\Library\\plugs\\MySynth\\vfxinfo.tx_',
  })
  backupFile!: string | null;

  @ApiProperty({
    description: '`false` si el `dll_name` ya era el pedido y no se escribió nada.',
    example: true,
  })
  changed!: boolean;

  @ApiProperty({ type: () => [LibraryActionDto], example: [] })
  actions!: LibraryActionDto[];
}

export const LIBRARY_DLL_PREFERENCE_EXAMPLE = {
  pluginDir: 'C:\\VFX\\Library\\plugs\\MySynth',
  previousDllName: 'MySynth/fxbLoader.dll',
  dllName: 'Synth64.dll',
  backupFile: null,
  changed: true,
  actions: [
    {
      kind: 'backup',
      path: 'C:\\VFX\\Library\\plugs\\MySynth\\vfxinfo.tx_',
      detail: 'vfxinfo.tx_ ya existe; se conserva',
    },
    {
      kind: 'patch',
      path: 'C:\\VFX\\Library\\plugs\\MySynth\\vfxinfo.txt',
      detail: 'dll_name: Synth64.dll',
    },
  ],
};

export const LIBRARY_DLL_PREFERENCE_ERROR_EXAMPLE = {
  message: 'dllName apunta fuera del plugin: "..\\otro.dll"',
};

/** Petición para inspeccionar una DLL suelta y validar exportaciones VST. */
export class LibraryInspectDllDto {
  @ApiProperty({
    description: 'Ruta absoluta al archivo DLL a analizar.',
    example: 'C:\\Vst\\Synth.dll',
  })
  dllPath!: string;
}

/** Resumen de wizard coincidente para DLL inspeccionada. */
export class LibraryInspectDllMatchingWizardDto {
  @ApiProperty({ example: '1398231096' })
  id!: string;

  @ApiProperty({ example: 'SuperWave P8' })
  name!: string;

  @ApiProperty({ example: 'Superwave' })
  vendor!: string;

  @ApiProperty({ example: 'Synth' })
  genre!: string;

  @ApiProperty({ example: 'SuperWave P8/P8.dll' })
  dllName!: string;

  @ApiProperty({ example: true })
  isSynth!: boolean;
}

/** Resultado de la inspección técnica de un binario DLL. */
export class LibraryInspectDllResponseDto {
  @ApiProperty({ description: 'Indica si es un ejecutable PE válido.', example: true })
  validPe!: boolean;

  @ApiProperty({ description: 'Arquitectura en bits (32 o 64).', nullable: true, type: Number, example: 32 })
  bitness!: number | null;

  @ApiProperty({ description: 'Compatible con hardware VFX Machine (PE32 de 32 bits).', example: true })
  is32BitCompatible!: boolean;

  @ApiProperty({ description: 'Indica si exporta puntos de entrada VST (VSTPluginMain o main).', example: true })
  isVstPlugin!: boolean;

  @ApiProperty({
    description: 'Punto de entrada VST detectado en la tabla de exportación.',
    nullable: true,
    type: String,
    example: 'VSTPluginMain',
  })
  vstEntrypoint!: string | null;

  @ApiProperty({
    description: 'Nombre interno de la DLL declarado en su tabla de exportación.',
    nullable: true,
    type: String,
    example: 'Synth.dll',
  })
  internalDllName!: string | null;

  @ApiProperty({ description: 'Nombre recomendado para el instrumento.', example: 'Synth' })
  suggestedName!: string;

  @ApiProperty({ description: 'ID VST numérico sugerido.', example: '1398231096' })
  suggestedId!: string;

  @ApiProperty({
    description: 'Lista de funciones exportadas detectadas en la cabecera PE.',
    example: ['VSTPluginMain'],
    type: [String],
  })
  exportedNames!: string[];

  @ApiProperty({
    description: 'Problemas o avisos de compatibilidad detectados.',
    example: [],
    type: [String],
  })
  issues!: string[];

  @ApiProperty({
    description: 'Wizard oficial coincidente en el catálogo si existe.',
    nullable: true,
    type: () => LibraryInspectDllMatchingWizardDto,
  })
  matchingWizard!: LibraryInspectDllMatchingWizardDto | null;
}

export const LIBRARY_INSPECT_DLL_EXAMPLE: LibraryInspectDllDto = {
  dllPath: 'C:\\Vst\\Synth.dll',
};

export const LIBRARY_INSPECT_DLL_RESPONSE_EXAMPLE: LibraryInspectDllResponseDto = {
  validPe: true,
  bitness: 32,
  is32BitCompatible: true,
  isVstPlugin: true,
  vstEntrypoint: 'VSTPluginMain',
  internalDllName: 'Synth.dll',
  suggestedName: 'Synth',
  suggestedId: '1398231096',
  exportedNames: ['VSTPluginMain'],
  issues: [],
  matchingWizard: null,
};

/** Petición para dar de alta un plugin personalizado desde un DLL sin wizard previo. */
export class LibraryCreateCustomPluginDto {
  @ApiProperty({
    description: 'Ruta absoluta a la librería VFX activa.',
    example: 'C:\\VFX\\Library',
  })
  libraryRoot!: string;

  @ApiProperty({
    description: 'Ruta absoluta al archivo DLL de origen.',
    example: 'C:\\Vst\\NewSynth.dll',
  })
  sourceDllPath!: string;

  @ApiProperty({
    description: 'Nombre de la carpeta del plugin bajo plugs/.',
    example: 'NewSynth',
  })
  folderName!: string;

  @ApiProperty({
    description: 'Nombre visible del instrumento o efecto.',
    example: 'New Synth Pro',
  })
  name!: string;

  @ApiProperty({
    description: 'ID VST numérico o FourCC de 4 caracteres.',
    example: '12345678',
  })
  id!: string;

  @ApiProperty({
    description: '`true` si es un sintetizador/generador; `false` si es un efecto de audio.',
    example: true,
  })
  isSynth!: boolean;

  @ApiProperty({
    description: 'Número de parámetros VST (por defecto 16).',
    required: false,
    example: 16,
  })
  parameterCount?: number;

  @ApiProperty({
    description: 'Número de programas / patches VST (por defecto 16).',
    required: false,
    example: 16,
  })
  programCount?: number;

  @ApiProperty({
    description: 'Indica si el plugin dispone de editor gráfico (GUI).',
    required: false,
    example: true,
  })
  hasEditor?: boolean;

  @ApiProperty({
    description: 'Ancho de la ventana de GUI en píxeles.',
    required: false,
    example: 800,
  })
  editorWidth?: number;

  @ApiProperty({
    description: 'Alto de la ventana de GUI en píxeles.',
    required: false,
    example: 600,
  })
  editorHeight?: number;

  @ApiProperty({
    description: 'Fabricante o autor del plugin.',
    required: false,
    example: 'Custom Audio',
  })
  vendor?: string;

  @ApiProperty({
    description: 'Género musical o categoría (ej. Synth, Filter, Reverb).',
    required: false,
    example: 'Synth',
  })
  genre?: string;

  @ApiProperty({
    description: 'Guarda además un archivo .vfxwizard en el catálogo local para reutilizarlo.',
    required: false,
    example: false,
  })
  saveAsWizard?: boolean;

  @ApiProperty({
    description: 'Sobrescribe si la carpeta ya existe.',
    required: false,
    example: false,
  })
  overwrite?: boolean;
}

/** Resultado del alta y creación del plugin personalizado. */
export class LibraryCreateCustomPluginResponseDto {
  @ApiProperty({ description: 'Indica si la creación se completó con éxito.', example: true })
  created!: boolean;

  @ApiProperty({
    description: 'Ruta absoluta al directorio del plugin instalado.',
    example: 'C:\\VFX\\Library\\plugs\\NewSynth',
  })
  pluginDir!: string;

  @ApiProperty({
    description: 'Ruta relativa de la DLL dentro del plugin.',
    example: 'NewSynth/NewSynth.dll',
  })
  dllRelativePath!: string;

  @ApiProperty({
    description: 'Ruta al archivo vfxinfo.txt generado.',
    example: 'C:\\VFX\\Library\\plugs\\NewSynth\\vfxinfo.txt',
  })
  vfxinfoPath!: string;

  @ApiProperty({
    description: 'Ruta al archivo fxbLoader.meta.json generado.',
    example: 'C:\\VFX\\Library\\plugs\\NewSynth\\fxbLoader.meta.json',
  })
  metaPath!: string;

  @ApiProperty({
    description: 'Ruta al wizard guardado en disco si saveAsWizard fue true.',
    nullable: true,
    type: String,
    example: null,
  })
  wizardPath!: string | null;

  @ApiProperty({
    description: 'Avisos o advertencias generadas durante la inspección.',
    example: [],
    type: [String],
  })
  warnings!: string[];
}

export const LIBRARY_CREATE_CUSTOM_PLUGIN_EXAMPLE: LibraryCreateCustomPluginDto = {
  libraryRoot: 'C:\\VFX\\Library',
  sourceDllPath: 'C:\\Vst\\NewSynth.dll',
  folderName: 'NewSynth',
  name: 'New Synth Pro',
  id: '12345678',
  isSynth: true,
  parameterCount: 32,
  programCount: 16,
  hasEditor: true,
  editorWidth: 800,
  editorHeight: 600,
  vendor: 'Custom Audio',
  genre: 'Synth',
  saveAsWizard: false,
  overwrite: false,
};

export const LIBRARY_CREATE_CUSTOM_PLUGIN_RESPONSE_EXAMPLE: LibraryCreateCustomPluginResponseDto = {
  created: true,
  pluginDir: 'C:\\VFX\\Library\\plugs\\NewSynth',
  dllRelativePath: 'NewSynth/NewSynth.dll',
  vfxinfoPath: 'C:\\VFX\\Library\\plugs\\NewSynth\\vfxinfo.txt',
  metaPath: 'C:\\VFX\\Library\\plugs\\NewSynth\\fxbLoader.meta.json',
  wizardPath: null,
  warnings: [],
};

