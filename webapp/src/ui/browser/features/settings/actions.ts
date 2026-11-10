import { t } from '../../../i18n/index.js';
import { showPanel } from '../../drawers.js';
import { els } from '../../elements.js';
import { navigateTo } from '../../views.js';
import type { StatusAction } from '../../status.js';

export function openSettingsAndFocus(
  targetFieldId: 'library-root' | 'dll-source' | 'vmachine-drive' = 'library-root',
): void {
  showPanel(els.settingsDrawer, els.settingsNavBtn);
  requestAnimationFrame(() => {
    const el = document.getElementById(targetFieldId);
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
      el.focus();
      if (el instanceof HTMLInputElement) el.select();
    }
  });
}

export function openSettingsForLibraryRootAction(): StatusAction {
  return {
    get label() { return t('ui.app.chooseRoot'); },
    title: t('ui.app.chooseRootTitle'),
    onClick: () => {
      navigateTo('libreria');
      els.root.focus({ preventScroll: false });
      els.root.select();
    },
  };
}
