/**
 * Ayudas de la vista para los diálogos nativos (`POST /system/pick`).
 *
 * El servidor devuelve rutas absolutas tal cual las eligió la persona. Aquí solo
 * se decide qué carpeta proponerle al diálogo y cómo sumar los archivos
 * elegidos al cuadro de texto sin duplicar lo que ya estaba escrito.
 */

/**
 * Carpeta que contiene una ruta, o `null` si no tiene separador (un nombre
 * suelto) o es una raíz. Acepta `\` y `/` porque la vista también recibe rutas
 * pegadas a mano.
 */
export function parentDir(target: string): string | null {
  const trimmed = target.trim().replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (index <= 0) return null;
  const parent = trimmed.slice(0, index);
  // `C:` es una unidad, no una carpeta: sin la barra no sirve como `initialDir`.
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

/**
 * Añade las rutas elegidas al final del cuadro de texto, una por línea y sin
 * repetir las que ya estaban. Conserva lo escrito y el orden: el servidor
 * devuelve los resultados en el orden de la lista.
 */
export function appendPaths(current: string, picked: readonly string[]): string {
  const lines = current
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const seen = new Set(lines);

  for (const path of picked) {
    const value = path.trim();
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    lines.push(value);
  }

  return lines.join('\n');
}
