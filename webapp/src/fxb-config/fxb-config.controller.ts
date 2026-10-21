import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  FXB_CONFIG_CONFLICT_EXAMPLE,
  FXB_CONFIG_OK_EXAMPLE,
  FXB_CONFIG_VALIDATION_ERROR_EXAMPLE,
  FxbConfigConflictErrorDto,
  FxbConfigPathErrorDto,
  FxbConfigReadRequestDto,
  FxbConfigSnapshotDto,
  FxbConfigValidationErrorDto,
  FxbConfigWriteRequestDto,
} from './fxb-config.dto';
import { FxbConfigService } from './fxb-config.service';
import {
  FxbConfigConflictError,
  FxbConfigPathError,
  FxbConfigValidationError,
} from './fxb-config.types';
import type {
  FxbConfig,
  FxbConfigSnapshot,
  FxbConfigWriteInput,
} from './fxb-config.types';

const CONFIG_KEYS = ['pluginName', 'defaultFxbName', 'programDirName', 'loadFxbBank'] as const;

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('El cuerpo debe ser un objeto JSON');
  }
  return body as Record<string, unknown>;
}

function requirePluginDir(body: Record<string, unknown>): string {
  const value = body['pluginDir'];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException('pluginDir es obligatorio y debe ser una cadena');
  }
  return value;
}

function readWriteInput(body: unknown): FxbConfigWriteInput {
  const record = asRecord(body);
  const pluginDir = requirePluginDir(record);

  if (!('expectedMtimeMs' in record)) {
    throw new BadRequestException(
      'expectedMtimeMs es obligatorio (usa null si el archivo no existía)',
    );
  }
  const expected = record['expectedMtimeMs'];
  if (expected !== null && typeof expected !== 'number') {
    throw new BadRequestException('expectedMtimeMs debe ser un número o null');
  }

  const rawConfig = record['config'];
  if (typeof rawConfig !== 'object' || rawConfig === null || Array.isArray(rawConfig)) {
    throw new BadRequestException('config debe ser un objeto');
  }

  const config: Partial<FxbConfig> = {};
  for (const [key, value] of Object.entries(rawConfig as Record<string, unknown>)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new BadRequestException(`clave desconocida en config: "${key}"`);
    }

    if (key === 'loadFxbBank') {
      if (typeof value !== 'boolean') {
        throw new BadRequestException('config.loadFxbBank debe ser booleano');
      }
      config.loadFxbBank = value;
      continue;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`config.${key} debe ser una cadena`);
    }

    switch (key) {
      case 'pluginName':
        config.pluginName = value;
        break;
      case 'defaultFxbName':
        config.defaultFxbName = value;
        break;
      default:
        config.programDirName = value;
        break;
    }
  }

  return { pluginDir, expectedMtimeMs: expected as number | null, config };
}

function mapDomainError(error: unknown): never {
  if (error instanceof FxbConfigValidationError) {
    throw new BadRequestException({
      message: 'Configuración no válida',
      issues: error.issues,
    });
  }
  if (error instanceof FxbConfigConflictError) {
    throw new ConflictException({
      message: error.message,
      current: error.current,
    });
  }
  if (error instanceof FxbConfigPathError) {
    throw new BadRequestException({ message: error.message });
  }
  if (error instanceof HttpException) throw error;
  throw error;
}

@ApiTags('fxb-config')
@ApiExtraModels(FxbConfigPathErrorDto, FxbConfigValidationErrorDto)
@Controller('fxb-config')
export class FxbConfigController {
  constructor(private readonly service: FxbConfigService) {}

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lee fxbLoader.config de un plugin',
    description:
      'Si el archivo no existe devuelve los valores por defecto con `exists: false` y ' +
      '`mtimeMs: null`, sin crear nada.',
  })
  @ApiBody({ type: FxbConfigReadRequestDto })
  @ApiOkResponse({
    description: 'Snapshot del archivo y del `mtimeMs` para el control optimista.',
    type: FxbConfigSnapshotDto,
    example: FXB_CONFIG_OK_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: '`pluginDir` ausente, relativo, inexistente o que no es un directorio.',
    type: FxbConfigPathErrorDto,
    example: { message: 'pluginDir debe ser una ruta absoluta: "plugs/MySynth"' },
  })
  async read(@Body() body: unknown): Promise<FxbConfigSnapshot> {
    const pluginDir = requirePluginDir(asRecord(body));
    try {
      return await this.service.read(pluginDir);
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Put()
  @ApiOperation({
    summary: 'Escribe fxbLoader.config de forma atómica',
    description:
      'Fusiona `config` con lo que haya en disco, valida los límites del binario y ' +
      'exige que `expectedMtimeMs` siga siendo el vigente.',
  })
  @ApiBody({
    type: FxbConfigWriteRequestDto,
    examples: {
      cambioParcial: {
        summary: 'Cambiar banco y desactivar la carga',
        value: {
          pluginDir: 'C:\\VFX\\plugs\\MySynth',
          expectedMtimeMs: 1760000000000.123,
          config: { defaultFxbName: 'Rhodes.fxb', loadFxbBank: false },
        },
      },
      archivoNuevo: {
        summary: 'Crear el archivo desde cero',
        value: {
          pluginDir: 'C:\\VFX\\plugs\\MySynth',
          expectedMtimeMs: null,
          config: { pluginName: 'MySynth.dll' },
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Configuración escrita y snapshot resultante.',
    type: FxbConfigSnapshotDto,
    example: FXB_CONFIG_OK_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description:
      'Ruta inválida o valores fuera de los límites del binario ' +
      '(63 caracteres, sin `/`, sin controles, `programDirName` no vacío).',
    // `anyOf`: los dos errores comparten `message`, así que un ejemplo puede
    // cumplir ambos y `oneOf` sería una restricción falsa.
    schema: {
      anyOf: [
        { $ref: getSchemaPath(FxbConfigPathErrorDto) },
        { $ref: getSchemaPath(FxbConfigValidationErrorDto) },
      ],
    },
    examples: {
      rutaInvalida: {
        summary: 'Ruta relativa',
        value: { message: 'pluginDir debe ser una ruta absoluta: "plugs/MySynth"' },
      },
      validacion: {
        summary: 'Valor no representable o fuera de límite',
        value: FXB_CONFIG_VALIDATION_ERROR_EXAMPLE,
      },
    },
  })
  @ApiConflictResponse({
    description:
      'El `mtimeMs` enviado ya no es el vigente (por ejemplo, porque la DLL guardó ' +
      'desde su diálogo). No se escribe nada.',
    type: FxbConfigConflictErrorDto,
    example: FXB_CONFIG_CONFLICT_EXAMPLE,
  })
  async write(@Body() body: unknown): Promise<FxbConfigSnapshot> {
    const input = readWriteInput(body);
    try {
      return await this.service.write(input);
    } catch (error) {
      mapDomainError(error);
    }
  }
}
