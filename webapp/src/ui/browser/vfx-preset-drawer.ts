/**
 * Compositor de Escenas Multi-Plugin de 4 Canales para la V-Machine (#vfx-preset-drawer).
 */
import { els } from './elements.js';
import { hidePanel, showPanel } from './drawers.js';
import { t } from '../i18n/index.js';
import { describeError } from './api.js';
import { libraryRoot } from './features/library/state.js';
import { activeBankSummary, selectVfxBank } from './vfx-banks-view.js';

export interface VfxPresetState {
  bankFolder: string;
  presetFolder?: string;
  index?: number;
  name: string;
  tempoBpm: number;
  timeSignatureNum: number;
  timeSignatureDen: number;
  channels: any[];
  aux: any[];
  master: any;
}

let currentPresetState: VfxPresetState | null = null;

export function openNewPresetDrawer(): void {
  if (!activeBankSummary) return;
  currentPresetState = {
    bankFolder: activeBankSummary.folder,
    name: 'New Scene',
    tempoBpm: 120,
    timeSignatureNum: 4,
    timeSignatureDen: 4,
    channels: [
      createEmptyChannel(0),
      createEmptyChannel(1),
      createEmptyChannel(2),
      createEmptyChannel(3),
    ],
    aux: [createEmptyChannel(0), createEmptyChannel(1)],
    master: createEmptyChannel(0),
  };
  renderPresetDrawer();
  showPanel(els.vfxPresetDrawer, els.vfxPresetCreateBtn);
}

function createEmptyChannel(index: number) {
  return {
    index,
    volume: 206,
    pan: 128,
    midiChannel: 0,
    midiNoteMin: 0,
    midiNoteMax: 127,
    midiTranspose: 0,
    slotA: null,
    slotB: null,
    slotC: null,
    sends: [
      { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
      { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
    ],
  };
}

export function closePresetDrawer(): void {
  hidePanel(els.vfxPresetDrawer);
  currentPresetState = null;
}

export function renderPresetDrawer(): void {
  if (!currentPresetState) return;

  els.vfxPresetName.value = currentPresetState.name;
  els.vfxPresetTempo.value = String(currentPresetState.tempoBpm);
  els.vfxPresetTimesigNum.value = String(currentPresetState.timeSignatureNum);
  els.vfxPresetTimesigDen.value = String(currentPresetState.timeSignatureDen);

  updateLcdPreview();
}

function updateLcdPreview(): void {
  if (!currentPresetState) return;
  const line1 = `BNK 000:000 ${currentPresetState.name.slice(0, 16)}`;
  const slotsText = currentPresetState.channels
    .map((c, i) => `${i + 1}:${c.slotA ? (c.slotA.shortName || 'PLUG').slice(0, 4) : '----'}`)
    .join(' ');
  els.vfxLcdLine1.textContent = line1;
  els.vfxLcdLine2.textContent = slotsText;
}

export async function saveCurrentPreset(): Promise<void> {
  if (!currentPresetState) return;
  const root = libraryRoot;
  if (!root) return;

  currentPresetState.name = els.vfxPresetName.value.trim() || 'Preset';
  currentPresetState.tempoBpm = Number(els.vfxPresetTempo.value) || 120;
  currentPresetState.timeSignatureNum = Number(els.vfxPresetTimesigNum.value) || 4;
  currentPresetState.timeSignatureDen = Number(els.vfxPresetTimesigDen.value) || 4;

  els.vfxPresetStatus.textContent = t('common.save');
  els.vfxPresetStatus.className = 'status busy';

  try {
    const res = await fetch('/library/vfx-banks/preset/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        libraryRoot: root,
        bankFolder: currentPresetState.bankFolder,
        presetFolder: currentPresetState.presetFolder,
        index: currentPresetState.index,
        preset: {
          name: currentPresetState.name,
          version: 3,
          tempoBpm: currentPresetState.tempoBpm,
          timeSignatureNum: currentPresetState.timeSignatureNum,
          timeSignatureDen: currentPresetState.timeSignatureDen,
          tempoBpmMidi: 0,
          mixerMidiChannel: 0,
          audioBufferSize: 0,
          channels: currentPresetState.channels,
          aux: currentPresetState.aux,
          master: currentPresetState.master,
        },
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    els.vfxPresetStatus.textContent = t('vfxBanks.presetSaved');
    els.vfxPresetStatus.className = 'status ok';

    if (activeBankSummary) {
      void selectVfxBank(activeBankSummary);
    }
    setTimeout(() => {
      closePresetDrawer();
    }, 400);
  } catch (error) {
    els.vfxPresetStatus.textContent = describeError(error);
    els.vfxPresetStatus.className = 'status error';
  }
}
