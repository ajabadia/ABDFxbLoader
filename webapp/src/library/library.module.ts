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

// Re-export del módulo nativo para que el código de la UI y los tests puedan
// usar la puerta que reemplaza a `vst/fxbLoader.dll` sin importar el módulo
// concreto.
export * as fxbLoaderNativeModule from './fxbLoader-native';
