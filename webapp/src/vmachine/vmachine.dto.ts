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
