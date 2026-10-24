import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Ejemplo reutilizado por las respuestas 200 y por el `current` del 409. */
export const PLUGIN_META_SNAPSHOT_EXAMPLE = {
  metaPath: 'C:\\VFX\\plugs\\MySynth\\fxbLoader.meta.json',
  exists: true,
  mtimeMs: 1760000000000.123,
  size: 214,
  common: {
    id: 'MySy',
    name: 'MySynth',
    vendor: 'ABD Synths',
    vendor_url: 'https://example.invalid/abd',
    genre: 'Synth',
    name_abbreviation: 'MySy',
    notes: 'Rhodes edición 2026',
    created: '2026-01-15',
  },
  extended: {
    category: 'electric-piano',
    tags: { family: 'keys' },
  },
  source: { vfxinfo: false },
  updated: '2026-10-24T09:12:03Z',
};

/** Ejemplo de 409: el `mtimeMs` enviado ya no es el vigente. */
export const PLUGIN_META_CONFLICT_EXAMPLE = {
  message: 'El archivo propio cambió en disco desde la última lectura',
  current: PLUGIN_META_SNAPSHOT_EXAMPLE,
};

/** Ejemplo de 400 por valores que el archivo propio no admite. */
export const PLUGIN_META_VALIDATION_ERROR_EXAMPLE = {
  message: 'Metadatos no válidos',
  issues: ['common.id: no puede estar vacío'],
};

/** Ejemplo de 400 por una ruta que no existe o no es un directorio. */
export const PLUGIN_META_PATH_ERROR_EXAMPLE = {
  message: 'el directorio no existe: C:\\VFX\\plugs\\NoExiste',
};

export class PluginMetaCommonDto {
  @ApiProperty({
    description: 'Identidad del plugin en el catálogo (el `id` de `vfxinfo.txt`).',
    example: 'MySy',
  })
  id!: string;

  @ApiProperty({ description: 'Nombre legible del plugin.', example: 'MySynth' })
  name!: string;

  @ApiProperty({ description: 'Fabricante.', example: 'ABD Synths' })
  vendor!: string;

  @ApiProperty({
    description: 'URL del fabricante, si aparece.',
    example: 'https://example.invalid/abd',
  })
  vendor_url!: string;

  @ApiProperty({ description: 'Género o categoría.', example: 'Synth' })
  genre!: string;

  @ApiProperty({
    description: 'Abreviatura del nombre del plugin.',
    example: 'MySy',
  })
  name_abbreviation!: string;

  @ApiProperty({
    description: 'Notas libres del plugin.',
    example: 'Rhodes edición 2026',
  })
  notes!: string;

  @ApiProperty({
    description: 'Fecha de creación declarada por el plugin (ISO date).',
    example: '2026-01-15',
  })
  created!: string;
}

export class PluginMetaSourceDto {
  @ApiPropertyOptional({
    description:
      '`true` si los campos comunes se leyeron de `vfxinfo.txt` en la última lectura. ' +
      'Este archivo lo escribe la app, así que hoy siempre es `false`.',
    example: false,
  })
  vfxinfo?: boolean;
}

export class PluginMetaSnapshotDto {
  @ApiProperty({
    description: 'Ruta absoluta de `fxbLoader.meta.json`.',
    example: PLUGIN_META_SNAPSHOT_EXAMPLE.metaPath,
  })
  metaPath!: string;

  @ApiProperty({
    description: '`false` si el archivo no existe; entonces `common` va vacío y `mtimeMs` es `null`.',
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

  @ApiProperty({ description: 'Tamaño en bytes.', example: 214 })
  size!: number;

  @ApiProperty({ type: () => PluginMetaCommonDto })
  common!: PluginMetaCommonDto;

  @ApiProperty({
    description:
      'Campos propios del plugin: claves `[A-Za-z][A-Za-z0-9_:-]{0,63}` (máximo 128) y ' +
      'valores escalares u objetos planos, sin arrays.',
    type: 'object',
    additionalProperties: true,
    example: PLUGIN_META_SNAPSHOT_EXAMPLE.extended,
  })
  extended!: Record<string, unknown>;

  @ApiProperty({
    description: 'Origen del catálogo en la última escritura, o `null` si el archivo no lo declara.',
    type: () => PluginMetaSourceDto,
    nullable: true,
    example: PLUGIN_META_SNAPSHOT_EXAMPLE.source,
  })
  source!: PluginMetaSourceDto | null;

  @ApiProperty({
    description:
      'Marca ISO-8601 en UTC de la última escritura hecha por la app, o `null` si el archivo no la trae.',
    type: String,
    nullable: true,
    example: PLUGIN_META_SNAPSHOT_EXAMPLE.updated,
  })
  updated!: string | null;
}

export class PluginMetaCommonPatchDto {
  @ApiPropertyOptional({
    description: 'Omitir un campo conserva el valor que ya haya en disco.',
    example: 'MySy',
  })
  id?: string;

  @ApiPropertyOptional({ example: 'MySynth' })
  name?: string;

  @ApiPropertyOptional({ example: 'ABD Synths' })
  vendor?: string;

  @ApiPropertyOptional({ example: 'https://example.invalid/abd' })
  vendor_url?: string;

  @ApiPropertyOptional({ example: 'Synth' })
  genre?: string;

  @ApiPropertyOptional({ example: 'MySy' })
  name_abbreviation?: string;

  @ApiPropertyOptional({ example: 'Rhodes edición 2026' })
  notes?: string;

  @ApiPropertyOptional({ example: '2026-01-15' })
  created?: string;
}

export class PluginMetaWriteRequestDto {
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

  @ApiPropertyOptional({
    description: 'Solo las claves a cambiar; el resto se conserva de disco.',
    type: () => PluginMetaCommonPatchDto,
    example: { name: 'MySynth 2', vendor: 'ABD Synths' },
  })
  common?: PluginMetaCommonPatchDto;

  @ApiPropertyOptional({
    description:
      'Campos propios a añadir o reemplazar. Un `null` borra la clave; ' +
      'lo que no se envía se conserva de disco.',
    type: 'object',
    additionalProperties: true,
    example: { category: 'electric-piano' },
  })
  extended?: Record<string, unknown>;
}

export class PluginMetaPathErrorDto {
  @ApiProperty({
    description: 'Explicación del problema de ruta.',
    example: PLUGIN_META_PATH_ERROR_EXAMPLE.message,
  })
  message!: string;
}

export class PluginMetaValidationErrorDto {
  @ApiProperty({ example: PLUGIN_META_VALIDATION_ERROR_EXAMPLE.message })
  message!: string;

  @ApiProperty({
    description: 'Reglas incumplidas: tipos, claves desconocidas y límites del formato.',
    type: [String],
    example: PLUGIN_META_VALIDATION_ERROR_EXAMPLE.issues,
  })
  issues!: string[];
}

export class PluginMetaConflictErrorDto {
  @ApiProperty({ example: PLUGIN_META_CONFLICT_EXAMPLE.message })
  message!: string;

  @ApiProperty({
    description: 'Estado vigente en disco, para reintentar con el `mtimeMs` correcto.',
    type: () => PluginMetaSnapshotDto,
  })
  current!: PluginMetaSnapshotDto;
}
