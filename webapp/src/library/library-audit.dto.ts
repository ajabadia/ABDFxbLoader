import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  LibraryAuditIssueSeverity,
  LibraryAuditProposalSource,
} from './library-audit.types';

export class LibraryAuditRequestDto {
  @ApiProperty({
    description: 'Ruta absoluta a la librería VFX activa (la que contiene `plugs\\`).',
    example: 'D:\\_banks\\storage',
  })
  libraryRoot!: string;
}

export class LibraryAuditIssueDto {
  @ApiProperty({
    description: 'Campo afectado, con prefijo de origen (`vfxinfo.id`, `meta.vendor`, `dll`…).',
    example: 'meta',
  })
  field!: string;

  @ApiProperty({
    description: '`missing`/`invalid` dejan el plugin incompleto; `note` es informativo.',
    enum: ['missing', 'invalid', 'note'],
    example: 'missing',
  })
  severity!: LibraryAuditIssueSeverity;

  @ApiProperty({
    description: 'Explicación legible del hueco.',
    example: 'no existe fxbLoader.meta.json: el catálogo no tiene fabricante, género ni notas',
  })
  message!: string;
}

export class LibraryAuditProposalDto {
  @ApiProperty({ description: 'Campo que se rellenaría.', example: 'meta.genre' })
  field!: string;

  @ApiProperty({ description: 'Valor propuesto.', example: 'Synth' })
  value!: string;

  @ApiProperty({
    description: 'Origen del valor: `vfxinfo`, `meta`, `dll` o deducido.',
    enum: ['vfxinfo', 'meta', 'dll', 'derived'],
    example: 'derived',
  })
  source!: LibraryAuditProposalSource;

  @ApiPropertyOptional({ description: 'Aclaración sobre cómo se obtuvo el valor.' })
  note?: string;
}

export class LibraryAuditDllDto {
  @ApiProperty({
    description: 'Valor de `dll_name` en `vfxinfo.txt`; `null` si no lo declara.',
    type: String,
    nullable: true,
    example: 'FSynthz-15/15.dll',
  })
  declared!: string | null;

  @ApiProperty({
    description: 'DLL localizado en disco, relativo a `plugs\\`; `null` si no hay ninguno.',
    type: String,
    nullable: true,
    example: 'FSynthz-15/15.dll',
  })
  resolved!: string | null;

  @ApiProperty({
    description: 'Arquitectura del DLL inspeccionado (32/64) o `null` si no se pudo leer.',
    type: Number,
    nullable: true,
    example: 32,
  })
  bitness!: number | null;

  @ApiProperty({
    description: 'Entrypoint VST2 exportado por el DLL, si lo hay.',
    type: String,
    nullable: true,
    example: 'main',
  })
  vstEntrypoint!: string | null;
}

export class LibraryAuditPluginDto {
  @ApiProperty({ description: 'Carpeta del plugin bajo `plugs\\`.', example: 'FSynthz-15' })
  name!: string;

  @ApiProperty({
    description: 'Ruta absoluta de la carpeta del plugin.',
    example: 'D:\\_banks\\storage\\plugs\\FSynthz-15',
  })
  path!: string;

  @ApiProperty({ description: 'El plugin tiene `vfxinfo.txt`.', example: true })
  hasVfxinfo!: boolean;

  @ApiProperty({ description: 'El plugin tiene `fxbLoader.meta.json`.', example: false })
  hasMeta!: boolean;

  @ApiProperty({ description: 'Estado del DLL declarado y localizado.', type: LibraryAuditDllDto })
  dll!: LibraryAuditDllDto;

  @ApiProperty({ description: 'Huecos detectados.', type: [LibraryAuditIssueDto] })
  issues!: LibraryAuditIssueDto[];

  @ApiProperty({ description: 'Valores que se pueden rellenar sin intervención.', type: [LibraryAuditProposalDto] })
  proposals!: LibraryAuditProposalDto[];
}

export class LibraryAuditResultDto {
  @ApiProperty({ description: 'Librería analizada.', example: 'D:\\_banks\\storage' })
  libraryRoot!: string;

  @ApiProperty({ description: 'Carpeta `plugs\\` recorrida.', example: 'D:\\_banks\\storage\\plugs' })
  plugsPath!: string;

  @ApiProperty({ description: 'Momento del análisis (ISO-8601).', example: '2026-10-30T12:00:00.000Z' })
  scannedAt!: string;

  @ApiProperty({ description: 'Plugins encontrados.', example: 19 })
  total!: number;

  @ApiProperty({ description: 'Plugins sin huecos `missing`/`invalid`.', example: 4 })
  complete!: number;

  @ApiProperty({ description: 'Plugins con algún hueco bloqueante.', example: 15 })
  incomplete!: number;

  @ApiProperty({ description: 'Total de huecos detectados.', example: 42 })
  issueCount!: number;

  @ApiProperty({ description: 'Total de valores rellenables automáticamente.', example: 61 })
  proposalCount!: number;

  @ApiProperty({ description: 'Detalle por plugin, ordenado por nombre.', type: [LibraryAuditPluginDto] })
  plugins!: LibraryAuditPluginDto[];
}

export const LIBRARY_AUDIT_REQUEST_EXAMPLE: LibraryAuditRequestDto = {
  libraryRoot: 'D:\\_banks\\storage',
};

export const LIBRARY_AUDIT_EXAMPLE: LibraryAuditResultDto = {
  libraryRoot: 'D:\\_banks\\storage',
  plugsPath: 'D:\\_banks\\storage\\plugs',
  scannedAt: '2026-10-30T12:00:00.000Z',
  total: 2,
  complete: 1,
  incomplete: 1,
  issueCount: 3,
  proposalCount: 4,
  plugins: [
    {
      name: 'FSynthz-15',
      path: 'D:\\_banks\\storage\\plugs\\FSynthz-15',
      hasVfxinfo: true,
      hasMeta: false,
      dll: {
        declared: 'FSynthz-15/15.dll',
        resolved: 'FSynthz-15/15.dll',
        bitness: 32,
        vstEntrypoint: 'main',
      },
      issues: [
        {
          field: 'meta',
          severity: 'missing',
          message: 'no existe fxbLoader.meta.json: el catálogo no tiene fabricante, género ni notas',
        },
        { field: 'meta.vendor', severity: 'missing', message: 'sin fabricante' },
      ],
      proposals: [
        { field: 'meta.id', value: '1177630041', source: 'vfxinfo' },
        { field: 'meta.name', value: '15 - SynthEdit', source: 'vfxinfo' },
        { field: 'meta.genre', value: 'Synth', source: 'derived', note: 'deducido de is_synth' },
        { field: 'meta.name_abbreviation', value: '15', source: 'derived' },
      ],
    },
    {
      name: 'StringSynth',
      path: 'D:\\_banks\\storage\\plugs\\StringSynth',
      hasVfxinfo: true,
      hasMeta: true,
      dll: {
        declared: 'StringSynth/StringSynth.dll',
        resolved: 'StringSynth/StringSynth.dll',
        bitness: 32,
        vstEntrypoint: 'main',
      },
      issues: [],
      proposals: [
        { field: 'meta.id', value: '1398231097', source: 'vfxinfo' },
        { field: 'meta.name', value: 'StringSynth', source: 'vfxinfo' },
      ],
    },
  ],
};
