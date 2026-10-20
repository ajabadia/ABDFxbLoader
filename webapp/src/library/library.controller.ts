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
import { FXB_CONFIG_SNAPSHOT_EXAMPLE } from '../fxb-config/fxb-config.dto';
import { FxbConfigConflictError } from '../fxb-config/fxb-config.types';
import {
  LIBRARY_BANKS_LIST_EXAMPLE,
  LIBRARY_DLL_ERROR_EXAMPLE,
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
  LIBRARY_LIBRARY_MISSING_ERROR_EXAMPLE,
  LIBRARY_PLUGIN_NOT_FOUND_EXAMPLE,
  LIBRARY_SCAN_EXAMPLE,
  LIBRARY_SCAN_PATH_ERROR_EXAMPLE,
  LIBRARY_UNINSTALL_CONFLICT_EXAMPLE,
  LIBRARY_UNINSTALL_EXAMPLE,
  LIBRARY_VFXINFO_ERROR_EXAMPLE,
  LibraryBankInspectRequestDto,
  LibraryBankInspectResponseDto,
  LibraryBanksImportErrorDto,
  LibraryBanksImportRequestDto,
  LibraryBanksImportResponseDto,
  LibraryBanksListRequestDto,
  LibraryBanksListResponseDto,
  LibraryConflictErrorDto,
  LibraryErrorDto,
  LibraryInstallRequestDto,
  LibraryOperationResponseDto,
  LibraryScanRequestDto,
  LibraryScanResponseDto,
  LibraryUninstallRequestDto,
} from './library.dto';
import { defaultLoaderDllPath } from './loader-dll';
import { LibraryService } from './library.service';
import {
  LibraryOperationError,
  LibraryPathError,
  PluginNotFoundError,
  PluginStateError,
} from './library.types';
import type {
  BankImportInput,
  BankInspectInput,
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
    schema: {
      oneOf: [
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
      '`vfxinfo.txt` ausente o sin `dll_name`, `fxbLoader.dll` que no es PE32 i386 ' +
      'o plugin de otra arquitectura; no se toca nada.',
    type: LibraryErrorDto,
    examples: {
      vfxinfo: {
        summary: 'vfxinfo.txt sin dll_name',
        value: LIBRARY_VFXINFO_ERROR_EXAMPLE,
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
    const record = asRecord(body);

    const sourcePaths = record['sourcePaths'];
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
      throw new BadRequestException('sourcePaths debe ser un array con al menos una ruta');
    }
    if (!sourcePaths.every((value) => typeof value === 'string' && value.trim() !== '')) {
      throw new BadRequestException('sourcePaths debe contener cadenas no vacías');
    }

    const overwrite = optionalBoolean(record, 'overwrite');
    const input: BankImportInput = {
      libraryRoot: requireString(record, 'libraryRoot'),
      plugin: requireString(record, 'plugin'),
      sourcePaths: sourcePaths as string[],
      ...readBankReference(record),
      ...(overwrite === undefined ? {} : { overwrite }),
    };

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
}
