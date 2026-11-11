/**
 * Componente interactivo y accesible de potenciómetro rotatorio (Knob)
 * estilo sintetizador analógico / V-Machine.
 *
 * Web Standards puro (HTML + SVG + CSS), sin librerías externas.
 * Soporta arrastre vertical/circular, rueda de ratón, accesibilidad por teclado
 * (Flechas arriba/derecha/abajo/izquierda, Home, End, PageUp, PageDown)
 * con roles y atributos ARIA estándar (role="slider", aria-valuenow, aria-valuemin, aria-valuemax).
 */

export interface VfxKnobOptions {
  id?: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  label: string;
  unit?: string;
  bipolar?: boolean; // ej: Pan (-100% a +100% o centro en 128)
  onChange: (value: number) => void;
}

export function createKnob(options: VfxKnobOptions): HTMLElement {
  const {
    min = 0,
    max = 255,
    value: initialValue = 0,
    step = 1,
    label,
    unit = '',
    bipolar = false,
    onChange,
  } = options;

  let currentValue = Math.max(min, Math.min(max, initialValue));

  const container = document.createElement('div');
  container.className = 'vfx-knob-container';

  const labelEl = document.createElement('span');
  labelEl.className = 'vfx-knob-label';
  labelEl.textContent = label;
  container.append(labelEl);

  const dialWrap = document.createElement('div');
  dialWrap.className = 'vfx-knob-dial-wrap';
  dialWrap.setAttribute('role', 'slider');
  dialWrap.setAttribute('tabindex', '0');
  dialWrap.setAttribute('aria-label', label);
  dialWrap.setAttribute('aria-valuemin', String(min));
  dialWrap.setAttribute('aria-valuemax', String(max));
  dialWrap.setAttribute('aria-valuenow', String(currentValue));

  // SVG visual del knob (anillo de fondo, arco de valor y puntero)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 44 44');
  svg.setAttribute('class', 'vfx-knob-svg');

  // Círculo base
  const circleBg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circleBg.setAttribute('cx', '22');
  circleBg.setAttribute('cy', '22');
  circleBg.setAttribute('r', '17');
  circleBg.setAttribute('class', 'vfx-knob-circle-bg');
  svg.append(circleBg);

  // Línea indicadora (puntero rotatorio)
  const pointer = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  pointer.setAttribute('x1', '22');
  pointer.setAttribute('y1', '22');
  pointer.setAttribute('x2', '22');
  pointer.setAttribute('y2', '8');
  pointer.setAttribute('class', 'vfx-knob-pointer');
  svg.append(pointer);

  dialWrap.append(svg);
  container.append(dialWrap);

  const valueDisplay = document.createElement('span');
  valueDisplay.className = 'vfx-knob-value';
  container.append(valueDisplay);

  function formatDisplay(val: number): string {
    if (bipolar) {
      const mid = (min + max) / 2;
      const diff = val - mid;
      if (Math.abs(diff) < 2) return 'C';
      const pct = Math.round((diff / (max - mid)) * 100);
      return pct < 0 ? `L${Math.abs(pct)}` : `R${pct}`;
    }
    if (unit === '%') {
      return `${Math.round(((val - min) / (max - min)) * 100)}%`;
    }
    return `${Math.round(val)}${unit}`;
  }

  function updateVisuals(val: number): void {
    currentValue = Math.max(min, Math.min(max, val));
    dialWrap.setAttribute('aria-valuenow', String(currentValue));
    dialWrap.setAttribute('aria-valuetext', formatDisplay(currentValue));
    valueDisplay.textContent = formatDisplay(currentValue);

    // Rango de giro: de -140 deg a +140 deg (280 grados de recorrido)
    const norm = (currentValue - min) / (max - min);
    const angle = -140 + norm * 280;
    pointer.setAttribute('transform', `rotate(${angle} 22 22)`);
  }

  updateVisuals(currentValue);

  // Interacción de arrastre con ratón
  let startY = 0;
  let startVal = 0;

  function onPointerDown(e: MouseEvent): void {
    e.preventDefault();
    startY = e.clientY;
    startVal = currentValue;
    dialWrap.focus();

    function onPointerMove(moveEvent: MouseEvent): void {
      const dy = startY - moveEvent.clientY; // Arriba aumenta
      const range = max - min;
      const sensitivity = 150; // pixels para el recorrido completo
      const delta = (dy / sensitivity) * range;
      const rawVal = startVal + delta;
      const stepped = Math.round(rawVal / step) * step;
      updateVisuals(stepped);
      onChange(currentValue);
    }

    function onPointerUp(): void {
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', onPointerUp);
    }

    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
  }

  dialWrap.addEventListener('mousedown', onPointerDown);

  // Rueda de ratón
  dialWrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const delta = ((max - min) / 30) * dir;
    const rawVal = currentValue + delta;
    const stepped = Math.round(rawVal / step) * step;
    updateVisuals(stepped);
    onChange(currentValue);
  });

  // Soporte teclado accesible
  dialWrap.addEventListener('keydown', (e) => {
    let delta = 0;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') delta = step;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') delta = -step;
    else if (e.key === 'PageUp') delta = step * 10;
    else if (e.key === 'PageDown') delta = -step * 10;
    else if (e.key === 'Home') {
      updateVisuals(min);
      onChange(currentValue);
      e.preventDefault();
      return;
    } else if (e.key === 'End') {
      updateVisuals(max);
      onChange(currentValue);
      e.preventDefault();
      return;
    }

    if (delta !== 0) {
      e.preventDefault();
      updateVisuals(currentValue + delta);
      onChange(currentValue);
    }
  });

  return container;
}
