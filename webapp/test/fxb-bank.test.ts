import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkBankCompatibility,
  convertFxbEndianness,
  parseFxbBank,
  parseUniqueIdInput,
  uniqueIdToText,
} from '../src/library/fxb-bank';
import { buildBank } from './helpers/fxb-bank';

test('parsea un FxBk little-endian con programas', () => {
  const parsed = parseFxbBank(buildBank({ programs: 3, uniqueId: 'MySy', fxVersion: 1234 }));

  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.bank?.kind, 'FxBk');
  assert.equal(parsed.bank?.endianness, 'little');
  assert.equal(parsed.bank?.uniqueId, 'MySy');
  assert.equal(parsed.bank?.uniqueIdValue, 0x4d795379);
  assert.equal(parsed.bank?.fxVersion, 1234);
  assert.equal(parsed.bank?.numPrograms, 3);
  assert.equal(parsed.bank?.chunkSize, null);
});

test('parsea un banco big-endian y un FBCh', () => {
  const big = parseFxbBank(buildBank({ endianness: 'big' }));
  assert.equal(big.bank?.endianness, 'big');
  assert.deepEqual(big.issues, []);

  const chunked = parseFxbBank(buildBank({ kind: 'FBCh', chunkSize: 24 }));
  assert.equal(chunked.bank?.kind, 'FBCh');
  assert.equal(chunked.bank?.chunkSize, 24);
  assert.equal(chunked.bank?.numPrograms, 0);
  assert.deepEqual(chunked.issues, []);
});

test('acepta la versión 2 del banco y expone currentProgram', () => {
  const parsed = parseFxbBank(buildBank({ version: 2, currentProgram: 3 }));

  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.bank?.version, 2);
  assert.equal(parsed.bank?.currentProgram, 3);

  const unknown = buildBank();
  unknown.writeUInt32LE(3, 12);
  assert.match(parseFxbBank(unknown).issues.join(' '), /versión de banco 3/);
});

test('detecta magic, byteSize y truncamientos', () => {
  assert.match(parseFxbBank(Buffer.alloc(200, 0x41)).issues[0] ?? '', /chunkMagic/);

  const wrongSize = buildBank();
  wrongSize.writeUInt32LE(999, 4);
  assert.match(parseFxbBank(wrongSize).issues.join(' '), /byteSize/);

  const short = buildBank();
  assert.match(
    parseFxbBank(short.subarray(0, short.length - 10)).issues.join(' '),
    /byteSize|termina antes|byteSize/,
  );

  const empty = parseFxbBank(Buffer.alloc(0));
  assert.equal(empty.bank, null);
  assert.match(empty.issues[0] ?? '', /156/);
});

test('valida la cabecera sin recorrer programas cuando solo se lee el encabezado', () => {
  const full = buildBank();
  const header = full.subarray(0, 156);

  const parsed = parseFxbBank(header, full.length);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.bank?.numPrograms, 2);

  const truncatedFile = parseFxbBank(header, full.length + 10);
  assert.match(truncatedFile.issues.join(' '), /byteSize/);
});

test('convierte un FxBk de orden y lo deja idéntico al volver', () => {
  const big = buildBank({ endianness: 'big', programs: 2 });
  const little = convertFxbEndianness(big, 'little');

  // 8 campos de cabecera + 7 de cada programa + 1 parámetro float de cada uno.
  assert.equal(little.fields, 8 + 2 * (7 + 1));
  assert.equal(little.programs, 2);
  assert.equal(little.chunks, 0);

  const parsed = parseFxbBank(little.data);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.bank?.endianness, 'little');
  assert.equal(parsed.bank?.numPrograms, 2);
  assert.equal(parsed.bank?.uniqueId, 'MySy');

  assert.deepEqual(convertFxbEndianness(little.data, 'big').data, big);
});

test('convierte un FBCh y solo reescribe el tamaño del chunk', () => {
  const big = buildBank({ kind: 'FBCh', chunkSize: 24, endianness: 'big' });
  const little = convertFxbEndianness(big, 'little');

  assert.equal(little.fields, 9); // 8 de cabecera + el chunkSize del banco
  assert.equal(little.chunks, 1);
  assert.equal(little.programs, 0);

  const parsed = parseFxbBank(little.data);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.bank?.kind, 'FBCh');
  assert.equal(parsed.bank?.chunkSize, 24);
  assert.deepEqual(convertFxbEndianness(little.data, 'big').data, big);
});

test('no invierte nada si el banco ya está en el orden pedido', () => {
  const little = buildBank({ endianness: 'little' });
  const result = convertFxbEndianness(little, 'little');

  assert.equal(result.fields, 0);
  assert.equal(result.programs, 2);
  assert.deepEqual(result.data, little);
  assert.notEqual(result.data, little, 'devuelve una copia, no el mismo buffer');
});

test('rechaza lo que no puede convertir sin corromperlo', () => {
  assert.throws(() => convertFxbEndianness(Buffer.alloc(200, 0x41), 'little'), /CcnK/);
  assert.throws(() => convertFxbEndianness(Buffer.alloc(10), 'little'), /al menos 156/);
  assert.throws(
    () => convertFxbEndianness(buildBank(), 'medium' as never),
    RangeError,
  );

  const truncated = buildBank({ endianness: 'big' });
  truncated.writeUInt32BE(9999, 160); // byteSize del primer programa
  assert.throws(() => convertFxbEndianness(truncated, 'little'), /se sale del archivo/);
});

test('convierte uniqueID entre texto y entero', () => {
  assert.equal(parseUniqueIdInput('MySy'), 0x4d795379);
  assert.equal(parseUniqueIdInput(0x4d795379), 0x4d795379);
  assert.equal(uniqueIdToText(0x4d795379), 'MySy');
  assert.equal(uniqueIdToText(0x01020304), '0x01020304');
  assert.throws(() => parseUniqueIdInput('abc'), RangeError);
  assert.throws(() => parseUniqueIdInput(-1), RangeError);
});

test('compatibilidad: compatible, incompatible y sin verificar', () => {
  const parsed = parseFxbBank(buildBank({ uniqueId: 'MySy', fxVersion: 1000 }));
  const bank = parsed.bank!;

  assert.equal(
    checkBankCompatibility(bank, {
      source: 'explicit',
      uniqueId: 'MySy',
      uniqueIdValue: 0x4d795379,
      fxVersion: 1000,
      file: null,
    }).compatibility,
    'compatible',
  );

  const foreign = checkBankCompatibility(bank, {
    source: 'explicit',
    uniqueId: 'Othr',
    uniqueIdValue: parseUniqueIdInput('Othr'),
    fxVersion: null,
    file: null,
  });
  assert.equal(foreign.compatibility, 'incompatible');
  assert.match(foreign.reason ?? '', /uniqueID MySy/);

  assert.equal(
    checkBankCompatibility(bank, {
      source: 'none',
      uniqueId: null,
      uniqueIdValue: null,
      fxVersion: null,
      file: null,
    }).compatibility,
    'unverified',
  );
});

test('solo la referencia explícita compara la versión del plugin', () => {
  const bank = parseFxbBank(buildBank({ uniqueId: 'MySy', fxVersion: 1000 })).bank!;

  // La DLL no mira fxVersion; una referencia inferida no debe rechazar por eso.
  assert.equal(
    checkBankCompatibility(bank, {
      source: 'existing-bank',
      uniqueId: 'MySy',
      uniqueIdValue: 0x4d795379,
      fxVersion: 2000,
      file: 'Old.fxb',
    }).compatibility,
    'compatible',
  );
  assert.equal(
    checkBankCompatibility(bank, {
      source: 'explicit',
      uniqueId: 'MySy',
      uniqueIdValue: 0x4d795379,
      fxVersion: 2000,
      file: null,
    }).compatibility,
    'incompatible',
  );
});
