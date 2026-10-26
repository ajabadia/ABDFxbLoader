import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AssociationAuditEntry,
  AssociationAuditSnapshot,
} from './association-audit.types';

export const ASSOCIATION_AUDIT_LIST_EXAMPLE = {
  auditPath: 'C:\\vfx\\mylib\\fxbLoader.audit.jsonl',
  exists: true,
  size: 1024,
  total: 3,
  entries: [
    {
      ts: '2026-10-25T09:32:11.482Z',
      kind: 'association-change',
      plugin: 'AnalogSynth',
      libraryRoot: 'C:/vfx/mylib',
      field: 'dll_name',
      previousValue: 'AnalogSynth/AnalogSynth.dll',
      newValue: 'AnalogSynth/fxbLoader.dll',
    },
    {
      ts: '2026-10-25T09:35:02.100Z',
      kind: 'import',
      libraryRoot: 'C:/vfx/mylib',
      packageSource: 'C:/downloads/pack.vfxlibrary',
      repairedBanks: [],
    },
    {
      ts: '2026-10-25T09:35:02.115Z',
      kind: 'collision',
      plugin: 'OtroPlugin',
      libraryRoot: 'C:/vfx/mylib',
      packageSource: 'C:/downloads/pack.vfxlibrary',
      collisionPolicy: 'skip',
      collisionNames: ['OtroPlugin'],
    },
  ],
};

export const ASSOCIATION_AUDIT_EMPTY_EXAMPLE = {
  auditPath: 'C:\\vfx\\mylib\\fxbLoader.audit.jsonl',
  exists: false,
  size: 0,
  total: 0,
  entries: [],
};

export const ASSOCIATION_AUDIT_BAD_REQUEST_EXAMPLE = {
  message: 'libraryRoot debe ser una ruta absoluta: "rel/ativa"',
};

export class AssociationAuditPathErrorDto {
  @ApiProperty({
    description: 'Explicación del problema con la librería.',
    example: 'libraryRoot debe ser una ruta absoluta: "rel/ativa"',
  })
  message!: string;
}

export class AssociationAuditEntryDto {
  @ApiProperty({
    description: 'Marca de tiempo ISO-8601 UTC.',
    example: '2026-10-25T09:32:11.482Z',
  })
  ts!: string;

  @ApiProperty({
    description: "Tipo de evento: 'association-change' | 'import' | 'reimport' | 'collision'.",
    example: 'association-change',
  })
  kind!: string;

  @ApiProperty({
    description: 'Carpeta del plugin; los eventos de import global pueden omitirla.',
    required: false,
    example: 'AnalogSynth',
  })
  plugin?: string;

  @ApiProperty({
    description: 'Raíz canónica de la librería.',
    required: false,
    example: 'C:/vfx/mylib',
  })
  libraryRoot?: string;

  @ApiProperty({
    description: 'Campo asociado (dll_name hoy).',
    required: false,
    example: 'dll_name',
  })
  field?: string;

  @ApiProperty({
    description: 'Valor previo del campo (null para tombstone).',
    required: false,
    type: String,
    example: 'AnalogSynth/AnalogSynth.dll',
    nullable: true,
  })
  previousValue?: string | null;

  @ApiProperty({
    description: 'Valor nuevo del campo (null en desinstalación).',
    required: false,
    type: String,
    example: 'AnalogSynth/fxbLoader.dll',
    nullable: true,
  })
  newValue?: string | null;

  @ApiProperty({
    description: 'Origen del paquete: enlaza las líneas de una misma importación.',
    required: false,
    example: 'C:/downloads/pack.vfxlibrary',
  })
  packageSource?: string;

  @ApiProperty({
    description: "Política de colisión aplicada: 'skip' | 'overwrite'.",
    required: false,
    example: 'skip',
  })
  collisionPolicy?: string;

  @ApiProperty({
    description: 'Nombres de plugins/bancos omitidos por la política.',
    required: false,
    type: [String],
  })
  collisionNames?: string[];

  @ApiProperty({
    description: 'Bancos reparados por la importación.',
    required: false,
    type: [String],
  })
  repairedBanks?: string[];
}

export class AssociationAuditListInputDto {
  @ApiProperty({
    description: 'Raíz absoluta de la librería activa.',
    example: 'C:\\vfx\\mylib',
  })
  libraryRoot!: string;

  @ApiProperty({
    description: 'Filtro por carpeta de plugin.',
    required: false,
    example: 'AnalogSynth',
  })
  plugin?: string;

  @ApiProperty({
    description: "Filtro por tipo de evento.",
    required: false,
    example: 'association-change',
  })
  kind?: string;

  @ApiProperty({
    description: 'Marca de tiempo mínima (ISO-8601, inclusiva).',
    required: false,
    example: '2026-10-25T00:00:00.000Z',
  })
  from?: string;

  @ApiProperty({
    description: 'Marca de tiempo máxima (ISO-8601, inclusiva).',
    required: false,
    example: '2026-10-26T00:00:00.000Z',
  })
  to?: string;

  @ApiProperty({
    description: 'Máximo de eventos devueltos (los últimos que pasan los filtros).',
    required: false,
    example: 200,
  })
  limit?: number;
}

export class AssociationAuditSnapshotDto
  implements Omit<AssociationAuditSnapshot, 'entries'>
{
  @ApiProperty({
    description: 'Ruta absoluta del almacén fxbLoader.audit.jsonl.',
    example: 'C:\\vfx\\mylib\\fxbLoader.audit.jsonl',
  })
  auditPath!: string;

  @ApiProperty({
    description: 'Indica si el almacén ya existe.',
    example: true,
  })
  exists!: boolean;

  @ApiProperty({
    description: 'Tamaño del almacén en bytes.',
    example: 512,
  })
  size!: number;

  @ApiProperty({
    description: 'Total de eventos que pasan los filtros (antes del límite).',
    example: 2,
  })
  total!: number;

  @ApiProperty({
    description: 'Últimos eventos que pasan los filtros, en orden cronológico.',
    type: [AssociationAuditEntryDto],
  })
  entries!: AssociationAuditEntry[];
}

/** Cuerpo de `POST /library/association-audit/list`. */
export class AssociationAuditListRequestDto {
  @ApiProperty({
    description: 'Raíz absoluta de la librería activa.',
    example: 'C:\\vfx\\mylib',
  })
  libraryRoot!: string;

  @ApiPropertyOptional({
    description: 'Filtra por carpeta de plugin.',
    example: 'AnalogSynth',
  })
  plugin?: string;

  @ApiPropertyOptional({
    description: 'Filtra por tipo de evento.',
    enum: ['association-change', 'import', 'reimport', 'collision'],
    example: 'association-change',
  })
  kind?: string;

  @ApiPropertyOptional({
    description: 'Desde esta marca ISO-8601, inclusive.',
    example: '2026-10-25T00:00:00.000Z',
  })
  from?: string;

  @ApiPropertyOptional({
    description: 'Hasta esta marca ISO-8601, inclusive.',
    example: '2026-10-25T23:59:59.999Z',
  })
  to?: string;

  @ApiPropertyOptional({
    type: Number,
    description: 'Máximo de eventos devueltos; 200 si se omite.',
    example: 50,
    minimum: 1,
  })
  limit?: number;
}

export const ASSOCIATION_AUDIT_LIST_REQUEST_EXAMPLE = {
  libraryRoot: 'C:\\vfx\\mylib',
  plugin: 'AnalogSynth',
  kind: 'association-change',
  limit: 50,
};
