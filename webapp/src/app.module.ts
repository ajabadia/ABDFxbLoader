import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { BadRequestFilter } from './common/bad-request.filter';
import { FxbConfigModule } from './fxb-config/fxb-config.module';
import { LibraryModule } from './library/library.module';
import { PluginLogModule } from './plugin-log/plugin-log.module';
import { PluginMetaModule } from './plugin-meta/plugin-meta.module';
import { SystemModule } from './system/system.module';
import { WizardModule } from './wizard/wizard.module';

@Module({
  imports: [
    FxbConfigModule,
    LibraryModule,
    PluginLogModule,
    PluginMetaModule,
    SystemModule,
    WizardModule,
  ],
  // Global: cualquier 400 responde el cuerpo que documentan los DTO, también
  // en las apps que montan los tests desde este módulo.
  providers: [{ provide: APP_FILTER, useClass: BadRequestFilter }],
})
export class AppModule {}
