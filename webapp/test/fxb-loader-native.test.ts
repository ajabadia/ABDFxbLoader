import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  CONFIG_EOL,
  CONFIG_KEYS,
  LOADER_DLL_FILENAME,
  MAX_PE_FILE_SIZE,
  listBankFiles,
  readFxbLoaderConfig,
  resolveDefaultLoaderDllPath,
  sha256File,
  validateLoaderDllAsPe32I386,
  writeFxbLoaderConfig,
} from '../src/library/fxbLoader-native';

/**
 * `fxbLoader-native.ts` es la puerta en TypeScript puro que sustituye a
 * `vst/fxbLoader.dll`: valida el binario como PE32 i386 y lee/escribe
 * `fxbLoader.config` igual que el DLL. Estas pruebas la ejercen con las dos
 * cosas que no se pueden falsear: la DLL real del repo y cabeceras PE
 * sintéticas con cada firma y arquitectura.
 */

const REPO_DLL = path.resolve(__dirname, '..', '..', '..', 'vst', 'fxbLoader.dll');

async function tempDir(t: TestContext, prefix = 'fxb-native-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * Cabecera PE mínima de 0x60 bytes: firma MZ al inicio, `e_lfanew` en 0x3C y
 * la cabecera COFF en ese desplazamiento con la máquina pedida.
 */
function peBuffer(
  machine: number,
  options: { dosSignature?: number; peSignature?: number; peOffset?: number } = {},
): Buffer {
  const peOffset = options.peOffset ?? 0x40;
  const buffer = Buffer.alloc(0x60);
  buffer.writeUInt32LE(options.dosSignature ?? 0x5a4d, 0);
  buffer.writeUInt32LE(peOffset, 0x3c);
  if (peOffset + 8 <= buffer.length) {
    buffer.writeUInt32LE(options.peSignature ?? 0x00004550, peOffset);
    buffer.writeUInt16LE(machine, peOffset + 4);
  }
  return buffer;
}

test('las constantes mantienen el contrato del DLL', () => {
  assert.equal(LOADER_DLL_FILENAME, 'fxbLoader.dll');
  assert.equal(CONFIG_EOL, '\r\n');
  assert.equal(MAX_PE_FILE_SIZE, 64 * 1024 * 1024);
  assert.deepEqual(CONFIG_KEYS, ['pluginName', 'defaultFxbName', 'programDirName', 'loadFxbBank']);
});

test('acepta la DLL real del repo como PE32 i386', async () => {
  const result = await validateLoaderDllAsPe32I386(REPO_DLL);

  assert.equal(result.valid, true);
  assert.equal(result.bitness, 32);
  assert.equal(result.machine, 'i386 (32 bits)');
  assert.deepEqual(result.issues, []);
});

test('un archivo que no se puede leer no se da por válido', async (t) => {
  const dir = await tempDir(t);

  const result = await validateLoaderDllAsPe32I386(path.join(dir, 'no-existe.dll'));

  assert.equal(result.valid, false);
  assert.equal(result.bitness, null);
  assert.equal(result.machine, null);
  assert.match(result.issues[0]!, /no se pudo leer el archivo/);
});

test('no valida un directorio como si fuera un PE', async (t) => {
  const dir = await tempDir(t);
  const folder = path.join(dir, 'fxbLoader.dll');
  await mkdir(folder);

  const result = await validateLoaderDllAsPe32I386(folder);

  assert.equal(result.valid, false);
  assert.match(result.issues[0]!, /no es un fichero/);
});

test('rechaza un archivo demasiado corto para tener cabecera', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'corto.dll');
  await writeFile(file, peBuffer(0x014c).subarray(0, 10));

  const result = await validateLoaderDllAsPe32I386(file);

  assert.equal(result.valid, false);
  assert.equal(result.bitness, null);
  assert.deepEqual(result.issues, ['el archivo es demasiado corto para contener una cabecera PE']);
});

test('rechaza un desplazamiento PE fuera del archivo o dentro de la cabecera DOS', async (t) => {
  const dir = await tempDir(t);
  const far = path.join(dir, 'lejos.dll');
  const low = path.join(dir, 'bajo.dll');
  await writeFile(far, peBuffer(0x014c, { peOffset: 0x1000 }));
  await writeFile(low, peBuffer(0x014c, { peOffset: 0x20 }));

  for (const file of [far, low]) {
    const result = await validateLoaderDllAsPe32I386(file);
    assert.equal(result.valid, false);
    assert.equal(result.bitness, null);
    assert.match(result.issues[0]!, /desplazamiento PE \w+ fuera de rango/);
  }
});

test('un AMD64 se reconoce como 64 bits pero no es PE32 i386', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'x64.dll');
  await writeFile(file, peBuffer(0x8664));

  const result = await validateLoaderDllAsPe32I386(file);

  assert.equal(result.valid, false);
  assert.equal(result.bitness, 64);
  assert.equal(result.machine, 'AMD64 (64 bits)');
  // La cabecera está bien formada: lo único que la descarta es no ser i386, y
  // eso no se cuenta como problema del archivo.
  assert.deepEqual(result.issues, []);
});

test('una arquitectura sin equivalencia se queda sin bitness y con su código', async (t) => {
  const dir = await tempDir(t);
  const arm = path.join(dir, 'arm.dll');
  const raro = path.join(dir, 'raro.dll');
  await writeFile(arm, peBuffer(0x01c4));
  await writeFile(raro, peBuffer(0x1234));

  const armResult = await validateLoaderDllAsPe32I386(arm);
  assert.equal(armResult.valid, false);
  assert.equal(armResult.bitness, null);
  assert.equal(armResult.machine, 'ARM (32 bits)');

  const raroResult = await validateLoaderDllAsPe32I386(raro);
  assert.equal(raroResult.valid, false);
  assert.equal(raroResult.bitness, null);
  assert.equal(raroResult.machine, '0x1234');
});

test('avisa de una firma MZ ausente y de una cabecera PE que no lo es', async (t) => {
  const dir = await tempDir(t);
  const sinMz = path.join(dir, 'sin-mz.dll');
  const sinPe = path.join(dir, 'sin-pe.dll');
  await writeFile(sinMz, peBuffer(0x014c, { dosSignature: 0x464c457f }));
  await writeFile(sinPe, peBuffer(0x014c, { peSignature: 0x00004551 }));

  const mz = await validateLoaderDllAsPe32I386(sinMz);
  assert.ok(mz.issues.some((issue) => issue.includes('sin firma MZ')), 'nombra la firma MZ');

  const pe = await validateLoaderDllAsPe32I386(sinPe);
  assert.ok(
    pe.issues.some((issue) => issue.includes('la cabecera PE declara 0x4551')),
    'dice qué declaró en vez de «PE\\0\\0»',
  );
});

test('escribe las cuatro claves con CRLF y sin salto final', async (t) => {
  const dir = await tempDir(t);

  writeFxbLoaderConfig(dir, {
    pluginName: 'SuperWave P8',
    defaultFxbName: 'Rhodes.fxb',
    programDirName: 'presets',
    loadFxbBank: true,
  });

  const raw = await readFile(path.join(dir, 'fxbLoader.config'), 'utf8');
  assert.deepEqual(raw.split('\r\n'), [
    'pluginName = SuperWave P8',
    'defaultFxbName = Rhodes.fxb',
    'programDirName = presets',
    'loadFxbBank = yes',
  ]);
  assert.ok(!raw.endsWith('\n'), 'el serializador del DLL no añade salto final');
});

test('al escribir sin valores usa los del DLL y desactiva la carga', async (t) => {
  const dir = await tempDir(t);

  writeFxbLoaderConfig(dir, { loadFxbBank: false });

  const raw = await readFile(path.join(dir, 'fxbLoader.config'), 'utf8');
  assert.deepEqual(raw.split('\r\n'), [
    'pluginName = ',
    'defaultFxbName = ',
    'programDirName = presets',
    'loadFxbBank = no',
  ]);
});

test('lee el config con comentarios, espacios y claves que no valen', async (t) => {
  const dir = await tempDir(t);
  await writeFile(
    path.join(dir, 'fxbLoader.config'),
    [
      '/ comentario del DLL',
      'pluginName = SuperWave P8',
      'defaultFxbName=Rhodes.fxb',
      '   programDirName = bancos   ',
      'clave/conbarra = se ignora',
      '= sin clave',
      'linea sin igual',
      'loadFxbBank = yes',
      '',
    ].join('\r\n'),
    'utf8',
  );

  const config = await readFxbLoaderConfig(dir);

  assert.deepEqual(config, {
    pluginName: 'SuperWave P8',
    defaultFxbName: 'Rhodes.fxb',
    programDirName: 'bancos',
    loadFxbBank: true,
  });
});

test('una clave repetida se queda con la última, como el Map del DLL', async (t) => {
  const dir = await tempDir(t);
  await writeFile(
    path.join(dir, 'fxbLoader.config'),
    'pluginName = primero\r\npluginName = segundo\r\n',
    'utf8',
  );

  assert.equal((await readFxbLoaderConfig(dir)).pluginName, 'segundo');
});

test('sin archivo devuelve el fallback y completa lo que falte', async (t) => {
  const dir = await tempDir(t);

  const conFallback = await readFxbLoaderConfig(dir, {
    pluginName: 'Synth.dll',
    loadFxbBank: false,
  });
  assert.deepEqual(conFallback, {
    pluginName: 'Synth.dll',
    defaultFxbName: '',
    programDirName: 'presets',
    loadFxbBank: false,
  });

  const sinFallback = await readFxbLoaderConfig(dir);
  assert.deepEqual(sinFallback, {
    pluginName: '',
    defaultFxbName: '',
    programDirName: 'presets',
    loadFxbBank: true,
  });
});

test('las claves ausentes del archivo salen del fallback', async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, 'fxbLoader.config'), 'pluginName = Synth\r\n', 'utf8');

  const config = await readFxbLoaderConfig(dir, { defaultFxbName: 'Rhodes.fxb' });

  assert.equal(config.pluginName, 'Synth');
  assert.equal(config.defaultFxbName, 'Rhodes.fxb');
});

test('loadFxbBank acepta las formas del DLL y descarta lo que no reconoce', async (t) => {
  const dir = await tempDir(t);
  const cases: Array<[string, boolean]> = [
    ['yes', true],
    ['1', true],
    ['true', true],
    ['no', false],
    ['0', false],
    ['false', false],
    ['YES', false],
    ['quizá', false],
  ];

  for (const [value, expected] of cases) {
    await writeFile(path.join(dir, 'fxbLoader.config'), `loadFxbBank = ${value}\r\n`, 'utf8');
    assert.equal(
      (await readFxbLoaderConfig(dir)).loadFxbBank,
      expected,
      `loadFxbBank = ${value}`,
    );
  }

  await writeFile(path.join(dir, 'fxbLoader.config'), 'pluginName = Synth\r\n', 'utf8');
  assert.equal(
    (await readFxbLoaderConfig(dir)).loadFxbBank,
    false,
    'sin la clave no se arranca la carga',
  );
});

test('un error que no es ENOENT se propaga en vez de devolver el fallback', async (t) => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, 'fxbLoader.config'));

  await assert.rejects(readFxbLoaderConfig(dir), (error: NodeJS.ErrnoException) => {
    assert.notEqual(error.code, 'ENOENT');
    return true;
  });
});

test('resolveDefaultLoaderDllPath busca vst/fxbLoader.dll desde el CWD', async (t) => {
  const dir = await tempDir(t, 'fxb-native-cwd-');
  const previous = process.cwd();

  // El CWD se restaura dentro del propio test: si se dejara al hook de limpieza,
  // el borrado del temporal en Windows fallaría con EBUSY.
  try {
    process.chdir(dir);
    assert.equal(resolveDefaultLoaderDllPath(), null, 'sin la DLL no devuelve una ruta inventada');

    await mkdir(path.join(dir, 'vst'));
    await writeFile(path.join(dir, 'vst', 'fxbLoader.dll'), 'no hace falta que sea un PE');
    assert.equal(resolveDefaultLoaderDllPath(), path.join(dir, 'vst', 'fxbLoader.dll'));
  } finally {
    process.chdir(previous);
  }
});

test('sha256File hashea el contenido, no la ruta', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'Rhodes.fxb');
  await writeFile(file, 'abc');

  assert.equal(
    sha256File(file),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('listBankFiles lista solo los .fxb, en orden y sin distinguir mayúsculas', async (t) => {
  const plugin = await tempDir(t, 'fxb-native-plug-');
  const presets = path.join(plugin, 'presets');
  await mkdir(path.join(presets, 'carpeta.fxb'), { recursive: true });
  await writeFile(path.join(presets, 'Rhodes.fxb'), 'banco');
  await writeFile(path.join(presets, 'bass.FXB'), 'banco');
  await writeFile(path.join(presets, 'a.fxb'), 'banco');
  await writeFile(path.join(presets, 'notas.txt'), 'no es un banco');
  await writeFile(path.join(presets, 'sin-extension'), 'no es un banco');

  assert.deepEqual(await listBankFiles(plugin), ['a.fxb', 'bass.FXB', 'Rhodes.fxb']);
});

test('listBankFiles devuelve vacío si el plugin no tiene presets', async (t) => {
  const plugin = await tempDir(t, 'fxb-native-vacio-');

  assert.deepEqual(await listBankFiles(plugin), []);
});

test('listBankFiles no se come los errores que no son ENOENT', async (t) => {
  const plugin = await tempDir(t, 'fxb-native-roto-');
  await writeFile(path.join(plugin, 'presets'), 'presets es un archivo, no una carpeta');

  await assert.rejects(listBankFiles(plugin));
});
