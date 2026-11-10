import { stepLabel, timingLabel, BatchClock, type BatchProgress } from '../../../batch.js';
import { els } from '../../elements.js';

export let batchClock: BatchClock | null = null;
export let batchProgress: BatchProgress | null = null;
let batchTicker: ReturnType<typeof setInterval> | null = null;

/** Último progreso pintado: el reloj lo necesita para estimar entre eventos. */
export function setBatchProgress(progress: BatchProgress): void {
  batchProgress = progress;
}

export function setButtonLabel(button: HTMLButtonElement, text: string): void {
  const label = button.querySelector<HTMLElement>('.label');
  if (label === null) {
    button.textContent = text;
    return;
  }
  label.textContent = text;
}

/** Oculta la barra de progreso del lote, su reloj y el paso en curso. */
export function hideBatchProgress(): void {
  els.batchProgress.hidden = true;
  els.batchProgress.value = 0;
  els.batchProgress.max = 1;
  els.batchStep.hidden = true;
  els.batchStep.textContent = '';
  stopBatchClock();
  els.batchClock.hidden = true;
  els.batchClock.textContent = '';
}

/** Barra, texto, paso interno y reloj del progreso en caliente. */
export function showBatchProgress(
  progress: BatchProgress,
  setStatusFn?: (message: string, kind?: string) => void,
  progressLabelFn?: (p: BatchProgress) => string,
): void {
  els.batchProgress.hidden = false;
  els.batchProgress.max = Math.max(progress.total, 1);
  els.batchProgress.value = progress.done;

  const step = stepLabel(progress);
  els.batchStep.hidden = step === null;
  els.batchStep.textContent = step ?? '';

  batchProgress = progress;
  els.batchClock.hidden = false;
  renderBatchClock();

  if (!progress.finished && setStatusFn && progressLabelFn) {
    setStatusFn(progressLabelFn(progress), 'busy');
  }
}

/** Arranca el reloj del lote y su refresco. */
export function startBatchClock(): BatchClock {
  stopBatchClock();
  const clock = new BatchClock();
  batchClock = clock;
  batchProgress = null;
  els.batchClock.hidden = false;
  els.batchClock.textContent = '';
  batchTicker = setInterval(renderBatchClock, 250);
  return clock;
}

export function stopBatchClock(): void {
  if (batchTicker !== null) {
    clearInterval(batchTicker);
    batchTicker = null;
  }
  batchClock = null;
  batchProgress = null;
}

/** Tiempo transcurrido, estimación de lo que falta y tiempo del paso actual. */
export function renderBatchClock(): void {
  if (batchClock === null || batchProgress === null) return;
  els.batchClock.textContent = timingLabel(batchClock.snapshot(batchProgress), batchProgress);
}
