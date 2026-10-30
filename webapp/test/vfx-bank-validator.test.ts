import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { banksSkipReason } from './helpers/environment';
import {
  diagnoseVfxBank,
  repairVfxBank,
  readVfxChunkHeader,
  patchVfxChunkHeader,
  generatePresetVfxContent,
  parsePresetVfxContent,
  VFX_CHUNK_MAGIC_BUFFER,
} from '../src/library/vfx-bank-validator';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const BANKS_ROOT = path.join(PROJECT_ROOT, '_banks');
const NOVATION_BANK = path.join(
  BANKS_ROOT,
  'Novation V-Station demo.vfxlibrary',
  'Novation V-Station demo.vfxlibrary',
  'banks',
  '000_Novation V-Station demo.vfxbank',
);
const MDA_BANK = path.join(BANKS_ROOT, 'MDAPiano.vfxlibrary', 'banks', '000_MDA Piano.vfxbank');
// Los dos bancos reales vienen de `_banks/`, que no se versiona: sin ellos se
// omiten estas pruebas con el motivo; el resto usa fixtures temporales.
const banksSkip = banksSkipReason([
  'Novation V-Station demo.vfxlibrary',
  'MDAPiano.vfxlibrary',
]);

describe('vfx-bank-validator (utilidad transversal)', () => {
  it('diagnostica un banco real concordante (Novation V-Station)', { skip: banksSkip }, async () => {
    const diag = await diagnoseVfxBank(NOVATION_BANK, {
      expectedPluginId: 1316377392,
      wizardLookup: (id) =>
        id === '1316377392'
          ? { id: '1316377392', name: 'V-Station Demo', vendor: 'Novation', isSynth: true }
          : null,
    });

    assert.equal(diag.bankName, '000_Novation V-Station demo.vfxbank');
    assert.equal(diag.presetCount, 6);
    assert.equal(diag.validPresetCount, 6);
    assert.equal(diag.primaryPluginId, 1316377392);
    assert.equal(diag.primaryPluginFourCc, 'NvS0');
    assert.equal(diag.isConcordant, true);
    assert.equal(diag.deficiencies.length, 0);
    assert.ok(diag.matchedWizard);
    assert.equal(diag.matchedWizard.name, 'V-Station Demo');
  });

  it('diagnostica MDAPiano.vfxbank correctamente', { skip: banksSkip }, async () => {
    const diag = await diagnoseVfxBank(MDA_BANK);

    assert.equal(diag.presetCount, 1);
    assert.equal(diag.validPresetCount, 1);
    assert.equal(diag.primaryPluginId, 1296318832);
    assert.equal(diag.primaryPluginFourCc, 'MDAp');
    assert.equal(diag.isConcordant, true);
  });

  it('detecta carencias en un banco manipulado o incompleto', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-bank-corrupt-'));
    try {
      const bankDir = path.join(tempDir, 'CorruptBank.vfxbank');
      const p1 = path.join(bankDir, '000_Lead.vfxpreset');
      const p2 = path.join(bankDir, '001_Bass.vfxpreset');
      await fs.mkdir(p1, { recursive: true });
      await fs.mkdir(p2, { recursive: true });

      // Preset 1: tiene chunk pero le falta preset.vfx
      const chunkBuf = Buffer.alloc(148);
      VFX_CHUNK_MAGIC_BUFFER.copy(chunkBuf, 0);
      chunkBuf.writeUInt32LE(11112222, 40);
      await fs.writeFile(path.join(p1, 'channel_1_slot_a_11112222.chunk'), chunkBuf);

      // Preset 2: tiene preset.vfx pero le falta chunk
      await fs.writeFile(
        path.join(p2, 'preset.vfx'),
        generatePresetVfxContent({ presetName: 'Bass', pluginId: 11112222, pluginName: 'TestSynth' }),
      );

      const diag = await diagnoseVfxBank(bankDir);

      assert.equal(diag.presetCount, 2);
      assert.equal(diag.validPresetCount, 0);
      assert.equal(diag.isConcordant, false);
      assert.ok(diag.deficiencies.some((d) => d.code === 'MISSING_DESCRIPTOR'));
      assert.ok(diag.deficiencies.some((d) => d.code === 'MISSING_CHUNK'));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('repara y alinea un banco con IDs desalineados o descriptores faltantes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-bank-repair-'));
    try {
      const bankDir = path.join(tempDir, 'MyPresetBank.vfxbank');
      const p1 = path.join(bankDir, '000_Pad Warm.vfxpreset');
      await fs.mkdir(p1, { recursive: true });

      // Chunk con ID viejo (ej. 99999999)
      const oldId = 99999999;
      const targetId = 1316377392; // V-Station
      const chunkBuf = Buffer.alloc(148);
      VFX_CHUNK_MAGIC_BUFFER.copy(chunkBuf, 0);
      chunkBuf.writeUInt32LE(oldId, 40);
      await fs.writeFile(path.join(p1, `channel_1_slot_a_${oldId}.chunk`), chunkBuf);

      // 1. Diagnóstico previo detecta discrepancia de ID si esperamos V-Station
      const diagBefore = await diagnoseVfxBank(bankDir, { expectedPluginId: targetId });
      assert.equal(diagBefore.isConcordant, false);
      assert.equal(diagBefore.canRepair, true);

      // 2. Ejecutar reparación
      const repairRes = await repairVfxBank(bankDir, {
        targetPluginId: targetId,
        targetPluginName: 'V-Station Demo',
        targetShortName: 'NvS0',
      });

      assert.equal(repairRes.repairedPresets, 1);
      assert.equal(repairRes.renamedChunks, 1);
      assert.equal(repairRes.patchedChunkHeaders, 1);
      assert.equal(repairRes.createdDescriptors, 1);

      // 3. Comprobar que el archivo se renombró en disco
      const newChunkPath = path.join(p1, `channel_1_slot_a_${targetId}.chunk`);
      assert.ok(await fs.stat(newChunkPath));

      // Comprobar cabecera binaria parcheada
      const header = await readVfxChunkHeader(newChunkPath);
      assert.equal(header.pluginId, targetId);
      assert.equal(header.fourCc, 'NvS0');

      // Comprobar descriptor generado
      const descText = await fs.readFile(path.join(p1, 'preset.vfx'), 'utf8');
      const parsedDesc = parsePresetVfxContent(descText);
      assert.equal(parsedDesc.pluginId, targetId);
      assert.equal(parsedDesc.pluginName, 'V-Station Demo');

      // 4. Diagnóstico posterior confirma concordancia perfecta
      const diagAfter = await diagnoseVfxBank(bankDir, { expectedPluginId: targetId });
      assert.equal(diagAfter.isConcordant, true);
      assert.equal(diagAfter.deficiencies.length, 0);
      assert.equal(diagAfter.primaryPluginId, targetId);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
