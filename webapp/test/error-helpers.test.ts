import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FxbApiError } from '../src/ui/browser/api.js';
import { errorDiagnostics, formatErrorDiagnostics, copyErrorDiagnostics } from '../src/ui/browser/error-helpers.js';

test('errorDiagnostics extrae código y issues de un FxbApiError', () => {
  const error = new FxbApiError(400, { code: 'plugin.alreadyInstalled', message: 'El plugin ya está instalado', issues: ['issue one', 'issue two'] }, 'El plugin ya está instalado');
  const d = errorDiagnostics(error, { route: '/library/batch' });
  assert.equal(d.status, 400);
  assert.equal(d.code, 'plugin.alreadyInstalled');
  assert.equal(d.userMessage, 'El plugin ya está instalado');
  assert.deepEqual(d.issues, ['issue one', 'issue two']);
  assert.equal(d.route, '/library/batch');
});

test('errorDiagnostics maneja cuerpo sin código como null', () => {
  const error = new FxbApiError(500, { message: 'fallo interno' }, 'fallo interno');
  const d = errorDiagnostics(error);
  assert.equal(d.code, null);
  assert.equal(d.status, 500);
  assert.equal(d.userMessage, 'fallo interno');
});

test('errorDiagnostics formatea un diagnóstico copiable', () => {
  const error = new FxbApiError(409, { code: 'config.conflict', message: 'conflicto' }, 'conflicto');
  const d = errorDiagnostics(error);
  const text = formatErrorDiagnostics(d);
  assert.ok(text.includes('--- fxbLoader error diagnostic ---'));
  assert.ok(text.includes('status: 409'));
  assert.ok(text.includes('code: config.conflict'));
  assert.ok(text.includes('userMessage: conflicto'));
  assert.ok(text.includes('--- end ---'));
});

test('copyErrorDiagnostics copia cuando clipboard está disponible', async () => {
  let written = '';
  const originalClipboard = (globalThis as unknown as { navigator?: { clipboard?: unknown } }).navigator?.clipboard;
  try {
    // mockear clipboard en globalThis si no existe o no tiene writeText
    const mockClipboard = {
      writeText: async (text: string) => {
        written = text;
      },
    };
    Object.defineProperty(navigator, 'clipboard', {
      value: mockClipboard,
      configurable: true,
      writable: true,
    });
    const error = new FxbApiError(400, { code: 'plugin.badName', message: 'nombre inválido' }, 'nombre inválido');
    const result = await copyErrorDiagnostics(error, { route: '/library/inspect-dll' });
    assert.equal(result.copied, true);
    assert.ok(written.includes('--- fxbLoader error diagnostic ---'));
    assert.ok(written.includes('code: plugin.badName'));
  } finally {
    if (originalClipboard !== undefined) {
      Object.defineProperty(navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
        writable: true,
      });
    } else {
      // @ts-expect-error restaurar propiedad en node navigator
      delete (navigator as Record<string, unknown>)['clipboard'];
    }
  }
});
