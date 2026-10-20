import { Injectable } from '@nestjs/common';
import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../common/atomic-file';
import { FXB_CONFIG_DEFAULTS, FXB_CONFIG_FILENAME } from './fxb-config.constants';
import { parseFxbConfig } from './fxb-config.parser';
import { serializeFxbConfig, validateFxbConfig } from './fxb-config.serializer';
import {
  FxbConfigConflictError,
  FxbConfigPathError,
  FxbConfigValidationError,
} from './fxb-config.types';
import type { FxbConfig, FxbConfigSnapshot, FxbConfigWriteInput } from './fxb-config.types';

async function statOrNull(file: string): Promise<Stats | null> {
  try {
    return await fs.stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

@Injectable()
export class FxbConfigService {
  /**
   * Lee `<pluginDir>\fxbLoader.config`. Si no existe devuelve los valores por
   * defecto y `exists: false`, sin crear nada.
   */
  async read(pluginDir: string): Promise<FxbConfigSnapshot> {
    const { file } = await this.resolveDirectory(pluginDir);
    return this.readFile(file);
  }

  /**
   * Fusiona los cambios con lo que haya en disco y escribe de forma atómica.
   * Si el `mtimeMs` esperado no coincide con el actual, lanza conflicto y no
   * toca el archivo (la DLL pudo haber guardado desde la última lectura).
   */
  async write(input: FxbConfigWriteInput): Promise<FxbConfigSnapshot> {
    const { file } = await this.resolveDirectory(input.pluginDir);
    const current = await this.readFile(file);

    if (input.expectedMtimeMs === null) {
      if (current.exists) throw new FxbConfigConflictError(current);
    } else if (!current.exists || current.mtimeMs !== input.expectedMtimeMs) {
      throw new FxbConfigConflictError(current);
    }

    const merged: FxbConfig = { ...current.config, ...input.config };
    const issues = validateFxbConfig(merged);
    if (issues.length > 0) throw new FxbConfigValidationError(issues);

    const payload = Buffer.from(serializeFxbConfig(merged), 'latin1');
    await writeFileAtomic(file, payload);

    const stats = await fs.stat(file);
    return {
      configPath: file,
      exists: true,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      config: merged,
      warnings: [],
    };
  }

  private async resolveDirectory(pluginDir: string): Promise<{ dir: string; file: string }> {
    if (typeof pluginDir !== 'string' || pluginDir.trim() === '') {
      throw new FxbConfigPathError('pluginDir es obligatorio');
    }
    if (!path.isAbsolute(pluginDir)) {
      throw new FxbConfigPathError(`pluginDir debe ser una ruta absoluta: "${pluginDir}"`);
    }

    const dir = path.resolve(pluginDir);
    let stats: Stats;
    try {
      stats = await fs.stat(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FxbConfigPathError(`el directorio no existe: ${dir}`);
      }
      throw error;
    }
    if (!stats.isDirectory()) {
      throw new FxbConfigPathError(`no es un directorio: ${dir}`);
    }

    // El archivo se construye dentro del directorio validado; no hay traversal.
    return { dir, file: path.join(dir, FXB_CONFIG_FILENAME) };
  }

  private async readFile(file: string): Promise<FxbConfigSnapshot> {
    const stats = await statOrNull(file);
    if (stats === null) {
      return {
        configPath: file,
        exists: false,
        mtimeMs: null,
        size: 0,
        config: { ...FXB_CONFIG_DEFAULTS },
        warnings: [],
      };
    }

    // `latin1` mapea byte a carácter: el round-trip conserva CP-1252 tal cual.
    const raw = (await fs.readFile(file)).toString('latin1');
    const { config, warnings } = parseFxbConfig(raw);

    return {
      configPath: file,
      exists: true,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      config,
      warnings,
    };
  }
}
