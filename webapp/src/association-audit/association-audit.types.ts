/**
 * Tipos y constantes del almacén durable de asociaciones.
 * Ver diseño: docs/superpowers/plans/2026-10-25-durable-association-audit.md
 */

/** Un solo almacén por librería; apéndice puro, nunca rota. */
export const ASSOCIATION_AUDIT_FILENAME = 'fxbLoader.audit.jsonl';

/** Límite por defecto del listado calculado. */
export const DEFAULT_AUDIT_LIMIT = 200;

export type AssociationAuditKind =
  | 'association-change'
  | 'import'
  | 'reimport'
  | 'collision';

export type CollisionPolicy = 'skip' | 'overwrite';

export interface AssociationAuditEntry {
  /** ISO-8601 UTC del momento de escritura. */
  ts: string;
  kind: AssociationAuditKind;
  /** Carpeta del plugin tal cual; los eventos de import global pueden omitirla. */
  plugin?: string;
  /** Raíz canónica de la librería donde vive el evento. */
  libraryRoot?: string;
  /** Campo asociado (dll_name hoy). */
  field?: string;
  previousValue?: string | null;
  newValue?: string | null;
  /** Solo en import/reimport/collision: enlaza las líneas de una misma llamada. */
  packageSource?: string;
  collisionPolicy?: CollisionPolicy;
  collisionNames?: string[];
  repairedBanks?: string[];
}

export interface AssociationAuditSnapshot {
  auditPath: string;
  exists: boolean;
  size: number;
  total: number;
  entries: AssociationAuditEntry[];
}

export interface AssociationAuditFilter {
  plugin?: string;
  /** Texto libre: subcadena insensible a mayúsculas sobre los textos por columna de la tabla del visor. */
  q?: string;
  kind?: AssociationAuditKind;
  /** ISO-8601 inclusive. */
  from?: string;
  /** ISO-8601 inclusive. */
  to?: string;
  /** De los últimos `limit` eventos que pasan los filtros. */
  limit?: number;
}
