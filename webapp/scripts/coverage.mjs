#!/usr/bin/env node
/**
 * Ejecuta la suite con el test runner de Node recogiendo cobertura y publica el
 * informe HTML en `coverage/html` (`coverage/lcov.info` es el dato intermedio).
 *
 * Se ejecuta después de `tsc -p tsconfig.test.json`; el workflow sube
 * `coverage/html` como artefacto.
 *
 * Umbrales opcionales (porcentajes):
 *   node scripts/coverage.mjs --min-lines 94 --min-functions 80 --min-branches 78
 *
 * Si la cobertura queda por debajo de alguno, el script termina con código 1
 * aunque los tests hayan pasado: una regresión de cobertura rompe la CI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateHtmlReport } from './lcov-html.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coverageDir = path.join(root, 'coverage');
const lcovPath = path.join(coverageDir, 'lcov.info');
const htmlDir = path.join(coverageDir, 'html');

const THRESHOLD_FLAGS = {
  '--min-lines': 'lines',
  '--min-functions': 'functions',
  '--min-branches': 'branches',
};

const METRIC_LABELS = { lines: 'líneas', functions: 'funciones', branches: 'ramas' };

/** Lee `--min-<métrica> <pct>`; un argumento desconocido o inválido es un error de uso. */
function parseThresholds(argv) {
  const thresholds = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const metric = THRESHOLD_FLAGS[flag];
    if (metric === undefined) {
      throw new Error(`argumento desconocido: ${flag}`);
    }
    const raw = argv[index + 1];
    const value = Number(raw);
    if (raw === undefined || raw === '' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`${flag} necesita un porcentaje entre 0 y 100 (recibido: ${raw ?? 'nada'})`);
    }
    thresholds[metric] = value;
  }
  return thresholds;
}

/**
 * Compara los totales del informe con los umbrales. Devuelve las métricas que
 * no llegan, ya formateadas; una métrica sin datos (0 elementos) también falla,
 * porque un umbral no se puede dar por cumplido sin medir nada.
 */
function checkThresholds(thresholds, totals) {
  const failures = [];
  for (const [metric, minimum] of Object.entries(thresholds)) {
    const { hit, total } = totals[metric] ?? { hit: 0, total: 0 };
    const label = METRIC_LABELS[metric];
    if (total === 0) {
      console.log(`✖ ${label}: sin datos (0 elementos medidos)`);
      failures.push(`${label}: sin datos, umbral ${minimum} %`);
      continue;
    }
    const pct = (hit * 100) / total;
    const ok = pct >= minimum;
    console.log(`${ok ? '✔' : '✖'} ${label}: ${pct.toFixed(2)} % ${ok ? '≥' : '<'} ${minimum} %`);
    if (!ok) failures.push(`${label}: ${pct.toFixed(2)} % < ${minimum} %`);
  }
  return failures;
}

let thresholds;
try {
  thresholds = parseThresholds(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

// Un informe viejo no debe sobrevivir a una ejecución fallida.
rmSync(coverageDir, { recursive: true, force: true });
mkdirSync(coverageDir, { recursive: true });

const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--experimental-test-coverage',
    // Los tests no son código de producción: fuera del denominador.
    '--test-coverage-exclude=dist-test/test/**',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    `--test-reporter-destination=${lcovPath}`,
    'dist-test/test/*.test.js',
  ],
  { cwd: root, stdio: 'inherit' },
);

const status = result.status ?? 1;

if (!existsSync(lcovPath) || statSync(lcovPath).size === 0) {
  console.error('No se generó coverage/lcov.info; no hay informe HTML que publicar.');
  process.exit(status === 0 ? 1 : status);
}

let failures = [];
try {
  const { files, totals } = generateHtmlReport({ lcovPath, outDir: htmlDir, root });
  const pct = ({ hit, total }) => (total === 0 ? '—' : `${((hit * 100) / total).toFixed(2)} %`);
  console.log(
    `\nInforme HTML: ${files} archivo(s) · líneas ${pct(totals.lines)} · ` +
      `ramas ${pct(totals.branches)} · funciones ${pct(totals.functions)} → ${path.relative(root, htmlDir)}`,
  );
  failures = checkThresholds(thresholds, totals);
} catch (error) {
  console.error(`No se pudo generar el informe HTML: ${error.message}`);
  process.exit(status === 0 ? 1 : status);
}

if (failures.length > 0) {
  // Anotación de GitHub Actions: se ve en la pestaña del job, no solo en el log.
  console.error(`::error::Cobertura por debajo del umbral: ${failures.join('; ')}`);
  process.exit(1);
}

process.exit(status);
