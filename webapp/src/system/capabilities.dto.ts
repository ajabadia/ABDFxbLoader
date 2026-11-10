import { ApiProperty } from '@nestjs/swagger';

export type AppDeliveryMode = 'desktop' | 'web-local' | 'web-remote';

export class SystemCapabilitiesResponseDto {
  @ApiProperty({
    description: 'Modo de entrega y ejecución de la aplicación',
    enum: ['desktop', 'web-local', 'web-remote'],
    example: 'web-local',
  })
  mode!: AppDeliveryMode;

  @ApiProperty({
    description:
      'Carpeta de libreria encontrada en el disco cuando aun no hay ninguna configurada ' +
      '(`null` si ninguna de las carpetas de siempre contiene `plugs\\`).',
    type: String,
    nullable: true,
    required: false,
    example: 'D:\\_banks\\storage',
  })
  defaultLibraryRoot?: string | null;

  @ApiProperty({
    description: 'Indica si puede tomar instantáneas y diffs del Registro de Windows',
    example: true,
  })
  canCaptureRegistry!: boolean;

  @ApiProperty({
    description: 'Indica si puede enviar archivos a la Papelera de reciclaje de Windows',
    example: true,
  })
  canTrash!: boolean;

  @ApiProperty({
    description: 'Indica si puede revelar archivos en el Explorador de Windows (explorer.exe)',
    example: true,
  })
  canRevealInExplorer!: boolean;

  @ApiProperty({
    description: 'Indica si puede abrir diálogos nativos del sistema operativo (PowerShell/Win32)',
    example: true,
  })
  canNativePick!: boolean;

  @ApiProperty({
    description: 'Indica si el entorno soporta File System Access API (navegador)',
    example: false,
  })
  canFileSystemAccess!: boolean;
}

export const SYSTEM_CAPABILITIES_EXAMPLE: SystemCapabilitiesResponseDto = {
  mode: 'web-local',
  canCaptureRegistry: true,
  canTrash: true,
  canRevealInExplorer: true,
  canNativePick: true,
  canFileSystemAccess: false,
  defaultLibraryRoot: 'D:\\_banks\\storage',
};
