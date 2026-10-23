import { Module } from '@nestjs/common';
import { PluginMetaService } from './plugin-meta.service';

@Module({
  providers: [PluginMetaService],
  exports: [PluginMetaService],
})
export class PluginMetaModule {}
