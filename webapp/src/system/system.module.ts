import { Module } from '@nestjs/common';
import { runPowerShellPicker, PickerService } from './picker.service';
import { SystemController } from './picker.controller';
import { SystemPathsController } from './paths.controller';
import { SystemCapabilitiesController } from './capabilities.controller';
import { PathsService } from './paths.service';

@Module({
  controllers: [SystemController, SystemPathsController, SystemCapabilitiesController],
  providers: [
    {
      provide: PickerService,
      // El servicio no depende de nada más: se construye con el platform del
      // proceso y el diálogo real. Los tests lo instancian a mano con un runner
      // de mentira, así que la factory evita que Nest intente inyectar strings.
      useFactory: () => new PickerService(process.platform, runPowerShellPicker),
    },
    {
      provide: PathsService,
      // `fs.stat` real; los tests la instancian a mano con un stat de mentira.
      useFactory: () => new PathsService(),
    },
  ],
})
export class SystemModule {}
