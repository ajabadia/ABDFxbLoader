import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { test } from 'node:test';

interface BatchPlugin {
  name: string;
  installed: boolean;
}

interface BatchFailure {
  plugin: BatchPlugin;
  action: 'install' | 'uninstall';
  message: string;
}

interface BatchResult {
  action: 'install' | 'uninstall';
  total: number;
  succeeded: number;
  failures: BatchFailure[];
}

interface BatchModule {
  runBatch(options: {
    action: 'install' | 'uninstall';
    plugins: BatchPlugin[];
    callAction: (plugin: BatchPlugin, action: string) => Promise<unknown>;
    onProgress?: (progress: { index: number; total: number; plugin: BatchPlugin }) => void;
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  }): Promise<BatchResult>;
  callWithRetry(
    callAction: (plugin: BatchPlugin, action: string) => Promise<unknown>,
    plugin: BatchPlugin,
    action: 'install' | 'uninstall',
    options?: { retryDelayMs?: number; sleep?: (ms: number) => Promise<void> },
  ): Promise<unknown>;
  summarize(result: BatchResult): string;
}

// `dist-test/test` -> `public/batch.js`: el mismo archivo que sirve la UI.
const load = createRequire(__filename);
const FxbBatch = load(path.resolve(__dirname, '../../public/batch.js')) as BatchModule;

const plugins: BatchPlugin[] = [
  { name: 'Alpha', installed: false },
  { name: 'Beta', installed: false },
  { name: 'Gamma', installed: false },
];

const noSleep = async (): Promise<void> => {};

function recorder(): {
  calls: string[];
  callAction: (plugin: BatchPlugin, action: string) => Promise<unknown>;
} {
  const calls: string[] = [];
  return {
    calls,
    callAction: async (plugin, action) => {
      calls.push(`${action}:${plugin.name}`);
      return { plugin, actions: [] };
    },
  };
}

test('runBatch procesa todos los plugins en orden y resume sin errores', async () => {
  const { calls, callAction } = recorder();
  const progress: string[] = [];

  const result = await FxbBatch.runBatch({
    action: 'install',
    plugins,
    callAction,
    onProgress: ({ index, total, plugin }) => {
      progress.push(`${index + 1}/${total}:${plugin.name}`);
    },
    sleep: noSleep,
  });

  assert.deepEqual(calls, ['install:Alpha', 'install:Beta', 'install:Gamma']);
  assert.deepEqual(progress, ['1/3:Alpha', '2/3:Beta', '3/3:Gamma']);
  assert.deepEqual(result, { action: 'install', total: 3, succeeded: 3, failures: [] });
  assert.equal(FxbBatch.summarize(result), '3 plugin(s) instalado(s).');
});

test('runBatch reintenta una vez por plugin y sigue si el reintento funciona', async () => {
  const attempts = new Map<string, number>();
  const calls: string[] = [];

  const result = await FxbBatch.runBatch({
    action: 'install',
    plugins,
    callAction: async (plugin, action) => {
      calls.push(`${action}:${plugin.name}`);
      const attempt = (attempts.get(plugin.name) ?? 0) + 1;
      attempts.set(plugin.name, attempt);
      if (plugin.name === 'Beta' && attempt === 1) {
        throw new Error('archivo bloqueado');
      }
      return { plugin, actions: [] };
    },
    retryDelayMs: 0,
    sleep: noSleep,
  });

  assert.deepEqual(calls, [
    'install:Alpha',
    'install:Beta',
    'install:Beta',
    'install:Gamma',
  ]);
  assert.equal(attempts.get('Beta'), 2);
  assert.equal(attempts.get('Alpha'), 1);
  assert.equal(result.succeeded, 3);
  assert.deepEqual(result.failures, []);
  assert.equal(FxbBatch.summarize(result), '3 plugin(s) instalado(s).');
});

test('runBatch agota el reintento, registra el error y continúa con el resto', async () => {
  const attempts = new Map<string, number>();

  const result = await FxbBatch.runBatch({
    action: 'uninstall',
    plugins,
    callAction: async (plugin, action) => {
      assert.equal(action, 'uninstall');
      const attempt = (attempts.get(plugin.name) ?? 0) + 1;
      attempts.set(plugin.name, attempt);
      if (plugin.name === 'Alpha') throw new Error('sin respaldo vfxinfo.tx_');
      if (plugin.name === 'Beta') throw new Error('acceso denegado');
      return { plugin, actions: [] };
    },
    retryDelayMs: 0,
    sleep: noSleep,
  });

  assert.equal(attempts.get('Alpha'), 2);
  assert.equal(attempts.get('Beta'), 2);
  assert.equal(attempts.get('Gamma'), 1);
  assert.equal(result.succeeded, 1);
  assert.deepEqual(
    result.failures.map((failure) => [failure.plugin.name, failure.action, failure.message]),
    [
      ['Alpha', 'uninstall', 'sin respaldo vfxinfo.tx_'],
      ['Beta', 'uninstall', 'acceso denegado'],
    ],
  );
  assert.equal(FxbBatch.summarize(result), '1 de 3 desinstalado(s); 2 con error.');
});

test('runBatch admite una lista vacía', async () => {
  const { calls, callAction } = recorder();
  const result = await FxbBatch.runBatch({
    action: 'install',
    plugins: [],
    callAction,
    sleep: noSleep,
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, { action: 'install', total: 0, succeeded: 0, failures: [] });
  assert.equal(FxbBatch.summarize(result), '0 plugin(s) instalado(s).');
});

test('callWithRetry no repite una llamada correcta y espera entre intentos', async () => {
  const plugin = plugins[0]!;
  const waits: number[] = [];
  let calls = 0;

  const value = await FxbBatch.callWithRetry(
    async () => {
      calls += 1;
      return 'ok';
    },
    plugin,
    'install',
    {
      retryDelayMs: 25,
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );

  assert.equal(value, 'ok');
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('callWithRetry usa el mensaje del último error y espera el retardo', async () => {
  const plugin = plugins[0]!;
  const waits: number[] = [];
  let calls = 0;

  await assert.rejects(
    FxbBatch.callWithRetry(
      async () => {
        calls += 1;
        throw new Error(`fallo ${calls}`);
      },
      plugin,
      'install',
      {
        retryDelayMs: 25,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    ),
    /fallo 2/,
  );

  assert.equal(calls, 2);
  assert.deepEqual(waits, [25]);
});

test('callWithRetry no repite un 4xx determinista', async () => {
  const plugin = plugins[0]!;
  const waits: number[] = [];
  let calls = 0;
  const error = Object.assign(new Error('El plugin ya está instalado'), { status: 409 });

  await assert.rejects(
    FxbBatch.callWithRetry(
      async () => {
        calls += 1;
        throw error;
      },
      plugin,
      'install',
      {
        retryDelayMs: 25,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    ),
    /ya está instalado/,
  );

  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('callWithRetry repite un 5xx', async () => {
  const plugin = plugins[0]!;
  const waits: number[] = [];
  let calls = 0;

  await assert.rejects(
    FxbBatch.callWithRetry(
      async () => {
        calls += 1;
        throw Object.assign(new Error('servidor no disponible'), { status: 503 });
      },
      plugin,
      'install',
      {
        retryDelayMs: 25,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    ),
    /no disponible/,
  );

  assert.equal(calls, 2);
  assert.deepEqual(waits, [25]);
});

test('runBatch no reintenta un fallo determinista y lo resume igual', async () => {
  let calls = 0;

  const result = await FxbBatch.runBatch({
    action: 'install',
    plugins: [plugins[0]!],
    callAction: async () => {
      calls += 1;
      throw Object.assign(new Error('no existe vfxinfo.txt'), { status: 422 });
    },
    retryDelayMs: 0,
    sleep: noSleep,
  });

  assert.equal(calls, 1);
  assert.equal(result.succeeded, 0);
  assert.equal(result.failures[0]?.message, 'no existe vfxinfo.txt');
  assert.equal(FxbBatch.summarize(result), '0 de 1 instalado(s); 1 con error.');
});

test('runBatch rechaza una acción desconocida', async () => {
  await assert.rejects(
    FxbBatch.runBatch({
      action: 'delete' as 'install',
      plugins,
      callAction: async () => undefined,
      sleep: noSleep,
    }),
    TypeError,
  );
});
