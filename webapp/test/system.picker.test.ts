import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { readPickInput, SystemController } from '../src/system/picker.controller';
import {
  SYSTEM_PICK_FILE_EXAMPLE,
  SYSTEM_PICK_FILES_EXAMPLE,
} from '../src/system/picker.dto';
import { parsePickerOutput, PickerService } from '../src/system/picker.service';
import { PickerBusyError, PickerUnsupportedError } from '../src/system/picker.types';
import type { PickInput } from '../src/system/picker.types';

/**
 * El diálogo nativo no se puede abrir en un test (bloquearía la máquina), así
 * que se prueban sus tres piezas: la validación del cuerpo, el servicio con un
 * runner de mentira (incluida la exclusión mutua y la carpeta inicial) y el
 * mapeo de errores del controlador.
 */

function input(overrides: Partial<PickInput> = {}): PickInput {
  return {
    kind: 'folder',
    title: 'Elige una carpeta',
    extensions: [],
    initialDir: null,
    ...overrides,
  };
}

test('readPickInput aplica títulos por defecto y normaliza extensiones', () => {
  assert.deepEqual(readPickInput({ kind: 'folder' }), input());
  assert.deepEqual(
    readPickInput({ kind: 'file', title: '  Mis DLL  ', extensions: ['DLL', 'dll', 'fxb'] }),
    input({ kind: 'file', title: 'Mis DLL', extensions: ['dll', 'fxb'] }),
  );
  // Elegir una carpeta no usa filtros: no tiene sentido rechazarlos.
  assert.deepEqual(readPickInput({ kind: 'folder', extensions: ['fxb'] }), input());
  // El título vacío vuelve al de por defecto...
  assert.equal(readPickInput({ kind: 'files', title: '   ' }).title, 'Elige los archivos');
  // ...y la ruta se recorta, sin exigir que exista (lo decide el servicio).
  assert.equal(
    readPickInput({ kind: 'file', initialDir: '  C:\\Bancos  ' }).initialDir,
    'C:\\Bancos',
  );
  assert.equal(
    readPickInput({ kind: 'file', initialDir: '\\\\servidor\\share' }).initialDir,
    '\\\\servidor\\share',
  );
});

test('readPickInput rechaza cuerpos que el diálogo no puede abrir', () => {
  const invalid: unknown[] = [
    null,
    [],
    { kind: 'carpeta' },
    { kind: 'file', title: 42 },
    { kind: 'file', title: 'x'.repeat(81) },
    { kind: 'file', extensions: 'fxb' },
    { kind: 'file', extensions: ['.fxb'] },
    { kind: 'file', extensions: ['a', 'b', 'c', 'd', 'e', 'f'] },
    { kind: 'file', extensions: ['extensi-n'] },
    { kind: 'file', initialDir: 42 },
    { kind: 'file', initialDir: 'Bancos' },
  ];

  for (const body of invalid) {
    assert.throws(
      () => readPickInput(body),
      BadRequestException,
      `debería rechazar ${JSON.stringify(body)}`,
    );
  }
});

test('parsePickerOutput decodifica base64, ignora líneas vacías y conserva acentos', () => {
  const encoded = (value: string): string =>
    Buffer.from(value, 'utf8').toString('base64');

  assert.deepEqual(
    parsePickerOutput(
      [
        encoded('C:\\Bancos\\Ñandú.fxb'),
        '',
        encoded('C:\\VFX Library\\plugs\\My Synth'),
        '   ',
        encoded('C:\\otro.fxb'),
        '',
      ].join('\r\n'),
    ),
    ['C:\\Bancos\\Ñandú.fxb', 'C:\\VFX Library\\plugs\\My Synth', 'C:\\otro.fxb'],
  );
  assert.deepEqual(parsePickerOutput(''), []);
});

test('PickerService pasa solo una carpeta inicial que exista', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fxb-pick-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const received: PickInput[] = [];
  const service = new PickerService('win32', async (value) => {
    received.push(value);
    return ['C:\\Bancos\\elegido.fxb'];
  });

  assert.deepEqual(
    await service.pick(input({ kind: 'files', initialDir: dir })),
    ['C:\\Bancos\\elegido.fxb'],
  );
  assert.deepEqual(received[0], input({ kind: 'files', initialDir: dir }));

  const missing = path.join(dir, 'no-existe');
  await service.pick(input({ kind: 'file', initialDir: missing }));
  assert.equal(received[1]?.initialDir, null, 'una carpeta que no existe se descarta');

  await service.pick(input({ kind: 'folder', initialDir: null }));
  assert.equal(received[2]?.initialDir, null);
});

test('PickerService responde 501 fuera de Windows sin abrir nada', async () => {
  let calls = 0;
  const service = new PickerService('linux', async () => {
    calls += 1;
    return [];
  });

  await assert.rejects(service.pick(input()), PickerUnsupportedError);
  assert.equal(calls, 0);
});

test('PickerService admite un solo diálogo a la vez y se libera al terminar', async () => {
  let release!: (paths: string[]) => void;
  const gate = new Promise<string[]>((resolve) => {
    release = resolve;
  });

  const service = new PickerService('win32', () => gate);
  const first = service.pick(input());

  await assert.rejects(service.pick(input()), PickerBusyError);
  release(['C:\\elegido']);
  assert.deepEqual(await first, ['C:\\elegido']);

  // Tras cerrar el diálogo se puede abrir otro.
  const after = new PickerService('win32', async () => ['C:\\otro']);
  assert.deepEqual(await after.pick(input()), ['C:\\otro']);
});

test('PickerService libera el turno aunque el diálogo falle', async () => {
  let attempts = 0;
  const service = new PickerService('win32', async () => {
    attempts += 1;
    throw new Error('el diálogo terminó con 1');
  });

  await assert.rejects(service.pick(input()), /terminó con 1/);
  await assert.rejects(service.pick(input()), /terminó con 1/);
  assert.equal(attempts, 2, 'el segundo intento no debe dar 409');
});

test('SystemController traduce el diálogo ocupado y el sistema sin soporte', async () => {
  const busy = new SystemController({
    pick: async () => {
      throw new PickerBusyError();
    },
  } as unknown as PickerService);

  await assert.rejects(busy.pick({ kind: 'folder' }), ConflictException);

  const linux = new SystemController(new PickerService('darwin', async () => []));
  await assert.rejects(linux.pick({ kind: 'folder' }), (error: unknown) => {
    assert.ok(error instanceof HttpException);
    assert.equal(error.getStatus(), 501);
    return true;
  });
});

test('SystemController valida antes de abrir y devuelve las rutas del diálogo', async () => {
  const received: PickInput[] = [];
  const controller = new SystemController({
    pick: async (value: PickInput) => {
      received.push(value);
      return ['C:\\Bancos\\Rhodes.fxb', 'C:\\Bancos\\Strings.fxb'];
    },
  } as unknown as PickerService);

  await assert.rejects(controller.pick({ kind: 'folder', initialDir: 'relativa' }), BadRequestException);
  assert.deepEqual(received, [], 'una petición inválida no llega al diálogo');

  assert.deepEqual(
    await controller.pick({
      kind: 'files',
      title: 'Bancos',
      extensions: ['fxb'],
      initialDir: 'C:\\Bancos',
    }),
    { paths: SYSTEM_PICK_FILES_EXAMPLE.paths },
  );
  assert.deepEqual(received[0], {
    kind: 'files',
    title: 'Bancos',
    extensions: ['fxb'],
    initialDir: 'C:\\Bancos',
  });
  assert.equal(SYSTEM_PICK_FILES_EXAMPLE.paths.length, 2);
});

test('el ejemplo de un archivo es una sola ruta', () => {
  assert.deepEqual(SYSTEM_PICK_FILE_EXAMPLE, { paths: ['C:\\fxbLoader\\vst\\fxbLoader.dll'] });
});
