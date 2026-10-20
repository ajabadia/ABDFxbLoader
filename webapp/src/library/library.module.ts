import { Module } from '@nestjs/common';
import { FxbConfigModule } from '../fxb-config/fxb-config.module';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';

@Module({
  imports: [FxbConfigModule],
  controllers: [LibraryController],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
