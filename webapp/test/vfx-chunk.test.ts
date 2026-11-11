import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  buildVfxChunk,
  parseVfxChunk,
  parseVfxChunkHeader,
  patchVfxChunkPluginId,
  vfxCrc16Finalize,
  vfxCrc16Update,
  VFX_CHUNK_MAGIC,
} from '../src/library/vfx-chunk';

const SAMPLE_CHUNK = path.resolve(
  __dirname,
  '..',
  '..',
  '_banks',
  'storage',
  'banks',
  '005_Demo Drums & Effects',
  '004_Crushed Bass.vfxpreset',
  'channel_1_slot_b_1280263753.chunk',
);

test('algoritmo CRC-16 de vfx.exe reproduce exactamente el checksum de un .chunk real', () => {
  if (!existsSync(SAMPLE_CHUNK)) return;

  const bytes = new Uint8Array(readFileSync(SAMPLE_CHUNK));
  assert.equal(bytes.length, 168);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerChecksum = view.getUint16(0x10, true);
  const overallChecksum = view.getUint16(0x12, true);

  const s1 = vfxCrc16Update(0xffff, bytes.subarray(0x14, 0x64));
  const calcHeader = vfxCrc16Finalize(s1);
  assert.equal(calcHeader, headerChecksum, 'headerChecksum coincide');

  const s2 = vfxCrc16Update(s1, bytes.subarray(0x64));
  const calcOverall = vfxCrc16Finalize(s2);
  assert.equal(calcOverall, overallChecksum, 'overallChecksum coincide');
});

test('parseVfxChunkHeader y parseVfxChunk validan un chunk real con parámetros', () => {
  if (!existsSync(SAMPLE_CHUNK)) return;

  const bytes = new Uint8Array(readFileSync(SAMPLE_CHUNK));
  const header = parseVfxChunkHeader(bytes);

  assert.ok(header);
  assert.equal(header.isValidMagic, true);
  assert.equal(header.isValidHeaderChecksum, true);
  assert.equal(header.isValidOverallChecksum, true);
  assert.equal(header.pluginId, 1280263753);
  assert.equal(header.parameterDumpSize, 68); // 17 floats * 4 bytes
  assert.equal(header.vstChunkSize, 0);

  const parsed = parseVfxChunk(bytes);
  assert.ok(parsed);
  assert.equal(parsed.parameterDump.length, 17);
});

test('buildVfxChunk genera un buffer con cabecera de 100 bytes y CRC-16 válido', () => {
  const dummyParams = [0.1, 0.5, 0.9];
  const chunk = buildVfxChunk({
    pluginId: 1316377392,
    pluginVersion: 1000,
    numPrograms: 400,
    parameters: dummyParams,
  });

  assert.equal(chunk.length, 100 + dummyParams.length * 4);
  const parsed = parseVfxChunk(chunk);
  assert.ok(parsed);
  assert.equal(parsed.isValidMagic, true);
  assert.equal(parsed.isValidHeaderChecksum, true);
  assert.equal(parsed.isValidOverallChecksum, true);
  assert.equal(parsed.pluginId, 1316377392);
  assert.equal(parsed.parameterDump.length, 3);
  assert.ok(Math.abs(parsed.parameterDump[0]! - 0.1) < 1e-6);
  assert.ok(Math.abs(parsed.parameterDump[1]! - 0.5) < 1e-6);
  assert.ok(Math.abs(parsed.parameterDump[2]! - 0.9) < 1e-6);
});

test('patchVfxChunkPluginId modifica el ID y recalcula los checksums sin alterar datos', () => {
  const original = buildVfxChunk({
    pluginId: 1000,
    parameters: [0.25],
  });

  const patched = patchVfxChunkPluginId(original, 9999);
  const parsed = parseVfxChunk(patched);

  assert.ok(parsed);
  assert.equal(parsed.pluginId, 9999);
  assert.equal(parsed.isValidHeaderChecksum, true);
  assert.equal(parsed.isValidOverallChecksum, true);
  assert.ok(Math.abs(parsed.parameterDump[0]! - 0.25) < 1e-6);
});
