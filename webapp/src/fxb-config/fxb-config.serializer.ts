import { FXB_VALUE_MAX_LENGTH } from './fxb-config.constants';
import { FxbConfigValidationError } from './fxb-config.types';
import type { FxbConfig } from './fxb-config.types';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function checkValue(name: string, value: unknown, issues: string[]): void {
  if (typeof value !== 'string') {
    issues.push(`${name}: debe ser una cadena`);
    return;
  }
  if (value.length > FXB_VALUE_MAX_LENGTH) {
    issues.push(
      `${name}: ${value.length} caracteres; el máximo es ${FXB_VALUE_MAX_LENGTH} (buffer de 64 bytes en la DLL)`,
    );
  }
  if (value.includes('/')) {
    issues.push(`${name}: no puede contener "/" (el parser trunca la línea ahí)`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    issues.push(`${name}: no puede contener caracteres de control ni saltos de línea`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint > 0xff) {
      issues.push(`${name}: "${character}" no es representable en ANSI (CP-1252)`);
      break;
    }
  }
}

/** Reglas de la §7 de la especificación. Devuelve una lista vacía si es válida. */
export function validateFxbConfig(config: FxbConfig): string[] {
  const issues: string[] = [];

  checkValue('pluginName', config.pluginName, issues);
  checkValue('defaultFxbName', config.defaultFxbName, issues);
  checkValue('programDirName', config.programDirName, issues);

  if (typeof config.programDirName === 'string' && config.programDirName.trim() === '') {
    issues.push('programDirName: no puede estar vacío');
  }
  if (typeof config.loadFxbBank !== 'boolean') {
    issues.push('loadFxbBank: debe ser booleano');
  }

  return issues;
}

/**
 * Serializa las cuatro claves en el orden y con el formato de `FUN_100037f0`:
 * `clave = valor`, CRLF y salto final.
 */
export function serializeFxbConfig(config: FxbConfig): string {
  const issues = validateFxbConfig(config);
  if (issues.length > 0) throw new FxbConfigValidationError(issues);

  return (
    [
      `pluginName = ${config.pluginName}`,
      `defaultFxbName = ${config.defaultFxbName}`,
      `programDirName = ${config.programDirName}`,
      `loadFxbBank = ${config.loadFxbBank ? 'yes' : 'no'}`,
    ].join('\r\n') + '\r\n'
  );
}
