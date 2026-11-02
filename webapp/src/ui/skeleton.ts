/**
 * Esqueleto de carga compartido.
 *
 * El caso normal no se escribe por vista: `mountTable` pinta sus propias filas
 * de esqueleto con `TableController.setLoading`, así que cualquier tabla que
 * monte el sistema lo hereda. Aquí viven las piezas que la tabla reutiliza; los
 * paneles que esperan red (el modal de wizard) ocultan su contenido y enseñan
 * un estado `busy`, que informa mejor que doce barras grises.
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
