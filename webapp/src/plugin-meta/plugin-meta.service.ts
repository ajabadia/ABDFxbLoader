import { Injectable } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../common/atomic-file';
import { readVfxinfo, VFXINFO_FILENAME } from '../library/vfxinfo';
import type {
  PluginMetaCommon,
  PluginMetaSnapshot,
  PluginMetaValue,
} from './plugin-meta.types';
import {
  COMMON_KEYS,
  PluginMetaConflictError,
  PluginMetaInvalidError,
  PluginMetaPathError,
} from './plugin-meta.types';

const META_FILENAME = 'fxbLoader.meta.json';
const COMMON_KEY_ARRAY: readonly (keyof PluginMetaCommon)[] = [
  'id',
  'name',
  'vendor',
  'vendor_url',
  'genre',
  'name_abbreviation',
  'notes',
  'created',
];

function nowIsoInstant(): string {
  const offset = new Date().getTimezoneOffset();
  const local = new Date(Date.now() - offset * 60 * 1000);
  return local.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function copyCommonDefaults(): PluginMetaCommon {
  return {
    id: '',
    name: '',
    vendor: '',
    vendor_url: '',
    genre: '',
    name_abbreviation: '',
    notes: '',
    created: '',
  };
}

function assertStringForKey(key: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new PluginMetaInvalidError([`common.${key}: debe ser una cadena`]);
  }
}

function commonFromExistingRecord(
  common: Record<string, unknown>,
): PluginMetaCommon {
  const out: PluginMetaCommon = copyCommonDefaults();

  for (const key of COMMON_KEY_ARRAY) {
    if (common[key] != null) {
      assertStringForKey(key, common[key]);
      out[key] = common[key] as string;
    }
  }

  return out;
}

function validateInputCommonShape(input: Record<string, string>): void {
  for (const key of Object.keys(input)) {
    if (!COMMON_KEYS.has(key as keyof PluginMetaCommon)) {
      throw new PluginMetaInvalidError([`common: clave del cliente no admitida "${key}"`]);
    }
    const value = input[key];
    if (typeof value !== 'string') {
      throw new PluginMetaInvalidError([`common.${key}: debe ser una cadena`]);
    }
    if (value.length > 255) {
      throw new PluginMetaInvalidError([`common.${key}: ${value.length} caracteres; el máximo es 255`]);
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      throw new PluginMetaInvalidError([`common.${key}: no puede contener caracteres de control`]);
    }
  }
}

function commonFromInput(input: Record<string, string>): PluginMetaCommon {
  const out: PluginMetaCommon = copyCommonDefaults();

  for (const key of COMMON_KEY_ARRAY) {
    if (input[key] !== undefined) {
      assertStringForKey(key, input[key]);
      out[key] = input[key];
    }
  }

  return out;
}

function validateCommonMeta(value: object, issues: string[]): void {
  const common = value as Record<string, unknown>;
  for (const key of Object.keys(common)) {
    if (!COMMON_KEYS.has(key as keyof PluginMetaCommon)) {
      issues.push(`common: clave desconocida "${key}"`);
      continue;
    }
    const field = common[key];
    if (typeof field !== 'string') {
      issues.push(`common.${key}: debe ser una cadena`);
    } else if (field.length > 255) {
      issues.push(`common.${key}: ${field.length} caracteres; el máximo es 255`);
    } else if (/[\u0000-\u001f\u007f]/.test(field)) {
      issues.push(`common.${key}: no puede contener caracteres de control`);
    }
  }
}

function validateExtendedValue(
  value: unknown,
  key: string,
  issues: string[],
): void {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return;
  }

  if (Array.isArray(value)) {
    issues.push(`extended.${key}: los arrays no se permiten`);
    return;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length > 128) {
      issues.push(`extended.${key}: objeto con más de 128 propiedades`);
    }
    for (const [subkey, subvalue] of Object.entries(record)) {
      if (typeof subkey !== 'string' || !/^[A-Za-z0-9_-]+$/.test(subkey)) {
        issues.push(`extended.${key}: clave de objeto no válida "${subkey}"`);
        continue;
      }
      validateExtendedValue(subvalue, `${key}.${subkey}`, issues);
    }
    return;
  }

  issues.push(`extended.${key}: el valor tiene un tipo no soportado`);
}

const EXTENDED_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;

function validateExtended(
  extended: Record<string, unknown>,
  issues: string[],
): void {
  const keys = Object.keys(extended);
  if (keys.length > 128) {
    issues.push('extended: más de 128 claves');
  }

  for (const key of keys) {
    if (!EXTENDED_KEY_PATTERN.test(key)) {
      issues.push(`extended: clave "${key}" no válida`);
      continue;
    }
    validateExtendedValue(extended[key], key, issues);
  }
}

function validateMetaFile(obj: unknown, issues: string[]): void {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    issues.push('el archivo propio debe ser un objeto JSON');
    return;
  }

  const record = obj as Record<string, unknown>;

  if (!('common' in record) || typeof record.common !== 'object' || record.common === null) {
    issues.push('el archivo propio debe incluir "common" como objeto');
    return;
  }

  if (Array.isArray(record.common)) {
    issues.push('common debe ser un objeto, no un array');
    return;
  }

  validateCommonMeta(record.common as Record<string, unknown>, issues);

  if (!('extended' in record) || typeof record.extended !== 'object' || record.extended === null) {
    issues.push('el archivo propio debe incluir "extended" como objeto');
    return;
  }

  if (Array.isArray(record.extended)) {
    issues.push('extended debe ser un objeto, no un array');
    return;
  }

  validateExtended(record.extended as Record<string, unknown>, issues);

  if ('updated' in record) {
    if (typeof record.updated !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(record.updated)) {
      issues.push('updated: debe ser una fecha ISO-8601 con Z');
    }
  }

  if ('source' in record) {
    const source = record.source;
    if (typeof source !== 'object' || source === null || Array.isArray(source)) {
      issues.push('source: debe ser un objeto');
    } else {
      const src = source as Record<string, unknown>;
      for (const key of Object.keys(src)) {
        if (key === 'vfxinfo') {
          if (typeof src[key] !== 'boolean') {
            issues.push('source.vfxinfo: debe ser un booleano');
          }
        } else {
          issues.push(`source: clave desconocida "${key}"`);
        }
      }
    }
  }

  for (const key of Object.keys(record)) {
    if (key !== 'common' && key !== 'extended' && key !== 'updated' && key !== 'source') {
      issues.push(`clave desconocida en el archivo propio: "${key}"`);
    }
  }
}

function metaFromDisk(
  file: string,
  raw: string,
  stats: { mtimeMs: number; size: number },
): PluginMetaSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new PluginMetaInvalidError(['el archivo propio no es JSON válido']);
  }
  const issues: string[] = [];
  validateMetaFile(parsed, issues);
  if (issues.length > 0) {
    throw new PluginMetaInvalidError(issues);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PluginMetaInvalidError(['el archivo propio debe ser un objeto JSON']);
  }

  const record = parsed as Record<string, unknown>;
  const common = record.common as Record<string, unknown>;
  const extended = record.extended as Record<string, unknown>;

  const commonOut: PluginMetaCommon = {
    id: typeof common.id === 'string' ? common.id : '',
    name: typeof common.name === 'string' ? common.name : '',
    vendor: typeof common.vendor === 'string' ? common.vendor : '',
    vendor_url: typeof common.vendor_url === 'string' ? common.vendor_url : '',
    genre: typeof common.genre === 'string' ? common.genre : '',
    name_abbreviation: typeof common.name_abbreviation === 'string' ? common.name_abbreviation : '',
    notes: typeof common.notes === 'string' ? common.notes : '',
    created: typeof common.created === 'string' ? common.created : '',
  };    const sourceOut: { vfxinfo?: boolean } | null =
    typeof record.source === 'object' && record.source !== null && !Array.isArray(record.source)
      ? (('vfxinfo' in record.source) ? { vfxinfo: record.source.vfxinfo === true } : null)
      : null;

  return {
    metaPath: file,
    exists: true,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    common: commonOut,
    extended: extended as Record<string, PluginMetaValue>,
    source: sourceOut ?? null,
    updated: typeof record.updated === 'string' ? record.updated : null,
  };
}

/**
 * Instantánea tolerante del estado en disco, para los errores de conflicto: el
 * archivo puede estar corrupto o a medias y aun así hay que devolver al cliente
 * lo que haya para que pueda reconciliar.
 */
function snapshotFromDiskLenient(
  file: string,
  raw: string,
  stats: { mtimeMs: number; size: number },
): PluginMetaSnapshot {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    parsed = null;
  }

  const record =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  const common =
    typeof record.common === 'object' && record.common !== null && !Array.isArray(record.common)
      ? (record.common as Record<string, unknown>)
      : {};

  const extended =
    typeof record.extended === 'object' && record.extended !== null && !Array.isArray(record.extended)
      ? (record.extended as Record<string, PluginMetaValue>)
      : {};

  const rawSource = record.source;
  const source: { vfxinfo?: boolean } | null =
    typeof rawSource === 'object' && rawSource !== null && !Array.isArray(rawSource) && 'vfxinfo' in rawSource
      ? { vfxinfo: (rawSource as Record<string, unknown>).vfxinfo === true }
      : null;

  return {
    metaPath: file,
    exists: true,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    common: {
      id: typeof common.id === 'string' ? common.id : '',
      name: typeof common.name === 'string' ? common.name : '',
      vendor: typeof common.vendor === 'string' ? common.vendor : '',
      vendor_url: typeof common.vendor_url === 'string' ? common.vendor_url : '',
      genre: typeof common.genre === 'string' ? common.genre : '',
      name_abbreviation: typeof common.name_abbreviation === 'string' ? common.name_abbreviation : '',
      notes: typeof common.notes === 'string' ? common.notes : '',
      created: typeof common.created === 'string' ? common.created : '',
    },
    extended,
    source,
    updated: typeof record.updated === 'string' ? record.updated : null,
  };
}

async function statOrNull(file: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const stats = await fs.stat(file);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function resolvePluginDir(pluginDir: string): Promise<string> {
  if (typeof pluginDir !== 'string' || pluginDir.trim() === '') {
    throw new PluginMetaPathError('pluginDir es obligatorio');
  }
  if (!path.isAbsolute(pluginDir)) {
    throw new PluginMetaPathError(`pluginDir debe ser una ruta absoluta: "${pluginDir}"`);
  }

  const resolved = path.resolve(pluginDir);
  let stats: { isDirectory(): boolean };
  try {
    stats = await fs.stat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PluginMetaPathError(`el directorio no existe: ${resolved}`);
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new PluginMetaPathError(`no es un directorio: ${resolved}`);
  }

  return resolved;
}

export function commonFromVfxinfoFile(text: string): Record<string, string> {
  const common: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;

    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    if (value === '') continue;

    if (COMMON_KEY_ARRAY.includes(key as keyof PluginMetaCommon)) {
      common[key] = value;
    }
  }
  return common;
}

export async function readCommonFromVfxinfo(pluginDir: string): Promise<Record<string, string>> {
  const vfxinfoPath = path.join(pluginDir, VFXINFO_FILENAME);
  const text = await readVfxinfo(vfxinfoPath);
  if (text === null) return {};
  return commonFromVfxinfoFile(text);
}

@Injectable()
export class PluginMetaService {
  async read(pluginDir: string): Promise<PluginMetaSnapshot> {
    const dir = await resolvePluginDir(pluginDir);
    const file = path.join(dir, META_FILENAME);
    const stats = await statOrNull(file);

    if (stats === null) {
      return {
        metaPath: file,
        exists: false,
        mtimeMs: null,
        size: 0,
        common: copyCommonDefaults(),
        extended: {},
        source: null,
        updated: null,
      };
    }

    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          metaPath: file,
          exists: false,
          mtimeMs: null,
          size: 0,
          common: copyCommonDefaults(),
          extended: {},
          source: null,
          updated: null,
        };
      }
      throw error;
    }

    return metaFromDisk(file, raw, stats);
  }

  async write(input: {
    pluginDir: string;
    expectedMtimeMs: number | null;
    common: Readonly<Record<string, string>>;
    extended: Readonly<Record<string, PluginMetaValue>>;
  }): Promise<PluginMetaSnapshot> {
    const dir = await resolvePluginDir(input.pluginDir);
    const file = path.join(dir, META_FILENAME);

    const writeCommon: PluginMetaCommon = commonFromInput(input.common);
    validateInputCommonShape(input.common);
    // Solo se rechaza lo que el cliente envía explícitamente vacío: omitir un
    // campo es válido y se resuelve con lo que ya hubiera en disco.
    if (input.common.id !== undefined && input.common.id.trim() === '') {
      throw new PluginMetaInvalidError(['common.id: no puede estar vacío']);
    }
    if (input.common.name !== undefined && input.common.name.trim() === '') {
      throw new PluginMetaInvalidError(['common.name: no puede estar vacío']);
    }
    const issues: string[] = [];
    validateExtended(input.extended as Record<string, unknown>, issues);
    if (issues.length > 0) {
      throw new PluginMetaInvalidError(issues);
    }

    const current = await statOrNull(file);
    let currentCommon: Record<string, unknown> | undefined;
    let currentExtended: Readonly<Record<string, PluginMetaValue>> | undefined;
    if (current === null) {
      if (input.expectedMtimeMs !== null) {
        throw new PluginMetaConflictError({
          metaPath: file,
          exists: false,
          mtimeMs: null,
          size: 0,
          common: copyCommonDefaults(),
          extended: {},
          source: null,
          updated: null,
        });
      }
      currentCommon = undefined;
      currentExtended = undefined;
    } else if (
      input.expectedMtimeMs === null ||
      input.expectedMtimeMs !== current.mtimeMs
    ) {
      const diskStats = await fs.stat(file);
      const beforeRaw = await fs.readFile(file, 'utf8');
      throw new PluginMetaConflictError(
        snapshotFromDiskLenient(file, beforeRaw, { mtimeMs: diskStats.mtimeMs, size: diskStats.size }),
      );
    } else {
      const beforeRaw = await fs.readFile(file, 'utf8');
      const beforeRecord = JSON.parse(beforeRaw) as Record<string, unknown>;
      currentCommon = beforeRecord.common as Record<string, unknown> | undefined;
      currentExtended = beforeRecord.extended != null
        ? (beforeRecord.extended as unknown) as Readonly<Record<string, PluginMetaValue>>
        : undefined;
    }

    const updated = nowIsoInstant();

    const baseCommon: PluginMetaCommon = currentCommon != null
      ? commonFromExistingRecord(currentCommon)
      : copyCommonDefaults();

    const baseExtended: Readonly<Record<string, PluginMetaValue>> = currentExtended ?? ({} as Readonly<Record<string, PluginMetaValue>>);

    const mergedExtended: Record<string, PluginMetaValue> = {
      ...(baseExtended as Readonly<Record<string, PluginMetaValue>>),
      ...(input.extended as Readonly<Record<string, PluginMetaValue>>),
    };

    const mergedCommon: PluginMetaCommon = {
      ...baseCommon,
      ...writeCommon,
    };
    if (mergedExtended.notes != null) {
      mergedCommon.notes = String(mergedExtended.notes);
    }

    validateCommonMeta(mergedCommon, issues);
    validateExtended(mergedExtended, issues);
    if (issues.length > 0) {
      throw new PluginMetaInvalidError(issues);
    }

    const payload = JSON.stringify(
      {
        common: mergedCommon,
        extended: mergedExtended,
        updated,
        source: { vfxinfo: false },
      },
      null,
      2,
    ) + '\n';

    await writeFileAtomic(file, Buffer.from(payload, 'utf8'));

    const diskStats = await fs.stat(file);
    return {
      metaPath: file,
      exists: true,
      mtimeMs: diskStats.mtimeMs,
      size: diskStats.size,
      common: mergedCommon as PluginMetaCommon,
      extended: mergedExtended as Readonly<Record<string, PluginMetaValue>>,
      source: { vfxinfo: false },
      updated,
    };
  }
}
