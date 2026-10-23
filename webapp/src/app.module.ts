import { Module } from '@nestjs/common';
import { FxbConfigModule } from './fxb-config/fxb-config.module';
import { LibraryModule } from './library/library.module';
import { PluginMetaModule } from './plugin-meta/plugin-meta.module';
import { SystemModule } from './system/system.module';

@Module({
  imports: [FxbConfigModule, LibraryModule, PluginMetaModule, SystemModule],
})
export class AppModule {}
