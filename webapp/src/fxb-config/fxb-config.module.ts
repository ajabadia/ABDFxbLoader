import { Module } from '@nestjs/common';
import { FxbConfigController } from './fxb-config.controller';
import { FxbConfigService } from './fxb-config.service';

@Module({
  controllers: [FxbConfigController],
  providers: [FxbConfigService],
  exports: [FxbConfigService],
})
export class FxbConfigModule {}
