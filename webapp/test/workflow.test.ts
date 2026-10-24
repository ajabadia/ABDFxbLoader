import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';

// `dist-test/test` → `webapp/` → raíz del repositorio, donde vive el workflow.
const webappRoot = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(webappRoot, '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');

async function readWorkflow(): Promise<string> {
  return readFile(workflowPath, 'utf8');
}

test('el workflow publica el informe HTML de cobertura como artefacto', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /^  coverage:/m, 'falta el job de cobertura');
  assert.match(workflow, /npm run test:coverage/);
  // Sin umbrales, bajar la cobertura no rompe la CI.
  assert.match(workflow, /--min-lines \d+/);
  assert.match(workflow, /--min-functions \d+/);
  assert.match(workflow, /--min-branches \d+/);
  // El informe se publica aunque los umbrales hayan fallado.
  assert.match(workflow, /^\s+if: always\(\)$/m);
  assert.match(workflow, /uses: actions\/upload-artifact@v7/);
  assert.match(workflow, /name: coverage-html/);
  // La ruta es relativa a la raíz del repositorio, no a `webapp/`.
  assert.match(workflow, /path: webapp\/coverage\/html/);
  // Sin esto, un informe ausente pasaría desapercibido como artefacto vacío.
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /retention-days: \d+/);
});

test('el workflow ejecuta la prueba de navegador contra el servidor real', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /^  browser-e2e:/m, 'falta el job de navegador');
  assert.match(workflow, /runs-on: ubuntu-latest/);
  // El navegador se instala aparte de `npm ci`.
  assert.match(workflow, /run: npx playwright install --with-deps chromium/);
  assert.match(workflow, /run: npm run test:e2e/);
  // La captura del fallo se conserva y no rompe el job si no existe.
  assert.match(workflow, /name: e2e-chromium/);
  assert.match(workflow, /path: webapp\/test-results/);

  const pkg = JSON.parse(await readFile(path.join(webappRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.match(pkg.scripts?.['test:e2e'] ?? '', /dist-test\/test\/e2e\/browser\.test\.js/);
  assert.ok(pkg.devDependencies?.['playwright'], 'playwright debe ser dependencia de desarrollo');
});

test('el script test:coverage usa el test runner de Node y el conversor local', async () => {
  const pkg = JSON.parse(await readFile(path.join(webappRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

  assert.match(pkg.scripts?.['test:coverage'] ?? '', /node scripts\/coverage\.mjs/);

  const runner = await readFile(path.join(webappRoot, 'scripts', 'coverage.mjs'), 'utf8');
  assert.match(runner, /--experimental-test-coverage/);
  // El lcov es la única vía de la que el propio runner saca informe HTML.
  assert.match(runner, /--test-reporter=lcov/);
  // Los umbrales se comparan contra los totales del propio informe.
  assert.match(runner, /--min-lines/);
  assert.match(runner, /checkThresholds/);
  assert.match(runner, /::error::/);
  // Los tests no deben inflar el denominador de la cobertura.
  assert.match(runner, /--test-coverage-exclude=dist-test\/test\/\*\*/);
  // El workflow sube exactamente lo que el script escribe.
  assert.match(runner, /path\.join\(coverageDir, 'html'\)/);
});

test('el workflow prueba start.bat en Windows de punta a punta', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /^  start-bat:/m, 'falta el job de start.bat');
  assert.match(workflow, /runs-on: windows-latest/);

  // Sin el .bat en el checkout, el job falla en vez de pasar sin probar nada.
  assert.match(workflow, /Test-Path \.\.\/start\.bat/);
  assert.match(workflow, /::error file=\.\.\/start\.bat::/);

  // Recorre los caminos de la decisión sin arrancar el servidor.
  assert.match(workflow, /FXB_SKIP_SERVER/);
  assert.match(workflow, /\$bat = Join-Path \(Get-Location\) '\.\.\\start\.bat'/);
  assert.match(workflow, /& \$bat 34\d\d/);
  assert.match(workflow, /Recompilar: tsconfig/);
  assert.match(workflow, /dist\/orphan\.js/);

  // Los huérfanos se prueban en un build al día y sin tocar fechas: si el job
  // los mezcla con `tsconfig.json`, el motivo de los huérfanos tapa al de la
  // fecha y el paso comprueba lo que no cree.
  assert.match(workflow, /Recompilar: 2 huérfano/, 'falta el caso de huérfanos sin fuente nueva');
  assert.match(workflow, /\$log -match 'más nuevo'/, 'el caso de huérfanos debe descartar las fechas');
  const orphanStep = workflow.indexOf("Recompilar: 2 huérfano");
  const dateStep = workflow.indexOf('Recompilar: tsconfig');
  assert.ok(orphanStep !== -1 && dateStep !== -1 && orphanStep < dateStep, 'los huérfanos se prueban antes de tocar tsconfig.json');

  // El script que decide existe y es el que llama el .bat.
  const bat = await readFile(path.join(repoRoot, 'start.bat'), 'utf8').catch(() => null);
  if (bat !== null) {
    assert.match(bat, /node "webapp\\scripts\\build-decision\.mjs"/);
  }
  await readFile(path.join(webappRoot, 'scripts', 'build-decision.mjs'), 'utf8');
});
