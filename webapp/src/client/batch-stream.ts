/**
 * Contrato del progreso del lote (`POST /library/batch/stream`).
 *
 * El servidor escribe una línea JSON (NDJSON) por evento en cuanto ocurre, así
 * que la vista sabe qué plugin se está procesando sin esperar al final. Los
 * tipos viven aquí, junto al resto del contrato que consume el cliente, porque
 * este módulo se compila también para el navegador: no debe arrastrar el
 * código del servidor (que usa `Buffer` y el sistema de archivos).
 *
 * `start` sale después de validar la petición entera (raíz, cargador), de modo
 * que un 400/422 nunca llega a medias: si la validación falla no se escribe
 * ningún evento. `plugin` sale dos veces por plugin, con `status: "running"`
 * antes de operarlo y con el estado final después; entre esos dos avisos sale un
 * `step` por cada paso interno (respaldo, copia del DLL, parcheo, config…), que
 * es lo que permite contar qué está haciendo el servidor con un plugin grande.
 */

/**
 * Tope de plugins por petición de lote. Vive aquí, junto al contrato, porque lo
 * necesitan los dos lados: el servidor lo valida y la vista lo usa para trocear
 * el lote sin pasarse. Si viviera en el servicio no lo podría importar el
 * navegador, que arrastraría `fs` y el resto de dependencias de Node.
 */
export const MAX_PLUGINS_PER_BATCH = 500;

export type BatchStreamAction = 'install' | 'uninstall';

/** Estado final de un plugin dentro del lote. */
export type BatchStreamPluginStatus = 'installed' | 'uninstalled' | 'planned' | 'failed';

/**
 * Pasos internos de la operación de un plugin, en el orden en que ocurren. Son
 * los mismos `kind` de `actions` que devuelve el resultado, para que la vista
 * pueda nombrarlos sin que el servidor mande texto por cada evento.
 */
export type BatchStreamStepKind =
  | 'backup'
  | 'copy'
  | 'patch'
  | 'write-config'
  | 'create-dir'
  | 'restore'
  | 'delete';

/** Lo mínimo que la vista necesita del resultado final de un plugin. */
export interface BatchStreamPluginResult {
  name: string;
  status: BatchStreamPluginStatus;
  /** Motivo del fallo; `null` cuando la operación fue correcta. */
  message: string | null;
}

/** `end.result`: el mismo resultado que devuelve `POST /library/batch`. */
export interface BatchStreamResult {
  action: BatchStreamAction;
  dryRun: boolean;
  total: number;
  succeeded: number;
  failed: number;
  results: BatchStreamPluginResult[];
}

export type BatchStreamEvent =
  | {
      type: 'start';
      action: BatchStreamAction;
      dryRun: boolean;
      total: number;
      /** Nombres en el orden en que se van a procesar. */
      plugins: string[];
    }
  | {
      type: 'plugin';
      /** Posición 0-based dentro del lote. */
      index: number;
      total: number;
      name: string;
      status: 'running' | BatchStreamPluginStatus;
      /** Motivo del fallo; `null` mientras corre o si salió bien. */
      message: string | null;
    }
  | {
      type: 'step';
      /** Posición 0-based del plugin dentro del lote. */
      index: number;
      total: number;
      name: string;
      /** Paso que empieza ahora. */
      step: BatchStreamStepKind;
      /** Posición 0-based del paso dentro del plugin. */
      stepIndex: number;
      /** Pasos que hará el plugin. */
      steps: number;
    }
  | { type: 'end'; result: BatchStreamResult };
