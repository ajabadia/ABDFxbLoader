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
