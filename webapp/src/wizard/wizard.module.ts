import { Module } from '@nestjs/common';
import { PluginLogModule } from '../plugin-log/plugin-log.module';
import { PluginMetaModule } from '../plugin-meta/plugin-meta.module';
import { WizardController } from './wizard.controller';
import { WizardService } from './wizard.service';

@Module({
  imports: [PluginMetaModule, PluginLogModule],
  controllers: [WizardController],
  providers: [WizardService],
  exports: [WizardService],
})
export class WizardModule {}
