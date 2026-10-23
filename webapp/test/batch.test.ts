import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyBatchEvent,
  BatchClock,
  cancelledSummary,
  failuresOf,
  formatDuration,
  initialProgress,
  mergeProgress,
  progressLabel,
  resumablePlugins,
  resumeLabel,
  retryProgress,
  runBatchInChunks,
  splitBatch,
  stepLabel,
  summarize,
  timingLabel,
  type BatchAction,
  type BatchFailure,
  type BatchResponse,
  type BatchProgress,
  type BatchSender,
  type BatchTotals,
} from '../src/ui/batch';
import {
  MAX_PLUGINS_PER_BATCH,
  type BatchStreamEvent,
  type BatchStreamPluginResult,
  type BatchStreamResult,
} from '../src/client/batch-stream';

/**
 * La vista ya no orquesta el lote: lo ejecuta el servidor. Aquí se comprueba
 * cómo traduce el flujo de progreso (`start`, `plugin`, `end`) en el estado que
 * pinta mientras trabaja, su respuesta final en la lista de fallos y el
 * resumen, y el troceado del lote cuando hay más plugins que el tope de una
 * petición: varias peticiones seguidas con una sola barra.
 */

function response(overrides: Partial<BatchResponse> = {}): BatchResponse {
  return {
    action: 'install',
    total: 0,
    succeeded: 0,
    failed: 0,
    results: [],
    ...overrides,
  };
}

test('failuresOf devuelve vacío si ningún plugin falló', () => {
  const result = failuresOf(
    response({
      action: 'install',
      total: 2,
      succeeded: 2,
      results: [
        { name: 'Alpha', status: 'installed', message: null },
        { name: 'Beta', status: 'installed', message: null },
      ],
    }),
  );

  assert.deepEqual(result, []);
});

test('failuresOf recoge los fallidos con su motivo y la acción del lote', () => {
  const failures: BatchFailure[] = failuresOf(
    response({
      action: 'install',
      total: 3,
      succeeded: 1,
      failed: 2,
      results: [
        { name: 'Alpha', status: 'failed', message: 'sin respaldo vfxinfo.tx_' },
        { name: 'Beta', status: 'installed', message: null },
        { name: 'Gamma', status: 'failed', message: 'acceso denegado' },
      ],
    }),
  );

  assert.deepEqual(failures, [
    { plugin: { name: 'Alpha' }, action: 'install', message: 'sin respaldo vfxinfo.tx_' },
    { plugin: { name: 'Gamma' }, action: 'install', message: 'acceso denegado' },
  ]);
  // El orden es el del lote, para reintentarlos en el mismo orden.
  assert.deepEqual(
    failures.map((failure) => failure.plugin.name),
    ['Alpha', 'Gamma'],
  );
});

test('failuresOf usa la acción del lote, también al desinstalar', () => {
  const failures = failuresOf(
    response({
      action: 'uninstall',
      total: 1,
      succeeded: 0,
      failed: 1,
      results: [{ name: 'Alpha', status: 'failed', message: 'falta vfxinfo.tx_' }],
    }),
  );

  assert.equal(failures[0]?.action, 'uninstall' satisfies BatchAction);
  assert.equal(failures[0]?.plugin.name, 'Alpha');
});

test('failuresOf no inventa mensajes cuando el servidor no manda motivo', () => {
  const failures = failuresOf(
    response({
      action: 'uninstall',
      total: 1,
      succeeded: 0,
      failed: 1,
      results: [{ name: 'Alpha', status: 'failed', message: null }],
    }),
  );

  assert.equal(failures[0]?.message, 'Error desconocido');
});

test('el progreso nombra el plugin en curso y avanza con cada evento', () => {
  const events: BatchStreamEvent[] = [
    { type: 'start', action: 'install', dryRun: false, total: 3, plugins: ['Alpha', 'Beta'] },
    { type: 'plugin', index: 0, total: 3, name: 'Alpha', status: 'running', message: null },
  ];

  let progress: BatchProgress = initialProgress('install', 3);
  for (const event of events) progress = applyBatchEvent(progress, event);

  assert.equal(progress.current, 'Alpha');
  assert.equal(progress.total, 3);
  assert.equal(progress.done, 0);
  assert.equal(progressLabel(progress), 'Instalando 1 de 3: Alpha…');

  progress = applyBatchEvent(progress, {
    type: 'plugin',
    index: 0,
    total: 3,
    name: 'Alpha',
    status: 'installed',
    message: null,
  });
  assert.equal(progress.current, null, 'entre plugins no hay ninguno en curso');
  assert.equal(progress.done, 1);
  assert.equal(progressLabel(progress), 'Instalando 2 de 3…');
});

test('los pasos internos se pintan y se limpian al cerrar el plugin', () => {
  let progress = applyBatchEvent(initialProgress('install', 2), {
    type: 'start',
    action: 'install',
    dryRun: false,
    total: 2,
    plugins: ['Alpha', 'Beta'],
  });
  progress = applyBatchEvent(progress, {
    type: 'plugin',
    index: 0,
    total: 2,
    name: 'Alpha',
    status: 'running',
    message: null,
  });
  assert.equal(stepLabel(progress), null, 'sin paso interno no hay detalle');

  progress = applyBatchEvent(progress, {
    type: 'step',
    index: 0,
    total: 2,
    name: 'Alpha',
    step: 'copy',
    stepIndex: 1,
    steps: 5,
  });
  assert.equal(progress.step, 'copy');
  assert.equal(stepLabel(progress), 'paso 2 de 5 · copiando fxbLoader.dll');
  assert.equal(
    progressLabel(progress),
    'Instalando 1 de 2: Alpha…',
    'el paso no cambia la cuenta de plugins',
  );

  progress = applyBatchEvent(progress, {
    type: 'plugin',
    index: 0,
    total: 2,
    name: 'Alpha',
    status: 'installed',
    message: null,
  });
  assert.equal(progress.step, null, 'al cerrar el plugin no queda ningún paso');
  assert.equal(stepLabel(progress), null);

  // El siguiente plugin estrena su propia cuenta de pasos.
  progress = applyBatchEvent(progress, {
    type: 'plugin',
    index: 1,
    total: 2,
    name: 'Beta',
    status: 'running',
    message: null,
  });
  progress = applyBatchEvent(progress, {
    type: 'step',
    index: 1,
    total: 2,
    name: 'Beta',
    step: 'restore',
    stepIndex: 0,
    steps: 3,
  });
  assert.equal(stepLabel(progress), 'paso 1 de 3 · restaurando vfxinfo.txt');

  progress = applyBatchEvent(progress, {
    type: 'step',
    index: 1,
    total: 2,
    name: 'Beta',
    step: 'delete',
    stepIndex: 2,
    steps: 3,
  });
  assert.equal(stepLabel(progress), 'paso 3 de 3 · borrando fxbLoader.config');

  progress = applyBatchEvent(progress, {
    type: 'end',
    result: streamResult('uninstall', ['Alpha', 'Beta']),
  });
  assert.equal(progress.step, null, 'el lote terminado no deja un paso a medias');
  assert.equal(stepLabel(progress), null);
});

test('el progreso cuenta los fallos y termina con el resultado del lote', () => {
  let progress = applyBatchEvent(initialProgress('uninstall', 2), {
    type: 'start',
    action: 'uninstall',
    dryRun: false,
    total: 2,
    plugins: ['Alpha', 'Beta'],
  });
  progress = applyBatchEvent(progress, {
    type: 'plugin',
    index: 0,
    total: 2,
    name: 'Alpha',
    status: 'running',
    message: null,
  });
  progress = applyBatchEvent(progress, {
    type: 'plugin',
    index: 0,
    total: 2,
    name: 'Alpha',
    status: 'failed',
    message: 'falta vfxinfo.tx_',
  });

  assert.equal(progress.failed, 1);
  assert.equal(progressLabel(progress), 'Desinstalando 2 de 2… · 1 con error');

  progress = applyBatchEvent(progress, {
    type: 'end',
    result: {
      action: 'uninstall',
      dryRun: false,
      total: 2,
      succeeded: 1,
      failed: 1,
      results: [
        { name: 'Alpha', status: 'failed', message: 'falta vfxinfo.tx_' },
        { name: 'Beta', status: 'uninstalled', message: null },
      ],
    },
  });

  assert.equal(progress.finished, true);
  assert.equal(progress.current, null);
  assert.equal(progress.done, 2);
  assert.equal(progressLabel(progress), '2 de 2 desinstalado(s) · 1 con error.');
});

/** Resultado de una petición, como el que llega en el evento `end`. */
function streamResult(
  action: BatchAction,
  names: string[],
  failedNames: readonly string[] = [],
): BatchStreamResult {
  const results: BatchStreamPluginResult[] = names.map((name) => ({
    name,
    status: failedNames.includes(name)
      ? 'failed'
      : action === 'install'
        ? 'installed'
        : 'uninstalled',
    message: failedNames.includes(name) ? `${name} falló` : null,
  }));
  return {
    action,
    dryRun: false,
    total: names.length,
    succeeded: results.filter((result) => result.status !== 'failed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    results,
  };
}

/** Emisor de mentira: apunta las peticiones y reproduce los eventos reales. */
function fakeSender(
  action: BatchAction,
  options: { failOnRequest?: number; failedNames?: readonly string[] } = {},
): { send: BatchSender; requests: string[][] } {
  const requests: string[][] = [];
  const failedNames = options.failedNames ?? [];

  const send: BatchSender = async (plugins, onEvent) => {
    requests.push([...plugins]);
    if (requests.length === options.failOnRequest) throw new Error('se cayó la red');

    onEvent({ type: 'start', action, dryRun: false, total: plugins.length, plugins: [...plugins] });
    for (const [index, name] of plugins.entries()) {
      const failedHere = failedNames.includes(name);
      onEvent({
        type: 'plugin',
        index,
        total: plugins.length,
        name,
        status: 'running',
        message: null,
      });
      onEvent({
        type: 'plugin',
        index,
        total: plugins.length,
        name,
        status: failedHere ? 'failed' : action === 'install' ? 'installed' : 'uninstalled',
        message: failedHere ? `${name} falló` : null,
      });
    }

    const result = streamResult(action, plugins, failedNames);
    onEvent({ type: 'end', result });
    return result;
  };

  return { send, requests };
}

const namesFrom = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `P${index}`);

test('splitBatch deja una sola petición cuando todo cabe en el tope', () => {
  const names = ['Alpha', 'Beta', 'Gamma'];

  assert.deepEqual(splitBatch(names), [names]);
  assert.deepEqual(splitBatch([]), [], 'sin plugins no hay peticiones');
  assert.equal(splitBatch(names, 500).length, 1, 'el tamaño se puede fijar');
});

test('splitBatch trocea al llegar al tope del servidor sin perder ni reordenar', () => {
  const names = namesFrom(MAX_PLUGINS_PER_BATCH + 2);
  const batches = splitBatch(names);

  assert.equal(batches.length, 2, 'un solo plugin de más abre una petición nueva');
  assert.equal(batches[0]?.length, MAX_PLUGINS_PER_BATCH);
  assert.deepEqual(batches[1], names.slice(MAX_PLUGINS_PER_BATCH));
  assert.deepEqual(batches.flat(), names, 'el orden del lote se conserva');
  assert.ok(
    batches.every((batch) => batch.length > 0 && batch.length <= MAX_PLUGINS_PER_BATCH),
    'ninguna petición vacía ni por encima del tope',
  );
});

test('splitBatch rechaza un tamaño que no puede ser el de una petición', () => {
  for (const size of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => splitBatch(['Alpha'], size), /tamaño de lote no válido/);
  }
});

test('mergeProgress suma las peticiones anteriores en una sola cuenta', () => {
  const totals = { action: 'install', total: 6, done: 3, failed: 1 } satisfies Parameters<
    typeof mergeProgress
  >[0];

  const merged = mergeProgress(totals, {
    action: 'install',
    total: 3,
    current: 'Delta',
    index: 0,
    done: 0,
    failed: 0,
    finished: false,
    step: 'patch',
    stepIndex: 2,
    steps: 5,
  });

  assert.deepEqual(merged, {
    action: 'install',
    total: 6,
    current: 'Delta',
    index: 3,
    done: 3,
    failed: 1,
    finished: false,
    step: 'patch',
    stepIndex: 2,
    steps: 5,
  });
  assert.equal(progressLabel(merged), 'Instalando 4 de 6: Delta… · 1 con error');
  assert.equal(stepLabel(merged), 'paso 3 de 5 · parcheando dll_name', 'el paso sigue al lote');
});

test('retryProgress reutiliza barra, paso y reloj para cada fallo reintentado', () => {
  const failures: BatchFailure[] = [
    { plugin: { name: 'Alpha' }, action: 'install', message: 'falló' },
    { plugin: { name: 'Beta' }, action: 'uninstall', message: 'falló' },
    { plugin: { name: 'Gamma' }, action: 'install', message: 'falló' },
  ];
  const progress = retryProgress(failures[1]!, 1, failures.length, 1);

  assert.deepEqual(progress, {
    action: 'uninstall',
    total: 3,
    current: 'Beta',
    index: 1,
    done: 1,
    failed: 1,
    finished: false,
    step: null,
    stepIndex: 1,
    steps: 3,
    stepText: 'paso 2 de 3 · reintentando Beta',
  });
  assert.equal(stepLabel(progress), 'paso 2 de 3 · reintentando Beta');

  const clock = new BatchClock(0);
  clock.startStep(500);
  const timing = clock.snapshot(progress, 900);
  assert.equal(timing.stepElapsedMs, 400, 'el paso del reintento también se cronometra');
  assert.equal(
    timingLabel(timing, progress),
    '0,9 s transcurridos · calculando el tiempo restante… · 1 fallo(s) detrás del actual · 0,4 s en el paso actual',
  );
});

test('mergeProgress solo da el lote por terminado en la última petición', () => {
  const totals: BatchTotals = { action: 'uninstall', total: 6, done: 3, failed: 0 };
  const lastChunk = {
    action: 'uninstall',
    total: 3,
    current: null,
    index: 0,
    done: 3,
    failed: 0,
    finished: true,
    step: null,
    stepIndex: 0,
    steps: 0,
  } as const;

  assert.equal(mergeProgress({ ...totals, done: 0 }, lastChunk).finished, false);
  assert.equal(mergeProgress(totals, lastChunk).finished, true);
});

test('el lote se envía troceado y la barra sigue la cuenta global', async () => {
  const names = namesFrom(MAX_PLUGINS_PER_BATCH + 3);
  const { send, requests } = fakeSender('install');
  const labels: string[] = [];

  const run = await runBatchInChunks({
    action: 'install',
    plugins: names,
    send,
    onProgress: (progress) => labels.push(progressLabel(progress)),
  });

  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.length <= MAX_PLUGINS_PER_BATCH));
  assert.deepEqual(requests.flat(), names, 'las peticiones cubren el lote en orden');

  assert.equal(run.error, null);
  assert.equal(run.requests, 2);
  assert.equal(run.total, names.length);
  assert.equal(run.succeeded, names.length);
  assert.equal(run.failed, 0);
  assert.equal(run.unreported, 0);
  assert.deepEqual(run.pending, [], 'un lote completo no deja nada por reanudar');
  assert.equal(run.results.length, names.length);

  // La segunda petición no reinicia el texto: sigue contando desde el principio.
  const firstOfSecondBatch = `Instalando ${MAX_PLUGINS_PER_BATCH + 1} de ${names.length}: ` +
    `${names[MAX_PLUGINS_PER_BATCH]}…`;
  assert.ok(labels.includes(firstOfSecondBatch), labels.join('\n'));
  assert.equal(labels.at(-1), `${names.length} de ${names.length} instalado(s).`);
});

test('si una petición falla, el lote se corta y conserva lo confirmado', async () => {
  const names = namesFrom(MAX_PLUGINS_PER_BATCH + 2);
  const { send, requests } = fakeSender('install', {
    failOnRequest: 2,
    failedNames: ['P1', 'P3'],
  });

  const run = await runBatchInChunks({ action: 'install', plugins: names, send });

  assert.equal(requests.length, 2, 'no se envía una tercera petición tras el fallo');
  assert.equal(run.requests, 2);
  assert.ok(run.error instanceof Error, 'el error que cortó el lote queda a la vista');
  assert.equal(run.results.length, MAX_PLUGINS_PER_BATCH);
  assert.equal(run.succeeded, MAX_PLUGINS_PER_BATCH - 2);
  assert.equal(run.failed, 2);
  assert.equal(run.unreported, 2, 'los plugins de la petición cortada quedan sin confirmar');
  assert.deepEqual(
    run.pending,
    names.slice(MAX_PLUGINS_PER_BATCH),
    'los pendientes son los de la petición que no llegó a responder, en orden',
  );

  const failures = failuresOf(run);
  assert.deepEqual(
    failures.map((failure) => failure.plugin.name),
    ['P1', 'P3'],
    'los fallos de las peticiones ya cerradas no se pierden',
  );
  assert.equal(summarize(run), `${MAX_PLUGINS_PER_BATCH - 2} de ${names.length} instalado(s); 2 con error.`);
});

test('cancelar corta la petición y conserva los plugins ya confirmados', async () => {
  const controller = new AbortController();
  const names = ['Alpha', 'Beta', 'Gamma'];
  const requests: string[][] = [];

  const send: BatchSender = async (plugins, onEvent) => {
    requests.push([...plugins]);
    onEvent({
      type: 'start',
      action: 'install',
      dryRun: false,
      total: plugins.length,
      plugins: [...plugins],
    });
    onEvent({ type: 'plugin', index: 0, total: plugins.length, name: 'Alpha', status: 'running', message: null });
    onEvent({ type: 'plugin', index: 0, total: plugins.length, name: 'Alpha', status: 'installed', message: null });
    onEvent({ type: 'plugin', index: 1, total: plugins.length, name: 'Beta', status: 'running', message: null });

    // Lo mismo que hace el botón: aborta mientras Beta está en curso.
    controller.abort();
    throw new Error('petición abortada');
  };

  const run = await runBatchInChunks({
    action: 'install',
    plugins: names,
    send,
    signal: controller.signal,
  });

  assert.equal(requests.length, 1, 'no se envía otra petición tras cancelar');
  assert.equal(run.cancelled, true);
  assert.equal(run.error, null, 'cancelar no es un fallo del lote');
  assert.deepEqual(
    run.results,
    [{ name: 'Alpha', status: 'installed', message: null }],
    'solo se conserva el plugin que ya había avisado su estado final',
  );
  assert.equal(run.succeeded, 1);
  assert.equal(run.failed, 0);
  assert.equal(run.unreported, 2, 'Beta estaba en curso y Gamma ni empezó');
  assert.deepEqual(
    run.pending,
    ['Beta', 'Gamma'],
    'Beta quedó en curso y Gamma no llegó a enviarse, en el orden del lote',
  );
  assert.equal(cancelledSummary(run), 'Lote cancelado: 1 de 3 instalado(s); 2 sin confirmar.');
});

test('cancelar entre peticiones no envía la siguiente', async () => {
  const controller = new AbortController();
  const names = namesFrom(MAX_PLUGINS_PER_BATCH + 2);
  const requests: string[][] = [];

  const send: BatchSender = async (plugins, onEvent) => {
    requests.push([...plugins]);
    onEvent({
      type: 'start',
      action: 'uninstall',
      dryRun: false,
      total: plugins.length,
      plugins: [...plugins],
    });
    for (const [index, name] of plugins.entries()) {
      onEvent({ type: 'plugin', index, total: plugins.length, name, status: 'running', message: null });
      onEvent({
        type: 'plugin',
        index,
        total: plugins.length,
        name,
        status: 'uninstalled',
        message: null,
      });
    }
    const result = streamResult('uninstall', plugins);
    onEvent({ type: 'end', result });
    if (requests.length === 1) controller.abort();
    return result;
  };

  const run = await runBatchInChunks({
    action: 'uninstall',
    plugins: names,
    send,
    signal: controller.signal,
  });

  assert.equal(requests.length, 1, 'la petición siguiente no llega a salir');
  assert.equal(run.cancelled, true);
  assert.equal(run.error, null);
  assert.equal(run.results.length, MAX_PLUGINS_PER_BATCH);
  assert.equal(run.succeeded, MAX_PLUGINS_PER_BATCH);
  assert.equal(run.unreported, 2);
  assert.deepEqual(run.pending, names.slice(MAX_PLUGINS_PER_BATCH));
});

test('un lote cancelado resume lo confirmado y los fallos', () => {
  assert.equal(
    cancelledSummary({ action: 'install', total: 6, succeeded: 3, failed: 1, unreported: 2 }),
    'Lote cancelado: 3 de 6 instalado(s) y 1 con error; 2 sin confirmar.',
  );
  assert.equal(
    cancelledSummary({ action: 'uninstall', total: 2, succeeded: 2, failed: 0, unreported: 0 }),
    'Lote cancelado: 2 de 2 desinstalado(s).',
  );
});

test('el último plugin del trozo no cuenta uno de más', () => {
  const progress: BatchProgress = {
    ...initialProgress('install', 3),
    done: 3,
    finished: false,
  };

  assert.equal(
    progressLabel(progress),
    'Instalando 3 de 3…',
    'entre el último `plugin` y `end` no existe un cuarto plugin',
  );
});

test('un lote vacío no manda ninguna petición', async () => {
  const { send, requests } = fakeSender('uninstall');

  const run = await runBatchInChunks({ action: 'uninstall', plugins: [], send });

  assert.equal(requests.length, 0);
  assert.equal(run.total, 0);
  assert.equal(run.requests, 0);
  assert.equal(run.unreported, 0);
  assert.equal(run.error, null);
});

/* ------------------------------------------------------------------ */
/* Reloj del lote: transcurrido, paso en curso y estimación del resto  */
/* ------------------------------------------------------------------ */

/** Aplica el mismo evento al reloj y al progreso, como hace la vista. */
function feed(
  clock: BatchClock,
  progress: BatchProgress,
  event: BatchStreamEvent,
  now: number,
): BatchProgress {
  clock.event(event, now);
  return applyBatchEvent(progress, event);
}

function running(index: number, name: string, total = 4): BatchStreamEvent {
  return { type: 'plugin', index, total, name, status: 'running', message: null };
}

function installed(index: number, name: string, total = 4): BatchStreamEvent {
  return { type: 'plugin', index, total, name, status: 'installed', message: null };
}

function step(
  index: number,
  name: string,
  stepIndex: number,
  total = 4,
): BatchStreamEvent {
  return { type: 'step', index, total, name, step: 'copy', stepIndex, steps: 5 };
}

test('formatDuration redondea a décimas, segundos y minutos', () => {
  assert.equal(formatDuration(0), '0,0 s');
  assert.equal(formatDuration(420), '0,4 s');
  assert.equal(formatDuration(1_240), '1,2 s');
  assert.equal(formatDuration(9_960), '10,0 s');
  assert.equal(formatDuration(12_400), '12 s');
  assert.equal(formatDuration(59_600), '1 min');
  assert.equal(formatDuration(65_000), '1 min 05 s');
  assert.equal(formatDuration(3_600_000), '1 h');
  assert.equal(formatDuration(3_726_000), '1 h 02 min');
  assert.equal(formatDuration(-5), '0,0 s', 'un reloj hacia atrás no pinta negativos');
});

test('el reloj cuenta desde el arranque y no inventa el resto sin referencia', () => {
  const clock = new BatchClock(1_000);
  const progress = initialProgress('install', 3);

  const timing = clock.snapshot(progress, 3_400);

  assert.deepEqual(timing, { elapsedMs: 2_400, stepElapsedMs: null, remainingMs: null });
  assert.equal(
    timingLabel(timing, progress),
    '2,4 s transcurridos · calculando el tiempo restante…',
    'sin un plugin terminado no hay media con la que estimar',
  );
});

test('cronometra cada paso y estima el resto con los plugins ya resueltos', () => {
  const clock = new BatchClock(0);
  let progress = initialProgress('install', 4);

  progress = feed(
    clock,
    progress,
    { type: 'start', action: 'install', dryRun: false, total: 4, plugins: ['A', 'B', 'C', 'D'] },
    0,
  );
  progress = feed(clock, progress, running(0, 'A'), 100);
  progress = feed(clock, progress, step(0, 'A', 1), 600);
  assert.equal(
    clock.snapshot(progress, 1_000).stepElapsedMs,
    400,
    'el paso se mide desde que empieza, no desde el plugin',
  );

  // El paso siguiente estrena su propio cronómetro.
  progress = feed(clock, progress, step(0, 'A', 2), 900);
  assert.equal(clock.snapshot(progress, 1_000).stepElapsedMs, 100);

  progress = feed(clock, progress, installed(0, 'A'), 1_100);
  const afterFirst = clock.snapshot(progress, 1_100);
  assert.equal(afterFirst.stepElapsedMs, null, 'al cerrar el plugin no queda paso');
  assert.equal(afterFirst.elapsedMs, 1_100);
  assert.equal(afterFirst.remainingMs, 3_000, 'los tres plugins que aún no han empezado');

  progress = feed(clock, progress, running(1, 'B'), 1_200);
  const midway = clock.snapshot(progress, 1_500);
  assert.equal(midway.remainingMs, 2_700, 'lo que le queda a B y los dos que vienen detrás');
  assert.equal(timingLabel(midway, progress), '1,5 s transcurridos · ~2,7 s restantes');

  progress = feed(clock, progress, installed(1, 'B'), 2_000);
  assert.equal(clock.snapshot(progress, 2_000).remainingMs, 1_800, 'media de 0,9 s por plugin');

  progress = feed(
    clock,
    progress,
    {
      type: 'end',
      result: {
        action: 'install',
        dryRun: false,
        total: 4,
        succeeded: 4,
        failed: 0,
        results: [],
      },
    },
    2_100,
  );
  assert.equal(clock.snapshot(progress, 2_200).remainingMs, 0, 'terminado no falta nada');
});

test('el tiempo de un plugin fallido también cuenta para la estimación', () => {
  const clock = new BatchClock(0);
  let progress = initialProgress('install', 2);

  progress = feed(clock, progress, running(0, 'A', 2), 0);
  progress = feed(
    clock,
    progress,
    { type: 'plugin', index: 0, total: 2, name: 'A', status: 'failed', message: 'sin respaldo' },
    400,
  );

  assert.equal(
    clock.snapshot(progress, 400).remainingMs,
    400,
    'se esperó ese medio segundo, así que sirve de referencia',
  );
});

test('el start de otra petición no reinicia el reloj del lote', () => {
  const clock = new BatchClock(0);
  let progress = initialProgress('install', 2);

  progress = feed(
    clock,
    progress,
    { type: 'start', action: 'install', dryRun: false, total: 2, plugins: ['A', 'B'] },
    0,
  );
  progress = feed(clock, progress, running(0, 'A', 2), 100);
  progress = feed(clock, progress, installed(0, 'A', 2), 600);

  // El segundo trozo empieza con su propio `start`, pero el lote no se reinicia.
  clock.event(
    { type: 'start', action: 'install', dryRun: false, total: 1, plugins: ['B'] },
    800,
  );
  const timing = clock.snapshot(progress, 900);

  assert.equal(timing.elapsedMs, 900, 'el tiempo se cuenta desde el principio del lote');
  assert.equal(timing.remainingMs, 500, 'la media de A sigue valiendo para B');
});

test('summarize describe el lote completo y el parcial', () => {
  assert.equal(
    summarize({ action: 'install', total: 3, succeeded: 3, failed: 0 }),
    '3 plugin(s) instalado(s).',
  );
  assert.equal(
    summarize({ action: 'install', total: 3, succeeded: 2, failed: 1 }),
    '2 de 3 instalado(s); 1 con error.',
  );
  assert.equal(
    summarize({ action: 'uninstall', total: 3, succeeded: 1, failed: 2 }),
    '1 de 3 desinstalado(s); 2 con error.',
  );
  assert.equal(
    summarize({ action: 'install', total: 0, succeeded: 0, failed: 0 }),
    '0 plugin(s) instalado(s).',
  );
});

/* ------------------------------------------------------------------ */
/* Reanudar solo los plugins que quedaron sin confirmar                */
/* ------------------------------------------------------------------ */

test('resumablePlugins deja solo los que aún necesitan la acción', () => {
  const scanned = [
    { name: 'A', installed: true, compatible: true },
    { name: 'B', installed: false, compatible: true },
    { name: 'C', installed: false, compatible: false },
    { name: 'D', installed: false, compatible: null },
    { name: 'E', installed: true, compatible: true },
  ];
  const pending = ['A', 'B', 'C', 'D', 'E'];

  assert.deepEqual(
    resumablePlugins(pending, scanned, 'install'),
    ['B'],
    'instalar solo reanuda lo que no está instalado y es compatible',
  );
  assert.deepEqual(
    resumablePlugins(pending, scanned, 'uninstall'),
    ['A', 'E'],
    'desinstalar solo reanuda lo que sigue instalado',
  );
  assert.deepEqual(
    resumablePlugins(['Z'], scanned, 'install'),
    [],
    'un plugin que ya no está en el escaneo no se reanuda',
  );
  assert.deepEqual(resumablePlugins([], scanned, 'uninstall'), []);
});

test('resumeLabel nombra cuántos quedan sin confirmar', () => {
  assert.equal(resumeLabel(1), 'Reanudar 1 sin confirmar');
  assert.equal(resumeLabel(12), 'Reanudar 12 sin confirmar');
});

test('reanudar un lote cancelado solo envía los plugins sin confirmar', async () => {
  const controller = new AbortController();
  const names = ['Alpha', 'Beta', 'Gamma'];
  const requests: string[][] = [];

  const send: BatchSender = async (plugins, onEvent) => {
    requests.push([...plugins]);
    onEvent({
      type: 'start',
      action: 'install',
      dryRun: false,
      total: plugins.length,
      plugins: [...plugins],
    });
    onEvent({
      type: 'plugin',
      index: 0,
      total: plugins.length,
      name: plugins[0]!,
      status: 'running',
      message: null,
    });
    // Se corta antes de que Alpha avise su estado final.
    controller.abort();
    throw new Error('petición abortada');
  };

  const first = await runBatchInChunks({
    action: 'install',
    plugins: names,
    send,
    signal: controller.signal,
  });
  assert.deepEqual(first.pending, names, 'ninguno llegó a confirmarse');
  assert.equal(first.unreported, 3);

  // Reanudar arranca con una señal nueva, como hace la vista.
  const retry = fakeSender('install');
  const second = await runBatchInChunks({
    action: first.action,
    plugins: first.pending,
    send: retry.send,
  });

  assert.deepEqual(retry.requests, [names], 'solo los pendientes, en el mismo orden');
  assert.equal(second.succeeded, 3);
  assert.deepEqual(second.pending, [], 'después de reanudar no queda nada pendiente');
  assert.equal(second.unreported, 0);
});
