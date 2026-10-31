import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appEn } from '../src/ui/i18n/locales/en';
import { appEs } from '../src/ui/i18n/locales/es';

class MockElement {
  children: MockElement[] = [];
  attributes: Record<string, string> = {};
  className = '';
  textContent = '';
  type = '';
  title = '';
  listeners: Record<string, Array<(e: { preventDefault: () => void }) => void>> = {};

  appendChild(item: MockElement) {
    this.children.push(item);
    return item;
  }

  replaceChildren(...items: MockElement[]) {
    this.children = items;
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  addEventListener(type: string, listener: (e: { preventDefault: () => void }) => void) {
    (this.listeners[type] ??= []).push(listener);
  }

  click() {
    for (const listener of this.listeners.click ?? []) {
      listener({ preventDefault() {} });
    }
  }

  querySelector(selector: string): MockElement | null {
    if (selector === '.status-action-btn') {
      return this.children.find((c) => c.className === 'status-action-btn') ?? null;
    }
    return null;
  }
}

const mockDoc = {
  createElement(tag: string) {
    const el = new MockElement();
    el.setAttribute('tag', tag);
    return el;
  },
  createElementNS(_ns: string, tag: string) {
    const el = new MockElement();
    el.setAttribute('tag', tag);
    return el;
  },
};

interface StatusAction {
  label: string;
  icon?: string;
  title?: string;
  onClick: () => void;
}

function renderStatusWithAction(
  container: MockElement,
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
  const span = mockDoc.createElement('span');
  span.textContent = message;
  container.appendChild(span);

  if (action) {
    const btn = mockDoc.createElement('button');
    btn.type = 'button';
    btn.className = 'status-action-btn';
    if (action.title) btn.title = action.title;
    if (action.icon) {
      const svg = mockDoc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'icon');
      btn.appendChild(svg);
    }
    const labelSpan = mockDoc.createElement('span');
    labelSpan.textContent = action.label;
    btn.appendChild(labelSpan);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      action.onClick();
    });
    container.appendChild(btn);
  }
}

test('diccionarios i18n contienen las claves de acción hacia Ajustes y rutas', () => {
  assert.equal(appEs.ui.app.openSettings, 'Configurar en Ajustes');
  assert.equal(appEn.ui.app.openSettings, 'Configure in Settings');
  assert.equal(typeof appEs.ui.app.openSettingsTitle, 'string');
  assert.equal(typeof appEn.ui.app.openSettingsTitle, 'string');
  assert.equal(typeof appEs.ui.app.focusField, 'string');
  assert.equal(typeof appEn.ui.app.focusField, 'string');
  assert.equal(typeof appEs.ui.app.connectedLocalAgent, 'string');
  assert.equal(typeof appEn.ui.app.connectedLocalAgent, 'string');
});

test('renderStatusWithAction pinta el mensaje y el botón de acción interactivo', () => {
  const container = new MockElement();
  let clicked = false;

  renderStatusWithAction(container, 'Elige la carpeta de la librería VFX para empezar.', 'info', {
    label: 'Configurar en Ajustes',
    icon: 'settings',
    title: 'Abrir Ajustes',
    onClick: () => {
      clicked = true;
    },
  });

  assert.equal(container.className, 'status info');
  assert.equal(container.children.length, 2);

  // El primer hijo es el span con el texto
  assert.equal(container.children[0]?.textContent, 'Elige la carpeta de la librería VFX para empezar.');

  // El segundo hijo es el botón de acción
  const btn = container.children[1];
  assert.ok(btn);
  assert.equal(btn.className, 'status-action-btn');
  assert.equal(btn.title, 'Abrir Ajustes');

  // Al hacer clic, ejecuta la acción
  assert.equal(clicked, false);
  btn.click();
  assert.equal(clicked, true);
});

test('renderStatusWithAction sin acción solo pinta el texto y no añade botones', () => {
  const container = new MockElement();
  renderStatusWithAction(container, '3 plugins encontrados.', 'ok');

  assert.equal(container.className, 'status ok');
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0]?.textContent, '3 plugins encontrados.');
  assert.equal(container.querySelector('.status-action-btn'), null);
});

test('renderStatusWithAction con mensaje vacío vacía el contenedor', () => {
  const container = new MockElement();
  renderStatusWithAction(container, '');

  assert.equal(container.className, 'status');
  assert.equal(container.children.length, 0);
});
