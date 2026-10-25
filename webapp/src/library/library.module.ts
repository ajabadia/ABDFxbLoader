import { Module } from '@nestjs/common';
import { AssociationAuditModule } from '../association-audit/association-audit.module';
import { FxbConfigModule } from '../fxb-config/fxb-config.module';
import { PluginLogModule } from '../plugin-log/plugin-log.module';
import { PluginMetaModule } from '../plugin-meta/plugin-meta.module';
import { WizardModule } from '../wizard/wizard.module';
import { LibraryImportService } from './library-import.service';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';

@Module({
  imports: [FxbConfigModule, AssociationAuditModule, PluginLogModule, WizardModule, PluginMetaModule],
  controllers: [LibraryController],
  providers: [LibraryService, LibraryImportService],
  exports: [LibraryService, LibraryImportService],
})
export class LibraryModule {}

// Re-export del módulo nativo para que el código de la UI y los tests puedan
// usar la puerta que reemplaza a `vst/fxbLoader.dll` sin importar el módulo
// concreto.
export * as fxbLoaderNativeModule from './fxbLoader-native';
