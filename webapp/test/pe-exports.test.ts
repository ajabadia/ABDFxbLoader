import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { inspectPeExports } from '../src/library/pe-exports';
import { pe32Dll, pe64Dll, peWithExportsDll } from './helpers/pe';

describe('inspectPeExports', () => {
  it('detecta correctamente un plugin VST2 de 32 bits que exporta VSTPluginMain', async () => {
    const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'vst-pe-test-'));
    const dllPath = path.join(tempDir, 'synth.dll');
    try {
      const buffer = peWithExportsDll(['VSTPluginMain'], {
        bitness: 32,
        internalName: 'MySynth.dll',
      });
      await fs.writeFile(dllPath, buffer);

      const inspection = await inspectPeExports(dllPath);

      assert.equal(inspection.validPe, true);
      assert.equal(inspection.bitness, 32);
      assert.equal(inspection.is32BitCompatible, true);
      assert.equal(inspection.isVstPlugin, true);
      assert.equal(inspection.vstEntrypoint, 'VSTPluginMain');
      assert.equal(inspection.internalDllName, 'MySynth.dll');
      assert.deepEqual(inspection.exportedNames, ['VSTPluginMain']);
      assert.equal(inspection.issues.length, 0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('detecta correctamente un plugin VST2 tradicional de 32 bits que exporta main', async () => {
    const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'vst-pe-test-'));
    const dllPath = path.join(tempDir, 'classic.dll');
    try {
      const buffer = peWithExportsDll(['main', 'anotherExport'], {
        bitness: 32,
        internalName: 'ClassicSynth.dll',
      });
      await fs.writeFile(dllPath, buffer);

      const inspection = await inspectPeExports(dllPath);

      assert.equal(inspection.validPe, true);
      assert.equal(inspection.is32BitCompatible, true);
      assert.equal(inspection.isVstPlugin, true);
      assert.equal(inspection.vstEntrypoint, 'main');
      assert.ok(inspection.exportedNames.includes('main'));
      assert.ok(inspection.exportedNames.includes('anotherExport'));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('detecta que una DLL genérica no es un plugin VST', async () => {
    const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'vst-pe-test-'));
    const dllPath = path.join(tempDir, 'generic.dll');
    try {
      const buffer = peWithExportsDll(['CalculateSum', 'DoWork'], {
        bitness: 32,
        internalName: 'helper.dll',
      });
      await fs.writeFile(dllPath, buffer);

      const inspection = await inspectPeExports(dllPath);

      assert.equal(inspection.validPe, true);
      assert.equal(inspection.is32BitCompatible, true);
      assert.equal(inspection.isVstPlugin, false);
      assert.equal(inspection.vstEntrypoint, null);
      assert.ok(inspection.issues.some((issue) => issue.includes('no es un VST2')));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('advierte cuando el plugin VST es de 64 bits (incompatible con hardware VFX)', async () => {
    const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'vst-pe-test-'));
    const dllPath = path.join(tempDir, 'vst64.dll');
    try {
      const buffer = peWithExportsDll(['VSTPluginMain'], {
        bitness: 64,
        internalName: 'Synth64.dll',
      });
      await fs.writeFile(dllPath, buffer);

      const inspection = await inspectPeExports(dllPath);

      assert.equal(inspection.validPe, true);
      assert.equal(inspection.bitness, 64);
      assert.equal(inspection.is32BitCompatible, false);
      assert.equal(inspection.isVstPlugin, true);
      assert.ok(inspection.issues.some((issue) => issue.includes('64 bits')));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('informa correctamente de DLLs sin tabla de exportación o no ejecutables', async () => {
    const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'vst-pe-test-'));
    const noExportsDll = path.join(tempDir, 'stub.dll');
    const corruptDll = path.join(tempDir, 'corrupt.dll');
    try {
      await fs.writeFile(noExportsDll, pe32Dll());
      await fs.writeFile(corruptDll, Buffer.from('NOT A VALID PE'));

      const inspStub = await inspectPeExports(noExportsDll);
      assert.equal(inspStub.validPe, true);
      assert.equal(inspStub.isVstPlugin, false);
      assert.ok(inspStub.issues.some((issue) => issue.includes('no tiene tabla de exportación')));

      const inspCorrupt = await inspectPeExports(corruptDll);
      assert.equal(inspCorrupt.validPe, false);
      assert.equal(inspCorrupt.isVstPlugin, false);
      assert.ok(inspCorrupt.issues.length > 0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
