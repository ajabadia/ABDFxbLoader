import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import * as path from 'node:path';
import { AssociationAuditService } from './association-audit.service';
import {
  ASSOCIATION_AUDIT_BAD_REQUEST_EXAMPLE,
  ASSOCIATION_AUDIT_EMPTY_EXAMPLE,
  ASSOCIATION_AUDIT_LIST_EXAMPLE,
  AssociationAuditPathErrorDto,
  AssociationAuditSnapshotDto,
} from './association-audit.dto';
import type { AssociationAuditFilter, AssociationAuditKind } from './association-audit.types';

const VALID_KINDS: AssociationAuditKind[] = [
  'association-change',
  'import',
  'reimport',
  'collision',
];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${name} debe ser una cadena`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

@ApiTags('library')
@Controller('library')
export class AssociationAuditController {
  constructor(private readonly service: AssociationAuditService) {}

  /** `libraryRoot` obligatorio y absoluto; filtros opcionales validados. */
  private buildLibraryRoot(body: Record<string, unknown>): string {
    const value = typeof body['libraryRoot'] === 'string' ? body['libraryRoot']!.trim() : '';
    if (value === '') {
      throw new BadRequestException('libraryRoot es obligatorio y debe ser una cadena');
    }
    if (value.includes('\0')) {
      throw new BadRequestException('libraryRoot contiene un NUL');
    }
    if (!path.isAbsolute(value)) {
      throw new BadRequestException(
        `libraryRoot debe ser una ruta absoluta: "${value}"`,
      );
    }
    return path.resolve(value);
  }

  private buildFilter(body: Record<string, unknown>): AssociationAuditFilter {
    const kind = optionalString(body['kind'], 'kind');
    if (kind !== undefined && !VALID_KINDS.includes(kind as AssociationAuditKind)) {
      throw new BadRequestException(
        `kind no válido: "${kind}". Válidos: ${VALID_KINDS.join(', ')}`,
      );
    }
    const limitRaw = body['limit'];
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      if (typeof limitRaw !== 'number' || !Number.isInteger(limitRaw) || limitRaw <= 0) {
        throw new BadRequestException('limit debe ser un entero positivo');
      }
      limit = limitRaw;
    }

    return {
      plugin: optionalString(body['plugin'], 'plugin'),
      kind: kind as AssociationAuditKind | undefined,
      from: optionalString(body['from'], 'from'),
      to: optionalString(body['to'], 'to'),
      limit,
    };
  }

  @Post('association-audit/list')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lista eventos de la auditoría durable de asociaciones',
    description:
      'Lee `<libraryRoot>/fxbLoader.audit.jsonl` (apéndice puro, nunca rota) y devuelve ' +
      'los últimos `limit` eventos que pasan los filtros, en orden cronológico. ' +
      'Solo lectura: no existe endpoint de escritura; los servicios internos son los únicos que auditan.',
  })
  @ApiOkResponse({
    description:
      'Snapshot calculado del almacén. Sin almacén, responde 200 con exists: false y lista vacía.',
    type: AssociationAuditSnapshotDto,
    examples: {
      conEventos: {
        summary: 'Almacén con eventos de asociación e importación',
        value: ASSOCIATION_AUDIT_LIST_EXAMPLE,
      },
      sinAlmacen: {
        summary: 'Librería que todavía no audita nada',
        value: ASSOCIATION_AUDIT_EMPTY_EXAMPLE,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'libraryRoot ausente o relativo, filtros inválidos.',
    type: AssociationAuditPathErrorDto,
    example: ASSOCIATION_AUDIT_BAD_REQUEST_EXAMPLE,
  })
  async list(@Body() body: unknown): Promise<AssociationAuditSnapshotDto> {
    const record = asRecord(body);
    const libraryRoot = this.buildLibraryRoot(record);
    return this.service.read(libraryRoot, this.buildFilter(record));
  }

  @Get('association-audit/stream')
  @ApiOperation({
    summary: 'Snapshot completo de la auditoría para el visor',
    description:
      'Mismos datos que el listado sin filtros, aceptados como query: ' +
      'minea `<libraryRoot>/fxbLoader.audit.jsonl` tal cual. Solo lectura.',
  })
  @ApiQuery({
    name: 'libraryRoot',
    description: 'Raíz absoluta de la librería activa.',
    example: 'C:\\vfx\\mylib',
  })
  @ApiQuery({
    name: 'plugin',
    required: false,
    description: 'Filtro por carpeta de plugin.',
    example: 'AnalogSynth',
  })
  @ApiOkResponse({
    description:
      'Snapshot calculado del almacén. Sin almacén, responde 200 con exists: false y lista vacía.',
    type: AssociationAuditSnapshotDto,
    examples: {
      conEventos: {
        summary: 'Almacén con eventos de asociación e importación',
        value: ASSOCIATION_AUDIT_LIST_EXAMPLE,
      },
      sinAlmacen: {
        summary: 'Librería que todavía no audita nada',
        value: ASSOCIATION_AUDIT_EMPTY_EXAMPLE,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'libraryRoot ausente o relativo.',
    type: AssociationAuditPathErrorDto,
    example: ASSOCIATION_AUDIT_BAD_REQUEST_EXAMPLE,
  })
  async stream(@Query() query: Record<string, unknown>): Promise<AssociationAuditSnapshotDto> {
    const libraryRoot = this.buildLibraryRoot(query);
    const filter = this.buildFilter({
      plugin: query['plugin'],
      kind: query['kind'],
      from: query['from'],
      to: query['to'],
      limit: typeof query['limit'] === 'string' ? Number.parseInt(query['limit'] as string, 10) : undefined,
    });
    return this.service.read(libraryRoot, filter);
  }
}
