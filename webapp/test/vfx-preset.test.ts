import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  createEmptyPresetDescriptor,
  formatVfxChunkFilename,
  parsePresetVfx,
  serializePresetVfx,
} from '../src/library/vfx-preset';

const SAMPLE_PRESET_FILE = path.resolve(
  __dirname,
  '..',
  '..',
  '_banks',
  'storage',
  'banks',
  '005_Demo Drums & Effects',
  '004_Crushed Bass.vfxpreset',
  'preset.vfx',
);

test('parsePresetVfx extrae correctamente una escena con instrumento + efecto en serie', () => {
  if (!existsSync(SAMPLE_PRESET_FILE)) return;

  const text = readFileSync(SAMPLE_PRESET_FILE, 'latin1');
  const preset = parsePresetVfx(text);

  assert.equal(preset.name, 'Crushed Bass');
  assert.equal(preset.tempoBpm, 60);

  // Canal 0 tiene Bass Module en Slot A y E-Phonic LOFI en Slot B
  const ch0 = preset.channels[0];
  assert.ok(ch0.slots[0]);
  assert.equal(ch0.slots[0].pluginId, 877019731);
  assert.equal(ch0.slots[0].name, 'Bass Module');
  assert.equal(ch0.slots[0].shortName, '4FBS');

  assert.ok(ch0.slots[1]);
  assert.equal(ch0.slots[1].pluginId, 1280263753);
  assert.equal(ch0.slots[1].name, 'E-Phonic LOFI');
  assert.equal(ch0.slots[1].shortName, 'LOFI');

  assert.equal(ch0.slots[2], null);
  assert.equal(ch0.volume, 153);
  assert.equal(ch0.pan, 128);

  // Canales 1, 2, 3 vacíos
  assert.equal(preset.channels[1].slots[0], null);
  assert.equal(preset.channels[2].slots[0], null);
  assert.equal(preset.channels[3].slots[0], null);
});

test('serializePresetVfx realiza round-trip preservando la estructura y sangrías', () => {
  const original = createEmptyPresetDescriptor('Split Test');
  original.tempoBpm = 130;

  // Canal 0: Sintetizador 1
  original.channels[0].slots[0] = {
    pluginId: 1001,
    name: 'Synth A',
    shortName: 'SYNA',
    midiChannel: 1,
    midiNoteMin: 0,
    midiNoteMax: 59,
    midiTranspose: 0,
    midiFromComputer: 1,
    chainedMidi: 0,
    midiThru: 0,
    programMidi: 0,
    parameterCount: 10,
    selectedProgram: 0,
    midiMaps: [{ cc: 74, param: 5 }],
  };
  original.channels[0].volume = 206;

  // Canal 1: Sintetizador 2
  original.channels[1].slots[0] = {
    pluginId: 1002,
    name: 'Lead B',
    shortName: 'LEADB',
    midiChannel: 1,
    midiNoteMin: 60,
    midiNoteMax: 127,
    midiTranspose: 12,
    midiFromComputer: 1,
    chainedMidi: 0,
    midiThru: 0,
    programMidi: 0,
    parameterCount: 20,
    selectedProgram: 1,
  };
  original.channels[1].volume = 190;

  const serialized = serializePresetVfx(original);
  assert.ok(serialized.includes('\r\n')); // CRLF
  assert.ok(serialized.includes('preset: Split Test'));
  assert.ok(serialized.includes('channel: 0'));
  assert.ok(serialized.includes('midi_map: 74: 5'));
  assert.ok(serialized.includes('channel: 1'));

  const reparsed = parsePresetVfx(serialized);
  assert.equal(reparsed.name, 'Split Test');
  assert.equal(reparsed.tempoBpm, 130);
  assert.equal(reparsed.channels[0].slots[0]?.pluginId, 1001);
  assert.equal(reparsed.channels[0].slots[0]?.midiMaps?.[0]?.cc, 74);
  assert.equal(reparsed.channels[1].slots[0]?.pluginId, 1002);
  assert.equal(reparsed.channels[1].slots[0]?.midiNoteMin, 60);
  assert.equal(reparsed.channels[1].slots[0]?.midiTranspose, 12);
});

test('formatVfxChunkFilename genera los nombres exactos 1-based para channel y aux', () => {
  assert.equal(formatVfxChunkFilename('channel', 0, 0, 12345), 'channel_1_slot_a_12345.chunk');
  assert.equal(formatVfxChunkFilename('channel', 3, 1, 67890), 'channel_4_slot_b_67890.chunk');
  assert.equal(formatVfxChunkFilename('aux', 0, 0, 11111), 'aux_1_slot_a_11111.chunk');
  assert.equal(formatVfxChunkFilename('aux', 1, 2, 22222), 'aux_2_slot_c_22222.chunk');
  assert.equal(formatVfxChunkFilename('master', 0, 0, 33333), 'master_slot_a_33333.chunk');
});
