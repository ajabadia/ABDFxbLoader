import { Module } from '@nestjs/common';
import { AssociationAuditModule } from '../association-audit/association-audit.module';
import { FxbConfigModule } from '../fxb-config/fxb-config.module';
import { PluginLogModule } from '../plugin-log/plugin-log.module';
import { PluginMetaModule } from '../plugin-meta/plugin-meta.module';
import { WizardModule } from '../wizard/wizard.module';
import { LibraryAuditService } from './library-audit.service';
import { LibraryImportService } from './library-import.service';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';
import { VfxBanksController } from './vfx-banks.controller';
import { VfxBanksService } from './vfx-banks.service';

@Module({
  imports: [FxbConfigModule, AssociationAuditModule, PluginLogModule, WizardModule, PluginMetaModule],
  controllers: [LibraryController, VfxBanksController],
  providers: [LibraryService, LibraryImportService, LibraryAuditService, VfxBanksService],
  exports: [LibraryService, LibraryImportService, LibraryAuditService, VfxBanksService],
})
export class LibraryModule {}

// Re-export del módulo nativo para que el código de la UI y los tests puedan
// usar la puerta que reemplaza a `vst/fxbLoader.dll` sin importar el módulo
// concreto.
export * as fxbLoaderNativeModule from './fxbLoader-native';
