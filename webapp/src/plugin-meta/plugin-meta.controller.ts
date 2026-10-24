import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';

import { PluginMetaService } from './plugin-meta.service';
import {
  PLUGIN_META_CONFLICT_EXAMPLE,
  PLUGIN_META_PATH_ERROR_EXAMPLE,
  PLUGIN_META_SNAPSHOT_EXAMPLE,
  PLUGIN_META_VALIDATION_ERROR_EXAMPLE,
  PluginMetaConflictErrorDto,
  PluginMetaPathErrorDto,
  PluginMetaSnapshotDto,
  PluginMetaValidationErrorDto,
  PluginMetaWriteRequestDto,
} from './plugin-meta.dto';
import type {
  PluginMetaCommon,
  PluginMetaSnapshot,
  PluginMetaValue,
  PluginMetaWriteInput,
} from './plugin-meta.types';
import {
  COMMON_KEYS,
  PluginMetaConflictError,
  PluginMetaInvalidError,
  PluginMetaPathError,
} from './plugin-meta.types';

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('El cuerpo debe ser un objeto JSON');
  }
  return body as Record<string, unknown>;
}

function readWriteInput(body: unknown): PluginMetaWriteInput {
  const record = asRecord(body);

  const pluginDir = record['pluginDir'];
  if (typeof pluginDir !== 'string' || pluginDir.trim() === '') {
    throw new BadRequestException('pluginDir es obligatorio y debe ser una cadena');
  }

  if (!('expectedMtimeMs' in record)) {
    throw new BadRequestException(
      'expectedMtimeMs es obligatorio (usa null si el archivo no existía)',
    );
  }
  const expected = record['expectedMtimeMs'];
  if (expected !== null && typeof expected !== 'number') {
    throw new BadRequestException('expectedMtimeMs debe ser un número o null');
  }

  const common: Record<string, string> = {};
  const rawCommon = record['common'];
  if (rawCommon !== undefined) {
    if (typeof rawCommon !== 'object' || rawCommon === null || Array.isArray(rawCommon)) {
      throw new BadRequestException('common debe ser un objeto');
    }
    for (const [key, value] of Object.entries(rawCommon as Record<string, unknown>)) {
      if (!COMMON_KEYS.has(key as keyof PluginMetaCommon)) {
        throw new BadRequestException(`clave desconocida en common: "${key}"`);
      }
      if (typeof value !== 'string') {
        throw new BadRequestException(`common.${key} debe ser una cadena`);
      }
      common[key] = value;
    }
  }

  const rawExtended = record['extended'];
  if (
    rawExtended !== undefined &&
    (typeof rawExtended !== 'object' || rawExtended === null || Array.isArray(rawExtended))
  ) {
    throw new BadRequestException('extended debe ser un objeto');
  }

  return {
    pluginDir,
    expectedMtimeMs: expected as number | null,
    common,
    extended: (rawExtended ?? {}) as Readonly<Record<string, PluginMetaValue>>,
  };
}

/** Traduce los errores del servicio a códigos HTTP; el resto sube tal cual. */
function mapDomainError(error: unknown): never {
  if (error instanceof PluginMetaInvalidError) {
    throw new BadRequestException({
      message: 'Metadatos no válidos',
      issues: error.issues,
    });
  }
  if (error instanceof PluginMetaConflictError) {
    throw new ConflictException({ message: error.message, current: error.current });
  }
  if (error instanceof PluginMetaPathError) {
    throw new BadRequestException({ message: error.message });
  }
  throw error;
}

@ApiTags('plugin-meta')
@ApiExtraModels(PluginMetaPathErrorDto, PluginMetaValidationErrorDto)
@Controller('plugins')
export class PluginMetaController {
  constructor(private readonly service: PluginMetaService) {}

  @Get(':id/meta')
  @ApiOperation({
    summary: 'Lee fxbLoader.meta.json de un plugin',
    description:
      'Si el archivo no existe devuelve `exists: false` con los campos comunes vacíos, ' +
      'sin crear nada. El directorio se toma de `dir`; `id` solo identifica al plugin en el catálogo.',
  })
  @ApiParam({
    name: 'id',
    description: 'Identificador del plugin en el catálogo. No altera qué archivo se lee.',
    example: 'MySy',
  })
  @ApiQuery({
    name: 'dir',
    description: 'Directorio absoluto del plugin.',
    example: 'C:\\VFX\\plugs\\MySynth',
  })
  @ApiOkResponse({
    description: 'Snapshot del archivo propio y su `mtimeMs` para el control optimista.',
    type: PluginMetaSnapshotDto,
    example: PLUGIN_META_SNAPSHOT_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description:
      '`dir` ausente, relativo, inexistente o que no es un directorio, ' +
      'o un archivo propio que no cumple el formato.',
    schema: {
      anyOf: [
        { $ref: getSchemaPath(PluginMetaPathErrorDto) },
        { $ref: getSchemaPath(PluginMetaValidationErrorDto) },
      ],
    },
    examples: {
      falta: {
        summary: 'Sin el parámetro `dir`',
        value: { message: 'dir es obligatorio y debe ser una cadena' },
      },
      rutaInvalida: {
        summary: 'Ruta inexistente',
        value: PLUGIN_META_PATH_ERROR_EXAMPLE,
      },
      archivoInvalido: {
        summary: 'El archivo existe pero no cumple el formato',
        value: { message: 'Metadatos no válidos', issues: ['el archivo propio no es JSON válido'] },
      },
    },
  })
  async readMeta(
    @Param('id') _id: string,
    @Query('dir') dir: string | undefined,
  ): Promise<PluginMetaSnapshot> {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new BadRequestException({ message: 'dir es obligatorio y debe ser una cadena' });
    }

    try {
      return await this.service.read(dir);
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post(':id/meta')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Escribe fxbLoader.meta.json de forma atómica',
    description:
      'Fusiona `common` y `extended` con lo que haya en disco y exige que ' +
      '`expectedMtimeMs` siga siendo el vigente. Un `null` en `extended` borra la clave.',
  })
  @ApiParam({
    name: 'id',
    description: 'Identificador del plugin en el catálogo. No altera qué archivo se escribe.',
    example: 'MySy',
  })
  @ApiBody({
    type: PluginMetaWriteRequestDto,
    examples: {
      cambioParcial: {
        summary: 'Cambiar el nombre y añadir una categoría',
        value: {
          pluginDir: 'C:\\VFX\\plugs\\MySynth',
          expectedMtimeMs: 1760000000000.123,
          common: { name: 'MySynth 2', vendor: 'ABD Synths' },
          extended: { category: 'electric-piano' },
        },
      },
      archivoNuevo: {
        summary: 'Crear el archivo desde cero',
        value: {
          pluginDir: 'C:\\VFX\\plugs\\MySynth',
          expectedMtimeMs: null,
          common: { id: 'MySy', name: 'MySynth' },
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Metadatos escritos y snapshot resultante.',
    type: PluginMetaSnapshotDto,
    example: PLUGIN_META_SNAPSHOT_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description:
      'Ruta inválida o valores que el formato no admite (claves desconocidas, ' +
      'más de 255 caracteres, controles, arrays en `extended`, `id` o `name` vacíos).',
    // `anyOf`: los dos errores comparten `message`, así que un ejemplo puede
    // cumplir ambos y `oneOf` sería una restricción falsa.
    schema: {
      anyOf: [
        { $ref: getSchemaPath(PluginMetaPathErrorDto) },
        { $ref: getSchemaPath(PluginMetaValidationErrorDto) },
      ],
    },
    examples: {
      rutaInvalida: {
        summary: 'Ruta relativa',
        value: {
          message: 'pluginDir debe ser una ruta absoluta: "plugs/MySynth"',
        },
      },
      validacion: {
        summary: 'Valor no representable en el archivo',
        value: PLUGIN_META_VALIDATION_ERROR_EXAMPLE,
      },
    },
  })
  @ApiConflictResponse({
    description:
      'El `mtimeMs` enviado ya no es el vigente (por ejemplo, porque otra pestaña o ' +
      'la propia app escribieron el meta). No se escribe nada.',
    type: PluginMetaConflictErrorDto,
    example: PLUGIN_META_CONFLICT_EXAMPLE,
  })
  async upsertMeta(
    @Param('id') _id: string,
    @Body() body: unknown,
  ): Promise<PluginMetaSnapshot> {
    const input = readWriteInput(body);
    try {
      return await this.service.write(input);
    } catch (error) {
      mapDomainError(error);
    }
  }
}
