/** Iconos SVG: el marcado declara cada `<symbol>` y aquí solo se enlaza. */

export function createIcon(name: string): SVGSVGElement {
  // El espacio de nombres va literal: `renderRecentBanks` corre antes de que se
  // inicialicen las constantes de la mitad del archivo (zona muerta temporal).
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}