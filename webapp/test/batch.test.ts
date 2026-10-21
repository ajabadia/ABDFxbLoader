import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyBatchEvent,
  failuresOf,
  initialProgress,
  mergeProgress,
  progressLabel,
  runBatchInChunks,
  splitBatch,
  stepLabel,
  summarize,
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

  const failures = failuresOf(run);
  assert.deepEqual(
    failures.map((failure) => failure.plugin.name),
    ['P1', 'P3'],
    'los fallos de las peticiones ya cerradas no se pierden',
  );
  assert.equal(summarize(run), `${MAX_PLUGINS_PER_BATCH - 2} de ${names.length} instalado(s); 2 con error.`);
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
