import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Post,
  Res,
  UnprocessableEntityException,
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
  ApiUnprocessableEntityResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { FXB_CONFIG_SNAPSHOT_EXAMPLE } from '../fxb-config/fxb-config.dto';
import { FxbConfigConflictError } from '../fxb-config/fxb-config.types';
import {
  LIBRARY_BANKS_LIST_EXAMPLE,
  LIBRARY_BATCH_ACTION_ERROR_EXAMPLE,
  LIBRARY_BATCH_DRY_RUN_EXAMPLE,
  LIBRARY_BATCH_EXAMPLE,
  LIBRARY_BATCH_LOADER_ERROR_EXAMPLE,
  LIBRARY_BATCH_PLUGINS_ERROR_EXAMPLE,
  LIBRARY_BATCH_STREAM_EXAMPLE,
  LIBRARY_BATCH_TOO_MANY_ERROR_EXAMPLE,
  LIBRARY_BANKS_IMPORT_STREAM_EXAMPLE,
  LIBRARY_CONVERT_EXAMPLE,
  LIBRARY_CONVERT_MISSING_BANK_EXAMPLE,
  LIBRARY_CONVERT_NO_DEFAULT_EXAMPLE,
  LIBRARY_DISCARD_BACKUP_EXAMPLE,
  LIBRARY_DISCARD_NO_BACKUP_EXAMPLE,
  LIBRARY_DISCARD_TRASH_ERROR_EXAMPLE,
  LIBRARY_DLL_ERROR_EXAMPLE,
  LIBRARY_EXPORT_EXAMPLE,
  LIBRARY_EXPORT_TARGET_EXISTS_EXAMPLE,
  LIBRARY_IMPORT_EXAMPLE,
  LIBRARY_IMPORT_REJECTED_EXAMPLE,
  LIBRARY_INCOMPATIBLE_ERROR_EXAMPLE,
  LIBRARY_INSPECT_EXAMPLE,
  LIBRARY_INSPECT_EXTENSION_ERROR_EXAMPLE,
  LIBRARY_INSPECT_INVALID_EXAMPLE,
  LIBRARY_INSPECT_PATH_ERROR_EXAMPLE,
  LIBRARY_INSPECT_WITHOUT_PLUGIN_EXAMPLE,
  LIBRARY_INSTALLED_PLUGIN_EXAMPLE,
  LIBRARY_INSTALL_CONFLICT_EXAMPLE,
  LIBRARY_INSTALL_DRY_RUN_EXAMPLE,
  LIBRARY_INSTALL_EXAMPLE,
  LIBRARY_MISSING_PLUGIN_DLL_ERROR_EXAMPLE,
  LIBRARY_LIBRARY_MISSING_ERROR_EXAMPLE,
  LIBRARY_PLUGIN_NOT_FOUND_EXAMPLE,
  LIBRARY_RESTORE_EXAMPLE,
  LIBRARY_RESTORE_INVALID_BACKUP_EXAMPLE,
  LIBRARY_RESTORE_NO_BACKUP_EXAMPLE,
  LIBRARY_RESTORE_UNCHANGED_EXAMPLE,
  LIBRARY_SCAN_EXAMPLE,
  LIBRARY_SCAN_PATH_ERROR_EXAMPLE,
  LIBRARY_UNINSTALL_CONFLICT_EXAMPLE,
  LIBRARY_UNINSTALL_EXAMPLE,
  LIBRARY_VFXINFO_ERROR_EXAMPLE,
  LibraryBankConvertRequestDto,
  LibraryBankConvertResponseDto,
  LibraryBankDiscardBackupRequestDto,
  LibraryBankDiscardBackupResponseDto,
  LibraryBankExportRequestDto,
  LibraryBankExportResponseDto,
  LibraryBankInspectRequestDto,
  LibraryBankInspectResponseDto,
  LibraryBanksImportErrorDto,
  LibraryBanksImportRequestDto,
  LibraryBanksImportResponseDto,
  LibraryBanksListRequestDto,
  LibraryBanksListResponseDto,
  LibraryBankRestoreRequestDto,
  LibraryBankRestoreResponseDto,
  LibraryBatchRequestDto,
  LibraryBatchResponseDto,
  LibraryConflictErrorDto,
  LibraryErrorDto,
  LibraryInstallRequestDto,
  LibraryOperationResponseDto,
  LibraryScanRequestDto,
  LibraryScanResponseDto,
  LibraryUninstallRequestDto,
} from './library.dto';
import { defaultLoaderDllPath } from './loader-dll';
import { MAX_PLUGINS_PER_BATCH } from '../client/batch-stream';
import type { BankImportStreamEvent } from '../client/bank-import-stream';
import { LibraryService } from './library.service';
import {
  LibraryOperationError,
  LibraryPathError,
  PluginNotFoundError,
  PluginStateError,
} from './library.types';
import type {
  BankConvertInput,
  BankDiscardBackupInput,
  BankExportInput,
  BankImportInput,
  BankInspectInput,
  BankRestoreInput,
  BatchAction,
  BatchInput,
  BatchStreamEvent,
  InstallInput,
  UninstallInput,
} from './library.types';

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('El cuerpo debe ser un objeto JSON');
  }
  return body as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${key} es obligatorio y debe ser una cadena`);
  }
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${key} debe ser booleano`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${key} debe ser una cadena no vacía`);
  }
  return value;
}

/** `expectedUniqueId` y `expectedFxVersion`; los comparten import e inspect. */
function readBankReference(body: Record<string, unknown>): {
  expectedUniqueId?: string | number;
  expectedFxVersion?: number;
} {
  const expectedUniqueId = body['expectedUniqueId'];
  if (expectedUniqueId !== undefined) {
    const validString = typeof expectedUniqueId === 'string' && expectedUniqueId.length === 4;
    const validNumber = typeof expectedUniqueId === 'number' && Number.isInteger(expectedUniqueId);
    if (!validString && !validNumber) {
      throw new BadRequestException(
        'expectedUniqueId debe ser una cadena de 4 caracteres o un entero',
      );
    }
  }

  const expectedFxVersion = body['expectedFxVersion'];
  if (
    expectedFxVersion !== undefined &&
    (typeof expectedFxVersion !== 'number' ||
      !Number.isInteger(expectedFxVersion) ||
      expectedFxVersion < 0)
  ) {
    throw new BadRequestException('expectedFxVersion debe ser un entero no negativo');
  }

  return {
    ...(expectedUniqueId === undefined
      ? {}
      : { expectedUniqueId: expectedUniqueId as string | number }),
    ...(expectedFxVersion === undefined
      ? {}
      : { expectedFxVersion: expectedFxVersion as number }),
  };
}

/** Cuerpo de `POST /library/banks/import` y de su variante NDJSON. */
function readBankImportInput(body: Record<string, unknown>): BankImportInput {
  const sourcePaths = body['sourcePaths'];
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    throw new BadRequestException('sourcePaths debe ser un array con al menos una ruta');
  }
  if (!sourcePaths.every((value) => typeof value === 'string' && value.trim() !== '')) {
    throw new BadRequestException('sourcePaths debe contener cadenas no vacías');
  }

  const overwrite = optionalBoolean(body, 'overwrite');
  return {
    libraryRoot: requireString(body, 'libraryRoot'),
    plugin: requireString(body, 'plugin'),
    sourcePaths: sourcePaths as string[],
    ...readBankReference(body),
    ...(overwrite === undefined ? {} : { overwrite }),
  };
}

function readBatchAction(body: Record<string, unknown>): BatchAction {
  const value = body['action'];
  if (value === 'install' || value === 'uninstall') return value;
  throw new BadRequestException('action debe ser "install" o "uninstall"');
}

function readBatchPlugins(body: Record<string, unknown>): string[] {
  const value = body['plugins'];
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestException('plugins debe ser un array con al menos un nombre');
  }
  if (!value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new BadRequestException('plugins debe contener cadenas no vacías');
  }
  return value as string[];
}

/** Cuerpo de `POST /library/batch` y `POST /library/batch/stream`; son el mismo lote. */
function readBatchInput(body: Record<string, unknown>): BatchInput {
  return {
    libraryRoot: requireString(body, 'libraryRoot'),
    action: readBatchAction(body),
    plugins: readBatchPlugins(body),
    dllSourcePath:
      typeof body['dllSourcePath'] === 'string' && body['dllSourcePath'].trim() !== ''
        ? body['dllSourcePath']
        : defaultLoaderDllPath(),
    force: optionalBoolean(body, 'force'),
    dryRun: optionalBoolean(body, 'dryRun'),
  };
}

function mapDomainError(error: unknown): never {
  if (error instanceof PluginNotFoundError) {
    throw new NotFoundException({ message: error.message });
  }
  if (error instanceof PluginStateError || error instanceof FxbConfigConflictError) {
    throw new ConflictException({
      message: error.message,
      ...(error instanceof FxbConfigConflictError ? { current: error.current } : {}),
    });
  }
  if (error instanceof LibraryOperationError) {
    throw new UnprocessableEntityException({ message: error.message });
  }
  if (error instanceof LibraryPathError) {
    throw new BadRequestException({ message: error.message });
  }
  if (error instanceof HttpException) throw error;
  throw error;
}

@ApiTags('library')
@ApiExtraModels(LibraryErrorDto, LibraryConflictErrorDto, LibraryBanksImportErrorDto)
@Controller('library')
export class LibraryController {
  constructor(private readonly service: LibraryService) {}

  @Post('scan')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enumera los plugins de la librería',
    description: 'Lista los directorios de `plugs\\` y marca los que tienen `fxbLoader.config`.',
  })
  @ApiBody({
    type: LibraryScanRequestDto,
    examples: {
      libreria: {
        summary: 'Escanear una librería VFX',
        value: { libraryRoot: 'C:\\VFX\\Library' },
      },
      conDll: {
        summary: 'Validar además otro fxbLoader.dll',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          dllSourcePath: 'C:\\fxbLoader\\vst\\fxbLoader.dll',
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Plugins encontrados, ordenados por nombre, con su estado.',
    type: LibraryScanResponseDto,
    example: LIBRARY_SCAN_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description:
      '`libraryRoot` ausente, relativo, inexistente o sin carpeta `plugs\\`, o ' +
      '`dllSourcePath` no absoluta o inexistente.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    examples: {
      rutaRelativa: {
        summary: 'Ruta relativa',
        value: LIBRARY_SCAN_PATH_ERROR_EXAMPLE,
      },
      sinPlugs: {
        summary: 'La carpeta existe pero no tiene plugs\\',
        value: LIBRARY_LIBRARY_MISSING_ERROR_EXAMPLE,
      },
      dll: {
        summary: 'DLL del cargador ausente o relativa',
        value: LIBRARY_DLL_ERROR_EXAMPLE,
      },
    },
  })
  async scan(@Body() body: unknown) {
    const record = asRecord(body);
    const configured = record['dllSourcePath'];
    const dllSourcePath =
      typeof configured === 'string' && configured.trim() !== ''
        ? configured
        : defaultLoaderDllPath();
    try {
      return await this.service.scan(requireString(record, 'libraryRoot'), dllSourcePath);
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('install')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Instala fxbLoader en un plugin',
    description:
      'Respalda `vfxinfo.txt` como `vfxinfo.tx_`, copia el DLL, reescribe `dll_name` ' +
      'y crea `fxbLoader.config` + `presets\\`.',
  })
  @ApiBody({
    type: LibraryInstallRequestDto,
    examples: {
      instalacion: {
        summary: 'Instalar con el DLL del repositorio',
        value: { libraryRoot: 'C:\\VFX\\Library', plugin: 'MySynth' },
      },
      simulacion: {
        summary: 'Ver el plan sin escribir (dryRun)',
        value: { libraryRoot: 'C:\\VFX\\Library', plugin: 'GrandPiano', dryRun: true },
      },
    },
  })
  @ApiOkResponse({
    description: 'Operación aplicada y estado resultante del plugin.',
    type: LibraryOperationResponseDto,
    examples: {
      instalado: {
        summary: 'Instalación aplicada',
        value: LIBRARY_INSTALL_EXAMPLE,
      },
      dryRun: {
        summary: 'Solo el plan (`dryRun: true`)',
        value: LIBRARY_INSTALL_DRY_RUN_EXAMPLE,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Ruta o nombre inválido, o DLL de origen ausente.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    examples: {
      dllRelativa: {
        summary: 'dllSourcePath no absoluta o inexistente',
        value: LIBRARY_DLL_ERROR_EXAMPLE,
      },
      pluginInvalido: {
        summary: 'Nombre de plugin con separadores',
        value: { message: 'nombre de plugin no válido: "..\\Otro"' },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'El plugin no existe en `plugs\\`.',
    type: LibraryErrorDto,
    example: LIBRARY_PLUGIN_NOT_FOUND_EXAMPLE,
  })
  @ApiConflictResponse({
    description:
      'El plugin ya está instalado (usa `force`) o `fxbLoader.config` cambió entre la ' +
      'lectura y la escritura.',
    // `anyOf`: ambos errores comparten `message` y no son mutuamente
    // excluyentes, así que `oneOf` rechazaría ejemplos válidos.
    schema: {
      anyOf: [
        { $ref: getSchemaPath(LibraryConflictErrorDto) },
        { $ref: getSchemaPath(LibraryErrorDto) },
      ],
    },
    examples: {
      yaInstalado: {
        summary: 'Ya tiene el cargador',
        value: LIBRARY_INSTALL_CONFLICT_EXAMPLE,
      },
      configCambiada: {
        summary: 'Config modificada por la DLL durante la instalación',
        value: {
          message: 'El archivo cambió en disco desde la última lectura',
          current: FXB_CONFIG_SNAPSHOT_EXAMPLE,
        },
      },
    },
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`vfxinfo.txt` ausente o sin `dll_name`, `dll_name` que apunta a un archivo ' +
      'inexistente (se trata como incompatible), `fxbLoader.dll` que no es PE32 i386 o ' +
      'plugin de otra arquitectura; no se toca nada.',
    type: LibraryErrorDto,
    examples: {
      vfxinfo: {
        summary: 'vfxinfo.txt sin dll_name',
        value: LIBRARY_VFXINFO_ERROR_EXAMPLE,
      },
      binarioAusente: {
        summary: 'El DLL declarado no existe en el plugin',
        value: LIBRARY_MISSING_PLUGIN_DLL_ERROR_EXAMPLE,
      },
      incompatible: {
        summary: 'Cargador o plugin de otra arquitectura',
        value: LIBRARY_INCOMPATIBLE_ERROR_EXAMPLE,
      },
    },
  })
  async install(@Body() body: unknown) {
    const record = asRecord(body);
    const input: InstallInput = {
      libraryRoot: requireString(record, 'libraryRoot'),
      plugin: requireString(record, 'plugin'),
      dllSourcePath:
        typeof record['dllSourcePath'] === 'string' && record['dllSourcePath'].trim() !== ''
          ? record['dllSourcePath']
          : defaultLoaderDllPath(),
      force: optionalBoolean(record, 'force'),
      dryRun: optionalBoolean(record, 'dryRun'),
    };
    try {
      return await this.service.install(input);
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('banks/list')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lista los bancos de un plugin y su configuración',
    description:
      'Lee la cabecera de cada `.fxb` de `<plugin>\\<programDirName>\\` y devuelve el ' +
      'snapshot de `fxbLoader.config` (incluido `mtimeMs` para guardar el banco por ' +
      'defecto). **No crea ni copia nada**: con la carpeta ausente devuelve `banks: []`.',
  })
  @ApiBody({
    type: LibraryBanksListRequestDto,
    examples: {
      plugin: {
        summary: 'Bancos de un plugin instalado',
        value: { libraryRoot: 'C:\\VFX\\Library', plugin: 'MySynth' },
      },
    },
  })
  @ApiOkResponse({
    description: 'Carpeta de presets, bancos válidos y configuración vigente.',
    type: LibraryBanksListResponseDto,
    example: LIBRARY_BANKS_LIST_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: '`libraryRoot` ausente, relativo, inexistente o sin `plugs\\`.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    example: LIBRARY_SCAN_PATH_ERROR_EXAMPLE,
  })
  @ApiNotFoundResponse({
    description: 'El plugin no existe en `plugs\\`.',
    type: LibraryErrorDto,
    example: LIBRARY_PLUGIN_NOT_FOUND_EXAMPLE,
  })
  @ApiUnprocessableEntityResponse({
    description: '`programDirName` de `fxbLoader.config` no es un nombre de carpeta simple.',
    type: LibraryErrorDto,
    example: {
      message:
        'programDirName "..\\fuera" no es un nombre de carpeta simple; revisa fxbLoader.config ' +
        'antes de listar los bancos',
    },
  })
  async listBanks(@Body() body: unknown) {
    const record = asRecord(body);
    try {
      return await this.service.listBanks({
        libraryRoot: requireString(record, 'libraryRoot'),
        plugin: requireString(record, 'plugin'),
      });
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('banks/import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Importa bancos .fxb en la carpeta de presets',
    description:
      'Valida el formato VST2 de cada banco y su compatibilidad (uniqueID/versión) ' +
      'antes de copiarlo de forma atómica en `<plugin>\\<programDirName>\\`.',
  })
  @ApiBody({
    type: LibraryBanksImportRequestDto,
    examples: {
      lote: {
        summary: 'Dos bancos con uniqueID explícito',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          plugin: 'MySynth',
          sourcePaths: ['C:\\Banks\\Rhodes.fxb', 'C:\\Banks\\Strings.fxb'],
          expectedUniqueId: 'MySy',
          expectedFxVersion: 1000,
        },
      },
      sinReferencia: {
        summary: 'Sin referencia: se importa como unverified',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          plugin: 'MySynth',
          sourcePaths: ['C:\\Banks\\Rhodes.fxb'],
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Resultado por archivo; 200 basta con que uno se importe.',
    type: LibraryBanksImportResponseDto,
    example: LIBRARY_IMPORT_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description:
      'Petición mal formada: rutas no absolutas, más de 50 bancos, `expectedUniqueId` ' +
      'inválido o `libraryRoot` inexistente.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    examples: {
      rutaRelativa: {
        summary: 'Origen no absoluto',
        value: { message: 'la ruta debe ser absoluta: "Banks/Rhodes.fxb"' },
      },
      demasiados: {
        summary: 'Lote demasiado grande',
        value: { message: 'como máximo 50 bancos por petición' },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'El plugin no existe en `plugs\\`.',
    type: LibraryErrorDto,
    example: LIBRARY_PLUGIN_NOT_FOUND_EXAMPLE,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Todos los bancos se rechazaron. El cuerpo es el resultado completo, para que el ' +
      'cliente muestre el motivo de cada archivo.',
    type: LibraryBanksImportErrorDto,
    example: LIBRARY_IMPORT_REJECTED_EXAMPLE,
  })
  async importBanks(@Body() body: unknown) {
    const input = readBankImportInput(asRecord(body));

    try {
      const result = await this.service.importBanks(input);
      if (result.results.every((item) => item.status === 'rejected')) {
        throw new UnprocessableEntityException({
          message: 'Ningún banco se pudo importar',
          ...result,
        });
      }
      return result;
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('banks/import/stream')
  @ApiOperation({
    summary: 'Importa bancos .fxb informando del progreso por archivo',
    description:
      'El mismo cuerpo que `POST /library/banks/import`, pero la respuesta es NDJSON: `start` ' +
      'con el total, un `bank` con el resultado de cada archivo (importado o rechazado) y `end` ' +
      'con el cuerpo completo. Así la barra avanza banco a banco. La petición se valida entera ' +
      'antes del primer byte: un 400/404 sigue siendo JSON. Si todos los bancos se rechazan, el ' +
      'flujo termina con `end` y la vista cuenta los `rejected`.',
  })
  @ApiBody({
    type: LibraryBanksImportRequestDto,
    examples: {
      lote: {
        summary: 'Dos bancos con uniqueID explícito',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          plugin: 'MySynth',
          sourcePaths: ['C:\\Banks\\Rhodes.fxb', 'C:\\Banks\\Strings.fxb'],
          expectedUniqueId: 'MySy',
          expectedFxVersion: 1000,
        },
      },
      sinReferencia: {
        summary: 'Sin referencia: se importa como unverified',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          plugin: 'MySynth',
          sourcePaths: ['C:\\Banks\\Rhodes.fxb'],
        },
      },
    },
  })
  @ApiOkResponse({
    description:
      'Un evento JSON por línea: `start`, un `bank` por archivo en el orden recibido y `end` ' +
      'con el mismo cuerpo que `POST /library/banks/import`.',
    content: {
      'application/x-ndjson': {
        schema: { type: 'string' },
        example: LIBRARY_BANKS_IMPORT_STREAM_EXAMPLE,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Petición mal formada: rutas no absolutas, más de 50 bancos o `expectedUniqueId` inválido. ' +
      'Se rechaza antes de escribir ningún evento.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    example: { message: 'la ruta debe ser absoluta: "Banks/Rhodes.fxb"' },
  })
  @ApiNotFoundResponse({
    description: 'El plugin no existe en `plugs\\`; tampoco se escribe ningún evento.',
    type: LibraryErrorDto,
    example: LIBRARY_PLUGIN_NOT_FOUND_EXAMPLE,
  })
  async importBanksStream(@Body() body: unknown, @Res() response: Response): Promise<void> {
    const input = readBankImportInput(asRecord(body));
    let started = false;
    let closed = false;
    response.on('close', () => {
      closed = true;
    });

    /** Primera escritura = cabeceras de la respuesta en streaming. */
    const write = (event: BankImportStreamEvent): void => {
      if (closed) return;
      if (!started) {
        started = true;
        response.status(HttpStatus.OK);
        response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        // Un proxy intermedio no debe acumular la respuesta entera.
        response.setHeader('x-accel-buffering', 'no');
      }
      response.write(`${JSON.stringify(event)}\n`);
    };

    try {
      await this.service.importBanks(input, write, () => closed);
    } catch (error) {
      if (!started) mapDomainError(error);
      // Ya hay eventos enviados: no se puede cambiar el código de estado. Se
      // corta el flujo sin `end`, que es lo que el cliente interpreta como fallo.
      response.destroy();
      throw error;
    }

    if (!closed) response.end();
  }

  @Post('banks/export')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exporta un banco importado en big-endian o little-endian',
    description:
      'Reescribe un `.fxb` que ya está en `<plugin>\\<programDirName>\\` en el orden de ' +
      'bytes pedido y lo guarda al lado como `<banco>-le.fxb` o `<banco>-be.fxb`, para ' +
      'convertir los bancos legacy que un plugin de Windows guardó con su struct nativo. ' +
      'Solo se invierten los campos numéricos (enteros y floats): los nombres de programa ' +
      'y los chunks opacos quedan byte a byte iguales. El banco de origen no se toca.',
  })
  @ApiBody({
    type: LibraryBankExportRequestDto,
    examples: {
      little: {
        summary: 'Convertir un banco legacy a little-endian',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          plugin: 'MySynth',
          fileName: 'Legacy.fxb',
          endianness: 'little',
        },
      },
      big: {
        summary: 'Volver al estándar big-endian',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          plugin: 'MySynth',
          fileName: 'Legacy-le.fxb',
          endianness: 'big',
          overwrite: true,
        },
      },
    },
  })
  @ApiOkResponse({
    description:
      'Archivo exportado, con el hash y la cabecera de origen y destino. `changed: false` ' +
      'indica que ya estaba en ese orden.',
    type: LibraryBankExportResponseDto,
    example: LIBRARY_EXPORT_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description:
      '`libraryRoot` inválido, `fileName` con separadores o sin `.fxb`, banco ausente de la ' +
      'carpeta del plugin o `endianness` desconocida.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    examples: {
      nombre: {
        summary: 'fileName con separadores',
        value: { message: 'fileName no puede contener separadores de ruta: "..\\Legacy.fxb"' },
      },
      orden: {
        summary: 'endianness desconocida',
        value: { message: 'endianness debe ser "big" o "little"' },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'El plugin no existe en `plugs\\` o no tiene `fxbLoader.config`.',
    type: LibraryErrorDto,
    example: LIBRARY_PLUGIN_NOT_FOUND_EXAMPLE,
  })
  @ApiConflictResponse({
    description: 'Ya existe el archivo de salida y `overwrite` no es `true`.',
    type: LibraryErrorDto,
    example: LIBRARY_EXPORT_TARGET_EXISTS_EXAMPLE,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'El archivo no es un banco VST2 válido o su nombre ya declara un orden que no ' +
      'coincide con su contenido.',
    type: LibraryErrorDto,
    example: {
      message:
        'el banco no es un .fxb válido: byteSize 999 no coincide con el tamaño del archivo ' +
        '(208 sin cabecera de chunk)',
    },
  })
  async exportBank(@Body() body: unknown) {
    const record = asRecord(body);
    const endianness = record['endianness'];
    if (endianness !== 'big' && endianness !== 'little') {
      throw new BadRequestException('endianness debe ser "big" o "little"');
    }
    const overwrite = optionalBoolean(record, 'overwrite');
    const input: BankExportInput = {
      libraryRoot: requireString(record, 'libraryRoot'),
      plugin: requireString(record, 'plugin'),
      fileName: requireString(record, 'fileName'),
      endianness,
      ...(overwrite === undefined ? {} : { overwrite }),
    };
    try {
      return await this.service.exportBank(input);
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('banks/convert')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Convierte en el sitio el banco por defecto del plugin',
    description:
      'Reescribe el `.fxb` que `fxbLoader.config` marca como predeterminado ' +
      '(`defaultFxbName`) en su misma ruta y en el orden pedido —por defecto, el contrario ' +
      'al que tiene—, para que la DLL lo siga cargando sin renombrarlo. Antes de escribirlo ' +
      'guarda una copia byte a byte del original como `<banco>.orig`; si el respaldo ya ' +
      'existe no se pisa. Solo se invierten los campos numéricos (enteros y floats): los ' +
      'nombres de programa y los chunks opacos quedan iguales, y el archivo convertido se ' +
      'vuelve a parsear antes de sustituir al original.',
  })
  @ApiBody({
    type: LibraryBankConvertRequestDto,
    examples: {
      alReves: {
        summary: 'Invertir el orden del banco por defecto',
        value: { libraryRoot: 'C:\\VFX\\Library', plugin: 'MySynth' },
      },
      explicito: {
        summary: 'Forzar el big-endian estándar',
        value: { libraryRoot: 'C:\\VFX\\Library', plugin: 'MySynth', endianness: 'big' },
      },
    },
  })
  @ApiOkResponse({
    description:
      'Banco convertido con el hash de origen y destino, el respaldo `<banco>.orig` y si se ' +
      'creó ahora. `changed: false` indica que ya estaba en ese orden y no se escribió nada.',
    type: LibraryBankConvertResponseDto,
    example: LIBRARY_CONVERT_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description:
      '`libraryRoot` o `plugin` inválidos, `endianness` desconocida o un `defaultFxbName` con ' +
      'separadores de ruta o sin `.fxb`.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    examples: {
      orden: {
        summary: 'endianness desconocida',
        value: { message: 'endianness debe ser "big" o "little"' },
      },
      nombre: {
        summary: 'defaultFxbName con separadores',
        value: {
          message: 'defaultFxbName no puede contener separadores de ruta: "..\\Rhodes.fxb"',
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'El plugin no existe en `plugs\\`.',
    type: LibraryErrorDto,
    example: LIBRARY_PLUGIN_NOT_FOUND_EXAMPLE,
  })
  @ApiConflictResponse({
    description:
      'El plugin no tiene `defaultFxbName` configurado, o el banco que declara no está en su ' +
      'carpeta de presets.',
    type: LibraryErrorDto,
    examples: {
      sinDefecto: {
        summary: 'Sin banco por defecto',
        value: LIBRARY_CONVERT_NO_DEFAULT_EXAMPLE,
      },
      ausente: {
        summary: 'El banco configurado no está en la carpeta',
        value: LIBRARY_CONVERT_MISSING_BANK_EXAMPLE,
      },
    },
  })
  @ApiUnprocessableEntityResponse({
    description:
      'El archivo no es un banco VST2 válido, la conversión lo dejaría inválido o el nombre ' +
      'declara el orden contrario al pedido.',
    type: LibraryErrorDto,
    example: {
      message:
        '"Legacy-le.fxb" declara little-endian en el nombre pero se pidió big-endian; ' +
        'renómbralo antes de convertir',
    },
  })
  async convertDefaultBank(@Body() body: unknown) {
    const record = asRecord(body);
    const endianness = record['endianness'];
    if (endianness !== undefined && endianness !== 'big' && endianness !== 'little') {
      throw new BadRequestException('endianness debe ser "big" o "little"');
    }
    const input: BankConvertInput = {
      libraryRoot: requireString(record, 'libraryRoot'),
      plugin: requireString(record, 'plugin'),
      ...(endianness === undefined ? {} : { endianness }),
    };
    try {
      return await this.service.convertDefaultBank(input);
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('banks/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restaura el banco por defecto desde su respaldo .orig',
    description:
      'Devuelve el `.fxb` que `fxbLoader.config` marca como predeterminado al contenido de ' +
      '`<banco>.orig`, que dejó `banks/convert`, en su misma ruta y con su mismo nombre. ' +
      'El respaldo **solo se lee**: no se renombra ni se reescribe, así que la restauración ' +
      'se puede repetir y el original sigue disponible. Antes de escribir se reparsea el ' +
      'respaldo, y si el banco ya es byte a byte el respaldo no se escribe nada ' +
      '(`changed: false`).',
  })
  @ApiBody({
    type: LibraryBankRestoreRequestDto,
    examples: {
      restaurar: {
        summary: 'Volver al banco original',
        value: { libraryRoot: 'C:\\VFX\\Library', plugin: 'MySynth' },
      },
    },
  })
  @ApiOkResponse({
    description:
      'Banco restaurado con el hash del respaldo usado. `changed: false` indica que ya era ' +
      'el respaldo y no se escribió nada.',
    type: LibraryBankRestoreResponseDto,
    examples: {
      restaurado: {
        summary: 'Restauración con escritura',
        value: LIBRARY_RESTORE_EXAMPLE,
      },
      yaRestaurado: {
        summary: 'El banco ya era el respaldo',
        value: LIBRARY_RESTORE_UNCHANGED_EXAMPLE,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      '`libraryRoot` o `plugin` inválidos, o un `defaultFxbName` con separadores de ruta o ' +
      'sin `.fxb`.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    example: { message: 'defaultFxbName debe terminar en .fxb: "Warm Rhodes.txt"' },
  })
  @ApiNotFoundResponse({
    description: 'El plugin no existe en `plugs\\`.',
    type: LibraryErrorDto,
    example: LIBRARY_PLUGIN_NOT_FOUND_EXAMPLE,
  })
  @ApiConflictResponse({
    description:
      'El plugin no tiene `defaultFxbName` configurado, o no hay `<banco>.orig` que restaurar ' +
      'porque el banco nunca se convirtió.',
    type: LibraryErrorDto,
    examples: {
      sinDefecto: {
        summary: 'Sin banco por defecto',
        value: LIBRARY_CONVERT_NO_DEFAULT_EXAMPLE,
      },
      sinRespaldo: {
        summary: 'No hay respaldo .orig',
        value: LIBRARY_RESTORE_NO_BACKUP_EXAMPLE,
      },
    },
  })
  @ApiUnprocessableEntityResponse({
    description: 'El respaldo está vacío, supera el tamaño máximo o no es un `.fxb` válido.',
    type: LibraryErrorDto,
    example: LIBRARY_RESTORE_INVALID_BACKUP_EXAMPLE,
  })
  async restoreDefaultBank(@Body() body: unknown) {
    const record = asRecord(body);
    const input: BankRestoreInput = {
      libraryRoot: requireString(record, 'libraryRoot'),
      plugin: requireString(record, 'plugin'),
    };
    try {
      return await this.service.restoreDefaultBank(input);
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('banks/discard-backup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Envía el respaldo .orig del banco por defecto a la papelera',
    description:
      'Mueve `<banco>.orig`, la copia que dejó `banks/convert`, a la papelera del sistema ' +
      '(Papelera de reciclaje en Windows) sin tocar el `.fxb` que `fxbLoader.config` marca ' +
      'como predeterminado. El respaldo deja de estar en la carpeta del plugin, pero puede ' +
      'recuperarse desde la papelera: la respuesta dice dónde y cómo. El respaldo no se ' +
      'valida antes de moverlo (descartar uno corrupto es uno de los motivos para hacerlo); ' +
      'se lee solo para devolver su nombre, tamaño y SHA-256.',
  })
  @ApiBody({
    type: LibraryBankDiscardBackupRequestDto,
    examples: {
      descartar: {
        summary: 'Borrar el respaldo del banco por defecto',
        value: { libraryRoot: 'C:\\VFX\\Library', plugin: 'MySynth' },
      },
    },
  })
  @ApiOkResponse({
    description:
      'Respaldo movido a la papelera. El banco por defecto sigue igual y el `.orig` puede ' +
      'recuperarse desde ahí.',
    type: LibraryBankDiscardBackupResponseDto,
    example: LIBRARY_DISCARD_BACKUP_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description:
      '`libraryRoot` o `plugin` inválidos, o un `defaultFxbName` con separadores de ruta o ' +
      'sin `.fxb`.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    example: LIBRARY_SCAN_PATH_ERROR_EXAMPLE,
  })
  @ApiNotFoundResponse({
    description: 'El plugin no existe en `plugs\\`.',
    type: LibraryErrorDto,
    example: LIBRARY_PLUGIN_NOT_FOUND_EXAMPLE,
  })
  @ApiConflictResponse({
    description:
      'El plugin no tiene `defaultFxbName` configurado, o no hay `<banco>.orig` que descartar.',
    type: LibraryErrorDto,
    examples: {
      sinDefecto: {
        summary: 'Sin banco por defecto',
        value: LIBRARY_CONVERT_NO_DEFAULT_EXAMPLE,
      },
      sinRespaldo: {
        summary: 'No hay respaldo .orig',
        value: LIBRARY_DISCARD_NO_BACKUP_EXAMPLE,
      },
    },
  })
  @ApiUnprocessableEntityResponse({
    description:
      'No se pudo mover el respaldo a la papelera; el archivo queda intacto en su sitio.',
    type: LibraryErrorDto,
    example: LIBRARY_DISCARD_TRASH_ERROR_EXAMPLE,
  })
  async discardDefaultBankBackup(@Body() body: unknown) {
    const record = asRecord(body);
    const input: BankDiscardBackupInput = {
      libraryRoot: requireString(record, 'libraryRoot'),
      plugin: requireString(record, 'plugin'),
    };
    try {
      return await this.service.discardDefaultBankBackup(input);
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('banks/inspect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Inspecciona un .fxb y lo compara con los bancos del plugin',
    description:
      'Lee el archivo, valida su formato y calcula su SHA-256. Si se indican `libraryRoot` ' +
      'y `plugin`, lo compara con los bancos que ya están en su carpeta de presets y ' +
      'devuelve el destino y si lo sobrescribiría. **No copia ni modifica nada.**',
  })
  @ApiBody({
    type: LibraryBankInspectRequestDto,
    examples: {
      conPlugin: {
        summary: 'Comparar con los bancos del plugin',
        value: {
          sourcePath: 'C:\\Banks\\Rhodes.fxb',
          libraryRoot: 'C:\\VFX\\Library',
          plugin: 'MySynth',
        },
      },
      soloArchivo: {
        summary: 'Solo validar el archivo',
        value: { sourcePath: 'C:\\Banks\\Rhodes.fxb' },
      },
    },
  })
  @ApiOkResponse({
    description:
      'Inspección correcta. `valid: false` describe un archivo que no es un banco usable, ' +
      'con el detalle en `issues`.',
    type: LibraryBankInspectResponseDto,
    examples: {
      compatible: {
        summary: 'Compatible con un banco del plugin',
        value: LIBRARY_INSPECT_EXAMPLE,
      },
      soloArchivo: {
        summary: 'Sin plugin: solo validación',
        value: LIBRARY_INSPECT_WITHOUT_PLUGIN_EXAMPLE,
      },
      invalido: {
        summary: 'El archivo no es un .fxb',
        value: LIBRARY_INSPECT_INVALID_EXAMPLE,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Ruta no absoluta, archivo ausente, extensión distinta de `.fxb` o tamaño fuera de rango.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    examples: {
      inexistente: { summary: 'No existe', value: LIBRARY_INSPECT_PATH_ERROR_EXAMPLE },
      extension: { summary: 'No es .fxb', value: LIBRARY_INSPECT_EXTENSION_ERROR_EXAMPLE },
    },
  })
  @ApiNotFoundResponse({
    description: 'El plugin no existe en `plugs\\`.',
    type: LibraryErrorDto,
    example: LIBRARY_PLUGIN_NOT_FOUND_EXAMPLE,
  })
  @ApiUnprocessableEntityResponse({
    description: '`programDirName` de la configuración no es un nombre de carpeta simple.',
    type: LibraryErrorDto,
    example: {
      message:
        'programDirName "..\\fuera" no es un nombre de carpeta simple; revisa ' +
        'fxbLoader.config antes de inspeccionar',
    },
  })
  async inspectBank(@Body() body: unknown) {
    const record = asRecord(body);
    const libraryRoot = optionalString(record, 'libraryRoot');
    const plugin = optionalString(record, 'plugin');
    const input: BankInspectInput = {
      sourcePath: requireString(record, 'sourcePath'),
      ...(libraryRoot === undefined ? {} : { libraryRoot }),
      ...(plugin === undefined ? {} : { plugin }),
      ...readBankReference(record),
    };
    try {
      return await this.service.inspectBank(input);
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('uninstall')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Desinstala fxbLoader de un plugin',
    description:
      'Restaura `vfxinfo.tx_`, conserva el modificado como `vfxinfo.loader` y borra ' +
      '`fxbLoader.config`.',
  })
  @ApiBody({
    type: LibraryUninstallRequestDto,
    examples: {
      desinstalacion: {
        summary: 'Desinstalar el cargador',
        value: { libraryRoot: 'C:\\VFX\\Library', plugin: 'MySynth' },
      },
      simulacion: {
        summary: 'Ver el plan sin escribir (dryRun)',
        value: { libraryRoot: 'C:\\VFX\\Library', plugin: 'MySynth', dryRun: true },
      },
    },
  })
  @ApiOkResponse({
    description: 'Plugin restaurado; el DLL y los bancos se conservan.',
    type: LibraryOperationResponseDto,
    examples: {
      desinstalado: {
        summary: 'Desinstalación aplicada',
        value: LIBRARY_UNINSTALL_EXAMPLE,
      },
      dryRun: {
        summary: 'Solo el plan (`dryRun: true`)',
        value: { ...LIBRARY_UNINSTALL_EXAMPLE, plugin: LIBRARY_INSTALLED_PLUGIN_EXAMPLE, dryRun: true },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Ruta o nombre de plugin inválido.',
    type: LibraryErrorDto,
    example: { message: 'libraryRoot debe ser una ruta absoluta: "plugs"' },
  })
  @ApiNotFoundResponse({
    description: 'El plugin no existe en `plugs\\`.',
    type: LibraryErrorDto,
    example: LIBRARY_PLUGIN_NOT_FOUND_EXAMPLE,
  })
  @ApiConflictResponse({
    description: 'No está instalado o falta `vfxinfo.tx_` para restaurar.',
    type: LibraryErrorDto,
    example: LIBRARY_UNINSTALL_CONFLICT_EXAMPLE,
  })
  async uninstall(@Body() body: unknown) {
    const record = asRecord(body);
    const input: UninstallInput = {
      libraryRoot: requireString(record, 'libraryRoot'),
      plugin: requireString(record, 'plugin'),
      dryRun: optionalBoolean(record, 'dryRun'),
    };
    try {
      return await this.service.uninstall(input);
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Instala o desinstala varios plugins de una vez',
    description:
      'El lote que antes hacía la UI con una petición por plugin pasa al servidor: se procesa ' +
      'en serie y en el orden recibido, y cada plugin devuelve su propio resultado. Un fallo ' +
      'individual no detiene al resto. Con `dryRun` solo se calcula el plan de cada uno. ' +
      `Como máximo ${MAX_PLUGINS_PER_BATCH} plugins por petición.`,
  })
  @ApiBody({
    type: LibraryBatchRequestDto,
    examples: {
      instalacion: {
        summary: 'Instalar varios plugins',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          action: 'install',
          plugins: ['MySynth', 'GrandPiano'],
        },
      },
      reconexion: {
        summary: 'Desinstalar varios plugins',
        value: { libraryRoot: 'C:\\VFX\\Library', action: 'uninstall', plugins: ['MySynth'] },
      },
      simulacion: {
        summary: 'Ver el plan de cada plugin sin escribir (dryRun)',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          action: 'install',
          plugins: ['GrandPiano'],
          dryRun: true,
        },
      },
    },
  })
  @ApiOkResponse({
    description:
      'Resultado por plugin (`status`, `message` y `actions`); responde 200 aunque todos ' +
      'fallen, porque el lote ya se ha recorrido entero.',
    type: LibraryBatchResponseDto,
    examples: {
      aplicado: {
        summary: 'Un plugin instalado y otro fallido',
        value: LIBRARY_BATCH_EXAMPLE,
      },
      dryRun: {
        summary: 'Solo el plan (`dryRun: true`)',
        value: LIBRARY_BATCH_DRY_RUN_EXAMPLE,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      '`action` desconocida, `plugins` vacío o por encima del tope, o rutas inválidas: se ' +
      'rechaza el lote entero sin procesar ningún plugin.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    examples: {
      actionInvalida: {
        summary: 'action que no es install ni uninstall',
        value: LIBRARY_BATCH_ACTION_ERROR_EXAMPLE,
      },
      pluginsVacios: {
        summary: 'Sin plugins que procesar',
        value: LIBRARY_BATCH_PLUGINS_ERROR_EXAMPLE,
      },
      demasiadosPlugins: {
        summary: 'Más plugins que el tope por petición',
        value: LIBRARY_BATCH_TOO_MANY_ERROR_EXAMPLE,
      },
      dllRelativa: {
        summary: 'dllSourcePath no absoluta o inexistente',
        value: LIBRARY_DLL_ERROR_EXAMPLE,
      },
    },
  })
  @ApiUnprocessableEntityResponse({
    description: 'El cargador no es PE32 i386; se rechaza el lote antes de tocar ningún plugin.',
    type: LibraryErrorDto,
    example: LIBRARY_BATCH_LOADER_ERROR_EXAMPLE,
  })
  async batch(@Body() body: unknown) {
    const input = readBatchInput(asRecord(body));
    try {
      return await this.service.runBatch(input);
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('batch/stream')
  @ApiOperation({
    summary: 'Instala o desinstala varios plugins informando del progreso',
    description:
      'El mismo lote que `POST /library/batch`, pero la respuesta es NDJSON (una línea JSON por ' +
      'evento) escrita según avanza el servidor: `start` con el total y el orden, dos `plugin` por ' +
      'plugin (`running` y luego el estado final), un `step` por cada paso interno (respaldo, copia ' +
      'del DLL, parcheo de `dll_name`, config y `presets`) y `end` con el resultado completo. Así la ' +
      'vista sabe qué plugin y qué paso se están ejecutando sin esperar al final. La petición se ' +
      'valida entera antes del primer byte: un 400/422 sigue siendo una respuesta JSON normal.',
  })
  @ApiBody({
    type: LibraryBatchRequestDto,
    examples: {
      instalacion: {
        summary: 'Instalar varios plugins',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          action: 'install',
          plugins: ['MySynth', 'GrandPiano'],
        },
      },
      simulacion: {
        summary: 'Ver el progreso de un dryRun',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          action: 'uninstall',
          plugins: ['MySynth'],
          dryRun: true,
        },
      },
    },
  })
  @ApiOkResponse({
    description:
      'Un evento JSON por línea: `start`, por cada plugin un `plugin` con `status: "running"`, sus ' +
      '`step` internos y otro `plugin` con el estado final, y `end` con el mismo resultado que ' +
      '`POST /library/batch`.',
    content: {
      'application/x-ndjson': { schema: { type: 'string' }, example: LIBRARY_BATCH_STREAM_EXAMPLE },
    },
  })
  @ApiBadRequestResponse({
    description: 'Lote inválido: se rechaza antes de escribir ningún evento (respuesta JSON).',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    examples: {
      pluginsVacios: {
        summary: 'Sin plugins que procesar',
        value: LIBRARY_BATCH_PLUGINS_ERROR_EXAMPLE,
      },
      demasiadosPlugins: {
        summary: 'Más plugins que el tope por petición',
        value: LIBRARY_BATCH_TOO_MANY_ERROR_EXAMPLE,
      },
    },
  })
  @ApiUnprocessableEntityResponse({
    description: 'El cargador no es PE32 i386; tampoco se escribe ningún evento.',
    type: LibraryErrorDto,
    example: LIBRARY_BATCH_LOADER_ERROR_EXAMPLE,
  })
  async batchStream(@Body() body: unknown, @Res() response: Response): Promise<void> {
    const input = readBatchInput(asRecord(body));
    let started = false;
    let closed = false;
    response.on('close', () => {
      closed = true;
    });

    /** Primera escritura = cabeceras de la respuesta en streaming. */
    const write = (event: BatchStreamEvent): void => {
      if (closed) return;
      if (!started) {
        started = true;
        response.status(HttpStatus.OK);
        response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        // Un proxy intermedio no debe acumular la respuesta entera.
        response.setHeader('x-accel-buffering', 'no');
      }
      response.write(`${JSON.stringify(event)}\n`);
    };

    try {
      // `start` sale después de validar: mientras no se escriba nada, un error
      // de la petición sigue siendo un 400/422 JSON. Si el cliente corta la
      // respuesta (botón «Cancelar»), `closed` detiene el lote tras el plugin
      // en curso en vez de seguir instalando lo que ya nadie va a ver.
      await this.service.runBatch(input, write, () => closed);
    } catch (error) {
      if (!started) mapDomainError(error);
      // Ya hay eventos enviados: no se puede cambiar el código de estado. Se
      // corta el flujo sin `end`, que es lo que la vista interpreta como fallo.
      response.destroy();
      throw error;
    }

    if (!closed) response.end();
  }
}
