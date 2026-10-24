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
import { MAX_BANKS_PER_REQUEST } from '../../src/client/bank-limits';
import { MAX_PLUGINS_PER_BATCH } from '../../src/client/batch-stream';
import { parseFxbBank } from '../../src/library/fxb-bank';
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

function pluginRow(page: Page): Locator {
  return page.locator('#plugins tr').filter({ hasText: PLUGIN });
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
      await pluginRow(page).locator('[data-action="meta"]').click();
      await page.locator('#meta').waitFor({ state: 'visible' });
      await waitForText(page, '#meta-plugin', PLUGIN);
      await waitForText(page, '#meta-status', /no tiene catálogo/);
      assert.equal(await page.locator('#meta-save').isDisabled(), false);

      await page.fill('#meta-id', 'OBXd');
      await page.fill('#meta-name', 'OB-Xd E2E');
      await page.fill('#meta-vendor', 'discoDSP');
      await page.fill('#meta-notes', 'Banco de fábrica');
      await page.fill('#meta-extended', '{ "family": "synth" }');
      await page.click('#meta-save');
      await waitForText(page, '#meta-status', 'Catálogo guardado.');

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

      // «Descartar cambios» vuelve a lo guardado sin escribir nada.
      await page.fill('#meta-name', 'Sin guardar');
      await page.click('#meta-reload');
      await page.waitForFunction(`document.querySelector('#meta-status').textContent === ''`);
      assert.equal(await page.inputValue('#meta-name'), 'OB-Xd E2E');
      assert.equal(
        (JSON.parse(await readFile(metaPath, 'utf8')) as { common: { name: string } }).common.name,
        'OB-Xd E2E',
      );

      await page.click('#meta-close');
      assert.equal(await page.locator('#meta').isHidden(), true);

      /* 4. Lote completo con progreso en caliente ----------------------- */
      // La vista ya no orquesta el lote: lo pide a `POST /library/batch/stream`
      // y pinta el plugin en curso a medida que el servidor lo cuenta.
      assert.equal(await page.locator('#batch-progress').isHidden(), true);
      assert.equal(await page.locator('#batch-step').isHidden(), true);
      assert.equal(await page.locator('#batch-clock').isHidden(), true);

      await recordTexts(page, 'batch-step', '__batchSteps');
      await recordTexts(page, 'batch-clock', '__batchClock');
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
      await waitForText(page, '#batch-status', /instalado\(s\)/);
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

      await waitForText(page, '#batch-status', `${total} plugin(s) instalado(s).`);
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
            installed: installed.has(name),
            hasVfxinfo: true,
            pluginName: null,
            warnings: [],
            compatible: true,
            compatibilityIssues: [],
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
          action: 'install',
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
            status: 'installed',
            message: null,
          },
        ]),
        {
          type: 'end',
          result: {
            action: 'install',
            dryRun: false,
            total: body.plugins.length,
            succeeded: body.plugins.length,
            failed: 0,
            results: body.plugins.map((name) => ({
              name,
              status: 'installed',
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
      await waitForText(page, '#batch-status', `Instalando 1 de ${names.length}…`);

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
        /Lote cancelado: 0 de 3 instalado\(s\); 3 sin confirmar\./,
      );

      // Alpha ya está instalado, así que solo quedan dos por reanudar.
      await page.locator('#batch-resume').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#batch-resume').textContent(), 'Reanudar 2 sin confirmar');
      assert.equal(await page.locator('#batch-resume').isEnabled(), true);

      release();
      await page.click('#batch-resume');
      await waitForText(page, '#batch-status', '2 plugin(s) instalado(s).');

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
      await row.locator('[data-action="toggle"]').click();
      await waitForText(page, '#status', `Instalado en ${PLUGIN}.`);

      await pluginRow(page).locator('[data-action="banks"]').click();
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

      await pluginRow(page).locator('[data-action="banks"]').click();
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
      await pluginRow(page).locator('[data-action="banks"]').click();
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
          action: 'install',
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
            status: failed.includes(name) ? 'failed' : 'installed',
            message: failed.includes(name) ? `fallo simulado en ${name}` : null,
          },
        ]),
        {
          type: 'end',
          result: {
            action: 'install',
            dryRun: false,
            total: body.plugins.length,
            succeeded: body.plugins.length - failed.length,
            failed: failed.length,
            results: body.plugins.map((name) => ({
              name,
              status: failed.includes(name) ? 'failed' : 'installed',
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

    await page.route('**/library/install', async (route) => {
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
      await waitForText(page, '#batch-status', '1 de 3 instalado(s); 2 con error.');
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
      assert.equal(await page.locator('#plugins tr').count(), 3);

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
      await pluginRow(page).locator('[data-action="banks"]').click();
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
