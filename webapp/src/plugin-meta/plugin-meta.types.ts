import type { FxbConfigSnapshot } from '../fxb-config/fxb-config.types';

/**
 * Modelo del archivo propio del plugin gestionado por la web:
 * `<pluginDir>/fxbLoader.meta.json`.
 *
 * No sustituye a `vfxinfo.txt`: `vfxinfo.txt` sigue siendo la fuente de los
 * campos rígidos del plugin. Este archivo solo gestiona lo extendido por la app.
 */
export interface PluginMetaSnapshot {
  metaPath: string;
  exists: boolean;
  /** `null` cuando el archivo no existe. */
  mtimeMs: number | null;
  size: number;
  /** Campos comunes que la app sabe interpretar del plugin. */
  common: PluginMetaCommon;
  /** Campos extendidos arbitrarios por plugin, sin forzar una forma fija. */
  extended: Readonly<Record<string, PluginMetaValue>>;
  /** Origen breve del catálogo en el momento de la última escritura. */
  source: PluginMetaSource | null;
  /** Marca de lectura/escritura mantenida por la app. */
  updated: string | null;
}

export interface PluginMetaCommon {
  /** Identidad del plugin para el catálogo (viene del `id` de `vfxinfo.txt`). */
  id: string;
  /** Nombre legible del plugin. */
  name: string;
  /** Fabricante. */
  vendor: string;
  /** URL del fabricante, si aparece. */
  vendor_url: string;
  /** Género o categoría del plugin. */
  genre: string;
  /** Abreviatura del nombre del plugin. */
  name_abbreviation: string;
  /** Notas del plugin. */
  notes: string;
  /** Fecha de creación del plugin (formato ISO date). */
  created: string;
}

/**
 * Valores escalares permitidos en `extended`. Los arrays no se permiten, y los
 * objetos pueden anidarse en forma plana sin que la clave tenga espacios al
 * principio ni al final.
 */
export type PluginMetaValue = string | number | boolean | null | Readonly<PluginMetaRecord>;

export interface PluginMetaRecord {
  readonly [key: string]: PluginMetaValue;
}

export interface PluginMetaSource {
  /** El catálogo leyó campos comunes desde `vfxinfo.txt` en la última escritura. */
  vfxinfo?: boolean;
}

/**
 * Campos comunes tal como llegan del cliente: solo las claves presentes se
 * aplican, y el servicio rechaza las que no son del formato.
 */
export type PluginMetaCommonInput = Readonly<Record<string, string | undefined>>;

/** Entrada del cliente para escribir un meta. Solo lo que la persona puede actuar. */
export interface PluginMetaWriteInput {
  pluginDir: string;
  /** `mtimeMs` que el cliente leyó, o `null` si el archivo no existía. */
  expectedMtimeMs: number | null;
  /** Solo las claves a cambiar: omitir una conserva el valor que haya en disco. */
  common: PluginMetaCommonInput;
  extended: Readonly<Record<string, PluginMetaValue>>;
}

export class PluginMetaConflictError extends Error {
  readonly current: PluginMetaSnapshot;

  constructor(current: PluginMetaSnapshot) {
    super('El archivo propio cambió en disco desde la última lectura');
    this.name = 'PluginMetaConflictError';
    this.current = current;
  }
}

export class PluginMetaPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginMetaPathError';
  }
}

export class PluginMetaInvalidError extends Error {
  readonly issues: ReadonlyArray<string>;

  constructor(issues: ReadonlyArray<string>) {
    super(`Metadatos no válidos: ${issues.join('; ')}`);
    this.name = 'PluginMetaInvalidError';
    this.issues = issues;
  }
}

export const COMMON_KEYS: ReadonlySet<keyof PluginMetaCommon> = new Set([
  'id',
  'name',
  'vendor',
  'vendor_url',
  'genre',
  'name_abbreviation',
  'notes',
  'created',
]);
