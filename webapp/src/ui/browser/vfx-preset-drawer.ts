/**
 * Compositor de Escenas Multi-Plugin de 4 Canales para la V-Machine (#vfx-preset-drawer).
 */
import { els } from './elements.js';
import { hidePanel, showPanel } from './drawers.js';
import { t } from '../i18n/index.js';
import { describeError } from './api.js';
import { libraryRoot } from './features/library/state.js';
import { activeBankSummary, selectVfxBank } from './vfx-banks-view.js';
import { createKnob } from './knob.js';

export interface VfxPluginSlotState {
  pluginId: number;
  name: string;
  shortName: string;
  midiChannel: number;
  midiNoteMin: number;
  midiNoteMax: number;
  midiTranspose: number;
  midiFromComputer: number;
  chainedMidi: number;
  midiThru: number;
  programMidi: number;
  parameterCount: number;
  selectedProgram: number;
}

export interface VfxChannelState {
  index: number;
  volume: number;
  pan: number;
  midiChannel: number;
  midiNoteMin: number;
  midiNoteMax: number;
  midiTranspose: number;
  slotA: VfxPluginSlotState | null;
  slotB: VfxPluginSlotState | null;
  slotC: VfxPluginSlotState | null;
  sends: [{ gain: number; isPre: number; gainMidi: number; isPreMidi: number }, { gain: number; isPre: number; gainMidi: number; isPreMidi: number }];
}

export interface VfxPresetState {
  bankFolder: string;
  presetFolder?: string;
  index?: number;
  name: string;
  tempoBpm: number;
  timeSignatureNum: number;
  timeSignatureDen: number;
  channels: VfxChannelState[];
  aux: VfxChannelState[];
  master: VfxChannelState;
}

export interface AvailablePlugin {
  id: number;
  name: string;
  folder: string;
  isSynth: boolean;
}

let currentPresetState: VfxPresetState | null = null;
let cachedLibraryPlugins: AvailablePlugin[] = [];

async function loadAvailablePlugins(): Promise<AvailablePlugin[]> {
  if (cachedLibraryPlugins.length > 0) return cachedLibraryPlugins;
  const root = libraryRoot;
  if (!root) return [];
  try {
    const res = await fetch('/library/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ libraryRoot: root }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { plugins: Array<{ name: string; path: string }> };
    
    // Si tenemos plugins del escáner y plugins de bancos, los unificamos
    const list: AvailablePlugin[] = [];
    const seen = new Set<string>();

    if (activeBankSummary?.referencedPlugins) {
      for (const ref of activeBankSummary.referencedPlugins) {
        list.push({
          id: ref.id,
          name: ref.name,
          folder: ref.installedFolder || ref.name,
          isSynth: ref.isSynth ?? true,
        });
        seen.add(ref.name.toLowerCase());
      }
    }

    cachedLibraryPlugins = list;
    return cachedLibraryPlugins;
  } catch {
    return activeBankSummary?.referencedPlugins?.map((ref) => ({
      id: ref.id,
      name: ref.name,
      folder: ref.installedFolder || ref.name,
      isSynth: ref.isSynth ?? true,
    })) || [];
  }
}

function createEmptySlot(): VfxPluginSlotState {
  return {
    pluginId: 0,
    name: '',
    shortName: '',
    midiChannel: 0,
    midiNoteMin: 0,
    midiNoteMax: 127,
    midiTranspose: 0,
    midiFromComputer: 1,
    chainedMidi: 0,
    midiThru: 0,
    programMidi: 0,
    parameterCount: 0,
    selectedProgram: 0,
  };
}

function createEmptyChannel(index: number, isMaster = false): VfxChannelState {
  return {
    index,
    volume: isMaster ? 206 : index === 0 ? 206 : 0,
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
    master: createEmptyChannel(0, true),
  };
  void loadAvailablePlugins().then(() => {
    renderPresetDrawer();
    showPanel(els.vfxPresetDrawer, els.vfxPresetCreateBtn);
  });
}

export async function openEditPresetDrawer(bankFolder: string, presetFolder: string): Promise<void> {
  const root = libraryRoot;
  if (!root) return;

  try {
    const res = await fetch('/library/vfx-banks/preset/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ libraryRoot: root, bankFolder, presetFolder }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const descriptor = await res.json() as any;

    currentPresetState = {
      bankFolder,
      presetFolder,
      name: descriptor.name || 'Preset',
      tempoBpm: descriptor.tempoBpm || 120,
      timeSignatureNum: descriptor.timeSignatureNum || 4,
      timeSignatureDen: descriptor.timeSignatureDen || 4,
      channels: descriptor.channels.map((ch: any, idx: number) => ({
        index: idx,
        volume: ch.volume ?? 0,
        pan: ch.pan ?? 128,
        midiChannel: ch.slotA?.midiChannel ?? 0,
        midiNoteMin: ch.slotA?.midiNoteMin ?? 0,
        midiNoteMax: ch.slotA?.midiNoteMax ?? 127,
        midiTranspose: ch.slotA?.midiTranspose ?? 0,
        slotA: ch.slotA ? { ...ch.slotA } : null,
        slotB: ch.slotB ? { ...ch.slotB } : null,
        slotC: ch.slotC ? { ...ch.slotC } : null,
        sends: ch.sends || [
          { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
          { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
        ],
      })),
      aux: descriptor.aux.map((a: any, idx: number) => ({
        index: idx,
        volume: a.volume ?? 0,
        pan: a.pan ?? 128,
        midiChannel: 0,
        midiNoteMin: 0,
        midiNoteMax: 127,
        midiTranspose: 0,
        slotA: a.slotA ? { ...a.slotA } : null,
        slotB: a.slotB ? { ...a.slotB } : null,
        slotC: a.slotC ? { ...a.slotC } : null,
        sends: [
          { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
          { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
        ],
      })),
      master: {
        index: 0,
        volume: descriptor.master?.volume ?? 206,
        pan: descriptor.master?.pan ?? 128,
        midiChannel: 0,
        midiNoteMin: 0,
        midiNoteMax: 127,
        midiTranspose: 0,
        slotA: descriptor.master?.slotA ? { ...descriptor.master.slotA } : null,
        slotB: descriptor.master?.slotB ? { ...descriptor.master.slotB } : null,
        slotC: descriptor.master?.slotC ? { ...descriptor.master.slotC } : null,
        sends: [
          { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
          { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
        ],
      },
    };

    await loadAvailablePlugins();
    renderPresetDrawer();
    showPanel(els.vfxPresetDrawer);
  } catch (error) {
    els.vfxBanksStatus.textContent = describeError(error);
    els.vfxBanksStatus.className = 'status error';
  }
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

  renderChannelsGrid();
  renderGlobalBuses();
  updateLcdPreview();
}

function renderChannelsGrid(): void {
  if (!currentPresetState) return;
  els.vfxChannelsGrid.replaceChildren();

  currentPresetState.channels.forEach((channel, chIndex) => {
    const card = document.createElement('div');
    card.className = 'vfx-channel-card';

    const head = document.createElement('div');
    head.className = 'vfx-channel-head';
    const title = document.createElement('h4');
    title.textContent = t('vfxPreset.channel', { 0: chIndex + 1 });
    head.append(title);
    card.append(head);

    // Slot A (Principal)
    const slotAField = createSlotField('slotA', t('vfxPreset.slotA'), channel.slotA, (newSlot) => {
      channel.slotA = newSlot;
      if (newSlot && channel.volume === 0) {
        channel.volume = 206;
      }
      updateLcdPreview();
    });
    card.append(slotAField);

    // Slot B (Inserción 1)
    const slotBField = createSlotField('slotB', t('vfxPreset.slotB'), channel.slotB, (newSlot) => {
      channel.slotB = newSlot;
      updateLcdPreview();
    });
    card.append(slotBField);

    // Slot C (Inserción 2)
    const slotCField = createSlotField('slotC', t('vfxPreset.slotC'), channel.slotC, (newSlot) => {
      channel.slotC = newSlot;
      updateLcdPreview();
    });
    card.append(slotCField);

    // Grupo de Potenciómetros Rotatorios (Knobs) para Mezcla y Envíos
    const knobsGroup = document.createElement('div');
    knobsGroup.className = 'vfx-knobs-group';

    // Knob Volumen
    const volKnob = createKnob({
      label: t('vfxPreset.volume'),
      min: 0,
      max: 255,
      value: channel.volume,
      unit: '%',
      onChange: (val) => {
        channel.volume = val;
      },
    });
    knobsGroup.append(volKnob);

    // Knob Panorama
    const panKnob = createKnob({
      label: t('vfxPreset.pan'),
      min: 0,
      max: 255,
      value: channel.pan,
      bipolar: true,
      onChange: (val) => {
        channel.pan = val;
      },
    });
    knobsGroup.append(panKnob);

    // Knob Envío Aux 1
    const aux1Knob = createKnob({
      label: t('vfxPreset.sendAux1'),
      min: 0,
      max: 255,
      value: channel.sends[0].gain,
      unit: '%',
      onChange: (val) => {
        channel.sends[0].gain = val;
      },
    });
    knobsGroup.append(aux1Knob);

    // Knob Envío Aux 2
    const aux2Knob = createKnob({
      label: t('vfxPreset.sendAux2'),
      min: 0,
      max: 255,
      value: channel.sends[1].gain,
      unit: '%',
      onChange: (val) => {
        channel.sends[1].gain = val;
      },
    });
    knobsGroup.append(aux2Knob);

    card.append(knobsGroup);

    // MIDI Channel y Transpose
    const midiRow = document.createElement('div');
    midiRow.className = 'row vfx-midi-row';

    const chLabel = document.createElement('label');
    chLabel.className = 'field';
    const chSpan = document.createElement('span');
    chSpan.textContent = t('vfxPreset.midiChannel');
    const chSelect = document.createElement('select');
    const optOmni = document.createElement('option');
    optOmni.value = '0';
    optOmni.textContent = 'Omni';
    chSelect.append(optOmni);
    for (let m = 1; m <= 16; m++) {
      const opt = document.createElement('option');
      opt.value = String(m);
      opt.textContent = `Ch ${m}`;
      chSelect.append(opt);
    }
    chSelect.value = String(channel.midiChannel);
    chSelect.addEventListener('change', () => {
      channel.midiChannel = Number(chSelect.value);
    });
    chLabel.append(chSpan, chSelect);
    midiRow.append(chLabel);

    card.append(midiRow);
    els.vfxChannelsGrid.append(card);
  });
}

function renderGlobalBuses(): void {
  if (!currentPresetState) return;
  els.vfxBusesContent.replaceChildren();

  // Aux 1 y Aux 2
  currentPresetState.aux.forEach((auxStrip, idx) => {
    const card = document.createElement('div');
    card.className = 'vfx-channel-card vfx-aux-card';

    const title = document.createElement('h4');
    title.textContent = t('vfxPreset.auxBus', { 0: idx + 1 });
    card.append(title);

    const slotField = createSlotField('slotA', t('vfxPreset.slotA'), auxStrip.slotA, (newSlot) => {
      auxStrip.slotA = newSlot;
    });
    card.append(slotField);

    els.vfxBusesContent.append(card);
  });

  // Master
  const masterCard = document.createElement('div');
  masterCard.className = 'vfx-channel-card vfx-master-card';
  const mTitle = document.createElement('h4');
  mTitle.textContent = t('vfxPreset.masterBus');
  masterCard.append(mTitle);

  const mSlotField = createSlotField('slotA', t('vfxPreset.slotA'), currentPresetState.master.slotA, (newSlot) => {
    currentPresetState!.master.slotA = newSlot;
  });
  masterCard.append(mSlotField);
  els.vfxBusesContent.append(masterCard);
}

function createSlotField(
  slotId: 'slotA' | 'slotB' | 'slotC',
  labelStr: string,
  currentSlot: VfxPluginSlotState | null,
  onChange: (slot: VfxPluginSlotState | null) => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field vfx-slot-field';

  const label = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = labelStr;
  label.append(span);

  const select = document.createElement('select');
  const optEmpty = document.createElement('option');
  optEmpty.value = '';
  optEmpty.textContent = t('vfxPreset.emptySlot');
  select.append(optEmpty);

  const plugins = cachedLibraryPlugins.length > 0
    ? cachedLibraryPlugins
    : (activeBankSummary?.referencedPlugins?.map((p) => ({
        id: p.id,
        name: p.name,
        folder: p.installedFolder || p.name,
        isSynth: p.isSynth ?? true,
      })) || []);

  const synthsGroup = document.createElement('optgroup');
  synthsGroup.label = 'Synths';
  const fxGroup = document.createElement('optgroup');
  fxGroup.label = 'Effects';

  plugins.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = String(p.id ?? 0);
    opt.textContent = p.name;
    if (p.isSynth) {
      synthsGroup.append(opt);
    } else {
      fxGroup.append(opt);
    }
  });

  if (synthsGroup.children.length > 0) select.append(synthsGroup);
  if (fxGroup.children.length > 0) select.append(fxGroup);

  if (currentSlot && currentSlot.pluginId) {
    select.value = String(currentSlot.pluginId);
  }

  select.addEventListener('change', () => {
    const chosenId = Number(select.value);
    if (!chosenId) {
      onChange(null);
    } else {
      const found = plugins.find((p) => p.id === chosenId);
      const newSlot = createEmptySlot();
      newSlot.pluginId = chosenId;
      newSlot.name = found?.name ?? `Plugin ${chosenId}`;
      newSlot.shortName = (found?.name ?? 'PLUG').slice(0, 6).trim();
      newSlot.parameterCount = 0;
      onChange(newSlot);
    }
  });

  label.append(select);
  wrap.append(label);
  return wrap;
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
