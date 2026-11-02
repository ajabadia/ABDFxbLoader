import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiExtraModels,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CodedError, type ApiErrorCode } from '../common/api-errors';
import {
  VMACHINE_DRIVES_EXAMPLE,
  VMACHINE_ERROR_EXAMPLE,
  VMACHINE_INSTALL_REQUEST_EXAMPLE,
  VMACHINE_INSTALL_RESULT_EXAMPLE,
  VMachineDrivesResponseDto,
  VMachineErrorDto,
  VMachineInstallRequestDto,
  VMachineInstallResultDto,
} from './vmachine.dto';
import { VMachineService } from './vmachine.service';
import type { VMachineInstallOptions } from './vmachine.types';

/**
 * Estado con el que viaja cada código. El resto de la API hace lo mismo: la
 * ruta que no existe es un 404, el paquete inválido un 400 y el medio lleno un
 * 409, porque no es culpa de la petición sino del estado de la unidad.
 */
const STATUS_BY_CODE: Partial<Record<ApiErrorCode, HttpStatus>> = {
  driveNotFound: HttpStatus.NOT_FOUND,
  pluginFolderMissing: HttpStatus.NOT_FOUND,
  vfxinfoMissing: HttpStatus.BAD_REQUEST,
  libraryNameInvalid: HttpStatus.BAD_REQUEST,
  notEnoughSpace: HttpStatus.CONFLICT,
  copyMismatch: HttpStatus.INTERNAL_SERVER_ERROR,
};

/** Cuerpo del error: mensaje y, si lo hay, el código traducible con sus valores. */
function codedBody(error: CodedError): Record<string, unknown> {
  const body: Record<string, unknown> = { message: error.message };
  if (error.apiCode !== undefined) body['code'] = error.apiCode;
  if (error.apiParams !== undefined) body['params'] = error.apiParams;
  return body;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('El cuerpo debe ser un objeto JSON');
  }
  return body as Record<string, unknown>;
}

/** Valida la petición antes de tocar el disco: tres campos de texto, nada más. */
export function readInstallRequest(body: unknown): VMachineInstallOptions {
  const record = asRecord(body);
  const text = (key: string): string | null => {
    const value = record[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
      throw new BadRequestException(`${key} debe ser una cadena`);
    }
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };

  const drive = text('drive');
  if (drive === null) throw new BadRequestException('drive requerido');
  const pluginDir = text('pluginDir');
  if (pluginDir === null) throw new BadRequestException('pluginDir requerido');
  const libraryName = text('libraryName');

  return libraryName === null ? { drive, pluginDir } : { drive, pluginDir, libraryName };
}

@ApiTags('vmachine')
@ApiExtraModels(VMachineErrorDto)
@Controller('vmachine')
export class VMachineController {
  constructor(private readonly service: VMachineService) {}

  @Get('drives')
  @ApiOperation({
    summary: 'Unidades conectadas y bibliotecas que ya tienen en la raíz',
    description:
      'Enumera los discos lógicos del sistema con su etiqueta, espacio libre y si son ' +
      'extraíbles, y dice qué bibliotecas `*.vfxlibrary` hay en la raíz de cada uno: es lo que ' +
      'la v-machine reconoce al insertar el medio. Fuera de Windows devuelve `supported: false`.',
  })
  @ApiOkResponse({
    description: 'Unidades conectadas, por letra.',
    type: VMachineDrivesResponseDto,
    example: VMACHINE_DRIVES_EXAMPLE,
  })
  async listDrives(): Promise<VMachineDrivesResponseDto> {
    try {
      return await this.service.listDrives();
    } catch (error) {
      throw asHttpException(error);
    }
  }

  @Post('install')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Copiar el paquete del plugin a la biblioteca del medio, con verificación',
    description:
      'Envuelve el paquete generado por `/capture/vmachine/:diffId` en ' +
      '`<Nombre>.vfxlibrary\\plugs\\<Plugin>\\` —la forma que la v-machine lee desde la raíz del ' +
      'medio— y comprueba archivo por archivo que lo copiado es idéntico a lo generado: tamaño ' +
      'siempre, y SHA-256 hasta 32 MiB. Si la unidad ya tiene una única biblioteca se escribe en ' +
      'ella; pisar una versión anterior del mismo plugin se informa en `replaced`. No borra nada ' +
      'que no sea del propio plugin.',
  })
  @ApiBody({
    type: VMachineInstallRequestDto,
    examples: { estandar: { value: VMACHINE_INSTALL_REQUEST_EXAMPLE } },
  })
  @ApiOkResponse({
    description: 'Lo copiado y lo verificado.',
    type: VMachineInstallResultDto,
    example: VMACHINE_INSTALL_RESULT_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description:
      'Falta `drive` o `pluginDir`, no son texto, o el paquete no tiene `vfxinfo.txt`.',
    type: VMachineErrorDto,
    examples: {
      sinDll: {
        summary: 'La carpeta no es un plugin',
        value: {
          message: 'No hay vfxinfo.txt en C:/fxbLoader/storage/vmachine/plugs/Nada.',
          code: 'vfxinfoMissing',
          params: { 0: 'C:/fxbLoader/storage/vmachine/plugs/Nada' },
        },
      },
      sinCampo: { summary: 'Falta el campo', value: { message: 'pluginDir requerido' } },
    },
  })
  @ApiNotFoundResponse({
    description: 'La unidad o la carpeta del plugin no existen.',
    schema: { $ref: getSchemaPath(VMachineErrorDto) },
    examples: {
      sinUnidad: {
        summary: 'La unidad no está conectada',
        value: { message: 'La unidad "Z:" no existe o no es una carpeta.', code: 'driveNotFound', params: { 0: 'Z:' } },
      },
      sinPlugin: {
        summary: 'La carpeta del plugin no existe',
        value: VMACHINE_ERROR_EXAMPLE,
      },
    },
  })
  @ApiConflictResponse({
    description: 'El paquete no cabe en el espacio libre del medio.',
    type: VMachineErrorDto,
    example: {
      message: 'No cabe en "E:": hacen falta 1,2 GB y quedan 340 MB.',
      code: 'notEnoughSpace',
      params: { 0: '1,2 GB', 1: '340 MB' },
    },
  })
  async install(@Body() body: unknown): Promise<VMachineInstallResultDto> {
    try {
      return await this.service.install(readInstallRequest(body));
    } catch (error) {
      throw asHttpException(error);
    }
  }
}

/** Traduce un error de dominio a la excepción HTTP que le toca. */
function asHttpException(error: unknown): unknown {
  if (!(error instanceof CodedError)) return error;
  const status = (error.apiCode !== undefined && STATUS_BY_CODE[error.apiCode]) || HttpStatus.INTERNAL_SERVER_ERROR;
  return new HttpException(codedBody(error), status);
}
