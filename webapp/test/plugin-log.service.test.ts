import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PluginLogService } from '../src/plugin-log/plugin-log.service';
import {
  DEFAULT_MAX_LOG_SIZE_BYTES,
  MAX_ROTATED_LOG_FILES,
  PLUGIN_LOG_FILENAME,
} from '../src/plugin-log/plugin-log.types';

describe('PluginLogService', () => {
  let tempDir: string;
  let service: PluginLogService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fxbloader-log-test-'));
    service = new PluginLogService();
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('un plugin nuevo sin log devuelve snapshot vacío con exists: false', async () => {
    const snapshot = await service.read(tempDir);
    assert.equal(snapshot.exists, false);
    assert.equal(snapshot.size, 0);
    assert.equal(snapshot.entries.length, 0);
    assert.equal(snapshot.raw, '');
    assert.deepEqual(snapshot.rotatedFiles, []);
  });

  it('escribe la primera entrada en fxbLoader.log con timestamp ISO y resumen', async () => {
    const ok = await service.append(tempDir, 'install', 'Instalado fxbLoader.dll en el plugin');
    assert.equal(ok, true);

    const logPath = path.join(tempDir, PLUGIN_LOG_FILENAME);
    const content = await fs.readFile(logPath, 'utf8');
    assert.match(content, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.match(content, /\[install\] Instalado fxbLoader\.dll en el plugin/);

    const snapshot = await service.read(tempDir);
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0]?.action, 'install');
    assert.equal(snapshot.entries[0]?.summary, 'Instalado fxbLoader.dll en el plugin');
  });

  it('trunca por la derecha un resumen que excede MAX_SUMMARY_LENGTH', async () => {
    const longSummary = 'A'.repeat(1200);
    const ok = await service.append(tempDir, 'batch', longSummary);
    assert.equal(ok, true);

    const snapshot = await service.read(tempDir);
    assert.equal(snapshot.entries.length, 1);
    const summary = snapshot.entries[0]!.summary;
    assert.ok(summary.length <= 1003);
    assert.ok(summary.endsWith('...'));
    assert.ok(summary.startsWith('AAAAA'));
  });

  it('admite detalle opcional separado en la entrada', async () => {
    await service.append(tempDir, 'import', 'Importados 3 bancos', 'presets/Piano.fxb');
    const snapshot = await service.read(tempDir);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0]?.detail, 'presets/Piano.fxb');
  });

  it('rota fxbLoader.log al superar el umbral de tamaño configurado', async () => {
    const smallThreshold = 200; // 200 bytes para probar rotación rápida
    await service.append(
      tempDir,
      'op1',
      'Operación inicial número 1',
      undefined,
      { maxSizeBytes: smallThreshold },
    );

    // Segundo append que hará que el archivo supere los 200 bytes
    await service.append(
      tempDir,
      'op2',
      'Operación número 2 con texto suficientemente largo para sobrepasar el umbral de prueba de doscientos bytes',
      undefined,
      { maxSizeBytes: smallThreshold },
    );

    const files = await fs.readdir(tempDir);
    assert.ok(files.includes(PLUGIN_LOG_FILENAME), 'debe existir archivo activo fxbLoader.log');
    assert.ok(files.includes(`${PLUGIN_LOG_FILENAME}.1`), 'debe existir fxbLoader.log.1');

    const snapshot = await service.read(tempDir);
    assert.equal(snapshot.rotatedFiles.length, 1);
    assert.ok(snapshot.rotatedFiles.includes(`${PLUGIN_LOG_FILENAME}.1`));
    // Ambas entradas deben ser legibles
    assert.ok(snapshot.entries.some((e) => e.action === 'op1'));
    assert.ok(snapshot.entries.some((e) => e.action === 'op2'));
  });

  it('mantiene un máximo de 7 archivos rotados y descarta el más antiguo (.log.7)', async () => {
    const tinyThreshold = 50;

    // Escribir 9 entradas que fuercen 8 rotaciones
    for (let i = 1; i <= 9; i++) {
      await service.append(
        tempDir,
        `op${i}`,
        `Entrada repetida para forzar rotaciones sucesivas número ${i}`,
        undefined,
        { maxSizeBytes: tinyThreshold },
      );
    }

    const files = (await fs.readdir(tempDir)).sort();
    assert.ok(files.includes(PLUGIN_LOG_FILENAME));
    for (let r = 1; r <= MAX_ROTATED_LOG_FILES; r++) {
      assert.ok(files.includes(`${PLUGIN_LOG_FILENAME}.${r}`), `falta .log.${r}`);
    }
    assert.equal(files.includes(`${PLUGIN_LOG_FILENAME}.8`), false, 'no debe haber .log.8');
  });

  it('rota justo al pasarse del umbral por un byte, no cuando la entrada cabe', async () => {
    // La condición es `tamaño + línea > umbral`, así que el límite exacto no
    // rota. La línea se mide con el mismo formato que escribe el servicio (el
    // timestamp ISO siempre ocupa 24 caracteres), sin depender del reloj.
    const lineBytes = (action: string, summary: string): number =>
      Buffer.byteLength(`[${'x'.repeat(24)}] [${action}] ${summary}\n`, 'utf8');

    const first = { action: 'op1', summary: 'Primera entrada del archivo activo' };
    await service.append(tempDir, first.action, first.summary, undefined, { maxSizeBytes: 1024 });
    const logPath = path.join(tempDir, PLUGIN_LOG_FILENAME);
    const afterFirst = (await fs.stat(logPath)).size;

    // Cabe exacto: el archivo queda en el umbral y no se rota nada.
    const second = { action: 'op2', summary: 'Segunda entrada que cabe exacta' };
    await service.append(tempDir, second.action, second.summary, undefined, {
      maxSizeBytes: afterFirst + lineBytes(second.action, second.summary),
    });
    assert.deepEqual(await fs.readdir(tempDir), [PLUGIN_LOG_FILENAME], 'no debe aparecer .log.1');
    assert.equal((await fs.stat(logPath)).size, afterFirst + lineBytes(second.action, second.summary));

    // Un byte menos de umbral ya obliga a rotar: el activo se lleva el anterior.
    const third = { action: 'op3', summary: 'Tercera entrada que ya no cabe' };
    const bytesBeforeThird = (await fs.stat(logPath)).size;
    await service.append(tempDir, third.action, third.summary, undefined, {
      maxSizeBytes: bytesBeforeThird + lineBytes(third.action, third.summary) - 1,
    });

    const rotated = await fs.readFile(`${logPath}.1`, 'utf8');
    assert.match(rotated, /\[op1\]/);
    assert.match(rotated, /\[op2\]/);
    assert.equal((await fs.stat(`${logPath}.1`)).size, bytesBeforeThird, 'el rotado es el activo anterior entero');

    const active = await fs.readFile(logPath, 'utf8');
    assert.match(active, /\[op3\]/);
    assert.doesNotMatch(active, /\[op2\]/, 'el activo solo conserva lo escrito tras rotar');

    // La lectura sigue viendo las tres entradas y las devuelve en orden.
    const snapshot = await service.read(tempDir);
    assert.deepEqual(snapshot.entries.map((entry) => entry.action), ['op1', 'op2', 'op3']);
    assert.equal(snapshot.totalEntries, 3);
  });

  it('lee los rotados del más antiguo al más reciente y nombra .log.1 primero', async () => {
    // Umbral de 1 byte: cada append rota el activo anterior. Con tres rotados
    // permitidos, la quinta entrada descarta la más vieja (.log.3).
    const options = { maxSizeBytes: 1, maxRotatedFiles: 3 };
    for (let i = 1; i <= 5; i++) {
      await service.append(tempDir, `op${i}`, `Entrada número ${i}`, undefined, options);
    }

    const logPath = path.join(tempDir, PLUGIN_LOG_FILENAME);
    assert.match(await fs.readFile(`${logPath}.1`, 'utf8'), /\[op4\]/);
    assert.match(await fs.readFile(`${logPath}.2`, 'utf8'), /\[op3\]/);
    assert.match(await fs.readFile(`${logPath}.3`, 'utf8'), /\[op2\]/);
    assert.match(await fs.readFile(logPath, 'utf8'), /\[op5\]/);
    assert.equal(await fs.stat(`${logPath}.4`).then(() => true, () => false), false);

    const snapshot = await service.read(tempDir);

    // Los rotados se listan del más nuevo al más viejo y las entradas se leen
    // al revés, del rotado más antiguo al activo: eso es el orden cronológico.
    assert.deepEqual(snapshot.rotatedFiles, ['.1', '.2', '.3'].map((suffix) => `${PLUGIN_LOG_FILENAME}${suffix}`));
    assert.deepEqual(snapshot.entries.map((entry) => entry.action), ['op2', 'op3', 'op4', 'op5']);
    assert.equal(snapshot.totalEntries, 4);
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.size, (await fs.stat(logPath)).size, 'size es solo el archivo activo');

    const positions = ['op2', 'op3', 'op4', 'op5'].map((action) => snapshot.raw.indexOf(`[${action}]`));
    assert.ok(positions.every((position) => position >= 0), `raw debe contener las cuatro entradas: ${positions}`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'raw va del más antiguo al más reciente');
    assert.equal(snapshot.raw.includes('[op1]'), false, 'la entrada descartada ya no se lee');
  });

  it('degrada silenciosamente sin lanzar excepción si el directorio no existe o falla', async () => {
    const nonExistent = path.join(tempDir, 'no-existe', 'sub');
    const ok = await service.append(nonExistent, 'install', 'resumen');
    assert.equal(ok, false, 'debe devolver false indicando degradación sin error');

    const snapshot = await service.read(nonExistent);
    assert.equal(snapshot.exists, false);
    assert.equal(snapshot.entries.length, 0);
  });
});
