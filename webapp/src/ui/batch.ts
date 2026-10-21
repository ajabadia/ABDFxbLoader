/**
 * Presentación del lote para la vista.
 *
 * La orquestación de cada petición vive en el servidor (`POST /library/batch`):
 * él decide el orden, sigue con el resto si un plugin falla y devuelve el
 * resultado de cada uno. Con `POST /library/batch/stream` además va informando
 * del progreso mientras trabaja, y aquí se traduce ese flujo (`start`, `plugin`,
 * `step`, `end`) en el estado que pinta la vista: qué plugin está en curso, qué
 * paso interno está ejecutando y cuántos quedan.
 *
 * Una librería puede tener más plugins que el tope de una petición, así que el
 * lote se trocea (`splitBatch`) y se envía en peticiones consecutivas: el
 * progreso de todas se suma en un solo estado (`mergeProgress`) para que la
 * vista tenga una única barra y una única cuenta, no una por petición.
 *
 * No toca el DOM ni conoce `fetch` (la petición la inyecta la vista), así que
 * se prueba con datos simples y un emisor de mentira.
 */
import { MAX_PLUGINS_PER_BATCH } from '../client/batch-stream.js';
import type {
  BatchStreamEvent,
  BatchStreamPluginResult,
  BatchStreamResult,
  BatchStreamStepKind,
} from '../client/batch-stream.js';

export type BatchAction = 'install' | 'uninstall';

/** Lo mínimo que la vista necesita de un plugin para poder informar de él. */
export interface BatchPlugin {
  name: string;
}

export interface BatchFailure<P extends BatchPlugin = BatchPlugin> {
  plugin: P;
  action: BatchAction;
  message: string;
}

export interface BatchResult<P extends BatchPlugin = BatchPlugin> {
  action: BatchAction;
  total: number;
  succeeded: number;
  failures: BatchFailure<P>[];
}

/** Forma de un resultado por plugin de `POST /library/batch`. */
export interface BatchPluginOutcome {
  name: string;
  status: 'installed' | 'uninstalled' | 'planned' | 'failed';
  message: string | null;
}

/** Forma de la respuesta de `POST /library/batch` que consume la vista. */
export interface BatchResponse {
  action: BatchAction;
  total: number;
  succeeded: number;
  failed: number;
  results: BatchPluginOutcome[];
}

/**
 * Los plugins con `status: "failed"`, conservando el orden del lote. Cada fallo
 * lleva su acción, que es lo que la vista necesita para reintentarlo con los
 * endpoints individuales.
 */
export function failuresOf(response: BatchResponse): BatchFailure[] {
  return response.results
    .filter((result) => result.status === 'failed')
    .map((result) => ({
      plugin: { name: result.name },
      action: response.action,
      message: result.message ?? 'Error desconocido',
    }));
}

/** Estado del progreso en caliente que pinta la vista. */
export interface BatchProgress {
  action: BatchAction;
  total: number;
  /** Plugin que el servidor está procesando, o `null` entre plugins. */
  current: string | null;
  /** Posición 0-based del plugin en curso. */
  index: number;
  /** Plugins ya resueltos, con su estado final. */
  done: number;
  failed: number;
  /** `true` cuando llegó `end`: el lote terminó. */
  finished: boolean;
  /** Paso interno en curso, o `null` entre plugins. */
  step: BatchStreamStepKind | null;
  /** Posición 0-based del paso en curso. */
  stepIndex: number;
  /** Pasos que hará el plugin en curso; 0 mientras no se sepa. */
  steps: number;
}

/** Estado inicial, antes del primer evento del servidor. */
export function initialProgress(action: BatchAction, total: number): BatchProgress {
  return {
    action,
    total,
    current: null,
    index: 0,
    done: 0,
    failed: 0,
    finished: false,
    step: null,
    stepIndex: 0,
    steps: 0,
  };
}

/**
 * Trocea el lote en peticiones que el servidor acepta. `POST /library/batch` y
 * su variante con progreso rechazan el lote entero por encima de
 * `MAX_PLUGINS_PER_BATCH`, así que una librería mayor se manda en varios lotes
 * consecutivos en vez de recibir un 400 y no instalar nada. Conserva el orden y
 * nunca devuelve un trozo vacío.
 */
export function splitBatch<P>(
  plugins: readonly P[],
  size: number = MAX_PLUGINS_PER_BATCH,
): P[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`tamaño de lote no válido: ${String(size)}`);
  }

  const batches: P[][] = [];
  for (let start = 0; start < plugins.length; start += size) {
    batches.push(plugins.slice(start, start + size));
  }
  return batches;
}

/** Lo ya resuelto por las peticiones anteriores, para sumarlo a la actual. */
export interface BatchTotals {
  action: BatchAction;
  /** Plugins del lote completo, no los de la petición en curso. */
  total: number;
  /** Plugins terminados en las peticiones ya cerradas. */
  done: number;
  /** Fallos que dejaron esas peticiones. */
  failed: number;
}

/**
 * Progreso de todo el lote a partir del de la petición en curso: los contadores
 * de las anteriores se suman y el índice del plugin avanza como si todo fuera
 * una sola petición, que es lo que permite pintar una única barra.
 */
export function mergeProgress(totals: BatchTotals, chunk: BatchProgress): BatchProgress {
  const done = totals.done + chunk.done;
  return {
    action: totals.action,
    total: totals.total,
    current: chunk.current,
    index: totals.done + chunk.index,
    done,
    failed: totals.failed + chunk.failed,
    finished: chunk.finished && done === totals.total,
    step: chunk.step,
    stepIndex: chunk.stepIndex,
    steps: chunk.steps,
  };
}

/**
 * Aplica un evento del stream al estado. Es una función pura: se puede probar
 * el flujo completo sin red y sin DOM.
 */
export function applyBatchEvent(
  state: BatchProgress,
  event: BatchStreamEvent,
): BatchProgress {
  if (event.type === 'start') {
    return { ...initialProgress(event.action, event.total) };
  }
  if (event.type === 'end') {
    return {
      ...state,
      current: null,
      done: event.result.total,
      failed: event.result.failed,
      finished: true,
      step: null,
    };
  }
  if (event.type === 'step') {
    return {
      ...state,
      current: event.name,
      index: event.index,
      step: event.step,
      stepIndex: event.stepIndex,
      steps: event.steps,
    };
  }
  // `running` abre el plugin y su estado final lo cierra: los dos pasos
  // internos de antes ya no describen lo que ocurre ahora.
  if (event.status === 'running') {
    return { ...state, current: event.name, index: event.index, step: null, stepIndex: 0, steps: 0 };
  }
  return {
    ...state,
    current: null,
    done: state.done + 1,
    failed: state.failed + (event.status === 'failed' ? 1 : 0),
    step: null,
  };
}

/** Nombre en gerundio de cada paso interno, para la línea de detalle. */
const STEP_LABELS: Record<BatchStreamStepKind, string> = {
  backup: 'respaldando vfxinfo.txt',
  copy: 'copiando fxbLoader.dll',
  patch: 'parcheando dll_name',
  'write-config': 'escribiendo fxbLoader.config',
  'create-dir': 'creando la carpeta de presets',
  restore: 'restaurando vfxinfo.txt',
  delete: 'borrando fxbLoader.config',
};

/**
 * Línea del paso interno en curso («paso 2 de 5 · copiando fxbLoader.dll»), o
 * `null` si el plugin aún no ha empezado ninguno.
 */
export function stepLabel(progress: BatchProgress): string | null {
  if (progress.step === null) return null;
  return `paso ${progress.stepIndex + 1} de ${progress.steps} · ${STEP_LABELS[progress.step]}`;
}

/** Texto del progreso: qué plugin va y cuántos quedan, con los fallos a la vista. */
export function progressLabel(state: BatchProgress): string {
  const doing = state.action === 'install' ? 'Instalando' : 'Desinstalando';
  const done = state.action === 'install' ? 'instalado' : 'desinstalado';
  const errors = state.failed === 0 ? '' : ` · ${state.failed} con error`;
  if (state.finished) return `${state.done} de ${state.total} ${done}(s)${errors}.`;

  // Entre plugins, `done` es el que viene; mientras corre uno, manda su índice.
  const position = state.current === null ? state.done : state.index;
  const count = `${position + 1} de ${state.total}`;
  return state.current === null
    ? `${doing} ${count}…${errors}`
    : `${doing} ${count}: ${state.current}…${errors}`;
}

/** Resumen del lote a partir de sus contadores. */
export function summarize(result: {
  action: BatchAction;
  total: number;
  succeeded: number;
  failed: number;
}): string {
  const verb = result.action === 'install' ? 'instalado' : 'desinstalado';
  if (result.failed === 0) return `${result.succeeded} plugin(s) ${verb}(s).`;
  return `${result.succeeded} de ${result.total} ${verb}(s); ${result.failed} con error.`;
}

/** Envía una petición de lote; la vista le pasa el cliente HTTP. */
export type BatchSender = (
  plugins: string[],
  onEvent: (event: BatchStreamEvent) => void,
) => Promise<BatchStreamResult>;

export interface BatchRunOptions {
  action: BatchAction;
  /** Plugins del lote completo, en el orden en que hay que operarlos. */
  plugins: string[];
  send: BatchSender;
  /** Progreso acumulado tras cada evento; la vista pinta la barra con él. */
  onProgress?: (progress: BatchProgress) => void;
  /** Estado de cada plugin (en curso, terminado o fallido), para marcarlo. */
  onPlugin?: (event: Extract<BatchStreamEvent, { type: 'plugin' }>) => void;
}

/** Resultado del lote completo, sumando todas las peticiones enviadas. */
export interface BatchRun {
  action: BatchAction;
  /** Plugins del lote completo. */
  total: number;
  succeeded: number;
  failed: number;
  /** Resultado de cada plugin, en el orden del lote. */
  results: BatchStreamPluginResult[];
  /** Peticiones enviadas al servidor. */
  requests: number;
  /** Plugins cuyo resultado no llegó porque una petición se cortó. */
  unreported: number;
  /** Error que cortó el lote, o `null` si terminó entero. */
  error: unknown;
}

/**
 * Recorre el lote en peticiones dentro del tope del servidor y suma el progreso
 * de todas en un solo estado. Si una petición falla (400, error de red, `end`
 * ausente) se corta ahí: lo que sí respondió se conserva en el resultado y
 * `unreported` dice cuántos plugins quedaron sin confirmar.
 */
export async function runBatchInChunks(options: BatchRunOptions): Promise<BatchRun> {
  const batches = splitBatch(options.plugins);
  const results: BatchStreamPluginResult[] = [];
  let totals: BatchTotals = {
    action: options.action,
    total: options.plugins.length,
    done: 0,
    failed: 0,
  };
  let requests = 0;
  let error: unknown = null;

  options.onProgress?.(initialProgress(totals.action, totals.total));

  for (const plugins of batches) {
    let chunk = initialProgress(totals.action, plugins.length);
    options.onProgress?.(mergeProgress(totals, chunk));
    requests += 1;

    try {
      const response = await options.send(plugins, (event) => {
        if (event.type === 'plugin') options.onPlugin?.(event);
        chunk = applyBatchEvent(chunk, event);
        options.onProgress?.(mergeProgress(totals, chunk));
      });
      results.push(...response.results);
      totals = {
        ...totals,
        done: totals.done + plugins.length,
        failed: totals.failed + response.failed,
      };
    } catch (caught) {
      error = caught;
      break;
    }
  }

  const succeeded = results.filter((result) => result.status !== 'failed').length;
  return {
    action: totals.action,
    total: totals.total,
    succeeded,
    failed: results.length - succeeded,
    results,
    requests,
    unreported: totals.total - results.length,
    error,
  };
}
