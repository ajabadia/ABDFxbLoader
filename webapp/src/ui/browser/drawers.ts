/**
 * Cajones modales: apertura con foco, cierre que devuelve el foco y la lista
 * de controles que entran con Tab mientras el panel está abierto.
 *
 * Un cajón siempre cuelga de algo ya elegido (un plugin, una acción), por eso
 * oscurece el fondo: las colecciones navegables son vistas, no cajones.
 */
import { els } from './elements.js';

/** Cajón abierto (bancos o catálogo) y el control que lo abrió. */
export let openPanel: HTMLElement | null = null;
let panelOpener: HTMLElement | null = null;

/** Controles que reciben Tab dentro del cajón, en orden de documento. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function isFocusableByTab(element: HTMLElement): boolean {
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
  }
  // Sin `checkVisibility`, el contenido de un `<details>` cerrado conserva
  // rectángulos aunque el navegador no lo tabule; solo su `summary` entra.
  if (element.getClientRects().length === 0) return false;
  const details = element.closest('details');
  return details === null || details.open || element.matches('summary');
}

export function panelFocusables(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isFocusableByTab);
}

/**
 * Abre un cajón como diálogo modal: recuerda quién lo abrió, le da el foco al
 * panel para que el lector anuncie su nombre (`aria-labelledby`) y deja el Tab
 * encerrado dentro mientras siga abierto.
 */
export function showPanel(panel: HTMLElement, opener?: HTMLElement): void {
  panel.scrollTop = 0;
  if (openPanel === panel) return;
  const active = document.activeElement;
  panelOpener = opener ?? (active instanceof HTMLElement && active !== panel ? active : null);
  openPanel = panel;
  panel.hidden = false;
  els.drawerBackdrop.hidden = false;
  document.body.classList.add('drawer-open');
  panel.focus({ preventScroll: true });
}

export function hidePanel(panel: HTMLElement): void {
  panel.hidden = true;
  if (openPanel !== panel) return;

  openPanel = null;
  if (
    els.banks.hidden &&
    els.meta.hidden &&
    els.pluginWizard.hidden &&
    els.logDrawer.hidden &&
    els.importPackageDrawer.hidden &&
    els.customPluginDrawer.hidden &&
    els.settingsDrawer.hidden
  ) {
    els.drawerBackdrop.hidden = true;
    document.body.classList.remove('drawer-open');
  }

  const opener = panelOpener;
  panelOpener = null;
  // El menú de fila se cierra al abrir el cajón: si el control quedó oculto no
  // se le puede devolver el foco, y no es un error.
  if (opener !== null && opener.isConnected && opener.getClientRects().length > 0) {
    opener.focus({ preventScroll: true });
  }
}