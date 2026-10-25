import { ApiProperty } from '@nestjs/swagger';

export const PLUGIN_LOG_SNAPSHOT_EXAMPLE = {
  logPath: 'C:\\VFX\\plugs\\MySynth\\fxbLoader.log',
  exists: true,
  size: 149,
  totalEntries: 2,
  entries: [
    {
      timestamp: '2026-10-24T08:00:00.000Z',
      action: 'install',
      summary: 'Instalado fxbLoader.dll (MySynth.dll)',
      raw: '[2026-10-24T08:00:00.000Z] [install] Instalado fxbLoader.dll (MySynth.dll)',
    },
    {
      timestamp: '2026-10-24T08:05:00.000Z',
      action: 'import-banks',
      summary: 'Importados 2 de 2 banco(s) .fxb',
      raw: '[2026-10-24T08:05:00.000Z] [import-banks] Importados 2 de 2 banco(s) .fxb',
    },
  ],
  raw: '[2026-10-24T08:00:00.000Z] [install] Instalado fxbLoader.dll (MySynth.dll)\n[2026-10-24T08:05:00.000Z] [import-banks] Importados 2 de 2 banco(s) .fxb\n',
  rotatedFiles: [],
};

/** Un plugin que todavía no escribió nada: ni archivo activo ni rotados. */
export const PLUGIN_LOG_EMPTY_EXAMPLE = {
  logPath: 'C:\\VFX\\plugs\\MySynth\\fxbLoader.log',
  exists: false,
  size: 0,
  totalEntries: 0,
  entries: [],
  raw: '',
  rotatedFiles: [],
};

export const PLUGIN_LOG_BAD_REQUEST_EXAMPLE = {
  message: 'dir es obligatorio y debe ser una cadena',
};

export class PluginLogPathErrorDto {
  @ApiProperty({
    description: 'Explicación del problema con el directorio.',
    example: 'dir es obligatorio y debe ser una cadena',
  })
  message!: string;
}

export class PluginLogEntryDto {
  @ApiProperty({
    description: 'Marca de tiempo en formato ISO-8601.',
    example: '2026-10-24T08:00:00.000Z',
  })
  timestamp!: string;

  @ApiProperty({
    description: 'Acción realizada.',
    example: 'install',
  })
  action!: string;

  @ApiProperty({
    description: 'Resumen legible de la operación.',
    example: 'Instalado fxbLoader.dll',
  })
  summary!: string;

  @ApiProperty({
    description: 'Detalle opcional de la operación.',
    required: false,
    example: 'presets/Piano.fxb',
  })
  detail?: string;

  @ApiProperty({
    description: 'Línea en bruto tal como se escribió en el archivo.',
    example: '[2026-10-24T08:00:00.000Z] [install] Instalado fxbLoader.dll',
  })
  raw!: string;
}

export class PluginLogSnapshotDto {
  @ApiProperty({
    description: 'Ruta absoluta del archivo fxbLoader.log activo.',
    example: 'C:\\VFX\\plugs\\MySynth\\fxbLoader.log',
  })
  logPath!: string;

  @ApiProperty({
    description: 'Indica si existe el archivo activo o algún archivo rotado.',
    example: true,
  })
  exists!: boolean;

  @ApiProperty({
    description: 'Tamaño en bytes del archivo activo.',
    example: 156,
  })
  size!: number;

  @ApiProperty({
    description: 'Total de entradas registradas acumuladas.',
    example: 2,
  })
  totalEntries!: number;

  @ApiProperty({
    description: 'Lista de entradas de log parsedas.',
    type: [PluginLogEntryDto],
  })
  entries!: PluginLogEntryDto[];

  @ApiProperty({
    description: 'Texto concatenado completo del log activo y rotados.',
    example: '[2026-10-24T08:00:00.000Z] [install] Instalado fxbLoader.dll\n',
  })
  raw!: string;

  @ApiProperty({
    description: 'Nombres de archivos rotados existentes (.log.1 ... .log.7).',
    type: [String],
    example: ['fxbLoader.log.1'],
  })
  rotatedFiles!: string[];
}
