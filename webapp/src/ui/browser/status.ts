/**
 * Estado de la aplicación bajo la barra: mensaje, tono y acción opcional.
 *
 * El último estado se guarda para repintarlo cuando cambia el idioma sin que
 * cada vista tenga que repetir su texto.
 */
import { els } from './elements.js';
import { createIcon } from './icons.js';

export interface StatusAction {
  label: string;
  icon?: string;
  title?: string;
  onClick: () => void;
}

export function renderStatusWithAction(
  container: HTMLElement,
  message: string,
  kind = 'info',
  action?: StatusAction,
): void {
  container.replaceChildren();
  if (!message) {
    container.className = 'status';
    return;
  }
  container.className = kind ? `status ${kind}` : 'status';
  const span = document.createElement('span');
  span.textContent = message;
  container.appendChild(span);

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'status-action-btn';
    if (action.title) btn.title = action.title;
    if (action.icon) {
      btn.appendChild(createIcon(action.icon));
    }
    const labelSpan = document.createElement('span');
    labelSpan.textContent = action.label;
    btn.appendChild(labelSpan);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      action.onClick();
    });
    container.appendChild(btn);
  }
}

/** Ultimo estado pintado: al cambiar de idioma se vuelve a componer su texto. */
let lastStatus: { message: () => string; kind: string; action?: () => StatusAction | undefined } | null =
  null;

export function setStatus(
  message: string | (() => string),
  kind = 'info',
  action?: StatusAction | (() => StatusAction | undefined),
): void {
  const resolveAction = typeof action === 'function' ? action : () => action;
  lastStatus = {
    message: typeof message === 'function' ? message : () => message,
    kind,
    action: resolveAction,
  };
  renderStatusWithAction(els.status, lastStatus.message(), kind, resolveAction());
}

export function repaintStatus(): void {
  if (lastStatus === null) return;
  renderStatusWithAction(els.status, lastStatus.message(), lastStatus.kind, lastStatus.action?.());
}