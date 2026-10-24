import { Module } from '@nestjs/common';
import { PluginMetaController } from './plugin-meta.controller';
import { PluginMetaService } from './plugin-meta.service';

@Module({
  controllers: [PluginMetaController],
  providers: [PluginMetaService],
  exports: [PluginMetaService],
})
export class PluginMetaModule {}
