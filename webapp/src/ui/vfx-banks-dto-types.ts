export interface VfxBankPluginRefDto {
  id: number;
  name: string;
  installedFolder?: string;
  isSynth?: boolean;
}

export interface VfxBankSummaryDto {
  folder: string;
  index: number;
  name: string;
  isCanonicalSuffix: boolean;
  presetCount: number;
  totalBytes: number;
  mtimeMs: number;
  referencedPlugins: VfxBankPluginRefDto[];
  missingPluginIds: number[];
  health: 'valid' | 'repairable' | 'broken';
  issuesCount: number;
}

export interface VfxPresetSlotSummaryDto {
  slotIndex: number;
  pluginId: number;
  name: string;
  shortName: string;
  isMissing: boolean;
}

export interface VfxPresetChannelSummaryDto {
  channelIndex: number;
  slotA: VfxPresetSlotSummaryDto | null;
  slotB: VfxPresetSlotSummaryDto | null;
  slotC: VfxPresetSlotSummaryDto | null;
  volume: number;
  pan: number;
  midiChannel: number;
  midiNoteMin: number;
  midiNoteMax: number;
  midiTranspose: number;
}

export interface VfxPresetSummaryDto {
  folder: string;
  index: number;
  name: string;
  tempoBpm: number;
  channelsSummary: VfxPresetChannelSummaryDto[];
  hasAuxEffects: boolean;
  hasMasterEffects: boolean;
}
