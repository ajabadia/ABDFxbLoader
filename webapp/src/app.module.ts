import { Module } from '@nestjs/common';
import { FxbConfigModule } from './fxb-config/fxb-config.module';
import { LibraryModule } from './library/library.module';

@Module({
  imports: [FxbConfigModule, LibraryModule],
})
export class AppModule {}
