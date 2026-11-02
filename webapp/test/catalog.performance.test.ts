import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

/**
 * El catálogo de wizards empaquetado (629 KB) se lee en cada arranque del
 * servidor con un `JSON.parse` síncrono. El techo es amplio a propósito: no
 * mide la máquina, detecta un salto de orden (un catálogo que crece sin control
 * o un parseo que se repite por plugin) sin fallar en un portátil lento.
 */
const CATALOG = path.resolve(__dirname, '..', '..', 'src', 'wizard', 'wizards-catalog.json');
const CEILING_MS = 250;

test('el catálogo de wizards se parsea por debajo de 250 ms', () => {
  const raw = readFileSync(CATALOG, 'utf8');
  const samples: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const start = process.hrtime.bigint();
    const parsed = JSON.parse(raw) as unknown[];
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    assert.ok(parsed.length > 0, 'el catálogo está vacío');
  }
  samples.sort((left, right) => left - right);
  const median = samples[Math.floor(samples.length / 2)]!;
  assert.ok(median <= CEILING_MS, `mediana ${median.toFixed(1)} ms > ${CEILING_MS} ms`);
});
