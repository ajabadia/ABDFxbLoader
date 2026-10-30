/**
 * Auditoría de datos de la librería: qué falta en cada plugin y qué se puede
 * rellenar sin intervención humana a partir de lo que ya hay en disco.
 */

/** Gravedad de un hueco. `note` no impide considerar completo al plugin. */
export type LibraryAuditIssueSeverity = 'missing' | 'invalid' | 'note';

/** De dónde sale el valor propuesto. */
export type LibraryAuditProposalSource = 'vfxinfo' | 'meta' | 'dll' | 'derived';

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
