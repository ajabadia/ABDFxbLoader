/**
 * Vista de Bancos Nativos V-Machine (.vfxbank) y sus Escenas (.vfxpreset).
 *
 * Implementado en Web Standards (cero dependencias de terceros),
 * montado con mountTable y respetando estilos, accesibilidad e i18n estricto.
 */
import { els } from './elements.js';
import { describeError } from './api.js';
import { libraryRoot } from './features/library/state.js';
import { mountTable, type TableController, type TableView } from '../table.js';
import { t } from '../i18n/index.js';
import { renderStatusWithAction } from './status.js';
import { openSettingsForLibraryRootAction } from './features/settings/actions.js';
import { openEditPresetDrawer } from './vfx-preset-drawer.js';
import type { VfxBankSummaryDto, VfxPresetSummaryDto } from '../vfx-banks-dto-types.js';

export let vfxBanksTableController: TableController<VfxBankSummaryDto> | null = null;
export let vfxPresetsTableController: TableController<VfxPresetSummaryDto> | null = null;
export let activeBankSummary: VfxBankSummaryDto | null = null;

export const vfxBanksTableView: TableView<VfxBankSummaryDto> = {
  columns: [
    {
      id: 'index',
      get label() {
        return t('vfxBanks.colIndex');
      },
      cellClass: 'mono',
      getValue: (bank: VfxBankSummaryDto) => bank.index,
      renderCell: (bank: VfxBankSummaryDto) => String(bank.index).padStart(3, '0'),
    },
    {
      id: 'name',
      get label() {
        return t('common.name');
      },
      getValue: (bank: VfxBankSummaryDto) => bank.name,
      renderNode: (bank: VfxBankSummaryDto) => {
        const wrap = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = bank.name;
        wrap.append(strong);
        const folder = document.createElement('span');
        folder.className = 'sub-label';
        folder.textContent = bank.folder;
        wrap.append(folder);
        return wrap;
      },
    },
    {
      id: 'presetCount',
      get label() {
        return t('vfxBanks.colPresets');
      },
      getValue: (bank: VfxBankSummaryDto) => bank.presetCount,
      renderCell: (bank: VfxBankSummaryDto) => `${bank.presetCount} / 128`,
    },
    {
      id: 'health',
      get label() {
        return t('vfxBanks.colHealth');
      },
      getValue: (bank: VfxBankSummaryDto) => bank.health,
      renderNode: (bank: VfxBankSummaryDto) => {
        const badge = document.createElement('span');
        badge.className = `badge ${bank.health === 'valid' ? 'on' : bank.health === 'repairable' ? 'warn' : 'danger'}`;
        badge.textContent =
          bank.health === 'valid'
            ? t('vfxBanks.healthValid')
            : bank.health === 'repairable'
              ? t('vfxBanks.healthRepairable')
              : t('vfxBanks.healthBroken');
        return badge;
      },
    },
  ],
  getRowId: (bank: VfxBankSummaryDto) => bank.folder,
  initialSort: { columnId: 'index', direction: 'asc' },
  rowActions: {
    actions: (bank: VfxBankSummaryDto) => [
      {
        id: 'view-presets',
        get label() {
          return t('vfxBanks.actionViewPresets');
        },
        icon: 'list',
        onSelect: () => {
          void selectVfxBank(bank);
        },
      },
    ],
  },
  emptyText: () => t('vfxBanks.empty'),
};

export const vfxPresetsTableView: TableView<VfxPresetSummaryDto> = {
  columns: [
    {
      id: 'index',
      get label() {
        return t('vfxBanks.colIndex');
      },
      cellClass: 'mono',
      getValue: (preset: VfxPresetSummaryDto) => preset.index,
      renderCell: (preset: VfxPresetSummaryDto) => String(preset.index).padStart(3, '0'),
    },
    {
      id: 'name',
      get label() {
        return t('common.name');
      },
      getValue: (preset: VfxPresetSummaryDto) => preset.name,
      renderCell: (preset: VfxPresetSummaryDto) => preset.name,
    },
    {
      id: 'channels',
      get label() {
        return t('vfxBanks.colChannels');
      },
      getValue: () => '',
      renderNode: (preset: VfxPresetSummaryDto) => {
        const wrap = document.createElement('div');
        wrap.className = 'vfx-ch-summary';
        const channels = preset.channels || [];
        for (let i = 0; i < 4; i++) {
          const ch = channels[i];
          const pill = document.createElement('span');
          pill.className = `badge ${ch && ch.slotA ? 'on' : 'off'}`;
          pill.textContent = `Ch${i + 1}: ${ch && ch.slotA ? ch.slotA.shortName || ch.slotA.name : '—'}`;
          wrap.append(pill);
        }
        return wrap;
      },
    },
    {
      id: 'tempo',
      get label() {
        return t('vfxBanks.colTempo');
      },
      getValue: (preset: VfxPresetSummaryDto) => preset.tempoBpm,
      renderCell: (preset: VfxPresetSummaryDto) => `${preset.tempoBpm} BPM`,
    },
  ],
  getRowId: (preset: VfxPresetSummaryDto) => preset.folder,
  initialSort: { columnId: 'index', direction: 'asc' },
  rowActions: {
    actions: (preset: VfxPresetSummaryDto) => [
      {
        id: 'edit-preset',
        get label() {
          return t('vfxBanks.actionEditPreset');
        },
        icon: 'edit',
        onSelect: () => {
          if (activeBankSummary) {
            void openEditPresetDrawer(activeBankSummary.folder, preset.folder);
          }
        },
      },
    ],
  },
  emptyText: () => t('vfxBanks.presetsEmpty'),
};

export async function refreshVfxBanksView(): Promise<void> {
  const root = libraryRoot;
  if (!root) {
    renderStatusWithAction(els.vfxBanksStatus, t('vfxBanks.noLibraryRoot'), 'info', openSettingsForLibraryRootAction());
    els.vfxBanksTable.replaceChildren();
    els.vfxBankDetailCard.hidden = true;
    return;
  }

  els.vfxBanksStatus.textContent = t('common.refresh');
  els.vfxBanksStatus.className = 'status busy';

  try {
    const res = await fetch('/library/vfx-banks/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ libraryRoot: root }),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as { banks: VfxBankSummaryDto[] };
    els.vfxBanksStatus.textContent = '';
    els.vfxBanksStatus.className = 'status';

    vfxBanksTableController = mountTable(els.vfxBanksTable, vfxBanksTableView, data.banks);

    if (activeBankSummary) {
      const updated = data.banks.find((b) => b.folder === activeBankSummary!.folder);
      if (updated) {
        void selectVfxBank(updated);
      } else {
        els.vfxBankDetailCard.hidden = true;
        activeBankSummary = null;
      }
    }
  } catch (error) {
    els.vfxBanksStatus.textContent = describeError(error);
    els.vfxBanksStatus.className = 'status error';
  }
}

export async function selectVfxBank(bank: VfxBankSummaryDto): Promise<void> {
  activeBankSummary = bank;
  els.vfxBankDetailCard.hidden = false;
  els.vfxBankDetailTitle.textContent = bank.name;
  els.vfxBankDetailCount.textContent = `${bank.presetCount} / 128`;

  const root = libraryRoot;
  try {
    const res = await fetch('/library/vfx-banks/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ libraryRoot: root, bankFolder: bank.folder }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { presets: VfxPresetSummaryDto[] };
    vfxPresetsTableController = mountTable(els.vfxPresetsTable, vfxPresetsTableView, data.presets);
  } catch (error) {
    els.vfxBanksStatus.textContent = describeError(error);
    els.vfxBanksStatus.className = 'status error';
  }
}
