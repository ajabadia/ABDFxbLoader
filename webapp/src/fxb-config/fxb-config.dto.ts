import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FXB_VALUE_MAX_LENGTH } from './fxb-config.constants';

/** Ejemplo reutilizado por las respuestas 200 y 409 del módulo. */
export const FXB_CONFIG_SNAPSHOT_EXAMPLE = {
  configPath: 'C:\\VFX\\plugs\\MySynth\\fxbLoader.config',
  exists: true,
  mtimeMs: 1760000000000.123,
  size: 96,
  config: {
    pluginName: 'MySynth.dll',
    defaultFxbName: 'Rhodes.fxb',
    programDirName: 'presets',
    loadFxbBank: true,
  },
  warnings: [],
};

export class FxbConfigDto {
  @ApiProperty({
    description: 'Nombre del DLL original del plugin (no una ruta).',
    example: 'MySynth.dll',
  })
  pluginName!: string;

  @ApiProperty({
    description: 'Banco .fxb preseleccionado, sin ruta. Vacío = no cargar ninguno.',
    example: 'Rhodes.fxb',
  })
  defaultFxbName!: string;

  @ApiProperty({
    description: 'Subcarpeta de bancos relativa al directorio del plugin. No puede estar vacía.',
    example: 'presets',
  })
  programDirName!: string;

  @ApiProperty({
    description: 'Activa la carga del banco al abrir el plugin.',
    example: true,
  })
  loadFxbBank!: boolean;
}

export class FxbConfigSnapshotDto {
  @ApiProperty({
    description: 'Ruta absoluta del archivo.',
    example: FXB_CONFIG_SNAPSHOT_EXAMPLE.configPath,
  })
  configPath!: string;

  @ApiProperty({
    description: '`false` si el archivo no existe; entonces se devuelven los valores por defecto.',
    example: true,
  })
  exists!: boolean;

  @ApiProperty({
    description: '`mtimeMs` vigente, o `null` si el archivo no existe. Es el testigo optimista.',
    type: Number,
    nullable: true,
    example: 1760000000000.123,
  })
  mtimeMs!: number | null;

  @ApiProperty({ description: 'Tamaño en bytes.', example: 96 })
  size!: number;

  @ApiProperty({ type: () => FxbConfigDto })
  config!: FxbConfigDto;

  @ApiProperty({
    description: 'Avisos del parser; no impiden la lectura.',
    type: [String],
    example: [],
  })
  warnings!: string[];
}

export class FxbConfigPatchDto {
  @ApiPropertyOptional({
    description: 'Nombre del DLL original. Vacío se acepta para no rechazar configuraciones rotas.',
    example: 'MySynth.dll',
  })
  pluginName?: string;

  @ApiPropertyOptional({ example: 'Rhodes.fxb' })
  defaultFxbName?: string;

  @ApiPropertyOptional({ example: 'presets' })
  programDirName?: string;

  @ApiPropertyOptional({ example: false })
  loadFxbBank?: boolean;
}

export class FxbConfigReadRequestDto {
  @ApiProperty({
    description: 'Directorio absoluto del plugin.',
    example: 'C:\\VFX\\plugs\\MySynth',
  })
  pluginDir!: string;
}

export class FxbConfigWriteRequestDto {
  @ApiProperty({
    description: 'Directorio absoluto del plugin.',
    example: 'C:\\VFX\\plugs\\MySynth',
  })
  pluginDir!: string;

  @ApiProperty({
    description:
      '`mtimeMs` leído por el cliente, o `null` si el archivo no existía. ' +
      'Si ya no coincide con el disco, la escritura se rechaza con 409.',
    type: Number,
    nullable: true,
    example: 1760000000000.123,
  })
  expectedMtimeMs!: number | null;

  @ApiProperty({
    description: 'Solo las claves a cambiar; el resto se conserva de disco.',
    type: () => FxbConfigPatchDto,
    example: { defaultFxbName: 'Rhodes.fxb', loadFxbBank: false },
  })
  config!: FxbConfigPatchDto;
}

export class FxbConfigPathErrorDto {
  @ApiProperty({
    description: 'Explicación del problema de ruta.',
    example: 'pluginDir debe ser una ruta absoluta: "plugs/MySynth"',
  })
  message!: string;
}

export class FxbConfigValidationErrorDto {
  @ApiProperty({ example: 'Configuración no válida' })
  message!: string;

  @ApiProperty({
    description: `Reglas de la especificación; cada valor admite como máximo ${FXB_VALUE_MAX_LENGTH} caracteres.`,
    type: [String],
    example: ['programDirName: no puede estar vacío'],
  })
  issues!: string[];
}

export class FxbConfigConflictErrorDto {
  @ApiProperty({ example: 'El archivo cambió en disco desde la última lectura' })
  message!: string;

  @ApiProperty({
    description: 'Estado vigente en disco, para reintentar con el `mtimeMs` correcto.',
    type: () => FxbConfigSnapshotDto,
  })
  current!: FxbConfigSnapshotDto;
}

/** Ejemplo de 200 para `POST /fxb-config/read` y `PUT /fxb-config`. */
export const FXB_CONFIG_OK_EXAMPLE = FXB_CONFIG_SNAPSHOT_EXAMPLE;

/** Ejemplo de 409 (el `mtimeMs` enviado ya no es el vigente). */
export const FXB_CONFIG_CONFLICT_EXAMPLE = {
  message: 'El archivo cambió en disco desde la última lectura',
  current: FXB_CONFIG_SNAPSHOT_EXAMPLE,
};

/** Ejemplo de 400 por validación de valores. */
export const FXB_CONFIG_VALIDATION_ERROR_EXAMPLE = {
  message: 'Configuración no válida',
  issues: ['programDirName: no puede estar vacío'],
};
