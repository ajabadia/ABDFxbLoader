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
  LIBRARY_DLL_PREFERENCE_ERROR_EXAMPLE,
  LIBRARY_DLL_PREFERENCE_EXAMPLE,
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
  LIBRARY_PLUGIN_WITH_LOADER_EXAMPLE,
  LIBRARY_LOADER_ADD_CONFLICT_EXAMPLE,
  LIBRARY_LOADER_ADD_DRY_RUN_EXAMPLE,
  LIBRARY_LOADER_ADD_EXAMPLE,
  LIBRARY_MISSING_PLUGIN_DLL_ERROR_EXAMPLE,
  LIBRARY_LIBRARY_MISSING_ERROR_EXAMPLE,
  LIBRARY_PLUGIN_NOT_FOUND_EXAMPLE,
  LIBRARY_RESTORE_EXAMPLE,
  LIBRARY_RESTORE_INVALID_BACKUP_EXAMPLE,
  LIBRARY_RESTORE_NO_BACKUP_EXAMPLE,
  LIBRARY_RESTORE_UNCHANGED_EXAMPLE,
  LIBRARY_SCAN_EXAMPLE,
  LIBRARY_SCAN_PATH_ERROR_EXAMPLE,
  LIBRARY_LOADER_REMOVE_CONFLICT_EXAMPLE,
  LIBRARY_LOADER_REMOVE_EXAMPLE,
  LIBRARY_VFXINFO_ERROR_EXAMPLE,
  LIBRARY_CREATE_CUSTOM_PLUGIN_EXAMPLE,
  LIBRARY_CREATE_CUSTOM_PLUGIN_RESPONSE_EXAMPLE,
  LIBRARY_INSPECT_DLL_EXAMPLE,
  LIBRARY_INSPECT_DLL_RESPONSE_EXAMPLE,
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
  LibraryBanksCreateRequestDto,
  LibraryBanksCreateResponseDto,
  LIBRARY_BANK_CREATE_EXAMPLE,
  LIBRARY_BANK_CREATE_NO_ID_ERROR_EXAMPLE,
  LibraryBanksListRequestDto,
  LibraryBanksListResponseDto,
  LibraryBankRestoreRequestDto,
  LibraryBankRestoreResponseDto,
  LibraryBatchRequestDto,
  LibraryBatchResponseDto,
  LibraryConflictErrorDto,
  LibraryCreateCustomPluginDto,
  LibraryCreateCustomPluginResponseDto,
  LibraryDllPreferenceRequestDto,
  LibraryDllPreferenceResponseDto,
  LibraryErrorDto,
  LibraryInspectDllDto,
  LibraryInspectDllResponseDto,
  LibraryLoaderAddRequestDto,
  LibraryOperationResponseDto,
  LibraryScanRequestDto,
  LibraryScanResponseDto,
  LibraryLoaderRemoveRequestDto,
} from './library.dto';
import { defaultLoaderDllPath } from './loader-dll';
import { LibraryAuditService } from './library-audit.service';
import {
  LIBRARY_AUDIT_EXAMPLE,
  LIBRARY_AUDIT_REQUEST_EXAMPLE,
  LibraryAuditRequestDto,
  LibraryAuditResultDto,
} from './library-audit.dto';
import { MAX_PLUGINS_PER_BATCH } from '../client/batch-stream';
import type { BankImportStreamEvent } from '../client/bank-import-stream';
import { LibraryService } from './library.service';
import {
  DllPreferenceError,
  LibraryOperationError,
  LibraryPathError,
  PluginNotFoundError,
  PluginStateError,
} from './library.types';
import type {
  BankConvertInput,
  BankCreateInput,
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
function readProgramNames(body: Record<string, unknown>): string[] {
  const value = body['programNames'];
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestException('programNames debe ser un array con al menos un nombre');
  }
  if (!value.every((item) => typeof item === 'string')) {
    throw new BadRequestException('programNames debe contener cadenas');
  }
  return value as string[];
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
  if (value === 'add' || value === 'remove') return value;
  throw new BadRequestException('action debe ser "add" o "remove"');
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
  if (error instanceof DllPreferenceError) {
    // La preferencia inválida es un contenido rechazable del cliente: como
    // `vfxinfo.txt` sin `dll_name`, es 422 y no 400.
    throw new UnprocessableEntityException({ message: error.message });
  }
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

import { LibraryImportService } from './library-import.service';
import {
  IMPORT_PACKAGE_EXAMPLE,
  IMPORT_PACKAGE_RESULT_EXAMPLE,
  INSPECT_PACKAGE_EXAMPLE,
  INSPECT_PACKAGE_RESULT_EXAMPLE,
  ImportPackageDto,
  ImportPackageResultDto,
  InspectPackageDto,
  InspectPackageResultDto,
} from './library-import.dto';

@ApiTags('library')
@ApiExtraModels(LibraryErrorDto, LibraryConflictErrorDto, LibraryBanksImportErrorDto)
@Controller('library')
export class LibraryController {
  constructor(
    private readonly service: LibraryService,
    private readonly importService: LibraryImportService,
    private readonly auditService: LibraryAuditService,
  ) {}

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

  @Post('audit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Audita los datos de los plugins de la librería',
    description:
      'Recorre `plugs\\*` en modo lectura y devuelve, por plugin, los campos que faltan en `vfxinfo.txt` ' +
      'y en `fxbLoader.meta.json`, el estado del DLL (arquitectura y entrypoint VST) y qué valores se ' +
      'pueden rellenar automáticamente, indicando si salen del vfxinfo, del meta, del DLL o son derivados. ' +
      'No modifica ningún archivo.',
  })
  @ApiBody({
    type: LibraryAuditRequestDto,
    examples: { libreria: { summary: 'Auditar la librería activa', value: LIBRARY_AUDIT_REQUEST_EXAMPLE } },
  })
  @ApiOkResponse({
    description: 'Resumen y detalle por plugin.',
    type: LibraryAuditResultDto,
    example: LIBRARY_AUDIT_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: '`libraryRoot` ausente, relativo, inexistente o sin carpeta `plugs\\`.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    examples: {
      rutaRelativa: { summary: 'Ruta relativa', value: LIBRARY_SCAN_PATH_ERROR_EXAMPLE },
      sinPlugs: { summary: 'La carpeta existe pero no tiene plugs\\', value: LIBRARY_LIBRARY_MISSING_ERROR_EXAMPLE },
    },
  })
  async audit(@Body() body: unknown) {
    const record = asRecord(body);
    try {
      return await this.auditService.audit(requireString(record, 'libraryRoot'));
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('plugin-dll-preference')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Guarda la preferencia local de DLL de un plugin',
    description:
      'Escribe el valor pedido en la línea `dll_name` de `vfxinfo.txt` del plugin. La DLL ' +
      'debe existir dentro de la carpeta del plugin: la ruta origen nunca se altera. Si el ' +
      'respaldo `vfxinfo.tx_` todavía no existe se crea en este primer guardado; si el ' +
      'valor pedido ya es el vigente no se toca nada (`changed: false`).',
  })
  @ApiBody({
    type: LibraryDllPreferenceRequestDto,
    examples: {
      cambio: {
        summary: 'Guardar una DLL concreta del plugin',
        value: {
          pluginDir: 'C:\\VFX\\Library\\plugs\\MySynth',
          dllName: 'Synth64.dll',
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Preferencia guardada (o ya vigente). `actions` describe los pasos hechos.',
    type: LibraryDllPreferenceResponseDto,
    example: LIBRARY_DLL_PREFERENCE_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: '`pluginDir` ausente o no absoluto.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    examples: {
      ruta: {
        summary: 'pluginDir no es absoluto',
        value: { message: 'pluginDir debe ser una ruta absoluta: "MySynth"' },
      },
    },
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`dllName` vacío, con NUL, absoluto, fuera del plugin, sin archivo en disco, o ' +
      '`vfxinfo.txt` ausente o sin línea `dll_name`.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    examples: {
      fuera: {
        summary: 'dllName sale de la carpeta del plugin',
        value: LIBRARY_DLL_PREFERENCE_ERROR_EXAMPLE,
      },
    },
  })
  async updateDllPreference(@Body() body: unknown) {
    const record = asRecord(body);
    const input = {
      pluginDir: requireString(record, 'pluginDir'),
      dllName: requireString(record, 'dllName'),
    };
    try {
      return await this.service.updateDllPreference(input);
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('loader/add')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pone el cargador en un plugin',
    description:
      'Respalda `vfxinfo.txt` como `vfxinfo.tx_`, copia el DLL, reescribe `dll_name` ' +
      'y crea `fxbLoader.config` + `presets\\`.',
  })
  @ApiBody({
    type: LibraryLoaderAddRequestDto,
    examples: {
      cargador: {
        summary: 'Poner el cargador usando el DLL del repositorio',
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
      puesto: {
        summary: 'Cargador puesto',
        value: LIBRARY_LOADER_ADD_EXAMPLE,
      },
      dryRun: {
        summary: 'Solo el plan (`dryRun: true`)',
        value: LIBRARY_LOADER_ADD_DRY_RUN_EXAMPLE,
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
      'El plugin ya tiene el cargador (usa `force`) o `fxbLoader.config` cambió entre la ' +
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
        value: LIBRARY_LOADER_ADD_CONFLICT_EXAMPLE,
      },
      configCambiada: {
        summary: 'Config modificada por la DLL mientras se ponía el cargador',
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
  async addLoader(@Body() body: unknown) {
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
        summary: 'Bancos de un plugin con el cargador',
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

    @Post('banks/create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Crea un banco .fxb desde cero (programas o chunk opaco)',
    description:
      'Genera un banco `CcnK/FxBk` con programas `FxCk` (`numParams` parámetros a 0) o, si llega ' +
      '`chunkHex`, un banco `CcnK/FBCh` con el chunk opaco del plugin (bancos de plugins con ' +
      'estado que no exponen parámetros). Lo escribe en `<plugin>\\<programDirName>\\`. ' +
      'El FourCC sale del `id` de `vfxinfo.txt` del propio plugin: con vfxinfo ausente o sin `id` ' +
      'no hay banco que generar. `programNames` y `numParams` no se admiten en modo chunk.',
  })
  @ApiBody({
    type: LibraryBanksCreateRequestDto,
    examples: {
      basico: {
        summary: 'Banco de inicialización con tres programas',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          plugin: 'MySynth',
          bankName: 'Init Bank.fxb',
          programNames: ['Init', 'Bright Rhodes', 'Dark Rhodes'],
        },
      },
      conParametros: {
        summary: 'Con parámetros a cero y versión del plugin',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          plugin: 'MySynth',
          programNames: ['Init'],
          numParams: 12,
          fxVersion: 1000,
        },
      },
      chunkOpaco: {
        summary: 'Banco FBCh con el chunk opaco del plugin',
        description:
          'Banco `CcnK/FBCh` versión 2 para un plugin con estado: el chunk hex ' +
          'es íntegro el que devolvería `getChunk`, sin recortes.',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          plugin: 'MySynth',
          bankName: 'Estado del sínt.fxb',
          mode: 'chunk',
          chunkHex: 'beef cafe',
          chunkVersion: 2,
          currentProgram: 0,
          chunkNumPrograms: 0,
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'El banco quedó escrito y revalidado.',
    type: LibraryBanksCreateResponseDto,
    example: LIBRARY_BANK_CREATE_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description:
      'Petición mal formada: `programNames` vacío o no cadenas, `numParams`/`fxVersion` ' +
      'fuera de rango, `chunkHex` vacío o no hexadecimal, `chunkVersion` distinta de 1/2, ' +
      'para `programNames`/`numParams` en modo chunk, ' +
      '`bankName` con separadores de ruta o `libraryRoot` inexistente.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    examples: {
      sinProgramas: {
        summary: 'Lista de programas vacía',
        value: { message: 'programNames debe contener al menos un programa' },
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
      'El archivo ya existe con `overwrite=false`, el plugin no tiene `vfxinfo.txt` o este ' +
      'no tiene línea `id`.',
    schema: { $ref: getSchemaPath(LibraryErrorDto) },
    examples: {
      sinId: {
        summary: 'vfxinfo sin línea `id`',
        value: LIBRARY_BANK_CREATE_NO_ID_ERROR_EXAMPLE,
      },
    },
  })
  async createBank(@Body() body: unknown) {
    const record = asRecord(body);
    const mode = typeof record['mode'] === 'string' ? record['mode'] : undefined;
    if (mode !== undefined && mode !== 'programNames' && mode !== 'chunk') {
      throw new BadRequestException('mode debe ser "programNames" o "chunk"');
    }
    const hasChunk = record['chunkHex'] !== undefined || mode === 'chunk';
    if (mode === 'chunk' && record['chunkHex'] === undefined) {
      throw new BadRequestException('mode "chunk" exige chunkHex con el contenido opaco del plugin');
    }
    if (hasChunk) {
      // El banco FBCh lleva un chunk opaco, no programas FxCk: explicitarlo es
      // un error, no algo que el endpoint ignore en silencio.
      if (Array.isArray(record['programNames']) && record['programNames'].length > 0) {
        throw new BadRequestException('en modo chunk no se admiten programNames');
      }
      if (record['numParams'] !== undefined) {
        throw new BadRequestException('en modo chunk no se admite numParams');
      }
    }
    const input: BankCreateInput = {
      libraryRoot: requireString(record, 'libraryRoot'),
      plugin: requireString(record, 'plugin'),
      // En modo chunk el banco lleva un chunk opaco, así que `programNames` no
      // hace falta; fuera del chunk, manda la validación de siempre.
      ...(hasChunk ? {} : { programNames: readProgramNames(record) }),
      ...(typeof record['bankName'] === 'string' ? { bankName: record['bankName'] } : {}),
      ...(record['numParams'] === undefined ? {} : { numParams: record['numParams'] as number }),
      ...(record['fxVersion'] === undefined ? {} : { fxVersion: record['fxVersion'] as number }),
      ...(optionalBoolean(record, 'overwrite') === undefined
        ? {}
        : { overwrite: optionalBoolean(record, 'overwrite') }),
      ...(hasChunk ? { mode: 'chunk' as const } : {}),
      ...(record['chunkHex'] === undefined
        ? {}
        : { chunkHex: typeof record['chunkHex'] === 'string' ? record['chunkHex'] : '' }),
      ...(record['chunkVersion'] === undefined
        ? {}
        : { chunkVersion: record['chunkVersion'] as 1 | 2 }),
      ...(record['currentProgram'] === undefined
        ? {}
        : { currentProgram: record['currentProgram'] as number }),
      ...(record['chunkNumPrograms'] === undefined
        ? {}
        : { chunkNumPrograms: record['chunkNumPrograms'] as number }),
      ...(record['endianness'] === undefined
        ? {}
        : {
            endianness:
              record['endianness'] === 'big' || record['endianness'] === 'little'
                ? record['endianness']
                : (record['endianness'] as never),
          }),
    };
    try {
      return await this.service.createBank(input);
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

  @Post('loader/remove')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Quita el cargador de un plugin',
    description:
      'Restaura `vfxinfo.tx_`, conserva el modificado como `vfxinfo.loader` y borra ' +
      '`fxbLoader.config`.',
  })
  @ApiBody({
    type: LibraryLoaderRemoveRequestDto,
    examples: {
      sinCargador: {
        summary: 'Quitar el cargador',
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
      quitado: {
        summary: 'Cargador quitado',
        value: LIBRARY_LOADER_REMOVE_EXAMPLE,
      },
      dryRun: {
        summary: 'Solo el plan (`dryRun: true`)',
        value: { ...LIBRARY_LOADER_REMOVE_EXAMPLE, plugin: LIBRARY_PLUGIN_WITH_LOADER_EXAMPLE, dryRun: true },
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
    description: 'No tiene el cargador o falta `vfxinfo.tx_` para restaurar.',
    type: LibraryErrorDto,
    example: LIBRARY_LOADER_REMOVE_CONFLICT_EXAMPLE,
  })
  async removeLoader(@Body() body: unknown) {
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
    summary: 'Pone o quita el cargador en varios plugins de una vez',
    description:
      'El lote que antes hacía la UI con una petición por plugin pasa al servidor: se procesa ' +
      'en serie y en el orden recibido, y cada plugin devuelve su propio resultado. Un fallo ' +
      'individual no detiene al resto. Con `dryRun` solo se calcula el plan de cada uno. ' +
      `Como máximo ${MAX_PLUGINS_PER_BATCH} plugins por petición.`,
  })
  @ApiBody({
    type: LibraryBatchRequestDto,
    examples: {
      cargador: {
        summary: 'Poner el cargador en varios plugins',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          action: 'add',
          plugins: ['MySynth', 'GrandPiano'],
        },
      },
      sinCargador: {
        summary: 'Quitar el cargador en varios plugins',
        value: { libraryRoot: 'C:\\VFX\\Library', action: 'remove', plugins: ['MySynth'] },
      },
      simulacion: {
        summary: 'Ver el plan de cada plugin sin escribir (dryRun)',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          action: 'add',
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
        summary: 'Un plugin con el cargador y otro fallido',
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
        summary: 'action que no es add ni remove',
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
      cargador: {
        summary: 'Poner el cargador en varios plugins',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          action: 'add',
          plugins: ['MySynth', 'GrandPiano'],
        },
      },
      simulacion: {
        summary: 'Ver el progreso de un dryRun',
        value: {
          libraryRoot: 'C:\\VFX\\Library',
          action: 'remove',
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

  @Post('inspect-package')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Inspecciona un paquete externo (.vfxlibrary o carpeta de plugin)',
    description:
      'Analiza la ruta de origen para detectar plugins y bancos presentes, ' +
      'y evalúa colisiones contra la librería de destino activa.',
  })
  @ApiBody({
    type: InspectPackageDto,
    examples: {
      paquete: {
        summary: 'Inspeccionar .vfxlibrary externa',
        value: INSPECT_PACKAGE_EXAMPLE,
      },
    },
  })
  @ApiOkResponse({
    description: 'Resumen de plugins y bancos encontrados',
    type: InspectPackageResultDto,
    example: INSPECT_PACKAGE_RESULT_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: 'La ruta no existe o es inválida',
    type: LibraryErrorDto,
    example: { message: 'packagePath es obligatorio y debe ser una ruta absoluta existente' },
  })
  @ApiUnprocessableEntityResponse({
    description: 'El directorio no contiene una estructura reconocible de librería o plugin',
    type: LibraryErrorDto,
    example: { message: 'El paquete no contiene subcarpetas plugs/ ni bancos reconocibles' },
  })
  async inspectPackage(@Body() body: InspectPackageDto): Promise<InspectPackageResultDto> {
    try {
      return await this.importService.inspect(body);
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('import-package')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Importa plugins y bancos desde un paquete externo hacia la librería activa',
    description:
      'Copia de forma atómica y segura los instrumentos y bancos seleccionados ' +
      'hacia `<targetLibraryRoot>/plugs/` y `<targetLibraryRoot>/banks/`.',
  })
  @ApiBody({
    type: ImportPackageDto,
    examples: {
      importar: {
        summary: 'Importar paquete completo con política skip',
        value: IMPORT_PACKAGE_EXAMPLE,
      },
    },
  })
  @ApiOkResponse({
    description: 'Resultado de la importación con elementos copiados y omitidos',
    type: ImportPackageResultDto,
    example: IMPORT_PACKAGE_RESULT_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: 'Rutas o parámetros inválidos',
    type: LibraryErrorDto,
    example: { message: 'targetLibraryRoot debe ser una ruta absoluta a una librería VFX' },
  })
  async importPackage(@Body() body: ImportPackageDto): Promise<ImportPackageResultDto> {
    try {
      return await this.importService.importPackage(body);
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('inspect-dll')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Inspecciona estáticamente un archivo DLL para detectar exportaciones VST y compatibilidad PE32',
    description:
      'Analiza la cabecera PE, arquitectura (32/64 bits) y exportaciones como `VSTPluginMain` o `main` ' +
      'sin ejecutar código nativo. Comprueba además si existe un wizard certificado coincidente.',
  })
  @ApiBody({
    type: LibraryInspectDllDto,
    examples: {
      inspect: {
        summary: 'Inspección de DLL VST de 32 bits',
        value: LIBRARY_INSPECT_DLL_EXAMPLE,
      },
    },
  })
  @ApiOkResponse({
    description: 'Diagnóstico de la cabecera PE y compatibilidad VST',
    type: LibraryInspectDllResponseDto,
    example: LIBRARY_INSPECT_DLL_RESPONSE_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: 'La ruta al DLL es inválida o no es absoluta',
    type: LibraryErrorDto,
    example: { message: 'dllPath es obligatorio y debe ser una ruta absoluta' },
  })
  @ApiNotFoundResponse({
    description: 'El archivo DLL no existe en disco',
    type: LibraryErrorDto,
    example: { message: 'No existe el archivo DLL: "C:\\Vst\\Synth.dll"' },
  })
  async inspectDll(@Body() body: LibraryInspectDllDto): Promise<LibraryInspectDllResponseDto> {
    try {
      return await this.service.inspectDll(body);
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post('create-custom-plugin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Crea un nuevo instrumento o efecto en la librería a partir de un DLL externo sin wizard previo',
    description:
      'Copia el DLL dentro de `<libraryRoot>/plugs/<folderName>/`, genera `vfxinfo.txt` con la identidad VST, ' +
      'crea `presets/` y `fxbLoader.meta.json`, y opcionalmente exporta un `.vfxwizard` en el catálogo local.',
  })
  @ApiBody({
    type: LibraryCreateCustomPluginDto,
    examples: {
      crear: {
        summary: 'Creación guiada de plugin VST2 personalizado',
        value: LIBRARY_CREATE_CUSTOM_PLUGIN_EXAMPLE,
      },
    },
  })
  @ApiOkResponse({
    description: 'Resultado de la creación del plugin y rutas de los archivos generados',
    type: LibraryCreateCustomPluginResponseDto,
    example: LIBRARY_CREATE_CUSTOM_PLUGIN_RESPONSE_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: 'Parámetros o rutas inválidas',
    type: LibraryErrorDto,
    example: { message: 'folderName debe ser un nombre simple de directorio' },
  })
  @ApiNotFoundResponse({
    description: 'El archivo DLL origen no existe',
    type: LibraryErrorDto,
    example: { message: 'No existe el archivo DLL origen: "C:\\Vst\\NewSynth.dll"' },
  })
  @ApiConflictResponse({
    description: 'La carpeta del plugin ya existe y no se especificó overwrite',
    type: LibraryErrorDto,
    example: { message: 'Ya existe una carpeta para el plugin en: "C:\\VFX\\Library\\plugs\\NewSynth"' },
  })
  async createCustomPlugin(
    @Body() body: LibraryCreateCustomPluginDto,
  ): Promise<LibraryCreateCustomPluginResponseDto> {
    try {
      return await this.service.createCustomPlugin(body);
    } catch (error) {
      mapDomainError(error);
    }
  }
}
