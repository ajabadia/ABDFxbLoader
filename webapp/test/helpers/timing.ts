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

export interface BudgetResult {
  ok: boolean;
  /** La mediana pasó del presupuesto aunque la mejor muestra no: apunta a carga. */
  loadSuspected: boolean;
  message: string;
}

/**
 * Comprueba un presupuesto de tiempo con dos lecturas complementarias.
 *
 * La **mejor muestra** es la más cercana al coste real: la carga de la máquina
 * solo puede sumar tiempo, así que un runner ocupado no la mueve —mientras que
 * la mediana sí, y convertir la carga en un fallo es lo que hacía fallar la CI
 * de forma intermitente—. Una regresión de verdad sube también la mejor
 * muestra.
 *
 * La mediana se sigue mirando, pero con holgura (`medianHeadroom`): así un
 * empeoramiento de fondo —algo que se volvió varias veces más lento en todas
 * las muestras— rompe el test igual, aunque el mínimo siga por debajo.
 */
export function checkBudget(
  timing: Timing,
  budgetMs: number,
  label: string,
  medianHeadroom = 4,
): BudgetResult {
  const medianCeilingMs = budgetMs * medianHeadroom;
  const bestOk = timing.bestMs < budgetMs;
  const message =
    `${label} tardó ${timing.bestMs.toFixed(3)} ms en su mejor muestra ` +
    `(mediana ${timing.medianMs.toFixed(3)} ms, peor ${timing.worstMs.toFixed(3)} ms); ` +
    `presupuesto ${budgetMs} ms por muestra y techo de mediana ${medianCeilingMs} ms`;
  const medianBelowCeiling = timing.medianMs < medianCeilingMs;
  return {
    ok: bestOk && medianBelowCeiling,
    // Solo es «carga» si pasa por la mediana y no llega a fallar: si se pasa
    // también del techo, es una regresión y el diagnóstico no debe excusarla.
    loadSuspected: bestOk && medianBelowCeiling && timing.medianMs >= budgetMs,
    message,
  };
}

/** «mediana 0.0310 ms (p95 …, min …, max …) ≈ 32258 parses/s». */
export function describeTiming(timing: Timing, noun: string): string {
  return (
    `mediana ${timing.medianMs.toFixed(4)} ms ` +
    `(p95 ${timing.p95Ms.toFixed(4)} ms, min ${timing.bestMs.toFixed(4)} ms, ` +
    `max ${timing.worstMs.toFixed(4)} ms) ≈ ${Math.round(timing.perSecond)} ${noun}`
  );
}
