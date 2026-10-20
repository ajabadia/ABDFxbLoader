import type { FxbConfig } from './fxb-config.types';

export const FXB_CONFIG_FILENAME = 'fxbLoader.config';

/** La DLL copia con strcpy a buffers de 64 bytes: 63 caracteres + NUL. */
export const FXB_VALUE_MAX_LENGTH = 63;

/** `fgets(buf, 301, f)` en la DLL: las líneas más largas se parten. */
export const FXB_LINE_MAX_LENGTH = 300;

export const FXB_CONFIG_DEFAULTS: Readonly<FxbConfig> = Object.freeze({
  pluginName: '',
  defaultFxbName: '',
  programDirName: 'presets',
  loadFxbBank: true,
});

/** Literales que activan `loadFxbBank` (tabla en 0x1001d680). */
export const FXB_TRUTHY_VALUES: ReadonlySet<string> = new Set([
  'yes',
  'Yes',
  'YES',
  'true',
  'True',
  'TRUE',
  '1',
]);

/** Literales que desactivan `loadFxbBank`. Ojo: `False` no está. */
export const FXB_FALSY_VALUES: ReadonlySet<string> = new Set([
  'no',
  'No',
  'NO',
  'false',
  'FALSE',
  '0',
]);
