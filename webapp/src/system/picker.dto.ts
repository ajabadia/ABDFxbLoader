import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Una carpeta del disco, tal como la devuelve el diálogo. */
export const SYSTEM_PICK_FOLDER_EXAMPLE = { paths: ['C:\\VFX\\Library'] };

/** Un único archivo, como el DLL del cargador. */
export const SYSTEM_PICK_FILE_EXAMPLE = {
  paths: ['C:\\fxbLoader\\vst\\fxbLoader.dll'],
};

/** Varios archivos elegidos de una vez (Ctrl o Mayús en el diálogo). */
export const SYSTEM_PICK_FILES_EXAMPLE = {
  paths: ['C:\\Bancos\\Rhodes.fxb', 'C:\\Bancos\\Strings.fxb'],
};

/** Cancelar no es un error: la lista vuelve vacía. */
export const SYSTEM_PICK_CANCELLED_EXAMPLE = { paths: [] };

export const SYSTEM_PICK_BUSY_EXAMPLE = {
  message: 'Ya hay un diálogo abierto; ciérralo antes de abrir otro',
};

export const SYSTEM_PICK_UNSUPPORTED_EXAMPLE = {
  message: 'El diálogo nativo solo está disponible en Windows',
};

export class SystemPickRequestDto {
  @ApiProperty({
    description:
      'Qué se elige: una carpeta (`folder`), un archivo (`file`) o varios (`files`). ' +
      'Los archivos se eligen en el disco del servidor, que es el de esta máquina.',
    enum: ['folder', 'file', 'files'],
    example: 'folder',
  })
  kind!: 'folder' | 'file' | 'files';

  @ApiPropertyOptional({
    description: 'Título de la ventana del diálogo; como máximo 80 caracteres.',
    example: 'Elige la carpeta de la librería VFX',
  })
  title?: string;

  @ApiPropertyOptional({
    description:
      'Extensiones sin punto para el filtro de los diálogos de archivo ' +
      '(`fxb` muestra `*.fxb`); se ignoran al elegir una carpeta.',
    type: [String],
    example: ['fxb'],
  })
  extensions?: string[];

  @ApiPropertyOptional({
    description:
      'Carpeta donde abrir el diálogo. Si no existe se ignora y se abre en la ' +
      'última que recuerde Windows.',
    example: 'C:\\Bancos',
  })
  initialDir?: string;
}

export class SystemPickResponseDto {
  @ApiProperty({
    description:
      'Rutas absolutas elegidas, en el orden del diálogo. Vacío si se canceló: ' +
      'cancelar no es un error y la vista no cambia nada.',
    type: [String],
    example: SYSTEM_PICK_FOLDER_EXAMPLE.paths,
  })
  paths!: string[];
}

export class SystemPickErrorDto {
  @ApiProperty({
    description: 'Motivo por el que no se abrió el diálogo.',
    example: SYSTEM_PICK_BUSY_EXAMPLE.message,
  })
  message!: string;
}
