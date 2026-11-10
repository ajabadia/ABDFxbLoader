import { t } from '../../../i18n/index.js';
import { els } from '../../elements.js';

export function captureLog(message: string, kind: 'info' | 'ok' | 'error' | 'busy' = 'info'): void {
  const entry = document.createElement('div');
  entry.className = `capture-log-entry ${kind}`;
  const time = document.createElement('span');
  time.className = 'capture-log-time';
  time.textContent = new Date().toLocaleTimeString();
  const text = document.createElement('span');
  text.textContent = message;
  entry.append(time, text);
  if (els.captureLogState) {
    els.captureLogState.textContent = kind === 'busy' ? t('ui.capture.logInProgress') : kind === 'error' ? t('ui.capture.logNeedsAttention') : kind === 'ok' ? 'Actualizado' : 'Actividad';
    els.captureLogState.className = `capture-log-state ${kind}`;
  }
  if (els.captureLog) {
    els.captureLog.prepend(entry);
    // El registro es una consola viva: conservar más contexto en escaneos largos.
    while (els.captureLog.children.length > 120) {
      els.captureLog.removeChild(els.captureLog.lastChild!);
    }
  }
}

export function setCaptureStatus(message: string, kind = 'info'): void {
  if (els.captureStatus) {
    els.captureStatus.textContent = message;
    els.captureStatus.className = `status ${kind}`;
  }
}
