import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SystemCapabilitiesResponseDto, SYSTEM_CAPABILITIES_EXAMPLE } from './capabilities.dto';

@ApiTags('system')
@Controller('system/capabilities')
export class SystemCapabilitiesController {
  @Get()
  @ApiOperation({
    summary: 'Capacidades del entorno de ejecución',
    description:
      'Devuelve qué características del sistema operativo (diálogos nativos, papelera de reciclaje, registro de Windows, explorador) están disponibles según el modo (desktop .exe o web local).',
  })
  @ApiOkResponse({
    description: 'Capacidades activas del sistema',
    type: SystemCapabilitiesResponseDto,
    examples: {
      estandar: {
        summary: 'Capacidades activas en entorno Windows',
        value: SYSTEM_CAPABILITIES_EXAMPLE,
      },
    },
  })
  getCapabilities(): SystemCapabilitiesResponseDto {
    const isWin = process.platform === 'win32';
    const mode = process.env['FXB_APP_MODE'] === 'desktop' ? 'desktop' : 'web-local';

    return {
      mode,
      canCaptureRegistry: isWin,
      canTrash: isWin,
      canRevealInExplorer: isWin,
      canNativePick: isWin,
      canFileSystemAccess: false,
    };
  }
}
