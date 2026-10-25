/**
 * Constantes y tipos canónicos para el log por plugin rotado por tamaño.
 * Ver documento de decisión: docs/superpowers/decisions/2026-10-22-fxbLoader-plugin-log-rotation.md
 */

export const PLUGIN_LOG_FILENAME = 'fxbLoader.log';
export const MAX_ROTATED_LOG_FILES = 7;
/** 1 MiB en bytes (1_048_576) */
export const DEFAULT_MAX_LOG_SIZE_BYTES = 1024 * 1024;
/** Longitud máxima del resumen; si es más largo se trunca por la derecha */
export const MAX_SUMMARY_LENGTH = 1000;

export interface PluginLogEntry {
  timestamp: string;
  action: string;
  summary: string;
  detail?: string;
  raw: string;
}

export interface PluginLogSnapshot {
  logPath: string;
  exists: boolean;
  size: number;
  totalEntries: number;
  entries: PluginLogEntry[];
  raw: string;
  rotatedFiles: string[];
}

export interface AppendLogOptions {
  maxSizeBytes?: number;
  maxRotatedFiles?: number;
}
