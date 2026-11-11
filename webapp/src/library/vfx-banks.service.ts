import { Injectable } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { CodedError } from '../common/api-errors';
import { analyzeVfxinfo } from './vfxinfo';
import {
  VfxBankSummaryDto,
  VfxPresetSummaryDto,
  VfxPresetChannelSummaryDto,
  VfxPresetSlotSummaryDto,
  VfxBankPluginRefDto,
  VfxPresetDescriptorDto,
  VfxMixerStripDescriptorDto,
} from './vfx-banks.dto';
import {
  parsePresetVfx,
  serializePresetVfx,
  createEmptyPresetDescriptor,
  VfxPresetDescriptor,
  VfxMixerStrip,
  VfxSendConfig,
  formatVfxChunkFilename,
} from './vfx-preset';
import { buildVfxChunk } from './vfx-chunk';

@Injectable()
export class VfxBanksService {
  constructor() {}

  private resolveLibraryRoot(explicit?: string): string {
    const raw = (explicit ?? '').trim();
    if (!raw) {
      throw new CodedError('Falta la carpeta de la librería.', 'libraryRootRequired');
    }
    return raw;
  }

  private resolveBanksDir(libraryRoot: string): string {
    return path.join(libraryRoot, 'banks');
  }

  private parseBankFolder(folder: string): { index: number; name: string; isCanonical: boolean } {
    const isCanonical = folder.toLowerCase().endsWith('.vfxbank');
    const clean = isCanonical ? folder.slice(0, -8) : folder;
    const match = clean.match(/^(\d{1,3})[_\-\s]+(.*)$/);
    if (match) {
      return {
        index: Number.parseInt(match[1]!, 10),
        name: match[2]!.trim() || clean,
        isCanonical,
      };
    }
    return {
      index: 0,
      name: clean,
      isCanonical,
    };
  }

  private parsePresetFolder(folder: string): { index: number; name: string } {
    const clean = folder.toLowerCase().endsWith('.vfxpreset') ? folder.slice(0, -10) : folder;
    const match = clean.match(/^(\d{1,3})[_\-\s]+(.*)$/);
    if (match) {
      return {
        index: Number.parseInt(match[1]!, 10),
        name: match[2]!.trim() || clean,
      };
    }
    return {
      index: 0,
      name: clean,
    };
  }

  private async scanInstalledPlugins(libraryRoot: string): Promise<Map<number, { folder: string; name: string; isSynth: boolean }>> {
    const plugsDir = path.join(libraryRoot, 'plugs');
    const result = new Map<number, { folder: string; name: string; isSynth: boolean }>();
    try {
      const entries = await fs.readdir(plugsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const vfxinfoPath = path.join(plugsDir, entry.name, 'vfxinfo.txt');
        try {
          const content = await fs.readFile(vfxinfoPath, 'latin1');
          let id: number | null = null;
          let name: string = entry.name;
          let isSynth: boolean = true;

          for (const line of content.split(/\r?\n/)) {
            const colon = line.indexOf(':');
            if (colon === -1) continue;
            const key = line.slice(0, colon).trim().toLowerCase();
            const val = line.slice(colon + 1).trim();
            if (key === 'id') {
              const num = Number.parseInt(val, 10);
              if (!Number.isNaN(num)) id = num;
            } else if (key === 'name') {
              if (val) name = val;
            } else if (key === 'is_synth') {
              isSynth = val !== '0';
            }
          }

          if (id !== null) {
            result.set(id, {
              folder: entry.name,
              name,
              isSynth,
            });
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    return result;
  }

  async listBanks(libraryRootParam?: string): Promise<{ banks: VfxBankSummaryDto[]; total: number }> {
    const libraryRoot = this.resolveLibraryRoot(libraryRootParam);
    const banksDir = this.resolveBanksDir(libraryRoot);

    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(banksDir, { withFileTypes: true });
    } catch {
      return { banks: [], total: 0 };
    }

    const installed = await this.scanInstalledPlugins(libraryRoot);
    const banks: VfxBankSummaryDto[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const parsedFolder = this.parseBankFolder(entry.name);
      const bankPath = path.join(banksDir, entry.name);

      let subEntries: import('node:fs').Dirent[] = [];
      try {
        subEntries = await fs.readdir(bankPath, { withFileTypes: true });
      } catch {
        continue;
      }

      const presetDirs = subEntries.filter(
        (s) => s.isDirectory() && s.name.toLowerCase().endsWith('.vfxpreset'),
      );

      // Si no tiene sufijo .vfxbank y no contiene .vfxpreset, no es un banco V-Machine
      if (!parsedFolder.isCanonical && presetDirs.length === 0) continue;

      let totalBytes = 0;
      let mtimeMs = 0;
      try {
        const st = await fs.stat(bankPath);
        mtimeMs = st.mtimeMs;
      } catch {
        // ignore
      }

      const pluginIdsSet = new Set<number>();

      // Inspección rápida de presets
      for (const pDir of presetDirs) {
        const pPath = path.join(bankPath, pDir.name);
        try {
          const pFiles = await fs.readdir(pPath, { withFileTypes: true });
          for (const f of pFiles) {
            if (f.isFile()) {
              const fStat = await fs.stat(path.join(pPath, f.name));
              totalBytes += fStat.size;
              // Detectar pluginId desde chunk o preset.vfx
              const m = f.name.match(/_(\d+)\.chunk$/i);
              if (m) {
                pluginIdsSet.add(Number.parseInt(m[1]!, 10));
              }
            }
          }
        } catch {
          // ignore
        }
      }

      const referencedPlugins: VfxBankPluginRefDto[] = [];
      const missingPluginIds: number[] = [];

      for (const id of pluginIdsSet) {
        const inst = installed.get(id);
        if (inst) {
          referencedPlugins.push({
            id,
            name: inst.name,
            installedFolder: inst.folder,
            isSynth: inst.isSynth,
          });
        } else {
          referencedPlugins.push({
            id,
            name: `Plugin ${id}`,
            installedFolder: null,
            isSynth: true,
          });
          missingPluginIds.push(id);
        }
      }

      banks.push({
        folder: entry.name,
        index: parsedFolder.index,
        name: parsedFolder.name,
        isCanonicalSuffix: parsedFolder.isCanonical,
        presetCount: presetDirs.length,
        totalBytes,
        mtimeMs,
        referencedPlugins,
        missingPluginIds,
        health: missingPluginIds.length > 0 ? 'repairable' : 'valid',
        issuesCount: missingPluginIds.length,
      });
    }

    banks.sort((a, b) => a.index - b.index || a.name.localeCompare(b.name));
    return { banks, total: banks.length };
  }

  async inspectBank(
    bankFolder: string,
    libraryRootParam?: string,
  ): Promise<{ bank: VfxBankSummaryDto; presets: VfxPresetSummaryDto[] }> {
    const libraryRoot = this.resolveLibraryRoot(libraryRootParam);
    const bankPath = path.join(this.resolveBanksDir(libraryRoot), bankFolder);

    try {
      const st = await fs.stat(bankPath);
      if (!st.isDirectory()) {
        throw new CodedError(`No existe el banco: ${bankFolder}`, 'bankFolderMissing', { 0: bankFolder });
      }
    } catch {
      throw new CodedError(`No existe el banco: ${bankFolder}`, 'bankFolderMissing', { 0: bankFolder });
    }

    const installed = await this.scanInstalledPlugins(libraryRoot);
    const subEntries = await fs.readdir(bankPath, { withFileTypes: true });
    const presetDirs = subEntries
      .filter((s) => s.isDirectory() && s.name.toLowerCase().endsWith('.vfxpreset'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const presets: VfxPresetSummaryDto[] = [];
    const bankPluginsSet = new Set<number>();
    let bankBytes = 0;

    for (const pDir of presetDirs) {
      const pFolderInfo = this.parsePresetFolder(pDir.name);
      const pPath = path.join(bankPath, pDir.name);
      const files = await fs.readdir(pPath, { withFileTypes: true });

      const chunkFiles: string[] = [];
      let descriptorContent = '';

      for (const f of files) {
        if (f.isFile()) {
          const fStat = await fs.stat(path.join(pPath, f.name));
          bankBytes += fStat.size;
          if (f.name.toLowerCase().endsWith('.chunk')) {
            chunkFiles.push(f.name);
          } else if (f.name.toLowerCase() === 'preset.vfx') {
            descriptorContent = await fs.readFile(path.join(pPath, f.name), 'latin1');
          }
        }
      }

      const descriptor = descriptorContent ? parsePresetVfx(descriptorContent) : createEmptyPresetDescriptor(pFolderInfo.name);

      const channelSummaries: VfxPresetChannelSummaryDto[] = descriptor.channels.map((ch, idx) => {
        const mapSlot = (slot: any): VfxPresetSlotSummaryDto | null => {
          if (!slot || !slot.pluginId) return null;
          bankPluginsSet.add(slot.pluginId);
          const inst = installed.get(slot.pluginId);
          return {
            pluginId: slot.pluginId,
            name: inst?.name || slot.name || `Plugin ${slot.pluginId}`,
            shortName: slot.shortName || '',
            midiChannel: slot.midiChannel || 0,
            midiNoteMin: slot.midiNoteMin || 0,
            midiNoteMax: slot.midiNoteMax || 127,
            midiTranspose: slot.midiTranspose || 0,
            parameterCount: slot.parameterCount || 0,
            selectedProgram: slot.selectedProgram || 0,
          };
        };

        return {
          channelIndex: idx,
          volume: ch.volume ?? 0,
          pan: ch.pan ?? 128,
          isMuted: ch.mute !== 0,
          isSolo: ch.solo !== 0,
          slotA: mapSlot(ch.slots[0]),
          slotB: mapSlot(ch.slots[1]),
          slotC: mapSlot(ch.slots[2]),
        };
      });

      const hasAuxEffects = descriptor.aux.some((a) => a.slots.some((s) => s !== null));
      const hasMasterEffects = descriptor.master.slots.some((s) => s !== null);

      presets.push({
        folder: pDir.name,
        index: pFolderInfo.index,
        name: descriptor.name || pFolderInfo.name,
        tempoBpm: descriptor.tempoBpm || 120,
        channels: channelSummaries,
        hasAuxEffects,
        hasMasterEffects,
        chunkFiles,
      });
    }

    const referencedPlugins: VfxBankPluginRefDto[] = [];
    const missingPluginIds: number[] = [];
    for (const id of bankPluginsSet) {
      const inst = installed.get(id);
      if (inst) {
        referencedPlugins.push({
          id,
          name: inst.name,
          installedFolder: inst.folder,
          isSynth: inst.isSynth,
        });
      } else {
        referencedPlugins.push({
          id,
          name: `Plugin ${id}`,
          installedFolder: null,
          isSynth: true,
        });
        missingPluginIds.push(id);
      }
    }

    const parsedFolder = this.parseBankFolder(bankFolder);
    const bankStat = await fs.stat(bankPath);

    const bankSummary: VfxBankSummaryDto = {
      folder: bankFolder,
      index: parsedFolder.index,
      name: parsedFolder.name,
      isCanonicalSuffix: parsedFolder.isCanonical,
      presetCount: presets.length,
      totalBytes: bankBytes,
      mtimeMs: bankStat.mtimeMs,
      referencedPlugins,
      missingPluginIds,
      health: missingPluginIds.length > 0 ? 'repairable' : 'valid',
      issuesCount: missingPluginIds.length,
    };

    return { bank: bankSummary, presets };
  }

  async createBank(
    name: string,
    indexParam?: number,
    libraryRootParam?: string,
  ): Promise<VfxBankSummaryDto> {
    const libraryRoot = this.resolveLibraryRoot(libraryRootParam);
    const banksDir = this.resolveBanksDir(libraryRoot);
    await fs.mkdir(banksDir, { recursive: true });

    const trimmedName = name.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 30);
    if (!trimmedName) {
      throw new CodedError('Nombre de banco inválido', 'bankNameInvalid', { 0: name });
    }

    const existing = await this.listBanks(libraryRoot);
    if (existing.total >= 128) {
      throw new CodedError('Límite de 128 bancos alcanzado', 'bankLimitExceeded');
    }

    let assignedIndex = indexParam;
    if (assignedIndex === undefined || assignedIndex < 0 || assignedIndex > 127) {
      const usedIndices = new Set(existing.banks.map((b) => b.index));
      for (let i = 0; i < 128; i++) {
        if (!usedIndices.has(i)) {
          assignedIndex = i;
          break;
        }
      }
    }

    const padIndex = String(assignedIndex).padStart(3, '0');
    const folderName = `${padIndex}_${trimmedName}.vfxbank`;
    const targetDir = path.join(banksDir, folderName);

    try {
      await fs.mkdir(targetDir);
    } catch {
      throw new CodedError(`Ya existe el banco: ${folderName}`, 'bankAlreadyExists', { 0: folderName });
    }

    return {
      folder: folderName,
      index: assignedIndex!,
      name: trimmedName,
      isCanonicalSuffix: true,
      presetCount: 0,
      totalBytes: 0,
      mtimeMs: Date.now(),
      referencedPlugins: [],
      missingPluginIds: [],
      health: 'valid',
      issuesCount: 0,
    };
  }

  async readPreset(
    bankFolder: string,
    presetFolder: string,
    libraryRootParam?: string,
  ): Promise<VfxPresetDescriptorDto> {
    const libraryRoot = this.resolveLibraryRoot(libraryRootParam);
    const presetPath = path.join(this.resolveBanksDir(libraryRoot), bankFolder, presetFolder);
    const descPath = path.join(presetPath, 'preset.vfx');

    try {
      const content = await fs.readFile(descPath, 'latin1');
      const parsed = parsePresetVfx(content);
      const toDtoStrip = (s: VfxMixerStrip): VfxMixerStripDescriptorDto => ({
        kind: s.kind,
        index: s.index,
        slotA: s.slots[0],
        slotB: s.slots[1],
        slotC: s.slots[2],
        volume: s.volume,
        pan: s.pan,
        leftIn: s.leftIn,
        rightIn: s.rightIn,
        mute: s.mute,
        solo: s.solo,
        muteOthersMidi: s.muteOthersMidi,
        toggleMuteMidi: s.toggleMuteMidi,
        toggleSoloMidi: s.toggleSoloMidi,
        volumeMidi: s.volumeMidi,
        panMidi: s.panMidi,
        muteMidi: s.muteMidi,
        soloMidi: s.soloMidi,
        sends: s.sends.map((send) => ({
          gain: send.gain,
          isPre: send.isPre,
          gainMidi: send.gainMidi,
          isPreMidi: send.isPreMidi,
        })),
      });

      return {
        name: parsed.name,
        version: parsed.version,
        tempoBpm: parsed.tempoBpm,
        timeSignatureNum: parsed.timeSignatureNum,
        timeSignatureDen: parsed.timeSignatureDen,
        tempoBpmMidi: parsed.tempoBpmMidi,
        mixerMidiChannel: parsed.mixerMidiChannel,
        audioBufferSize: parsed.audioBufferSize,
        channels: parsed.channels.map(toDtoStrip),
        aux: parsed.aux.map(toDtoStrip),
        master: toDtoStrip(parsed.master),
      };
    } catch {
      throw new CodedError(`No existe el preset: ${presetFolder}`, 'presetFolderMissing', { 0: presetFolder });
    }
  }

  async savePreset(
    bankFolder: string,
    presetFolderParam: string | undefined,
    indexParam: number | undefined,
    presetDto: VfxPresetDescriptorDto,
    libraryRootParam?: string,
  ): Promise<{ folder: string; preset: VfxPresetDescriptorDto }> {
    const libraryRoot = this.resolveLibraryRoot(libraryRootParam);
    const bankPath = path.join(this.resolveBanksDir(libraryRoot), bankFolder);

    const existingPresets = await fs.readdir(bankPath, { withFileTypes: true });
    const count = existingPresets.filter(
      (e) => e.isDirectory() && e.name.toLowerCase().endsWith('.vfxpreset'),
    ).length;

    let targetFolder = presetFolderParam;
    if (!targetFolder) {
      if (count >= 128) {
        throw new CodedError('Límite de 128 presets alcanzado', 'presetLimitExceeded');
      }
      let idx = indexParam;
      if (idx === undefined || idx < 0 || idx > 127) {
        idx = count;
      }
      const padIdx = String(idx).padStart(3, '0');
      const cleanName = (presetDto.name || 'Preset').replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 30);
      targetFolder = `${padIdx}_${cleanName}.vfxpreset`;
    }

    const presetPath = path.join(bankPath, targetFolder);
    await fs.mkdir(presetPath, { recursive: true });

    const fromDtoStrip = (s: VfxMixerStripDescriptorDto): VfxMixerStrip => ({
      kind: s.kind,
      index: s.index,
      slots: [
        s.slotA ? { ...s.slotA } : null,
        s.slotB ? { ...s.slotB } : null,
        s.slotC ? { ...s.slotC } : null,
      ],
      volume: s.volume,
      pan: s.pan,
      leftIn: s.leftIn,
      rightIn: s.rightIn,
      mute: s.mute,
      solo: s.solo,
      muteOthersMidi: s.muteOthersMidi,
      toggleMuteMidi: s.toggleMuteMidi,
      toggleSoloMidi: s.toggleSoloMidi,
      volumeMidi: s.volumeMidi,
      panMidi: s.panMidi,
      muteMidi: s.muteMidi,
      soloMidi: s.soloMidi,
      sends: [
        s.sends[0] || { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
        s.sends[1] || { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 },
      ],
    });

    const presetDomain: VfxPresetDescriptor = {
      name: presetDto.name,
      version: presetDto.version ?? 3,
      tempoBpm: presetDto.tempoBpm ?? 120,
      timeSignatureNum: presetDto.timeSignatureNum ?? 4,
      timeSignatureDen: presetDto.timeSignatureDen ?? 4,
      tempoBpmMidi: presetDto.tempoBpmMidi ?? 0,
      mixerMidiChannel: presetDto.mixerMidiChannel ?? 0,
      audioBufferSize: presetDto.audioBufferSize ?? 0,
      channels: [
        fromDtoStrip(presetDto.channels[0]!),
        fromDtoStrip(presetDto.channels[1]!),
        fromDtoStrip(presetDto.channels[2]!),
        fromDtoStrip(presetDto.channels[3]!),
      ],
      aux: [fromDtoStrip(presetDto.aux[0]!), fromDtoStrip(presetDto.aux[1]!)],
      master: fromDtoStrip(presetDto.master),
    };

    // 1. Guardar preset.vfx con CRLF y formato exacto
    const serialized = serializePresetVfx(presetDomain);
    await fs.writeFile(path.join(presetPath, 'preset.vfx'), serialized, 'latin1');

    // 2. Gestionar archivos .chunk para cada plugin en los 4 canales
    for (let ch = 0; ch < 4; ch++) {
      const strip = presetDomain.channels[ch]!;
      for (let s = 0; s < 3; s++) {
        const slot = strip.slots[s];
        if (slot && slot.pluginId) {
          const chunkName = formatVfxChunkFilename('channel', ch, s, slot.pluginId);
          const chunkPath = path.join(presetPath, chunkName);
          let exists = false;
          try {
            await fs.access(chunkPath);
            exists = true;
          } catch {
            exists = false;
          }

          if (!exists) {
            // Generar chunk inicial válido si no existía
            const chunkData = buildVfxChunk({
              pluginId: slot.pluginId,
              parameters: new Array(slot.parameterCount || 0).fill(0),
            });
            await fs.writeFile(chunkPath, Buffer.from(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength));
          }
        }
      }
    }

    return { folder: targetFolder, preset: presetDto };
  }
}
