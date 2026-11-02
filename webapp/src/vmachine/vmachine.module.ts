import { Module } from '@nestjs/common';
import { runPowerShellDrives } from './drives';
import { VMachineController } from './vmachine.controller';
import { VMachineService } from './vmachine.service';

@Module({
  controllers: [VMachineController],
  providers: [
    {
      provide: VMachineService,
      // El servicio se construye con el platform del proceso y el runner real,
      // igual que el selector de rutas: los tests lo instancian a mano con una
      // tabla de mentira en vez de lanzar PowerShell.
      useFactory: () => new VMachineService(process.platform, runPowerShellDrives),
    },
  ],
})
export class VMachineModule {}
