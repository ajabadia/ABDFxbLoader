/**
 * Router de vistas: librería, catálogo de wizards y auditoría.
 *
 * Vive aparte porque es el único sitio que decide quién se ve, y porque el
 * estado de cada vista (scroll incluido) no debe mezclarse con las funciones
 * que pintan su contenido.
 */
import { els } from './elements.js';
import {
  closeBanks,
  closeMeta,
  closePluginWizard,
  closeLogDrawer,
  closeImportPackageDrawer,
  closeCustomPluginDrawer,
  ensureWizardsLoaded,
  loadDataAudit,
  loadAssociationAudit,
  startAuditPolling,
  stopAuditPolling,
  scanData,
} from './main.js';

/**
 * Vistas
 *
 * La librería, el catálogo de wizards y las auditorías son colecciones: se
 * navegan, no se abren encima de otra cosa. Cada una conserva su estado
 * (filtro, orden, página, scroll) y la barra solo cambia de destino. Los
 * cajones quedan para lo que cuelga de un plugin concreto: sus bancos, sus
 * metadatos y su historial.
 */
export type ViewId = 'libreria' | 'wizards' | 'auditoria';
export type AuditTab = 'data' | 'associations';

const VIEW_HASH: Record<ViewId, string> = {
  libreria: '#/libreria',
  wizards: '#/wizards',
  auditoria: '#/auditoria',
};

export let activeView: ViewId | null = null;
export let activeAuditTab: AuditTab = 'data';
const viewScroll = new Map<ViewId, number>();

export function viewFromHash(): ViewId {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return raw === 'wizards' || raw === 'auditoria' ? raw : 'libreria';
}

function viewButtons(): [ViewId, HTMLButtonElement][] {
  return [
    ['libreria', els.libraryNavBtn],
    ['wizards', els.wizardsNavBtn],
    ['auditoria', els.auditViewBtn],
  ];
}

/** Sin datos escaneados la vista de librería enseña la portada, no una tabla. */
export function syncLibraryView(): void {
  const hasData = scanData !== null;
  els.results.hidden = !hasData;
  els.libraryEmpty.hidden = hasData;
}

function closeAllDrawers(): void {
  closeBanks();
  closeMeta();
  closePluginWizard();
  closeLogDrawer();
  closeImportPackageDrawer();
  closeCustomPluginDrawer();
}

export function applyView(view: ViewId): void {
  if (activeView !== null && activeView !== view) viewScroll.set(activeView, window.scrollY);
  if (activeView !== view) closeAllDrawers();
  activeView = view;

  els.libraryView.hidden = view !== 'libreria';
  els.wizards.hidden = view !== 'wizards';
  els.auditView.hidden = view !== 'auditoria';

  for (const [id, button] of viewButtons()) {
    if (id === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  if (view === 'libreria') syncLibraryView();
  if (view === 'wizards') void ensureWizardsLoaded();
  if (view === 'auditoria') showAuditTab(activeAuditTab, true);
  else stopAuditPolling();

  window.scrollTo({ top: viewScroll.get(view) ?? 0 });
}

export function navigateTo(view: ViewId): void {
  const hash = VIEW_HASH[view];
  if (window.location.hash !== hash) window.history.pushState(null, '', hash);
  applyView(view);
}

/**
 * Cambia de pestaña dentro de la vista de auditoría. `reload` solo se activa al
 * entrar en la vista: pulsar dos veces la misma pestaña no vuelve a leer.
 */
export function showAuditTab(tab: AuditTab, reload: boolean): void {
  const changed = tab !== activeAuditTab;
  activeAuditTab = tab;
  els.auditData.hidden = tab !== 'data';
  els.auditAssociations.hidden = tab !== 'associations';
  els.dataAuditNavBtn.setAttribute('aria-selected', String(tab === 'data'));
  els.auditNavBtn.setAttribute('aria-selected', String(tab === 'associations'));

  if (tab === 'associations') {
    startAuditPolling();
    if (reload || changed) void loadAssociationAudit();
  } else {
    stopAuditPolling();
    if (reload || changed) void loadDataAudit();
  }
}

window.addEventListener('popstate', () => {
  applyView(viewFromHash());
});
window.addEventListener('hashchange', () => {
  applyView(viewFromHash());
});
