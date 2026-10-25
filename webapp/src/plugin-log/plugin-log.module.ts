import { Module } from '@nestjs/common';
import { PluginLogController } from './plugin-log.controller';
import { PluginLogService } from './plugin-log.service';

@Module({
  controllers: [PluginLogController],
  providers: [PluginLogService],
  exports: [PluginLogService],
})
export class PluginLogModule {}
