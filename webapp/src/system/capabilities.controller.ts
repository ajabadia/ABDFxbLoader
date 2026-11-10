import { Controller, Get } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SystemCapabilitiesResponseDto, SYSTEM_CAPABILITIES_EXAMPLE } from './capabilities.dto';

/**
 * Carpetas donde suele estar la libreria: el `_banks\storage` del proyecto (que
 * es donde apunta la app mientras se desarrolla), una instalacion de VFX del
 * usuario y la de fabrica. Es el mismo sondeo por variables de entorno que usa
 * el escaner de captura: no se recorre el disco.
 */
function candidateRoots(): string[] {
  const cwd = process.cwd();
  const home = process.env['USERPROFILE'] || os.homedir();
  return [
    path.join(cwd, '_banks', 'storage'),
    path.join(cwd, '..', '_banks', 'storage'),
    path.join(home, 'VFX', 'Library'),
    'C:\\VFX\\Library',
    cwd,
  ];
}

/** La primera carpeta de las de siempre que contenga `plugs\`. */
async function detectLibraryRoot(): Promise<string | null> {
  for (const candidate of candidateRoots()) {
    try {
      const stat = await fs.stat(path.join(candidate, 'plugs'));
      if (stat.isDirectory()) return path.resolve(candidate);
    } catch {
      // No esta: se prueba la siguiente.
    }
  }
  return null;
}

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
    description: 'Capacidades activas del sistema y la carpeta de libreria detectada, si la hay.',
    type: SystemCapabilitiesResponseDto,
    examples: {
      estandar: {
        summary: 'Capacidades activas en entorno Windows',
        value: SYSTEM_CAPABILITIES_EXAMPLE,
      },
    },
  })
  async getCapabilities(): Promise<SystemCapabilitiesResponseDto> {
    const isWin = process.platform === 'win32';
    const mode = process.env['FXB_APP_MODE'] === 'desktop' ? 'desktop' : 'web-local';

    return {
      mode,
      canCaptureRegistry: isWin,
      canTrash: isWin,
      canRevealInExplorer: isWin,
      canNativePick: isWin,
      canFileSystemAccess: false,
      defaultLibraryRoot: await detectLibraryRoot(),
    };
  }
}
