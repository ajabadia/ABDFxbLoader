import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  PLUGIN_META_SNAPSHOT_EXAMPLE,
  PluginMetaSnapshotDto,
} from '../plugin-meta/plugin-meta.dto';
import type { PluginMetaSnapshot } from '../plugin-meta/plugin-meta.types';
import {
  WIZARD_APPLY_META_EXAMPLE,
  WIZARD_CREATE_FROM_PLUGIN_EXAMPLE,
  WIZARD_CREATE_FROM_PLUGIN_RESPONSE_EXAMPLE,
  WIZARD_CREATE_VFXINFO_EXAMPLE,
  WIZARD_CREATE_VFXINFO_RESULT_EXAMPLE,
  WIZARD_ERROR_EXAMPLE,
  WIZARD_INSTALL_PLUGIN_EXAMPLE,
  WIZARD_INSTALL_PLUGIN_RESPONSE_EXAMPLE,
  WIZARD_LIST_RESPONSE_EXAMPLE,
  WIZARD_RECORD_EXAMPLE,
  WizardApplyMetaDto,
  WizardCreateFromPluginDto,
  WizardCreateFromPluginResultDto,
  WizardCreateVfxinfoDto,
  WizardCreateVfxinfoResultDto,
  WizardErrorDto,
  WizardInstallPluginDto,
  WizardInstallPluginResponseDto,
  WizardListResponseDto,
  WizardMatchQueryDto,
  WizardRecordDto,
} from './wizard.dto';
import { WizardService } from './wizard.service';

@ApiTags('wizards')
@Controller('wizards')
export class WizardController {
  constructor(private readonly wizardService: WizardService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar wizards del repositorio',
    description:
      'Devuelve el listado paginado de wizards disponibles en el repositorio con filtros de búsqueda por nombre, fabricante o género.',
  })
  @ApiQuery({ name: 'query', required: false, description: 'Texto a buscar en nombre, fabricante, dll o ID', example: 'SuperWave' })
  @ApiQuery({ name: 'genre', required: false, description: 'Filtrar por género (Synth, Effect, etc.)', example: 'Synth' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Desplazamiento para paginación', example: 0 })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Límite de elementos (1..100)', example: 20 })
  @ApiQuery({
    name: 'sort',
    required: false,
    description: 'Ordenar por un campo admitido (name, vendor, genre, dllName o id); otro valor usa el orden por defecto',
    example: 'name',
  })
  @ApiQuery({ name: 'dir', required: false, description: 'Dirección del orden: asc o desc (por defecto asc)', example: 'asc' })
  @ApiOkResponse({
    description: 'Listado de wizards paginado',
    type: WizardListResponseDto,
    example: WIZARD_LIST_RESPONSE_EXAMPLE,
  })
  list(
    @Query('query') query?: string,
    @Query('genre') genre?: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
  ): WizardListResponseDto {
    const parsedOffset = offset ? Number.parseInt(offset, 10) : 0;
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 20;

    return this.wizardService.list({
      query,
      genre,
      offset: Number.isNaN(parsedOffset) ? 0 : parsedOffset,
      limit: Number.isNaN(parsedLimit) ? 20 : parsedLimit,
      sort,
      dir,
    });
  }

  @Get('match')
  @ApiOperation({
    summary: 'Buscar wizard coincidente para un plugin',
    description:
      'Busca el mejor wizard disponible para un plugin según su ID VST, nombre o nombre del archivo DLL.',
  })
  @ApiQuery({ name: 'id', required: false, description: 'ID VST numérico del plugin', example: '1398231096' })
  @ApiQuery({ name: 'name', required: false, description: 'Nombre del plugin', example: 'SuperWave P8' })
  @ApiQuery({ name: 'dllName', required: false, description: 'Nombre o ruta de la DLL', example: 'P8.dll' })
  @ApiOkResponse({
    description: 'Wizard coincidente o null si no se encuentra',
    type: WizardRecordDto,
    example: WIZARD_RECORD_EXAMPLE,
  })
  match(@Query() query: WizardMatchQueryDto): WizardRecordDto | null {
    const match = this.wizardService.match(query);
    return (match as WizardRecordDto) ?? null;
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalles completos de un wizard por su ID',
    description: 'Devuelve toda la información, metadatos, dependencias y claves de registro de un wizard específico.',
  })
  @ApiParam({ name: 'id', description: 'ID VST numérico del wizard', example: '1398231096' })
  @ApiOkResponse({
    description: 'Detalles completos del wizard',
    type: WizardRecordDto,
    example: WIZARD_RECORD_EXAMPLE,
  })
  @ApiNotFoundResponse({
    description: 'No se encontró el wizard con ese ID',
    type: WizardErrorDto,
    example: WIZARD_ERROR_EXAMPLE,
  })
  getById(@Param('id') id: string): WizardRecordDto {
    const record = this.wizardService.getById(id);
    if (!record) {
      throw new NotFoundException({ message: `Wizard no encontrado con ID: ${id}` });
    }
    return record as WizardRecordDto;
  }

  @Post('apply-meta')
  @ApiOperation({
    summary: 'Aplicar metadatos del wizard al catálogo del plugin',
    description:
      'Rellena los campos comunes del catálogo extendido (fxbLoader.meta.json) del plugin con la información del wizard.',
  })
  @ApiBody({
    type: WizardApplyMetaDto,
    examples: {
      ejemplo: {
        summary: 'Aplicar metadatos de SuperWave P8',
        value: WIZARD_APPLY_META_EXAMPLE,
      },
    },
  })
  @ApiOkResponse({
    description: 'Catálogo actualizado con los datos del wizard',
    type: PluginMetaSnapshotDto,
    example: PLUGIN_META_SNAPSHOT_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: 'Ruta no válida o parámetro ausente',
    type: WizardErrorDto,
    example: { message: 'Se requiere pluginDir' },
  })
  async applyMeta(@Body() body: WizardApplyMetaDto): Promise<PluginMetaSnapshot> {
    if (!body.pluginDir || body.pluginDir.trim() === '') {
      throw new BadRequestException({ message: 'Se requiere pluginDir' });
    }
    try {
      return await this.wizardService.applyToMeta(body);
    } catch (err) {
      throw new BadRequestException({ message: (err as Error).message });
    }
  }

  @Post('create-vfxinfo')
  @ApiOperation({
    summary: 'Crear vfxinfo.txt desde un wizard',
    description:
      'Genera el archivo vfxinfo.txt en la carpeta del plugin a partir de los parámetros del wizard certificado.',
  })
  @ApiBody({
    type: WizardCreateVfxinfoDto,
    examples: {
      ejemplo: {
        summary: 'Crear vfxinfo.txt para SuperWave P8',
        value: WIZARD_CREATE_VFXINFO_EXAMPLE,
      },
    },
  })
  @ApiOkResponse({
    description: 'Resultado de la creación del vfxinfo.txt',
    type: WizardCreateVfxinfoResultDto,
    example: WIZARD_CREATE_VFXINFO_RESULT_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: 'Ruta no válida o wizard no encontrado',
    type: WizardErrorDto,
    example: { message: 'Se requiere pluginDir' },
  })
  async createVfxinfo(@Body() body: WizardCreateVfxinfoDto): Promise<WizardCreateVfxinfoResultDto> {
    if (!body.pluginDir || body.pluginDir.trim() === '') {
      throw new BadRequestException({ message: 'Se requiere pluginDir' });
    }
    try {
      return await this.wizardService.createVfxinfo(body);
    } catch (err) {
      throw new BadRequestException({ message: (err as Error).message });
    }
  }

  @Post('create-from-plugin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Crear un wizard a partir de un plugin ya instalado en la librería',
    description:
      'Genera un `.vfxwizard` en el catálogo local a partir del `vfxinfo.txt` y el `fxbLoader.meta.json` ' +
      'del plugin. El DLL se localiza dentro de la carpeta del plugin (no en carpetas VST canónicas) y solo ' +
      'se inspecciona para avisar de arquitectura o de un entrypoint VST2 ausente. El wizard queda indexado ' +
      'de inmediato, así que `GET /wizards/match` lo devuelve para ese plugin.',
  })
  @ApiBody({
    type: WizardCreateFromPluginDto,
    examples: {
      ejemplo: {
        summary: 'Crear wizard para un plugin sin wizard certificado',
        value: WIZARD_CREATE_FROM_PLUGIN_EXAMPLE,
      },
    },
  })
  @ApiOkResponse({
    description: 'Wizard creado y ruta del archivo generado',
    type: WizardCreateFromPluginResultDto,
    example: WIZARD_CREATE_FROM_PLUGIN_RESPONSE_EXAMPLE,
  })
  @ApiNotFoundResponse({
    description: 'La carpeta del plugin no existe o no contiene vfxinfo.txt',
    type: WizardErrorDto,
    example: { message: 'No existe la carpeta del plugin: D:\\_banks\\storage\\plugs\\FSynthz-15' },
  })
  @ApiConflictResponse({
    description: 'Ya existe un wizard con ese nombre y no se pidió overwrite',
    type: WizardErrorDto,
    example: { message: 'Ya existe el wizard "15 - SynthEdit.vfxwizard" en el catálogo local; usa overwrite para rehacerlo' },
  })
  async createFromPlugin(
    @Body() body: WizardCreateFromPluginDto,
  ): Promise<WizardCreateFromPluginResultDto> {
    try {
      return await this.wizardService.createFromPlugin(body);
    } catch (err) {
      const msg = (err as Error).message;
      const lower = msg.toLowerCase();
      if (lower.includes('ya existe')) {
        throw new ConflictException({ message: msg });
      }
      if (lower.includes('no existe') || lower.includes('no tiene')) {
        throw new NotFoundException({ message: msg });
      }
      throw new BadRequestException({ message: msg });
    }
  }

  @Post('install')
  @ApiOperation({
    summary: 'Instalar un plugin en la librería activa desde un Wizard',
    description:
      'Copia el DLL proporcionado por el usuario a la subcarpeta del plugin, genera el archivo vfxinfo.txt certificado, inicializa fxbLoader.meta.json y genera claves de registro si son requeridas.',
  })
  @ApiBody({
    type: WizardInstallPluginDto,
    examples: {
      ejemplo: {
        summary: 'Instalar SuperWave P8',
        value: WIZARD_INSTALL_PLUGIN_EXAMPLE,
      },
    },
  })
  @ApiOkResponse({
    description: 'Plugin instalado exitosamente desde el wizard',
    type: WizardInstallPluginResponseDto,
    example: WIZARD_INSTALL_PLUGIN_RESPONSE_EXAMPLE,
  })
  @ApiBadRequestResponse({
    description: 'Parámetros obligatorios ausentes o DLL inválido',
    type: WizardErrorDto,
    example: { message: 'El archivo DLL de origen no existe' },
  })
  @ApiNotFoundResponse({
    description: 'No se encontró el wizard especificado',
    type: WizardErrorDto,
    example: { message: 'Wizard no encontrado con ID: 1398231096' },
  })
  @ApiConflictResponse({
    description: 'El plugin ya existe en destino y no se especificó overwrite',
    type: WizardErrorDto,
    example: { message: 'El plugin "SuperWave P8" ya existe en la librería destino. Usa overwrite para sobrescribir.' },
  })
  async install(@Body() body: WizardInstallPluginDto): Promise<WizardInstallPluginResponseDto> {
    if (!body.wizardId || body.wizardId.trim() === '') {
      throw new BadRequestException({ message: 'wizardId es obligatorio' });
    }
    if (!body.libraryRoot || body.libraryRoot.trim() === '') {
      throw new BadRequestException({ message: 'libraryRoot es obligatorio' });
    }
    if (!body.dllSourcePath || body.dllSourcePath.trim() === '') {
      throw new BadRequestException({ message: 'dllSourcePath es obligatorio' });
    }

    try {
      return await this.wizardService.installPlugin(body);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('no encontrado')) {
        throw new NotFoundException({ message: msg });
      }
      if (msg.includes('ya existe')) {
        throw new ConflictException({ message: msg });
      }
      throw new BadRequestException({ message: msg });
    }
  }
}

