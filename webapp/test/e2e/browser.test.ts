import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { MAX_PLUGINS_PER_BATCH } from '../../src/client/batch-stream';
import { parseFxbBank } from '../../src/library/fxb-bank';

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

function pluginRow(page: Page): Locator {
  return page.locator('#plugins tr').filter({ hasText: PLUGIN });
}

/**
 * Empieza a acumular lo que la UI escribe en `#batch-step`. El observer guarda
 * los nodos añadidos y no el texto final: los eventos de un lote llegan dentro
 * de la misma tarea, así que leer `textContent` al final solo vería el último
 * paso. Se evalúa como cadena para no depender del lib DOM del proyecto.
 */
async function recordStepTexts(page: Page): Promise<void> {
  await page.evaluate(`
    (() => {
      const target = document.getElementById('batch-step');
      if (target === null) throw new Error('la UI no tiene #batch-step');
      const seen = [];
      window.__batchSteps = seen;
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

async function stepTexts(page: Page): Promise<string[]> {
  return (await page.evaluate('window.__batchSteps')) as string[];
}

async function resetStepTexts(page: Page): Promise<void> {
  await page.evaluate('window.__batchSteps.length = 0');
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
      assert.equal(await page.locator('#plugins tr').count(), 3);

      const row = pluginRow(page);
      assert.equal(await row.count(), 1, `no hay fila para ${PLUGIN}`);
      assert.equal(await row.locator('[data-field="status"]').textContent(), 'no instalado');
      assert.equal(await row.locator('[data-field="compatibility"]').textContent(), 'compatible');
      assert.equal(await row.locator('[data-action="toggle"]').textContent(), 'Instalar');

      /* 2. Instalación -------------------------------------------------- */
      await row.locator('[data-action="toggle"]').click();
      await waitForText(page, '#status', `Instalado en ${PLUGIN}.`);
      await waitForText(page, '#summary-text', '1 de 3 con el cargador');

      const installedRow = pluginRow(page);
      assert.equal(await installedRow.locator('[data-field="status"]').textContent(), 'instalado');
      assert.equal(await installedRow.locator('[data-action="toggle"]').textContent(), 'Desinstalar');

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

      const blockedRow = page.locator('#plugins tr').filter({ hasText: 'GrandPiano' });
      assert.equal(
        await blockedRow.locator('[data-field="compatibility"]').textContent(),
        'incompatible',
      );
      assert.equal(await blockedRow.locator('[data-action="toggle"]').isDisabled(), true);

      /* 3. Bancos: abrir, importar y fijar el banco por defecto --------- */
      await installedRow.locator('[data-action="banks"]').click();
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
      assert.equal(await page.locator('#import-results .import-result.rejected').count(), 0);

      const bankRow = page.locator('#banks-rows tr').filter({ hasText: BANK });
      assert.equal(await bankRow.count(), 1);
      assert.equal(await bankRow.locator('[data-field="bank-name"]').textContent(), BANK);
      assert.equal(
        sha256(await readFile(path.join(pluginDir, 'presets', BANK))),
        sha256(await readFile(OBXD_BANK)),
      );

      // Sin respaldo `.orig` no se puede restaurar: el botón está apagado.
      assert.equal(await page.locator('#default-restore').isDisabled(), true);

      await page.selectOption('#default-bank', BANK);
      await page.check('#load-fxb');
      await page.click('#default-save');
      await waitForText(page, '#banks-status', `Banco por defecto de ${PLUGIN}: ${BANK}.`);
      await waitForText(page, '#banks-rows', 'por defecto');

      const config = (await readFile(path.join(pluginDir, 'fxbLoader.config'))).toString('latin1');
      assert.match(config, new RegExp(`^defaultFxbName = ${BANK.replace(/\./g, '\\.')}\\r?$`, 'm'));
      assert.match(config, /^loadFxbBank = yes\r?$/m);
      assert.match(config, /^programDirName = presets\r?$/m);

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

      /* 4. Lote completo con progreso en caliente ----------------------- */
      // La vista ya no orquesta el lote: lo pide a `POST /library/batch/stream`
      // y pinta el plugin en curso a medida que el servidor lo cuenta.
      assert.equal(await page.locator('#batch-progress').isHidden(), true);
      assert.equal(await page.locator('#batch-step').isHidden(), true);

      await recordStepTexts(page);
      await page.locator('#uninstall-all').click();
      await waitForText(page, '#batch-status', /desinstalado\(s\)/);
      await waitForText(page, '#summary-text', '0 de 3 con el cargador');
      await waitForText(page, '#batch-status', /desinstalado\(s\)/);
      assert.equal(
        await pluginRow(page).locator('[data-field="status"]').textContent(),
        'no instalado',
      );
      // La barra de progreso solo vive mientras dura el lote.
      assert.equal(await page.locator('#batch-progress').isHidden(), true);
      assert.equal(
        await page.locator('#plugins tr.batch-running, #plugins tr.batch-done').count(),
        0,
        'las filas quedan sin marcar al terminar',
      );
      assert.equal(await page.locator('#batch-step').isHidden(), true);

      // La vista pintó los pasos internos que mandó el servidor.
      const uninstallSteps = await stepTexts(page);
      assert.ok(
        uninstallSteps.includes('paso 1 de 3 · restaurando vfxinfo.txt'),
        `la UI no pintó los pasos de la desinstalación: ${uninstallSteps.join(' | ')}`,
      );
      assert.ok(uninstallSteps.includes('paso 3 de 3 · borrando fxbLoader.config'));
      assert.ok(
        uninstallSteps.every((text) => /^paso \d de 3 · /.test(text)),
        `paso con formato inesperado: ${uninstallSteps.join(' | ')}`,
      );

      await resetStepTexts(page);
      await page.locator('#install-all').click();
      await waitForText(page, '#batch-status', /instalado\(s\)/);
      await waitForText(page, '#summary-text', '2 de 3 con el cargador');

      const installSteps = await stepTexts(page);
      assert.ok(
        installSteps.includes('paso 1 de 5 · respaldando vfxinfo.txt'),
        `la UI no pintó los pasos de la instalación: ${installSteps.join(' | ')}`,
      );
      assert.ok(installSteps.includes('paso 5 de 5 · creando la carpeta de presets'));
      assert.equal(await page.locator('#batch-step').isHidden(), true, 'el paso no se queda al terminar');
      assert.equal(await page.locator('#batch-step').textContent(), '');
      assert.equal(
        await pluginRow(page).locator('[data-field="status"]').textContent(),
        'instalado',
      );

      assert.equal(
        requests.some((url) => url.endsWith('/library/batch/stream')),
        true,
        'el lote debe pedirse por el endpoint de progreso',
      );
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
  'trocea «Instalar todos» por encima del tope y pinta una sola barra',
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
            installed: false,
            hasVfxinfo: true,
            pluginName: null,
            warnings: [],
            compatible: true,
            compatibilityIssues: [],
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
        { type: 'start', action: 'install', dryRun: false, total: body.plugins.length, plugins: body.plugins },
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
          { type: 'plugin', index, total: body.plugins.length, name, status: 'installed', message: null },
        ]),
        {
          type: 'end',
          result: {
            action: 'install',
            dryRun: false,
            total: body.plugins.length,
            succeeded: body.plugins.length,
            failed: 0,
            results: body.plugins.map((name) => ({ name, status: 'installed', message: null })),
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
      await waitForText(page, '#batch-status', `Instalando ${total} de ${total}…`);
      assert.equal(await page.locator('#batch-progress').isHidden(), false);
      assert.equal(await page.locator('#batch-progress').getAttribute('max'), String(total));
      assert.equal(
        await page.locator('#batch-progress').getAttribute('value'),
        String(MAX_PLUGINS_PER_BATCH),
      );
      assert.equal(await page.locator('#batch-progress').count(), 1, 'una sola barra para el lote');

      await waitForText(page, '#batch-status', `${total} plugin(s) instalado(s).`);
      assert.equal(await page.locator('#batch-progress').isHidden(), true);
      assert.equal(await page.locator('#batch-step').isHidden(), true);
      assert.equal(await page.locator('#batch-step').textContent(), '');

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
