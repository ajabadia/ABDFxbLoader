import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { PluginLogService } from './plugin-log.service';
import {
  PLUGIN_LOG_BAD_REQUEST_EXAMPLE,
  PLUGIN_LOG_EMPTY_EXAMPLE,
  PLUGIN_LOG_SNAPSHOT_EXAMPLE,
  PluginLogPathErrorDto,
  PluginLogSnapshotDto,
} from './plugin-log.dto';

@ApiTags('plugin-log')
@Controller('plugins')
export class PluginLogController {
  constructor(private readonly service: PluginLogService) {}

  @Get(':id/log')
  @ApiOperation({
    summary: 'Lee el log (fxbLoader.log) de un plugin',
    description:
      'Lee el archivo activo y rotados concatenados en orden cronológico. ' +
      'Si el archivo aún no existe, devuelve exists: false con lista vacía sin error.',
  })
  @ApiParam({
    name: 'id',
    description: 'Identificador o nombre de carpeta del plugin.',
    example: 'MySynth',
  })
  @ApiQuery({
    name: 'dir',
    description: 'Directorio absoluto del plugin.',
    example: 'C:\\VFX\\plugs\\MySynth',
  })
  @ApiOkResponse({
    description:
      'Snapshot del log del plugin con entradas y texto concatenado. ' +
      'Un plugin sin log responde el mismo 200 con exists: false y listas vacías.',
    type: PluginLogSnapshotDto,
    examples: {
      conEntradas: {
        summary: 'Plugin con dos operaciones en el archivo activo',
        value: PLUGIN_LOG_SNAPSHOT_EXAMPLE,
      },
      sinLog: {
        summary: 'Plugin que todavía no escribió su log',
        value: PLUGIN_LOG_EMPTY_EXAMPLE,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'dir ausente o inválido.',
    type: PluginLogPathErrorDto,
    example: PLUGIN_LOG_BAD_REQUEST_EXAMPLE,
  })
  async readLog(
    @Param('id') _id: string,
    @Query('dir') dir?: string,
  ): Promise<PluginLogSnapshotDto> {
    if (!dir || typeof dir !== 'string' || dir.trim() === '') {
      throw new BadRequestException('dir es obligatorio y debe ser una cadena');
    }
    return this.service.read(dir);
  }
}
