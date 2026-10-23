/**
 * Contrato del progreso de la importación de bancos
 * (`POST /library/banks/import/stream`).
 *
 * El servidor escribe una línea JSON (NDJSON) por evento en cuanto ocurre:
 * `start` con el total, un `bank` con el resultado de cada archivo —también los
 * rechazados— y `end` con el mismo cuerpo que devolvería `POST /library/banks/import`.
 * Así la barra avanza banco a banco en vez de esperar al cierre de cada trozo.
 *
 * El flujo se valida entero antes del primer byte. Si la petición es inválida
 * (400/404), la respuesta sigue siendo JSON normal; una vez enviado `start` no
 * se puede cambiar el código de estado, así que un corte se detecta porque no
 * llega `end`.
 */
import type { components } from './api-types';

/** Resultado por archivo y cuerpo final, tomados del contrato OpenAPI. */
export type BankImportStreamResult = components['schemas']['LibraryBanksImportResponseDto'];
type BankImportResult = components['schemas']['BankImportResultDto'];

export type BankImportStreamEvent =
  | {
      type: 'start';
      total: number;
      /** Rutas del trozo, en el mismo orden en que se van a procesar. */
      sourcePaths: string[];
    }
  | {
      type: 'bank';
      /** Posición 0-based dentro del trozo. */
      index: number;
      total: number;
      /** Resultado del archivo, importado o rechazado. */
      result: BankImportResult;
    }
  | {
      type: 'end';
      /** Mismo cuerpo que `POST /library/banks/import`, también si todo se rechazó. */
      result: BankImportStreamResult;
    };
