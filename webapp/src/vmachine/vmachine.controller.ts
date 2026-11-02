import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiExtraModels,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CodedError, type ApiErrorCode } from '../common/api-errors';
import {
  VMACHINE_DRIVE_MISSING_EXAMPLE,
  VMACHINE_DRIVES_EXAMPLE,
  VMACHINE_ERROR_EXAMPLE,
  VMACHINE_INVENTORY_EXAMPLE,
  VMACHINE_INSTALL_REQUEST_EXAMPLE,
  VMACHINE_INSTALL_RESULT_EXAMPLE,
  VMachineCopyRequestDto,
  VMachineCopyResultDto,
  VMachineDrivesResponseDto,
  VMachineErrorDto,
  VMACHINE_COPY_REQUEST_EXAMPLE,
  VMACHINE_COPY_RESULT_EXAMPLE,
  VMACHINE_SYNC_EXAMPLE,
  VMachineInstallRequestDto,
  VMachineInventoryResponseDto,
  VMachineInstallResultDto,
  VMachineSyncResponseDto,
} from './vmachine.dto';
import { VMachineService } from './vmachine.service';
import type { VMachineCopyOptions, VMachineInstallOptions } from './vmachine.types';

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
  plugsMissing: HttpStatus.BAD_REQUEST,
  batchPluginsEmpty: HttpStatus.BAD_REQUEST,
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

/**
 * Petición de copia en lote: unidad, raíz de la librería y nombres de carpeta. Cada
 * nombre se valida contra el disco en el servicio; aquí solo se comprueba la forma.
 */
export function readCopyRequest(body: unknown): VMachineCopyOptions {
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
  const library = text('library');
  if (library === null) throw new BadRequestException('library requerido');

  const raw = record['folders'];
  if (!Array.isArray(raw)) throw new BadRequestException('folders requerido');
  const folders = raw.map((entry: unknown) => {
    if (typeof entry !== 'string') {
      throw new BadRequestException('folders debe ser una lista de nombres');
    }
    return entry.trim();
  });
  if (folders.every((folder: string) => folder === '')) {
    throw new BadRequestException('folders requerido');
  }

  const libraryName = text('libraryName');
  return libraryName === null
    ? { drive, libraryRoot: library, folders }
    : { drive, libraryRoot: library, folders, libraryName };
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

  @Get('inventory')
  @ApiOperation({
    summary: 'Plugins que ya viven en las bibliotecas del medio',
    description:
      'Recorre en modo lectura las bibliotecas `*.vfxlibrary` de la raíz de la unidad y, por cada ' +
      'carpeta de `plugs\\`, lee su `vfxinfo.txt` —en latin1, como lo escribe la máquina— y lo ' +
      'compara con el catálogo de wizards por id, DLL o nombre exacto. `status` dice si el medio ' +
      'tiene la misma versión que el catálogo (`match`), otra (`differs`) o si el catálogo no lo ' +
      'conoce (`unknown`).',
  })
  @ApiQuery({
    name: 'drive',
    required: true,
    description: 'Raíz del medio, tal como la devuelve `GET /vmachine/drives` («E:», «E:\\»).',
    example: 'E:',
  })
  @ApiOkResponse({
    description: 'Bibliotecas del medio con sus plugins, ya comparados con el catálogo.',
    type: VMachineInventoryResponseDto,
    example: VMACHINE_INVENTORY_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: 'Falta `drive` o llega vacío.',
    type: VMachineErrorDto,
    example: { message: 'drive requerido' },
  })
  @ApiNotFoundResponse({
    description: 'La unidad no existe o no es una carpeta.',
    type: VMachineErrorDto,
    example: VMACHINE_DRIVE_MISSING_EXAMPLE,
  })
  async inventory(@Query('drive') drive?: string): Promise<VMachineInventoryResponseDto> {
    try {
      const value = (drive ?? '').trim();
      if (value === '') throw new BadRequestException('drive requerido');
      return await this.service.inventory(value);
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

  @Get('sync')
  @ApiOperation({
    summary: 'Comparar la librería con las bibliotecas del medio',
    description:
      'Lee en modo lectura los plugins de la librería del equipo (`plugs\\<Plugin>\\vfxinfo.txt`) ' +
      'y los empareja con los del medio por id VST, nombre de carpeta o nombre declarado. ' +
      '`state` dice si el plugin solo está en la librería (`missing`), si el medio tiene otra ' +
      'versión (`differs`) o si coinciden (`same`); `extra` son los del medio que la librería no ' +
      'tiene, que no se tocan. No escribe nada.',
  })
  @ApiQuery({
    name: 'drive',
    required: true,
    description: 'Raíz del medio, tal como la devuelve `GET /vmachine/drives`.',
    example: 'E:',
  })
  @ApiQuery({
    name: 'library',
    required: true,
    description: 'Raíz de la librería del equipo: la carpeta que contiene `plugs\\`.',
    example: 'D:\\VFX',
  })
  @ApiOkResponse({
    description: 'Comparación por plugin y totales.',
    type: VMachineSyncResponseDto,
    example: VMACHINE_SYNC_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: 'Falta `drive` o `library`, o la librería no tiene `plugs`.',
    type: VMachineErrorDto,
    examples: {
      sinDrive: { summary: 'Falta la unidad', value: { message: 'drive requerido' } },
      sinPlugs: {
        summary: 'La ruta no es una librería',
        value: {
          message: 'No existe la carpeta plugs de la librería "D:/VFX".',
          code: 'plugsMissing',
          params: { 0: 'D:/VFX' },
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'La unidad no existe o no es una carpeta.',
    type: VMachineErrorDto,
    example: VMACHINE_DRIVE_MISSING_EXAMPLE,
  })
  async sync(
    @Query('drive') drive?: string,
    @Query('library') library?: string,
  ): Promise<VMachineSyncResponseDto> {
    try {
      const value = (drive ?? '').trim();
      if (value === '') throw new BadRequestException('drive requerido');
      const root = (library ?? '').trim();
      if (root === '') throw new BadRequestException('library requerido');
      return await this.service.sync(value, root);
    } catch (error) {
      throw asHttpException(error);
    }
  }

  @Post('copy')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Copiar en lote a la biblioteca del medio, con verificación',
    description:
      'Copia las carpetas de `plugs\\` que se piden —lo que `GET /vmachine/sync` marca como ' +
      '`missing` o `differs`— envolviéndolas en `<Biblioteca>.vfxlibrary\\plugs\\<Plugin>\\`. ' +
      'El espacio libre se comprueba para todo el lote antes de escribir el primer archivo; ' +
      'un fallo posterior en un plugin se informa en `results` y no cancela los demás. Cada ' +
      'archivo se verifica por tamaño y, hasta 32 MiB, por SHA-256.',
  })
  @ApiBody({
    type: VMachineCopyRequestDto,
    examples: { estandar: { value: VMACHINE_COPY_REQUEST_EXAMPLE } },
  })
  @ApiOkResponse({
    description: 'Lo copiado por plugin y el total.',
    type: VMachineCopyResultDto,
    example: VMACHINE_COPY_RESULT_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description:
      'Falta `drive`, `library` o `folders`, o alguno de los plugins no está en la librería.',
    type: VMachineErrorDto,
    examples: {
      sinFolders: { summary: 'Sin plugins que copiar', value: { message: 'folders requerido' } },
      sinVfxinfo: {
        summary: 'El plugin no tiene vfxinfo',
        value: {
          message: 'El plugin "Roto" no tiene vfxinfo.txt; la máquina no lo reconocería.',
          code: 'vfxinfoMissing',
          params: { 0: 'Roto' },
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'La unidad o la carpeta de algún plugin no existen.',
    type: VMachineErrorDto,
    example: VMACHINE_DRIVE_MISSING_EXAMPLE,
  })
  @ApiConflictResponse({
    description: 'El lote completo no cabe en el espacio libre del medio.',
    type: VMachineErrorDto,
    example: {
      message: 'No cabe en "E:": hacen falta 640 MB y quedan 340 MB.',
      code: 'notEnoughSpace',
      params: { 0: '640 MB', 1: '340 MB' },
    },
  })
  async copy(@Body() body: unknown): Promise<VMachineCopyResultDto> {
    try {
      return await this.service.copyToStick(readCopyRequest(body));
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
