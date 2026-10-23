import { ApiProperty } from '@nestjs/swagger';

/** Rutas que caben en una petición: las tres listas de la vista, con holgura. */
export const SYSTEM_PATHS_LIMIT = 32;

/** Un banco de la lista ya no está, pero la carpeta y el DLL siguen. */
export const SYSTEM_PATHS_MIXED_EXAMPLE = {
  results: [
    { path: 'C:\\VFX\\Library', exists: true, isDirectory: true },
    { path: 'C:\\fxbLoader\\vst\\fxbLoader.dll', exists: true, isDirectory: false },
    { path: 'C:\\Bancos\\Borrado.fxb', exists: false, isDirectory: false },
  ],
};

/** Nada que comprobar: la vista no tenía historial. */
export const SYSTEM_PATHS_EMPTY_EXAMPLE = { results: [] };

export const SYSTEM_PATHS_ERROR_EXAMPLE = {
  message: 'paths debe ser una lista de rutas absolutas: "plugs"',
};

export class SystemPathsRequestDto {
  @ApiProperty({
    description:
      'Rutas absolutas a comprobar en el disco del servidor, en cualquier orden. ' +
      `Como máximo ${SYSTEM_PATHS_LIMIT}; una lista vacía responde \`results: []\`.`,
    type: [String],
    example: SYSTEM_PATHS_MIXED_EXAMPLE.results.map((result) => result.path),
  })
  paths!: string[];
}

export class SystemPathStateDto {
  @ApiProperty({
    description: 'La ruta tal como se pidió (sin espacios alrededor).',
    example: SYSTEM_PATHS_MIXED_EXAMPLE.results[0]!.path,
  })
  path!: string;

  @ApiProperty({
    description:
      'Si la ruta está en el disco. `false` también cuando no se puede leer ' +
      '(permisos), que para la vista es lo mismo: la sugerencia ya no sirve.',
    example: true,
  })
  exists!: boolean;

  @ApiProperty({
    description:
      'Si lo que hay es una carpeta. Solo tiene sentido con `exists: true`; con ' +
      'una ruta que falta es `false`.',
    example: true,
  })
  isDirectory!: boolean;
}

export class SystemPathsResponseDto {
  @ApiProperty({
    description: 'Un elemento por ruta pedida, en el mismo orden.',
    type: [SystemPathStateDto],
  })
  results!: SystemPathStateDto[];
}

export class SystemPathsErrorDto {
  @ApiProperty({
    description: 'Motivo por el que no se comprobó ninguna ruta.',
    example: SYSTEM_PATHS_ERROR_EXAMPLE.message,
  })
  message!: string;
}
