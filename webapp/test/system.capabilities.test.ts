import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SystemCapabilitiesController } from '../src/system/capabilities.controller';
import { createFxbClient } from '../src/client/fxb-client';

test('SystemCapabilitiesController devuelve las capacidades según el SO y FXB_APP_MODE', () => {
  const controller = new SystemCapabilitiesController();
  const isWin = process.platform === 'win32';

  delete process.env['FXB_APP_MODE'];
  const localCaps = controller.getCapabilities();
  assert.equal(localCaps.mode, 'web-local');
  assert.equal(localCaps.canCaptureRegistry, isWin);
  assert.equal(localCaps.canTrash, isWin);
  assert.equal(localCaps.canRevealInExplorer, isWin);
  assert.equal(localCaps.canNativePick, isWin);
  assert.equal(localCaps.canFileSystemAccess, false);

  process.env['FXB_APP_MODE'] = 'desktop';
  try {
    const desktopCaps = controller.getCapabilities();
    assert.equal(desktopCaps.mode, 'desktop');
    assert.equal(desktopCaps.canCaptureRegistry, isWin);
  } finally {
    delete process.env['FXB_APP_MODE'];
  }
});

test('createFxbClient invoca GET /system/capabilities a través del cliente tipado', async () => {
  let requestedUrl = '';
  let requestedMethod = '';

  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url);
    requestedMethod = init?.method ?? 'GET';
    return new Response(
      JSON.stringify({
        mode: 'web-local',
        canCaptureRegistry: true,
        canTrash: true,
        canRevealInExplorer: true,
        canNativePick: true,
        canFileSystemAccess: false,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  const client = createFxbClient({ baseUrl: 'http://127.0.0.1:3210', fetch: mockFetch });
  const caps = await client.system.capabilities();

  assert.equal(requestedUrl, 'http://127.0.0.1:3210/system/capabilities');
  assert.equal(requestedMethod, 'GET');
  assert.equal(caps.mode, 'web-local');
  assert.equal(caps.canCaptureRegistry, true);
});
