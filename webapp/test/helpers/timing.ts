/**
 * Medición compartida por los tests de rendimiento.
 *
 * Cada muestra se toma con `process.hrtime.bigint()` alrededor de una sola
 * operación, así que la mediana y el p95 describen operaciones sueltas y no el
 * tiempo medio de un lote (que escondería una cola lenta).
 */

export interface Timing {
  medianMs: number;
  p95Ms: number;
  bestMs: number;
  worstMs: number;
  /** Operaciones por segundo según la mediana. */
  perSecond: number;
  /** Muestras medidas. */
  samples: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
}

/** Resumen de muestras ya tomadas, en milisegundos. */
export function timingFromSamples(samples: readonly number[]): Timing {
  const sorted = [...samples].sort((left, right) => left - right);
  const medianMs = percentile(sorted, 0.5);
  return {
    medianMs,
    p95Ms: percentile(sorted, 0.95),
    bestMs: sorted[0]!,
    worstMs: sorted[sorted.length - 1]!,
    perSecond: medianMs > 0 ? 1000 / medianMs : Infinity,
    samples: sorted.length,
  };
}

/** Mide `iterations` ejecuciones síncronas, una muestra por ejecución. */
export function measureSync(iterations: number, run: (index: number) => void): Timing {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = process.hrtime.bigint();
    run(index);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return timingFromSamples(samples);
}

/**
 * Mide `iterations` ejecuciones asíncronas, esperando cada una antes de pasar a
 * la siguiente (no se solapan, que es lo que hace una importación por petición).
 */
export async function measureAsync(
  iterations: number,
  run: (index: number) => Promise<unknown> | unknown,
): Promise<Timing> {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = process.hrtime.bigint();
    await run(index);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return timingFromSamples(samples);
}

/** «mediana 0.0310 ms (p95 …, min …, max …) ≈ 32258 parses/s». */
export function describeTiming(timing: Timing, noun: string): string {
  return (
    `mediana ${timing.medianMs.toFixed(4)} ms ` +
    `(p95 ${timing.p95Ms.toFixed(4)} ms, min ${timing.bestMs.toFixed(4)} ms, ` +
    `max ${timing.worstMs.toFixed(4)} ms) ≈ ${Math.round(timing.perSecond)} ${noun}`
  );
}
