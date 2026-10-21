import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseFxbBank } from '../src/library/fxb-bank';
import { describeTiming, measureSync } from './helpers/timing';

/**
 * Referencia de rendimiento del parser con bancos reales: el de 100 programas
 * de MauSynth (`FxBk` v2, cada programa `FxCk`) frente al de fábrica de 128
 * programas de OB-Xd (`FBCh` v2, todo el estado en un chunk opaco).
 *
 * Ojo con leer la comparación al revés: en un `FxBk` el parser recorre los 100
 * programas comprobando `CcnK`, tamaños y `byteSize = 48 + 4 * numParams`,
 * mientras que un `FBCh` solo valida la cabecera y el int32 con el tamaño del
 * chunk. El segundo archivo es cuatro veces más grande que el primero y aun así
 * se parsea sin recorrer ningún programa, así que los dos números miden trabajos
 * distintos: sirven como referencia absoluta (cuánto cuesta parsear un banco
 * real) y no como comparación entre plugins.
 */

const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'fxb');
const MAUSYNTH = path.join(FIXTURES, 'mausynth-az-bank.fxb');
const OBXD = path.join(FIXTURES, 'wam-obxd-factory.fxb');

/** Parses de calentamiento antes de medir (JIT, caché de páginas del archivo). */
const WARMUP = 50;
/** Muestras medidas por banco: el percentil 95 necesita una cola razonable. */
const ITERATIONS = 500;
/**
 * Techo por parse. En una máquina normal cada banco tarda decenas de
 * microsegundos, así que el margen absorbe cualquier CI lenta sin volver el
 * test dependiente del hardware. Si se supera, algo pasó de lineal a otra cosa.
 */
const BUDGET_MS = 25;

/** Mide cada parse por separado para poder quedarse con la mediana. */
function timeParses(data: Buffer, iterations: number): ReturnType<typeof measureSync> {
  return measureSync(iterations, () => {
    parseFxbBank(data);
  });
}

test('el parser tarda microsegundos con los bancos reales de MauSynth y OB-Xd', async (t) => {
  const mausynth = await readFile(MAUSYNTH);
  const obxd = await readFile(OBXD);
  const mausynthBytes = mausynth.length;
  const obxdBytes = obxd.length;

  // Antes de medir: que sean los bancos esperados y que el parseo sea correcto,
  // para no cronometrar un error temprano (que también sería rápido).
  const mausynthParse = parseFxbBank(mausynth);
  assert.deepEqual(mausynthParse.issues, []);
  assert.equal(mausynthParse.bank?.kind, 'FxBk');
  assert.equal(mausynthParse.bank?.numPrograms, 100);
  assert.equal(mausynthParse.bank?.uniqueId, 'Pang');

  const obxdParse = parseFxbBank(obxd);
  assert.deepEqual(obxdParse.issues, []);
  assert.equal(obxdParse.bank?.kind, 'FBCh');
  assert.equal(obxdParse.bank?.numPrograms, 128);
  assert.equal(obxdParse.bank?.chunkSize, 86197);
  assert.equal(obxdParse.bank?.uniqueId, 'Obxd');

  for (let index = 0; index < WARMUP; index += 1) {
    parseFxbBank(mausynth);
    parseFxbBank(obxd);
  }

  const mausynthTiming = timeParses(mausynth, ITERATIONS);
  const obxdTiming = timeParses(obxd, ITERATIONS);

  t.diagnostic(
    `MauSynth ${mausynthBytes} bytes, 100 programas FxCk → parse ${describeTiming(mausynthTiming, 'parses/s')}`,
  );
  t.diagnostic(
    `OB-Xd ${obxdBytes} bytes, 128 programas chunk → parse ${describeTiming(obxdTiming, 'parses/s')}`,
  );

  assert.ok(
    mausynthTiming.medianMs < BUDGET_MS,
    `MauSynth (100 programas) tardó ${mausynthTiming.medianMs.toFixed(3)} ms de mediana, ` +
      `presupuesto ${BUDGET_MS} ms`,
  );
  assert.ok(
    obxdTiming.medianMs < BUDGET_MS,
    `OB-Xd (128 programas) tardó ${obxdTiming.medianMs.toFixed(3)} ms de mediana, ` +
      `presupuesto ${BUDGET_MS} ms`,
  );

  // Los buffers son los del fixture: parsear no debe reescribirlos.
  assert.deepEqual(mausynth, await readFile(MAUSYNTH), 'el parse no modifica el banco de MauSynth');
  assert.deepEqual(obxd, await readFile(OBXD), 'el parse no modifica el banco de OB-Xd');
});
