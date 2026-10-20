export { FxbConfigModule } from './fxb-config.module';
export { FxbConfigService } from './fxb-config.service';
export { parseFxbConfig, trimLikeDll } from './fxb-config.parser';
export type { FxbConfigParseResult } from './fxb-config.parser';
export { serializeFxbConfig, validateFxbConfig } from './fxb-config.serializer';
export {
  FXB_CONFIG_DEFAULTS,
  FXB_CONFIG_FILENAME,
  FXB_FALSY_VALUES,
  FXB_LINE_MAX_LENGTH,
  FXB_TRUTHY_VALUES,
  FXB_VALUE_MAX_LENGTH,
} from './fxb-config.constants';
export {
  FxbConfigConflictError,
  FxbConfigPathError,
  FxbConfigValidationError,
} from './fxb-config.types';
export type {
  FxbConfig,
  FxbConfigSnapshot,
  FxbConfigWriteInput,
} from './fxb-config.types';
