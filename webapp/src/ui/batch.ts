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
  /**
   * Detalle de la línea de paso cuando no lo manda el stream, como en los
   * reintentos individuales: `paso 2 de 3 · reintentando Rhodes`. Si falta, la
   * vista usa el paso interno del servidor.
   */
  stepText?: string | null;
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
  if (progress.stepText) return progress.stepText;
  if (progress.step === null) return null;
  return `paso ${progress.stepIndex + 1} de ${progress.steps} · ${STEP_LABELS[progress.step]}`;
}

/**
 * Progreso de un reintento individual dentro de «Reintentar fallidos». Usa la
 * misma barra, el mismo paso y el mismo reloj que el lote normal, pero cada
 * plugin es un lote de un solo elemento: el endpoint individual no informa de
 * sus pasos internos, así que el paso se inventa con el nombre del plugin.
 *
 * `failed` es el número de fallos del lote completo antes de que empieces este
 * reintento, que es lo que permite contar «2 de 3 fallidos» mientras se reintenta
 * el tercero.
 */
export function retryProgress(
  failure: BatchFailure,
  index: number,
  total: number,
  failed: number,
): BatchProgress {
  return {
    action: failure.action,
    total,
    current: failure.plugin.name,
    index,
    done: index,
    failed,
    finished: false,
    step: null,
    stepIndex: index,
    steps: total,
    stepText: `paso ${index + 1} de ${total} · reintentando ${failure.plugin.name}`,
  };
}

/** Texto del progreso: qué plugin va y cuántos quedan, con los fallos a la vista. */
export function progressLabel(state: BatchProgress): string {
  const doing = state.action === 'install' ? 'Instalando' : 'Desinstalando';
  const done = state.action === 'install' ? 'instalado' : 'desinstalado';
  const errors = state.failed === 0 ? '' : ` · ${state.failed} con error`;
  if (state.finished) return `${state.done} de ${state.total} ${done}(s)${errors}.`;

  // Entre plugins, `done` es el que viene; mientras corre uno, manda su índice.
  // Al cerrar el último del trozo ambos llegan al total, y sumar uno daría
  // «251 de 250»: se limita al último plugin que existe.
  const position = Math.min(
    state.current === null ? state.done : state.index,
    Math.max(state.total - 1, 0),
  );
  const count = `${position + 1} de ${state.total}`;
  return state.current === null
    ? `${doing} ${count}…${errors}`
    : `${doing} ${count}: ${state.current}…${errors}`;
}

/** Lo que la vista pinta del reloj del lote. */
export interface BatchTiming {
  /** Tiempo desde que arrancó el lote. */
  elapsedMs: number;
  /** Tiempo del paso interno en curso, o `null` si no hay ninguno. */
  stepElapsedMs: number | null;
  /** Estimación de lo que falta, o `null` mientras no haya referencia. */
  remainingMs: number | null;
}

/**
 * Cronómetro del lote. Mide en la vista, con el reloj de pared, porque lo que
 * interesa es la espera real de la persona: incluye la red y el salto entre
 * peticiones cuando el lote se trocea. Por eso vive aparte de `BatchProgress`:
 * así el `start` de cada trozo no reinicia el tiempo y se puede refrescar entre
 * evento y evento para que los segundos corran aunque el servidor calle.
 *
 * La estimación promedia los plugins ya resueltos —fallen o no, porque su
 * tiempo también se esperó— y descuenta lo que lleva el plugin en curso, de modo
 * que el número baja de forma continua en vez de saltar solo al cerrar cada
 * uno. Sin ningún plugin terminado no hay referencia: `remainingMs` es `null`
 * y la vista dice que está calculando, en vez de inventarse un número.
 */
export class BatchClock {
  private readonly startedAt: number;
  private pluginStartedAt: number | null = null;
  private stepStartedAt: number | null = null;
  private readonly durations: number[] = [];

  constructor(now: number = Date.now()) {
    this.startedAt = now;
  }

  /** Tiempo desde el inicio del lote. */
  elapsed(now: number = Date.now()): number {
    return Math.max(0, now - this.startedAt);
  }

  /**
   * Reinicia el cronómetro del paso en curso sin un evento del servidor. Lo usa
   * «Reintentar fallidos», que llama a los endpoints individuales y no recibe
   * el stream de pasos del lote.
   */
  startStep(now: number = Date.now()): void {
    this.stepStartedAt = now;
  }

  /**
   * Aplica un evento del stream al cronómetro: `running` abre el plugin, cada
   * `step` reinicia el paso en curso y el estado final del plugin lo cierra y
   * guarda su duración. `start` y `end` no tocan el reloj: el primero repetiría
   * el reinicio en cada trozo y el segundo llega cuando ya está todo medido.
   */
  event(event: BatchStreamEvent, now: number = Date.now()): void {
    if (event.type === 'step') {
      this.startStep(now);
      return;
    }
    if (event.type !== 'plugin') return;

    if (event.status === 'running') {
      this.pluginStartedAt = now;
      this.stepStartedAt = null;
      return;
    }

    if (this.pluginStartedAt !== null) {
      this.durations.push(Math.max(0, now - this.pluginStartedAt));
    }
    this.pluginStartedAt = null;
    this.stepStartedAt = null;
  }

  /** Foto del reloj para pintarla ahora mismo. */
  snapshot(progress: BatchProgress, now: number = Date.now()): BatchTiming {
    return {
      elapsedMs: this.elapsed(now),
      stepElapsedMs:
        stepLabel(progress) === null || this.stepStartedAt === null
          ? null
          : Math.max(0, now - this.stepStartedAt),
      remainingMs: this.remaining(progress, now),
    };
  }

  private remaining(progress: BatchProgress, now: number): number | null {
    if (progress.finished) return 0;
    const pending = progress.total - progress.done;
    if (pending <= 0) return 0;
    if (this.durations.length === 0) return null;

    const average =
      this.durations.reduce((sum, duration) => sum + duration, 0) / this.durations.length;

    // Entre plugins, `pending` son todos los que faltan y ninguno ha empezado.
    if (this.pluginStartedAt === null) return pending * average;

    // Con uno en curso, `pending` lo incluye: se suma lo que le resta a él y la
    // media entera a cada uno de los que aún no han empezado.
    const currentElapsed = Math.max(0, now - this.pluginStartedAt);
    return Math.max(0, (pending - 1) * average + Math.max(0, average - currentElapsed));
  }
}

/** Duración legible: «0,4 s», «12 s», «1 min 05 s», «1 h 02 min». */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (total < 10_000) {
    return `${(Math.round(total / 100) / 10).toFixed(1).replace('.', ',')} s`;
  }

  const seconds = Math.round(total / 1000);
  if (seconds < 60) return `${seconds} s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${String(rest).padStart(2, '0')} s`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')} min`;
}

/**
 * Línea del reloj: «12,4 s transcurridos · ~18 s restantes · 0,3 s en el paso
 * actual». El tiempo de cada paso interno se reinicia con el paso, que es lo
 * que permite ver cuánto tarda la copia del DLL o el parcheo por separado.
 *
 * Cuando solo falta un plugin, la cuenta de fallos actualizada (`progress.failed`)
 * dice cuántos quedan detrás del que va, así que el reloj las lee en vez de la
 * cuenta vieja del lote: así un reintento individual muestra «X fallo(s) detrás
 * del actual» y cada pulsación de «Reintentar» lo recalcula sin tocar el CSS.
 *
 * Un reintento individual también gira la barra, el paso y el reloj del lote:
 * la vista no tiene dos modos de progreso, solo uno que en «Reintentar fallidos»
 * se reubica en el plugin que se reintenta. El paso se inventa porque el endpoint
 * individual no informa de sus pasos, y el reloj puede continuar desde donde lo
 * dejó el lote anterior si el reintento arranca con `resumeClock`.
 */
export function timingLabel(timing: BatchTiming, progress: BatchProgress): string {
  const elapsed = `${formatDuration(timing.elapsedMs)} transcurridos`;
  const rest =
    timing.remainingMs === null
      ? 'calculando el tiempo restante…'
      : `~${formatDuration(timing.remainingMs)} restantes`;
  const behind = progress.failed > 0 ? ` · ${progress.failed} fallo(s) detrás del actual` : '';
  const step =
    timing.stepElapsedMs === null || stepLabel(progress) === null
      ? ''
      : ` · ${formatDuration(timing.stepElapsedMs)} en el paso actual`;
  return `${elapsed} · ${rest}${behind}${step}`;
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
  /** Cancela el lote: corta la petición actual y no envía la siguiente. */
  signal?: AbortSignal;
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
  /**
   * Nombres de los plugins sin confirmar, en el orden del lote: el que estaba
   * en curso al cortarse la petición y los que ya no llegaron a enviarse. Son
   * los que la vista puede reanudar sin repetir lo que sí quedó confirmado.
   */
  pending: string[];
  /** Plugins cuyo resultado no llegó porque una petición se cortó. */
  unreported: number;
  /** Error que cortó el lote, o `null` si terminó entero o se canceló. */
  error: unknown;
  /** `true` si lo cortó la señal de cancelación, no un fallo. */
  cancelled: boolean;
}

/**
 * Recorre el lote en peticiones dentro del tope del servidor y suma el progreso
 * de todas en un solo estado. Si una petición falla (400, error de red, `end`
 * ausente) se corta ahí: lo que sí respondió se conserva en el resultado y
 * `unreported` dice cuántos plugins quedaron sin confirmar.
 *
 * Con `signal` la parada es una cancelación, no un fallo: se corta la petición
 * en curso (el `fetch` aborta) y no se envía la siguiente. Los plugins que ya
 * habían avisado su estado final por el stream se conservan aunque la respuesta
 * no llegue a completarse, que es lo que permite resumir lo confirmado.
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
  let cancelled = false;
  // Se consulta a través de una función: el narrowing de TypeScript no alcanza
  // a ver que la señal puede abortarse mientras se espera la respuesta.
  const signal = options.signal;
  const aborted = (): boolean => signal?.aborted === true;

  options.onProgress?.(initialProgress(totals.action, totals.total));

  for (const plugins of batches) {
    if (aborted()) {
      cancelled = true;
      break;
    }

    let chunk = initialProgress(totals.action, plugins.length);
    options.onProgress?.(mergeProgress(totals, chunk));
    requests += 1;

    // Estado final de cada plugin según los eventos ya recibidos. Si la
    // petición se corta a mitad, la respuesta completa no llega, pero estos
    // sí son resultados reales: el servidor ya los había confirmado.
    const confirmed: BatchStreamPluginResult[] = [];

    try {
      const response = await options.send(plugins, (event) => {
        if (event.type === 'plugin') {
          options.onPlugin?.(event);
          if (event.status !== 'running') {
            confirmed.push({ name: event.name, status: event.status, message: event.message });
          }
        }
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
      results.push(...confirmed);
      cancelled = aborted();
      if (!cancelled) error = caught;
      break;
    }
  }

  const succeeded = results.filter((result) => result.status !== 'failed').length;
  // El nombre, no solo la cuenta: reanudar necesita saber cuáles quedaron a
  // medias, y el orden del lote se conserva para repetir la misma secuencia.
  const reported = new Set(results.map((result) => result.name));
  const pending = options.plugins.filter((name) => !reported.has(name));
  return {
    action: totals.action,
    total: totals.total,
    succeeded,
    failed: results.length - succeeded,
    results,
    requests,
    pending,
    unreported: pending.length,
    error,
    cancelled,
  };
}

/** Un plugin del último escaneo: lo justo para decidir si sigue pendiente. */
export interface ScannedPlugin {
  name: string;
  installed: boolean;
  compatible: boolean | null;
}

/**
 * De los plugins sin confirmar, los que todavía necesitan la acción. Al
 * cancelar, el servidor termina el plugin que tenía entre manos, así que puede
 * haber quedado hecho en disco: reinstalarlo daría un 409 y desinstalarlo, un
 * 409 por no estar instalado. El escaneo posterior a la cancelación dice cuáles
 * ya están en el estado buscado, y esos se descartan; los que desaparecieron de
 * la librería tampoco se reanudan. Conserva el orden del lote.
 */
export function resumablePlugins(
  pending: readonly string[],
  plugins: readonly ScannedPlugin[],
  action: BatchAction,
): string[] {
  const state = new Map(plugins.map((plugin) => [plugin.name, plugin]));
  return pending.filter((name) => {
    const plugin = state.get(name);
    if (plugin === undefined) return false;
    return action === 'install'
      ? !plugin.installed && plugin.compatible === true
      : plugin.installed;
  });
}

/** Texto del botón que reanuda solo lo que quedó sin confirmar. */
export function resumeLabel(count: number): string {
  return `Reanudar ${count} sin confirmar`;
}

/**
 * Resumen de un lote cancelado: lo que el servidor confirmó por el stream y
 * cuántos plugins quedaron sin respuesta (el que estaba en curso y los que ya
 * no se enviaron).
 */
export function cancelledSummary(
  run: Pick<BatchRun, 'action' | 'total' | 'succeeded' | 'failed' | 'unreported'>,
): string {
  const verb = run.action === 'install' ? 'instalado' : 'desinstalado';
  const errors = run.failed === 0 ? '' : ` y ${run.failed} con error`;
  const pending = run.unreported === 0 ? '' : `; ${run.unreported} sin confirmar`;
  return `Lote cancelado: ${run.succeeded} de ${run.total} ${verb}(s)${errors}${pending}.`;
}
