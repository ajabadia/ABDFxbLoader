import { Module } from '@nestjs/common';
import { WizardModule } from '../wizard/wizard.module';
import { WizardService } from '../wizard/wizard.service';
import { runPowerShellDrives } from './drives';
import { VMachineController } from './vmachine.controller';
import { VMachineService } from './vmachine.service';

@Module({
  imports: [WizardModule],
  controllers: [VMachineController],
  providers: [
    {
      provide: VMachineService,
      inject: [WizardService],
      // El servicio se construye con el platform del proceso, el runner real y el
      // catálogo de wizards: los tests lo instancian a mano con una tabla de
      // mentira y un catálogo vacío en vez de lanzar PowerShell.
      useFactory: (wizards: WizardService) =>
        new VMachineService(process.platform, runPowerShellDrives, (query) => {
          const record = wizards.matchExact(query);
          return record === null
            ? null
            : { id: record.id, name: record.name, version: record.version };
        }),
    },
  ],
})
export class VMachineModule {}
