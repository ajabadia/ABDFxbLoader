import {
  FXB_CONFIG_DEFAULTS,
  FXB_FALSY_VALUES,
  FXB_LINE_MAX_LENGTH,
  FXB_TRUTHY_VALUES,
} from './fxb-config.constants';
import type { FxbConfig } from './fxb-config.types';

export interface FxbConfigParseResult {
  config: FxbConfig;
  warnings: string[];
}

/**
 * `trim` de la DLL (FUN_100037a0): solo espacios al principio y
 * espacios / CR / LF al final. Los tabuladores NO se recortan.
 */
export function trimLikeDll(value: string): string {
  return value.replace(/^ +/, '').replace(/[ \r\n]+$/, '');
}

/**
 * Interpreta el contenido de `fxbLoader.config` igual que `FUN_10003f50`:
 * 1. corta en el primer `/` (comentario, y también trunca valores con `/`);
 * 2. parte por el primer `=`;
 * 3. recorta clave y valor con `trimLikeDll`;
 * 4. compara la clave de forma case-sensitive.
 *
 * Un valor desconocido en `loadFxbBank` no cambia el estado previo, tal como
 * hace `FUN_100032e0`; se emite un warning para que la UI lo muestre.
 */
export function parseFxbConfig(raw: string): FxbConfigParseResult {
  const config: FxbConfig = { ...FXB_CONFIG_DEFAULTS };
  const warnings: string[] = [];
  const seen = new Set<string>();

  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    const lineNumber = index + 1;

    if (rawLine.length > FXB_LINE_MAX_LENGTH) {
      warnings.push(
        `línea ${lineNumber}: supera ${FXB_LINE_MAX_LENGTH} caracteres; la DLL la leería partida`,
      );
    }

    const commentAt = rawLine.indexOf('/');
    const text = commentAt === -1 ? rawLine : rawLine.slice(0, commentAt);

    const equalsAt = text.indexOf('=');
    if (equalsAt === -1) continue;

    const key = trimLikeDll(text.slice(0, equalsAt));
    const value = trimLikeDll(text.slice(equalsAt + 1));
    if (key === '') continue;

    if (seen.has(key)) {
      warnings.push(`línea ${lineNumber}: clave duplicada "${key}"; gana la última`);
    }
    seen.add(key);

    switch (key) {
      case 'pluginName':
        config.pluginName = value;
        break;
      case 'defaultFxbName':
        config.defaultFxbName = value;
        break;
      case 'programDirName':
        config.programDirName = value;
        break;
      case 'loadFxbBank':
        if (FXB_TRUTHY_VALUES.has(value)) {
          config.loadFxbBank = true;
        } else if (FXB_FALSY_VALUES.has(value)) {
          config.loadFxbBank = false;
        } else {
          warnings.push(
            `línea ${lineNumber}: valor no reconocido para loadFxbBank ("${value}"); la DLL conserva el valor anterior`,
          );
        }
        break;
      default:
        warnings.push(`línea ${lineNumber}: clave desconocida "${key}", ignorada`);
        break;
    }
  }

  return { config, warnings };
}
