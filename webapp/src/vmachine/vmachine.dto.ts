import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const VMACHINE_ERROR_EXAMPLE = {
  message: 'No existe la carpeta del plugin "C:/fxbLoader/storage/vmachine/plugs/Nada".',
  code: 'pluginFolderMissing',
  params: { 0: 'C:/fxbLoader/storage/vmachine/plugs/Nada' },
};

export const VMACHINE_INSTALL_REQUEST_EXAMPLE = {
  drive: 'E:',
  pluginDir: 'C:/fxbLoader/storage/vmachine/plugs/SuperWave P8',
  libraryName: 'V-MACHINE',
};

export const VMACHINE_DRIVES_EXAMPLE = {
  supported: true,
  drives: [
    {
      id: 'E:',
      label: 'V-MACHINE',
      fileSystem: 'FAT32',
      totalBytes: 8004304896,
      freeBytes: 5123481600,
      removable: true,
      libraries: ['V-MACHINE.vfxlibrary'],
    },
  ],
  warnings: [],
};

export const VMACHINE_INSTALL_RESULT_EXAMPLE = {
  drive: 'E:\\',
  libraryDir: 'E:\\V-MACHINE.vfxlibrary',
  pluginDir: 'E:\\V-MACHINE.vfxlibrary\\plugs\\SuperWave P8',
  copied: 12,
  replaced: 0,
  bytes: 48210432,
  verified: 12,
  sizeOnly: [],
  warnings: [],
};

export class VMachineDriveDto {
  @ApiProperty({ description: 'Letra con dos puntos («E:») o punto de montaje.', example: 'E:' })
  id!: string;

  @ApiProperty({ description: 'Etiqueta del volumen; vacía si no tiene.', example: 'V-MACHINE' })
  label!: string;

  @ApiProperty({ description: 'Sistema de archivos del medio.', example: 'FAT32' })
  fileSystem!: string;

  @ApiPropertyOptional({
    type: Number,
    description: 'Capacidad en bytes, o `null` si el sistema no la informa.',
    example: 8004304896,
    nullable: true,
  })
  totalBytes!: number | null;

  @ApiPropertyOptional({
    type: Number,
    description: 'Espacio libre en bytes, o `null` si no se puede consultar.',
    example: 5123481600,
    nullable: true,
  })
  freeBytes!: number | null;

  @ApiProperty({
    description: 'Medio extraíble (`true`) o disco fijo, como un externo por USB.',
    example: true,
  })
  removable!: boolean;

  @ApiProperty({
    description:
      'Bibliotecas `*.vfxlibrary` que ya están en la raíz de la unidad. La máquina solo ' +
      'reconoce las que viven ahí.',
    type: [String],
    example: ['V-MACHINE.vfxlibrary'],
  })
  libraries!: string[];
}

export class VMachineDrivesResponseDto {
  @ApiProperty({
    description: '`false` fuera de Windows: no hay tabla de unidades que enumerar.',
    example: true,
  })
  supported!: boolean;

  @ApiProperty({ description: 'Unidades conectadas, por letra.', type: [VMachineDriveDto] })
  drives!: VMachineDriveDto[];

  @ApiProperty({
    description: 'Unidades que se listaron pero no se pudieron leer, y por qué.',
    type: [String],
    example: [],
  })
  warnings!: string[];
}

export class VMachineInstallRequestDto {
  @ApiProperty({
    description:
      'Raíz del medio, tal como la devuelve `GET /vmachine/drives` («E:», «E:\\»). También ' +
      'admite una carpeta montada, útil para probar sin stick.',
    example: VMACHINE_INSTALL_REQUEST_EXAMPLE.drive,
  })
  drive!: string;

  @ApiProperty({
    description:
      'Carpeta del plugin generada por `/capture/vmachine/:diffId` (`bankDir`). Tiene que ' +
      'contener su `vfxinfo.txt`.',
    example: VMACHINE_INSTALL_REQUEST_EXAMPLE.pluginDir,
  })
  pluginDir!: string;

  @ApiPropertyOptional({
    description:
      'Biblioteca de destino. Si se omite se reusa la única `*.vfxlibrary` de la raíz —el ' +
      'stick que la máquina ya usa— y, si no hay ninguna, se crea `V-MACHINE`.',
    example: VMACHINE_INSTALL_REQUEST_EXAMPLE.libraryName,
  })
  libraryName?: string;
}

export class VMachineInstallResultDto {
  @ApiProperty({ description: 'Raíz del medio donde se copió.', example: 'E:\\' })
  drive!: string;

  @ApiProperty({
    description: 'Carpeta de la biblioteca; la máquina la lee desde la raíz.',
    example: VMACHINE_INSTALL_RESULT_EXAMPLE.libraryDir,
  })
  libraryDir!: string;

  @ApiProperty({
    description: 'Carpeta del plugin dentro de la biblioteca.',
    example: VMACHINE_INSTALL_RESULT_EXAMPLE.pluginDir,
  })
  pluginDir!: string;

  @ApiProperty({ description: 'Archivos copiados.', example: 12 })
  copied!: number;

  @ApiProperty({
    description: 'De los copiados, cuántos reemplazaron una versión anterior del mismo plugin.',
    example: 0,
  })
  replaced!: number;

  @ApiProperty({ description: 'Bytes copiados.', example: 48210432 })
  bytes!: number;

  @ApiProperty({
    description: 'Archivos con SHA-256 comprobado en origen y destino.',
    example: 12,
  })
  verified!: number;

  @ApiProperty({
    description:
      'Archivos de más de 32 MiB comprobados solo por tamaño: hashearlos obligaría a leerlos ' +
      'dos veces más.',
    type: [String],
    example: [],
  })
  sizeOnly!: string[];

  @ApiProperty({
    description: 'Avisos de la copia; vacío cuando todo salió como se esperaba.',
    type: [String],
    example: [],
  })
  warnings!: string[];
}

export class VMachineErrorDto {
  @ApiProperty({
    description: 'Mensaje del servidor, en castellano, para los logs.',
    example: VMACHINE_ERROR_EXAMPLE.message,
  })
  message!: string;

  @ApiPropertyOptional({
    description: 'Código estable que la vista traduce.',
    example: VMACHINE_ERROR_EXAMPLE.code,
  })
  code?: string;

  @ApiPropertyOptional({
    description: 'Valores para `{0}`, `{1}`… del texto traducido.',
    example: VMACHINE_ERROR_EXAMPLE.params,
  })
  params?: Record<string, string | number>;
}

export const VMACHINE_DRIVE_MISSING_EXAMPLE = {
  message: 'La unidad "Z:" no existe o no es una carpeta.',
  code: 'driveNotFound',
  params: { 0: 'Z:' },
};

export const VMACHINE_INVENTORY_EXAMPLE = {
  drive: 'E:\\',
  libraries: [
    {
      name: 'V-MACHINE.vfxlibrary',
      path: 'E:\\V-MACHINE.vfxlibrary',
      plugins: [
        {
          library: 'V-MACHINE.vfxlibrary',
          folder: 'SuperWave P8',
          path: 'E:\\V-MACHINE.vfxlibrary\\plugs\\SuperWave P8',
          hasVfxinfo: true,
          name: 'SuperWave P8',
          id: '1316377392',
          version: '1.2',
          dll: 'SuperWave P8/P8.dll',
          files: 12,
          bytes: 48210432,
          catalog: { id: '1316377392', name: 'SuperWave P8', version: '1.2' },
          status: 'match',
        },
        {
          library: 'V-MACHINE.vfxlibrary',
          folder: 'Old Delay',
          path: 'E:\\V-MACHINE.vfxlibrary\\plugs\\Old Delay',
          hasVfxinfo: true,
          name: 'Old Delay',
          id: '987654321',
          version: '1.0',
          dll: 'Old Delay/OldDelay.dll',
          files: 4,
          bytes: 1048576,
          catalog: { id: '987654321', name: 'Old Delay', version: '1.1' },
          status: 'differs',
        },
        {
          library: 'V-MACHINE.vfxlibrary',
          folder: 'Sin Vfxinfo',
          path: 'E:\\V-MACHINE.vfxlibrary\\plugs\\Sin Vfxinfo',
          hasVfxinfo: false,
          name: null,
          id: null,
          version: null,
          dll: null,
          files: 1,
          bytes: 2048,
          catalog: null,
          status: 'unknown',
        },
      ],
    },
  ],
  plugins: 3,
  warnings: [],
};

export class VMachineCatalogDto {
  @ApiProperty({ description: 'ID VST del wizard que reconoce el plugin.', example: '1316377392' })
  id!: string;

  @ApiProperty({ description: 'Nombre del plugin en el catálogo.', example: 'SuperWave P8' })
  name!: string;

  @ApiProperty({
    description: 'Versión certificada en el catálogo; vacía si el wizard no la declara.',
    example: '1.2',
  })
  version!: string;
}

export class VMachineInventoryPluginDto {
  @ApiProperty({ description: 'Biblioteca a la que pertenece.', example: 'V-MACHINE.vfxlibrary' })
  library!: string;

  @ApiProperty({ description: 'Carpeta dentro de `plugs\\`.', example: 'SuperWave P8' })
  folder!: string;

  @ApiProperty({
    description: 'Ruta absoluta de la carpeta del plugin en el medio.',
    example: 'E:\\V-MACHINE.vfxlibrary\\plugs\\SuperWave P8',
  })
  path!: string;

  @ApiProperty({ description: 'Existe `vfxinfo.txt`: sin él la máquina no reconoce el plugin.' })
  hasVfxinfo!: boolean;

  @ApiPropertyOptional({
    type: String,
    description: '`name` del vfxinfo, o `null` si no lo declara.',
    example: 'SuperWave P8',
    nullable: true,
  })
  name!: string | null;

  @ApiPropertyOptional({
    type: String,
    description: '`id` VST del vfxinfo, la clave con la que el catálogo reconoce el plugin.',
    example: '1316377392',
    nullable: true,
  })
  id!: string | null;

  @ApiPropertyOptional({
    type: String,
    description: '`version` del vfxinfo; puede faltar aunque el plugin funcione.',
    example: '1.2',
    nullable: true,
  })
  version!: string | null;

  @ApiPropertyOptional({
    type: String,
    description: '`dll_name` del vfxinfo, relativo a la carpeta del plugin.',
    example: 'SuperWave P8/P8.dll',
    nullable: true,
  })
  dll!: string | null;

  @ApiProperty({ description: 'Archivos que ocupa el plugin en el medio.', example: 12 })
  files!: number;

  @ApiProperty({ description: 'Bytes que ocupa el plugin en el medio.', example: 48210432 })
  bytes!: number;

  @ApiPropertyOptional({
    description: 'Wizard del catálogo que reconoce al plugin, o `null` si ninguno coincide.',
    type: () => VMachineCatalogDto,
    nullable: true,
  })
  catalog!: VMachineCatalogDto | null;

  @ApiProperty({
    description:
      '`match` si la versión del medio coincide con el catálogo, `differs` si el catálogo ' +
      'tiene otra, y `unknown` si el catálogo no conoce el plugin.',
    enum: ['match', 'differs', 'unknown'],
    example: 'match',
  })
  status!: 'match' | 'differs' | 'unknown';
}

export class VMachineInventoryLibraryDto {
  @ApiProperty({ description: 'Nombre de la carpeta de la biblioteca.', example: 'V-MACHINE.vfxlibrary' })
  name!: string;

  @ApiProperty({
    description: 'Ruta absoluta de la biblioteca en el medio.',
    example: 'E:\\V-MACHINE.vfxlibrary',
  })
  path!: string;

  @ApiProperty({
    description: 'Plugins de `plugs\\`, por nombre de carpeta.',
    type: [VMachineInventoryPluginDto],
  })
  plugins!: VMachineInventoryPluginDto[];
}

export class VMachineInventoryResponseDto {
  @ApiProperty({ description: 'Raíz del medio que se leyó.', example: 'E:\\' })
  drive!: string;

  @ApiProperty({
    description: 'Bibliotecas `*.vfxlibrary` de la raíz, en orden alfabético.',
    type: [VMachineInventoryLibraryDto],
  })
  libraries!: VMachineInventoryLibraryDto[];

  @ApiProperty({ description: 'Total de plugins entre todas las bibliotecas.', example: 3 })
  plugins!: number;

  @ApiProperty({
    description: 'Lo que no se pudo leer del medio, y por qué; vacío si todo salió bien.',
    type: [String],
    example: [],
  })
  warnings!: string[];
}

export const VMACHINE_SYNC_EXAMPLE = {
  drive: 'E:\\',
  library: 'D:\\VFX',
  targetLibrary: 'V-MACHINE.vfxlibrary',
  entries: [
    {
      folder: 'SuperWave P8',
      path: 'D:\\VFX\\plugs\\SuperWave P8',
      name: 'SuperWave P8',
      id: '1316377392',
      version: '1.3',
      files: 12,
      bytes: 48210432,
      stickFolder: 'SuperWave P8',
      stickVersion: '1.2',
      state: 'differs',
    },
    {
      folder: 'Korg M1',
      path: 'D:\\VFX\\plugs\\Korg M1',
      name: 'Korg M1',
      id: '222222222',
      version: '1.0',
      files: 8,
      bytes: 20971520,
      stickFolder: null,
      stickVersion: null,
      state: 'missing',
    },
  ],
  extra: [
    {
      library: 'V-MACHINE.vfxlibrary',
      folder: 'Old Delay',
      name: 'Old Delay',
      version: '1.0',
      bytes: 1048576,
    },
  ],
  missing: 1,
  differs: 1,
  same: 0,
  pendingBytes: 69181952,
  warnings: [],
};

export const VMACHINE_COPY_REQUEST_EXAMPLE = {
  drive: 'E:',
  library: 'D:\\VFX',
  folders: ['SuperWave P8', 'Korg M1'],
  libraryName: 'V-MACHINE',
};

export const VMACHINE_COPY_RESULT_EXAMPLE = {
  drive: 'E:\\',
  libraryDir: 'E:\\V-MACHINE.vfxlibrary',
  results: [
    {
      folder: 'SuperWave P8',
      ok: true,
      copied: 12,
      replaced: 1,
      bytes: 48210432,
      verified: 12,
      sizeOnly: [],
      warnings: [],
    },
    {
      folder: 'Korg M1',
      ok: false,
      copied: 0,
      replaced: 0,
      bytes: 0,
      verified: 0,
      sizeOnly: [],
      warnings: [],
      error: {
        message: 'La copia de M1/M1.dll no llegó íntegra a la unidad.',
        code: 'copyMismatch',
        params: { 0: 'M1/M1.dll' },
      },
    },
  ],
  copied: 12,
  bytes: 48210432,
  verified: 12,
  failed: 1,
  warnings: [],
};

export class VMachineSyncEntryDto {
  @ApiProperty({ description: 'Carpeta del plugin en la librería.', example: 'SuperWave P8' })
  folder!: string;

  @ApiProperty({
    description: 'Ruta absoluta de la carpeta del plugin en la librería.',
    example: 'D:\\VFX\\plugs\\SuperWave P8',
  })
  path!: string;

  @ApiPropertyOptional({
    type: String,
    description: '`name` del vfxinfo de la librería, o `null` si no lo declara.',
    example: 'SuperWave P8',
    nullable: true,
  })
  name!: string | null;

  @ApiPropertyOptional({
    type: String,
    description: '`id` VST del vfxinfo: la clave con la que se empareja con el medio.',
    example: '1316377392',
    nullable: true,
  })
  id!: string | null;

  @ApiPropertyOptional({
    type: String,
    description: 'Versión que declara la librería.',
    example: '1.3',
    nullable: true,
  })
  version!: string | null;

  @ApiProperty({ description: 'Archivos que ocupa en la librería.', example: 12 })
  files!: number;

  @ApiProperty({ description: 'Bytes que ocupa en la librería.', example: 48210432 })
  bytes!: number;

  @ApiPropertyOptional({
    type: String,
    description: 'Carpeta del mismo plugin en el medio, o `null` si no está.',
    example: 'SuperWave P8',
    nullable: true,
  })
  stickFolder!: string | null;

  @ApiPropertyOptional({
    type: String,
    description: 'Versión que declara el vfxinfo del medio, si la declara.',
    example: '1.2',
    nullable: true,
  })
  stickVersion!: string | null;

  @ApiProperty({
    description:
      '`missing` si solo está en la librería, `differs` si el medio tiene otra versión y ' +
      '`same` si coinciden o no hay versión que comparar.',
    enum: ['missing', 'differs', 'same'],
    example: 'differs',
  })
  state!: 'missing' | 'differs' | 'same';
}

export class VMachineSyncExtraDto {
  @ApiProperty({ description: 'Biblioteca del medio que lo contiene.', example: 'V-MACHINE.vfxlibrary' })
  library!: string;

  @ApiProperty({ description: 'Carpeta dentro de `plugs\\` del medio.', example: 'Old Delay' })
  folder!: string;

  @ApiPropertyOptional({
    type: String,
    description: 'Nombre declarado en el medio.',
    example: 'Old Delay',
    nullable: true,
  })
  name!: string | null;

  @ApiPropertyOptional({
    type: String,
    description: 'Versión declarada en el medio.',
    example: '1.0',
    nullable: true,
  })
  version!: string | null;

  @ApiProperty({ description: 'Bytes que ocupa en el medio.', example: 1048576 })
  bytes!: number;
}

export class VMachineSyncResponseDto {
  @ApiProperty({ description: 'Raíz del medio leída.', example: 'E:\\' })
  drive!: string;

  @ApiProperty({ description: 'Raíz de la librería comparada.', example: 'D:\\VFX' })
  library!: string;

  @ApiProperty({
    description:
      'Biblioteca del medio en la que se copiaría: la única que ya está en la raíz o ' +
      '`V-MACHINE.vfxlibrary` si no hay ninguna.',
    example: 'V-MACHINE.vfxlibrary',
  })
  targetLibrary!: string;

  @ApiProperty({
    description: 'Plugins de la librería, por nombre de carpeta, con su comparación.',
    type: [VMachineSyncEntryDto],
  })
  entries!: VMachineSyncEntryDto[];

  @ApiProperty({
    description: 'Plugins que el medio tiene y la librería no. No se tocan.',
    type: [VMachineSyncExtraDto],
  })
  extra!: VMachineSyncExtraDto[];

  @ApiProperty({ description: 'Plugins que solo están en la librería.', example: 1 })
  missing!: number;

  @ApiProperty({ description: 'Plugins que están en los dos con otra versión.', example: 1 })
  differs!: number;

  @ApiProperty({ description: 'Plugins que coinciden o no tienen versión que comparar.', example: 0 })
  same!: number;

  @ApiProperty({
    description: 'Bytes de lo que habría que copiar para igualar el medio.',
    example: 69181952,
  })
  pendingBytes!: number;

  @ApiProperty({
    description: 'Avisos al leer el medio; vacío si todo salió bien.',
    type: [String],
    example: [],
  })
  warnings!: string[];
}

export class VMachineCopyRequestDto {
  @ApiProperty({
    description: 'Raíz del medio («E:», «E:\\») o una carpeta montada.',
    example: VMACHINE_COPY_REQUEST_EXAMPLE.drive,
  })
  drive!: string;

  @ApiProperty({
    description: 'Raíz de la librería del equipo que contiene `plugs\\`.',
    example: VMACHINE_COPY_REQUEST_EXAMPLE.library,
  })
  library!: string;

  @ApiProperty({
    description:
      'Carpetas de `plugs\\` a copiar, tal como las devuelve `GET /vmachine/sync` en `folder`.',
    type: [String],
    example: VMACHINE_COPY_REQUEST_EXAMPLE.folders,
  })
  folders!: string[];

  @ApiPropertyOptional({
    description: 'Biblioteca de destino; si se omite se reusa la única de la raíz.',
    example: VMACHINE_COPY_REQUEST_EXAMPLE.libraryName,
  })
  libraryName?: string;
}

export class VMachineCopyErrorDto {
  @ApiProperty({
    description: 'Mensaje del servidor, en castellano, para los logs.',
    example: VMACHINE_COPY_RESULT_EXAMPLE.results[1]!.error!.message,
  })
  message!: string;

  @ApiPropertyOptional({
    description: 'Código estable que la vista traduce.',
    example: 'copyMismatch',
  })
  code?: string;

  @ApiPropertyOptional({
    description: 'Valores para `{0}`, `{1}`… del texto traducido.',
    example: { 0: 'M1/M1.dll' },
  })
  params?: Record<string, string | number>;
}

export class VMachineCopyOutcomeDto {
  @ApiProperty({ description: 'Carpeta copiada.', example: 'SuperWave P8' })
  folder!: string;

  @ApiProperty({ description: '`false` si este plugin no se copió; el resto sigue.', example: true })
  ok!: boolean;

  @ApiProperty({ description: 'Archivos copiados de este plugin.', example: 12 })
  copied!: number;

  @ApiProperty({ description: 'Archivos que pisaron una versión anterior.', example: 1 })
  replaced!: number;

  @ApiProperty({ description: 'Bytes copiados de este plugin.', example: 48210432 })
  bytes!: number;

  @ApiProperty({ description: 'Archivos con SHA-256 comprobado.', example: 12 })
  verified!: number;

  @ApiProperty({
    description: 'Archivos de más de 32 MiB comprobados solo por tamaño.',
    type: [String],
    example: [],
  })
  sizeOnly!: string[];

  @ApiProperty({ description: 'Avisos de la copia.', type: [String], example: [] })
  warnings!: string[];

  @ApiPropertyOptional({
    description: 'Por qué no se copió este plugin.',
    type: () => VMachineCopyErrorDto,
    nullable: true,
  })
  error?: VMachineCopyErrorDto;
}

export class VMachineCopyResultDto {
  @ApiProperty({ description: 'Raíz del medio donde se copió.', example: 'E:\\' })
  drive!: string;

  @ApiProperty({
    description: 'Biblioteca del medio en la que se copió; vacía si no se copió nada.',
    example: 'E:\\V-MACHINE.vfxlibrary',
  })
  libraryDir!: string;

  @ApiProperty({
    description: 'Resultado por plugin, en el orden pedido.',
    type: [VMachineCopyOutcomeDto],
  })
  results!: VMachineCopyOutcomeDto[];

  @ApiProperty({ description: 'Archivos copiados en total.', example: 12 })
  copied!: number;

  @ApiProperty({ description: 'Bytes copiados en total.', example: 48210432 })
  bytes!: number;

  @ApiProperty({ description: 'Archivos verificados con SHA-256 en total.', example: 12 })
  verified!: number;

  @ApiProperty({ description: 'Plugins que no se copiaron.', example: 1 })
  failed!: number;

  @ApiProperty({ description: 'Avisos del lote.', type: [String], example: [] })
  warnings!: string[];
}
