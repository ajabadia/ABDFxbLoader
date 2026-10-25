import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureStaticAssets, resolvePublicDir } from '../src/app.setup';
import {
  elementIds,
  htmlIdReferences,
  parseHtml,
  querySelectorAll,
  scanUiSource,
} from './helpers/ui-dom';
import type { UiReference } from './helpers/ui-dom';

let app: NestExpressApplication;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureStaticAssets(app);
  await app.init();
});

after(async () => {
  await app?.close();
});

test('sirve la UI y carga el módulo tipado', async () => {
  const response = await request(app.getHttpServer())
    .get('/')
    .expect(200)
    .expect('content-type', /text\/html/);

  assert.match(response.text, /fxbLoader/);
  assert.match(response.text, /id="theme-toggle"/);
  // El conmutador de tema dibuja un sol (claro) y una luna (oscuro), no
  // emojis; con «Sistema» se enseña el que corresponda al SO.
  assert.match(response.text, /data-icon="light"/);
  assert.match(response.text, /data-icon="dark"/);
  assert.doesNotMatch(response.text, /data-icon="auto"/);
  assert.doesNotMatch(response.text, /🎛|🌓|☀|🌙/);
  assert.match(response.text, /id="plugins"/);
  assert.match(response.text, /id="scan-form"/);
  assert.match(response.text, /id="library-root-recents"/);
  assert.match(response.text, /list="library-root-recents"/);
  // La explicación de la carpeta es un aviso que empieza oculto; el campo la
  // usa como descripción cuando aparece.
  assert.match(response.text, /aria-describedby="root-warning"/);
  assert.match(response.text, /id="root-warning" class="warning" hidden/);
  assert.match(response.text, /La carpeta debe contener <code>plugs\\<\/code>/);
  assert.doesNotMatch(response.text, /class="hint"/);
  assert.match(response.text, /id="root-browse"/);
  assert.match(response.text, /Elegir carpeta…/);
  assert.match(response.text, /id="dll-source-recents"/);
  assert.match(response.text, /list="dll-source-recents"/);
  assert.match(response.text, /id="dll-browse"/);
  assert.match(response.text, /Elegir DLL…/);
  assert.match(response.text, /id="recents-clear"/);
  assert.match(response.text, /Vaciar historial de rutas/);
  assert.match(response.text, /id="import-browse"/);
  assert.match(response.text, /Añadir archivos…/);
  // Los cajones son diálogos modales: el rol, el nombre y el foco inicial.
  assert.match(
    response.text,
    /id="banks"[\s\S]{0,200}role="dialog"[\s\S]{0,200}aria-modal="true"[\s\S]{0,200}aria-labelledby="banks-title"[\s\S]{0,200}tabindex="-1"/,
  );
  assert.match(response.text, /id="banks-rows"/);
  assert.match(response.text, /id="default-bank"/);
  assert.match(response.text, /id="default-convert"/);
  assert.match(response.text, /Convertir orden de bytes/);
  assert.match(response.text, /id="default-restore"/);
  assert.match(response.text, /Restaurar original/);
  assert.match(response.text, /id="default-discard"/);
  assert.match(response.text, /Descartar respaldo/);
  assert.match(response.text, /id="import-paths"/);
  assert.match(response.text, /id="recent-banks"/);
  assert.match(response.text, /Bancos usados recientemente/);
  assert.match(response.text, /id="import-progress"/);
  assert.match(response.text, /Progreso de la importación de bancos/);
  assert.match(response.text, /id="export-bank"/);
  assert.match(response.text, /id="export-order"/);
  assert.match(response.text, /id="export-overwrite"/);
  assert.match(response.text, /id="export-button"/);
  assert.match(response.text, /Exportar un banco en otro orden de bytes/);
  assert.match(response.text, /id="install-all"/);
  assert.match(response.text, /id="uninstall-all"/);
  assert.match(response.text, /id="batch-cancel"/);
  assert.match(response.text, /Cancelar/);
  assert.match(response.text, /id="batch-resume"/);
  assert.match(response.text, /Reanudar/);
  assert.match(response.text, /id="retry-all"/);
  assert.match(response.text, /Reintentar fallidos/);
  assert.match(response.text, /id="batch-errors"/);
  assert.match(response.text, /id="batch-error-list"/);
  assert.match(response.text, /id="batch-progress"/);
  assert.match(response.text, /id="loader-status"/);
  assert.match(response.text, /Compatibilidad/);
  assert.match(response.text, /data-field="compatibility"/);
  // Los botones llevan iconos monocromos de un sprite: si falta una `<use>`, el
  // botón se queda sin marca y nadie más lo nota.
  assert.match(response.text, /class="icon-sprite"/);
  assert.match(response.text, /<use href="#icon-search"><\/use>/);
  assert.match(response.text, /<use href="#icon-save"><\/use>/);
  // La tabla dice cuántos bancos tiene cada plugin, sin abrir el panel.
  assert.match(response.text, /<th>Bancos<\/th>/);
  assert.match(response.text, /data-field="banks"/);
  // La tabla dice qué plugins ya tienen catálogo propio, sin abrir el panel.
  assert.match(response.text, /<th>Catálogo<\/th>/);
  assert.match(response.text, /data-field="meta"/);
  assert.match(response.text, /id="plugin-filter"/);
  assert.match(response.text, /aria-label="Filtros de la tabla"/);
  // Cuatro ejes, cada uno con un chip que abre sus tres estados. Un solo
  // control por eje evita los chips duplicados de «con» y «sin».
  for (const [axis, menu] of [
    ['install', 'filter-install-menu'],
    ['banks', 'filter-banks-menu'],
    ['wizard', 'filter-wizard-menu'],
    ['compat', 'filter-compat-menu'],
  ] as const) {
    // El chip anuncia si filtra (`aria-pressed`), que abre un menú
    // (`aria-haspopup`/`aria-expanded`) y cuál controla (`aria-controls`).
    assert.match(
      response.text,
      new RegExp(
        `id="filter-${axis}"[\\s\\S]{0,400}aria-expanded="false"[\\s\\S]{0,200}` +
          `aria-controls="${menu}"[\\s\\S]{0,200}aria-pressed="false"`,
      ),
      `chip del eje ${axis}`,
    );
    assert.match(
      response.text,
      new RegExp(`id="${menu}"[\\s\\S]{0,200}role="menu"`),
      `menú del eje ${axis}`,
    );
  }
  assert.equal(
    [...response.text.matchAll(/role="menuitemradio"/g)].length,
    12,
    'tres opciones por cada uno de los cuatro ejes',
  );
  assert.equal(
    [...response.text.matchAll(/aria-checked="true"/g)].length,
    4,
    'cada eje arranca en su estado «todos»',
  );
  for (const label of [
    'Con cargador',
    'Sin cargador',
    'Con y sin cargador',
    'Con bancos',
    'Sin bancos',
    'Con y sin bancos',
    'Con wizard',
    'Sin wizard',
    'Con y sin wizard',
    'Ningún incompatible',
    'Solo incompatibles',
    'Compatibles e incompatibles',
  ]) {
    assert.match(response.text, new RegExp(`>${label}<`), label);
  }
  assert.match(response.text, /id="filter-count"/);
  // El catálogo del plugin es un panel más, abierto desde la fila, y también
  // un diálogo modal.
  assert.match(
    response.text,
    /id="meta"[\s\S]{0,200}role="dialog"[\s\S]{0,200}aria-modal="true"[\s\S]{0,200}aria-labelledby="meta-title"[\s\S]{0,200}tabindex="-1"/,
  );
  assert.match(response.text, /id="meta-extended"/);
  assert.match(response.text, /id="meta-save"/);
  // La nota que explica de dónde salen los valores al abrir el panel.
  assert.match(response.text, /id="meta-origin"/);
  assert.match(response.text, /Campos propios \(JSON\)/);
  assert.match(response.text, /data-action="meta"/);
  assert.match(response.text, /Catálogo/);
  // El log del plugin, con su ruta, sus entradas y los archivos rotados en su propio cajón.
  assert.match(response.text, /id="log-path"/);
  assert.match(response.text, /id="log-summary"/);
  assert.match(response.text, /id="log-table"/);
  assert.doesNotMatch(response.text, /id="log-entries"/);
  assert.match(response.text, /id="log-rotated"/);
  assert.match(response.text, /data-action="log"/);
  assert.match(response.text, /Historial/);

  // La UI es un módulo ESM compilado desde TypeScript; `app.js` ya no existe.
  assert.match(response.text, /<script type="module" src="\/js\/ui\/browser\/main\.js">/);
  assert.doesNotMatch(response.text, /\/app\.js/);
  assert.doesNotMatch(response.text, /\/batch\.js/);
});

test('sirve el módulo de la UI, el orquestador y el cliente tipado', async () => {
  const main = await request(app.getHttpServer())
    .get('/js/ui/browser/main.js')
    .expect(200)
    .expect('content-type', /javascript/);

  // La vista usa el cliente tipado y conserva las operaciones de bancos.
  assert.match(main.text, /client\.library\.scan/);
  // Elegir carpetas y archivos sin teclearlos: el diálogo lo abre el servidor.
  assert.match(main.text, /client\.system\.pick/);
  assert.match(main.text, /appendPaths/);
  // Las rutas usadas se recuerdan y se ofrecen como sugerencias en su campo.
  assert.match(main.text, /parseRecents/);
  assert.match(main.text, /rememberRecent/);
  assert.match(main.text, /rememberRecentPaths/);
  assert.match(main.text, /recentRoots/);
  assert.match(main.text, /recentDlls/);
  assert.match(main.text, /recentBanks/);
  // Las sugerencias caducadas se podan contra el disco al cargar la vista.
  assert.match(main.text, /client\.system\.paths/);
  assert.match(main.text, /existingRecents/);
  // Y se pueden olvidar a mano desde Opciones avanzadas, o solo los bancos
  // desde el propio panel de bancos.
  assert.match(main.text, /recentsClear/);
  assert.match(main.text, /clearRecents/);
  assert.match(main.text, /clearRecentBanks/);
  assert.match(main.text, /recent-clear/);
  // Cada chip se puede olvidar por separado con su «×».
  assert.match(main.text, /forgetRecentBank/);
  assert.match(main.text, /recent-chip-remove/);
  assert.match(main.text, /client\.library\.listBanks/);
  assert.match(main.text, /client\.library\.importBanksStream/);
  assert.match(main.text, /client\.library\.convertDefaultBank/);
  assert.match(main.text, /client\.library\.restoreDefaultBank/);
  assert.match(main.text, /client\.library\.discardDefaultBankBackup/);
  // Restaurar pide confirmación y respeta el respaldo anunciado por la lista.
  assert.match(main.text, /defaultBackup/);
  assert.match(main.text, /client\.library\.exportBank/);
  assert.match(main.text, /renderExportOptions/);
  // Importar bancos lee NDJSON y acumula el resultado; la barra avanza con
  // cada banco, no solo al terminar el trozo.
  assert.match(main.text, /runImportInChunks/);
  assert.match(main.text, /onEvent/);
  assert.match(main.text, /importProgressLabel/);
  assert.match(main.text, /importProgress/);
  assert.match(main.text, /client\.config\.write/);
  assert.match(main.text, /expectedMtimeMs/);
  // El lote lo ejecuta el servidor, que además manda el progreso en caliente:
  // la vista pinta qué plugin va y el resultado por plugin al terminar.
  assert.match(main.text, /client\.library\.batchStream/);
  assert.match(main.text, /failuresOf/);
  assert.match(main.text, /progressLabel/);
  assert.match(main.text, /batchProgress/);
  // Reanudar solo los plugins sin confirmar: el botón se pinta con lo pendiente.
  assert.match(main.text, /resumablePlugins/);
  assert.match(main.text, /batchResume/);
  // Los fallos se pueden reintentar de uno en uno o todos en orden.
  assert.match(main.text, /retryAllFailures/);
  assert.match(main.text, /retryAll/);
  assert.doesNotMatch(main.text, /runPluginBatch/);
  assert.doesNotMatch(main.text, /callWithRetry/);
  // El escaneo bloquea los plugins incompatibles.
  assert.match(main.text, /plugin\.compatible === false/);
  assert.match(main.text, /dataset\[['"]blocked['"]\]/);
  // Filtrado en tiempo real por texto y por los cuatro ejes de tres estados.
  assert.match(main.text, /pluginFilter/);
  assert.match(main.text, /setFilterAxis/);
  assert.match(main.text, /FILTER_AXES/);
  assert.match(main.text, /dataset\[['"]axis['"]\]/);
  assert.match(main.text, /dataset\[['"]value['"]\]/);
  // El catálogo del plugin se lee y se guarda con el cliente tipado, y el
  // `mtimeMs` leído es el testigo que se manda al guardar.
  assert.match(main.text, /client\.plugins\.meta\.read/);
  assert.match(main.text, /client\.plugins\.meta\.write/);
  assert.match(main.text, /renderMeta/);
  assert.match(main.text, /readExtended/);
  // Cuando aún no hay archivo, el panel dice si los campos vienen del vfxinfo
  // y qué falta para poder guardar, en vez de abrirse vacío sin explicación.
  assert.match(main.text, /metaOriginText/);
  assert.match(main.text, /metaOrigin/);
  // El historial del plugin se lee con el cliente tipado y se pinta por partes.
  assert.match(main.text, /client\.plugins\.log\.read/);
  assert.match(main.text, /renderPluginLog/);
  assert.match(main.text, /pluginHistoryTableView/);
  assert.match(main.text, /import-result/);
  // Y la columna de la tabla se actualiza al guardar, sin volver a escanear.
  assert.match(main.text, /markPluginHasMeta/);

  const batch = await request(app.getHttpServer())
    .get('/js/ui/batch.js')
    .expect(200)
    .expect('content-type', /javascript/);

  assert.match(batch.text, /export function failuresOf/);
  assert.match(batch.text, /export function summarize/);
  // El progreso del lote se calcula sin DOM ni red, a partir de los eventos.
  assert.match(batch.text, /export function applyBatchEvent/);
  assert.match(batch.text, /export function progressLabel/);
  // La orquestación de cada petición vive en el servidor: el módulo no llama a
  // `fetch` ni conoce las rutas, solo recibe el emisor. Lo que sí hace es
  // trocear la lista por el tope del contrato y sumar el progreso de todas las
  // peticiones en un único estado.
  assert.doesNotMatch(batch.text, /fetch\(/);
  assert.doesNotMatch(batch.text, /['"]\/library\//, 'el módulo no debe conocer rutas de la API');
  assert.doesNotMatch(batch.text, /client\.library/);
  assert.doesNotMatch(batch.text, /callWithRetry/);
  assert.match(batch.text, /MAX_PLUGINS_PER_BATCH/);
  assert.match(batch.text, /export function splitBatch/);
  assert.match(batch.text, /export function mergeProgress/);
  assert.match(batch.text, /export async function runBatchInChunks/);

  const client = await request(app.getHttpServer())
    .get('/js/client/fxb-client.js')
    .expect(200)
    .expect('content-type', /javascript/);

  assert.match(client.text, /\/library\/banks\/import/);
  assert.match(client.text, /class FxbApiError/);

  const styles = await request(app.getHttpServer())
    .get('/styles.css')
    .expect(200)
    .expect('content-type', /text\/css/);

  assert.match(styles.text, /\.default-row/);
  assert.match(styles.text, /\.batch-errors/);
  assert.match(styles.text, /\.table-sort/);
  assert.match(styles.text, /\.table-view/);
  assert.match(styles.text, /\.batch-progress/);
  assert.match(styles.text, /\.import-progress/);
  assert.match(styles.text, /\.recents/);
  assert.match(styles.text, /\.recent-chip/);
  assert.match(styles.text, /\.recent-item/);
  assert.match(styles.text, /\.recent-chip-remove/);
  assert.match(styles.text, /\.recent-clear/);
  assert.match(styles.text, /tr\.batch-running/);
  assert.match(styles.text, /details\.export/);
});

test('el build de la UI existe y app.js ya no se sirve', () => {
  const dir = resolvePublicDir();
  assert.equal(existsSync(path.join(dir, 'js', 'ui', 'browser', 'main.js')), true);
  assert.equal(existsSync(path.join(dir, 'app.js')), false);
});

async function indexHtml(): Promise<string> {
  return readFile(path.join(resolvePublicDir(), 'index.html'), 'utf8');
}

async function uiSources(): Promise<{ file: string; source: string }[]> {
  const uiDir = path.resolve(__dirname, '..', '..', 'src', 'ui');
  const files = (await readdir(uiDir, { recursive: true }))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => path.join(uiDir, file));

  return Promise.all(
    files.map(async (file) => ({
      file: path.relative(uiDir, file).replace(/\\/g, '/'),
      source: await readFile(file, 'utf8'),
    })),
  );
}

function describeReferences(references: UiReference[]): string {
  return references.map((ref) => `${ref.value} (${ref.file}:${ref.line})`).join(', ');
}

/**
 * La vista pide elementos por id (`byId`, `getElementById`, `#id` dentro de un
 * selector), por atributo (`[data-field="…"]`, `[data-action="…"]`) y por
 * etiqueta. Todo eso es texto escrito a mano: si uno deja de existir, la página
 * falla al cargar o el botón deja de responder. Este test lo detecta sin abrir
 * el navegador, incluidas las filas de la `<template>`.
 */
test('los ids y selectores de la UI existen en index.html', async () => {
  const document = parseHtml(await indexHtml());
  const htmlIds = elementIds(document);

  const references = await Promise.all(
    (await uiSources()).map(({ file, source }) => scanUiSource(source, file)),
  );
  const ids = references.flatMap((entry) => entry.ids);
  const selectors = references.flatMap((entry) => entry.selectors);
  const dynamic = references.flatMap((entry) => entry.dynamic);

  // Un selector con plantilla no se puede comprobar contra el HTML.
  assert.deepEqual(
    dynamic.map((ref) => `${ref.value} (${ref.file}:${ref.line})`),
    [],
    'los selectores de la UI deben ser literales para poder comprobarlos',
  );

  // Sin estos mínimos, un cambio de sintaxis dejaría el test comparando nada.
  assert.ok(ids.length >= 25, `solo se encontraron ${ids.length} ids en la UI`);
  assert.ok(selectors.length >= 10, `solo se encontraron ${selectors.length} selectores en la UI`);

  const missingIds = ids.filter((ref) => !htmlIds.has(ref.value));
  assert.deepEqual(
    missingIds.map((ref) => `#${ref.value} (${ref.file}:${ref.line})`),
    [],
    `index.html no tiene: ${describeReferences(missingIds)}`,
  );

  const unmatched = selectors.filter((ref) => querySelectorAll(document, ref.value).length === 0);
  assert.deepEqual(
    unmatched.map((ref) => `${ref.value} (${ref.file}:${ref.line})`),
    [],
    `index.html no tiene ningún elemento para: ${describeReferences(unmatched)}`,
  );
});

/**
 * `index.html` también referencia ids desde `for` y `aria-*`: una etiqueta sin
 * su campo o una sección sin su título rompen la accesibilidad sin que falle
 * ninguna otra cosa.
 */
test('las referencias por id de index.html apuntan a elementos existentes', async () => {
  const document = parseHtml(await indexHtml());
  const htmlIds = elementIds(document);
  const references = htmlIdReferences(document);

  assert.ok(references.length >= 5, `solo se encontraron ${references.length} referencias`);

  const missing = references.filter((reference) => !htmlIds.has(reference.id));
  assert.deepEqual(
    missing.map((reference) => `${reference.origin} → #${reference.id}`),
    [],
    `index.html referencia ids que no existen: ${missing
      .map((reference) => `#${reference.id}`)
      .join(', ')}`,
  );
});

test('los estáticos no tapan la API', async () => {
  const response = await request(app.getHttpServer()).post('/library/scan').send({}).expect(400);

  assert.match(response.body.message, /libraryRoot/);
});

test('resolvePublicDir encuentra index.html', () => {
  const dir = resolvePublicDir();
  assert.equal(path.basename(dir), 'public');
  assert.equal(existsSync(path.join(dir, 'index.html')), true);
});

/**
 * El navegador no reescribe rutas de módulo: `from './x'` sin extensión no
 * carga, y el error ocurre antes de que la vista pinte nada, así que el resto
 * de los tests no lo verían. Se recorre el grafo emitido desde `main.js` y se
 * exige que cada import relativo termine en `.js` y exista en el build.
 */
test('el grafo de la UI se resuelve en el navegador: imports relativos con .js', async () => {
  const jsRoot = path.join(resolvePublicDir(), 'js');
  const seen = new Set<string>();
  const pending = [path.join(jsRoot, 'ui', 'browser', 'main.js')];
  const imports = /^(?:import|export)\s[^\n]*\bfrom\s+['"]([^'"]+)['"]/gm;

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = await readFile(file, 'utf8');
    const relative = path.relative(jsRoot, file);
    for (const match of source.matchAll(imports)) {
      const specifier = match[1]!;
      assert.match(
        specifier,
        /\.js$/,
        `${relative} importa "${specifier}" sin extensión: el navegador no lo resuelve`,
      );
      const target = path.resolve(path.dirname(file), specifier);
      assert.equal(existsSync(target), true, `${relative} importa "${specifier}", que no existe`);
      pending.push(target);
    }
  }

  // Sin este mínimo, un `main.js` recortado pasaría el test sin recorrer nada.
  assert.ok(seen.size >= 5, `solo se recorrieron ${seen.size} módulos`);
});
