import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyStagingFiles,
  formatPreExistingSummary,
  formatRemovePreExistingResult,
  formatRestorePreExistingResult,
  formatRestoreStagedFileResult,
  formatRevealPreExistingResult,
  preExistingListLabel,
  removedStagingNote,
  removePreExistingLabel,
  restorePreExistingLabel,
  restoreStagedFileLabel,
  revealPreExistingLabel,
} from '../src/ui/capture';

/**
 * El paso 4 enseña, antes de generar, cuántos archivos previos a la captura
 * entran en el paquete. El recuento lo da el servidor; aquí se fija el texto:
 * singular y plural, la casilla marcada o no, y el aviso de que el snapshot
 * inicial no se pudo recuperar. También se fija qué filas del staging se marcan
 * como previas: el listado llega con el separador del sistema y el snapshot con
 * `/`, así que la comparación no puede ser textual.
 */

test('sin recuento todavía no se pinta ninguna línea', () => {
  assert.equal(formatPreExistingSummary({ count: null, include: true }), '');
});

test('con la casilla marcada se anuncia cuántos previos se incluyen', () => {
  assert.equal(
    formatPreExistingSummary({ count: 3, include: true }),
    'Se incluirán 3 archivos previos del snapshot inicial.',
  );
  // Un archivo no es «1 archivos previos».
  assert.equal(
    formatPreExistingSummary({ count: 1, include: true }),
    'Se incluirán 1 archivo previo del snapshot inicial.',
  );
  assert.equal(
    formatPreExistingSummary({ count: 0, include: true }),
    'El paquete se queda solo con lo que cambió la captura: no hay archivos previos que incluir.',
  );
});

test('al desmarcar la casilla se dice cuántos quedan fuera', () => {
  assert.equal(
    formatPreExistingSummary({ count: 3, include: false }),
    'Se dejará fuera 3 archivos previos: el paquete solo llevará lo que cambió la captura.',
  );
  assert.equal(
    formatPreExistingSummary({ count: 1, include: false }),
    'Se dejará fuera 1 archivo previo: el paquete solo llevará lo que cambió la captura.',
  );
  assert.equal(
    formatPreExistingSummary({ count: 0, include: false }),
    'No hay archivos previos que dejar fuera: el paquete solo llevará lo que cambió la captura.',
  );
});

test('el desplegable de previos del paso 4 cuenta en singular y plural', () => {
  assert.equal(preExistingListLabel(1), 'Ver el archivo previo que se incluye');
  assert.equal(preExistingListLabel(4), 'Ver los 4 archivos previos que se incluyen');
});

test('el aviso del servidor manda sobre el recuento', () => {
  const warning = 'No se pudo recuperar el snapshot inicial: faltan archivos del plugin.';
  assert.equal(formatPreExistingSummary({ count: 3, include: true, warning }), warning);
  assert.equal(formatPreExistingSummary({ count: null, include: false, warning: `  ${warning}  ` }), warning);
  // Un aviso vacío no tapa el recuento.
  assert.equal(
    formatPreExistingSummary({ count: 2, include: true, warning: '   ' }),
    'Se incluirán 2 archivos previos del snapshot inicial.',
  );
});

test('el staging marca como previos solo los archivos del snapshot inicial', () => {
  const files = [
    'Program Files\\VstPlugins\\P8.dll',
    'Program Files\\VstPlugins\\P8\\wavetables\\table.wav',
    'Program Files\\VstPlugins\\P8.ini',
    'Program Files\\VstPlugins\\presets\\factory.fxb',
  ];
  // El snapshot da las rutas con `/`; el staging, con el separador del sistema.
  const preExisting = [
    'Program Files/VstPlugins/P8.dll',
    'Program Files/VstPlugins/P8/wavetables/table.wav',
    'Program Files/VstPlugins/presets/legacy.fxb',
  ];

  const entries = classifyStagingFiles(files, preExisting);
  const basename = (value: string): string => value.replaceAll('\\', '/').split('/').pop() ?? '';

  assert.deepEqual(
    entries.map((entry) => [basename(entry.path), entry.preExisting]),
    [
      ['P8.dll', true],
      ['table.wav', true],
      // Lo capturado no es previo, aunque comparta carpeta con los que sí.
      ['P8.ini', false],
      ['factory.fxb', false],
    ],
  );
  // El que el staging ya no tiene (legacy.fxb) no aparece por ningún lado.
  assert.equal(entries.some((entry) => entry.path.endsWith('legacy.fxb')), false);
});

test('la comparación ignora mayúsculas y separadores repetidos', () => {
  const entries = classifyStagingFiles(
    ['Program Files//VstPlugins\\P8.DLL'],
    ['program files/vstplugins/p8.dll'],
  );

  assert.deepEqual(entries, [
    { path: 'Program Files//VstPlugins\\P8.DLL', preExisting: true },
  ]);
  // Sin previos, ningún archivo queda marcado (y no se inventan coincidencias).
  assert.deepEqual(
    classifyStagingFiles(['P8.dll'], []).map((entry) => entry.preExisting),
    [false],
  );
});

test('el botón de quitar previos cuenta en singular y plural', () => {
  assert.equal(removePreExistingLabel(1), 'Quitar 1 previo');
  assert.equal(removePreExistingLabel(3), 'Quitar 3 previos');
});

test('el resumen de quitar previos no dice «1 archivos»', () => {
  assert.equal(
    formatRemovePreExistingResult(1, 1),
    'Quitado 1 archivo previo del staging',
  );
  assert.equal(
    formatRemovePreExistingResult(3, 3),
    'Quitados 3 de 3 archivos previos del staging',
  );
  // Si alguno falla, el resumen sigue diciendo cuántos de cuántos.
  assert.equal(
    formatRemovePreExistingResult(2, 3),
    'Quitados 2 de 3 archivos previos del staging',
  );
});

test('el botón de recuperar previos cuenta en singular y plural', () => {
  assert.equal(restorePreExistingLabel(1), 'Recuperar 1 previo');
  assert.equal(restorePreExistingLabel(3), 'Recuperar 3 previos');
});

test('las filas quitadas del staging anuncian que se devuelven de una en una', () => {
  assert.equal(
    removedStagingNote(1),
    'Quitado del staging: se puede devolver cuando quieras.',
  );
  assert.equal(
    removedStagingNote(4),
    'Quitados del staging (4): se pueden devolver de uno en uno.',
  );
  assert.equal(
    restoreStagedFileLabel('P8/wavetables/table.wav'),
    'Devolver P8/wavetables/table.wav al staging',
  );
});

test('devolver un único archivo distingue copiado, perdido y ya presente', () => {
  assert.equal(
    formatRestoreStagedFileResult('P8/wavetables/table.wav', 'restored'),
    'Devuelto al staging: P8/wavetables/table.wav',
  );
  assert.equal(
    formatRestoreStagedFileResult('P8/presets/ghost.fxb', 'missing'),
    'No se pudo devolver P8/presets/ghost.fxb: ya no está en el origen',
  );
  // Pulsar dos veces no es un fallo: el archivo ya estaba de vuelta.
  assert.equal(
    formatRestoreStagedFileResult('P8/wavetables/table.wav', 'present'),
    'Ya estaba en el staging: P8/wavetables/table.wav',
  );
});

test('cada previo del paso 4 se puede abrir en el Explorador', () => {
  // El nombre accesible dice qué archivo abre y dónde.
  assert.equal(
    revealPreExistingLabel('Program Files/VstPlugins/P8.dll'),
    'Abrir Program Files/VstPlugins/P8.dll en el Explorador de Windows',
  );
  // La confirmación usa la ruta absoluta que devolvió el servidor.
  assert.equal(
    formatRevealPreExistingResult(
      'Program Files/VstPlugins/P8.dll',
      'C:\\Program Files\\VstPlugins\\P8.dll',
    ),
    'Abierto en el Explorador: C:\\Program Files\\VstPlugins\\P8.dll',
  );
  // Sin ruta absoluta (respuesta antigua) se nombra la relativa del listado.
  assert.equal(
    formatRevealPreExistingResult('Program Files/VstPlugins/P8.dll', '  '),
    'Abierto en el Explorador: Program Files/VstPlugins/P8.dll',
  );
});

test('el resumen de recuperar previos separa los que ya no están en el origen', () => {
  assert.equal(
    formatRestorePreExistingResult(1, 0),
    'Recuperado 1 archivo previo en el staging',
  );
  assert.equal(
    formatRestorePreExistingResult(3, 0),
    'Recuperados 3 archivos previos en el staging',
  );
  // Sin nada que copiar el texto no puede decir «Recuperados 0».
  assert.equal(
    formatRestorePreExistingResult(0, 2),
    'No se ha recuperado ningún archivo previo; 2 ya no están en el origen',
  );
  assert.equal(
    formatRestorePreExistingResult(2, 1),
    'Recuperados 2 archivos previos en el staging; 1 ya no está en el origen',
  );
});
