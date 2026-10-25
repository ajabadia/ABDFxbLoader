import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  AppendLogOptions,
  DEFAULT_MAX_LOG_SIZE_BYTES,
  MAX_ROTATED_LOG_FILES,
  MAX_SUMMARY_LENGTH,
  PLUGIN_LOG_FILENAME,
  PluginLogEntry,
  PluginLogSnapshot,
} from './plugin-log.types';

function nowIso(): string {
  return new Date().toISOString();
}

function parseLogLine(line: string): PluginLogEntry | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  // Formato estándar: [2026-10-24T08:00:00.000Z] [action] summary [| detail]
  const match = trimmed.match(/^\[([^\]]+)\]\s+\[([^\]]+)\]\s+([^|]+?)(?:\s*\|\s*(.*))?$/);
  if (match) {
    return {
      timestamp: match[1] ?? '',
      action: match[2] ?? '',
      summary: match[3]?.trim() ?? '',
      detail: match[4]?.trim() || undefined,
      raw: trimmed,
    };
  }

  // Fallback para líneas sin corchetes de acción
  return {
    timestamp: '',
    action: 'log',
    summary: trimmed,
    raw: trimmed,
  };
}

@Injectable()
export class PluginLogService {
  private readonly logger = new Logger(PluginLogService.name);

  /**
   * Añade una entrada al log del plugin con política de rotación y degradación.
   * Devuelve `true` si se escribió con éxito, o `false` si falló sin interrumpir.
   */
  async append(
    pluginDir: string,
    action: string,
    summary: string,
    detail?: string,
    options?: AppendLogOptions,
  ): Promise<boolean> {
    try {
      const maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_LOG_SIZE_BYTES;
      const maxRotated = options?.maxRotatedFiles ?? MAX_ROTATED_LOG_FILES;

      let cleanSummary = summary.trim();
      if (cleanSummary.length > MAX_SUMMARY_LENGTH) {
        cleanSummary = cleanSummary.slice(0, MAX_SUMMARY_LENGTH) + '...';
      }

      const timestamp = nowIso();
      const cleanAction = action.trim() || 'action';
      const cleanDetail = detail?.trim();
      const line = `[${timestamp}] [${cleanAction}] ${cleanSummary}${cleanDetail ? ' | ' + cleanDetail : ''}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf8');

      const activePath = path.join(pluginDir, PLUGIN_LOG_FILENAME);

      let stat;
      try {
        stat = await fs.stat(activePath);
      } catch {
        stat = null;
      }

      if (stat && stat.isFile()) {
        if (stat.size + lineBytes > maxSizeBytes) {
          await this.rotate(pluginDir, maxRotated);
        }
      }

      await fs.appendFile(activePath, line, 'utf8');
      return true;
    } catch (error) {
      // Degradación silenciosa según decisión de diseño: el log complementa pero no aborta operaciones
      this.logger.warn(`No se pudo escribir en el log de ${pluginDir}: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Rota el archivo activo:
   * fxbLoader.log.7 descartado si existe
   * fxbLoader.log.i -> fxbLoader.log.(i+1)
   * fxbLoader.log -> fxbLoader.log.1
   */
  private async rotate(pluginDir: string, maxRotated: number): Promise<void> {
    const oldest = path.join(pluginDir, `${PLUGIN_LOG_FILENAME}.${maxRotated}`);
    try {
      await fs.rm(oldest, { force: true });
    } catch {
      // Ignorar si no existe
    }

    for (let i = maxRotated - 1; i >= 1; i--) {
      const src = path.join(pluginDir, `${PLUGIN_LOG_FILENAME}.${i}`);
      const dst = path.join(pluginDir, `${PLUGIN_LOG_FILENAME}.${i + 1}`);
      try {
        await fs.rename(src, dst);
      } catch {
        // Ignorar si src no existe
      }
    }

    const active = path.join(pluginDir, PLUGIN_LOG_FILENAME);
    const firstRotated = path.join(pluginDir, `${PLUGIN_LOG_FILENAME}.1`);
    try {
      await fs.rename(active, firstRotated);
    } catch {
      // Ignorar si active no existe
    }
  }

  /**
   * Lee el snapshot completo del log del plugin concatenando los archivos existentes
   * en orden cronológico (desde el rotado más antiguo hasta el activo).
   */
  async read(pluginDir: string, maxEntries?: number): Promise<PluginLogSnapshot> {
    const activePath = path.join(pluginDir, PLUGIN_LOG_FILENAME);
    const rotatedFound: string[] = [];
    const contents: string[] = [];

    // Comprobar rotados en orden inverso (7 -> 1) para que el texto quede cronológico
    for (let i = MAX_ROTATED_LOG_FILES; i >= 1; i--) {
      const rotName = `${PLUGIN_LOG_FILENAME}.${i}`;
      const rotPath = path.join(pluginDir, rotName);
      try {
        const text = await fs.readFile(rotPath, 'utf8');
        rotatedFound.push(rotName);
        contents.push(text);
      } catch {
        // No existe
      }
    }

    let activeSize = 0;
    let activeExists = false;
    try {
      const stat = await fs.stat(activePath);
      activeExists = stat.isFile();
      activeSize = stat.size;
      const text = await fs.readFile(activePath, 'utf8');
      contents.push(text);
    } catch {
      activeExists = false;
    }

    const fullRaw = contents.join('');
    const rawLines = fullRaw.split('\n');
    const entries: PluginLogEntry[] = [];

    for (const line of rawLines) {
      const parsed = parseLogLine(line);
      if (parsed) {
        entries.push(parsed);
      }
    }

    const exists = activeExists || rotatedFound.length > 0;
    const finalEntries = maxEntries && maxEntries > 0 ? entries.slice(-maxEntries) : entries;

    return {
      logPath: activePath,
      exists,
      size: activeSize,
      totalEntries: entries.length,
      entries: finalEntries,
      raw: fullRaw,
      rotatedFiles: rotatedFound.reverse(), // Ordenar .1, .2...
    };
  }
}
