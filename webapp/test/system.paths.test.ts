import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { readPaths, SystemPathsController } from '../src/system/paths.controller';
import { SYSTEM_PATHS_LIMIT, SYSTEM_PATHS_MIXED_EXAMPLE } from '../src/system/paths.dto';
import { PathsService } from '../src/system/paths.service';
import type { PathStat } from '../src/system/paths.service';

/**
 * La vista guarda rutas entre sesiones y necesita saber cuáles siguen en el
 * disco. El navegador no puede consultarlo, así que lo hace el servidor: estas
 * pruebas cubren la validación del cuerpo, el servicio con un `stat` de mentira
 * y el controlador con rutas reales de un directorio temporal.
 */

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fxb-paths-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('readPaths recorta los espacios, conserva el orden y admite una lista vacía', () => {
  assert.deepEqual(
    readPaths({ paths: ['  C:\\VFX\\Library ', 'C:\\Bancos\\Rhodes.fxb'] }),
    ['C:\\VFX\\Library', 'C:\\Bancos\\Rhodes.fxb'],
  );
  assert.deepEqual(readPaths({ paths: [] }), []);
  assert.deepEqual(readPaths({ paths: [path.resolve('.')] }), [path.resolve('.')]);
});

test('readPaths rechaza lo que no es una lista de rutas absolutas', () => {
  const invalid: unknown[] = [
    null,
    [],
    {},
    { paths: 'C:\\VFX' },
    { paths: [42] },
    { paths: [null] },
    { paths: [''] },
    { paths: ['   '] },
    { paths: ['plugs'] },
    { paths: ['./relativa'] },
    { paths: Array.from({ length: SYSTEM_PATHS_LIMIT + 1 }, () => 'C:\\VFX') },
  ];

  for (const body of invalid) {
    assert.throws(
      () => readPaths(body),
      BadRequestException,
      `debería rechazar ${JSON.stringify(body)}`,
    );
  }
});

test('PathsService dice qué hay en el disco, en el orden pedido', async (t) => {
  const dir = await tempDir(t);
  const folder = path.join(dir, 'plugs');
  await mkdir(folder);
  const file = path.join(dir, 'Rhodes.fxb');
  await writeFile(file, 'banco');
  const missing = path.join(dir, 'Borrado.fxb');

  const service = new PathsService();
  assert.deepEqual(await service.check([folder, file, missing]), [
    { path: folder, exists: true, isDirectory: true },
    { path: file, exists: true, isDirectory: false },
    { path: missing, exists: false, isDirectory: false },
  ]);
  assert.deepEqual(await service.check([]), []);
});

test('PathsService trata un error de lectura como ruta que ya no sirve', async () => {
  const denied: PathStat = async () => {
    throw Object.assign(new Error('EACCES: permiso denegado'), { code: 'EACCES' });
  };

  assert.deepEqual(await new PathsService(denied).check(['C:\\solo-administradores']), [
    { path: 'C:\\solo-administradores', exists: false, isDirectory: false },
  ]);
});

test('PathsService comprueba todas las rutas aunque una falle', async () => {
  const consulted: string[] = [];
  const stat: PathStat = async (target) => {
    consulted.push(target);
    if (target === 'C:\\roto') throw new Error('sin acceso');
    return { isDirectory: () => target === 'C:\\carpeta' };
  };

  assert.deepEqual(await new PathsService(stat).check(['C:\\carpeta', 'C:\\roto']), [
    { path: 'C:\\carpeta', exists: true, isDirectory: true },
    { path: 'C:\\roto', exists: false, isDirectory: false },
  ]);
  assert.deepEqual(consulted, ['C:\\carpeta', 'C:\\roto']);
});

test('SystemPathsController valida antes de tocar el disco y devuelve los estados', async () => {
  const consulted: string[][] = [];
  const service = new PathsService(async (target) => {
    consulted.push([target]);
    return { isDirectory: () => true };
  });
  const controller = new SystemPathsController(service);

  await assert.rejects(controller.check({ paths: ['relativa'] }), BadRequestException);
  assert.deepEqual(consulted, [], 'una petición inválida no llega al disco');

  const response = await controller.check({ paths: ['C:\\VFX\\Library'] });
  assert.deepEqual(response, {
    results: [{ path: 'C:\\VFX\\Library', exists: true, isDirectory: true }],
  });
});

test('el ejemplo del endpoint mezcla rutas vivas y una borrada', () => {
  assert.deepEqual(
    SYSTEM_PATHS_MIXED_EXAMPLE.results.map((result) => [result.exists, result.isDirectory]),
    [
      [true, true],
      [true, false],
      [false, false],
    ],
  );
});
