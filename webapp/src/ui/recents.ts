/**
 * Historial de rutas recientes para los `<datalist>` de la vista.
 *
 * Vive aparte de `localStorage` y del DOM a propósito: lo que hay que probar es
 * la política —el orden es el de uso, no hay duplicados aunque cambien las
 * mayúsculas o el tipo de barra, y un valor corrupto se convierte en una lista
 * vacía en vez de romper la pantalla—, no el navegador.
 */

/** Sugerencias que caben en cada `<datalist>`. */
export const MAX_RECENTS = 8;

/**
 * Clave de comparación de una ruta: en Windows la misma carpeta se escribe con
 * mayúsculas distintas, con `\` o `/` y con barra final, así que todo eso sobra
 * para decidir si dos entradas son la misma.
 */
export function pathKey(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Texto utilizable de una entrada almacenada; `null` si no vale. */
function normalize(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Lista guardada en `localStorage`: cualquier cosa que no sea una lista de
 * cadenas se descarta entrada a entrada, y el resultado nunca pasa del máximo.
 */
export function parseRecents(raw: string | null, limit: number = MAX_RECENTS): string[] {
  if (raw === null || raw === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return dedupe(parsed, limit);
}

/** Primera aparición de cada ruta, ya normalizada, recortada al máximo. */
function dedupe(values: readonly unknown[], limit: number): string[] {
  if (limit <= 0) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const path = normalize(value);
    if (path === null) continue;

    const key = pathKey(path);
    if (key === '' || seen.has(key)) continue;

    seen.add(key);
    out.push(path);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Mueve una ruta al principio sin duplicarla y sin tocar la lista recibida. La
 * ruta vacía no cambia nada: un campo en blanco no es un uso.
 */
export function rememberRecent(
  previous: readonly string[],
  path: string,
  limit: number = MAX_RECENTS,
): string[] {
  const added = normalize(path);
  if (added === null) return [...previous];
  if (limit <= 0) return [];

  const key = pathKey(added);
  const rest = previous.filter((entry) => pathKey(entry) !== key);
  return [added, ...rest].slice(0, limit);
}

/**
 * Aplica un lote de rutas en orden, de modo que la última usada queda la
 * primera en las sugerencias.
 */
export function rememberRecentPaths(
  previous: readonly string[],
  paths: readonly string[],
  limit: number = MAX_RECENTS,
): string[] {
  return paths.reduce<string[]>((list, path) => rememberRecent(list, path, limit), [
    ...previous,
  ]);
}

/** Lo que el servidor dice de una ruta: si está y si es carpeta. */
export interface RecentPathState {
  path: string;
  exists: boolean;
  isDirectory: boolean;
}

/** Qué se espera encontrar en el disco: una carpeta o un archivo. */
export type RecentKind = 'directory' | 'file';

/**
 * Quita del historial lo que ya no sirve: una ruta que el servidor dice que no
 * existe, o que ahora es del tipo contrario (una carpeta donde se recordaba un
 * `.fxb`, un archivo donde se recordaba una carpeta de librería).
 *
 * Lo que el servidor **no** contestó se conserva: si la comprobación falló para
 * una ruta, o no se llegó a preguntar por ella, una sugerencia de más es mejor
 * que perder el historial entero por un error de red.
 */
export function existingRecents(
  previous: readonly string[],
  states: readonly RecentPathState[],
  kind: RecentKind,
): string[] {
  const known = new Map<string, RecentPathState>();
  for (const state of states) known.set(pathKey(state.path), state);

  return previous.filter((entry) => {
    const state = known.get(pathKey(entry));
    if (state === undefined) return true;
    return state.exists && state.isDirectory === (kind === 'directory');
  });
}
