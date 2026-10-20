import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  describePe,
  inspectPeBuffer,
  inspectPeFile,
  isX86Pe32,
  MACHINE_AMD64,
  MACHINE_ARM64,
  MACHINE_I386,
} from '../src/library/pe';
import { pe32Dll, pe64Dll, peStub } from './helpers/pe';

test('reconoce un PE32 i386 como cargador válido', () => {
  const info = inspectPeBuffer(pe32Dll());

  assert.equal(info.valid, true);
  assert.equal(info.bitness, 32);
  assert.equal(info.machine, MACHINE_I386);
  assert.equal(info.machineName, 'i386');
  assert.equal(info.optionalMagic, 0x10b);
  assert.deepEqual(info.issues, []);
  assert.equal(isX86Pe32(info), true);
  assert.equal(describePe(info), 'PE32 i386 (32 bits)');
});

test('reconoce un PE32+ AMD64 y no lo acepta como plugin de 32 bits', () => {
  const info = inspectPeBuffer(pe64Dll());

  assert.equal(info.valid, true);
  assert.equal(info.bitness, 64);
  assert.equal(info.machine, MACHINE_AMD64);
  assert.equal(info.machineName, 'AMD64');
  assert.equal(info.optionalMagic, 0x20b);
  assert.equal(isX86Pe32(info), false);
  assert.equal(describePe(info), 'PE32+ AMD64 (64 bits)');
});

test('un PE32 ARM también es incompatible con el cargador i386', () => {
  const info = inspectPeBuffer(peStub({ bitness: 32, machine: 0x01c4 }));

  assert.equal(info.valid, true);
  assert.equal(info.bitness, 32);
  assert.equal(info.machineName, 'ARMNT');
  assert.equal(isX86Pe32(info), false);
});

test('rechaza archivos sin firma MZ, truncados o con magic desconocido', () => {
  const noMz = pe32Dll();
  noMz.write('XX', 0, 'latin1');
  assert.match(inspectPeBuffer(noMz).issues[0]!, /firma MZ/);

  assert.match(inspectPeBuffer(Buffer.alloc(20)).issues[0]!, /truncado/);

  const unknown = pe32Dll();
  unknown.writeUInt16LE(0x999, 0x98);
  const info = inspectPeBuffer(unknown);
  assert.equal(info.valid, false);
  assert.match(info.issues[0]!, /optional header desconocido/);
  assert.equal(info.bitness, null);
});

test('rechaza una firma PE ausente y un desplazamiento fuera del archivo', () => {
  const badSignature = pe32Dll();
  badSignature.writeUInt32LE(0x12345678, 0x80);
  assert.match(inspectPeBuffer(badSignature).issues[0]!, /firma PE/);

  const badOffset = pe32Dll();
  badOffset.writeUInt32LE(0x1000, 0x3c);
  assert.match(inspectPeBuffer(badOffset).issues[0]!, /cabecera PE truncada/);
});

test('detecta cabeceras incoherentes entre bitness y Machine', () => {
  const inconsistent = inspectPeBuffer(
    peStub({ bitness: 32, machine: MACHINE_AMD64, optionalMagic: 0x10b }),
  );

  assert.equal(inconsistent.valid, false);
  assert.match(inconsistent.issues.join(' '), /PE32 con Machine AMD64/);
});

test('inspectPeFile lee solo la cabecera y reporta archivos ilegibles', async (t: TestContext) => {
  const root = await mkdtemp(path.join(tmpdir(), 'fxb-pe-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const file = path.join(root, 'loader.dll');
  await writeFile(file, pe64Dll());
  const info = await inspectPeFile(file);
  assert.equal(info.bitness, 64);
  assert.equal(info.machine, MACHINE_AMD64);

  const missing = await inspectPeFile(path.join(root, 'nope.dll'));
  assert.equal(missing.valid, false);
  assert.match(missing.issues[0]!, /no existe/);

  await writeFile(path.join(root, 'arm64.dll'), peStub({ bitness: 64, machine: MACHINE_ARM64 }));
  const arm64 = await inspectPeFile(path.join(root, 'arm64.dll'));
  assert.equal(arm64.valid, true);
  assert.equal(arm64.machineName, 'ARM64');
  assert.equal(isX86Pe32(arm64), false);
});
