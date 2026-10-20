'use strict';

/**
 * Orquestación de lotes (instalar/desinstalar todos los plugins escaneados).
 *
 * No toca el DOM ni conoce `fetch`: recibe `callAction(plugin, action)` desde
 * `app.js`, de modo que la misma lógica se puede probar en Node con dobles.
 * Se carga antes que `app.js` y queda expuesta como `window.FxbBatch`; el
 * envoltorio UMD también la exporta con `require` para los tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FxbBatch = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const DEFAULT_RETRY_DELAY_MS = 250;

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function messageOf(error) {
    if (error && typeof error.message === 'string' && error.message !== '') return error.message;
    return String(error);
  }

  function verbOf(action) {
    return action === 'install' ? 'instalado' : 'desinstalado';
  }

  /**
   * Un error HTTP 4xx es determinista (404, 409, 422): repetirlo da el mismo
   * resultado y solo retrasa el resumen. Los fallos de red y los 5xx sí se
   * reintentan una vez.
   */
  function isTransient(error) {
    if (!error || typeof error.status !== 'number') return true;
    return error.status >= 500;
  }

  /**
   * Ejecuta la acción con un reintento. Un solo reintento absorbe fallos
   * transitorios (archivo bloqueado, servidor reiniciándose) sin multiplicar
   * los errores deterministas.
   */
  async function callWithRetry(callAction, plugin, action, options = {}) {
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const sleep = options.sleep ?? wait;
    try {
      return await callAction(plugin, action);
    } catch (error) {
      if (!isTransient(error)) throw error;
      await sleep(retryDelayMs);
      return callAction(plugin, action);
    }
  }

  /**
   * Procesa los plugins en serie (el instalador escribe en el mismo árbol) y
   * devuelve el resumen, sin lanzar por fallos individuales.
   *
   * @returns {Promise<{action: string, total: number, succeeded: number,
   *   failures: Array<{plugin: object, action: string, message: string}>}>}
   */
  async function runBatch(options) {
    const { action, plugins, callAction, onProgress, retryDelayMs, sleep } = options;
    if (action !== 'install' && action !== 'uninstall') {
      throw new TypeError(`acción de lote no válida: ${String(action)}`);
    }

    const total = plugins.length;
    const failures = [];
    let succeeded = 0;

    for (const [index, plugin] of plugins.entries()) {
      if (onProgress) onProgress({ index, total, plugin });
      try {
        await callWithRetry(callAction, plugin, action, { retryDelayMs, sleep });
        succeeded += 1;
      } catch (error) {
        failures.push({ plugin, action, message: messageOf(error) });
      }
    }

    return { action, total, succeeded, failures };
  }

  /** Texto del resumen; coincide con el que muestra la UI. */
  function summarize(result) {
    const verb = verbOf(result.action);
    if (result.failures.length === 0) return `${result.succeeded} plugin(s) ${verb}(s).`;
    return `${result.succeeded} de ${result.total} ${verb}(s); ${result.failures.length} con error.`;
  }

  return {
    runBatch,
    callWithRetry,
    summarize,
    messageOf,
    isTransient,
    DEFAULT_RETRY_DELAY_MS,
  };
});
