/**
 * Auditoría de datos de la librería: qué falta en cada plugin y qué se puede
 * rellenar sin intervención humana a partir de lo que ya hay en disco.
 */

/** Gravedad de un hueco. `note` no impide considerar completo al plugin. */
export type LibraryAuditIssueSeverity = 'missing' | 'invalid' | 'note';

/**
 * De dónde sale el valor propuesto. `wizard` es el catálogo de wizards: la
 * única fuente que declara fabricante, URL, notas, versión y los campos de
 * ejecución que el análisis estático del DLL no puede ver.
 */
export type LibraryAuditProposalSource = 'vfxinfo' | 'meta' | 'dll' | 'derived' | 'wizard';

export interface LibraryAuditIssue {
  /** Campo afectado con prefijo de origen: `vfxinfo.id`, `meta.vendor`, `dll`. */
  field: string;
  severity: LibraryAuditIssueSeverity;
  message: string;
}

export interface LibraryAuditProposal {
  /** Campo que se rellenaría, con el mismo prefijo que en `issues`. */
  field: string;
  value: string;
  source: LibraryAuditProposalSource;
  note?: string;
}

export interface LibraryAuditDll {
  /** Valor tal cual de `dll_name` en `vfxinfo.txt`, si lo hay. */
  declared: string | null;
  /** Ruta del DLL localizado, relativa a `plugs\` y con `/`. */
  resolved: string | null;
  bitness: number | null;
  vstEntrypoint: 'VSTPluginMain' | 'main' | null;
}

export interface LibraryAuditPlugin {
  /** Nombre de la carpeta bajo `plugs\`. */
  name: string;
  /** Ruta absoluta de la carpeta del plugin. */
  path: string;
  hasVfxinfo: boolean;
  hasMeta: boolean;
  dll: LibraryAuditDll;
  issues: LibraryAuditIssue[];
  proposals: LibraryAuditProposal[];
}

export interface LibraryAuditResult {
  libraryRoot: string;
  plugsPath: string;
  /** ISO-8601 del momento del análisis. */
  scannedAt: string;
  total: number;
  /** Plugins sin huecos (`missing`/`invalid`); las `note` no cuentan. */
  complete: number;
  incomplete: number;
  issueCount: number;
  proposalCount: number;
  plugins: LibraryAuditPlugin[];
}

/** Valor propuesto que se ha escrito en disco. */
export interface LibraryAuditApplied {
  field: string;
  value: string;
}

/** Propuesta pedida que no se aplicó, con el motivo. */
export interface LibraryAuditApplySkipped {
  field: string;
  reason: string;
}

export interface LibraryAuditApplyResult {
  /** Carpeta del plugin bajo `plugs\`. */
  plugin: string;
  /** Valores escritos. */
  applied: LibraryAuditApplied[];
  /** Propuestas pedidas que no se pudieron o no hacía falta escribir. */
  skipped: LibraryAuditApplySkipped[];
  /** `vfxinfo.txt` reescrito, o `null` si no se tocó. */
  vfxinfoPath: string | null;
  /** `fxbLoader.meta.json` escrito, o `null` si no se tocó. */
  metaPath: string | null;
  /** Respaldos creados antes de escribir (`*.bak`). */
  backups: string[];
  warnings: string[];
}
