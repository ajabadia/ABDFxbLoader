/**
 * Esqueleto de carga compartido.
 *
 * El caso normal no se escribe por vista: `mountTable` pinta sus propias filas
 * de esqueleto con `TableController.setLoading`, así que cualquier tabla que
 * monte el sistema lo hereda. Este módulo existe para los huecos que no son
 * tabla (paneles, fichas, cajones) y para las piezas que la tabla reutiliza.
 *
 * Las barras son `aria-hidden`: lo que anuncia la espera es `aria-busy` en el
 * contenedor, no un lector de pantalla recorriendo doce rectángulos.
 */

/** Tope de filas de esqueleto: más que eso no informa de nada. */
export const SKELETON_MAX_ROWS = 8;

/** Barra gris con la forma de una línea de texto. */
export function createSkeletonBar(): HTMLElement {
  const bar = document.createElement('span');
  bar.className = 'skeleton-bar';
  bar.setAttribute('aria-hidden', 'true');
  return bar;
}

/**
 * Filas de esqueleto con el número de columnas de la tabla real. La última
 * columna es la de acciones cuando la vista las tiene.
 */
export function createSkeletonRows(count: number, columns: number): HTMLTableRowElement[] {
  const rows: HTMLTableRowElement[] = [];
  for (let index = 0; index < count; index += 1) {
    const tr = document.createElement('tr');
    tr.className = 'skeleton-row';
    for (let column = 0; column < columns; column += 1) {
      const td = document.createElement('td');
      td.className = 'skeleton-cell';
      td.append(createSkeletonBar());
      tr.append(td);
    }
    rows.push(tr);
  }
  return rows;
}

/** Bloque de líneas para un panel que aún no tiene datos. */
export function createSkeletonLines(count = 3): HTMLElement {
  const box = document.createElement('div');
  box.className = 'skeleton-lines';
  for (let index = 0; index < count; index += 1) box.append(createSkeletonBar());
  return box;
}

/** Lo que había en la región antes de enseñar el esqueleto, para devolverlo. */
const savedContent = new WeakMap<HTMLElement, Node[]>();

/**
 * Enseña el esqueleto en una región que no es tabla y marca `aria-busy`. Al
 * pasar a `false` devuelve el contenido anterior tal cual: quien llama se
 * encarga de escribir los datos reales después.
 */
export function setRegionLoading(region: HTMLElement, busy: boolean, lines?: number): void {
  if (busy) {
    if (!savedContent.has(region)) savedContent.set(region, [...region.childNodes]);
    region.setAttribute('aria-busy', 'true');
    region.replaceChildren(createSkeletonLines(lines));
    return;
  }
  region.setAttribute('aria-busy', 'false');
  const previous = savedContent.get(region);
  if (previous !== undefined) {
    savedContent.delete(region);
    region.replaceChildren(...previous);
  }
}
