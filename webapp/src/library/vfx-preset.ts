/**
 * Parser y serializador de archivos `preset.vfx` de la V-Machine (VFX Application).
 * Modos de escena de hasta 4 canales (channel: 0..3), 2 buses de envío (aux: 0..1)
 * y bus maestro (master:), con 3 slots por bus (Slot A, B, C).
 *
 * Implementado en Web Standards (cadenas de texto / latin1 / CRLF) sin dependencias
 * de node:fs para garantizar compatibilidad Zero-Fork.
 */

export interface VfxMidiMap {
  cc: number;
  param: number;
}

export interface VfxPluginSlot {
  pluginId: number;
  name: string;
  shortName: string; // Máx. 6 caracteres para LCD V-Machine
  midiChannel: number; // 0 = omni, 1..16
  midiNoteMin: number; // 0..127 (0/0 = todo el teclado)
  midiNoteMax: number; // 0..127
  midiTranspose: number; // -48..+48
  midiFromComputer: number; // 0 o 1
  chainedMidi: number; // 0 o 1
  midiThru: number; // 0 o 1
  programMidi: number;
  parameterCount: number;
  selectedProgram: number;
  midiMaps?: VfxMidiMap[];
  priorityParameters?: number[];
  extraLines?: string[];
}

export interface VfxSendConfig {
  gain: number; // 0..255
  isPre: number; // 0 o 1
  gainMidi: number;
  isPreMidi: number;
}

export interface VfxMixerStrip {
  kind: 'channel' | 'aux' | 'master';
  index: number; // 0..3 para channel, 0..1 para aux, 0 para master
  slots: [VfxPluginSlot | null, VfxPluginSlot | null, VfxPluginSlot | null];
  volume: number; // 0..255 (206 ≈ 0 dB)
  pan: number; // 0..255 (128 = centro)
  leftIn: number;
  rightIn: number;
  mute: number; // 0 o 1
  solo: number; // 0 o 1
  muteOthersMidi: number;
  toggleMuteMidi: number;
  toggleSoloMidi: number;
  volumeMidi: number;
  panMidi: number;
  muteMidi: number;
  soloMidi: number;
  sends: [VfxSendConfig, VfxSendConfig];
}

export interface VfxPresetDescriptor {
  name: string;
  version: number;
  tempoBpm: number;
  timeSignatureNum: number;
  timeSignatureDen: number;
  tempoBpmMidi: number;
  mixerMidiChannel: number;
  audioBufferSize: number;
  channels: [VfxMixerStrip, VfxMixerStrip, VfxMixerStrip, VfxMixerStrip];
  aux: [VfxMixerStrip, VfxMixerStrip];
  master: VfxMixerStrip;
}

export function createDefaultSendConfig(): VfxSendConfig {
  return { gain: 0, isPre: 0, gainMidi: 0, isPreMidi: 0 };
}

export function createDefaultMixerStrip(kind: 'channel' | 'aux' | 'master', index: number): VfxMixerStrip {
  return {
    kind,
    index,
    slots: [null, null, null],
    volume: kind === 'master' ? 206 : 0,
    pan: 128,
    leftIn: 0,
    rightIn: 0,
    mute: 0,
    solo: 0,
    muteOthersMidi: 0,
    toggleMuteMidi: 0,
    toggleSoloMidi: 0,
    volumeMidi: 0,
    panMidi: 0,
    muteMidi: 0,
    soloMidi: 0,
    sends: [createDefaultSendConfig(), createDefaultSendConfig()],
  };
}

export function createEmptyPresetDescriptor(name: string): VfxPresetDescriptor {
  return {
    name,
    version: 3,
    tempoBpm: 120,
    timeSignatureNum: 4,
    timeSignatureDen: 4,
    tempoBpmMidi: 0,
    mixerMidiChannel: 0,
    audioBufferSize: 0,
    channels: [
      createDefaultMixerStrip('channel', 0),
      createDefaultMixerStrip('channel', 1),
      createDefaultMixerStrip('channel', 2),
      createDefaultMixerStrip('channel', 3),
    ],
    aux: [createDefaultMixerStrip('aux', 0), createDefaultMixerStrip('aux', 1)],
    master: createDefaultMixerStrip('master', 0),
  };
}

/**
 * Parsea un archivo de texto `preset.vfx` respetando la indentación de bloques
 * (preset -> channel/aux/master -> plugin -> parámetros y mezcla).
 */
export function parsePresetVfx(content: string): VfxPresetDescriptor {
  const lines = content.split(/\r?\n/);
  const preset = createEmptyPresetDescriptor('Untitled');

  type StripKey = 'channel_0' | 'channel_1' | 'channel_2' | 'channel_3' | 'aux_0' | 'aux_1' | 'master';
  let currentStrip: VfxMixerStrip | null = null;
  let currentSlotIndex = -1;
  let currentSlot: VfxPluginSlot | null = null;
  let currentSendIndex = -1;

  for (let rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Conteo de espacios iniciales para determinar nivel de indentación
    const indentMatch = rawLine.match(/^( *)/);
    const indent = indentMatch ? indentMatch[1]!.length : 0;

    // Nivel 0 o 4: Metadatos globales o inicio de Strip
    if (indent === 0 || indent === 4) {
      if (trimmed.startsWith('preset:')) {
        preset.name = trimmed.slice(7).trim();
        continue;
      }
      if (trimmed.startsWith('version:')) {
        preset.version = Number(trimmed.slice(8).trim()) || 3;
        continue;
      }
      if (trimmed.startsWith('tempo_bpm:')) {
        preset.tempoBpm = Number(trimmed.slice(10).trim()) || 120;
        continue;
      }
      if (trimmed.startsWith('time_signature_num:')) {
        preset.timeSignatureNum = Number(trimmed.slice(19).trim()) || 4;
        continue;
      }
      if (trimmed.startsWith('time_signature_den:')) {
        preset.timeSignatureDen = Number(trimmed.slice(19).trim()) || 4;
        continue;
      }
      if (trimmed.startsWith('tempo_bpm_midi:')) {
        preset.tempoBpmMidi = Number(trimmed.slice(15).trim()) || 0;
        continue;
      }
      if (trimmed.startsWith('mixer_midi_channel:')) {
        preset.mixerMidiChannel = Number(trimmed.slice(19).trim()) || 0;
        continue;
      }
      if (trimmed.startsWith('audio_buffer_size:')) {
        preset.audioBufferSize = Number(trimmed.slice(18).trim()) || 0;
        continue;
      }

      // Inicio de Strip: channel: N, aux: N, master:
      if (trimmed.startsWith('channel:')) {
        const idx = Number(trimmed.slice(8).trim()) || 0;
        if (idx >= 0 && idx < 4) {
          currentStrip = preset.channels[idx]!;
          currentSlotIndex = -1;
          currentSlot = null;
          currentSendIndex = -1;
        }
        continue;
      }
      if (trimmed.startsWith('aux:')) {
        const idx = Number(trimmed.slice(4).trim()) || 0;
        if (idx >= 0 && idx < 2) {
          currentStrip = preset.aux[idx]!;
          currentSlotIndex = -1;
          currentSlot = null;
          currentSendIndex = -1;
        }
        continue;
      }
      if (trimmed.startsWith('master:')) {
        currentStrip = preset.master;
        currentSlotIndex = -1;
        currentSlot = null;
        currentSendIndex = -1;
        continue;
      }
    }

    if (!currentStrip) continue;

    // Nivel 8: Slots de plugin, propiedades de mezcla o envíos del strip
    if (indent === 8) {
      if (trimmed.startsWith('plugin:')) {
        currentSlotIndex++;
        currentSendIndex = -1;
        const idText = trimmed.slice(7).trim();
        if (idText && currentSlotIndex >= 0 && currentSlotIndex < 3) {
          currentSlot = {
            pluginId: Number(idText) || 0,
            name: '',
            shortName: '',
            midiChannel: 0,
            midiNoteMin: 0,
            midiNoteMax: 0,
            midiTranspose: 0,
            midiFromComputer: 1,
            chainedMidi: 0,
            midiThru: 0,
            programMidi: 0,
            parameterCount: 0,
            selectedProgram: 0,
            midiMaps: [],
            priorityParameters: [],
            extraLines: [],
          };
          currentStrip.slots[currentSlotIndex] = currentSlot;
        } else if (currentSlotIndex >= 0 && currentSlotIndex < 3) {
          currentSlot = null;
          currentStrip.slots[currentSlotIndex] = null;
        }
        continue;
      }

      // Parámetros de mezcla del Strip
      currentSlot = null; // Al empezar las propiedades de mezcla, salimos del slot
      if (trimmed.startsWith('volume:')) {
        currentStrip.volume = Number(trimmed.slice(7).trim()) || 0;
        continue;
      }
      if (trimmed.startsWith('pan:')) {
        currentStrip.pan = Number(trimmed.slice(4).trim()) || 128;
        continue;
      }
      if (trimmed.startsWith('left_in:')) {
        currentStrip.leftIn = Number(trimmed.slice(8).trim()) || 0;
        continue;
      }
      if (trimmed.startsWith('right_in:')) {
        currentStrip.rightIn = Number(trimmed.slice(9).trim()) || 0;
        continue;
      }
      if (trimmed.startsWith('mute:')) {
        currentStrip.mute = Number(trimmed.slice(5).trim()) || 0;
        continue;
      }
      if (trimmed.startsWith('solo:')) {
        currentStrip.solo = Number(trimmed.slice(5).trim()) || 0;
        continue;
      }
      if (trimmed.startsWith('mute_others_midi:')) {
        currentStrip.muteOthersMidi = Number(trimmed.slice(17).trim()) || 0;
        continue;
      }
      if (trimmed.startsWith('toggle_mute_midi:')) {
        currentStrip.toggleMuteMidi = Number(trimmed.slice(17).trim()) || 0;
        continue;
      }
      if (trimmed.startsWith('toggle_solo_midi:')) {
        currentStrip.toggleSoloMidi = Number(trimmed.slice(17).trim()) || 0;
        continue;
      }
      if (trimmed.startsWith('volume_midi:')) {
        currentStrip.volumeMidi = Number(trimmed.slice(12).trim()) || 0;
        continue;
      }
      if (trimmed.startsWith('pan_midi:')) {
        currentStrip.panMidi = Number(trimmed.slice(9).trim()) || 0;
        continue;
      }
      if (trimmed.startsWith('mute_midi:')) {
        currentStrip.muteMidi = Number(trimmed.slice(10).trim()) || 0;
        continue;
      }
      if (trimmed.startsWith('solo_midi:')) {
        currentStrip.soloMidi = Number(trimmed.slice(10).trim()) || 0;
        continue;
      }
      if (trimmed.startsWith('send:')) {
        currentSendIndex = Number(trimmed.slice(5).trim()) || 0;
        continue;
      }
    }

    // Nivel 12: Propiedades dentro de un plugin o dentro de un send
    if (indent === 12) {
      if (currentSlot) {
        if (trimmed.startsWith('name:')) {
          currentSlot.name = trimmed.slice(5).trim();
          continue;
        }
        if (trimmed.startsWith('short_name:')) {
          currentSlot.shortName = trimmed.slice(11).trim();
          continue;
        }
        if (trimmed.startsWith('midi_channel:')) {
          currentSlot.midiChannel = Number(trimmed.slice(13).trim()) || 0;
          continue;
        }
        if (trimmed.startsWith('midi_note_min:')) {
          currentSlot.midiNoteMin = Number(trimmed.slice(14).trim()) || 0;
          continue;
        }
        if (trimmed.startsWith('midi_note_max:')) {
          currentSlot.midiNoteMax = Number(trimmed.slice(14).trim()) || 0;
          continue;
        }
        if (trimmed.startsWith('midi_transpose:')) {
          currentSlot.midiTranspose = Number(trimmed.slice(15).trim()) || 0;
          continue;
        }
        if (trimmed.startsWith('midi_from_computer:')) {
          currentSlot.midiFromComputer = Number(trimmed.slice(19).trim()) || 0;
          continue;
        }
        if (trimmed.startsWith('chained_midi:')) {
          currentSlot.chainedMidi = Number(trimmed.slice(13).trim()) || 0;
          continue;
        }
        if (trimmed.startsWith('midi_thru:')) {
          currentSlot.midiThru = Number(trimmed.slice(10).trim()) || 0;
          continue;
        }
        if (trimmed.startsWith('program_midi:')) {
          currentSlot.programMidi = Number(trimmed.slice(13).trim()) || 0;
          continue;
        }
        if (trimmed.startsWith('parameter_count:')) {
          currentSlot.parameterCount = Number(trimmed.slice(16).trim()) || 0;
          continue;
        }
        if (trimmed.startsWith('selected_program:')) {
          currentSlot.selectedProgram = Number(trimmed.slice(17).trim()) || 0;
          continue;
        }
        if (trimmed.startsWith('midi_map:')) {
          const parts = trimmed.slice(9).trim().split(':');
          if (parts.length >= 2) {
            currentSlot.midiMaps?.push({
              cc: Number(parts[0]?.trim()) || 0,
              param: Number(parts[1]?.trim()) || 0,
            });
          }
          continue;
        }
        if (trimmed.startsWith('priority_parameter:')) {
          const val = Number(trimmed.slice(19).trim());
          if (!isNaN(val)) currentSlot.priorityParameters?.push(val);
          continue;
        }
        // Cualquier otra línea desconocida se guarda para preservación
        currentSlot.extraLines?.push(trimmed);
        continue;
      }

      if (currentSendIndex >= 0 && currentSendIndex < 2) {
        const send = currentStrip.sends[currentSendIndex]!;
        if (trimmed.startsWith('gain:')) {
          send.gain = Number(trimmed.slice(5).trim()) || 0;
          continue;
        }
        if (trimmed.startsWith('is_pre:')) {
          send.isPre = Number(trimmed.slice(7).trim()) || 0;
          continue;
        }
        if (trimmed.startsWith('gain_midi:')) {
          send.gainMidi = Number(trimmed.slice(10).trim()) || 0;
          continue;
        }
        if (trimmed.startsWith('is_pre_midi:')) {
          send.isPreMidi = Number(trimmed.slice(12).trim()) || 0;
          continue;
        }
      }
    }
  }

  return preset;
}

/**
 * Serializa un `VfxPresetDescriptor` a texto compatible con V-Machine (CRLF, sangrías exactas, líneas < 80 chars).
 */
export function serializePresetVfx(preset: VfxPresetDescriptor): string {
  const out: string[] = [];

  out.push(`preset: ${preset.name.slice(0, 30)}`);
  out.push(`    version: ${preset.version || 3}`);
  out.push(`    tempo_bpm: ${preset.tempoBpm || 120}`);
  out.push(`    time_signature_num: ${preset.timeSignatureNum || 4}`);
  out.push(`    time_signature_den: ${preset.timeSignatureDen || 4}`);
  out.push(`    tempo_bpm_midi: ${preset.tempoBpmMidi || 0}`);
  out.push(`    mixer_midi_channel: ${preset.mixerMidiChannel || 0}`);
  out.push(`    audio_buffer_size: ${preset.audioBufferSize || 0}`);
  out.push('');

  const strips: VfxMixerStrip[] = [...preset.channels, ...preset.aux, preset.master];

  for (const strip of strips) {
    if (strip.kind === 'channel') {
      out.push(`    channel: ${strip.index}`);
    } else if (strip.kind === 'aux') {
      out.push(`    aux: ${strip.index}`);
    } else {
      out.push('    master:');
    }

    // Exactamente 3 slots posicionales por Strip
    for (let s = 0; s < 3; s++) {
      const slot = strip.slots[s];
      if (slot) {
        out.push(`        plugin: ${slot.pluginId}`);
        out.push(`            name: ${slot.name.slice(0, 50)}`);
        out.push(`            short_name: ${(slot.shortName || slot.name.slice(0, 6)).slice(0, 6)}`);
        out.push(`            midi_channel: ${slot.midiChannel || 0}`);
        out.push(`            midi_note_min: ${slot.midiNoteMin || 0}`);
        out.push(`            midi_note_max: ${slot.midiNoteMax || 0}`);
        out.push(`            midi_transpose: ${slot.midiTranspose || 0}`);
        out.push(`            midi_from_computer: ${slot.midiFromComputer ?? 1}`);
        out.push(`            chained_midi: ${slot.chainedMidi || 0}`);
        out.push(`            midi_thru: ${slot.midiThru || 0}`);
        out.push(`            program_midi: ${slot.programMidi || 0}`);
        out.push(`            parameter_count: ${slot.parameterCount || 0}`);
        out.push(`            selected_program: ${slot.selectedProgram || 0}`);

        if (slot.midiMaps && slot.midiMaps.length > 0) {
          for (const m of slot.midiMaps) {
            out.push(`            midi_map: ${m.cc}: ${m.param}`);
          }
        }
        if (slot.priorityParameters && slot.priorityParameters.length > 0) {
          for (const p of slot.priorityParameters) {
            out.push(`            priority_parameter: ${p}`);
          }
        }
        if (slot.extraLines && slot.extraLines.length > 0) {
          for (const line of slot.extraLines) {
            out.push(`            ${line}`);
          }
        }
        out.push('');
      } else {
        out.push('        plugin:');
        out.push('');
      }
    }

    // Mezcla del Strip
    out.push(`        volume: ${strip.volume ?? 0}`);
    out.push(`        pan: ${strip.pan ?? 128}`);
    out.push(`        left_in: ${strip.leftIn ?? 0}`);
    out.push(`        right_in: ${strip.rightIn ?? 0}`);
    out.push(`        mute: ${strip.mute ?? 0}`);
    out.push(`        solo: ${strip.solo ?? 0}`);
    out.push(`        mute_others_midi: ${strip.muteOthersMidi ?? 0}`);
    out.push(`        toggle_mute_midi: ${strip.toggleMuteMidi ?? 0}`);
    out.push(`        toggle_solo_midi: ${strip.toggleSoloMidi ?? 0}`);
    out.push(`        volume_midi: ${strip.volumeMidi ?? 0}`);
    out.push(`        pan_midi: ${strip.panMidi ?? 0}`);
    out.push(`        mute_midi: ${strip.muteMidi ?? 0}`);
    out.push(`        solo_midi: ${strip.soloMidi ?? 0}`);
    out.push('');

    // Envíos del Strip
    for (let sendIdx = 0; sendIdx < 2; sendIdx++) {
      const send = strip.sends[sendIdx] || createDefaultSendConfig();
      out.push(`        send: ${sendIdx}`);
      out.push(`            gain: ${send.gain ?? 0}`);
      out.push(`            is_pre: ${send.isPre ?? 0}`);
      out.push(`            gain_midi: ${send.gainMidi ?? 0}`);
      out.push(`            is_pre_midi: ${send.isPreMidi ?? 0}`);
      out.push('');
    }
  }

  return out.join('\r\n') + '\r\n';
}

/**
 * Devuelve el nombre exacto de archivo `.chunk` v3 en disco según strip y slot (1-based en nombre de archivo).
 */
export function formatVfxChunkFilename(
  stripKind: 'channel' | 'aux' | 'master',
  stripIndex: number,
  slotIndex: number,
  pluginId: number,
): string {
  const slotLetter = ['a', 'b', 'c'][slotIndex] || 'a';
  if (stripKind === 'channel') {
    return `channel_${stripIndex + 1}_slot_${slotLetter}_${pluginId}.chunk`;
  }
  if (stripKind === 'aux') {
    return `aux_${stripIndex + 1}_slot_${slotLetter}_${pluginId}.chunk`;
  }
  return `master_slot_${slotLetter}_${pluginId}.chunk`;
}
