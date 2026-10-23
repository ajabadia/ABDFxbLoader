import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import * as path from 'node:path';
import {
  SYSTEM_PATHS_EMPTY_EXAMPLE,
  SYSTEM_PATHS_ERROR_EXAMPLE,
  SYSTEM_PATHS_LIMIT,
  SYSTEM_PATHS_MIXED_EXAMPLE,
  SystemPathsErrorDto,
  SystemPathsRequestDto,
  SystemPathsResponseDto,
} from './paths.dto';
import { PathsService } from './paths.service';

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('El cuerpo debe ser un objeto JSON');
  }
  return body as Record<string, unknown>;
}

/**
 * Valida la lista antes de tocar el disco: cada entrada tiene que ser una ruta
 * absoluta. Una lista vacía es válida (la vista no tenía historial) y devuelve
 * `results: []`.
 */
export function readPaths(body: unknown): string[] {
  const value = asRecord(body)['paths'];
  if (!Array.isArray(value)) {
    throw new BadRequestException('paths debe ser una lista de cadenas');
  }
  if (value.length > SYSTEM_PATHS_LIMIT) {
    throw new BadRequestException(`paths admite como máximo ${SYSTEM_PATHS_LIMIT} rutas`);
  }

  return value.map((entry) => {
    if (typeof entry !== 'string') {
      throw new BadRequestException('paths debe ser una lista de cadenas');
    }
    const target = entry.trim();
    // `path.isAbsolute` mira al sistema que ejecuta, y la app es de Windows: en
    // Linux esa comprobación rechazaría `C:\VFX\Library`, que sí es absoluta
    // para quien la escribió. Se acepta cualquiera de las dos formas.
    if (!path.isAbsolute(target) && !path.win32.isAbsolute(target)) {
      throw new BadRequestException(
        `paths debe contener rutas absolutas: ${JSON.stringify(entry)}`,
      );
    }
    return target;
  });
}

@ApiTags('system')
@ApiExtraModels(SystemPathsErrorDto)
@Controller('system')
export class SystemPathsController {
  constructor(private readonly pathsService: PathsService) {}

  @Post('paths')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Comprueba si las rutas recordadas siguen en el disco',
    description:
      'La vista guarda las últimas carpetas y archivos usados en `localStorage`, y ' +
      'pide aquí cuáles siguen existiendo para no ofrecer sugerencias caducadas. ' +
      'Una ruta que falta **no es un error**: llega con `exists: false` y la vista ' +
      'la descarta de su historial.',
  })
  @ApiBody({
    type: SystemPathsRequestDto,
    examples: {
      mezcla: {
        summary: 'Carpeta, DLL y un banco borrado',
        value: { paths: SYSTEM_PATHS_MIXED_EXAMPLE.results.map((result) => result.path) },
      },
      vacia: { summary: 'Sin historial', value: { paths: [] } },
    },
  })
  @ApiOkResponse({
    description: 'Un resultado por ruta pedida, en el mismo orden.',
    type: SystemPathsResponseDto,
    examples: {
      mezcla: { summary: 'Dos rutas vivas y una borrada', value: SYSTEM_PATHS_MIXED_EXAMPLE },
      vacia: { summary: 'Nada que comprobar', value: SYSTEM_PATHS_EMPTY_EXAMPLE },
    },
  })
  @ApiBadRequestResponse({
    description:
      '`paths` no es una lista de cadenas, supera las ' +
      `${SYSTEM_PATHS_LIMIT} entradas o trae una ruta relativa.`,
    type: SystemPathsErrorDto,
    examples: {
      relativa: { summary: 'Ruta relativa', value: SYSTEM_PATHS_ERROR_EXAMPLE },
      tipo: {
        summary: 'Entrada que no es texto',
        value: { message: 'paths debe ser una lista de cadenas' },
      },
      tope: {
        summary: 'Demasiadas rutas',
        value: { message: `paths admite como máximo ${SYSTEM_PATHS_LIMIT} rutas` },
      },
    },
  })
  async check(@Body() body: unknown): Promise<SystemPathsResponseDto> {
    return { results: await this.pathsService.check(readPaths(body)) };
  }
}
