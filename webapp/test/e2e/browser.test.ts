import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { MAX_BANKS_PER_REQUEST } from '../../src/client/bank-limits';
import { MAX_PLUGINS_PER_BATCH } from '../../src/client/batch-stream';
import { parseFxbBank } from '../../src/library/fxb-bank';
import { pe32Dll, peWithExportsDll } from '../helpers/pe';
import { MAX_RECENTS } from '../../src/ui/recents';

/**
 * Prueba de navegador contra el servidor real (`dist/main.js`), no contra la app
 * montada en el proceso de test: arranca el binario compilado en un puerto
 * libre, opera sobre una copia temporal del fixture de librería y recorre con
 * Chromium el flujo que usa una persona: escanear, instalar y bancos (importar
 * y dejar un banco por defecto). Se ejecuta aparte (`npm run test:e2e`) porque
 * necesita los navegadores de Playwright y no corre en la suite normal.
 */

/** `dist-test/test/e2e` → raíz de `webapp`. */
const WEBAPP = path.resolve(__dirname, '..', '..', '..');
const REPO = path.resolve(WEBAPP, '..');
const SERVER_ENTRY = path.join(WEBAPP, 'dist', 'main.js');
const REPO_DLL = path.join(REPO, 'vst', 'fxbLoader.dll');
const FIXTURE_LIBRARY = path.join(WEBAPP, 'test', 'fixtures', 'vfx-library');
const OBXD_BANK = path.join(WEBAPP, 'test', 'fixtures', 'fxb', 'wam-obxd-factory.fxb');
const ARTIFACTS = path.join(WEBAPP, 'test-results');

const PLUGIN = 'OB-Xd';
const BANK = path.basename(OBXD_BANK);

/** Permite apuntar a una librería VFX real sin tocar el fixture. */
const LIBRARY_SOURCE = process.env['FXB_VFX_LIBRARY']?.trim() || FIXTURE_LIBRARY;

const skip = existsSync(REPO_DLL)
  ? false
  : `no está ${path.relative(process.cwd(), REPO_DLL)}; la prueba necesita la DLL real`;

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Puerto libre en loopback, reservado y liberado antes de arrancar el server. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(
  child: ChildProcess,
  url: string,
  logs: string[],
  deadlineMs = 30_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (child.exitCode !== null) {
      throw new Error(`el servidor terminó con ${child.exitCode}:\n${logs.join('')}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Todavía no escucha: se reintenta hasta el plazo.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`el servidor no respondió en ${deadlineMs} ms:\n${logs.join('')}`);
}

/** Espera a que el elemento exista y su texto case con el patrón. */
async function waitForText(page: Page, selector: string, text: string | RegExp): Promise<void> {
  await page.locator(selector, { hasText: text }).first().waitFor({ timeout: 20_000 });
}

/**
 * Espera a que el número de filas marcadas sea el esperado: los filtros se
 * aplican con debounce, así que el texto puede aparecer (render anterior) y
 * volverse a sustituir por el render según llega la respuesta del servidor.
 */
async function waitForRowCount(page: Page, selector: string, count: number): Promise<void> {
  const locator = page.locator(`${selector} tbody tr[data-row-id]`);
  if (await locator.count() !== count) {
    await locator.first().waitFor({ state: count === 0 ? 'detached' : 'visible', timeout: 20_000 });
  }
  if (await locator.count() !== count) {
    await page.waitForFunction(
      `document.querySelectorAll("${selector} tbody tr[data-row-id]").length === ${count}`,
      { timeout: 20_000 },
    );
  }
}

function pluginRow(page: Page): Locator {
  return page.locator('#plugins-table tbody tr').filter({ hasText: PLUGIN });
}

/** Despliega el menú «···» de la fila y pulsa la opción elegida. */
async function clickRowAction(
  row: Locator,
  action: 'toggle' | 'banks' | 'meta' | 'log',
): Promise<void> {
  await row.locator('[data-action="menu"]').click();
  await row.locator(`[data-action="${action}"]`).click();
}

/**
 * Empieza a acumular lo que la UI escribe en un elemento que se rellena con
 * `textContent` (`#batch-step`, `#batch-clock`). El observer guarda los nodos
 * añadidos y no el texto final: los eventos de un lote llegan dentro de la
 * misma tarea, así que leer `textContent` al final solo vería el último valor.
 * Se evalúa como cadena para no depender del lib DOM del proyecto.
 */
async function recordTexts(page: Page, id: string, key: string): Promise<void> {
  await page.evaluate(`
    (() => {
      const target = document.getElementById('${id}');
      if (target === null) throw new Error('la UI no tiene #${id}');
      const seen = [];
      window['${key}'] = seen;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.textContent !== null && node.textContent !== '') seen.push(node.textContent);
          }
        }
      }).observe(target, { childList: true, subtree: true });
    })()
  `);
}

async function texts(page: Page, key: string): Promise<string[]> {
  return (await page.evaluate(`window['${key}']`)) as string[];
}

async function resetTexts(page: Page, key: string): Promise<void> {
  await page.evaluate(`window['${key}'].length = 0`);
}

test(
  'recorre escaneo, instalación y bancos en el navegador contra el servidor real',
  { skip },
  async (t) => {
    assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);
    assert.ok(existsSync(OBXD_BANK), `falta el banco de prueba ${OBXD_BANK}`);
    assert.ok(existsSync(LIBRARY_SOURCE), `la librería no existe: ${LIBRARY_SOURCE}`);

    const temp = await mkdtemp(path.join(tmpdir(), 'fxb-e2e-'));
    const library = path.join(temp, 'library');
    // Nunca se toca el fixture: se trabaja sobre una copia.
    await cp(path.join(LIBRARY_SOURCE, 'plugs'), path.join(library, 'plugs'), { recursive: true });

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
      await rm(temp, { recursive: true, force: true });
    });

    await waitForServer(server, url, logs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));

    try {
      /* 1. Escaneo ------------------------------------------------------ */
      await page.goto(url);
      await page.waitForSelector('#scan-form');
      await page.fill('#library-root', library);
      await page.click('#scan-button');

      await waitForText(page, '#status', /3 plugin\(s\) encontrados/);
      await waitForText(page, '#summary-text', '0 de 3 con el cargador');
      assert.equal(await page.locator('#plugins-table tbody tr').count(), 3);

      const row = pluginRow(page);
      assert.equal(await row.count(), 1, `no hay fila para ${PLUGIN}`);
      assert.equal(await row.locator('[data-field="status"]').textContent(), 'sin cargador');
      assert.equal(await row.locator('[data-field="compatibility"]').textContent(), 'compatible');
      assert.equal(await row.locator('[data-action="toggle"]').textContent(), 'Poner cargador');

      /* 2. Instalación -------------------------------------------------- */
      await clickRowAction(row, 'toggle');
      await waitForText(page, '#status', `Cargador puesto en ${PLUGIN}.`);
      await waitForText(page, '#summary-text', '1 de 3 con el cargador');

      const installedRow = pluginRow(page);
      assert.equal(await installedRow.locator('[data-field="status"]').textContent(), 'con cargador');
      assert.equal(await installedRow.locator('[data-action="toggle"]').textContent(), 'Quitar cargador');

      // El disco lo confirma: el DLL copiado es el del repositorio.
      const pluginDir = path.join(library, 'plugs', PLUGIN);
      const copiedDll = await readFile(path.join(pluginDir, 'fxbLoader.dll'));
      assert.equal(sha256(copiedDll), sha256(await readFile(REPO_DLL)));

      /* 2b. Un plugin sin su DLL declarado queda bloqueado ------------ */
      // Se borra el binario que declara el vfxinfo de GrandPiano: el escaneo
      // debe marcarlo incompatible y deshabilitar Instalar.
      await rm(path.join(library, 'plugs', 'GrandPiano', 'GrandPiano', 'GrandPiano.dll'));
      await page.click('#scan-button');
      await waitForText(page, '#status', /1 incompatible/);

      const blockedRow = page.locator('#plugins-table tbody tr').filter({ hasText: 'GrandPiano' });
      assert.equal(
        await blockedRow.locator('[data-field="compatibility"]').textContent(),
        'incompatible',
      );
      assert.equal(await blockedRow.locator('[data-action="toggle"]').isDisabled(), true);

      /* 3. Bancos: abrir, importar y fijar el banco por defecto --------- */
      // Sin abrir nada, la columna ya dice que el plugin no tiene bancos, y la
      // pastilla abre el cajón igual que la opción del menú de la fila.
      const banksPill = installedRow.locator('button[data-field="banks"]');
      assert.equal(await banksPill.textContent(), 'sin bancos');
      await banksPill.click();
      await page.locator('#banks').waitFor({ state: 'visible' });
      await waitForText(page, '#banks-rows', 'La carpeta de bancos está vacía');
      await waitForText(page, '#banks-plugin', PLUGIN);

      const presetsDir = await page.locator('#banks-presets').textContent();
      assert.equal(path.basename(presetsDir ?? ''), 'presets');

      // El formulario de importación vive en un <details> plegado.
      await page.locator('details.import > summary').click();
      await page.locator('#import-paths').waitFor({ state: 'visible' });
      await page.fill('#import-paths', OBXD_BANK);
      await page.click('#import-button');
      await waitForText(page, '#banks-status', '1 banco(s) importados.');
      await waitForText(page, '#import-results', 'importado');
      // La pastilla se refresca con lo que acaba de leer el panel: cuenta el
      // banco importado y lo lista en el tooltip, sin volver a escanear.
      assert.equal(await installedRow.locator('[data-field="banks"]').textContent(), '1 banco');
      assert.ok(
        ((await installedRow.locator('[data-field="banks"]').getAttribute('title')) ?? '').includes(
          BANK,
        ),
      );
      assert.equal(await page.locator('#import-results .import-result.rejected').count(), 0);

      // La carpeta escaneada y el banco importado quedan como sugerencias.
      assert.deepEqual(
        (await page.evaluate(
          "Array.from(document.querySelectorAll('#library-root-recents option')).map((option) => option.getAttribute('value'))",
        )) as string[],
        [library],
      );
      const chip = page.locator('#recent-banks .recent-chip');
      assert.equal(await chip.count(), 1);
      assert.equal(await chip.textContent(), BANK);
      await page.fill('#import-paths', '');
      await chip.click();
      assert.equal(await page.inputValue('#import-paths'), OBXD_BANK);

      // «Olvidar» vacía solo los bancos recientes: la carpeta de la librería
      // sigue en su <datalist> y el cuadro conserva lo escrito.
      await page.locator('#recent-banks .recent-clear').click();
      await waitForText(page, '#banks-status', 'Bancos recientes olvidados.');
      assert.equal(await page.locator('#recent-banks .recent-chip').count(), 0);
      assert.equal(await page.locator('#recent-banks').isHidden(), true);
      assert.equal(await page.inputValue('#import-paths'), OBXD_BANK);
      assert.deepEqual(
        (await page.evaluate(
          "Array.from(document.querySelectorAll('#library-root-recents option')).map((option) => option.getAttribute('value'))",
        )) as string[],
        [library],
        'el historial de carpetas no se toca',
      );
      assert.equal(
        await page.evaluate(`localStorage.getItem('fxbLoader.recentBanks')`),
        null,
        'solo se borra la clave de bancos recientes',
      );
      assert.notEqual(
        await page.evaluate(`localStorage.getItem('fxbLoader.recentLibraryRoots')`),
        null,
      );

      const bankRow = page.locator('#banks-rows tr').filter({ hasText: BANK });
      assert.equal(await bankRow.count(), 1);
      assert.equal(await bankRow.locator('[data-field="bank-name"]').textContent(), BANK);
      assert.equal(
        sha256(await readFile(path.join(pluginDir, 'presets', BANK))),
        sha256(await readFile(OBXD_BANK)),
      );

      // Sin respaldo `.orig` no se puede restaurar ni descartar: los botones
      // están apagados.
      assert.equal(await page.locator('#default-restore').isDisabled(), true);
      assert.equal(await page.locator('#default-discard').isDisabled(), true);

      await page.selectOption('#default-bank', BANK);
      await page.check('#load-fxb');
      await page.click('#default-save');
      await waitForText(page, '#banks-status', `Banco por defecto de ${PLUGIN}: ${BANK}.`);
      await waitForText(page, '#banks-rows', 'por defecto');

      const config = (await readFile(path.join(pluginDir, 'fxbLoader.config'))).toString('latin1');
      assert.match(config, new RegExp(`^defaultFxbName = ${BANK.replace(/\./g, '\\.')}\\r?$`, 'm'));
      assert.match(config, /^loadFxbBank = yes\r?$/m);
      assert.match(config, /^programDirName = presets\r?$/m);

      // Un 409 al guardar el banco por defecto tampoco se sustituye por un texto
      // fijo: la vista enseña el mensaje del API y aplica la configuración que
      // vino en el error. Se reescribe el mismo archivo por detrás para mover su
      // mtime sin cambiar el contenido, así el resto del recorrido sigue igual.
      const configPath = path.join(pluginDir, 'fxbLoader.config');
      await writeFile(configPath, await readFile(configPath));
      await page.click('#default-save');
      await waitForText(page, '#banks-status', 'El archivo cambió en disco desde la última lectura');
      assert.match(
        (await page.locator('#banks-status').textContent()) ?? '',
        /revisa los valores actualizados/,
      );
      assert.equal(await page.inputValue('#default-bank'), BANK);

      /* 3b. Convertir el banco por defecto en el sitio ------------------ */
      const originalBank = parseFxbBank(await readFile(OBXD_BANK)).bank;
      assert.ok(originalBank, 'el fixture de OB-Xd no se pudo parsear');

      // El botón pide confirmación porque reescribe el banco en su archivo.
      page.once('dialog', (dialog) => void dialog.accept());
      await page.click('#default-convert');
      await waitForText(page, '#banks-status', /campo\(s\) a little-endian/);
      await waitForText(page, '#banks-status', `${BANK}.orig`);

      const bankPath = path.join(pluginDir, 'presets', BANK);
      const backupPath = path.join(pluginDir, 'presets', `${BANK}.orig`);
      // El respaldo guarda el original y el banco conserva nombre y ruta.
      assert.equal(sha256(await readFile(backupPath)), sha256(await readFile(OBXD_BANK)));
      const convertedBank = parseFxbBank(await readFile(bankPath));
      assert.deepEqual(convertedBank.issues, []);
      assert.equal(convertedBank.bank?.endianness, 'little');
      // Solo cambia el orden: el tipo, el chunk opaco y los programas quedan igual.
      assert.equal(convertedBank.bank?.kind, originalBank.kind);
      assert.equal(convertedBank.bank?.chunkSize, originalBank.chunkSize);
      assert.equal(convertedBank.bank?.numPrograms, originalBank.numPrograms);
      assert.equal(await page.locator('#banks-rows tr.is-default').count(), 1);

      // La configuración no cambia: el banco por defecto sigue siendo el mismo.
      assert.match(
        (await readFile(path.join(pluginDir, 'fxbLoader.config'))).toString('latin1'),
        new RegExp(`^defaultFxbName = ${BANK.replace(/\./g, '\\.')}\\r?$`, 'm'),
      );

      /* 3c. Restaurar el banco desde el respaldo ------------------------ */
      assert.equal(await page.locator('#default-restore').isDisabled(), false);

      // El botón también pide confirmación: reemplaza el banco que carga la DLL.
      page.once('dialog', (dialog) => void dialog.accept());
      await page.click('#default-restore');
      await waitForText(page, '#banks-status', /restaurado desde/);
      await waitForText(page, '#banks-status', 'el respaldo sigue intacto');

      // El banco vuelve a ser el original y el respaldo no se consumió.
      assert.equal(sha256(await readFile(bankPath)), sha256(await readFile(OBXD_BANK)));
      assert.equal(sha256(await readFile(backupPath)), sha256(await readFile(OBXD_BANK)));
      assert.equal(
        parseFxbBank(await readFile(bankPath)).bank?.endianness,
        originalBank.endianness,
      );
      assert.equal(await page.locator('#banks-rows tr.is-default').count(), 1);

      // Restaurar otra vez no escribe nada: el banco ya es el respaldo.
      page.once('dialog', (dialog) => void dialog.accept());
      await page.click('#default-restore');
      await waitForText(page, '#banks-status', 'no había nada que restaurar');
      assert.equal(sha256(await readFile(bankPath)), sha256(await readFile(OBXD_BANK)));
      assert.equal(sha256(await readFile(backupPath)), sha256(await readFile(OBXD_BANK)));

      /* 3d. Descartar el respaldo .orig -------------------------------- */
      assert.equal(await page.locator('#default-discard').isDisabled(), false);

      let confirmText = '';
      page.once('dialog', (dialog) => {
        confirmText = dialog.message();
        void dialog.accept();
      });
      await page.click('#default-discard');
      await waitForText(page, '#banks-status', /enviado a la .*Papelera/);
      assert.equal(
        confirmText.includes(`${BANK}.orig`),
        true,
        `la confirmación debe nombrar el respaldo: ${confirmText}`,
      );
      assert.match(confirmText, /a la papelera del sistema/);
      assert.match(confirmText, /podrás recuperarlo/);

      // El respaldo sale de la carpeta y el banco sigue exactamente igual; el
      // mensaje dice en qué papelera quedó y cómo recuperarlo.
      const discardStatus = (await page.locator('#banks-status').textContent()) ?? '';
      assert.match(discardStatus, /Papelera de reciclaje|Papelera/);
      assert.match(discardStatus, /recuperarlo|Restaurar|Volver a poner/);
      assert.equal(existsSync(backupPath), false, 'el .orig ya no está en la carpeta del plugin');
      assert.equal(sha256(await readFile(bankPath)), sha256(await readFile(OBXD_BANK)));
      assert.equal(await page.locator('#default-discard').isDisabled(), true);
      assert.equal(await page.locator('#default-restore').isDisabled(), true);
      assert.equal(await page.locator('#banks-rows tr.is-default').count(), 1);

      /* 3e. Catálogo del plugin: leer, guardar y releer ---------------- */
      // Los paneles son cajones: el de bancos tapa la fila hasta que se cierra.
      await page.click('#banks-close');
      await page.locator('#banks').waitFor({ state: 'hidden' });
      // El escaneo también cuenta los bancos: tras releer la librería la fila
      // sigue diciendo «1 banco», sin abrir el panel.
      await page.click('#scan-button');
      await waitForText(page, '#status', /3 plugin\(s\) encontrados/);
      assert.equal(await pluginRow(page).locator('[data-field="banks"]').textContent(), '1 banco');
      // La pastilla de la columna abre el cajón del catálogo sin pasar por «···».
      const metaPill = pluginRow(page).locator('button[data-field="meta"]');
      assert.equal(await metaPill.evaluate((el) => el.tagName), 'BUTTON');
      await metaPill.click();
      await page.locator('#meta').waitFor({ state: 'visible' });
      await page.locator('#drawer-backdrop').waitFor({ state: 'visible' });
      await waitForText(page, '#meta-plugin', PLUGIN);
      // El panel dice de dónde salen los valores y que falta el id: el fixture
      // trae `name` en el vfxinfo pero no `id`, y sin ambos no se puede guardar.
      await waitForText(page, '#meta-origin', /no trae id/);
      // La tabla dice que ese plugin aún no tiene catálogo, sin abrir el panel.
      assert.equal(await pluginRow(page).locator('[data-field="meta"]').textContent(), 'falta');
      assert.equal(await page.inputValue('#meta-name'), 'OB-Xd');
      assert.equal(await page.inputValue('#meta-id'), '');
      assert.equal(await page.locator('#meta-save').isDisabled(), false);

      await page.fill('#meta-id', 'OBXd');
      await page.fill('#meta-name', 'OB-Xd E2E');
      await page.fill('#meta-vendor', 'discoDSP');
      await page.fill('#meta-notes', 'Banco de fábrica');
      await page.fill('#meta-extended', '{ "family": "synth" }');
      await page.click('#meta-save');
      await waitForText(page, '#meta-status', 'Catálogo guardado.');
      // Guardarlo actualiza la columna de la fila; no hace falta volver a escanear.
      assert.equal(await pluginRow(page).locator('[data-field="meta"]').textContent(), 'presente');

      // El archivo queda en el directorio del plugin con lo que se escribió.
      const metaPath = path.join(pluginDir, 'fxbLoader.meta.json');
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as {
        common: { id: string; name: string; vendor: string; notes: string };
        extended: Record<string, unknown>;
        updated: string;
      };
      assert.equal(meta.common.id, 'OBXd');
      assert.equal(meta.common.name, 'OB-Xd E2E');
      assert.equal(meta.common.vendor, 'discoDSP');
      assert.equal(meta.common.notes, 'Banco de fábrica');
      assert.deepEqual(meta.extended, { family: 'synth' });
      assert.match(meta.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.equal(await page.locator('#meta-path').textContent(), metaPath);

      // Un 409 del API tampoco se sustituye por un texto fijo: la vista enseña
      // el mensaje del servidor y relee el archivo para no guardar con un
      // `mtimeMs` viejo.
      const external = {
        ...meta,
        common: { ...meta.common, notes: 'Cambiado fuera de la app' },
      };
      await writeFile(metaPath, JSON.stringify(external, null, 2) + '\n', 'utf8');
      await page.fill('#meta-notes', 'Guardado que llega tarde');
      await page.click('#meta-save');
      await waitForText(page, '#meta-status', 'El archivo propio cambió en disco desde la última lectura');
      assert.match((await page.locator('#meta-status').textContent()) ?? '', /vuelve a guardar/);
      assert.equal(await page.inputValue('#meta-notes'), 'Cambiado fuera de la app');

      // Un 400 de validación llega con su `message` y la lista de `issues`; el
      // estado los pinta debajo (su CSS conserva los saltos de línea).
      await page.fill('#meta-notes', 'x'.repeat(256));
      await page.click('#meta-save');
      await waitForText(page, '#meta-status', 'Metadatos no válidos');
      assert.equal(
        await page.locator('#meta-status').textContent(),
        'Metadatos no válidos\ncommon.notes: 256 caracteres; el máximo es 255',
      );

      // «Descartar cambios» vuelve a lo guardado sin escribir nada, y con el
      // archivo ya en disco la nota de origen desaparece.
      await page.fill('#meta-name', 'Sin guardar');
      await page.click('#meta-reload');
      await page.waitForFunction(`document.querySelector('#meta-status').textContent === ''`);
      assert.equal(await page.inputValue('#meta-name'), 'OB-Xd E2E');
      assert.equal(await page.locator('#meta-origin').textContent(), '');
      assert.equal(
        (JSON.parse(await readFile(metaPath, 'utf8')) as { common: { name: string } }).common.name,
        'OB-Xd E2E',
      );

      await page.click('#meta-close');
      assert.equal(await page.locator('#meta').isHidden(), true);

      // El log del plugin: ruta, resumen, entradas y rotados, desde su propio cajón.
      await pluginRow(page).locator('[data-action="menu"]').click();
      await pluginRow(page).locator('[data-action="log"]').click();
      await waitForText(page, '#log-path', /fxbLoader\.log$/);

      // El recorrido deja cinco operaciones en el historial: poner el cargador,
      // importar el banco, convertirlo, restaurarlo y descartar el respaldo. La
      // tabla se contrasta con el archivo, no con un número fijo: si una de esas
      // operaciones deja de registrarse, el test lo sigue detectando.
      const logEntries = (await readFile(path.join(pluginDir, 'fxbLoader.log'), 'utf8'))
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => {
          const match = line.match(/^\[([^\]]+)\] \[([^\]]+)\] (.*)$/);
          return {
            timestamp: match?.[1] ?? '',
            action: match?.[2] ?? '',
            summary: match?.[3] ?? '',
          };
        });
      assert.deepEqual(
        logEntries.map((entry) => entry.action),
        ['install', 'import-banks', 'convert-bank', 'restore-bank', 'discard-backup'],
        'faltó registrar alguna operación del recorrido',
      );

      // La tabla puede pintar una fila decorativa vacía; el estado se mide
      // solo con los registros reales.
      const logRows = (): Promise<number> =>
        page.locator('#log-table tbody tr:not(.table-empty-row)').count();
      const logActions = (): Promise<string[]> =>
        page.locator('#log-table tbody td.table-action').allTextContents();
      // Mismo comparador que la tabla: fecha descendente y, a igual marca, el
      // orden del archivo (el sort de la tabla es estable).
      const newestFirst = [...logEntries]
        .map((entry, index) => ({ entry, index }))
        .sort(
          (a, b) =>
            Date.parse(b.entry.timestamp) - Date.parse(a.entry.timestamp) || a.index - b.index,
        )
        .map((item) => item.entry.action);

      await waitForText(page, '#log-table tbody', /Instalado fxbLoader\.dll/);
      assert.equal(await logRows(), logEntries.length);
      assert.deepEqual(
        await logActions(),
        newestFirst,
        'la tabla debe abrir con la entrada más reciente primero',
      );
      assert.equal(await page.locator('#log-table th').count(), 5, 'la tabla añade una columna sin título para acciones');
      assert.equal(await page.locator('#log-table thead th.table-actions-heading').textContent(), '');
      assert.equal(await page.locator('#log-table .row-menu-btn').count(), logEntries.length);
      await page.locator('#log-table .row-menu-btn').first().click();
      assert.equal(await page.locator('#log-table .row-menu-dropdown:not([hidden])').count(), 1);
      assert.equal(await page.locator('#log-table .row-menu-dropdown:not([hidden]) [data-action="view-record"]').textContent(), 'Ver registro');
      await page.locator('#log-table .row-menu-dropdown:not([hidden]) [data-action="view-record"]').click();
      assert.equal(await page.locator('#log-table .row-menu-dropdown:not([hidden])').count(), 0);
      await page.locator('#log-record-detail').waitFor({ state: 'visible' });
      assert.match((await page.locator('#log-record-detail-title').textContent()) ?? '', /^Registro · /);
      assert.equal(await page.locator('#log-record-detail-fields .log-record-field').count(), 5);
      assert.equal(await page.locator('#log-record-detail-fields dt').allTextContents().then(labels => labels.join('|')), 'Fecha y hora|Acción|Resumen|Detalle|Línea original');
      assert.equal(
        await page.locator('#log-record-detail-fields dd').nth(4).textContent(),
        `[${logEntries.find(entry => entry.action === newestFirst[0])?.timestamp}] ` +
          `[${newestFirst[0]}] ${logEntries.find(entry => entry.action === newestFirst[0])?.summary}`,
      );
      assert.equal(await logRows(), logEntries.length, 'el detalle conserva el historial visible');
      await page.locator('#log-record-detail-close').click();
      assert.equal(await page.locator('#log-record-detail').isHidden(), true);
      assert.equal(await page.locator('#log-record-detail-fields .log-record-field').count(), 0);
      assert.equal(await page.evaluate(`document.activeElement?.getAttribute('aria-label')`), 'Acciones del registro');
      assert.equal(await page.locator('#log-table [aria-label="Buscar en la tabla"]').count(), 1);
      assert.equal(await page.locator('#log-table .pagination-select').inputValue(), '100');
      assert.equal(await page.locator('#log-table th[aria-sort="descending"]').count(), 1);

      // La búsqueda recorre acción y resumen: «instalado» solo encaja con la
      // primera operación, y el filtro vacío devuelve todas las entradas.
      await page.locator('#log-table [aria-label="Buscar en la tabla"]').fill('instalado');
      assert.equal(await logRows(), 1);
      assert.deepEqual(await logActions(), ['install']);
      assert.match(
        (await page.locator('#log-table tbody').textContent()) ?? '',
        /Instalado fxbLoader\.dll/,
      );
      await page.locator('#log-table [aria-label="Buscar en la tabla"]').fill('no existe');
      assert.equal(await logRows(), 0);
      assert.equal(await page.locator('#log-table .table-empty').isVisible(), true);
      await page.locator('#log-table [aria-label="Buscar en la tabla"]').fill('');
      assert.equal(await logRows(), logEntries.length);

      // Orden ascendente: el archivo tal cual se escribió.
      await page.locator('#log-table th button').first().click();
      assert.equal(await page.locator('#log-table th[aria-sort="ascending"]').count(), 1);
      assert.deepEqual(await logActions(), logEntries.map((entry) => entry.action));
      assert.ok(
        ((await page.locator('#log-summary').textContent()) ?? '').includes(
          `${logEntries.length} entrada(s)`,
        ),
      );
      assert.equal(await page.locator('#log-rotated').textContent(), 'Sin archivos rotados.');
      await page.locator('#log-close').click();
      assert.equal(await page.locator('#log-drawer').isHidden(), true);

      /* 4. Lote completo con progreso en caliente ----------------------- */
      // La vista ya no orquesta el lote: lo pide a `POST /library/batch/stream`
      // y pinta el plugin en curso a medida que el servidor lo cuenta.
      assert.equal(await page.locator('#batch-progress').isHidden(), true);
      assert.equal(await page.locator('#batch-step').isHidden(), true);
      assert.equal(await page.locator('#batch-clock').isHidden(), true);

      await recordTexts(page, 'batch-step', '__batchSteps');
      await recordTexts(page, 'batch-clock', '__batchClock');
      await page.locator('#uninstall-all').click();
      await waitForText(page, '#batch-status', /sin cargador/);
      await waitForText(page, '#summary-text', '0 de 3 con el cargador');
      await waitForText(page, '#batch-status', /sin cargador/);
      assert.equal(
        await pluginRow(page).locator('[data-field="status"]').textContent(),
        'sin cargador',
      );
      // La barra de progreso solo vive mientras dura el lote.
      assert.equal(await page.locator('#batch-progress').isHidden(), true);
      assert.equal(
        await page.locator('#plugins-table tbody tr.batch-running, #plugins-table tbody tr.batch-done').count(),
        0,
        'las filas quedan sin marcar al terminar',
      );
      assert.equal(await page.locator('#batch-step').isHidden(), true);
      // El reloj solo vive mientras dura el lote, igual que la barra.
      assert.equal(await page.locator('#batch-clock').isHidden(), true);
      assert.equal(await page.locator('#batch-clock').textContent(), '');

      // El reloj contó el tiempo y, al cerrar el primer plugin, ya estimaba.
      const clockTexts = await texts(page, '__batchClock');
      assert.ok(
        clockTexts.some((text) => /^\d+(,\d)? s transcurridos · /.test(text)),
        `la UI no pintó el reloj del lote: ${clockTexts.join(' | ')}`,
      );
      assert.ok(
        clockTexts.some((text) => text.includes('restantes')),
        `la estimación no apareció en el reloj: ${clockTexts.join(' | ')}`,
      );

      // La vista pintó los pasos internos que mandó el servidor.
      const uninstallSteps = await texts(page, '__batchSteps');
      assert.ok(
        uninstallSteps.includes('paso 1 de 3 · restaurando vfxinfo.txt'),
        `la UI no pintó los pasos de la desinstalación: ${uninstallSteps.join(' | ')}`,
      );
      assert.ok(uninstallSteps.includes('paso 3 de 3 · borrando fxbLoader.config'));
      assert.ok(
        uninstallSteps.every((text) => /^paso \d de 3 · /.test(text)),
        `paso con formato inesperado: ${uninstallSteps.join(' | ')}`,
      );

      await resetTexts(page, '__batchSteps');
      await resetTexts(page, '__batchClock');
      await page.locator('#install-all').click();
      await waitForText(page, '#batch-status', /con cargador/);
      await waitForText(page, '#summary-text', '2 de 3 con el cargador');

      const installSteps = await texts(page, '__batchSteps');
      assert.ok(
        installSteps.includes('paso 1 de 5 · respaldando vfxinfo.txt'),
        `la UI no pintó los pasos de la instalación: ${installSteps.join(' | ')}`,
      );
      assert.ok(installSteps.includes('paso 5 de 5 · creando la carpeta de presets'));
      assert.equal(await page.locator('#batch-step').isHidden(), true, 'el paso no se queda al terminar');
      assert.equal(await page.locator('#batch-step').textContent(), '');
      assert.equal(await page.locator('#batch-clock').isHidden(), true, 'el reloj no se queda al terminar');
      assert.equal(await page.locator('#batch-clock').textContent(), '');
      assert.equal(
        await pluginRow(page).locator('[data-field="status"]').textContent(),
        'con cargador',
      );

      assert.equal(
        requests.some((url) => url.endsWith('/library/batch/stream')),
        true,
        'el lote debe pedirse por el endpoint de progreso',
      );

      /* Un 400 del API se ve con su mensaje ---------------------------- */
      // Al final, para no ensuciar el historial de rutas recientes que ya se
      // comprobó: la vista enseña el mensaje del servidor, no un texto fijo.
      await page.fill('#library-root', 'plugs');
      await page.click('#scan-button');
      await waitForText(page, '#status', 'libraryRoot debe ser una ruta absoluta: "plugs"');
      assert.equal(await page.locator('#root-warning').isVisible(), true);
      assert.deepEqual(pageErrors, [], `errores de JavaScript en la página: ${pageErrors.join(' | ')}`);
    } catch (error) {
      // La captura y los logs del servidor son lo único útil si falla en CI.
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-failure.png'), fullPage: true });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

/**
 * El tope del servidor se prueba de verdad en `library.batch.test.ts`; aquí se
 * comprueba la otra mitad: que la vista no manda un lote por encima del tope y
 * que el avance de las peticiones resultantes cabe en una sola barra.
 *
 * El escaneo y el lote se responden desde la prueba con más plugins de los que
 * caben en una petición: instalar 501 de verdad tardaría minutos y lo que se
 * quiere ver es el troceado de la vista, no el instalador (que ya recorre el
 * test de arriba contra el servidor real).
 */
test(
  'trocea «Poner cargador a todos» por encima del tope y pinta una sola barra',
  { skip },
  async (t) => {
    assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);

    const total = MAX_PLUGINS_PER_BATCH + 1;
    const names = Array.from(
      { length: total },
      (_, index) => `Synth ${String(index).padStart(3, '0')}`,
    );
    const batches: string[][] = [];

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
    });

    await waitForServer(server, url, logs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.route('**/library/scan', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          libraryRoot: 'C:\\Fake\\Library',
          plugsPath: 'C:\\Fake\\Library\\plugs',
          loader: {
            path: 'C:\\Fake\\fxbLoader.dll',
            valid: true,
            bitness: 32,
            machine: 'i386',
            issues: [],
          },
          plugins: names.map((name) => ({
            name,
            path: `C:\\Fake\\Library\\plugs\\${name}`,
            hasLoader: false,
            hasVfxinfo: true,
            hasMeta: false,
            pluginName: null,
            warnings: [],
            compatible: true,
            compatibilityIssues: [],
            banks: { count: 0, names: [] },
          })),
        }),
      }),
    );

    await page.route('**/library/batch/stream', async (route) => {
      const body = route.request().postDataJSON() as { plugins: string[] };
      batches.push(body.plugins);
      // El segundo trozo se retrasa a propósito: mientras espera se puede leer
      // la barra y comprobar que sigue contando desde el principio del lote.
      if (batches.length === 2) await new Promise((resolve) => setTimeout(resolve, 700));

      const events = [
        { type: 'start', action: 'add', dryRun: false, total: body.plugins.length, plugins: body.plugins },
        ...body.plugins.flatMap((name, index) => [
          { type: 'plugin', index, total: body.plugins.length, name, status: 'running', message: null },
          // Un paso interno por petición: el flujo real los manda entre el
          // `running` y el estado final.
          ...(index === body.plugins.length - 1
            ? [
                {
                  type: 'step',
                  index,
                  total: body.plugins.length,
                  name,
                  step: 'copy',
                  stepIndex: 1,
                  steps: 5,
                },
              ]
            : []),
          { type: 'plugin', index, total: body.plugins.length, name, status: 'added', message: null },
        ]),
        {
          type: 'end',
          result: {
            action: 'add',
            dryRun: false,
            total: body.plugins.length,
            succeeded: body.plugins.length,
            failed: 0,
            results: body.plugins.map((name) => ({ name, status: 'added', message: null })),
          },
        },
      ];

      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
        body: events.map((event) => `${JSON.stringify(event)}\n`).join(''),
      });
    });

    try {
      await page.goto(url);
      await page.waitForSelector('#scan-form');
      await page.fill('#library-root', 'C:\\Fake\\Library');
      await page.click('#scan-button');
      await waitForText(page, '#summary-text', `0 de ${total} con el cargador`);

      await page.locator('#install-all').click();

      // La segunda petición ya está en vuelo y la barra no se reinició: sigue
      // en el plugin 501 de 501 y conserva el máximo del lote completo.
      await waitForText(page, '#batch-status', `Poniendo el cargador ${total} de ${total}…`);
      assert.equal(await page.locator('#batch-progress').isHidden(), false);
      assert.equal(await page.locator('#batch-clock').isHidden(), false, 'el reloj acompaña al lote troceado');
      assert.match(
        (await page.locator('#batch-clock').textContent()) ?? '',
        /^\d+(,\d)? s transcurridos · /,
        'el reloj debe seguir contando entre peticiones',
      );
      assert.equal(await page.locator('#batch-progress').getAttribute('max'), String(total));
      assert.equal(
        await page.locator('#batch-progress').getAttribute('value'),
        String(MAX_PLUGINS_PER_BATCH),
      );
      assert.equal(await page.locator('#batch-progress').count(), 1, 'una sola barra para el lote');

      await waitForText(page, '#batch-status', `${total} plugin(s) con cargador.`);
      assert.equal(await page.locator('#batch-progress').isHidden(), true);
      assert.equal(await page.locator('#batch-step').isHidden(), true);
      assert.equal(await page.locator('#batch-step').textContent(), '');
      assert.equal(await page.locator('#batch-clock').isHidden(), true);
      assert.equal(await page.locator('#batch-clock').textContent(), '');

      assert.equal(batches.length, 2, 'un plugin de más abre una segunda petición');
      assert.ok(
        batches.every((batch) => batch.length <= MAX_PLUGINS_PER_BATCH),
        `alguna petición supera el tope: ${batches.map((batch) => batch.length).join(', ')}`,
      );
      assert.deepEqual(batches.flat(), names, 'los trozos cubren el lote en orden');
      assert.deepEqual(pageErrors, [], `errores de JavaScript en la página: ${pageErrors.join(' | ')}`);
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-chunks-failure.png'), fullPage: true });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

/**
 * «Reanudar» tras cancelar: la vista ofrece el botón con lo que quedó sin
 * confirmar y, al pulsarlo, manda **solo** esa lista, en el mismo orden y con
 * la misma acción.
 *
 * El lote se responde desde la prueba y la primera petición se queda en vuelo a
 * propósito: así se pulsa Cancelar sin depender de lo que tarde un instalador
 * real, y el escaneo posterior puede decir que el servidor terminó el plugin
 * que tenía entre manos (Alpha), que es lo que la vista mira para no
 * reinstalarlo y no comerse un 409. La segunda petición, la del botón, sí
 * responde con el flujo NDJSON completo.
 */
test(
  'cancelar un lote y reanudar solo los plugins sin confirmar',
  { skip },
  async (t) => {
    assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);

    const names = ['Alpha', 'Beta', 'Gamma'];
    /** Cuerpos de las peticiones de lote, en orden. */
    const batches: string[][] = [];
    /** Plugins que el escaneo falso anuncia como instalados. */
    let installed = new Set<string>();

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
    });

    await waitForServer(server, url, logs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.route('**/library/scan', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          libraryRoot: 'C:\\Fake\\Library',
          plugsPath: 'C:\\Fake\\Library\\plugs',
          loader: {
            path: 'C:\\Fake\\fxbLoader.dll',
            valid: true,
            bitness: 32,
            machine: 'i386',
            issues: [],
          },
          plugins: names.map((name) => ({
            name,
            path: `C:\\Fake\\Library\\plugs\\${name}`,
            hasLoader: installed.has(name),
            hasVfxinfo: true,
            pluginName: null,
            warnings: [],
            compatible: true,
            compatibilityIssues: [],
            banks: { count: 0, names: [] },
          })),
        }),
      }),
    );

    // La primera petición se queda sin responder hasta que la prueba la suelta.
    let release: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;

    await page.route('**/library/batch/stream', async (route) => {
      const body = route.request().postDataJSON() as { plugins: string[] };
      batches.push(body.plugins);

      if (batches.length === 1) {
        held = true;
        await holding;
        // El fetch ya se abortó: el cuerpo vacío no llega a la página.
        await route
          .fulfill({ status: 200, contentType: 'application/x-ndjson; charset=utf-8', body: '' })
          .catch(() => undefined);
        return;
      }

      for (const name of body.plugins) installed.add(name);
      const events = [
        {
          type: 'start',
          action: 'add',
          dryRun: false,
          total: body.plugins.length,
          plugins: body.plugins,
        },
        ...body.plugins.flatMap((name, index) => [
          {
            type: 'plugin',
            index,
            total: body.plugins.length,
            name,
            status: 'running',
            message: null,
          },
          {
            type: 'plugin',
            index,
            total: body.plugins.length,
            name,
            status: 'added',
            message: null,
          },
        ]),
        {
          type: 'end',
          result: {
            action: 'add',
            dryRun: false,
            total: body.plugins.length,
            succeeded: body.plugins.length,
            failed: 0,
            results: body.plugins.map((name) => ({
              name,
              status: 'added',
              message: null,
            })),
          },
        },
      ];

      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson; charset=utf-8',
        body: events.map((event) => `${JSON.stringify(event)}\n`).join(''),
      });
    });

    try {
      await page.goto(url);
      await page.waitForSelector('#scan-form');
      await page.fill('#library-root', 'C:\\Fake\\Library');
      await page.click('#scan-button');
      await waitForText(page, '#summary-text', `0 de ${names.length} con el cargador`);

      await page.locator('#install-all').click();
      await waitForText(page, '#batch-status', `Poniendo el cargador 1 de ${names.length}…`);

      for (let attempt = 0; attempt < 200 && !held; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(held, true, 'la petición del lote debe haber salido');

      // El servidor terminó Alpha antes de que se cerrara la respuesta.
      installed = new Set(['Alpha']);
      await page.click('#batch-cancel');
      await waitForText(
        page,
        '#batch-status',
        /Lote cancelado: 0 de 3 con cargador; 3 sin confirmar\./,
      );

      // Alpha ya está instalado, así que solo quedan dos por reanudar.
      await page.locator('#batch-resume').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#batch-resume').textContent(), 'Reanudar 2 sin confirmar');
      assert.equal(await page.locator('#batch-resume').isEnabled(), true);

      release();
      await page.click('#batch-resume');
      await waitForText(page, '#batch-status', '2 plugin(s) con cargador.');

      assert.deepEqual(
        batches,
        [names, ['Beta', 'Gamma']],
        'reanudar manda solo los pendientes, en el orden del lote',
      );
      assert.equal(
        await page.locator('#batch-resume').isHidden(),
        true,
        'sin nada pendiente el botón desaparece',
      );
      assert.deepEqual(pageErrors, [], `errores de JavaScript en la página: ${pageErrors.join(' | ')}`);
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-resume-failure.png'), fullPage: true });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

/**
 * Importar más bancos que el tope por petición: la vista manda la lista en
 * trozos de `MAX_BANKS_PER_REQUEST` y acumula el resultado de cada archivo en
 * una sola lista, en el orden del cuadro de texto.
 *
 * Se hace contra el servidor real y con copias del banco de OB-Xd, que son
 * compatibles con el plugin instalado: lo que se comprueba es el troceado y la
 * acumulación de la vista, no el validador (que tiene sus propios tests).
 */
test(
  'trocea la importación de bancos por encima del tope y acumula el resultado',
  { skip },
  async (t) => {
    assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);
    assert.ok(existsSync(OBXD_BANK), `falta el banco de prueba ${OBXD_BANK}`);
    assert.ok(existsSync(LIBRARY_SOURCE), `la librería no existe: ${LIBRARY_SOURCE}`);

    const total = MAX_BANKS_PER_REQUEST + 1;
    const temp = await mkdtemp(path.join(tmpdir(), 'fxb-e2e-import-'));
    const library = path.join(temp, 'library');
    const banksDir = path.join(temp, 'banks');
    await cp(path.join(LIBRARY_SOURCE, 'plugs'), path.join(library, 'plugs'), { recursive: true });
    await mkdir(banksDir, { recursive: true });

    const bankPaths = Array.from({ length: total }, (_, index) => {
      const name = `banco-${String(index).padStart(2, '0')}.fxb`;
      return path.join(banksDir, name);
    });
    for (const bankPath of bankPaths) await cp(OBXD_BANK, bankPath);

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
      await rm(temp, { recursive: true, force: true });
    });

    await waitForServer(server, url, logs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    /** Rutas enviadas en cada petición de importación, en orden. */
    const importRequests: string[][] = [];
    page.on('request', (request) => {
      if (!request.url().endsWith('/library/banks/import/stream')) return;
      const body = request.postDataJSON() as { sourcePaths?: string[] };
      if (Array.isArray(body.sourcePaths)) importRequests.push(body.sourcePaths);
    });

    try {
      await page.goto(url);
      await page.waitForSelector('#scan-form');
      await page.fill('#library-root', library);
      await page.click('#scan-button');
      await waitForText(page, '#status', /3 plugin\(s\) encontrados/);

      const row = pluginRow(page);
      await clickRowAction(row, 'toggle');
      await waitForText(page, '#status', `Cargador puesto en ${PLUGIN}.`);

      await clickRowAction(pluginRow(page), 'banks');
      await page.locator('#banks').waitFor({ state: 'visible' });
      await waitForText(page, '#banks-rows', 'La carpeta de bancos está vacía');

      await page.locator('details.import > summary').click();
      await page.locator('#import-paths').waitFor({ state: 'visible' });
      await page.fill('#import-paths', bankPaths.join('\n'));
      await page.click('#import-button');

      await waitForText(page, '#banks-status', `${total} banco(s) importados.`);

      assert.deepEqual(
        importRequests.map((request) => request.length),
        [MAX_BANKS_PER_REQUEST, 1],
        `la vista debe trocear en peticiones dentro del tope, no en una de ${total}`,
      );
      assert.deepEqual(importRequests.flat(), bankPaths, 'los trozos cubren la lista en orden');

      // La lista de resultados es una sola y tiene un elemento por archivo.
      assert.equal(await page.locator('#import-results .import-result').count(), total);
      assert.equal(await page.locator('#import-results .import-result.rejected').count(), 0);
      const first = path.basename(bankPaths[0]!);
      const last = path.basename(bankPaths.at(-1)!);
      await waitForText(page, '#import-results', first);
      await waitForText(page, '#import-results', last);

      // Y la lista del plugin se refresca con todos los bancos copiados.
      assert.equal(await page.locator('#banks-rows tr').count(), total);

      // El historial guarda los últimos ocho bancos y cada chip trae su «×»:
      // pulsarlo quita ese banco y deja los otros siete intactos.
      const chips = page.locator('#recent-banks .recent-chip');
      assert.equal(await chips.count(), MAX_RECENTS);
      const forgotten = (await chips.last().textContent()) ?? '';
      assert.notEqual(forgotten, '');

      await page.locator('#recent-banks .recent-chip-remove').last().click();
      await waitForText(page, '#banks-status', `Olvidado ${forgotten} de los recientes.`);
      assert.equal(await chips.count(), MAX_RECENTS - 1, 'solo se va el banco elegido');
      assert.equal(
        await page.locator('#recent-banks .recent-chip', { hasText: forgotten }).count(),
        0,
      );
      const storedBanks = (await page.evaluate(
        `JSON.parse(localStorage.getItem('fxbLoader.recentBanks') ?? '[]')`,
      )) as string[];
      assert.equal(storedBanks.length, MAX_RECENTS - 1);
      assert.equal(
        storedBanks.some((entry) => entry.endsWith(forgotten)),
        false,
        'el banco olvidado sale también del localStorage',
      );

      assert.deepEqual(pageErrors, [], `errores de JavaScript en la página: ${pageErrors.join(' | ')}`);
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({
        path: path.join(ARTIFACTS, 'e2e-import-chunks-failure.png'),
        fullPage: true,
      });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

/**
 * La barra del import avanza con cada evento `bank`, no al cerrar la petición:
 * con tres bancos en un solo flujo, el `<progress>` recibe 1, 2 y 3 antes del
 * `end`. Se registran las asignaciones de `value` porque los eventos pueden
 * llegar en la misma tarea del navegador y un `MutationObserver` solo vería el
 * último valor.
 */
test(
  'la barra avanza banco a banco dentro del mismo flujo NDJSON',
  { skip },
  async (t) => {
    assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);
    assert.ok(existsSync(OBXD_BANK), `falta el banco de prueba ${OBXD_BANK}`);
    assert.ok(existsSync(LIBRARY_SOURCE), `la librería no existe: ${LIBRARY_SOURCE}`);

    const total = 3;
    const temp = await mkdtemp(path.join(tmpdir(), 'fxb-e2e-import-stream-'));
    const library = path.join(temp, 'library');
    const banksDir = path.join(temp, 'banks');
    await cp(path.join(LIBRARY_SOURCE, 'plugs'), path.join(library, 'plugs'), { recursive: true });
    await mkdir(banksDir, { recursive: true });

    const bankPaths = Array.from({ length: total }, (_, index) => {
      const name = `banco-${String(index).padStart(2, '0')}.fxb`;
      return path.join(banksDir, name);
    });
    for (const bankPath of bankPaths) await cp(OBXD_BANK, bankPath);

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
      await rm(temp, { recursive: true, force: true });
    });

    await waitForServer(server, url, logs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const importRequests: string[][] = [];
    page.on('request', (request) => {
      if (!request.url().endsWith('/library/banks/import/stream')) return;
      const body = request.postDataJSON() as { sourcePaths?: string[] };
      if (Array.isArray(body.sourcePaths)) importRequests.push(body.sourcePaths);
    });

    try {
      await page.goto(url);
      await page.waitForSelector('#scan-form');
      await page.fill('#library-root', library);
      await page.click('#scan-button');
      await waitForText(page, '#status', /3 plugin\(s\) encontrados/);

      await clickRowAction(pluginRow(page), 'banks');
      await page.locator('#banks').waitFor({ state: 'visible' });
      await waitForText(page, '#banks-rows', /La carpeta de bancos/);

      // Registra cada valor que la vista asigna a la barra del import. El test
      // no compila con lib DOM, así que el navegador se describe a mano.
      await page.evaluate(() => {
        interface Bar {
          id: string;
          hidden: boolean;
        }
        interface Accessor {
          get?: (this: Bar) => number;
          set?: (this: Bar, next: number) => void;
        }
        const browser = globalThis as unknown as {
          HTMLProgressElement: { prototype: object };
          __importProgressValues: number[];
        };
        const descriptor = Object.getOwnPropertyDescriptor(
          browser.HTMLProgressElement.prototype,
          'value',
        ) as Accessor | undefined;
        if (descriptor?.get === undefined || descriptor.set === undefined) {
          throw new Error('HTMLProgressElement.value no es una propiedad accesible');
        }
        const get = descriptor.get;
        const set = descriptor.set;
        const values: number[] = [];
        Object.defineProperty(browser.HTMLProgressElement.prototype, 'value', {
          configurable: true,
          get(this: Bar): number {
            return get.call(this);
          },
          set(this: Bar, next: number): void {
            set.call(this, next);
            if (this.id === 'import-progress' && !this.hidden) values.push(Number(next));
          },
        });
        browser.__importProgressValues = values;
      });

      await page.locator('details.import > summary').click();
      await page.locator('#import-paths').waitFor({ state: 'visible' });
      await page.fill('#import-paths', bankPaths.join('\n'));
      await page.click('#import-button');

      await waitForText(page, '#banks-status', `${total} banco(s) importados.`);
      const progressValues = await page.evaluate(
        () =>
          (globalThis as unknown as { __importProgressValues: number[] })
            .__importProgressValues,
      );
      assert.deepEqual(
        [...new Set(progressValues)],
        [0, 1, 2, 3],
        'la barra pasa por cada banco, no salta del 0 al total',
      );
      assert.deepEqual(
        importRequests.map((request) => request.length),
        [total],
        'los tres bancos van en un solo flujo',
      );
      assert.equal(await page.locator('#import-results .import-result').count(), total);
      assert.deepEqual(pageErrors, [], `errores de JavaScript en la página: ${pageErrors.join(' | ')}`);
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({
        path: path.join(ARTIFACTS, 'e2e-import-stream-failure.png'),
        fullPage: true,
      });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

/**
 * Un trozo con **todos** los bancos rechazados termina su NDJSON con `end` y el
 * motivo de cada archivo. Eso no es un fallo de la petición: la vista acumula
 * esos rechazos y sigue con el trozo siguiente, así que el resultado final
 * tiene una fila por archivo y no se pierde nada.
 *
 * Las respuestas del import se simulan (el validador real tiene sus tests),
 * pero el escaneo y la lista de bancos son los del servidor: lo que se comprueba
 * es la acumulación de la vista entre peticiones.
 */
test(
  'sigue con el trozo siguiente cuando el primero rechaza todos los bancos',
  { skip },
  async (t) => {
    assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);
    assert.ok(existsSync(LIBRARY_SOURCE), `la librería no existe: ${LIBRARY_SOURCE}`);

    const total = MAX_BANKS_PER_REQUEST + 1;
    const paths = Array.from(
      { length: total },
      (_, index) => `C:\\Banks\\banco-${String(index).padStart(2, '0')}.fxb`,
    );

    const temp = await mkdtemp(path.join(tmpdir(), 'fxb-e2e-reject-'));
    const library = path.join(temp, 'library');
    await cp(path.join(LIBRARY_SOURCE, 'plugs'), path.join(library, 'plugs'), { recursive: true });

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
      await rm(temp, { recursive: true, force: true });
    });

    await waitForServer(server, url, logs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const requests: string[][] = [];
    // La segunda petición se queda en vuelo para mirar la barra a mitad del
    // import: la primera ya contestó sus 50 archivos y aún falta el último.
    const second = {
      started: null as (() => void) | null,
      release: null as (() => void) | null,
    };
    const secondInFlight = new Promise<void>((resolve) => {
      second.started = resolve;
    });
    await page.route('**/library/banks/import/stream', async (route) => {
      const body = route.request().postDataJSON() as { sourcePaths: string[] };
      requests.push(body.sourcePaths);

      if (requests.length > 1) {
        second.started?.();
        await new Promise<void>((resolve) => {
          second.release = resolve;
        });
      }

      const results = body.sourcePaths.map((filePath) =>
        requests.length === 1
          ? {
              source: filePath,
              fileName: path.basename(filePath),
              target: filePath,
              status: 'rejected',
              compatibility: 'incompatible',
              reason: 'uniqueID distinto del plugin',
              issues: [],
              warnings: [],
              bank: null,
            }
          : {
              source: filePath,
              fileName: path.basename(filePath),
              target: filePath,
              status: 'imported',
              compatibility: 'compatible',
              reason: null,
              issues: [],
              warnings: [],
              bank: null,
            },
      );

      const events = [
        { type: 'start', total: body.sourcePaths.length, sourcePaths: body.sourcePaths },
        ...results.map((result, index) => ({
          type: 'bank',
          index,
          total: body.sourcePaths.length,
          result,
        })),
        {
          type: 'end',
          result: {
            plugin: null,
            presetsDir: '',
            reference: { source: 'none', uniqueId: null, uniqueIdValue: null, fxVersion: null, file: null },
            results,
          },
        },
      ];

      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson; charset=utf-8',
        body: events.map((event) => `${JSON.stringify(event)}\n`).join(''),
      });
    });

    try {
      await page.goto(url);
      await page.waitForSelector('#scan-form');
      await page.fill('#library-root', library);
      await page.click('#scan-button');
      await waitForText(page, '#status', /3 plugin\(s\) encontrados/);

      // Importar funciona sin instalar el plugin: solo no deja fijar el banco.
      await clickRowAction(pluginRow(page), 'banks');
      await page.locator('#banks').waitFor({ state: 'visible' });
      await waitForText(page, '#banks-rows', /La carpeta de bancos/);

      await page.locator('details.import > summary').click();
      await page.locator('#import-paths').waitFor({ state: 'visible' });
      await page.fill('#import-paths', paths.join('\n'));
      await page.click('#import-button');

      // Mientras el segundo trozo está en vuelo, la barra muestra lo ya
      // resuelto sobre la lista completa, no solo sobre la petición en curso.
      await secondInFlight;
      await waitForText(page, '#banks-status', `Importando 50 de ${total} archivo(s)…`);
      const progress = await page.locator('#import-progress').evaluate((bar) => {
        const el = bar as unknown as { hidden: boolean; value: number; max: number };
        return { hidden: el.hidden, value: el.value, max: el.max };
      });
      assert.deepEqual(progress, { hidden: false, value: MAX_BANKS_PER_REQUEST, max: total });

      second.release?.();
      await waitForText(page, '#banks-status', '1 importado(s), 50 rechazado(s).');
      assert.equal(await page.locator('#import-progress').isHidden(), true);

      assert.deepEqual(requests.map((request) => request.length), [MAX_BANKS_PER_REQUEST, 1]);
      assert.deepEqual(
        requests.flat(),
        paths,
        'el rechazo del primer trozo no impide mandar el segundo',
      );

      assert.equal(await page.locator('#import-results .import-result').count(), total);
      assert.equal(await page.locator('#import-results .import-result.rejected').count(), 50);
      assert.equal(await page.locator('#import-results .import-result.imported').count(), 1);
      await waitForText(page, '#import-results', path.basename(paths.at(-1)!));
      assert.deepEqual(pageErrors, [], `errores de JavaScript en la página: ${pageErrors.join(' | ')}`);
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({
        path: path.join(ARTIFACTS, 'e2e-import-422-failure.png'),
        fullPage: true,
      });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

/**
 * «Reintentar fallidos» reintenta en orden todos los errores del lote, cada uno
 * con su acción y sin detenerse en el primero que vuelve a fallar. El lote se
 * simula con Playwright (fallan dos plugins de los tres) y los reintentos
 * individuales se responden desde la prueba: uno se recupera y el otro sigue
 * fallando. El escaneo y la tabla son los del servidor real.
 */
test(
  'reintenta en lote todos los plugins fallidos, no solo de uno en uno',
  { skip },
  async (t) => {
    assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);
    assert.ok(existsSync(LIBRARY_SOURCE), `la librería no existe: ${LIBRARY_SOURCE}`);

    const temp = await mkdtemp(path.join(tmpdir(), 'fxb-e2e-retry-all-'));
    const library = path.join(temp, 'library');
    await cp(path.join(LIBRARY_SOURCE, 'plugs'), path.join(library, 'plugs'), { recursive: true });

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
      await rm(temp, { recursive: true, force: true });
    });

    await waitForServer(server, url, logs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    /** Los dos primeros plugins del lote fallan; el resto se instala. */
    let failedNames: string[] = [];
    /** Plugins reintentados, en el orden en que la vista los manda. */
    const retried: string[] = [];
    /**
     * Retiene la respuesta del primer reintento para poder mirar la barra, el
     * paso y el reloj antes de que el lote termine.
     */
    let releaseRetry: () => void = () => {};
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });

    await page.route('**/library/batch/stream', async (route) => {
      const body = route.request().postDataJSON() as { plugins: string[] };
      const failed = body.plugins.slice(0, 2);
      failedNames = failed;
      const events = [
        {
          type: 'start',
          action: 'add',
          dryRun: false,
          total: body.plugins.length,
          plugins: body.plugins,
        },
        ...body.plugins.flatMap((name, index) => [
          { type: 'plugin', index, total: body.plugins.length, name, status: 'running', message: null },
          {
            type: 'plugin',
            index,
            total: body.plugins.length,
            name,
            status: failed.includes(name) ? 'failed' : 'added',
            message: failed.includes(name) ? `fallo simulado en ${name}` : null,
          },
        ]),
        {
          type: 'end',
          result: {
            action: 'add',
            dryRun: false,
            total: body.plugins.length,
            succeeded: body.plugins.length - failed.length,
            failed: failed.length,
            results: body.plugins.map((name) => ({
              name,
              status: failed.includes(name) ? 'failed' : 'added',
              message: failed.includes(name) ? `fallo simulado en ${name}` : null,
            })),
          },
        },
      ];

      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
        body: events.map((event) => `${JSON.stringify(event)}\n`).join(''),
      });
    });

    await page.route('**/library/loader/add', async (route) => {
      const body = route.request().postDataJSON() as { plugin: string };
      retried.push(body.plugin);
      if (retried.length === 1) await retryGate;

      // El primero se recupera; el segundo vuelve a fallar y debe quedarse.
      if (body.plugin === failedNames[1]) {
        await route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({ message: `sigue fallando ${body.plugin}` }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ plugin: { name: body.plugin }, actions: [] }),
      });
    });

    try {
      await page.goto(url);
      await page.waitForSelector('#scan-form');
      await page.fill('#library-root', library);
      await page.click('#scan-button');
      await waitForText(page, '#status', /3 plugin\(s\) encontrados/);

      await page.click('#install-all');
      await waitForText(page, '#batch-status', '1 de 3 con cargador; 2 con error.');
      await page.locator('#retry-all').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#retry-all').textContent(), 'Reintentar fallidos (2)');
      assert.equal(await page.locator('#batch-error-list .batch-error').count(), 2);

      await page.click('#retry-all');
      await page.locator('#batch-progress').waitFor({ state: 'visible' });
      try {
        assert.equal(await page.locator('#batch-progress').getAttribute('max'), '2');
        assert.equal(await page.locator('#batch-progress').getAttribute('value'), '0');
        assert.equal(
          await page.locator('#batch-step').textContent(),
          `paso 1 de 2 · reintentando ${failedNames[0]}`,
        );
        assert.match((await page.locator('#batch-clock').textContent()) ?? '', /transcurridos/);
        assert.match(
          (await page.locator('#batch-clock').textContent()) ?? '',
          /en el paso actual/,
        );
      } finally {
        releaseRetry();
      }
      await waitForText(page, '#batch-status', /1 de 2 reintentado\(s\); 1 sigue\(n\) fallando/);
      assert.deepEqual(retried, failedNames, 'reintenta todos, en el orden del lote');
      assert.equal(await page.locator('#retry-all').textContent(), 'Reintentar fallidos (1)');
      assert.equal(await page.locator('#batch-error-list .batch-error').count(), 1);
      await waitForText(page, '#batch-error-list', `sigue fallando ${failedNames[1]}`);
      assert.deepEqual(pageErrors, [], `errores de JavaScript en la página: ${pageErrors.join(' | ')}`);
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({
        path: path.join(ARTIFACTS, 'e2e-retry-all-failure.png'),
        fullPage: true,
      });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

/**
 * Los botones «Elegir carpeta…», «Elegir DLL…» y «Añadir archivos…» abren el
 * diálogo nativo en el servidor (`POST /system/pick`). El navegador de prueba no
 * puede pulsar un diálogo de Windows, así que se intercepta esa petición: lo que
 * se comprueba es el contrato de la vista con el servidor (qué pide, qué hace con
 * la respuesta y qué vuelve a escanear), mientras el escaneo y los bancos son
 * los reales.
 */
test(
  'elige carpeta, DLL y bancos con los botones del diálogo',
  { skip },
  async (t) => {
    assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);
    assert.ok(existsSync(OBXD_BANK), `falta el banco de prueba ${OBXD_BANK}`);
    assert.ok(existsSync(LIBRARY_SOURCE), `la librería no existe: ${LIBRARY_SOURCE}`);

    const temp = await mkdtemp(path.join(tmpdir(), 'fxb-e2e-pick-'));
    const library = path.join(temp, 'library');
    await cp(path.join(LIBRARY_SOURCE, 'plugs'), path.join(library, 'plugs'), { recursive: true });

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
      await rm(temp, { recursive: true, force: true });
    });

    await waitForServer(server, url, logs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    /** Cuerpos que la vista manda al diálogo, en orden. */
    const pickBodies: Record<string, unknown>[] = [];
    /** Cuerpos de los escaneos, para ver qué DLL se validó. */
    const scans: Record<string, unknown>[] = [];
    const manualImport = 'C:\\Bancos\\manual.fxb';

    page.on('request', (request) => {
      if (!request.url().endsWith('/library/scan')) return;
      scans.push(request.postDataJSON() as Record<string, unknown>);
    });

    await page.route('**/system/pick', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      pickBodies.push(body);
      const paths =
        body['kind'] === 'folder'
          ? [library]
          : body['kind'] === 'file'
            ? [REPO_DLL]
            : [OBXD_BANK, manualImport];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ paths }),
      });
    });

    try {
      await page.goto(url);
      await page.waitForSelector('#scan-form');

      /* 1. Carpeta de la librería: elige y escanea ---------------------- */
      await page.click('#root-browse');
      await waitForText(page, '#status', /3 plugin\(s\) encontrados/);
      assert.equal(await page.locator('#library-root').inputValue(), library);
      assert.equal(await page.locator('#plugins-table tbody tr').count(), 3);

      /* 2. DLL del cargador: elige y revalida --------------------------- */
      await page.locator('#scan-form details > summary').click();
      // Si ya hay una ruta escrita, el diálogo abre en su carpeta.
      await page.fill('#dll-source', 'C:\\Tools\\fxbLoader.dll');
      await page.click('#dll-browse');
      await page.waitForFunction(
        `document.querySelector('#dll-source')?.value === ${JSON.stringify(REPO_DLL)}`,
      );

      // El escaneo de validación tarda: se espera a que salga la petición.
      const deadline = Date.now() + 20_000;
      while (scans.length < 2 && Date.now() < deadline) await page.waitForTimeout(100);
      assert.equal(scans.length, 2, 'elegir DLL vuelve a escanear para validarlo');
      assert.equal(scans[1]?.['dllSourcePath'], REPO_DLL);

      /* 3. Bancos: añade archivos a la lista sin borrar lo escrito ------ */
      await clickRowAction(pluginRow(page), 'banks');
      await page.locator('#banks').waitFor({ state: 'visible' });
      await page.locator('details.import > summary').click();
      await page.fill('#import-paths', manualImport);
      await page.click('#import-browse');

      await waitForText(page, '#banks-status', /1 archivo\(s\) añadidos; 2 en la lista/);
      assert.deepEqual(
        (await page.locator('#import-paths').inputValue()).split('\n'),
        [manualImport, OBXD_BANK],
        'conserva lo escrito, añade lo elegido y descarta el duplicado',
      );

      // Cada botón pide un diálogo distinto, con las extensiones y la carpeta
      // de partida que espera el servidor.
      assert.deepEqual(pickBodies, [
        { kind: 'folder', title: 'Elige la carpeta de la librería VFX (la que contiene plugs)' },
        {
          kind: 'file',
          title: 'Elige el fxbLoader.dll',
          extensions: ['dll'],
          initialDir: 'C:\\Tools',
        },
        {
          kind: 'files',
          title: 'Elige los bancos .fxb para importar',
          extensions: ['fxb'],
          initialDir: 'C:\\Bancos',
        },
      ]);
      assert.deepEqual(pageErrors, [], `errores de JavaScript en la página: ${pageErrors.join(' | ')}`);
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({
        path: path.join(ARTIFACTS, 'e2e-pick-failure.png'),
        fullPage: true,
      });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

/**
 * El historial de la vista se guarda en `localStorage` y con el tiempo apunta a
 * carpetas y archivos que ya no están. Al cargar se comprueba con
 * `POST /system/paths` y se descartan las sugerencias caducadas: se siembra el
 * historial antes de que corra el módulo (una ruta viva y otra borrada por tipo)
 * y se mira qué queda en los `<datalist>`, en los botones de bancos y en el
 * propio `localStorage`.
 */
test(
  'descarta del historial las rutas que ya no están en el disco',
  {
    skip: existsSync(SERVER_ENTRY)
      ? false
      : `falta ${path.relative(process.cwd(), SERVER_ENTRY)}; ejecuta npm run build`,
  },
  async (t) => {
    const temp = await mkdtemp(path.join(tmpdir(), 'fxb-e2e-recents-'));
    const alive = path.join(temp, 'libreria');
    const gone = path.join(temp, 'libreria-renombrada');
    const goneDll = path.join(temp, 'fxbLoader.dll');
    const goneBank = path.join(temp, 'Borrado.fxb');
    await mkdir(alive, { recursive: true });

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
      await rm(temp, { recursive: true, force: true });
    });

    await waitForServer(server, url, logs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    // Como si la sesión anterior hubiera dejado estas rutas guardadas. El
    // script va como texto para no necesitar el lib DOM del proyecto.
    const stored = (values: string[]): string => JSON.stringify(JSON.stringify(values));
    await page.addInitScript(`
      localStorage.setItem('fxbLoader.recentLibraryRoots', ${stored([gone, alive])});
      localStorage.setItem('fxbLoader.recentDlls', ${stored([goneDll])});
      localStorage.setItem('fxbLoader.recentBanks', ${stored([goneBank])});
    `);

    try {
      await page.goto(url);
      await page.waitForSelector('#scan-form');

      // La poda es asíncrona: se espera a que el datalist quede con una sola
      // sugerencia, y esa tiene que ser la carpeta que sigue existiendo.
      await page.waitForFunction(
        `document.querySelectorAll('#library-root-recents option').length === 1`,
      );
      const suggested = (await page.evaluate(
        `[...document.querySelectorAll('#library-root-recents option')].map((option) => option.value)`,
      )) as string[];
      assert.deepEqual(suggested, [alive]);

      assert.equal(await page.locator('#dll-source-recents option').count(), 0);
      assert.equal(await page.locator('#recent-banks button').count(), 0);
      assert.equal(await page.locator('#recent-banks').isHidden(), true);

      // Y el historial podado se guarda: no vuelve a ofrecerse al recargar.
      assert.deepEqual(
        (await page.evaluate(
          `JSON.parse(localStorage.getItem('fxbLoader.recentLibraryRoots') ?? '[]')`,
        )) as string[],
        [alive],
      );
      assert.equal(
        await page.evaluate(`localStorage.getItem('fxbLoader.recentDlls')`),
        null,
        'una lista vacía borra la clave',
      );
      assert.equal(
        await page.evaluate(`localStorage.getItem('fxbLoader.recentBanks')`),
        null,
      );

      /* «Vaciar historial de rutas», en Opciones avanzadas ---------------- */
      await page.locator('#scan-form details > summary').click();
      assert.equal(
        await page.locator('#recents-clear').isDisabled(),
        false,
        'queda la carpeta viva, así que hay historial que vaciar',
      );

      // Cancelar la confirmación no toca nada.
      await page.fill('#library-root', 'C:\\Intacta');
      page.once('dialog', (dialog) => void dialog.dismiss());
      await page.click('#recents-clear');
      assert.equal(
        await page.locator('#library-root-recents option').count(),
        1,
        'cancelar conserva el historial',
      );

      // Aceptarla borra las tres listas sin tocar lo escrito en los campos.
      page.once('dialog', (dialog) => void dialog.accept());
      await page.click('#recents-clear');
      await waitForText(page, '#status', /Historial de rutas recientes vaciado/);
      assert.equal(await page.locator('#library-root-recents option').count(), 0);
      assert.equal(await page.locator('#dll-source-recents option').count(), 0);
      assert.equal(await page.locator('#recent-banks button').count(), 0);
      assert.equal(
        await page.locator('#recents-clear').isDisabled(),
        true,
        'sin historial no hay nada que vaciar',
      );
      assert.equal(await page.locator('#library-root').inputValue(), 'C:\\Intacta');
      assert.deepEqual(
        (await page.evaluate(`[
          localStorage.getItem('fxbLoader.recentLibraryRoots'),
          localStorage.getItem('fxbLoader.recentDlls'),
          localStorage.getItem('fxbLoader.recentBanks'),
        ]`)) as (string | null)[],
        [null, null, null],
        'vaciar el historial borra también las claves',
      );

      assert.deepEqual(pageErrors, [], `errores de JavaScript en la página: ${pageErrors.join(' | ')}`);
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({
        path: path.join(ARTIFACTS, 'e2e-recents-failure.png'),
        fullPage: true,
      });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

/**
 * El conmutador de tema cicla Sistema → Oscuro → Claro. La elección se guarda
 * en `localStorage` (`fxbLoader.theme`), también «Sistema», que se escribe como
 * `auto` en vez de borrar la clave; al recargar, el modo y su dibujo (sol o
 * luna) tienen que seguir ahí. Con «Sistema» el dibujo sigue al SO sin cambiar
 * lo guardado.
 */
test(
  'el tema elegido se guarda y se recupera al recargar',
  {
    skip: existsSync(SERVER_ENTRY)
      ? false
      : `falta ${path.relative(process.cwd(), SERVER_ENTRY)}; ejecuta npm run build`,
  },
  async (t) => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
    });

    await waitForServer(server, url, logs);

    browser = await chromium.launch();
    // Tema del SO fijo: el sol o la luna de «Sistema» no deben depender del host.
    const context = await browser.newContext({ colorScheme: 'light' });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    interface ThemeState {
      stored: string | null;
      theme: string | null;
      sun: boolean;
      moon: boolean;
      title: string;
    }

    // El script va como texto para no necesitar el lib DOM del proyecto.
    const readTheme = async (): Promise<ThemeState> =>
      (await page.evaluate(`
        (() => {
          const visible = (mode) => {
            const svg = document.querySelector('svg[data-icon="' + mode + '"]');
            return svg !== null && getComputedStyle(svg).display !== 'none';
          };
          return {
            stored: localStorage.getItem('fxbLoader.theme'),
            theme: document.documentElement.getAttribute('data-theme'),
            sun: visible('light'),
            moon: visible('dark'),
            title: document.getElementById('theme-toggle').title,
          };
        })()
      `)) as ThemeState;

    const titleFor = {
      auto: 'Tema: Sistema (clic para cambiar a Oscuro)',
      dark: 'Tema: Oscuro (clic para cambiar a Claro)',
      light: 'Tema: Claro (clic para cambiar a Sistema)',
    } as const;

    const expectTheme = async (mode: keyof typeof titleFor): Promise<void> => {
      const dark = mode === 'dark';
      assert.deepEqual(
        await readTheme(),
        {
          stored: mode,
          theme: mode === 'auto' ? null : mode,
          sun: !dark,
          moon: dark,
          title: titleFor[mode],
        },
        `estado inesperado con el tema ${mode}`,
      );
    };

    try {
      await page.goto(url);
      await page.waitForSelector('#theme-toggle');

      // Primer arranque: nadie ha elegido, así que manda el SO y no hay clave.
      const initial = await readTheme();
      assert.equal(initial.stored, null, 'sin elección no se escribe la clave');
      assert.equal(initial.theme, null);
      assert.equal(initial.sun, true, 'con el SO claro se dibuja el sol');
      assert.equal(initial.title, titleFor.auto);

      await page.click('#theme-toggle');
      await expectTheme('dark');
      await page.reload();
      await page.waitForSelector('#theme-toggle');
      await expectTheme('dark');

      await page.click('#theme-toggle');
      await expectTheme('light');
      await page.reload();
      await page.waitForSelector('#theme-toggle');
      await expectTheme('light');

      await page.click('#theme-toggle');
      await expectTheme('auto');
      await page.reload();
      await page.waitForSelector('#theme-toggle');
      await expectTheme('auto');

      // «Sistema» sigue al SO sin tocar lo guardado.
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction(
        `getComputedStyle(document.querySelector('svg[data-icon="dark"]')).display !== 'none'`,
      );
      const followed = await readTheme();
      assert.equal(followed.stored, 'auto', '«Sistema» sigue guardado como auto');
      assert.equal(followed.theme, null, '«Sistema» no fija data-theme');
      assert.equal(followed.moon, true, 'con el SO oscuro se dibuja la luna');

      assert.deepEqual(
        pageErrors,
        [],
        `errores de JavaScript en la página: ${pageErrors.join(' | ')}`,
      );
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({
        path: path.join(ARTIFACTS, 'e2e-theme-failure.png'),
        fullPage: true,
      });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

test(
  'paginador de plugins embebido: tamaño de página y navegación',
  { skip },
  async (t) => {
    const temp = await mkdtemp(path.join(tmpdir(), 'fxb-e2e-pagination-'));
    const library = path.join(temp, 'library');
    await cp(LIBRARY_SOURCE, library, { recursive: true });

    // Copiar plugins dummy para pasar del tamaño de página por defecto (25) y
    // poder navegar de verdad entre páginas.
    const plugsDir = path.join(library, 'plugs');
    for (let i = 1; i <= 28; i++) {
      await cp(path.join(plugsDir, 'AnalogSynth'), path.join(plugsDir, `Synth-${i}`), {
        recursive: true,
      });
    }

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const logs: string[] = [];

    const server = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    server.stdout.on('data', (chunk) => logs.push(chunk.toString()));
    server.stderr.on('data', (chunk) => logs.push(chunk.toString()));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
      await rm(temp, { recursive: true, force: true });
    });

    await waitForServer(server, url, logs);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      await page.goto(url);
      await page.fill('#library-root', library);
      await page.click('#scan-button');

      await page.waitForSelector('#results:not([hidden])');
      await page.waitForSelector('#plugins-table .table-pagination');

      // El tamaño por defecto lo fija la vista del catálogo.
      const defaultPageSize = await page.inputValue('#plugins-table .pagination-select');
      assert.equal(defaultPageSize, '25', 'por defecto el paginador muestra 25');
      const prevDisabled = await page.isDisabled('#plugins-table .pagination-btn:has-text("Anterior")');
      assert.equal(prevDisabled, true, 'el botón Anterior debe estar deshabilitado en página 1');

      // Cambiar a 50 por página: caben todos los plugins.
      await page.selectOption('#plugins-table .pagination-select', '50');
      const rowsCount = await page.$$eval('#plugins-table tbody tr', (rows) => rows.length);
      assert.equal(rowsCount, 31, 'con 50 por página se ven todos los plugins');

      const pageInfoText = await page.$eval('#plugins-table .pagination-info', (el) => el.textContent?.trim());
      assert.match(pageInfoText ?? '', /^1–31 de 31$/, 'page-info refleja el rango completo');

      // Volver a 25 por página: quedan 6 plugins fuera de la primera página.
      await page.selectOption('#plugins-table .pagination-select', '25');
      const firstPageRows = await page.$$eval('#plugins-table tbody tr', (rows) => rows.length);
      assert.equal(firstPageRows, 25, 'con 25 por página solo se ven 25 filas');
      const firstPageInfo = await page.$eval('#plugins-table .pagination-info', (el) => el.textContent?.trim());
      assert.match(firstPageInfo ?? '', /^1–25 de 31$/, 'page-info refleja la primera página');

      // Avanzar a la página siguiente.
      await page.click('#plugins-table .pagination-btn:has-text("Siguiente")');
      const page2InfoText = await page.$eval('#plugins-table .pagination-info', (el) => el.textContent?.trim());
      assert.match(page2InfoText ?? '', /^26–31 de 31$/, 'page-info avanza a la página 2');

      // Volver a la página anterior.
      await page.click('#plugins-table .pagination-btn:has-text("Anterior")');
      const backInfoText = await page.$eval('#plugins-table .pagination-info', (el) => el.textContent?.trim());
      assert.match(backInfoText ?? '', /^1–25 de 31$/, 'page-info retrocede a la página 1');

      assert.deepEqual(
        pageErrors,
        [],
        `errores de JavaScript en la página: ${pageErrors.join(' | ')}`,
      );
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({
        path: path.join(ARTIFACTS, 'e2e-pagination-failure.png'),
        fullPage: true,
      });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

/**
 * El cajón de wizards destruye su tabla al cerrar, como el resto de cajones:
 * el contenedor queda vacío y, al reabrir, `renderWizardsList` vuelve a montar
 * una instancia nueva con los valores por defecto de la vista (100 por página,
 * página 1), sin arrastrar el tamaño de página ni la página de la apertura
 * anterior.
 */
test('cajón de wizards: la tabla se remonta al reabrir tras cerrar', { skip }, async (t) => {
  assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const logs: string[] = [];
  const server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: WEBAPP,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.setEncoding('utf8');
  server.stderr?.setEncoding('utf8');
  server.stdout?.on('data', (chunk: string) => logs.push(chunk));
  server.stderr?.on('data', (chunk: string) => logs.push(chunk));

  let browser: Browser | null = null;

  t.after(async () => {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
      await new Promise((resolve) => server.once('exit', resolve));
    }
  });

  await waitForServer(server, url, logs);

  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const pageInfo = async (): Promise<string> =>
    (await page.$eval('#wizards-table .pagination-info', (el) => el.textContent?.trim())) ?? '';

  try {
    await page.goto(url);

    /* Primer montaje: la vista fija 100 por página ---------------- */
    await page.click('#wizards-nav-btn');
    await page.locator('#wizards').waitFor({ state: 'visible' });
    await waitForRowCount(page, '#wizards-table', 100);
    assert.equal(
      await page.inputValue('#wizards-table .pagination-select'),
      '100',
      'la tabla recién montada arranca con el tamaño por defecto de la vista',
    );
    assert.match(await pageInfo(), /^1–100 de \d+$/, 'y en la primera página');

    // Estado que NO debe sobrevivir al cierre: 25 por página y página 2.
    await page.selectOption('#wizards-table .pagination-select', '25');
    await waitForRowCount(page, '#wizards-table', 25);
    await page.click('#wizards-table .pagination-btn:has-text("Siguiente")');
    assert.match(await pageInfo(), /^26–50 de \d+$/, 'antes de cerrar la tabla está en la página 2');

    /* Cierre: la tabla se destruye y el contenedor queda vacío ----- */
    await page.click('#wizards-close');
    await page.locator('#wizards').waitFor({ state: 'hidden' });
    assert.equal(
      await page.$eval('#wizards-table', (el) => el.childElementCount),
      0,
      'al cerrar, closeWizards vacía el contenedor de la tabla',
    );

    /* Reapertura: tabla nueva con el estado inicial --------------- */
    await page.click('#wizards-nav-btn');
    await page.locator('#wizards').waitFor({ state: 'visible' });
    await waitForRowCount(page, '#wizards-table', 100);
    assert.equal(
      await page.inputValue('#wizards-table .pagination-select'),
      '100',
      'la tabla remontada vuelve al tamaño por defecto, no al 25 de la apertura anterior',
    );
    assert.match(await pageInfo(), /^1–100 de \d+$/, 'y a la primera página');
    assert.match(
      (await page.locator('#wizards-count').textContent()) ?? '',
      /^\d+ de \d+$/,
      'el contador del cajón refleja el listado recargado',
    );

    assert.deepEqual(
      pageErrors,
      [],
      `errores de JavaScript en la página: ${pageErrors.join(' | ')}`,
    );
  } catch (error) {
    await mkdir(ARTIFACTS, { recursive: true });
    await page.screenshot({
      path: path.join(ARTIFACTS, 'e2e-wizards-remount-failure.png'),
      fullPage: true,
    });
    console.error(`Servidor:\n${logs.join('')}`);
    throw error;
  }
});

/**
 * Catálogo y wizards comparten la acción de abrir el historial: id `log`,
 * etiqueta «Historial» e icono `list`. El menú «···» de una fila de wizards la
 * ofrece con esa identidad — y sin `view-record`, reservado a la tabla del
 * historial — y el clic abre el mismo cajón de log que en el catálogo. Como el
 * plugin del wizard no está escaneado, el cajón muestra el estado «todavía no
 * ha escrito nada» en vez de fallar.
 */
test('menú «···» de wizards: «Historial» abre el cajón de log como en el catálogo', { skip }, async (t) => {
  assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const logs: string[] = [];
  const server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: WEBAPP,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.setEncoding('utf8');
  server.stderr?.setEncoding('utf8');
  server.stdout?.on('data', (chunk: string) => logs.push(chunk));
  server.stderr?.on('data', (chunk: string) => logs.push(chunk));

  let browser: Browser | null = null;

  t.after(async () => {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
      await new Promise((resolve) => server.once('exit', resolve));
    }
  });

  await waitForServer(server, url, logs);

  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await page.goto(url);
    await page.click('#wizards-nav-btn');
    await page.locator('#wizards').waitFor({ state: 'visible' });
    await waitForRowCount(page, '#wizards-table', 100);

    const row = page.locator('#wizards-table tbody tr[data-row-id]').first();
    const wizardName = ((await row.locator('td').first().textContent()) ?? '').trim();
    assert.notEqual(wizardName, '', 'la primera fila pinta el nombre del wizard');

    /* Misma identidad que la acción del catálogo ------------------- */
    await row.locator('[data-action="menu"]').click();
    assert.equal(
      await row.locator('[data-action="log"]').textContent(),
      'Historial',
      'la opción se llama «Historial», como en el catálogo',
    );
    assert.equal(
      await row.locator('[data-action="log"] use').getAttribute('href'),
      '#icon-list',
      'y lleva el mismo icono list',
    );
    assert.equal(await row.locator('[data-action="view-record"]').count(), 0, 'view-record queda reservado al historial');
    assert.equal(await row.locator('[data-action="install"]').textContent(), 'Instalar…');

    /* El clic abre el cajón del log, como en el catálogo ----------- */
    await row.locator('[data-action="log"]').click();
    await page.locator('#log-drawer').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#wizards').isHidden(), true, 'abrir el historial cierra el cajón de wizards');
    assert.equal(
      (await page.locator('#log-plugin').textContent())?.trim(),
      wizardName,
      'el cajón muestra el plugin que representa el wizard',
    );
    // Sin escaneo no hay log: el estado vacío estándar de la tabla.
    await waitForText(page, '#log-table', /todavía no ha escrito nada en su log/);

    assert.deepEqual(
      pageErrors,
      [],
      `errores de JavaScript en la página: ${pageErrors.join(' | ')}`,
    );
  } catch (error) {
    await mkdir(ARTIFACTS, { recursive: true });
    await page.screenshot({
      path: path.join(ARTIFACTS, 'e2e-wizards-log-action-failure.png'),
      fullPage: true,
    });
    console.error(`Servidor:\n${logs.join('')}`);
    throw error;
  }
});

/**
 * Cada eje del filtro es un menú de tres estados: positivo, negativo y «todos».
 * El chip anuncia si filtra (`aria-pressed`), si su menú está abierto
 * (`aria-expanded`) y el tono que aplica (`data-tone`); las opciones viajan con
 * `menuitemradio` + `aria-checked`. Se cubren clic, teclado, Escape, clic fuera,
 * los cuatro ejes y el color de cada estado.
 */
test(
  'los cuatro ejes filtran desde un menú de tres estados y lo anuncian',
  { skip },
  async (t) => {
    assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);
    assert.ok(existsSync(LIBRARY_SOURCE), `la librería no existe: ${LIBRARY_SOURCE}`);

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
    });

    await waitForServer(server, url, logs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const AXES = ['install', 'banks', 'wizard', 'compat'] as const;
    const ALL_LABELS: Record<string, string> = {
      install: 'Con y sin cargador',
      banks: 'Con y sin bancos',
      wizard: 'Con y sin wizard',
      compat: 'Compatibles e incompatibles',
    };

    const chip = (axis: string) => page.locator(`#filter-${axis}`);
    const option = (axis: string, value: string) =>
      page.locator(`#filter-${axis}-menu [data-value="${value}"]`);

    /** Elige una opción como lo haría el usuario: abre el chip y pulsa. */
    const choose = async (axis: string, value: string): Promise<void> => {
      await page.click(`#filter-${axis}`);
      await option(axis, value).click();
    };

    /** Estado que el DOM anuncia para un eje. */
    const stateOf = async (
      axis: string,
    ): Promise<{ pressed: string | null; expanded: string | null; tone: string | null; text: string }> => ({
      pressed: await chip(axis).getAttribute('aria-pressed'),
      expanded: await chip(axis).getAttribute('aria-expanded'),
      tone: await chip(axis).getAttribute('data-tone'),
      text: (await chip(axis).locator('.filter-btn-text').textContent())?.trim() ?? '',
    });

    /** Valor marcado dentro del menú de un eje. */
    const checkedValue = async (axis: string): Promise<string | null> =>
      page.locator(`#filter-${axis}-menu [aria-checked="true"]`).getAttribute('data-value');

    const rows = async (expected: number, scope: string): Promise<void> => {
      assert.equal(
        await page.locator('#plugins-table tbody tr').count(),
        expected === 0 ? 1 : expected,
        `${scope}: filas visibles`,
      );
    };

    const countLabel = async (): Promise<string> =>
      ((await page.textContent('#filter-count')) ?? '').trim();

    const cdp = await page.context().newCDPSession(page);
    /** Propiedad que el árbol de accesibilidad expone para un selector. */
    const axProperty = async (selector: string, property: string): Promise<string | undefined> => {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      const { node } = await cdp.send('DOM.describeNode', { nodeId });
      const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
        backendNodeId: node.backendNodeId,
        fetchRelatives: false,
      });
      const found = nodes[0]?.properties?.find((entry) => entry.name === property);
      const value = found?.value?.value as unknown;
      return value === undefined || value === null ? undefined : String(value);
    };

    try {
      await page.goto(url);
      await page.fill('#library-root', LIBRARY_SOURCE);
      await page.click('#scan-button');
      await page.waitForSelector('#results:not([hidden])');

      // Reparto del fixture, leído de los badges con todos los ejes en «todos».
      const total = await page.locator('#plugins-table tbody tr').count();
      assert.ok(total > 0, 'el fixture debe traer plugins');
      const installed = await page.locator('#plugins-table tbody tr').evaluateAll((trs) =>
        trs.filter(
          (tr) => tr.querySelector('[data-field="status"]')?.textContent?.trim() === 'con cargador',
        ).length,
      );
      const incompatible = await page.locator('#plugins-table tbody tr').evaluateAll((trs) =>
        trs.filter(
          (tr) =>
            tr.querySelector('[data-field="compatibility"]')?.textContent?.trim() ===
            'incompatible',
        ).length,
      );
      const withWizard = await page
        .locator('[data-field="wizard"]')
        .evaluateAll((badges) =>
          badges.filter((badge) => badge.textContent?.trim() === 'disponible').length,
        );

      for (const axis of AXES) {
        assert.deepEqual(
          await stateOf(axis),
          { pressed: 'false', expanded: 'false', tone: 'neutral', text: ALL_LABELS[axis] },
          `${axis}: estado inicial`,
        );
        assert.equal(await checkedValue(axis), 'all', `${axis}: arranca en «todos»`);
      }
      assert.equal(await countLabel(), '', 'sin filtros no hay recuento');

      /* Cargador: abrir, anunciar y elegir «Con cargador» --------------------- */
      await page.click('#filter-install');
      assert.deepEqual(
        await stateOf('install'),
        { pressed: 'false', expanded: 'true', tone: 'neutral', text: ALL_LABELS.install },
        'al abrir solo cambia aria-expanded',
      );
      assert.equal(await page.locator('#filter-install-menu').isVisible(), true);
      assert.equal(
        await page.evaluate('document.activeElement.dataset.value'),
        'all',
        'el foco entra en la opción vigente',
      );
      assert.equal(await axProperty('#filter-install', 'expanded'), 'true');
      assert.equal(
        await axProperty('#filter-install-menu [data-value="all"]', 'checked'),
        'true',
        'el árbol de accesibilidad anuncia la opción marcada',
      );

      await option('install', 'installed').click();
      assert.deepEqual(
        await stateOf('install'),
        { pressed: 'true', expanded: 'false', tone: 'positive', text: 'Con cargador' },
        'la opción elegida pinta el chip y cierra el menú',
      );
      assert.equal(await page.locator('#filter-install-menu').isVisible(), false);
      assert.equal(
        await page.evaluate('document.activeElement.id'),
        'filter-install',
        'el foco vuelve al chip',
      );
      assert.equal(await checkedValue('install'), 'installed');
      assert.equal(await axProperty('#filter-install', 'pressed'), 'true');
      await rows(installed, 'solo instalados');
      assert.equal(await countLabel(), `${installed} de ${total} plugin(s)`);

      /* Teclado: flechas desde la opción marcada e Intro ---------------------- */
      await page.focus('#filter-install');
      await page.keyboard.press('Enter');
      assert.equal(
        await page.evaluate('document.activeElement.dataset.value'),
        'installed',
        'Intro abre el menú en la opción marcada',
      );
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate('document.activeElement.dataset.value'), 'uninstalled');
      await page.keyboard.press('Enter');
      assert.deepEqual(
        await stateOf('install'),
        { pressed: 'true', expanded: 'false', tone: 'negative', text: 'Sin cargador' },
        'Intro elige la opción enfocada',
      );
      await rows(total - installed, 'ningún instalado');
      assert.equal(await countLabel(), `${total - installed} de ${total} plugin(s)`);

      /* Escape cierra y devuelve el foco; un clic fuera también cierra ------- */
      await page.click('#filter-install');
      await page.keyboard.press('Escape');
      assert.equal((await stateOf('install')).expanded, 'false');
      assert.equal(await page.evaluate('document.activeElement.id'), 'filter-install');

      await page.click('#filter-banks');
      assert.equal((await stateOf('banks')).expanded, 'true');
      // El buscador vive ahora dentro de la tabla, así que su clic no cierra;
      // lo hace un clic en algo ajeno al shell de la tabla.
      await page.click('#plugin-filter');
      assert.equal((await stateOf('banks')).expanded, 'true', 'un clic dentro de la tabla no cierra');
      await page.click('#theme-toggle');
      assert.equal((await stateOf('banks')).expanded, 'false', 'el clic fuera cierra el menú');

      /* Compatibilidad: el positivo es «Ningún incompatible» ------------------ */
      await choose('compat', 'incompatible');
      assert.deepEqual(
        await stateOf('compat'),
        { pressed: 'true', expanded: 'false', tone: 'negative', text: 'Solo incompatibles' },
        'compatibilidad negativa',
      );
      await rows(incompatible, 'solo incompatibles');
      await choose('compat', 'compatible');
      assert.deepEqual(
        await stateOf('compat'),
        { pressed: 'true', expanded: 'false', tone: 'positive', text: 'Ningún incompatible' },
        'compatibilidad positiva',
      );
      await rows(total - incompatible, 'ningún incompatible');
      await choose('compat', 'all');
      assert.equal((await stateOf('compat')).pressed, 'false');
      assert.equal(
        await countLabel(),
        `${total - installed} de ${total} plugin(s)`,
        'el eje de instalación sigue aplicado',
      );

      /* Wizard --------------------------------------------------------------- */
      await choose('wizard', 'with-wizard');
      assert.equal((await stateOf('wizard')).tone, 'positive');
      await rows(withWizard, 'con wizard');
      await choose('wizard', 'without-wizard');
      assert.deepEqual(
        await stateOf('wizard'),
        { pressed: 'true', expanded: 'false', tone: 'negative', text: 'Sin wizard' },
        'wizard negativo',
      );
      await rows(total - withWizard, 'sin wizard');
      await choose('wizard', 'all');
      assert.equal((await stateOf('wizard')).pressed, 'false');

      /* Bancos: el fixture no trae presets ------------------------------------ */
      await choose('install', 'all');
      await choose('banks', 'with-banks');
      assert.equal((await stateOf('banks')).tone, 'positive');
      await rows(0, 'con bancos');
      // La tabla reutilizable trae toolbar y paginación: el aviso es su fila vacía.
      assert.equal(
        (await page.textContent('#plugins-table .table-empty'))?.trim(),
        'Ningún plugin coincide con el filtro.',
        'sin intersección se enseña el aviso',
      );
      assert.equal(await countLabel(), `0 de ${total} plugin(s)`);
      await choose('banks', 'without-banks');
      assert.equal((await stateOf('banks')).tone, 'negative');
      await rows(total, 'sin bancos');
      await choose('banks', 'all');
      assert.equal(await countLabel(), '', 'sin filtros vuelve a no haber recuento');

      /* Los tres estados se pintan con colores distintos ---------------------- */
      const background = async (axis: string): Promise<string> =>
        (await page.evaluate(
          `getComputedStyle(document.getElementById('filter-${axis}')).backgroundColor`,
        )) as string;
      await choose('install', 'installed');
      const positive = await background('install');
      await choose('install', 'uninstalled');
      const negative = await background('install');
      await choose('install', 'all');
      const neutral = await background('install');
      assert.equal(
        new Set([positive, negative, neutral]).size,
        3,
        `cada estado tiene su color: ${positive} / ${negative} / ${neutral}`,
      );

      assert.deepEqual(
        pageErrors,
        [],
        `errores de JavaScript en la página: ${pageErrors.join(' | ')}`,
      );
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({
        path: path.join(ARTIFACTS, 'e2e-filter-axes-failure.png'),
        fullPage: true,
      });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

test(
  'combina los ejes de instalación y de bancos en la tabla',
  { skip },
  async (t) => {
    assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);
    assert.ok(existsSync(OBXD_BANK), `falta el banco de prueba ${OBXD_BANK}`);
    assert.ok(existsSync(FIXTURE_LIBRARY), `la librería no existe: ${FIXTURE_LIBRARY}`);

    // Copia propia: se instalan dos plugins y se deja un banco en uno de ellos
    // para que la intersección tenga casos con y sin bancos.
    const temp = await mkdtemp(path.join(tmpdir(), 'fxb-e2e-combo-'));
    const library = path.join(temp, 'library');
    await cp(FIXTURE_LIBRARY, library, { recursive: true });

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const url = `${base}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
      await rm(temp, { recursive: true, force: true });
    });

    await waitForServer(server, base, logs);

    // Dos instalados para poder cruzar «Instalados» con los dos ejes de bancos;
    // solo OB-Xd recibe un banco, así que «Instalados + sin bancos» tiene fila.
    for (const plugin of ['OB-Xd', 'AnalogSynth']) {
      const response = await fetch(`${base}/library/loader/add`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ libraryRoot: library, plugin, dllSourcePath: REPO_DLL }),
      });
      assert.equal(response.status, 200, `instalar ${plugin}: ${await response.text()}`);
    }
    const presets = path.join(library, 'plugs', 'OB-Xd', 'presets');
    await mkdir(presets, { recursive: true });
    await cp(OBXD_BANK, path.join(presets, BANK));

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    /** Nombres visibles ahora mismo, en orden alfabético. */
    const visible = async (): Promise<string[]> =>
      (await page.locator('#plugins-table tbody tr [data-field="name"]').allTextContents()).sort();

    const count = async (): Promise<string> =>
      ((await page.textContent('#filter-count')) ?? '').trim();

    const pressed = async (axis: string): Promise<string | null> =>
      page.getAttribute(`#filter-${axis}`, 'aria-pressed');

    const tone = async (axis: string): Promise<string | null> =>
      page.getAttribute(`#filter-${axis}`, 'data-tone');

    const label = async (axis: string): Promise<string> =>
      (await page.textContent(`#filter-${axis} .filter-btn-text`))?.trim() ?? '';

    /** Abre el chip de un eje y elige una de sus tres opciones. */
    const choose = async (axis: string, value: string): Promise<void> => {
      await page.click(`#filter-${axis}`);
      await page.click(`#filter-${axis}-menu [data-value="${value}"]`);
    };

    const expectRows = async (names: string[], scope: string): Promise<void> => {
      assert.deepEqual(await visible(), [...names].sort(), `${scope}: plugins visibles`);
      assert.equal(
        await count(),
        `${names.length} de 3 plugin(s)`,
        `${scope}: recuento del filtro`,
      );
    };

    try {
      await page.goto(url);
      await page.fill('#library-root', library);
      await page.click('#scan-button');
      await page.waitForSelector('#results:not([hidden])');

      // Punto de partida comprobado: el banco copiado cuenta y los dos
      // instalados no se confunden con el que quedó sin instalar.
      const rows = await page.locator('#plugins-table tbody tr').evaluateAll((trs) =>
        trs.map((tr) => ({
          name: tr.querySelector('[data-field="name"]')?.textContent?.trim() ?? '',
          status: tr.querySelector('[data-field="status"]')?.textContent?.trim() ?? '',
          banks: tr.querySelector('[data-field="banks"]')?.textContent?.trim() ?? '',
        })),
      );
      const rowOf = (name: string) => {
        const row = rows.find((entry) => entry.name === name);
        assert.ok(row, `falta la fila de ${name}`);
        return row;
      };
      assert.equal(rowOf('OB-Xd').status, 'con cargador');
      assert.match(rowOf('OB-Xd').banks, /^1 banco/);
      assert.equal(rowOf('AnalogSynth').status, 'con cargador');
      assert.equal(rowOf('AnalogSynth').banks, 'sin bancos');
      assert.equal(rowOf('GrandPiano').status, 'sin cargador');
      assert.equal(rowOf('GrandPiano').banks, 'sin bancos');

      assert.deepEqual(
        await visible(),
        ['AnalogSynth', 'GrandPiano', 'OB-Xd'],
        'sin filtros: plugins visibles',
      );
      assert.equal(await count(), '', 'sin filtros no hay recuento');

      /* Instalados + con bancos: intersección de los dos ejes ---------- */
      await choose('install', 'installed');
      await choose('banks', 'with-banks');
      await expectRows(['OB-Xd'], 'instalados + con bancos');
      assert.equal(await pressed('install'), 'true');
      assert.equal(await pressed('banks'), 'true');
      assert.equal(await pressed('wizard'), 'false');
      assert.equal(await pressed('compat'), 'false');
      assert.equal(await tone('install'), 'positive');
      assert.equal(await tone('banks'), 'positive');
      assert.equal(await label('install'), 'Con cargador');
      assert.equal(await label('banks'), 'Con bancos');

      /* Instalados + sin bancos --------------------------------------- */
      await choose('banks', 'without-banks');
      await expectRows(['AnalogSynth'], 'instalados + sin bancos');
      assert.equal(await tone('banks'), 'negative');

      /* Todos + sin bancos -------------------------------------------- */
      await choose('install', 'all');
      await expectRows(['AnalogSynth', 'GrandPiano'], 'todos + sin bancos');
      assert.equal(await pressed('install'), 'false');
      assert.equal(await tone('install'), 'neutral');

      /* Todos + con bancos -------------------------------------------- */
      await choose('banks', 'with-banks');
      await expectRows(['OB-Xd'], 'todos + con bancos');

      /* No instalados + con bancos: intersección vacía ---------------- */
      await choose('install', 'uninstalled');
      await expectRows([], 'no instalados + con bancos');
      assert.equal(
        (await page.locator('#plugins-table .table-empty').textContent())?.trim(),
        'Ningún plugin coincide con el filtro.',
        'sin intersección se enseña el aviso',
      );
      assert.equal(
        await pressed('banks'),
        'true',
        'el eje de bancos sigue aplicado aunque no queden filas',
      );
      assert.equal(await tone('install'), 'negative');
      assert.equal(await label('install'), 'Sin cargador');

      /* Quitar el eje de bancos deja solo el estado ------------------- */
      await choose('banks', 'all');
      await expectRows(['GrandPiano'], 'no instalados');

      /* Instalados, ahora con y sin el eje de bancos ------------------ */
      await choose('install', 'installed');
      await expectRows(['AnalogSynth', 'OB-Xd'], 'instalados');
      await choose('banks', 'with-banks');
      await expectRows(['OB-Xd'], 'instalados + con bancos otra vez');
      await choose('banks', 'all');
      await expectRows(['AnalogSynth', 'OB-Xd'], 'instalados tras quitar bancos');

      assert.deepEqual(
        pageErrors,
        [],
        `errores de JavaScript en la página: ${pageErrors.join(' | ')}`,
      );
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({
        path: path.join(ARTIFACTS, 'e2e-filter-combo-failure.png'),
        fullPage: true,
      });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

/**
 * Visor de auditoría durable de asociaciones contra el servidor real: el
 * snapshot de solo lectura montado sobre `mountTable`, primero sin almacén y
 * después con el evento real que deja en `fxbLoader.audit.jsonl` el guardado
 * de una preferencia de DLL, ejercitando el multiselección por `kind` y el
 * rango de fechas por `ts`.
 */
test('visor de auditoría: snapshot vacío, evento real, filtros y recarga sola', { skip }, async (t) => {
  assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);

  const auditDll = 'OB-Xd-audit.dll';
  const temp = await mkdtemp(path.join(tmpdir(), 'fxb-e2e-audit-'));
  const library = path.join(temp, 'library');
  // Nunca se toca el fixture: se trabaja sobre una copia.
  await cp(path.join(LIBRARY_SOURCE, 'plugs'), path.join(library, 'plugs'), { recursive: true });

  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const logs: string[] = [];
  const server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: WEBAPP,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.setEncoding('utf8');
  server.stderr?.setEncoding('utf8');
  server.stdout?.on('data', (chunk: string) => logs.push(chunk));
  server.stderr?.on('data', (chunk: string) => logs.push(chunk));

  let browser: Browser | null = null;

  t.after(async () => {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
      await new Promise((resolve) => server.once('exit', resolve));
    }
    await rm(temp, { recursive: true, force: true });
  });

  await waitForServer(server, url, logs);

  const pluginDir = path.join(library, 'plugs', PLUGIN);

  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    /* Escaneo y visor sin almacén ---------------------------------- */
    await page.goto(url);
    await page.waitForSelector('#scan-form');
    await page.fill('#library-root', library);
    await page.click('#scan-button');
    await waitForText(page, '#status', /3 plugin\(s\) encontrados/);

    await page.click('#audit-nav-btn');
    await page.locator('#audit-drawer').waitFor({ state: 'visible' });
    await waitForText(page, '#audit-summary', /Todavía no existe el almacén/);
    await waitForText(page, '#audit-table', /Sin eventos de auditoría que cumplan los filtros/);
    await page.click('#audit-close');
    await page.locator('#audit-drawer').waitFor({ state: 'hidden' });

    /* Un evento real: la preferencia de DLL ------------------------ */
    await writeFile(path.join(pluginDir, auditDll), pe32Dll());
    const row = pluginRow(page);
    await clickRowAction(row, 'meta');
    await page.locator('#meta').waitFor({ state: 'visible' });
    await page.fill('#meta-dll', auditDll);
    await page.click('#meta-dll-save');
    await waitForText(page, '#meta-status', `Preferencia de DLL guardada: ${auditDll}`);
    await page.click('#meta-close');
    await page.locator('#meta').waitFor({ state: 'hidden' });

    /* El visor monta el snapshot sobre mountTable ------------------ */
    await page.click('#audit-nav-btn');
    await page.locator('#audit-drawer').waitFor({ state: 'visible' });
    await waitForText(page, '#audit-path', /fxbLoader\.audit\.jsonl/);
    await waitForText(page, '#audit-table', /Cambio de asociación/);
    assert.equal(
      await page.locator('#audit-table tbody tr[data-row-id]').count(),
      1,
      'la tabla montada pinta el único evento de la auditoría',
    );
    // Los dos filtros del sistema de tablas que trae el visor.
    assert.equal(await page.locator('#audit-table input[aria-label="Fecha desde"]').count(), 1);
    assert.equal(await page.locator('#audit-table .table-multi-trigger').count(), 1);

    /* Multiselección por tipo -------------------------------------- */
    await page.click('#audit-table .table-multi-trigger');
    await page.click('#audit-table .table-multi-menu-list input[value="association-change"]');
    await waitForText(page, '#audit-table', /Sin eventos de auditoría que cumplan los filtros/);
    await page.click('#audit-table .table-multi-menu-list input[value="association-change"]');
    await waitForText(page, '#audit-table', /Cambio de asociación/);
    await page.click('#audit-table .table-multi-trigger');
    assert.equal(await page.locator('#audit-table .table-multi-menu-list').isVisible(), false);

    /* Rango de fechas por ts --------------------------------------- */
    await page.fill('#audit-table input[aria-label="Fecha desde"]', '2099-01-01');
    await waitForText(page, '#audit-table', /Sin eventos de auditoría que cumplan los filtros/);
    await page.fill('#audit-table input[aria-label="Fecha desde"]', '');
    await waitForText(page, '#audit-table', /Cambio de asociación/);

    /* Filtro por plugin, estrechado en el servidor ------------------ */
    // El resumen del cajón es lo que prueba que la recarga con filtro terminó:
    // el texto de «sin eventos» y las opciones del multiselect viven dentro de
    // `#audit-table` siempre, así que un waitForText sobre la tabla mentiría.
    await page.fill('#audit-plugin-filter', 'NoExiste');
    await waitForText(page, '#audit-summary', /filtrado por «NoExiste»/);
    await waitForText(page, '#audit-table', /Sin eventos de auditoría que cumplan los filtros/);
    await page.fill('#audit-plugin-filter', PLUGIN);
    await waitForText(page, '#audit-summary', /filtrado por «OB-Xd»/);
    assert.equal(
      await page.locator('#audit-table tbody tr[data-row-id]').count(),
      1,
      'el filtro por plugin se manda al servidor y devuelve solo ese plugin',
    );
    // Al vaciarlo vuelve el snapshot completo, con su recuento inicial.
    await page.fill('#audit-plugin-filter', '');
    await page.waitForFunction(
      `!document.getElementById('audit-summary').textContent.includes('filtrado')`,
    );
    assert.equal(
      await page.locator('#audit-table tbody tr[data-row-id]').count(),
      1,
      'sin filtro vuelve el evento a la tabla',
    );

    /* Recarga sola: un evento nuevo con el cajón abierto ------------ */
    // El almacén es un apéndice: basta con añadir una línea para que el
    // sondeo de 2 s la detecte y la pinte sin pulsar «Actualizar».
    await writeFile(
      path.join(library, 'fxbLoader.audit.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'association-change',
        plugin: PLUGIN,
        libraryRoot: library,
        field: 'dll_name',
        previousValue: 'a.dll',
        newValue: 'b.dll',
      })}\n`,
      { flag: 'a' },
    );
    await waitForText(page, '#audit-summary', /2 evento\(s\)/);
    assert.equal(
      await page.locator('#audit-table tbody tr[data-row-id]').count(),
      2,
      'la tabla se recarga sola al entrar el evento nuevo',
    );

    assert.deepEqual(
      pageErrors,
      [],
      `errores de JavaScript en la página: ${pageErrors.join(' | ')}`,
    );
  } catch (error) {
    await mkdir(ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-audit-viewer-failure.png'), fullPage: true });
    console.error(`Servidor:\n${logs.join('')}`);
    throw error;
  }
});

/***
 * Preferencia local de DLL por plugin, recorrida en el navegador contra el
 * servidor real: cambiar `dll_name` en el panel del catálogo, guardarlo (con
 * respaldo `vfxinfo.tx_` en disco) y comprobar el aviso de
 * borrador que intercepta al importador.
 *
 * Como en el recorrido de arriba se instala el cargador de verdad: el valor
 * guardado tras instalar es `OB-Xd/fxbLoader.dll`, y la alternativa es un PE32
 * mínimo dentro del plugin para que un reescaneo no la marque incompatible.
 */
test(
  'preferencia de DLL: borrador en el catálogo, guardado y aviso al importar',
  { skip },
  async (t) => {
    assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);

    const value = 'OB-Xd-alt.dll';
    const temp = await mkdtemp(path.join(tmpdir(), 'fxb-e2e-dll-'));
    const library = path.join(temp, 'library');
    // Nunca se toca el fixture: se trabaja sobre una copia.
    await cp(path.join(LIBRARY_SOURCE, 'plugs'), path.join(library, 'plugs'), { recursive: true });

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
      await rm(temp, { recursive: true, force: true });
    });

    await waitForServer(server, url, logs);

    const pluginDir = path.join(library, 'plugs', PLUGIN);
    const vfxinfoPath = path.join(pluginDir, 'vfxinfo.txt');

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      /* Escaneo e instalación ----------------------------------------- */
      await page.goto(url);
      await page.waitForSelector('#scan-form');
      await page.fill('#library-root', library);
      await page.click('#scan-button');
      await waitForText(page, '#status', /3 plugin\(s\) encontrados/);

      const row = pluginRow(page);
      await clickRowAction(row, 'toggle');
      await waitForText(page, '#status', `Cargador puesto en ${PLUGIN}.`);

      // La DLL alternativa: un PE32 válido para que un reescaneo la acepte.
      await writeFile(path.join(pluginDir, value), pe32Dll());

      /* Catálogo: valor guardado y botones al reposo ------------------ */
      await clickRowAction(row, 'meta');
      await page.locator('#meta').waitFor({ state: 'visible' });
      await waitForText(page, '#meta-dll-note', 'Preferencia guardada en vfxinfo.txt');
      // El panel muestra el `pluginName` del escaneo, que para un plugin con
      // cargador es la DLL original del vfxinfo (o su respaldo), no
      // `fxbLoader.dll`: el test toma el valor que está en pantalla.
      const original = await page.inputValue('#meta-dll');
      // La nota nombra el valor guardado tal cual está en el campo.
      assert.ok(
        ((await page.locator('#meta-dll-note').textContent()) ?? '').includes(original),
        `la nota nombra el valor guardado: original=${original}`,
      );
      assert.match(original, /\.dll$/);
      assert.equal(await page.locator('#meta-dll-save').isDisabled(), true);
      assert.equal(await page.locator('#meta-dll-cancel').isDisabled(), true);

      /* Borrador: nota, botones y cancelar --------------------------- */
      await page.fill('#meta-dll', value);
      await waitForText(page, '#meta-dll-note', 'Borrador sin guardar del valor mostrado.');
      assert.equal(await page.locator('#meta-dll-save').isDisabled(), false);
      assert.equal(await page.locator('#meta-dll-cancel').isDisabled(), false);      await page.click('#meta-dll-cancel');
      await waitForText(page, '#meta-status', 'Preferencia de DLL restablecida al valor guardado.');
      assert.equal(await page.inputValue('#meta-dll'), original);
      assert.equal(await page.locator('#meta-dll-save').isDisabled(), true);      /* Guardar: API, vfxinfo.txt y respaldo ------------------------- */
      const backupPath = path.join(pluginDir, 'vfxinfo.tx_');
      // La instalación ya dejó el respaldo del vfxinfo.txt original.
      assert.equal(existsSync(backupPath), true, 'la instalación respaldó el vfxinfo.txt');
      const backupBefore = await readFile(backupPath);
      await page.fill('#meta-dll', value);
      await page.click('#meta-dll-save');
      await waitForText(page, '#meta-status', `Preferencia de DLL guardada: ${value}`);
      await waitForText(
        page,
        '#meta-dll-note',
        `Preferencia guardada en vfxinfo.txt: ${value}`,
      );
      assert.equal(await page.inputValue('#meta-dll'), value);
      assert.equal(await page.locator('#meta-dll-save').isDisabled(), true);      assert.match(
        (await readFile(vfxinfoPath, 'latin1')),
        new RegExp(`^dll_name: ${value.replace(/\./g, '\\.')}\\r?$`, 'm'),
      );      // El respaldo de la instalación queda intacto tras guardar la
      // preferencia: guarda el vfxinfo.txt original, no el parcheado.
      assert.equal(existsSync(backupPath), true, 'el respaldo sigue ahí');
      assert.equal(
        Buffer.compare(await readFile(backupPath), backupBefore),
        0,
        'el primer guardado de preferencia no toca el respaldo existente',
      );
      assert.notEqual(
        Buffer.compare(await readFile(backupPath), await readFile(vfxinfoPath)),
        0,
        'el respaldo conserva el original, distinto del vfxinfo parcheado',
      );
      // La operación queda en el historial del plugin.
      assert.match(
        await readFile(path.join(pluginDir, 'fxbLoader.log'), 'utf8'),
        /\[dll-preference\]/,
      );

      /* Aviso de borrador al abrir el importador --------------------- */
      // Otro borrador (la preferencia guardada ahora es la alternativa): se

//      // abre el importador y el diálogo pregunta antes de continuar. El
      // cajón del catálogo tapa la barra: se cierra y el borrador sobrevive.
      await page.fill('#meta-dll', original);      await page.click('#meta-close');      await page.locator('#meta').waitFor({ state: 'hidden' });

      await page.click('#import-pkg-nav-btn');
      await page.locator('#dialog-dll-draft').waitFor({ state: 'visible' });
      assert.equal(
        await page.evaluate(`document.querySelector('#dialog-dll-draft')?.open`),
        true,
      );
      // «Cancelar» conserva el borrador y no abre nada.
      await page.click('#dialog-dll-draft-cancel');
      assert.equal(
        await page.evaluate(`document.querySelector('#dialog-dll-draft')?.open`),
        false,
      );      assert.equal(await page.locator('#import-package-drawer').isHidden(), true);
      assert.equal(await page.inputValue('#meta-dll'), original);

      // «Continuar sin cambios» descarta el borrador y abre el importador:
      // el campo vuelve a la preferencia guardada.
      await page.click('#import-pkg-nav-btn');
      await page.locator('#dialog-dll-draft').waitFor({ state: 'visible' });
      await page.click('#dialog-dll-draft-continue');
      await page.locator('#import-package-drawer').waitFor({ state: 'visible' });
      assert.equal(await page.inputValue('#meta-dll'), value);
      assert.equal(
        await page.evaluate(`document.querySelector('#dialog-dll-draft')?.open`),
        false,
      );

      assert.deepEqual(
        pageErrors,
        [],
        `errores de JavaScript en la página: ${pageErrors.join(' | ')}`,
      );
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({
        path: path.join(ARTIFACTS, 'e2e-dll-preference-failure.png'),
        fullPage: true,
      });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

/**
 * Fase III.D: asistente de plugins nuevos sin wizard. Recorre en el navegador
 * lo que hace una persona: abrir el cajón, analizar un binario DLL sintético
 * (PE válido con `VSTPluginMain`), dejar que el análisis rellene el nombre y el
 * id sugeridos, y crear el plugin en una librería temporal vacía. La prueba
 * ancla el resultado en archivos reales: la DLL copiada y el `vfxinfo.txt`.
 */
test(
  'asistente de plugin nuevo sin wizard: analiza el DLL y da de alta el plugin',
  {
    skip: existsSync(SERVER_ENTRY)
      ? false
      : `falta ${path.relative(process.cwd(), SERVER_ENTRY)}; ejecuta npm run build`,
  },
  async (t) => {
    const temp = await mkdtemp(path.join(tmpdir(), 'fxb-e2e-custom-'));
    const library = path.join(temp, 'library');
    await mkdir(path.join(library, 'plugs'), { recursive: true });

    const dllName = 'DemoSynth.dll';
    const dllPath = path.join(temp, dllName);
    await writeFile(dllPath, peWithExportsDll(['VSTPluginMain', 'main'], { bitness: 32 }));

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
      await rm(temp, { recursive: true, force: true });
    });

    await waitForServer(server, url, logs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      await page.goto(url);
      await page.waitForSelector('#custom-plugin-nav-btn');
      await page.click('#custom-plugin-nav-btn');
      await page.locator('#custom-plugin-drawer').waitFor({ state: 'visible' });

      // El cajón es un diálogo modal con nombre accesible.
      assert.equal(
        await page.getAttribute('#custom-plugin-drawer', 'aria-labelledby'),
        'custom-plugin-title',
      );

      await page.fill('#custom-plugin-path', dllPath);
      await page.fill('#custom-plugin-root', library);
      await page.click('#custom-plugin-inspect-btn');
      await waitForText(page, '#custom-plugin-status', 'Binario analizado.');

      // El análisis muestra el diagnóstico del binario y prefiere el nombre y
      // el id sugeridos por el servidor.
      assert.equal(await page.locator('#custom-plugin-result').isVisible(), true);
      assert.equal(
        ((await page.textContent('#custom-plugin-valid-pe')) ?? '').trim(),
        'PE válido',
      );
      assert.equal(
        ((await page.textContent('#custom-plugin-vst')) ?? '').trim(),
        'VST: VSTPluginMain',
      );
      assert.match(
        await page.inputValue('#custom-plugin-folder'),
        /^DemoSynth$/,
        'el análisis rellena el nombre con el base del DLL',
      );      assert.equal((await page.inputValue('#custom-plugin-id')).length > 0, true);
      // Un DLL apto para el host de 32 bits no activa la advertencia.
      assert.equal(
        await page.locator('#custom-plugin-bitness-warning').isHidden(),
        true,
        'PE de 32 bits: sin advertencia de arquitectura',
      );


      // Crear con los valores sugeridos: sin editor, sin wizard guardado.
      await page.click('#custom-plugin-create-btn');
      await waitForText(page, '#custom-plugin-status', 'Plugin creado.');

      // La creé en archivos reales: la DLL copiada, el vfxinfo y el meta.
      const pluginDir = path.join(library, 'plugs', 'DemoSynth');
      const binaryDir = path.join(pluginDir, 'DemoSynth');
      assert.equal(existsSync(path.join(binaryDir, dllName)), true, 'la DLL quedó copiada');
      const vfxinfo = await readFile(path.join(pluginDir, 'vfxinfo.txt'), 'latin1');
      assert.match(vfxinfo, /dll_name/i);
      assert.equal(existsSync(path.join(pluginDir, 'presets')), true);
      assert.equal(existsSync(path.join(pluginDir, 'fxbLoader.meta.json')), true);
      // El `dll_name` escrito apunta al binario que se acaba de copiar y la
      // casilla del editor (desmarcada) llega al vfxinfo.
      assert.match(vfxinfo, /^dll_name: DemoSynth\/DemoSynth\.dll\r$/m);
      assert.match(vfxinfo, /^has_editor: 0\r$/m);

      // Repetir el alta sin «Sobrescribir» devuelve 409: la vista enseña el
      // mensaje del API, no un error genérico.
      await page.click('#custom-plugin-create-btn');
      await waitForText(page, '#custom-plugin-status', /Ya existe una carpeta para el plugin/);      assert.match(
        (await page.textContent('#custom-plugin-status')) ?? '',
        /^No se pudo crear el plugin: Ya existe una carpeta para el plugin en:/,
      );

      // Advertencia visible antes de crear: al analizar un DLL de 64 bits el
      // cajón muestra el aviso de arquitectura sin bloquear el alta.
      const dll64Path = path.join(temp, 'DemoSynth64.dll');
      await writeFile(dll64Path, peWithExportsDll(['VSTPluginMain'], { bitness: 64 }));
      await page.fill('#custom-plugin-path', dll64Path);
      await page.click('#custom-plugin-inspect-btn');
      await waitForText(page, '#custom-plugin-status', 'Binario analizado.');
      assert.equal(
        await page.locator('#custom-plugin-bitness-warning').isVisible(),
        true,
        'DLL de 64 bits: advertencia de arquitectura visible',
      );
      assert.match(
        (await page.textContent('#custom-plugin-bitness-warning')) ?? '',
        /no es apto para el host de 32 bits/,
      );


      // El cajón es clicable solo una vez por revisión: al cerrarlo y abrir el
      // importador, el cajón del asistente queda oculto y sin estado pintado.
      await page.click('#custom-plugin-close');
      await page.locator('#custom-plugin-drawer').waitFor({ state: 'hidden' });
      await page.click('#import-pkg-nav-btn');
      await page.locator('#import-package-drawer').waitFor({ state: 'visible' });
      assert.equal(
        await page.locator('#custom-plugin-drawer').isHidden(),
        true,
        'abrir el importador cierra el asistente',
      );
      await page.keyboard.press('Escape');
      await page.locator('#import-package-drawer').waitFor({ state: 'hidden' });

      // El plugin recién creado entra en la tabla al escanear la librería:
      // el asistente y el listado hablan del mismo catálogo.
      await page.fill('#library-root', library);
      await page.click('#scan-button');
      await waitForText(page, '#status', /1 plugin\(s\) encontrados/);
      const createdRow = page.locator('#plugins-table tbody tr').filter({ hasText: 'DemoSynth' });
      assert.equal(await createdRow.count(), 1, 'falta la fila del plugin creado');
      assert.equal(await createdRow.locator('[data-field="status"]').textContent(), 'sin cargador');
      assert.equal(
        await createdRow.locator('[data-field="compatibility"]').textContent(),
        'compatible',
      );

      assert.deepEqual(
        pageErrors,
        [],          `errores de JavaScript en la página: ${pageErrors.join(' | ')}`,
      );
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({
        path: path.join(ARTIFACTS, 'e2e-custom-plugin-failure.png'),
        fullPage: true,
      });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

test(
  'crea un banco FBCh y lo refleja en el visor y el log del navegador',
  { skip },
  async (t) => {
    assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);
    assert.ok(existsSync(LIBRARY_SOURCE), `la librería no existe: ${LIBRARY_SOURCE}`);

    const temp = await mkdtemp(path.join(tmpdir(), 'fxb-e2e-chunk-'));
    const library = path.join(temp, 'library');
    await cp(path.join(LIBRARY_SOURCE, 'plugs'), path.join(library, 'plugs'), { recursive: true });

    // La creación de bancos toma el FourCC del `id` de `vfxinfo.txt`, que el
    // fixture no trae; se añade solo a la copia temporal.
    const vfxinfoPath = path.join(library, 'plugs', PLUGIN, 'vfxinfo.txt');
    await writeFile(
      vfxinfoPath,
      Buffer.concat([await readFile(vfxinfoPath), Buffer.from('id: Obxd\r\n', 'latin1')]),
    );

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
      await rm(temp, { recursive: true, force: true });
    });

    await waitForServer(server, url, logs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const BANK_NAME = 'Chunk Bank.fxb';
    const CHUNK_HEX = 'deadbeefcafe';

    try {
      /* 1. Escanear y poner el cargador --------------------------------- */
      await page.goto(url);
      await page.waitForSelector('#scan-form');
      await page.fill('#library-root', library);
      await page.click('#scan-button');
      await waitForText(page, '#status', /plugin\(s\) encontrados/);

      const row = pluginRow(page);
      assert.equal(await row.count(), 1);
      await row.locator('button[data-field="banks"]').click();
      await page.locator('#banks').waitFor({ state: 'visible' });

      /* 2. Crear el banco FBCh desde la página: el navegador habla con el  */
      /*    servidor real con el mismo formulario tipado que usaría la UI.  */
      const created = (await page.evaluate(
        `fetch('/library/banks/create', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({
             libraryRoot: ${JSON.stringify(library)},
             plugin: ${JSON.stringify(PLUGIN)},
             bankName: ${JSON.stringify(BANK_NAME)},
             mode: 'chunk',
             chunkHex: ${JSON.stringify(CHUNK_HEX)},
             chunkVersion: 2,
             currentProgram: 2,
           }),
         }).then(async (response) => ({
           status: response.status,
           body: await response.json(),
         }))`,
      )) as {
        status: number;
        body: {
          status: string;
          target: string;
          bank: { kind: string; version: number; uniqueId: string; chunkSize: number | null; currentProgram: number | null };
        };
      };
      assert.equal(created.status, 200);
      assert.equal(created.body.status, 'created');
      assert.equal(created.body.bank.kind, 'FBCh');
      assert.equal(created.body.bank.version, 2);
      assert.equal(created.body.bank.uniqueId, 'Obxd');
      assert.equal(created.body.bank.chunkSize, 6);
      assert.equal(created.body.bank.currentProgram, 2);

      /* 3. El disco confirma el chunk opaco byte a byte ----------------- */
      const CCNK = 0x43636e4b;
      const FBCH = 0x46424368;
      const createdBytes = await readFile(created.body.target);
      assert.equal(createdBytes.length, 156 + 4 + CHUNK_HEX.length / 2);
      assert.equal(createdBytes.readUInt32LE(8), FBCH);
      assert.equal(createdBytes.readUInt32LE(28), 2, 'currentProgram en la cabecera');
      assert.equal(createdBytes.readUInt32LE(156), CHUNK_HEX.length / 2, 'chunkSize');
      assert.deepEqual(createdBytes.subarray(160), Buffer.from(CHUNK_HEX, 'hex'));
      assert.equal((await parseFxbBank(createdBytes)).bank?.kind, 'FBCh');

      /* 4. El visor de bancos muestra el FBCh --------------------------- */
      // El cajón ya estaba abierto con la carpeta vacía: se cierra y se vuelve
      // a abrir para que relea el listado con el banco nuevo.
      await page.click('#banks-close');
      await page.locator('#banks').waitFor({ state: 'hidden' });
      await row.locator('button[data-field="banks"]').click();
      await page.locator('#banks').waitFor({ state: 'visible' });
      await waitForText(page, '#banks-rows', BANK_NAME);

      const chunkRow = page.locator('#banks-rows tr').filter({ hasText: BANK_NAME });
      assert.equal(await chunkRow.count(), 1, 'el banco FBCh aparece en la tabla');
      const cells = await chunkRow.locator('td').allTextContents();
      assert.ok(cells.some((text) => text.includes('FBCh (opaco)')), `tipo: ${cells.join(' | ')}`);
      assert.ok(cells.some((text) => text.includes('0 (informativo)')), `programas: ${cells.join(' | ')}`);
      assert.ok(cells.some((text) => text.includes('6 B')), `chunk: ${cells.join(' | ')}`);

      const kindCell = chunkRow.locator('td[title]', { hasText: 'FBCh (opaco)' });
      assert.equal(await kindCell.count(), 1, 'la celda Tipo lleva el tooltip del chunk opaco');
      await kindCell.hover().catch(() => {});
      assert.match((await kindCell.getAttribute('title')) ?? '', /versión del formato 2/);
      assert.match((await kindCell.getAttribute('title')) ?? '', /programa activo 2/);
      assert.match((await kindCell.getAttribute('title')) ?? '', /chunk de 6 bytes/);

      /* 5. El log del plugin muestra la creación con su detalle --------- */
      await page.keyboard.press('Escape');
      await page.locator('#banks').waitFor({ state: 'hidden' });
      await row.locator('[data-action="menu"]').click();
      await row.locator('[data-action="log"]').click();
      await page.locator('#log-drawer').waitFor({ state: 'visible' });
      await waitForText(page, '#log-plugin', PLUGIN);

      const logRow = page.locator('#log-table tbody tr').filter({ hasText: 'create-bank' });
      await logRow.first().waitFor({ timeout: 20_000 });
      const logCells = await logRow.first().locator('td').allTextContents();
      const logText = logCells.join(' | ');
      assert.ok(logText.includes('(FBCh, chunk de 6 bytes)'), `resumen: ${logText}`);
      assert.ok(logText.includes('formato FBCh versión 2'), `detalle: ${logText}`);
      assert.ok(logText.includes('programa activo 2'), `detalle: ${logText}`);
      assert.ok(logText.includes('sin programas informativos'), `detalle: ${logText}`);
      assert.ok(logText.includes('chunk de 6 bytes'), `detalle: ${logText}`);
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-chunk-bank-failure.png'), fullPage: true });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

test(
  'crea un banco little y otro big desde el formulario y verifica el orden de bytes en disco',
  { skip },
  async (t) => {
    assert.ok(existsSync(SERVER_ENTRY), `falta ${SERVER_ENTRY}; ejecuta npm run build`);
    assert.ok(existsSync(LIBRARY_SOURCE), `la librería no existe: ${LIBRARY_SOURCE}`);

    const temp = await mkdtemp(path.join(tmpdir(), 'fxb-e2e-endian-'));
    const library = path.join(temp, 'library');
    await cp(path.join(LIBRARY_SOURCE, 'plugs'), path.join(library, 'plugs'), { recursive: true });

    // La creación toma el FourCC del `id` de `vfxinfo.txt`, que el fixture no
    // trae; se añade solo a la copia temporal.
    const vfxinfoPath = path.join(library, 'plugs', PLUGIN, 'vfxinfo.txt');
    await writeFile(
      vfxinfoPath,
      Buffer.concat([await readFile(vfxinfoPath), Buffer.from('id: Obxd\r\n', 'latin1')]),
    );

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const logs: string[] = [];
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: WEBAPP,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.setEncoding('utf8');
    server.stderr?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => logs.push(chunk));
    server.stderr?.on('data', (chunk: string) => logs.push(chunk));

    let browser: Browser | null = null;

    t.after(async () => {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await new Promise((resolve) => server.once('exit', resolve));
      }
      await rm(temp, { recursive: true, force: true });
    });

    await waitForServer(server, url, logs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const LITTLE_NAME = 'Little Bank.fxb';
    const BIG_NAME = 'Big Bank.fxb';
    const FX_BANK_MAGIC = 0x4678426b; // 'FxBk'
    const FX_PROGRAM_MAGIC = 0x4678436b; // 'FxCk'
    const CHUNK_MAGIC = 0x43636e4b; // 'CcnK'
    const OBXD_ID = 0x4f627864; // 'Obxd'

    async function createBank(name: string, order: 'little' | 'big'): Promise<void> {
      await page.fill('#create-bank-name', name);
      await page.selectOption('#create-mode', 'programNames');
      await page.selectOption('#create-order', order);
      await page.fill('#create-program-names', 'Init');
      await page.click('#create-bank-button');
      await waitForText(page, '#banks-status', /creado en/);
      const row = page.locator('#banks-rows tr').filter({ hasText: name });
      await row.waitFor({ timeout: 20_000 });
      assert.equal(await row.count(), 1, `el banco ${name} aparece en la tabla`);
    }

    function expectProgramBank(bytes: Buffer, endianness: 'little' | 'big'): void {
      const readU32 = endianness === 'little'
        ? (offset: number) => bytes.readUInt32LE(offset)
        : (offset: number) => bytes.readUInt32BE(offset);
      // Cabecera de banco de 156 bytes + un programa de 48+0 parámetros.
      assert.equal(bytes.length, 156 + 8 + 48, `tamaño del fichero (${endianness})`);
      assert.equal(readU32(0), CHUNK_MAGIC, `CcnK de la cabecera en ${endianness}`);
      assert.equal(readU32(8), FX_BANK_MAGIC, `FxBk en ${endianness}`);
      assert.equal(readU32(16), OBXD_ID, `uniqueID Obxd en ${endianness}`);
      assert.equal(readU32(24), 1, `numPrograms = 1 en ${endianness}`);
      // El orden contrario debe dar basura, no coincidir por casualidad.
      const wrong = endianness === 'little'
        ? (offset: number) => bytes.readUInt32BE(offset)
        : (offset: number) => bytes.readUInt32LE(offset);
      assert.notEqual(wrong(8), FX_BANK_MAGIC, `bytes al revés en ${endianness}`);
      // Programa: CcnK + byteSize 48 + FxCk + nombre 'Init'.
      assert.equal(readU32(156), CHUNK_MAGIC);
      assert.equal(readU32(164), FX_PROGRAM_MAGIC, `FxCk en ${endianness}`);
      assert.equal(bytes.toString('latin1', 156 + 28, 156 + 32), 'Init', `nombre en ${endianness}`);
    }

    try {
      await page.goto(url);
      await page.waitForSelector('#scan-form');
      await page.fill('#library-root', library);
      await page.click('#scan-button');
      await waitForText(page, '#status', /plugin\(s\) encontrados/);

      const row = pluginRow(page);
      assert.equal(await row.count(), 1);
      await row.locator('button[data-field="banks"]').click();
      await page.locator('#banks').waitFor({ state: 'visible' });

      // El `<details>` de creación puede estar plegado: se abre si hace falta.
      const details = page.locator('#banks details.create');
      if ((await details.getAttribute('open')) === null) {
        await details.locator('summary').click();
      }

      /* 1. Banco little (por defecto del formulario) -------------------- */
      await createBank(LITTLE_NAME, 'little');
      const littlePath = path.join(library, 'plugs', PLUGIN, 'presets', LITTLE_NAME);
      const littleBytes = await readFile(littlePath);
      expectProgramBank(littleBytes, 'little');
      assert.equal((await parseFxbBank(littleBytes)).bank?.endianness, 'little');

      /* 2. Banco big con el mismo formulario ---------------------------- */
      await page.selectOption('#create-order', 'big');
      await page.fill('#create-bank-name', BIG_NAME);
      await page.click('#create-bank-button');
      await waitForText(page, '#banks-status', /creado en/);
      const bigPath = path.join(library, 'plugs', PLUGIN, 'presets', BIG_NAME);
      const bigBytes = await readFile(bigPath);
      expectProgramBank(bigBytes, 'big');
      assert.equal((await parseFxbBank(bigBytes)).bank?.endianness, 'big');

      // La tabla muestra los dos con el mismo contenido, solo cambia el orden.
      await page.waitForFunction(
        'document.querySelectorAll("#banks-rows tr").length === 2',
        { timeout: 20_000 },
      );

      // El tooltip de la columna Tipo muestra el orden de bytes de cada banco.
      for (const [name, order] of [
        [LITTLE_NAME, 'little-endian (legacy de Windows)'],
        [BIG_NAME, 'big-endian (estándar VST2)'],
      ] as const) {
        const bankRow = page.locator('#banks-rows tr').filter({ hasText: name });
        assert.equal(await bankRow.count(), 1, `${name} aparece en la tabla`);
        const titles = await bankRow
          .locator('td[title]')
          .evaluateAll((cells) => cells.map((cell) => (cell as HTMLElement).title));
        const title = titles.find((value) => value.includes('orden de bytes')) ?? '';
        assert.ok(title.includes(order), `tooltip de ${name}: ${title}`);
        assert.match(title, /versión del formato 1/);
        assert.match(title, /1 programa/);
        // Cada fila solo declara su propio orden, no el contrario.
        const other = order.startsWith('little') ? 'big-endian' : 'little-endian';
        assert.ok(!title.includes(other), `tooltip de ${name} no mezcla órdenes: ${title}`);
      }

      /* 3. El log registra ambos con su orden de bytes ------------------ */
      await page.keyboard.press('Escape');
      await page.locator('#banks').waitFor({ state: 'hidden' });
      await row.locator('[data-action="menu"]').click();
      await row.locator('[data-action="log"]').click();
      await page.locator('#log-drawer').waitFor({ state: 'visible' });
      await waitForText(page, '#log-plugin', PLUGIN);
            await waitForText(page, '#log-table tbody', /create-bank/);
      const logTexts = await page
        .locator('#log-table tbody tr')
        .filter({ hasText: 'create-bank' })
        .locator('td')
        .allTextContents();
      const logText = logTexts.join(' | ');
      assert.ok(logText.includes('Little Bank.fxb'), `log del banco little: ${logText}`);
      assert.ok(logText.includes('Big Bank.fxb'), `log del banco big: ${logText}`);

      assert.deepEqual(pageErrors, [], `errores de JavaScript en la página: ${pageErrors.join(' | ')}`);
    } catch (error) {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({ path: path.join(ARTIFACTS, 'e2e-endian-bank-failure.png'), fullPage: true });
      console.error(`Servidor:\n${logs.join('')}`);
      throw error;
    }
  },
);

